# pro31 — 窑炉探头混合帧解析器

解析换固件后串口录制中混在一起的两种帧，统一展开为采样 JSONL。

- 旧帧 `AA 55`：序号 u32 + 温度 i16 + CRC32（覆盖序号+温度）
- 新帧 `AA 56`：负载长度 u16 + 负载（1–64 条采样）+ CRC32（覆盖长度+负载）
- 全部小端，温度单位 0.1 °C；CRC32 为标准 zlib CRC-32

## 用法

```sh
python3 frame_parser.py recording.bin [out.jsonl]
python3 -m unittest test_frame_parser -v
```

每行一个 JSON 事件：`sample`（含帧偏移、帧内位置、序号状态）、
`frame_error`（长度非法 / CRC 失败）、`truncated`（文件末尾未凑齐的候选帧）。
解析器逐段消费数据，分块方式不影响输出。
