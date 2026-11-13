using System.Text.Json.Serialization;

namespace BroadcastIntake;

/// <summary>The three kinds of material a programme package needs before it can be sent to broadcast control.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AssetRole
{
    Mix,
    Subtitle,
    Manifest
}

public static class AssetRoles
{
    public static readonly AssetRole[] Required = [AssetRole.Mix, AssetRole.Subtitle, AssetRole.Manifest];

    public static int Order(AssetRole role) => role switch
    {
        AssetRole.Mix => 0,
        AssetRole.Subtitle => 1,
        AssetRole.Manifest => 2,
        _ => 3
    };

    public static string ToWire(AssetRole role) => role switch
    {
        AssetRole.Mix => "mix",
        AssetRole.Subtitle => "subtitle",
        AssetRole.Manifest => "manifest",
        _ => "unknown"
    };

    /// <summary>Human readable Chinese label used by the operator-facing output.</summary>
    public static string ToLabel(AssetRole role) => role switch
    {
        AssetRole.Mix => "混音",
        AssetRole.Subtitle => "字幕",
        AssetRole.Manifest => "制作清单",
        _ => "未知"
    };

    /// <summary>Accepts the role tokens used in file names and production manifests.</summary>
    public static AssetRole? TryParse(string? token)
    {
        if (token is null) return null;

        var t = token.Trim().ToLowerInvariant();
        if (t.Length == 0) return null;

        return t switch
        {
            "mix" or "mixdown" or "audio" or "aud" or "mx" or "main" or "混音" or "主混" => AssetRole.Mix,
            "sub" or "subs" or "subtitle" or "subtitles" or "caption" or "captions" or "cc" or "text"
                or "字幕" or "srt" or "vtt" => AssetRole.Subtitle,
            "manifest" or "productionlist" or "production-list" or "production" or "meta" or "metadata"
                or "list" or "info" or "清单" or "制作清单" => AssetRole.Manifest,
            _ => null
        };
    }
}

/// <summary>Where a revision stands in the intake pipeline.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RevisionStatus
{
    /// <summary>At least one required item has not arrived yet.</summary>
    AwaitingAssets,

    /// <summary>All items have arrived but at least one is still being written.</summary>
    Settling,

    /// <summary>Two production manifests with different content were dropped for this revision.</summary>
    Conflict,

    /// <summary>All items arrived but at least one check failed.</summary>
    Failed,

    /// <summary>All checks passed and the package was produced.</summary>
    Passed
}

/// <summary>Why a revision (or one of its items) is still pending.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum PendingReason
{
    None,

    /// <summary>A required item has not been delivered.</summary>
    MissingFile,

    /// <summary>An item is still being written to the drop directory.</summary>
    FileStillWriting,

    /// <summary>The delivered file does not match the checksum given by the production manifest.</summary>
    ChecksumMismatch,

    /// <summary>The production manifest is unreadable, incomplete, or lacks a checksum / audio duration.</summary>
    InvalidManifest,

    /// <summary>Two manifests for the same revision disagree.</summary>
    ManifestConflict,

    /// <summary>A subtitle cue has an invalid start/end time.</summary>
    SubtitleInvalidTime,

    /// <summary>A subtitle cue ends after the end of the audio.</summary>
    SubtitleOutOfBounds
}

/// <summary>Per-item state inside a revision.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ItemStatus
{
    Missing,
    StillWriting,
    Received,
    ChecksumMismatch,
    Invalid,
    Verified
}

/// <summary>One expected material inside a revision.</summary>
public sealed class AssetItem
{
    public AssetRole Role { get; set; }

    /// <summary>File name the manifest expects, when the manifest names it; otherwise the delivered file name.</summary>
    public string? FileName { get; set; }

    /// <summary>File name actually present in the drop directory.</summary>
    public string? DeliveredFileName { get; set; }

    public ItemStatus Status { get; set; }

    public long SizeBytes { get; set; }

    public string? ExpectedChecksum { get; set; }

    public string? ChecksumAlgorithm { get; set; }

    public string? ActualChecksum { get; set; }

    /// <summary>Audio duration in seconds, as declared by the manifest.</summary>
    public double? DurationSeconds { get; set; }

    public DateTimeOffset? SeenAt { get; set; }

    /// <summary>Short explanation shown to operators when the item is not verified.</summary>
    public string? Detail { get; set; }

    [JsonIgnore]
    public string RoleLabel => AssetRoles.ToLabel(Role);
}

/// <summary>A problem that keeps a revision from being packaged.</summary>
public sealed class PendingItem
{
    public PendingReason Reason { get; set; }

    public AssetRole? Role { get; set; }

    public string? FileName { get; set; }

    /// <summary>Human-readable detail, e.g. the offending subtitle cue.</summary>
    public string? Detail { get; set; }

    [JsonIgnore]
    public string ReasonLabel => PendingText.Reason(Reason);

    [JsonIgnore]
    public string? RoleLabel => Role is null ? null : AssetRoles.ToLabel(Role.Value);
}

/// <summary>One subtitle cue that failed timing validation.</summary>
public sealed class SubtitleIssue
{
    public int CueIndex { get; set; }

    public double StartSeconds { get; set; }

    public double EndSeconds { get; set; }

    public double? AudioDurationSeconds { get; set; }

    public string Kind { get; set; } = "";

    public string Detail { get; set; } = "";
}

/// <summary>A production manifest found for the revision.</summary>
public sealed class ManifestInfo
{
    public string FileName { get; set; } = "";

    /// <summary>SHA-256 of the manifest's canonical content; used to decide whether two manifests differ.</summary>
    public string? ContentHash { get; set; }

    public string RawSha256 { get; set; } = "";

    public bool IsReadable { get; set; }

    public string? ParseError { get; set; }
}

/// <summary>
/// The durable receipt record for one programme revision. Records are keyed by programme + revision;
/// once a revision passes, the record is frozen and re-delivery returns this same record.
/// </summary>
public sealed class ReceiptRecord
{
    public string Programme { get; set; } = "";

    public string Revision { get; set; } = "";

    public RevisionStatus Status { get; set; } = RevisionStatus.AwaitingAssets;

    /// <summary>When this revision was first observed in the drop directory. Never changes.</summary>
    public DateTimeOffset ReceivedAt { get; set; }

    /// <summary>When this revision last changed state in the pipeline.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>When the package was produced; null until the revision passes.</summary>
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>Absolute path of the produced zip package; null until the revision passes.</summary>
    public string? PackagePath { get; set; }

    public long? PackageSizeBytes { get; set; }

    public List<AssetItem> Items { get; set; } = [];

    /// <summary>Roles (or manifest-named files) that have not arrived yet.</summary>
    public List<string> Missing { get; set; } = [];

    public List<PendingItem> Pending { get; set; } = [];

    public List<SubtitleIssue> SubtitleIssues { get; set; } = [];

    public List<ManifestInfo> Manifests { get; set; } = [];

    /// <summary>Audio duration declared by the production manifest, in seconds.</summary>
    public double? AudioDurationSeconds { get; set; }

    [JsonIgnore]
    public string Key => RecordKey(Programme, Revision);

    /// <summary>A revision is final only once it passed and its package actually exists.</summary>
    [JsonIgnore]
    public bool IsFinal => Status == RevisionStatus.Passed && PackagePath is not null;

    public static string RecordKey(string programme, string revision)
    {
        // Normalise so a query with "2", "r2" or "R2" all find the same revision.
        var prog = programme.Trim().ToUpperInvariant();
        var rev = DropNaming.NormalizeRevision(revision) ?? revision.Trim().ToUpperInvariant();
        return prog + "/" + rev;
    }

    public AssetItem? Item(AssetRole role) => Items.FirstOrDefault(i => i.Role == role);

    /// <summary>True when any pending item is the given reason.</summary>
    public bool HasReason(PendingReason reason) => Pending.Any(p => p.Reason == reason);
}

public static class PendingText
{
    public static string Reason(PendingReason reason) => reason switch
    {
        PendingReason.MissingFile => "缺文件",
        PendingReason.FileStillWriting => "文件仍在写入",
        PendingReason.ChecksumMismatch => "校验失败",
        PendingReason.InvalidManifest => "清单无效",
        PendingReason.ManifestConflict => "清单冲突",
        PendingReason.SubtitleInvalidTime => "字幕时间无效",
        PendingReason.SubtitleOutOfBounds => "字幕越界",
        _ => ""
    };

    public static string Status(RevisionStatus status) => status switch
    {
        RevisionStatus.AwaitingAssets => "等待素材",
        RevisionStatus.Settling => "等待写入完成",
        RevisionStatus.Conflict => "清单冲突",
        RevisionStatus.Failed => "检查未通过",
        RevisionStatus.Passed => "已打包",
        _ => ""
    };
}
