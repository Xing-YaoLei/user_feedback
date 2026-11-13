using System.IO.Compression;
using System.Text;

namespace BroadcastIntake;

public sealed record PackageResult(string Path, long SizeBytes, IReadOnlyList<string> Entries);

/// <summary>
/// Produces the deliverable zip for a passing revision: the accepted assets under canonical names,
/// plus a receipt.json describing how the revision was checked. The archive is staged to a temp file
/// and moved into place, so a reader never sees a half-written package.
/// </summary>
public static class PackageBuilder
{
    public static readonly DateTimeOffset FixedEntryTime = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    public static string PathFor(IntakeOptions options, ReceiptRecord record) =>
        Path.Combine(options.StateDirectory, "packages", $"{record.Programme}_{record.Revision}.zip");

    internal static PackageResult Build(IntakeOptions options, ReceiptRecord record, DeliveryGroup group)
    {
        var packagesDirectory = Path.Combine(options.StateDirectory, "packages");
        Directory.CreateDirectory(packagesDirectory);

        var zipName = $"{record.Programme}_{record.Revision}.zip";
        var zipPath = Path.Combine(packagesDirectory, zipName);

        // Stage to a temp file, then atomically replace.
        var temp = zipPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var entries = new List<string>();

        using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: false))
        {
            foreach (var role in AssetRoles.Required)
            {
                var item = record.Item(role);
                if (item?.DeliveredFileName is null) continue;

                var delivered = group.Files.FirstOrDefault(f =>
                    f.Role == role && f.FileName.Equals(item.DeliveredFileName, StringComparison.Ordinal));
                if (delivered is null || !File.Exists(delivered.Path)) continue;

                // Canonical in-package name keeps the role addressable regardless of how it was dropped.
                var extension = Path.GetExtension(delivered.Path);
                var entryName = DropNaming.CanonicalFileName(record.Programme, record.Revision, role, extension);

                var entry = archive.CreateEntry(entryName, CompressionLevel.Optimal);
                entry.LastWriteTime = FixedEntryTime;

                using var source = new FileStream(delivered.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var target = entry.Open();
                source.CopyTo(target);

                entries.Add(entryName);
            }

            // A receipt inside the package makes the delivered archive self-describing.
            var receiptEntry = archive.CreateEntry("receipt.json", CompressionLevel.Optimal);
            receiptEntry.LastWriteTime = FixedEntryTime;
            using (var writer = new StreamWriter(receiptEntry.Open(), new UTF8Encoding(false)))
            {
                writer.Write(ReceiptSerializer.ToJson(record));
            }
            entries.Add("receipt.json");
        }

        File.Move(temp, zipPath, overwrite: true);

        return new PackageResult(zipPath, new FileInfo(zipPath).Length, entries);
    }
}

/// <summary>Shared receipt serialisation used by the store, the CLI and the in-package receipt.</summary>
public static class ReceiptSerializer
{
    public static string ToJson(ReceiptRecord record) =>
        System.Text.Json.JsonSerializer.Serialize(record, IntakeStore.JsonOptions);

    public static ReceiptRecord? FromJson(string json) =>
        System.Text.Json.JsonSerializer.Deserialize<ReceiptRecord>(json, IntakeStore.JsonOptions);
}
