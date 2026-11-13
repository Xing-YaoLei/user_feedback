using BroadcastIntake;

namespace BroadcastIntake.Tests;

internal static class NamingTests
{
    public static void ParsesStandardName()
    {
        var parsed = DropNaming.Parse("P12345_R2_mix.wav");
        TestRunner.NotNull(parsed, "应能解析 P12345_R2_mix.wav");
        TestRunner.Equal("P12345", parsed!.Programme, "节目号");
        TestRunner.Equal("R2", parsed.Revision, "修订号");
        TestRunner.Equal(AssetRole.Mix, parsed.Role, "角色");
    }

    public static void NormalizesRevision()
    {
        TestRunner.Equal("R3", DropNaming.NormalizeRevision("R3"), "R3");
        TestRunner.Equal("R3", DropNaming.NormalizeRevision("V3"), "V3");
        TestRunner.Equal("R3", DropNaming.NormalizeRevision("rev03"), "rev03");
        TestRunner.Equal("R3", DropNaming.NormalizeRevision("3"), "裸数字");
        TestRunner.True(DropNaming.NormalizeRevision("abc") is null, "abc 不是修订号");
    }

    public static void UsesExtensionForRole()
    {
        var parsed = DropNaming.Parse("SHOW-1_R1.srt");
        TestRunner.NotNull(parsed, "应能按扩展名识别角色");
        TestRunner.Equal(AssetRole.Subtitle, parsed!.Role, "srt 是字幕");
        TestRunner.Equal("SHOW-1", parsed.Programme, "节目号应保留连字符");

        var glued = DropNaming.Parse("P12345R2_mix.wav");
        TestRunner.NotNull(glued, "应能解析粘连写法的修订号");
        TestRunner.Equal("P12345", glued!.Programme, "粘连写法节目号");
        TestRunner.Equal("R2", glued.Revision, "粘连写法修订号");
    }

    public static void RejectsUnrecognisedNames()
    {
        TestRunner.True(DropNaming.Parse("notes.txt") is null, "notes.txt 不符合约定");
        TestRunner.True(DropNaming.Parse("README.md") is null, "README.md 不符合约定");
        TestRunner.True(DropNaming.Parse("P1_R2_unknownfile.bin") is null, "未知角色应拒绝");
    }
}
