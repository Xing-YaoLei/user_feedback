using System.Globalization;
using System.Text.RegularExpressions;

namespace BroadcastIntake;

/// <summary>One subtitle cue with times resolved to seconds.</summary>
public sealed record SubtitleCue(int Index, double StartSeconds, double EndSeconds, int LineNumber);

public sealed record SubtitleParseResult(List<SubtitleCue> Cues, List<SubtitleIssue> StructuralIssues);

/// <summary>Parses SRT and WebVTT subtitle files and validates their timing against the audio duration.</summary>
public static class SubtitleValidator
{
    // hh:mm:ss[,.]fff --> hh:mm:ss[,.]fff  (SRT uses a comma, WebVTT a dot)
    private static readonly Regex TimeLine =
        new(@"^\s*(?<h>\d{1,3}):(?<m>\d{2}):(?<s>\d{2})[,.](?<ms>\d{1,3})\s*-->\s*(?<h2>\d{1,3}):(?<m2>\d{2}):(?<s2>\d{2})[,.](?<ms2>\d{1,3})",
            RegexOptions.CultureInvariant);

    // mm:ss[,.]fff --> mm:ss[,.]fff, with an optional hours field
    private static readonly Regex TimeLineShort =
        new(@"^\s*(?:(?<h>\d{1,3}):)?(?<m>\d{2}):(?<s>\d{2})[,.](?<ms>\d{1,3})\s*-->\s*(?:(?<h2>\d{1,3}):)?(?<m2>\d{2}):(?<s2>\d{2})[,.](?<ms2>\d{1,3})",
            RegexOptions.CultureInvariant);

    /// <summary>How far past the audio a cue may end before it counts as out of bounds (subtitle frame rounding).</summary>
    public const double OutOfBoundsToleranceSeconds = 0.050;

    public static SubtitleParseResult Parse(string text)
    {
        var cues = new List<SubtitleCue>();
        var issues = new List<SubtitleIssue>();
        var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

        var index = 0;
        var i = 0;

        // Skip a WebVTT header and its metadata block.
        while (i < lines.Length)
        {
            var t = lines[i].Trim();
            if (t.Length == 0)
            {
                i++;
                continue;
            }

            if (t.StartsWith("WEBVTT", StringComparison.OrdinalIgnoreCase))
            {
                i++;
                continue;
            }

            if (t.Equals("NOTE", StringComparison.OrdinalIgnoreCase))
            {
                while (i < lines.Length && lines[i].Trim().Length != 0) i++;
                continue;
            }

            if (t.StartsWith("X-TIMESTAMP-MAP", StringComparison.OrdinalIgnoreCase)
                || t.StartsWith("Kind:", StringComparison.OrdinalIgnoreCase)
                || t.StartsWith("Language:", StringComparison.OrdinalIgnoreCase))
            {
                i++;
                continue;
            }

            // Optional numeric cue id.
            if (Regex.IsMatch(t, @"^\d{1,6}$") && i + 1 < lines.Length && IsTimeLine(lines[i + 1]))
            {
                i++;
                continue;
            }

            var timeLine = lines[i];
            if (!IsTimeLine(timeLine))
            {
                // Stray text before a cue; skip it rather than fail the whole file.
                i++;
                continue;
            }

            index++;
            var lineNumber = i + 1;

            // The long form (hh:mm:ss) is tried first; the short form may omit the hours field.
            Match match = TimeLine.Match(timeLine);
            if (!match.Success) match = TimeLineShort.Match(timeLine);
            if (!match.Success)
            {
                issues.Add(new SubtitleIssue
                {
                    CueIndex = index,
                    Kind = "invalid-time",
                    Detail = "无法解析时间行: " + timeLine.Trim()
                });
                i++;
                continue;
            }

            // Hours are optional in the short form; take them when present rather than assuming zero.
            string h = match.Groups["h"].Success ? match.Groups["h"].Value : "0";
            string h2 = match.Groups["h2"].Success ? match.Groups["h2"].Value : "0";

            var start = ToSeconds(h, match.Groups["m"].Value, match.Groups["s"].Value, match.Groups["ms"].Value);
            var end = ToSeconds(h2, match.Groups["m2"].Value, match.Groups["s2"].Value, match.Groups["ms2"].Value);

            if (start is null || end is null)
            {
                issues.Add(new SubtitleIssue
                {
                    CueIndex = index,
                    Kind = "invalid-time",
                    Detail = "时间值超出范围: " + timeLine.Trim()
                });
                i++;
                continue;
            }

            var startValue = start.Value;
            var endValue = end.Value;

            if (endValue <= startValue)
            {
                issues.Add(new SubtitleIssue
                {
                    CueIndex = index,
                    StartSeconds = startValue,
                    EndSeconds = endValue,
                    Kind = "invalid-time",
                    Detail = $"第 {index} 条字幕结束时间不晚于开始时间（{startValue:F3}s → {endValue:F3}s，第 {lineNumber} 行）"
                });
            }

            cues.Add(new SubtitleCue(index, startValue, endValue, lineNumber));

            // Consume the cue body up to a blank line.
            i++;
            while (i < lines.Length && lines[i].Trim().Length != 0) i++;
        }

        return new(cues, issues);
    }

    /// <summary>
    /// Validate a subtitle file against the manifest's audio duration. Returns every issue found;
    /// invalid cue times and cues ending past the audio are both reported.
    /// </summary>
    public static List<SubtitleIssue> Validate(string text, double? audioDurationSeconds)
    {
        var parsed = Parse(text);
        var issues = new List<SubtitleIssue>(parsed.StructuralIssues);

        foreach (var cue in parsed.Cues)
        {
            if (cue.StartSeconds < 0)
            {
                issues.Add(new SubtitleIssue
                {
                    CueIndex = cue.Index,
                    StartSeconds = cue.StartSeconds,
                    EndSeconds = cue.EndSeconds,
                    AudioDurationSeconds = audioDurationSeconds,
                    Kind = "invalid-time",
                    Detail = $"第 {cue.Index} 条字幕开始时间为负（{cue.StartSeconds:F3}s）"
                });
            }

            if (audioDurationSeconds is > 0)
            {
                var limit = audioDurationSeconds.Value + OutOfBoundsToleranceSeconds;
                if (cue.EndSeconds > limit)
                {
                    issues.Add(new SubtitleIssue
                    {
                        CueIndex = cue.Index,
                        StartSeconds = cue.StartSeconds,
                        EndSeconds = cue.EndSeconds,
                        AudioDurationSeconds = audioDurationSeconds,
                        Kind = "out-of-bounds",
                        Detail = $"第 {cue.Index} 条字幕结束于 {Format(cue.EndSeconds)}，超过音频时长 {Format(audioDurationSeconds.Value)}"
                    });
                }
            }
        }

        return issues;
    }

    /// <summary>The end of the latest cue, in seconds; null when the file has no cues.</summary>
    public static double? LastCueEnd(string text)
    {
        var parsed = Parse(text);
        return parsed.Cues.Count == 0 ? null : parsed.Cues.Max(c => c.EndSeconds);
    }

    private static bool IsTimeLine(string line) => TimeLine.IsMatch(line) || TimeLineShort.IsMatch(line);

    private static double? ToSeconds(string h, string m, string s, string ms)
    {
        if (!int.TryParse(h, out var hh) || !int.TryParse(m, out var mm) || !int.TryParse(s, out var ss))
            return null;
        if (mm > 59 || ss > 59) return null;

        var frac = ms.Length switch
        {
            1 => int.Parse(ms) / 10.0,
            2 => int.Parse(ms) / 100.0,
            _ => int.Parse(ms) / 1000.0
        };

        return hh * 3600 + mm * 60 + ss + frac;
    }

    public static string Format(double seconds)
    {
        var ts = TimeSpan.FromSeconds(seconds);
        var hours = (int)ts.TotalHours;
        return string.Format(CultureInfo.InvariantCulture, "{0:00}:{1:00}:{2:00}.{3:000}",
            hours, ts.Minutes, ts.Seconds, ts.Milliseconds);
    }
}
