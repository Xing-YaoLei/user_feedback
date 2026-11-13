using System.Globalization;
using System.Text;

namespace BroadcastIntake;

/// <summary>
/// Read-only view onto intake records for downstream consumers such as the broadcast-control
/// (播控) system: package location, receipt time, and which kind of work is still outstanding.
/// </summary>
public sealed class IntakeQuery
{
    private readonly IntakeStore _store;

    public IntakeQuery(IntakeStore store) => _store = store;

    public static IntakeQuery Open(string stateDirectory) => new(new IntakeStore(stateDirectory));

    public ReceiptRecord? Get(string programme, string revision) =>
        _store.Get(programme, revision);

    public IReadOnlyList<ReceiptRecord> All() => _store.All();

    public IReadOnlyList<ReceiptRecord> Pending() =>
        _store.All().Where(r => !r.IsFinal).ToList();

    public IReadOnlyList<ReceiptRecord> Passed() =>
        _store.All().Where(r => r.IsFinal).ToList();
}

/// <summary>Stable machine-readable snapshot for the C# intake client / broadcast-control integration.</summary>
public sealed record PackageLookup(
    string Programme,
    string Revision,
    RevisionStatus Status,
    DateTimeOffset ReceivedAt,
    DateTimeOffset? CompletedAt,
    string? PackagePath,
    long? PackageSizeBytes,
    IReadOnlyList<string> Missing,
    IReadOnlyList<PendingLookup> Pending,
    double? AudioDurationSeconds,
    IReadOnlyList<SubtitleIssue> SubtitleIssues)
{
    public bool ReadyToSend => Status == RevisionStatus.Passed && PackagePath is not null;

    public static PackageLookup From(ReceiptRecord record) => new(
        record.Programme,
        record.Revision,
        record.Status,
        record.ReceivedAt,
        record.CompletedAt,
        record.PackagePath,
        record.PackageSizeBytes,
        record.Missing,
        record.Pending.Select(p => new PendingLookup(p.Reason, p.Role, p.FileName, p.Detail)).ToList(),
        record.AudioDurationSeconds,
        record.SubtitleIssues);
}

/// <summary>One outstanding work item, with a category the consumer can switch on.</summary>
public sealed record PendingLookup(
    PendingReason Reason,
    AssetRole? Role,
    string? FileName,
    string? Detail);

/// <summary>Text rendering used by the CLI and by any operator console.</summary>
public static class ReceiptText
{
    public static string Describe(ReceiptRecord record) => Progress(record);

    public static string Progress(ReceiptRecord record)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"节目 {record.Programme} / 修订 {record.Revision}  [{PendingText.Status(record.Status)}]");
        sb.AppendLine($"  收件时间: {record.ReceivedAt.LocalDateTime:yyyy-MM-dd HH:mm:ss}");

        if (record.CompletedAt is { } done)
            sb.AppendLine($"  打包时间: {done.LocalDateTime:yyyy-MM-dd HH:mm:ss}");

        if (record.PackagePath is { } path)
            sb.AppendLine($"  压缩包:   {path}");

        sb.AppendLine("  已收到:");
        foreach (var item in record.Items.OrderBy(i => AssetRoles.Order(i.Role)))
        {
            if (item.Status == ItemStatus.Missing) continue;
            var size = item.SizeBytes > 0 ? FormatBytes(item.SizeBytes) : "-";
            sb.AppendLine($"    - {item.RoleLabel}: {item.DeliveredFileName}（{ItemStatusText(item.Status)}，{size}）");
            if (item.Detail is { Length: > 0 } detail && item.Status != ItemStatus.Verified)
                sb.AppendLine($"      {detail}");
        }

        if (record.Missing.Count > 0)
        {
            sb.AppendLine("  仍缺:");
            foreach (var role in record.Missing)
            {
                var parsed = AssetRoles.TryParse(role);
                sb.AppendLine($"    - {(parsed is null ? role : AssetRoles.ToLabel(parsed.Value))}");
            }
        }

        if (record.Pending.Count > 0)
        {
            sb.AppendLine("  待办:");
            foreach (var pending in record.Pending.OrderBy(p => p.Reason).ThenBy(p => p.Role is null ? 99 : AssetRoles.Order(p.Role.Value)))
            {
                var role = pending.Role is null ? "" : pending.RoleLabel + " ";
                sb.AppendLine($"    - [{pending.ReasonLabel}] {role}{pending.Detail}");
            }
        }

        return sb.ToString().TrimEnd() + Environment.NewLine;
    }

    public static string ItemStatusText(ItemStatus status) => status switch
    {
        ItemStatus.Missing => "缺文件",
        ItemStatus.StillWriting => "写入中",
        ItemStatus.Received => "已收到",
        ItemStatus.ChecksumMismatch => "校验失败",
        ItemStatus.Invalid => "检查未通过",
        ItemStatus.Verified => "校验通过",
        _ => ""
    };

    public static string FormatBytes(long bytes)
    {
        if (bytes < 1024) return bytes.ToString(CultureInfo.InvariantCulture) + " B";
        var units = new[] { "KB", "MB", "GB", "TB" };
        var value = bytes / 1024.0;
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        return string.Format(CultureInfo.InvariantCulture, "{0:F1} {1}", value, units[unit]);
    }
}
