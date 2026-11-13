using System.Text.Json;
using BroadcastIntake;

namespace BroadcastIntake.Cli;

public static class Program
{
    private const string Usage = """
        intake — 节目包收件与校验

        用法:
          intake scan   --drop <收件目录> --state <状态目录> [--no-package] [--force-settled]
          intake watch  --drop <收件目录> --state <状态目录> [--interval <秒>] [--no-package]
          intake query  --state <状态目录> --programme <节目编号> --revision <修订号> [--json]
          intake list   --state <状态目录> [--json] [--pending]
          intake reopen --state <状态目录> --programme <节目编号> --revision <修订号>

        退出码: 0 成功；2 修订仍未通过；3 用法或环境错误；4 未找到记录。
        """;

    public static int Main(string[] args)
    {
        if (args.Length == 0 || args[0] is "-h" or "--help" or "help")
        {
            Console.WriteLine(Usage);
            return args.Length == 0 ? 3 : 0;
        }

        var command = args[0];
        var options = CommandLineOptions.Parse(args.Skip(1));

        if (options.Error is not null)
        {
            Console.Error.WriteLine(options.Error);
            Console.Error.WriteLine();
            Console.Error.WriteLine(Usage);
            return 3;
        }

        try
        {
            return command switch
            {
                "scan" => Scan(options),
                "watch" => Watch(options),
                "query" => Query(options),
                "list" => List(options),
                "reopen" => Reopen(options),
                _ => Unknown(command)
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("错误: " + ex.Message);
            return 3;
        }
    }

    private static int Scan(CommandLineOptions options)
    {
        var service = CreateService(options);
        var result = service.Scan(waitForSettle: true);
        PrintWarnings(result);

        if (result.Changed.Count == 0)
            Console.WriteLine("本次扫描没有变化。");
        else
        {
            foreach (var record in result.Changed)
            {
                Console.WriteLine(ReceiptText.Progress(record));
            }
        }

        return result.All.Any(r => !r.IsFinal) ? 2 : 0;
    }

    private static int Watch(CommandLineOptions options)
    {
        var service = CreateService(options);
        var interval = TimeSpan.FromSeconds(options.IntervalSeconds);
        var lastStatus = new Dictionary<string, RevisionStatus>(StringComparer.Ordinal);
        var stopping = false;

        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            stopping = true;
        };

        Console.WriteLine($"开始监视 {options.DropDirectory}，每 {interval.TotalSeconds:F1}s 扫描一次（Ctrl+C 退出）");

        while (!stopping)
        {
            try
            {
                var result = service.Scan(waitForSettle: false);
                PrintWarnings(result);

                foreach (var record in result.All)
                {
                    var key = record.Key;
                    var changed = !lastStatus.TryGetValue(key, out var previous) || previous != record.Status;
                    lastStatus[key] = record.Status;

                    if (changed)
                        Console.WriteLine(ReceiptText.Progress(record));
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("扫描出错: " + ex.Message);
            }

            // Sleep in short slices so Ctrl+C is responsive.
            var slice = TimeSpan.FromMilliseconds(200);
            var deadline = DateTime.UtcNow + interval;
            while (!stopping && DateTime.UtcNow < deadline)
                Thread.Sleep(slice);
        }

        Console.WriteLine("已停止监视。");
        return 0;
    }

    private static int Query(CommandLineOptions options)
    {
        if (options.Programme is null || options.Revision is null)
        {
            Console.Error.WriteLine("query 需要 --programme 与 --revision。");
            return 3;
        }

        var query = IntakeQuery.Open(options.RequiredStateDirectory());
        var record = query.Get(options.Programme, options.Revision);

        if (record is null)
        {
            Console.Error.WriteLine($"未找到记录: {options.Programme} / {options.Revision}");
            return 4;
        }

        if (options.Json)
        {
            Console.WriteLine(JsonSerializer.Serialize(PackageLookup.From(record), JsonOutput.Options));
        }
        else
        {
            Console.WriteLine(ReceiptText.Progress(record));
        }

        return record.IsFinal ? 0 : 2;
    }

    private static int List(CommandLineOptions options)
    {
        var query = IntakeQuery.Open(options.RequiredStateDirectory());
        var records = options.PendingOnly ? query.Pending() : query.All();

        if (options.Json)
        {
            Console.WriteLine(JsonSerializer.Serialize(records.Select(PackageLookup.From).ToList(), JsonOutput.Options));
            return 0;
        }

        if (records.Count == 0)
        {
            Console.WriteLine("没有收件记录。");
            return 0;
        }

        Console.WriteLine(Pad("节目", 16) + " " + Pad("修订", 8) + " " + Pad("状态", 12) + " " +
                          Pad("收件时间", 18) + " " + Pad("待办", 12) + " 压缩包");
        foreach (var record in records)
        {
            var status = PendingText.Status(record.Status);
            var pending = record.Pending.Count == 0 ? "-" : DescribePendingCategories(record);
            var received = record.ReceivedAt.LocalDateTime.ToString("yyyy-MM-dd HH:mm", System.Globalization.CultureInfo.InvariantCulture);
            Console.WriteLine(Pad(record.Programme, 16) + " " + Pad(record.Revision, 8) + " " + Pad(status, 12) + " " +
                              received.PadRight(18) + " " + Pad(pending, 12) + " " + (record.PackagePath ?? "-"));
        }

        return records.Any(r => !r.IsFinal) ? 2 : 0;
    }

    /// <summary>Left-align to a display width, counting CJK characters as two columns.</summary>
    private static string Pad(string text, int width)
    {
        var columns = 0;
        foreach (var ch in text)
            columns += ch > 0x2E80 ? 2 : 1;

        if (columns >= width) return text;
        return text + new string(' ', width - columns);
    }

    private static string DescribePendingCategories(ReceiptRecord record)
    {
        var categories = record.Pending
            .Select(p => p.ReasonLabel)
            .Where(s => s.Length > 0)
            .Distinct()
            .ToList();
        return string.Join("/", categories);
    }

    private static int Reopen(CommandLineOptions options)
    {
        if (options.Programme is null || options.Revision is null)
        {
            Console.Error.WriteLine("reopen 需要 --programme 与 --revision。");
            return 3;
        }

        using var scope = new IntakeStore(options.RequiredStateDirectory()).AcquireLock();
        var store = new IntakeStore(options.RequiredStateDirectory());
        var records = store.LoadAll().ToList();
        var record = records.FirstOrDefault(r => r.Key == ReceiptRecord.RecordKey(options.Programme!, options.Revision!));

        if (record is null)
        {
            Console.Error.WriteLine($"未找到记录: {options.Programme} / {options.Revision}");
            return 4;
        }

        // Clears the freeze so the next scan re-evaluates this revision from the drop directory.
        record.Status = RevisionStatus.AwaitingAssets;
        record.CompletedAt = null;
        record.PackagePath = null;
        record.PackageSizeBytes = null;
        record.UpdatedAt = DateTimeOffset.Now;
        store.SaveAll(records);

        Console.WriteLine($"已重新打开 {record.Programme} / {record.Revision}，下次扫描将重新检查。");
        return 0;
    }

    private static IntakeService CreateService(CommandLineOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.DropDirectory))
            throw new ArgumentException("scan/watch 需要 --drop <收件目录>");

        var state = options.RequiredStateDirectory();
        var drop = Path.GetFullPath(options.DropDirectory);

        if (!Directory.Exists(drop))
            throw new DirectoryNotFoundException("收件目录不存在: " + drop);

        var store = new IntakeStore(state);
        var intakeOptions = new IntakeOptions
        {
            DropDirectory = drop,
            StateDirectory = state,
            SettleAlreadySatisfied = options.ForceSettled,
            NoPackaging = options.NoPackage
        };

        return new IntakeService(intakeOptions, store);
    }

    private static void PrintWarnings(ScanResult result)
    {
        foreach (var warning in result.Warnings.Distinct())
            Console.Error.WriteLine("提示: " + warning);
    }

    private static int Unknown(string command)
    {
        Console.Error.WriteLine($"未知命令: {command}");
        Console.Error.WriteLine();
        Console.Error.WriteLine(Usage);
        return 3;
    }
}

internal static class JsonOutput
{
    public static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
    };
}

internal sealed class CommandLineOptions
{
    public string? DropDirectory { get; private set; }
    public string? StateDirectory { get; private set; }
    public string? Programme { get; private set; }
    public string? Revision { get; private set; }
    public string? Error { get; private set; }
    public bool Json { get; private set; }
    public bool PendingOnly { get; private set; }
    public bool NoPackage { get; private set; }
    public bool ForceSettled { get; private set; }
    public double IntervalSeconds { get; private set; } = 1.0;

    public string RequiredStateDirectory()
    {
        if (string.IsNullOrWhiteSpace(StateDirectory))
            throw new ArgumentException("需要 --state <状态目录>");
        return Path.GetFullPath(StateDirectory);
    }

    public static CommandLineOptions Parse(IEnumerable<string> args)
    {
        var options = new CommandLineOptions();
        var list = args.ToList();

        for (var i = 0; i < list.Count; i++)
        {
            var arg = list[i];
            string? value = null;

            var eq = arg.IndexOf('=');
            if (arg.StartsWith("--") && eq > 2)
            {
                value = arg[(eq + 1)..];
                arg = arg[..eq];
            }

            string TakeValue(string name)
            {
                if (value is not null) return value;
                if (i + 1 >= list.Count)
                {
                    options.Error = $"{name} 缺少参数值";
                    return "";
                }
                return list[++i];
            }

            switch (arg)
            {
                case "--drop":
                case "-d":
                    options.DropDirectory = TakeValue(arg);
                    break;
                case "--state":
                case "-s":
                    options.StateDirectory = TakeValue(arg);
                    break;
                case "--programme":
                case "--program":
                case "-p":
                    options.Programme = TakeValue(arg);
                    break;
                case "--revision":
                case "--rev":
                case "-r":
                    options.Revision = TakeValue(arg);
                    break;
                case "--interval":
                case "-i":
                    var intervalText = TakeValue(arg);
                    if (double.TryParse(intervalText, out var seconds) && seconds > 0)
                        options.IntervalSeconds = seconds;
                    else
                        options.Error = "--interval 需要正数秒";
                    break;
                case "--json":
                    options.Json = true;
                    break;
                case "--pending":
                    options.PendingOnly = true;
                    break;
                case "--no-package":
                    options.NoPackage = true;
                    break;
                case "--force-settled":
                    options.ForceSettled = true;
                    break;
                default:
                    if (arg.StartsWith("-"))
                        options.Error = "未知选项: " + arg;
                    break;
            }

            if (options.Error is not null) return options;
        }

        return options;
    }
}
