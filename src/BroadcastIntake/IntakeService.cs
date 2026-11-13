using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace BroadcastIntake;

/// <summary>Settings controlling scan and settle behaviour.</summary>
public sealed class IntakeOptions
{
    /// <summary>Directory into which both material groups drop their files.</summary>
    public string DropDirectory { get; set; } = "";

    /// <summary>Directory holding records.json and the produced packages.</summary>
    public string StateDirectory { get; set; } = "";

    /// <summary>How long a file's size and modification time must stay unchanged before it is considered fully written.</summary>
    public TimeSpan SettleTime { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>Total time to wait for a file that keeps changing before accepting it as stable.</summary>
    public TimeSpan MaxWaitForSettle { get; set; } = TimeSpan.FromMinutes(10);

    /// <summary>When true, every existing file is treated as fully written. Used by tests and by explicit one-shot scans.</summary>
    public bool SettleAlreadySatisfied { get; set; }

    /// <summary>Update records and run checks but do not produce zip packages.</summary>
    public bool NoPackaging { get; set; }
}

/// <summary>Result of one scan pass over the drop directory.</summary>
public sealed class ScanResult
{
    public DateTimeOffset ScannedAt { get; set; }

    /// <summary>Revisions whose record changed during this pass (newly observed, state change, or packaged).</summary>
    public List<ReceiptRecord> Changed { get; set; } = [];

    /// <summary>Every known revision at the end of the pass, ordered by programme then revision.</summary>
    public List<ReceiptRecord> All { get; set; } = [];

    public List<string> Warnings { get; set; } = [];
}

/// <summary>
/// Scans one drop directory, groups deliveries by programme + revision, waits for writes to finish,
/// validates them against the production manifest, reports what has arrived and what is still pending,
/// and packages revisions that pass every check.
/// </summary>
public sealed class IntakeService
{
    private readonly IntakeOptions _options;
    private readonly IntakeStore _store;

    /// <summary>Tracks when each path was first seen at its current size/timestamp, across scans in one process.</summary>
    private readonly ConcurrentDictionary<string, FileObservation> _observations;

    public IntakeService(IntakeOptions options, IntakeStore store)
    {
        _options = options;
        _store = store;
        _observations = new ConcurrentDictionary<string, FileObservation>(StringComparer.Ordinal);
    }

    public IntakeStore Store => _store;

    /// <summary>
    /// One scan pass. Safe to call repeatedly; observations are remembered between passes.
    /// When <paramref name="waitForSettle"/> is true the scan first waits for files to stop growing,
    /// which is what a one-shot intake run should do; a watcher leaves it false and reports progress instead.
    /// </summary>
    public ScanResult Scan(bool waitForSettle = false, CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(_options.DropDirectory))
            throw new DirectoryNotFoundException("收件目录不存在: " + _options.DropDirectory);

        if (waitForSettle && !_options.SettleAlreadySatisfied)
        {
            // Take a baseline observation of every file, then wait until none of them keeps changing.
            ObserveOnce();
            var quiet = WaitForQuiet(cancellationToken);

            // If the deadline passed, accept the current files as stable so the checks can run now;
            // never block intake forever on a file that keeps changing.
            if (!quiet) TreatCurrentFilesAsSettled();
        }

        var result = new ScanResult { ScannedAt = DateTimeOffset.Now };

        using var lockScope = _store.AcquireLock();

        var existing = _store.LoadAll().ToDictionary(r => r.Key, StringComparer.Ordinal);
        var groups = DiscoverGroups(result.Warnings);
        var updated = new Dictionary<string, ReceiptRecord>(StringComparer.Ordinal);

        // Every group is re-evaluated from scratch so the receipt always reflects the drop directory.
        foreach (var group in groups.OrderBy(g => g.Programme, StringComparer.OrdinalIgnoreCase)
                                    .ThenBy(g => g.Revision, StringComparer.OrdinalIgnoreCase))
        {
            if (cancellationToken.IsCancellationRequested) break;

            existing.TryGetValue(ReceiptRecord.RecordKey(group.Programme, group.Revision), out var record);

            // Frozen once a package exists: a re-delivery returns the original receipt, package path and time.
            // (A pass made with packaging disabled is not frozen, so a later scan can still produce the package.)
            if (record is { Status: RevisionStatus.Passed, PackagePath: not null })
            {
                updated[record.Key] = record;
                continue;
            }

            var before = record is null ? null : Fingerprint(record);
            var next = Evaluate(group, record);
            updated[next.Key] = next;

            if (before != Fingerprint(next))
                result.Changed.Add(next);
        }

        // Retain records whose files are temporarily absent so the operator can still see them.
        foreach (var record in existing.Values)
            updated.TryAdd(record.Key, record);

        _store.SaveAll(updated.Values);

        result.All = updated.Values
            .OrderBy(r => r.Programme, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Revision, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return result;
    }

    /// <summary>Record the current size/timestamp of every drop file, establishing the baseline for settling.</summary>
    private void ObserveOnce()
    {
        foreach (var path in Directory.EnumerateFiles(_options.DropDirectory))
        {
            if (Path.GetFileName(path).StartsWith('.')) continue;

            try
            {
                var info = new FileInfo(path);
                if (!info.Exists) continue;
                _observations.TryAdd(path, new FileObservation(info.Length, info.LastWriteTimeUtc, DateTime.UtcNow, DateTime.UtcNow));
            }
            catch (IOException)
            {
                // A file that disappears between enumeration and stat is simply not observed yet.
            }
        }
    }

    /// <summary>
    /// Wait until every file in the drop directory has stopped changing, or until MaxWaitForSettle elapses.
    /// Returns true when everything is quiet, false when the deadline was reached first.
    /// </summary>
    private bool WaitForQuiet(CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + _options.MaxWaitForSettle;
        var poll = TimeSpan.FromMilliseconds(200);

        while (!cancellationToken.IsCancellationRequested)
        {
            var allQuiet = true;

            foreach (var path in Directory.EnumerateFiles(_options.DropDirectory))
            {
                if (Path.GetFileName(path).StartsWith('.')) continue;

                FileInfo info;
                try
                {
                    info = new FileInfo(path);
                    if (!info.Exists) continue;
                }
                catch (IOException)
                {
                    allQuiet = false;
                    continue;
                }

                var size = info.Length;
                var stamp = info.LastWriteTimeUtc;
                var key = path;
                var previous = _observations.GetOrAdd(key, _ => new FileObservation(size, stamp, DateTime.UtcNow, DateTime.UtcNow));

                if (previous.Size != size || previous.Stamp != stamp)
                {
                    _observations[key] = new FileObservation(size, stamp, DateTime.UtcNow, previous.FirstSeenUtc);
                    allQuiet = false;
                    continue;
                }

                if (DateTime.UtcNow - previous.StableSinceUtc < _options.SettleTime)
                    allQuiet = false;
            }

            if (allQuiet) return true;
            if (DateTime.UtcNow >= deadline) return false;

            Thread.Sleep(poll);
        }

        return false;
    }

    /// <summary>Mark the current state of every file as settled, used when the wait deadline is reached.</summary>
    private void TreatCurrentFilesAsSettled()
    {
        foreach (var path in Directory.EnumerateFiles(_options.DropDirectory))
        {
            if (Path.GetFileName(path).StartsWith('.')) continue;

            try
            {
                var info = new FileInfo(path);
                if (!info.Exists) continue;
                _observations[path] = new FileObservation(
                    info.Length, info.LastWriteTimeUtc, DateTime.UtcNow - _options.SettleTime, DateTime.UtcNow);
            }
            catch (IOException)
            {
                // File vanished; nothing to settle.
            }
        }
    }

    private List<DeliveryGroup> DiscoverGroups(List<string> warnings)
    {
        var groups = new Dictionary<string, DeliveryGroup>(StringComparer.Ordinal);

        foreach (var path in Directory.EnumerateFiles(_options.DropDirectory))
        {
            var fileName = Path.GetFileName(path);
            if (fileName.StartsWith('.')) continue;

            var parsed = DropNaming.Parse(fileName);
            if (parsed is null)
            {
                warnings.Add("忽略无法识别的文件名: " + fileName);
                continue;
            }

            var key = ReceiptRecord.RecordKey(parsed.Programme, parsed.Revision);
            if (!groups.TryGetValue(key, out var group))
            {
                group = new DeliveryGroup(parsed.Programme, parsed.Revision);
                groups[key] = group;
            }

            group.Files.Add(new DeliveredFile(parsed.Role, path, fileName));
        }

        foreach (var group in groups.Values)
            group.Files.Sort((a, b) => string.CompareOrdinal(a.FileName, b.FileName));

        return groups.Values.ToList();
    }

    private ReceiptRecord Evaluate(DeliveryGroup group, ReceiptRecord? prior)
    {
        var now = DateTimeOffset.Now;
        var record = prior ?? new ReceiptRecord
        {
            Programme = group.Programme,
            Revision = group.Revision,
            ReceivedAt = now,
            Status = RevisionStatus.AwaitingAssets
        };

        record.UpdatedAt = now;
        record.Status = RevisionStatus.AwaitingAssets;
        record.PackagePath = null;
        record.PackageSizeBytes = null;
        record.CompletedAt = null;
        record.Missing.Clear();
        record.Pending.Clear();
        record.SubtitleIssues.Clear();
        record.Manifests.Clear();
        record.AudioDurationSeconds = null;
        record.Items.Clear();

        var manifestFiles = group.Files.Where(f => f.Role == AssetRole.Manifest).ToList();

        // Judge settle for every delivered file first; a half-written manifest must never count as a rival version.
        var settled = new Dictionary<string, SettleResult>(StringComparer.Ordinal);
        foreach (var file in group.Files)
            settled[file.FileName] = JudgeSettle(file);

        var settledManifests = manifestFiles.Where(f => settled[f.FileName].Settled).ToList();
        var unsettledManifests = manifestFiles.Where(f => !settled[f.FileName].Settled).ToList();
        var manifests = ReadManifests(settledManifests, record);

        var readable = manifests.Where(m => m.Parsed.Manifest is not null).ToList();
        var distinctContent = readable.Select(m => m.Parsed.Manifest!.ContentHash).Distinct(StringComparer.Ordinal).ToList();
        var hasConflict = distinctContent.Count > 1;
        var unreadableCount = manifests.Count(m => m.Parsed.Manifest is null);

        var manifest = readable.Count > 0 ? readable[0].Parsed.Manifest : null;
        record.AudioDurationSeconds = manifest?.AudioDurationSeconds;

        // A second manifest only counts as a rival once it has finished writing; while any manifest
        // is still being written the revision must stay in "settling" so no decision is made too early.
        if (settledManifests.Count > 0)
        {
            foreach (var file in unsettledManifests)
                record.Pending.Add(new PendingItem
                {
                    Reason = PendingReason.FileStillWriting,
                    Role = AssetRole.Manifest,
                    FileName = file.FileName,
                    Detail = settled[file.FileName].Detail
                });
        }

        // Several manifests where at least one cannot be read: comparison is impossible, so leave it to staff.
        if (!hasConflict && settledManifests.Count > 1 && unreadableCount > 0)
        {
            hasConflict = true;
            record.Pending.Add(new PendingItem
            {
                Reason = PendingReason.ManifestConflict,
                Role = AssetRole.Manifest,
                Detail = "同一修订号收到多份制作清单，其中至少一份无法解析，无法自动比较：" +
                         string.Join("、", manifests.Select(m => m.File.FileName))
            });
        }

        if (hasConflict)
        {
            record.Status = RevisionStatus.Conflict;
            var contentConflictDetail = distinctContent.Count > 1
                ? "同一修订号收到内容不同的制作清单：" +
                  string.Join("、", readable.Select(m => m.File.FileName)) + "；请制作人员确认以哪一份为准"
                : null;

            if (contentConflictDetail is not null)
                record.Pending.Add(new PendingItem
                {
                    Reason = PendingReason.ManifestConflict,
                    Role = AssetRole.Manifest,
                    Detail = contentConflictDetail
                });
        }

        // A manifest whose declared revision disagrees with its drop file is a conflict signal: staff must decide
        // which revision the material really belongs to. A merely differently-spelled programme name is not.
        if (!hasConflict && manifest is not null)
        {
            var declaredRevision = DropNaming.NormalizeRevision(manifest.Revision);
            var revisionMismatch = declaredRevision is not null && declaredRevision != group.Revision;

            if (revisionMismatch)
            {
                hasConflict = true;
                record.Status = RevisionStatus.Conflict;
                record.Pending.Add(new PendingItem
                {
                    Reason = PendingReason.ManifestConflict,
                    Role = AssetRole.Manifest,
                    FileName = manifest.FileName,
                    Detail = $"清单标注的修订号（{manifest.Revision}）与投递文件名（{group.Revision}）不一致"
                });
            }
        }

        // A manifest that finished writing but cannot be parsed: report why, rather than failing silently.
        if (!hasConflict && settledManifests.Count > 0 && readable.Count == 0)
        {
            var firstError = manifests.Select(m => m.Parsed.Error).FirstOrDefault(e => e is not null) ?? "清单无效";
            record.Pending.Add(new PendingItem
            {
                Reason = PendingReason.InvalidManifest,
                Role = AssetRole.Manifest,
                FileName = settledManifests[0].FileName,
                Detail = firstError
            });

            var manifestItem = record.Item(AssetRole.Manifest);
            if (manifestItem is { Status: ItemStatus.Received }) manifestItem.Status = ItemStatus.Invalid;
        }

        // Every role expected for this revision: what arrived and what is still missing.
        foreach (var role in AssetRoles.Required)
        {
            var item = new AssetItem { Role = role };
            record.Items.Add(item);

            var candidates = group.Files.Where(f => f.Role == role).ToList();

            if (candidates.Count > 1)
            {
                // With several deliveries for one role, prefer a copy that has finished writing, then the
                // one the manifest names, then the one whose content matches the declared checksum.
                var expectedAsset = manifest?.For(role);
                var expectedName = expectedAsset?.FileName is { Length: > 0 } n ? Path.GetFileName(n) : null;

                candidates = candidates
                    .OrderByDescending(f => settled[f.FileName].Settled)
                    .ThenByDescending(f => expectedName is not null &&
                                           expectedName.Equals(f.FileName, StringComparison.OrdinalIgnoreCase))
                    .ThenByDescending(f => expectedAsset is not null && settled[f.FileName].Settled &&
                                           ChecksumMatches(f, expectedAsset))
                    .ThenBy(f => f.FileName, StringComparer.Ordinal)
                    .ToList();
            }

            if (candidates.Count == 0)
            {
                item.Status = ItemStatus.Missing;
                record.Missing.Add(AssetRoles.ToWire(role));
                record.Pending.Add(new PendingItem
                {
                    Reason = PendingReason.MissingFile,
                    Role = role,
                    Detail = AssetRoles.ToLabel(role) + "尚未收到"
                });
                continue;
            }

            var chosen = candidates[0];

            item.FileName = chosen.FileName;
            item.DeliveredFileName = chosen.FileName;
            item.SeenAt = chosen.SeenAt;

            if (candidates.Count > 1)
                item.Detail = "另有 " + string.Join("、", candidates.Skip(1).Select(c => c.FileName)) + " 未被采用";

            var settle = settled[chosen.FileName];
            if (!settle.Settled)
            {
                item.Status = ItemStatus.StillWriting;
                item.Detail = settle.Detail;
                record.Pending.Add(new PendingItem
                {
                    Reason = PendingReason.FileStillWriting,
                    Role = role,
                    FileName = chosen.FileName,
                    Detail = settle.Detail
                });
                continue;
            }

            item.Status = ItemStatus.Received;
            item.SizeBytes = settle.Size;
        }

        if (!hasConflict)
        {
            VerifyAgainstManifest(group, record, manifest);
        }

        // Subtitle timing only makes sense once the subtitle itself has passed its checksum and the audio duration is known.
        if (!hasConflict)
        {
            ValidateSubtitleTiming(group, record);
        }

        FinalizeStatus(record);

        if (record.Status == RevisionStatus.Passed && !_options.NoPackaging)
        {
            try
            {
                record.CompletedAt = now;
                record.PackagePath = PackageBuilder.PathFor(_options, record);
                var package = PackageBuilder.Build(_options, record, group);
                record.PackagePath = package.Path;
                record.PackageSizeBytes = package.SizeBytes;
            }
            catch (Exception ex)
            {
                record.Status = RevisionStatus.Failed;
                record.PackagePath = null;
                record.PackageSizeBytes = null;
                record.CompletedAt = null;
                record.Pending.Add(new PendingItem
                {
                    Reason = PendingReason.InvalidManifest,
                    Detail = "打包失败: " + ex.Message
                });
            }
        }

        record.Pending = record.Pending
            .GroupBy(p => (p.Reason, p.Role, p.FileName, p.Detail))
            .Select(g => g.First())
            .OrderBy(p => p.Reason)
            .ThenBy(p => p.Role is null ? 99 : AssetRoles.Order(p.Role.Value))
            .ThenBy(p => p.Detail, StringComparer.Ordinal)
            .ToList();

        return record;
    }

    private static List<(DeliveredFile File, ManifestParseResult Parsed)> ReadManifests(
        List<DeliveredFile> manifestFiles, ReceiptRecord record)
    {
        var manifests = new List<(DeliveredFile File, ManifestParseResult Parsed)>();

        foreach (var file in manifestFiles)
        {
            var text = SafeRead(file.Path, out var readError);
            if (readError is not null)
            {
                manifests.Add((file, new ManifestParseResult(null, readError)));
                record.Manifests.Add(new ManifestInfo
                {
                    FileName = file.FileName,
                    IsReadable = false,
                    ParseError = readError
                });
                continue;
            }

            var parsed = ManifestParser.Parse(file.FileName, text!);
            manifests.Add((file, parsed));
            record.Manifests.Add(new ManifestInfo
            {
                FileName = file.FileName,
                IsReadable = parsed.Manifest is not null,
                ParseError = parsed.Error,
                ContentHash = parsed.Manifest?.ContentHash,
                RawSha256 = ManifestParser.HashText(text!)
            });
        }

        return manifests;
    }

    /// <summary>True when the delivered file's content matches the manifest's declared checksum.</summary>
    private static bool ChecksumMatches(DeliveredFile file, ManifestAsset asset)
    {
        var actual = ComputeChecksum(file.Path, asset.Algorithm, out var error);
        return error is null && string.Equals(actual, asset.Checksum, StringComparison.OrdinalIgnoreCase);
    }

    private static void VerifyAgainstManifest(DeliveryGroup group, ReceiptRecord record, ProductionManifest? manifest)
    {
        if (manifest is null) return;

        // The accepted manifest is readable, settled and internally consistent; it needs no external checksum.
        var manifestItem = record.Item(AssetRole.Manifest);
        if (manifestItem is { Status: ItemStatus.Received })
        {
            manifestItem.Status = ItemStatus.Verified;
            manifestItem.ExpectedChecksum ??= manifest.RawSha256;
            manifestItem.ChecksumAlgorithm ??= "sha256";
            manifestItem.ActualChecksum ??= manifest.RawSha256;
        }


        foreach (var role in new[] { AssetRole.Mix, AssetRole.Subtitle })
        {
            if (manifest.For(role) is not null) continue;

            // A missing file is already reported as MissingFile; only call the manifest incomplete once the
            // material has actually arrived, otherwise the operator sees two conflicting explanations.
            var item = record.Item(role);
            if (item is null || item.Status is ItemStatus.Missing or ItemStatus.StillWriting) continue;

            record.Pending.Add(new PendingItem
            {
                Reason = PendingReason.InvalidManifest,
                Role = role,
                FileName = manifest.FileName,
                Detail = "制作清单没有给出" + AssetRoles.ToLabel(role) + "的校验值"
            });
            if (item.Status == ItemStatus.Received) item.Status = ItemStatus.Invalid;
        }

        foreach (var asset in manifest.Assets)
        {
            if (asset.Role == AssetRole.Manifest) continue; // its own checksum is not meaningful for intake

            var item = record.Item(asset.Role);
            if (item is null) continue;

            item.ExpectedChecksum = asset.Checksum.ToLowerInvariant();
            item.ChecksumAlgorithm = asset.Algorithm;

            // Informational: the delivered file name differs from the one the manifest names. Checksums still decide.
            if (asset.FileName is { Length: > 0 } expected
                && item.DeliveredFileName is { Length: > 0 } actual
                && !Path.GetFileName(expected).Equals(actual, StringComparison.OrdinalIgnoreCase))
            {
                var note = "清单标注的文件名为 " + Path.GetFileName(expected) + "，实际收到 " + actual;
                item.Detail = item.Detail is { Length: > 0 } ? note + "；" + item.Detail : note;
            }

            if (item.Status is ItemStatus.Missing or ItemStatus.StillWriting) continue;

            var delivered = group.Files.FirstOrDefault(f =>
                f.Role == asset.Role && item.DeliveredFileName is not null &&
                f.FileName.Equals(item.DeliveredFileName, StringComparison.Ordinal));
            if (delivered is null) continue;

            var actualChecksum = ComputeChecksum(delivered.Path, asset.Algorithm, out var hashError);
            if (hashError is not null)
            {
                item.Status = ItemStatus.Invalid;
                item.Detail = hashError;
                record.Pending.Add(new PendingItem
                {
                    Reason = PendingReason.ChecksumMismatch,
                    Role = asset.Role,
                    FileName = delivered.FileName,
                    Detail = hashError
                });
                continue;
            }

            item.ActualChecksum = actualChecksum;
            if (asset.Role == AssetRole.Mix)
                item.DurationSeconds = manifest.AudioDurationSeconds;

            if (!string.Equals(actualChecksum, asset.Checksum, StringComparison.OrdinalIgnoreCase))
            {
                item.Status = ItemStatus.ChecksumMismatch;
                item.Detail = $"期望 {asset.Algorithm}:{asset.Checksum}，实际 {asset.Algorithm}:{actualChecksum}";
                record.Pending.Add(new PendingItem
                {
                    Reason = PendingReason.ChecksumMismatch,
                    Role = asset.Role,
                    FileName = delivered.FileName,
                    Detail = item.Detail
                });
                continue;
            }

            item.Status = ItemStatus.Verified;
        }
    }

    private static void ValidateSubtitleTiming(DeliveryGroup group, ReceiptRecord record)
    {
        var subtitleItem = record.Item(AssetRole.Subtitle);
        if (subtitleItem is not { Status: ItemStatus.Verified }) return;
        if (record.AudioDurationSeconds is not > 0) return;

        var subtitleFile = group.Files.FirstOrDefault(f =>
            f.Role == AssetRole.Subtitle && subtitleItem.DeliveredFileName is not null &&
            f.FileName.Equals(subtitleItem.DeliveredFileName, StringComparison.Ordinal));
        if (subtitleFile is null) return;

        var text = SafeRead(subtitleFile.Path, out var err);
        if (err is not null)
        {
            subtitleItem.Status = ItemStatus.Invalid;
            subtitleItem.Detail = err;
            record.Pending.Add(new PendingItem
            {
                Reason = PendingReason.SubtitleInvalidTime,
                Role = AssetRole.Subtitle,
                FileName = subtitleFile.FileName,
                Detail = err
            });
            return;
        }

        var issues = SubtitleValidator.Validate(text!, record.AudioDurationSeconds);
        record.SubtitleIssues.AddRange(issues);

        foreach (var issue in issues)
        {
            record.Pending.Add(new PendingItem
            {
                Reason = issue.Kind == "out-of-bounds"
                    ? PendingReason.SubtitleOutOfBounds
                    : PendingReason.SubtitleInvalidTime,
                Role = AssetRole.Subtitle,
                FileName = subtitleFile.FileName,
                Detail = issue.Detail
            });
        }

        if (issues.Count > 0 && subtitleItem.Status == ItemStatus.Verified)
            subtitleItem.Status = ItemStatus.Invalid;
    }

    private static void FinalizeStatus(ReceiptRecord record)
    {
        if (record.Status == RevisionStatus.Conflict) return;

        // Any item still missing or settling means intake is not finished, even if other checks already failed.
        // A missing item outranks "still writing": nothing can complete until it arrives.
        if (record.Pending.Any(p => p.Reason == PendingReason.MissingFile))
        {
            record.Status = RevisionStatus.AwaitingAssets;
            return;
        }

        if (record.Pending.Any(p => p.Reason == PendingReason.FileStillWriting))
        {
            record.Status = RevisionStatus.Settling;
            return;
        }

        if (record.Pending.Count == 0 && record.Items.Count > 0 &&
            record.Items.All(i => i.Status == ItemStatus.Verified))
        {
            record.Status = RevisionStatus.Passed;
            return;
        }

        record.Status = RevisionStatus.Failed;
    }

    private SettleResult JudgeSettle(DeliveredFile file)
    {
        FileInfo info;
        try
        {
            info = new FileInfo(file.Path);
            if (!info.Exists) return new SettleResult(false, 0, "文件已不存在");
        }
        catch (IOException)
        {
            return new SettleResult(false, 0, "文件暂时无法访问");
        }

        var size = info.Length;
        var lastWriteUtc = info.LastWriteTimeUtc;

        if (_options.SettleAlreadySatisfied)
            return new SettleResult(true, size, "已确认写入完成");

        // Settle on stability we have actually observed: a file whose size and mtime have not moved for the
        // settle window across our own polls is complete. Never trust mtime alone — copy tools can preserve it.
        var observation = _observations.AddOrUpdate(
            file.Path,
            _ => new FileObservation(size, lastWriteUtc, DateTime.UtcNow, DateTime.UtcNow),
            (_, previous) => previous.Size != size || previous.Stamp != lastWriteUtc
                ? new FileObservation(size, lastWriteUtc, DateTime.UtcNow, previous.FirstSeenUtc)
                : previous);

        var stableFor = DateTime.UtcNow - observation.StableSinceUtc;
        if (stableFor >= _options.SettleTime)
            return new SettleResult(true, size, "写入完成");

        var waited = DateTime.UtcNow - observation.FirstSeenUtc;
        if (waited >= _options.MaxWaitForSettle)
        {
            // Stable-looking but never quiet long enough: accept rather than block intake forever.
            return new SettleResult(true, size, "等待超时，按稳定文件处理");
        }

        return new SettleResult(false, size,
            $"文件仍在写入（已观察 {waited.TotalSeconds:F1}s，需静止 {_options.SettleTime.TotalSeconds:F1}s）");
    }

    private static string? SafeRead(string path, out string? error)
    {
        try
        {
            error = null;
            return TextIo.Read(path);
        }
        catch (IOException ex)
        {
            error = "文件无法读取: " + ex.Message;
            return null;
        }
        catch (UnauthorizedAccessException ex)
        {
            error = "文件无法读取: " + ex.Message;
            return null;
        }
    }

    private static string? ComputeChecksum(string path, string algorithm, out string? error)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var hash = algorithm.ToLowerInvariant() switch
            {
                "md5" => MD5.HashData(stream),
                "sha1" => SHA1.HashData(stream),
                _ => SHA256.HashData(stream)
            };
            error = null;
            return Convert.ToHexString(hash).ToLowerInvariant();
        }
        catch (IOException ex)
        {
            error = "文件无法读取，无法计算校验值: " + ex.Message;
            return null;
        }
    }

    private static string Fingerprint(ReceiptRecord record)
    {
        var sb = new StringBuilder();
        sb.Append(record.Status).Append('|').Append(record.PackagePath).Append('|').Append(record.AudioDurationSeconds);
        foreach (var i in record.Items)
            sb.Append('|').Append(i.Role).Append(i.Status).Append(i.SizeBytes).Append(i.ActualChecksum);
        foreach (var p in record.Pending)
            sb.Append('|').Append(p.Reason).Append(p.Role).Append(p.FileName).Append(p.Detail);
        foreach (var m in record.Manifests)
            sb.Append('|').Append(m.RawSha256).Append(m.ContentHash);
        return sb.ToString();
    }
}

internal sealed record FileObservation(long Size, DateTime Stamp, DateTime StableSinceUtc, DateTime FirstSeenUtc);


internal sealed record SettleResult(bool Settled, long Size, string Detail);

internal sealed record DeliveredFile(AssetRole Role, string Path, string FileName)
{
    public DateTimeOffset? SeenAt
    {
        get
        {
            try
            {
                return File.Exists(Path)
                    ? new DateTimeOffset(DateTime.SpecifyKind(File.GetLastWriteTimeUtc(Path), DateTimeKind.Utc))
                    : null;
            }
            catch (IOException)
            {
                return null;
            }
        }
    }
}

internal sealed class DeliveryGroup
{
    public DeliveryGroup(string programme, string revision)
    {
        Programme = programme;
        Revision = revision;
    }

    public string Programme { get; }
    public string Revision { get; }
    public List<DeliveredFile> Files { get; } = [];
}
