using System.Globalization;
using System.Text.RegularExpressions;

namespace BroadcastIntake;

/// <summary>A parsed drop-file name: programme, revision and role.</summary>
public sealed record ParsedDropName(string Programme, string Revision, AssetRole Role, string Stem);

/// <summary>
/// Parses the intake naming convention: <c>&lt;programme&gt;_&lt;revision&gt;_&lt;role&gt;.&lt;ext&gt;</c>.
/// Separators may be <c>_</c>, <c>-</c> or <c>.</c>; the revision may be written <c>R2</c>, <c>V2</c>, <c>REV2</c>
/// or as a bare number after the programme; and the revision may be glued to the programme
/// (<c>P12345R2_mix.wav</c>). When no role token is present the extension decides.
/// The programme is returned exactly as written, separators included.
/// </summary>
public static class DropNaming
{
    private const string Sep = "[_\\-.]+";
    private const string ProgFirst = "[A-Za-z0-9\\u4e00-\\u9fff]";
    private const string ProgRest = "[A-Za-z0-9\\u4e00-\\u9fff_\\-.]*?";
    private const string Role = "[A-Za-z0-9\\u4e00-\\u9fff][A-Za-z0-9\\u4e00-\\u9fff\\-]*";
    private const string RevPrefix = "(?:(?:R|V|REV|VER|REVISION|版本|修订)\\s*)?";

    private static readonly Regex WithRole = new(
        $@"^\s*(?<prog>{ProgFirst}{ProgRest})\s*{Sep}\s*{RevPrefix}(?<rev>\d+)\s*{Sep}\s*(?<role>{Role})\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex GluedRole = new(
        $@"^\s*(?<prog>{ProgFirst}{ProgRest})\s*(?:R|V|REV|VER|REVISION)\s*(?<rev>\d+)\s*{Sep}\s*(?<role>{Role})\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex ExtensionOnly = new(
        $@"^\s*(?<prog>{ProgFirst}{ProgRest})\s*{Sep}\s*{RevPrefix}(?<rev>\d+)\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex RevisionToken =
        new(@"^(?:R|V|REV|VER|版本|修订)\s*0*(\d+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex RevisionNumberOnly =
        new(@"^0*(\d+)$", RegexOptions.CultureInvariant);

    /// <summary>Role implied by a file extension, used when the name carries no role token.</summary>
    public static AssetRole? RoleFromExtension(string extension) => extension.TrimStart('.').ToLowerInvariant() switch
    {
        "wav" or "wave" or "flac" or "aiff" or "aif" or "mp3" or "m4a" or "w64" => AssetRole.Mix,
        "srt" or "vtt" or "ass" or "ssa" => AssetRole.Subtitle,
        "json" or "yaml" or "yml" or "txt" or "csv" or "md" or "xml" => AssetRole.Manifest,
        _ => null
    };

    /// <summary>Normalise a revision token to <c>R&lt;n&gt;</c>; returns null when it is not a revision.</summary>
    public static string? NormalizeRevision(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;

        var t = token.Trim();
        Match m = RevisionToken.Match(t);
        if (!m.Success) m = RevisionNumberOnly.Match(t);
        if (!m.Success) return null;

        if (!int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var n)) return null;
        return "R" + n.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>Parse a file name (with or without extension). Returns null when it does not follow the convention.</summary>
    public static ParsedDropName? Parse(string fileName)
    {
        var stem = Path.GetFileNameWithoutExtension(fileName);
        var extension = Path.GetExtension(fileName);
        if (string.IsNullOrWhiteSpace(stem)) return null;

        // 1. Explicit role token in the name.
        var m = WithRole.Match(stem);
        if (m.Success)
        {
            var role = AssetRoles.TryParse(m.Groups["role"].Value);
            var revision = NormalizeRevision(m.Groups["rev"].Value);
            var programme = Clean(m.Groups["prog"].Value);
            if (role is not null && revision is not null && programme is not null)
                return new ParsedDropName(programme, revision, role.Value, stem);
        }

        // 2. Revision glued to the programme, still with an explicit role.
        m = GluedRole.Match(stem);
        if (m.Success)
        {
            var role = AssetRoles.TryParse(m.Groups["role"].Value);
            var revision = NormalizeRevision(m.Groups["rev"].Value);
            var programme = Clean(m.Groups["prog"].Value);
            if (role is not null && revision is not null && programme is not null)
                return new ParsedDropName(programme, revision, role.Value, stem);
        }

        // 3. No role token: infer it from the extension. A bare "P12345_R2.wav" is still unambiguous.
        if (RoleFromExtension(extension) is { } extensionRole)
        {
            m = ExtensionOnly.Match(stem);
            if (m.Success)
            {
                var revision = NormalizeRevision(m.Groups["rev"].Value);
                var programme = Clean(m.Groups["prog"].Value);
                if (revision is not null && programme is not null)
                    return new ParsedDropName(programme, revision, extensionRole, stem);
            }

            // Glued form: P12345R2.wav
            var gluedOnly = Regex.Match(stem,
                $@"^\s*(?<prog>{ProgFirst}{ProgRest})\s*(?:R|V|REV|VER|REVISION)\s*(?<rev>\d+)\s*$",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (gluedOnly.Success)
            {
                var revision = NormalizeRevision(gluedOnly.Groups["rev"].Value);
                var programme = Clean(gluedOnly.Groups["prog"].Value);
                if (revision is not null && programme is not null)
                    return new ParsedDropName(programme, revision, extensionRole, stem);
            }
        }

        return null;
    }

    /// <summary>Trim separators and surrounding whitespace from a captured programme token.</summary>
    private static string? Clean(string value)
    {
        var trimmed = value.Trim().TrimEnd('_', '-', '.', ' ').TrimStart('_', '-', '.', ' ');
        return trimmed.Length == 0 ? null : trimmed;
    }

    /// <summary>Build the canonical file name for a role inside a package.</summary>
    public static string CanonicalFileName(string programme, string revision, AssetRole role, string extension)
    {
        var ext = extension.StartsWith('.') ? extension : "." + extension;
        return $"{programme}_{revision}_{AssetRoles.ToWire(role)}{ext.ToLowerInvariant()}";
    }
}
