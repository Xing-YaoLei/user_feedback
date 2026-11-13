using System.Diagnostics;

namespace BroadcastIntake.Tests;

/// <summary>Minimal self-contained test harness: no external test framework or NuGet dependency.</summary>
public static class TestRunner
{
    private static int _passed;
    private static int _failed;
    private static readonly List<string> Failures = new();

    public static int RunAll()
    {
        var tests = new (string Name, Action Body)[]
        {
            ("命名: 解析节目号、修订号与角色", NamingTests.ParsesStandardName),
            ("命名: 修订号归一化 R3/V3/03", NamingTests.NormalizesRevision),
            ("命名: 无角色词时按扩展名识别", NamingTests.UsesExtensionForRole),
            ("命名: 拒绝不符合约定文件名", NamingTests.RejectsUnrecognisedNames),
            ("清单: JSON 解析校验值与时长", ManifestTests.ParsesJson),
            ("清单: 文本键值解析", ManifestTests.ParsesText),
            ("清单: 时长格式 hh:mm:ss", ManifestTests.ParsesColonDurations),
            ("清单: 缺少校验值判为无效", ManifestTests.RejectsMissingChecksums),
            ("字幕: SRT 时间解析与越界", SubtitleTests.DetectsOutOfBounds),
            ("字幕: 结束早于开始判无效", SubtitleTests.DetectsInvalidCue),
            ("字幕: WebVTT 支持", SubtitleTests.ParsesWebVtt),
            ("收件: 先到混音时列出已收与仍缺", IntakeTests.PartialDeliveryReportsProgress),
            ("收件: 全套正确素材通过并打包", IntakeTests.CompleteDeliveryPasses),
            ("收件: 校验值不符时说明校验失败", IntakeTests.ChecksumMismatchFails),
            ("收件: 字幕越界阻止打包", IntakeTests.SubtitleOutOfBoundsFails),
            ("收件: 两份不同清单留冲突", IntakeTests.ConflictingManifestsAreHeld),
            ("收件: 相同内容的两份清单不算冲突", IntakeTests.IdenticalManifestsAreNotConflict),
            ("收件: 文件仍在写入时继续等待", IntakeTests.WaitsForFileStillWriting),
            ("收件: 再次投递同一版本返回原收件记录", IntakeTests.RedeliveryReturnsOriginalReceipt),
            ("收件: 记录跨进程重建后仍可查询", IntakeTests.ReceiptSurvivesReload),
            ("查询: 待办分类可用于播控", IntakeTests.PendingReasonsAreCategorised),
            ("打包: 包含三份素材与回执", PackagingTests.ArchiveContainsAssetsAndReceipt)
        };

        var total = Stopwatch.StartNew();
        foreach (var test in tests)
        {
            try
            {
                test.Body();
                _passed++;
                Console.WriteLine($"  ✓ {test.Name}");
            }
            catch (Exception ex)
            {
                _failed++;
                Failures.Add($"{test.Name}\n    {ex.GetType().Name}: {ex.Message}");
                Console.WriteLine($"  ✗ {test.Name}");
                Console.WriteLine($"    {ex.GetType().Name}: {ex.Message}");
            }
        }

        total.Stop();
        Console.WriteLine();
        Console.WriteLine($"通过 {_passed}，失败 {_failed}，用时 {total.ElapsedMilliseconds} ms");

        if (Failures.Count > 0)
        {
            Console.WriteLine();
            Console.WriteLine("失败明细:");
            foreach (var failure in Failures)
                Console.WriteLine("  - " + failure);
        }

        return _failed == 0 ? 0 : 1;
    }

    public static void True(bool condition, string message)
    {
        if (!condition) throw new AssertionException(message);
    }

    public static void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new AssertionException($"{message}（期望 {expected}，实际 {actual}）");
    }

    public static void NotNull(object? value, string message)
    {
        if (value is null) throw new AssertionException(message);
    }

    public static void Contains(string haystack, string needle, string message)
    {
        if (!haystack.Contains(needle, StringComparison.Ordinal))
            throw new AssertionException($"{message}（未找到 \"{needle}\"）");
    }

    public static void DoesNotContain(string haystack, string needle, string message)
    {
        if (haystack.Contains(needle, StringComparison.Ordinal))
            throw new AssertionException($"{message}（不应出现 \"{needle}\"）");
    }

    public static void Assert(bool condition, string message)
    {
        if (!condition) throw new AssertionException(message);
    }
}

public sealed class AssertionException : Exception
{
    public AssertionException(string message) : base(message) { }
}

public static class Program
{
    public static int Main() => TestRunner.RunAll();
}
