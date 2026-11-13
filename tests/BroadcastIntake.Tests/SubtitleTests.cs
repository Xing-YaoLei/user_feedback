using BroadcastIntake;

namespace BroadcastIntake.Tests;

internal static class SubtitleTests
{
    public static void DetectsOutOfBounds()
    {
        var srt = """
            1
            00:00:01,000 --> 00:00:05,000
            第一句

            2
            00:00:10,000 --> 00:00:14,000
            超出音频
            """;
        var issues = SubtitleValidator.Validate(srt, 12.5);
        TestRunner.True(issues.Any(i => i.Kind == "out-of-bounds"), "应发现字幕越界");
        TestRunner.True(issues.All(i => i.Kind != "invalid-time"), "不应误报时间无效");
        TestRunner.Equal(2, issues.Single(i => i.Kind == "out-of-bounds").CueIndex, "越界的是第 2 条");
    }

    public static void DetectsInvalidCue()
    {
        var srt = """
            1
            00:00:05,000 --> 00:00:03,000
            时间倒置

            2
            00:00:01,000 --> 00:00:02,000
            正常
            """;
        var issues = SubtitleValidator.Validate(srt, 60);
        TestRunner.True(issues.Any(i => i.Kind == "invalid-time"), "应发现结束早于开始");
    }

    public static void ParsesWebVtt()
    {
        var vtt = """
            WEBVTT

            00:00:01.000 --> 00:00:04.000
            第一句

            00:00:04.000 --> 00:00:08.000
            第二句
            """;
        var parsed = SubtitleValidator.Parse(vtt);
        TestRunner.Equal(2, parsed.Cues.Count, "应解析两条字幕");
        TestRunner.Equal(8.0, parsed.Cues[^1].EndSeconds, "末条结束时间");
        var issues = SubtitleValidator.Validate(vtt, 10);
        TestRunner.Equal(0, issues.Count, "时长 10s 内不应有问题");
    }
}
