using System.Text.Json;
using System.Text.Json.Serialization;

namespace BroadcastIntake;

/// <summary>
/// Durable receipt store. Records live in <c>records.json</c> inside the state directory and are keyed
/// by programme + revision. A record that has passed is frozen: re-delivery never replaces it.
/// </summary>
public sealed class IntakeStore
{
    private const string FileName = "records.json";
    private const string LockName = "records.lock";

    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // Enums are written and read by name so records.json and the JSON lookup output stay legible.
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly string _stateDirectory;
    private readonly string _recordsPath;
    private readonly string _lockPath;

    public IntakeStore(string stateDirectory)
    {
        if (string.IsNullOrWhiteSpace(stateDirectory))
            throw new ArgumentException("state directory is required", nameof(stateDirectory));

        _stateDirectory = Path.GetFullPath(stateDirectory);
        Directory.CreateDirectory(_stateDirectory);
        _recordsPath = Path.Combine(_stateDirectory, FileName);
        _lockPath = Path.Combine(_stateDirectory, LockName);
    }

    public string StateDirectory => _stateDirectory;

    /// <summary>Take an exclusive cross-process lock around a read-modify-write cycle.</summary>
    public IDisposable AcquireLock()
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true)
        {
            try
            {
                return new FileStream(_lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException) when (DateTime.UtcNow < deadline)
            {
                Thread.Sleep(50);
            }
        }
    }

    public IReadOnlyList<ReceiptRecord> LoadAll()
    {
        if (!File.Exists(_recordsPath)) return new List<ReceiptRecord>();

        StoreDocument? document = null;
        var corrupt = false;

        // The stream is closed before any rename, so the corrupt-file backup works on every platform.
        try
        {
            using (var stream = new FileStream(_recordsPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                document = JsonSerializer.Deserialize<StoreDocument>(stream, JsonOptions);
        }
        catch (JsonException)
        {
            corrupt = true;
        }

        if (corrupt)
        {
            // A corrupt store must not be silently discarded: preserve it for inspection.
            var backup = _recordsPath + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
            File.Move(_recordsPath, backup, overwrite: false);
            throw new InvalidDataException(
                $"收件记录文件损坏，已保留为 {backup}；请检查后再继续。");
        }

        return document?.Records ?? new List<ReceiptRecord>();
    }

    public ReceiptRecord? Get(string programme, string revision)
    {
        var key = ReceiptRecord.RecordKey(programme, revision);
        return LoadAll().FirstOrDefault(r => r.Key == key);
    }

    public IReadOnlyList<ReceiptRecord> All() => LoadAll();

    /// <summary>Replace the stored record set atomically. Used by the intake pass and by operator actions (reopen).</summary>
    public void SaveAll(IEnumerable<ReceiptRecord> records)
    {
        var ordered = records
            .GroupBy(r => r.Key)
            .Select(g => g.Last())
            .OrderBy(r => r.Programme, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Revision, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var document = new StoreDocument { Version = 1, Records = ordered };
        var json = JsonSerializer.Serialize(document, JsonOptions);

        var temp = _recordsPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temp, json);
        File.Move(temp, _recordsPath, overwrite: true);
    }

    /// <summary>Envelope for records.json. Public so the JSON serializer can construct it.</summary>
    public sealed class StoreDocument
    {
        public int Version { get; set; }

        public List<ReceiptRecord> Records { get; set; } = new();
    }
}
