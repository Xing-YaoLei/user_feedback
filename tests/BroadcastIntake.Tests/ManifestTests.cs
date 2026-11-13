using BroadcastIntake;

namespace BroadcastIntake.Tests;

internal static class ManifestTests
{
    public const string MixSha256 = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

    public static string JsonManifest(double duration = 12.5)
    {
        var d = duration.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        return $$"""
            {
              "programme": "P12345",
              "revision": "R2",
              "audioDuration": {{d}},
              "assets": {
                "mix": { "file": "P12345_R2_mix.wav", "checksum": "sha256:{{MixSha256}}" },
                "subtitle": { "file": "P12345_R2_subtitle.srt", "checksum": "sha256:{{MixSha256}}" }
              }
            }
            """;
    }

    public static void ParsesJson()
    {
        var result = ManifestParser.Parse("P12345_R2_manifest.json", JsonManifest());
        TestRunner.NotNull(result.Manifest, "应解析成功: " + result.Error);
        TestRunner.Equal<double?>(12.5, result.Manifest!.AudioDurationSeconds, "音频时长");
        TestRunner.Equal("P12345", result.Manifest.Programme, "节目号");
        TestRunner.NotNull(result.Manifest.For(AssetRole.Mix), "应有混音校验值");
        TestRunner.Equal(MixSha256, result.Manifest.For(AssetRole.Mix)!.Checksum, "混音校验值");
        TestRunner.Equal("sha256", result.Manifest.For(AssetRole.Mix)!.Algorithm, "算法");
    }

    public static void ParsesText()
    {
        var text = $$"""
            programme: P12345
            revision: R2
            audio_duration: 12.5
            mix: P12345_R2_mix.wav sha256:{{MixSha256}}
            subtitle: sha256:{{MixSha256}}
            """;
        var result = ManifestParser.Parse("P12345_R2_manifest.txt", text);
        TestRunner.NotNull(result.Manifest, "应解析成功: " + result.Error);
        TestRunner.Equal<double?>(12.5, result.Manifest!.AudioDurationSeconds, "音频时长");
        TestRunner.Equal(MixSha256, result.Manifest.For(AssetRole.Subtitle)!.Checksum, "字幕校验值");
    }

    public static void ParsesColonDurations()
    {
        TestRunner.Equal<double?>(12.5, ManifestParser.TryParseDuration("00:00:12.500"), "hh:mm:ss");
        TestRunner.Equal<double?>(90.0, ManifestParser.TryParseDuration("01:30"), "mm:ss");
        TestRunner.Equal<double?>(12.5, ManifestParser.TryParseDuration("12.5s"), "带秒标");
    }

    public static void RejectsMissingChecksums()
    {
        var result = ManifestParser.Parse("x.json", """{ "audioDuration": 10 }""");
        TestRunner.True(result.Manifest is null, "缺少素材校验值应判为无效");
        TestRunner.NotNull(result.Error, "应给出错误说明");

        var noDuration = ManifestParser.Parse("y.json", """{ "assets": { "mix": "sha256:abc" } }""");
        TestRunner.True(noDuration.Manifest is null, "缺少音频时长应判为无效");
    }
}
