# 节目包收件与校验（BroadcastIntake）

族播节目包在混音、字幕、制作清单三份素材齐全并通过检查后，才会生成可送播控的压缩包。
本仓库提供：

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| 收件库 | `src/BroadcastIntake/` | 扫描收件目录、按节目+修订归组、等待写入、校验、冲突处理、打包、持久化收件记录、查询 API |
| 收件程序 | `src/BroadcastIntake.Cli/` | `scan` / `watch` / `query` / `list` / `reopen` 命令 |
| 测试 | `tests/BroadcastIntake.Tests/` | 自包含测试（不依赖 NuGet 或外部测试框架） |

## 工作流

1. **两组素材投到同一个目录**（混音+字幕 一组，制作清单 另一组），可能相隔数小时。
2. **归组**：文件名遵循 `节目号_修订号_角色.扩展名`，例如
   `P12345_R2_mix.wav`、`P12345_R2_subtitle.srt`、`P12345_R2_manifest.json`。
   修订号可写 `R2` / `V2` / `REV2` / 裸数字，也可与节目号粘连（`P12345R2_mix.wav`）；
   未写角色词时按扩展名判定。
3. **等待写入完成**：文件的尺寸与修改时间在静止窗口内不再变化（默认 2 秒）才视为写完；
   时间上限（默认 10 分钟）到达后按稳定文件处理，避免永久阻塞。
4. **进度**：每条记录都列出**已收到**的素材和**仍缺**的素材。
5. **校验**：制作清单给出各素材校验值（SHA-256/SHA-1/MD5）与音频时长；
   先核对校验值，再检查字幕起止时间是否有效、末条是否超过音频时长。
6. **冲突**：同一修订号收到两份**内容不同**的制作清单时，记录状态置为 `Conflict`，
   待办里写明冲突文件，留给制作人员处理；内容相同、格式不同的清单不算冲突。
7. **打包**：仅当所有素材 `Verified` 且无任何待办时生成 `packages/节目号_修订号.zip`
   （内含三份素材与 `receipt.json` 回执），并记录包路径与完成时间。
8. **收件记录冻结**：一旦打包完成，重复投递同一修订号返回**同一条收件记录**
   （相同收件时间、完成时间与包路径）。如需重新检查，用 `reopen`。

## 状态与待办分类

`RevisionStatus`：`AwaitingAssets`（等待素材）、`Settling`（等待写入完成）、
`Conflict`（清单冲突）、`Failed`（检查未通过）、`Passed`（已打包）。

`PendingReason`（播控可直接按此分类）：

| 待办 | 含义 |
| --- | --- |
| `MissingFile` | 缺文件 |
| `FileStillWriting` | 文件仍在写入 |
| `ChecksumMismatch` | 校验失败 |
| `InvalidManifest` | 清单无效（缺校验值、缺时长、不可解析） |
| `ManifestConflict` | 清单冲突 |
| `SubtitleInvalidTime` | 字幕时间无效 |
| `SubtitleOutOfBounds` | 字幕越界 |

## 收件程序用法

```sh
# 一次性收件（等待写入完成后检查并打包）
dotnet run --project src/BroadcastIntake.Cli -- scan --drop ./drop --state ./state

# 持续监视（收到一份先显示进度，收齐后再判定）
dotnet run --project src/BroadcastIntake.Cli -- watch --drop ./drop --state ./state --interval 1

# 播控查询：包位置、收件时间、待办分类
dotnet run --project src/BroadcastIntake.Cli -- query --state ./state \
    --programme P12345 --revision R2 --json

# 列出全部 / 仅未通过
dotnet run --project src/BroadcastIntake.Cli -- list --state ./state
dotnet run --project src/BroadcastIntake.Cli -- list --state ./state --pending --json

# 解除冻结，下次扫描重新检查
dotnet run --project src/BroadcastIntake.Cli -- reopen --state ./state \
    --programme P12345 --revision R2
```

退出码：`0` 成功；`2` 仍有未通过修订；`3` 用法或环境错误；`4` 未找到记录。

## C# 集成（播控端）

```csharp
var query = IntakeQuery.Open("/path/to/state");
var record = query.Get("P12345", "R2");
if (record is not null)
{
    var lookup = PackageLookup.From(record);
    Console.WriteLine(lookup.PackagePath);        // 包位置
    Console.WriteLine(lookup.ReceivedAt);         // 收件时间
    Console.WriteLine(lookup.ReadyToSend);        // 是否可送播

    foreach (var pending in lookup.Pending)
        Console.WriteLine($"{pending.Reason} {pending.Role}"); // 缺文件 / 校验失败 / 字幕越界
}
```

## 制作清单格式

JSON：

```json
{
  "programme": "P12345",
  "revision": "R2",
  "audioDuration": 12.5,
  "assets": {
    "mix": { "file": "P12345_R2_mix.wav", "checksum": "sha256:..." },
    "subtitle": { "file": "P12345_R2_subtitle.srt", "checksum": "sha256:..." }
  }
}
```

文本键值：

```text
programme: P12345
revision: R2
audio_duration: 12.5
mix: P12345_R2_mix.wav sha256:...
subtitle: sha256:...
```

## 构建与测试

```sh
./run-tests.sh          # 构建并运行自包含测试
```

`artifacts/naming_check.py` 是命名规则的独立交叉检查（Python 转写 C# 正则），
在没有 .NET 工具链的环境里也能验证命名解析。

## 目录约定

- 收件目录（`--drop`）：只放投递文件；隐藏文件（以 `.` 开头）与不符合命名的文件会被忽略并给出提示。
- 状态目录（`--state`）：`records.json`（收件记录）、`records.lock`（跨进程写锁）、
  `packages/`（生成的压缩包）。
