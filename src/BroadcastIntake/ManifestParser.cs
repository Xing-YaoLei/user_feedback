using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace BroadcastIntake;

/// <summary>One asset entry declared by a production manifest.</summary>
public sealed record ManifestAsset(string RoleToken, AssetRole Role, string? FileName, string Algorithm, string Checksum);

/// <summary>Parsed production manifest: expected checksums per asset plus the audio duration.</summary>
public sealed class ProductionManifest
{
    public string FileName { get; init; } = "";
    public string? Programme { get; init; }
    public string? Revision { get; init; }

    /// <summary>Audio duration in seconds.</summary>
    public double? AudioDurationSeconds { get; init; }

    public List<ManifestAsset> Assets { get; init; } = new();

    /// <summary>Hash of the semantic content, ignoring formatting, file name and key order.</summary>
    public string ContentHash { get; init; } = "";

    public string RawSha256 { get; init; } = "";

    public ManifestAsset? For(AssetRole role) => Assets.FirstOrDefault(a => a.Role == role);
}

public sealed record ManifestParseResult(ProductionManifest? Manifest, string? Error);

/// <summary>
/// Reads production manifests in JSON or the plain key/value form.
/// JSON supports <c>{ "audioDuration": 12.5, "assets": { "mix": { "checksum": "sha256:..." } } }</c>;
/// the text form accepts <c>audio_duration: 12.5</c> and <c>mix: file.wav sha256:abc...</c>.
/// </summary>
public static class ManifestParser
{
    private static readonly Regex ChecksumValue =
        new(@"^(?:(?<algo>sha256|sha1|md5)\s*[:=]\s*)?(?<hex>[0-9a-fA-F]{16,})$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex InlineAsset =
        new(@"^(?:(?<file>[^\s=:]+)\s+)?(?:(?<algo>sha256|sha1|md5)\s*[:=]\s*)?(?<hex>[0-9a-fA-F]{16,})$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex BareChecksum = new(@"(?<algo>sha256|sha1|md5)\s*[:=]\s*(?<hex>[0-9a-fA-F]{16,})",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static ManifestParseResult Parse(string fileName, string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new(null, "清单内容为空");

        // TextIo already removes any UTF-8/UTF-16 BOM; trim leading whitespace before sniffing the form.
        var trimmed = text.TrimStart(new[] { ' ', '\t', '\r', '\n' });

        if (trimmed.StartsWith('{') || trimmed.StartsWith('['))
            return ParseJson(fileName, trimmed, text);

        return ParseText(fileName, text);
    }

    private static ManifestParseResult ParseJson(string fileName, string trimmed, string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(trimmed, new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling = JsonCommentHandling.Skip
            });

            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return new(null, "清单不是 JSON 对象");

            string? programme = null, revision = null;
            double? duration = null;
            var assets = new List<ManifestAsset>();

            foreach (var prop in root.EnumerateObject())
            {
                var name = NormalizeKey(prop.Name);
                if (name is "programme" or "program" or "programcode" or "code")
                {
                    if (prop.Value.ValueKind == JsonValueKind.String) programme = prop.Value.GetString();
                    continue;
                }

                if (name is "revision" or "rev" or "version")
                {
                    if (prop.Value.ValueKind == JsonValueKind.String) revision = prop.Value.GetString();
                    else if (prop.Value.ValueKind == JsonValueKind.Number) revision = prop.Value.GetRawText();
                    continue;
                }

                if (name is "audioduration" or "duration" or "durationseconds" or "audioseconds" or "时长" or "音频时长")
                {
                    duration = ReadDuration(prop.Value);
                    continue;
                }

                if (name is "assets" or "files" or "materials" or "items" or "素材")
                {
                    if (prop.Value.ValueKind == JsonValueKind.Array) ReadAssetArray(prop.Value, assets);
                    else if (prop.Value.ValueKind == JsonValueKind.Object) ReadAssetObject(prop.Value, assets);
                    continue;
                }

                // Shorthand: top-level role keys, e.g. "mix": "sha256:..." or "mix": { "checksum": ... }.
                var role = AssetRoles.TryParse(prop.Name);
                if (role is not null) ReadAssetEntry(prop.Name, prop.Value, assets);

                // Also allow "mix_checksum": "sha256:..." / "mix_hash": "..." companions.
                if (name.EndsWith("checksum") || name.EndsWith("hash"))
                {
                    var keyword = name.EndsWith("checksum") ? "checksum" : "hash";
                    var prefix = name[..^keyword.Length];      // normalized: "mixchecksum" -> "mix"
                    var r = AssetRoles.TryParse(prefix);
                    if (r is not null && prop.Value.ValueKind == JsonValueKind.String)
                    {
                        var parsed = SplitChecksum(prop.Value.GetString());
                        if (parsed is not null)
                            assets.Add(new ManifestAsset(prefix, r.Value, null, parsed.Value.Algo, parsed.Value.Hex));
                    }
                }
            }

            if (assets.Count == 0)
                return new(null, "清单没有给出任何素材校验值");

            if (duration is null or <= 0)
                return new(null, "清单没有给出有效的音频时长");

            var digest = SemanticHash(duration, assets);
            var manifest = new ProductionManifest
            {
                FileName = fileName,
                Programme = programme,
                Revision = revision,
                AudioDurationSeconds = duration,
                Assets = assets,
                ContentHash = digest,
                RawSha256 = HashText(raw)
            };
            return new(manifest, null);
        }
        catch (JsonException ex)
        {
            return new(null, "清单 JSON 无法解析: " + ex.Message);
        }
    }

    private static void ReadAssetArray(JsonElement array, List<ManifestAsset> assets)
    {
        foreach (var entry in array.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object) continue;

            string? roleToken = null, fileName = null, algorithm = "sha256", checksum = null;

            foreach (var p in entry.EnumerateObject())
            {
                var k = NormalizeKey(p.Name);
                if (k is "role" or "type" or "kind" or "asset" or "material")
                    roleToken = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : null;
                else if (k is "file" or "filename" or "name" or "path")
                    fileName = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : null;
                else if (k is "algorithm" or "algo" or "hashalgorithm")
                    algorithm = p.Value.ValueKind == JsonValueKind.String ? (p.Value.GetString() ?? "sha256") : "sha256";
                else if (k is "checksum" or "hash" or "sha256" or "md5" or "sha1" or "checksumvalue")
                {
                    if (p.Value.ValueKind != JsonValueKind.String) continue;
                    var split = SplitChecksum(p.Value.GetString());
                    if (split is not null)
                    {
                        algorithm = split.Value.Algo;
                        checksum = split.Value.Hex;
                    }
                }
            }

            if (roleToken is null && fileName is not null)
            {
                var named = DropNaming.Parse(fileName);
                if (named is not null) roleToken = AssetRoles.ToWire(named.Role);
            }

            var role = AssetRoles.TryParse(roleToken);
            if (role is null || checksum is null) continue;

            assets.Add(new ManifestAsset(roleToken!, role.Value, fileName, algorithm ?? "sha256", checksum));
        }
    }

    private static void ReadAssetObject(JsonElement obj, List<ManifestAsset> assets)
    {
        foreach (var p in obj.EnumerateObject())
            ReadAssetEntry(p.Name, p.Value, assets);
    }

    private static void ReadAssetEntry(string roleToken, JsonElement value, List<ManifestAsset> assets)
    {
        var role = AssetRoles.TryParse(roleToken);
        if (role is null) return;

        string? fileName = null;
        string? algorithm = null;
        string? checksum = null;

        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                var split = SplitChecksum(value.GetString());
                if (split is not null)
                {
                    algorithm = split.Value.Algo;
                    checksum = split.Value.Hex;
                }
                else
                {
                    // A plain string may be the file name, with checksum given elsewhere.
                    fileName = value.GetString();
                }
                break;

            case JsonValueKind.Object:
                foreach (var p in value.EnumerateObject())
                {
                    var k = NormalizeKey(p.Name);
                    if (k is "file" or "filename" or "name" or "path")
                        fileName = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : null;
                    else if (k is "algorithm" or "algo")
                        algorithm = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : null;
                    else if (k is "checksum" or "hash" or "sha256" or "md5" or "sha1")
                    {
                        if (p.Value.ValueKind != JsonValueKind.String) continue;
                        var s = SplitChecksum(p.Value.GetString());
                        if (s is not null)
                        {
                            algorithm = s.Value.Algo;
                            checksum = s.Value.Hex;
                        }
                    }
                }
                break;

            case JsonValueKind.Array:
                return; // handled by ReadAssetArray
        }

        if (checksum is null) return;
        assets.Add(new ManifestAsset(roleToken, role.Value, fileName, algorithm ?? "sha256", checksum));
    }

    private static ManifestParseResult ParseText(string fileName, string raw)
    {
        string? programme = null, revision = null;
        double? duration = null;
        var assets = new List<ManifestAsset>();

        foreach (var line in raw.Split('\n'))
        {
            var text = line.Trim();
            if (text.Length == 0 || text.StartsWith('#') || text.StartsWith("//")) continue;

            var colon = text.IndexOf(':');
            if (colon <= 0)
            {
                // A bare "<hash> *<file>" line is GNU style; try it as a checksum record.
                var bare = Regex.Match(text, @"^(?<algo>sha256|sha1|md5)\s+(?<hex>[0-9a-fA-F]{16,})\s+\*?(?<file>\S+)",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                if (bare.Success)
                {
                    var fileNamePart = bare.Groups["file"].Value;
                    var named = DropNaming.Parse(fileNamePart);
                    if (named is not null)
                        assets.Add(new ManifestAsset(AssetRoles.ToWire(named.Role), named.Role, fileNamePart,
                            NormalizeAlgorithm(bare.Groups["algo"].Value), bare.Groups["hex"].Value));
                }
                continue;
            }

            var key = text[..colon].Trim();
            var value = text[(colon + 1)..].Trim();
            var norm = NormalizeKey(key);

            if (norm is "programme" or "program" or "programcode" or "code")
            {
                programme = value;
                continue;
            }

            if (norm is "revision" or "rev" or "version")
            {
                revision = value;
                continue;
            }

            if (norm is "audioduration" or "duration" or "durationseconds" or "audioseconds" or "音频时长" or "时长")
            {
                duration = TryParseDuration(value);
                continue;
            }

            var role = AssetRoles.TryParse(key);
            if (role is not null)
            {
                var m = InlineAsset.Match(value);
                if (m.Success)
                {
                    var file = m.Groups["file"].Success ? m.Groups["file"].Value : null;
                    var algo = m.Groups["algo"].Success ? m.Groups["algo"].Value : "sha256";
                    assets.Add(new ManifestAsset(key, role.Value, file, NormalizeAlgorithm(algo), m.Groups["hex"].Value));
                }
                else
                {
                    var c = BareChecksum.Match(value);
                    if (c.Success)
                        assets.Add(new ManifestAsset(key, role.Value, null, NormalizeAlgorithm(c.Groups["algo"].Value), c.Groups["hex"].Value));
                }
                continue;
            }

            // "<role>_checksum: sha256:..." / "<role>_hash: ..." form.
            if (norm.EndsWith("checksum") || norm.EndsWith("hash"))
            {
                var keyword = norm.EndsWith("checksum") ? "checksum" : "hash";
                var prefix = norm[..^keyword.Length];      // "mixchecksum" -> "mix"
                var r = AssetRoles.TryParse(prefix);
                var s = SplitChecksum(value);
                if (r is not null && s is not null)
                    assets.Add(new ManifestAsset(prefix, r.Value, null, s.Value.Algo, s.Value.Hex));
            }
        }

        if (assets.Count == 0)
            return new(null, "清单没有给出任何素材校验值");
        if (duration is null or <= 0)
            return new(null, "清单没有给出有效的音频时长");

        var manifest = new ProductionManifest
        {
            FileName = fileName,
            Programme = programme,
            Revision = revision,
            AudioDurationSeconds = duration,
            Assets = assets,
            ContentHash = SemanticHash(duration, assets),
            RawSha256 = HashText(raw)
        };
        return new(manifest, null);
    }

    /// <summary>
    /// Identity of a manifest's substance: the audio duration plus each asset's algorithm and checksum.
    /// Programme/revision annotations and formatting are deliberately excluded, so two manifests that agree
    /// on the actual material are not treated as a conflict; a disagreeing annotation is reported separately.
    /// </summary>
    private static string SemanticHash(double? duration, List<ManifestAsset> assets)
    {
        var sb = new StringBuilder();
        sb.Append(duration?.ToString("R", CultureInfo.InvariantCulture)).Append('\u0001');

        foreach (var a in assets.OrderBy(a => (int)a.Role).ThenBy(a => a.Algorithm).ThenBy(a => a.Checksum))
        {
            sb.Append(AssetRoles.ToWire(a.Role)).Append('\u0002')
              .Append(a.Algorithm.ToLowerInvariant()).Append('\u0002')
              .Append(a.Checksum.ToLowerInvariant()).Append('\u0001');
        }

        return HashText(sb.ToString());
    }

    internal static string HashText(string text)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(text));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static (string Algo, string Hex)? SplitChecksum(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var m = ChecksumValue.Match(value.Trim());
        if (!m.Success) return null;

        var algo = m.Groups["algo"].Success ? NormalizeAlgorithm(m.Groups["algo"].Value) : "sha256";
        var hex = m.Groups["hex"].Value.ToLowerInvariant();

        // Infer the algorithm from the digest length when none is written.
        if (!m.Groups["algo"].Success)
        {
            algo = hex.Length switch
            {
                32 => "md5",
                40 => "sha1",
                _ => "sha256"
            };
        }

        var expected = algo switch { "md5" => 32, "sha1" => 40, _ => 64 };
        if (hex.Length != expected) return null;
        return (algo, hex);
    }

    private static string NormalizeAlgorithm(string algo) => algo.Trim().ToLowerInvariant() switch
    {
        "md5" => "md5",
        "sha1" or "sha-1" => "sha1",
        _ => "sha256"
    };

    private static double? ReadDuration(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Number => element.TryGetDouble(out var d) ? d : null,
            JsonValueKind.String => TryParseDuration(element.GetString()),
            _ => null
        };
    }

    /// <summary>Accepts seconds, or <c>hh:mm:ss.fff</c> / <c>mm:ss.fff</c> / <c>12s</c> forms.</summary>
    public static double? TryParseDuration(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;

        var text = value.Trim().ToLowerInvariant().TrimEnd('s', '秒');
        if (text.Contains(':'))
        {
            var parts = text.Split(':');
            if (parts.Length is 2 or 3 && double.TryParse(parts[^1], NumberStyles.Float, CultureInfo.InvariantCulture, out var secs))
            {
                var total = secs;
                if (!double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var a)) return null;
                total += a * (parts.Length == 3 ? 3600 : 60);
                if (parts.Length == 3)
                {
                    if (!double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var b)) return null;
                    total += b * 60;
                }
                return total >= 0 ? total : null;
            }
            return null;
        }

        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && d >= 0 ? d : null;
    }

    private static string NormalizeKey(string key)
    {
        var sb = new StringBuilder(key.Length);
        foreach (var ch in key)
            if (char.IsLetterOrDigit(ch) || ch > 127)
                sb.Append(char.ToLowerInvariant(ch));
        return sb.ToString();
    }
}
