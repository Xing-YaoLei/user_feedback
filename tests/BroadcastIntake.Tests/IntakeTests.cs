using System.Security.Cryptography;
using System.Text;
using BroadcastIntake;

namespace BroadcastIntake.Tests;

internal sealed class Workspace : IDisposable
{
    public string Root { get; }
    public string Drop { get; }
    public string State { get; }
    public IntakeOptions Options { get; }

    public Workspace()
    {
        Root = Path.Combine(Path.GetTempPath(), "intake-tests-" + Guid.NewGuid().ToString("N"));
        Drop = Path.Combine(Root, "drop");
        State = Path.Combine(Root, "state");
        Directory.CreateDirectory(Drop);
        Directory.CreateDirectory(State);

        Options = new IntakeOptions
        {
            DropDirectory = Drop,
            StateDirectory = State,
            SettleAlreadySatisfied = true
        };
    }

    public IntakeService Service => new(Options, new IntakeStore(State));

    public string WriteAsset(string programme, string revision, AssetRole role, string content, string? extension = null)
    {
        var ext = extension ?? (role switch
        {
            AssetRole.Mix => ".wav",
            AssetRole.Subtitle => ".srt",
            _ => ".json"
        });

        var name = $"{programme}_{revision}_{AssetRoles.ToWire(role)}{ext}";
        var path = Path.Combine(Drop, name);
        File.WriteAllText(path, content, new UTF8Encoding(false));
        return path;
    }

    public string WriteFile(string fileName, string content)
    {
        var path = Path.Combine(Drop, fileName);
        File.WriteAllText(path, content, new UTF8Encoding(false));
        return path;
    }

    public string WriteManifest(string programme, string revision, double duration, params (AssetRole Role, string Checksum)[] assets)
        => WriteManifestNamed(programme, revision, "manifest", duration, assets);

    /// <summary>Write a manifest under a chosen role token, so two deliveries can coexist under distinct names.</summary>
    public string WriteManifestNamed(string programme, string revision, string roleToken, double duration,
        params (AssetRole Role, string Checksum)[] assets)
    {
        var payload = new StringBuilder();
        payload.AppendLine("programme: " + programme);
        payload.AppendLine("revision: " + revision);
        payload.AppendLine("audio_duration: " + duration.ToString(System.Globalization.CultureInfo.InvariantCulture));
        foreach (var asset in assets)
            payload.AppendLine($"{AssetRoles.ToWire(asset.Role)}: sha256:{asset.Checksum}");
        var name = $"{programme}_{revision}_{roleToken}.txt";
        File.WriteAllText(Path.Combine(Drop, name), payload.ToString(), new UTF8Encoding(false));
        return Path.Combine(Drop, name);
    }

    public static string Sha256(string content)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(content));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Root, recursive: true);
        }
        catch (IOException)
        {
            // Best effort cleanup of the temp workspace.
        }
    }
}

internal static class IntakeTests
{
    private const string MixContent = "MIX-AUDIO-BYTES";
    private const string SubContent = "1\n00:00:01,000 --> 00:00:05,000\n你好\n";

    public static void PartialDeliveryReportsProgress()
    {
        using var ws = new Workspace();
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent);

        var result = ws.Service.Scan();
        var record = result.All.Single();

        TestRunner.Equal(RevisionStatus.AwaitingAssets, record.Status, "只有混音时应等待");
        TestRunner.Equal(1, record.Items.Count(i => i.Status != ItemStatus.Missing), "应有一份已收到");
        TestRunner.True(record.Missing.Contains("subtitle"), "仍缺字幕");
        TestRunner.True(record.Missing.Contains("manifest"), "仍缺制作清单");
        TestRunner.True(record.HasReason(PendingReason.MissingFile), "待办应包含缺文件");

        var progress = ReceiptText.Progress(record);
        TestRunner.Contains(progress, "混音", "进度应列出已收到的混音");
        TestRunner.Contains(progress, "仍缺", "进度应列出仍缺的东西");

        TestRunner.Equal("P12345", record.Programme, "节目号稳定");
        TestRunner.Equal("R2", record.Revision, "修订号稳定");
    }

    public static void CompleteDeliveryPasses()
    {
        using var ws = new Workspace();
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent);
        ws.WriteAsset("P12345", "R2", AssetRole.Subtitle, SubContent);
        ws.WriteManifest("P12345", "R2", 12.5,
            (AssetRole.Mix, Workspace.Sha256(MixContent)),
            (AssetRole.Subtitle, Workspace.Sha256(SubContent)));

        var record = ws.Service.Scan().All.Single();

        TestRunner.Equal(RevisionStatus.Passed, record.Status, "全套素材应通过");
        TestRunner.NotNull(record.PackagePath, "应生成压缩包");
        TestRunner.NotNull(record.CompletedAt, "应记录打包时间");
        TestRunner.True(File.Exists(record.PackagePath!), "压缩包应存在");
        TestRunner.True(record.Items.All(i => i.Status == ItemStatus.Verified), "所有素材都应校验通过");
    }

    public static void ChecksumMismatchFails()
    {
        using var ws = new Workspace();
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent);
        ws.WriteAsset("P12345", "R2", AssetRole.Subtitle, SubContent);
        ws.WriteManifest("P12345", "R2", 12.5,
            (AssetRole.Mix, new string('0', 64)),
            (AssetRole.Subtitle, Workspace.Sha256(SubContent)));

        var record = ws.Service.Scan().All.Single();

        TestRunner.Equal(RevisionStatus.Failed, record.Status, "校验失败应判未通过");
        TestRunner.True(record.HasReason(PendingReason.ChecksumMismatch), "待办应说明校验失败");
        TestRunner.True(record.PackagePath is null, "不应生成压缩包");
        TestRunner.Equal(ItemStatus.ChecksumMismatch, record.Item(AssetRole.Mix)!.Status, "混音项应为校验失败");
    }

    public static void SubtitleOutOfBoundsFails()
    {
        using var ws = new Workspace();
        const string longSub = "1\n00:00:10,000 --> 00:00:20,000\n越界\n";
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent);
        ws.WriteAsset("P12345", "R2", AssetRole.Subtitle, longSub);
        ws.WriteManifest("P12345", "R2", 12.5,
            (AssetRole.Mix, Workspace.Sha256(MixContent)),
            (AssetRole.Subtitle, Workspace.Sha256(longSub)));

        var record = ws.Service.Scan().All.Single();

        TestRunner.Equal(RevisionStatus.Failed, record.Status, "字幕越界应判未通过");
        TestRunner.True(record.HasReason(PendingReason.SubtitleOutOfBounds), "待办应说明字幕越界");
        TestRunner.True(record.SubtitleIssues.Count > 0, "应保留字幕问题明细");
        TestRunner.True(record.PackagePath is null, "不应生成压缩包");
    }

    public static void ConflictingManifestsAreHeld()
    {
        using var ws = new Workspace();
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent);
        ws.WriteAsset("P12345", "R2", AssetRole.Subtitle, SubContent);
        ws.WriteManifest("P12345", "R2", 12.5,
            (AssetRole.Mix, Workspace.Sha256(MixContent)),
            (AssetRole.Subtitle, Workspace.Sha256(SubContent)));
        ws.WriteManifestNamed("P12345", "R2", "production-list", 13.0,
            (AssetRole.Mix, Workspace.Sha256(MixContent)),
            (AssetRole.Subtitle, Workspace.Sha256(SubContent)));

        var record = ws.Service.Scan().All.Single();

        TestRunner.Equal(RevisionStatus.Conflict, record.Status, "两份不同清单应留冲突");
        TestRunner.True(record.HasReason(PendingReason.ManifestConflict), "待办应说明清单冲突");
        TestRunner.True(record.PackagePath is null, "冲突时不应打包");
        TestRunner.Equal(2, record.Manifests.Count, "应保留两份清单记录");
    }

    public static void IdenticalManifestsAreNotConflict()
    {
        using var ws = new Workspace();
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent);
        ws.WriteAsset("P12345", "R2", AssetRole.Subtitle, SubContent);
        ws.WriteManifest("P12345", "R2", 12.5,
            (AssetRole.Mix, Workspace.Sha256(MixContent)),
            (AssetRole.Subtitle, Workspace.Sha256(SubContent)));
        // Same semantic content, different formatting: not a conflict.
        var json = $$"""
            {
              "audioDuration": 12.5,
              "assets": {
                "mix": "sha256:{{Workspace.Sha256(MixContent)}}",
                "subtitle": "sha256:{{Workspace.Sha256(SubContent)}}"
              }
            }
            """;
        ws.WriteFile("P12345_R2_manifest.json", json);

        var record = ws.Service.Scan().All.Single();

        TestRunner.True(record.Status != RevisionStatus.Conflict, "内容相同不应判冲突");
        TestRunner.Equal(RevisionStatus.Passed, record.Status, "内容相同应正常通过");
    }

    public static void WaitsForFileStillWriting()
    {
        using var ws = new Workspace();
        ws.Options.SettleAlreadySatisfied = false;
        ws.Options.SettleTime = TimeSpan.FromSeconds(30);

        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent);
        ws.WriteAsset("P12345", "R2", AssetRole.Subtitle, SubContent);
        ws.WriteManifest("P12345", "R2", 12.5,
            (AssetRole.Mix, Workspace.Sha256(MixContent)),
            (AssetRole.Subtitle, Workspace.Sha256(SubContent)));

        var record = ws.Service.Scan().All.Single();

        TestRunner.Equal(RevisionStatus.Settling, record.Status, "文件刚写入应等待");
        TestRunner.True(record.HasReason(PendingReason.FileStillWriting), "待办应说明仍在写入");
        TestRunner.True(record.PackagePath is null, "未写完不应打包");
    }

    public static void RedeliveryReturnsOriginalReceipt()
    {
        using var ws = new Workspace();
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent);
        ws.WriteAsset("P12345", "R2", AssetRole.Subtitle, SubContent);
        ws.WriteManifest("P12345", "R2", 12.5,
            (AssetRole.Mix, Workspace.Sha256(MixContent)),
            (AssetRole.Subtitle, Workspace.Sha256(SubContent)));

        var first = ws.Service.Scan().All.Single();
        TestRunner.Equal(RevisionStatus.Passed, first.Status, "首轮应通过");

        // A late re-delivery of the same revision (e.g. the second material group's copy) must not change the receipt.
        Thread.Sleep(30);
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent + "-again");

        var second = ws.Service.Scan().All.Single();
        TestRunner.Equal(first.PackagePath, second.PackagePath, "压缩包位置不变");
        TestRunner.Equal(first.ReceivedAt, second.ReceivedAt, "收件时间不变");
        TestRunner.Equal(first.CompletedAt, second.CompletedAt, "完成时间不变");
        TestRunner.Equal(RevisionStatus.Passed, second.Status, "状态仍为已打包");
    }

    public static void ReceiptSurvivesReload()
    {
        using var ws = new Workspace();
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent);
        ws.WriteAsset("P12345", "R2", AssetRole.Subtitle, SubContent);
        ws.WriteManifest("P12345", "R2", 12.5,
            (AssetRole.Mix, Workspace.Sha256(MixContent)),
            (AssetRole.Subtitle, Workspace.Sha256(SubContent)));

        var first = ws.Service.Scan().All.Single();

        // A fresh query object (as if from another process) sees the same record.
        var query = IntakeQuery.Open(ws.State);
        var loaded = query.Get("P12345", "R2");
        TestRunner.NotNull(loaded, "应能按节目号与修订号查回记录");
        TestRunner.Equal(first.PackagePath, loaded!.PackagePath, "包位置一致");
        TestRunner.Equal(first.ReceivedAt, loaded.ReceivedAt, "收件时间一致");
        TestRunner.True(PackageLookup.From(loaded).ReadyToSend, "播控应能看出可送播");
    }

    public static void PendingReasonsAreCategorised()
    {
        using var ws = new Workspace();
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, MixContent);
        ws.WriteAsset("P12345", "R2", AssetRole.Subtitle, SubContent);
        ws.WriteManifest("P12345", "R2", 12.5,
            (AssetRole.Mix, new string('1', 64)),
            (AssetRole.Subtitle, Workspace.Sha256(SubContent)));

        var record = ws.Service.Scan().All.Single();
        var lookup = PackageLookup.From(record);

        TestRunner.True(lookup.Pending.Any(p => p.Reason == PendingReason.ChecksumMismatch), "应能区分校验失败");
        TestRunner.True(PendingText.Reason(PendingReason.MissingFile) == "缺文件", "缺文件中文标签");
        TestRunner.True(PendingText.Reason(PendingReason.SubtitleOutOfBounds) == "字幕越界", "字幕越界中文标签");
        TestRunner.True(PendingText.Reason(PendingReason.ChecksumMismatch) == "校验失败", "校验失败中文标签");
    }
}

internal static class PackagingTests
{
    public static void ArchiveContainsAssetsAndReceipt()
    {
        using var ws = new Workspace();
        ws.WriteAsset("P12345", "R2", AssetRole.Mix, IntakeTestsContent.Mix);
        ws.WriteAsset("P12345", "R2", AssetRole.Subtitle, IntakeTestsContent.Sub);
        ws.WriteManifest("P12345", "R2", 12.5,
            (AssetRole.Mix, Workspace.Sha256(IntakeTestsContent.Mix)),
            (AssetRole.Subtitle, Workspace.Sha256(IntakeTestsContent.Sub)));

        var record = ws.Service.Scan().All.Single();
        TestRunner.NotNull(record.PackagePath, "应生成压缩包");

        using var archive = System.IO.Compression.ZipFile.OpenRead(record.PackagePath!);
        var names = archive.Entries.Select(e => e.FullName).ToList();
        TestRunner.Assert(names.Count >= 3, "压缩包应至少有三项");
        TestRunner.True(names.Any(n => n.Contains("mix")), "应包含混音");
        TestRunner.True(names.Any(n => n.Contains("subtitle")), "应包含字幕");
        TestRunner.True(names.Any(n => n.Contains("manifest")), "应包含制作清单");
        TestRunner.True(names.Any(n => n == "receipt.json"), "应包含回执");

        var receipt = archive.GetEntry("receipt.json");
        TestRunner.NotNull(receipt, "回执存在");
        using var reader = new StreamReader(receipt!.Open());
        var json = reader.ReadToEnd();
        var roundTrip = ReceiptSerializer.FromJson(json);
        TestRunner.NotNull(roundTrip, "回执应可反序列化");
        TestRunner.Equal(record.Programme, roundTrip!.Programme, "回执节目号");
        TestRunner.Equal(record.Revision, roundTrip.Revision, "回执修订号");
        TestRunner.Equal(record.PackagePath, roundTrip.PackagePath, "回执应记录包位置");
    }
}

internal static class IntakeTestsContent
{
    public const string Mix = "MIX-AUDIO-BYTES";
    public const string Sub = "1\n00:00:01,000 --> 00:00:05,000\n你好\n";
}
