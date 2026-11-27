# multipart-form-parser

Node.js 上的流式 `multipart/form-data` 解析模块（TypeScript，零依赖，使用 Node 内置
类型擦除支持直接运行 `.ts`）。

## 特性

- 输入为 Content-Type 中的 boundary 与异步字节流（`AsyncIterable<Uint8Array>`、
  `AsyncIterator` 或 `Readable` 均可），输出为**有序**的 part 序列。
- 普通字段按 UTF-8 解码为字符串（`fatal` 校验，非法 UTF-8 整次失败）；文件 part
  提供**可背压**的 `Readable` 字节流（高水位线 16KB）。
- 同名字段、同名文件严格保留原始顺序。
- 支持带引号（含 `\"`、`\\` 转义）与不带引号的 `name` / `filename` 参数。
- 按 CRLF 识别普通分隔行与结束分隔行（兼容 RFC 2046 传输填充）；前言与尾声被忽略
  但仍计入总字节量。
- 文件内容中只有**完整的分隔行**才结束 part；类似 boundary 的字节前缀原样保留。
- 分隔行、头部、多字节字符可以跨任意输入块。
- **取消当前文件**：`destroy()` 文件流后，解析器以常量内存有界地丢弃该 part 余下
  内容并定位下一 part；丢弃字节仍计入单文件与总正文限额。
- **整次取消**：中断 `for await` 迭代（或调用 `parser.cancel()`）会结束所有未完成
  的 part 并停止拉取源。
- 头部长度、字段长度、文件长度、part 数量、内部缓冲、总正文均有限额。
- 缺少结束分隔符或非法 UTF-8 字段导致整次解析失败——**已经返回的 part 不代表
  请求整体成功**。

## 使用

```ts
import { MultipartParser } from './src/index.ts';

const parser = new MultipartParser(boundary, byteStream, {
  // 可选：覆盖限额（Partial<MultipartLimits>）
  maxFileBytes: 10 * 1024 * 1024,
});

for await (const part of parser) {
  if (part.type === 'field') {
    console.log(part.name, part.value);        // value 为 UTF-8 字符串
  } else {
    // 文件 part：完整消费 part.stream，或 destroy() 取消当前文件
    for await (const chunk of part.stream) { /* ... */ }
    console.log(part.filename, part.contentType);
  }
}
// 迭代正常结束才表示整个请求解析成功；中途抛错则整体失败。
console.log(parser.bytesRead); // 从源读取的总字节数（含前言/尾声/丢弃内容）
```

约束：文件 part 的流必须先被完整消费或显式取消（`destroy()`），才能请求下一个
part，否则抛出 `UNCONSUMED_FILE`。

## 限额（`MultipartLimits`）

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `maxHeaderBytes` | 16 KB | 单个 part 头部块 |
| `maxFieldBytes` | 1 MB | 单个字段值 |
| `maxFileBytes` | 64 MB | 单个文件正文（含取消后丢弃的字节） |
| `maxParts` | 1000 | part 数量 |
| `maxBufferBytes` | 1 MB | 解析器内部缓冲 |
| `maxTotalBytes` | 256 MB | 整个请求正文（含前言、尾声、丢弃内容） |

## 错误码（`MultipartError.code`）

`LIMIT_HEADER` / `LIMIT_FIELD` / `LIMIT_FILE` / `LIMIT_PARTS` / `LIMIT_BUFFER` /
`LIMIT_TOTAL`：各类限额超限；`MISSING_DELIMITER`：缺少结束分隔符（流提前结束）；
`UNEXPECTED_EOF`：头部未完整时流结束；`INVALID_UTF8`：字段含非法 UTF-8；
`BAD_HEADERS` / `BAD_DISPOSITION`：头部或 Content-Disposition 非法；
`UNCONSUMED_FILE`：上一文件未消费/未取消就请求下一 part；`BAD_BOUNDARY` /
`REUSE`：用法错误。源自身的异常（如连接中断）原样向上传播，当前未完成的文件流
也会以同一错误失败。

## 运行

无需安装依赖（Node ≥ 22.6，推荐 23+；本仓库在 Node 26 上验证）：

```bash
npm test     # 运行全部测试（含交错取消、源崩溃、跨块、限额等场景）
npm run demo # 运行解析示例
```

## 结构

- `src/multipart.ts` — 解析器实现（`MultipartParser` / `MultipartError` / 限额）
- `src/index.ts` — 模块入口（导出 + `parseMultipart()` 便捷函数）
- `tests/multipart.test.ts` — 基于 `node:test` 的测试
- `examples/demo.ts` — 可运行示例
