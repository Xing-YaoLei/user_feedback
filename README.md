# grpc-web-response-decoder

An incremental **gRPC-Web response body decoder for Node.js**, written in
TypeScript with no runtime dependencies.  It decodes HTTP 200 response bodies
in both `application/grpc-web` (binary) and `application/grpc-web-text`
(base64) form, and it is strict about what counts as a successful call.

```bash
npm test        # runs the full suite with Node's built-in test runner
```

Requires Node.js ≥ 22.6 (uses native TypeScript type-stripping; no build step,
no compiler, no dependencies).

---

## Why "HTTP 200" is not success

A gRPC-Web response carries its call status in a **trailer frame** at the end of
the body.  A browser proxy can report HTTP 200, deliver several data messages,
and still end the call with a non-zero `grpc-status` — or the body can be cut
off before the trailer ever arrives.  This decoder therefore:

* emits messages **in arrival order** as soon as their frames complete;
* emits the **trailer item exactly once, from `finish()`**, and only after the
  *entire* input has been validated;
* **fails** when the input ends without a trailer, when a frame is truncated,
  and when a frame follows the trailer;
* distinguishes a **non-zero gRPC status** (a well-formed response whose call
  failed → `GrpcStatusError`) from a **wire-format error** (undecodable →
  `ProtocolError` and friends).

## Wire format handled

```
+--------+------------------+------------------+
| flag   | length (u32 BE)  | payload          |
| 1 byte | 4 bytes          | `length` bytes   |
+--------+------------------+------------------+
```

| flag   | meaning                    | this decoder        |
|--------|----------------------------|---------------------|
| `0x00` | uncompressed data frame    | decoded as message  |
| `0x80` | uncompressed trailer frame | decoded as trailer  |
| `0x01` | compressed data frame      | `UnsupportedCompressionError` |
| `0x81` | compressed trailer frame   | `UnsupportedCompressionError` |
| other  | undefined                  | `ProtocolError` (`MALFORMED_FRAME`) |

The trailer payload is a CRLF-separated block of lower-case `name: value`
fields with no start line and no terminating blank line.  `grpc-status` must
appear **exactly once** and hold a defined code (0–16); `grpc-message` is
percent-decoded as UTF-8.

## Quick start

### Stream adapter (bytes in, items out)

```ts
import { createDecoderStream } from './src/index.ts';

const decoder = createDecoderStream({ mode: 'binary' }); // or 'text'
httpResponse.on('data', (chunk) => decoder.write(chunk));
httpResponse.on('end', () => decoder.end());

for await (const item of decoder) {
  if (item.type === 'message') handleMessage(item.data); // Buffer, in order
  // item.type === 'trailer' -> item.status / item.statusText / item.message
}

// Authoritative outcome. Resolves only after the whole body validated.
const { trailer } = await decoder.completion; // rejects on failure
```

### HTTP convenience wrapper

```ts
import { decodeHttpResponseBody } from './src/index.ts';

const { messages, trailer } = await decodeHttpResponseBody(
  responseBodyAsyncIterable,
  { status: response.status, contentType: response.headers['content-type'] },
);

if (trailer.status !== 0) {
  // Unreachable: a non-zero status rejects with GrpcStatusError.
}
```

### Pull API, no streams

```ts
import { decodeResponse } from './src/index.ts';

const { messages, trailer } = decodeResponse(bodyBuffer, { mode: 'text' });
```

### Lower-level, incremental

```ts
import { GrpcWebResponseDecoder } from './src/index.ts';

const decoder = new GrpcWebResponseDecoder({ mode: 'text' });
for (const chunk of chunks) {
  decoder.write(chunk);
  for (let m = decoder.next(); m !== null; m = decoder.next()) use(m.data);
}
const trailer = decoder.finish(); // throws unless the whole exchange is valid
```

## Terminal-state matrix

| Situation                                         | Stream                              | `completion`               |
|---------------------------------------------------|-------------------------------------|----------------------------|
| Complete body, `grpc-status: 0`                    | messages, then trailer, then `end`  | resolves                   |
| Complete body, `grpc-status: 5`                    | messages, then trailer (`status: 5`) | rejects `GrpcStatusError`  |
| No trailer frame                                   | messages, then `error`              | rejects `ProtocolError`    |
| Truncated header / payload / base64                | messages, then `error`              | rejects `ProtocolError`    |
| Any bytes after the trailer (even a partial frame) | messages, then `error`              | rejects `ProtocolError` (`FRAME_AFTER_TRAILER`) |
| Compressed flag                                    | messages, then `error`              | rejects `UnsupportedCompressionError` |
| `maxMessageSize` exceeded                          | messages, then `error`              | rejects `LimitError`       |
| `maxUnparsedBytes` exceeded                        | messages, then `error`              | rejects `LimitError`       |
| `cancel()` / aborted `AbortSignal` / `destroy()`   | stops; **no trailer**               | rejects `CancelledError`   |
| HTTP status ≠ 200                                  | —                                   | `HttpStatusError`          |

A trailer item is **never** emitted for a wire-format failure.  A non-zero
status **is** fully received, so its trailer is delivered and the failure is
reported through `completion` (and through `trailer.status` for pure item
consumers).

## grpc-web-text segmentation

`application/grpc-web-text` bodies are base64, but producers differ:

* one encode of the whole stream (padding only at the very end), or
* one padded base64 block per write, concatenated.

Base64 segment boundaries have nothing to do with gRPC frame boundaries, and
network chunks may split a quartet, a padding run, a frame header, or a trailer
line anywhere.  The decoder handles all of this: it keeps only the partial
quartet between feeds, resets at every padding sequence, and emits decoded
bytes as soon as they exist.  ASCII whitespace between base64 characters is
ignored.  A dangling quartet or an unfinished padding run at end-of-input is
reported as truncated input.

## Limits and backpressure

* **`maxMessageSize`** (default 4 MiB) caps one data frame payload and is
  enforced as soon as its 5-byte header arrives — an oversized frame is refused
  before its payload is buffered.
* **`maxUnparsedBytes`** (default 8 MiB) caps bytes still buffered after every
  complete frame has been consumed (a header promising more than arrives, a
  stalled trailer, junk between frames).

They interact only as expected: a frame that is legal by size but arrives in
many small chunks necessarily accumulates as unparsed bytes, so
`maxUnparsedBytes` should be at least `maxMessageSize + 5` for such traffic.
The defaults (4 MiB / 8 MiB) satisfy that.

The stream adapter decodes lazily, one message at a time.  When the readable
side is full (`push()` returns `false`) it withholds the write callback, so Node
stops calling `_write`, the writable buffer fills, and upstream `write()`
returns `false` / `drain` waits.  A paused consumer therefore stops decoding at
the source rather than accumulating an internal queue.  `cancel()` releases any
withheld callback so upstream never hangs.

`completion` settles as soon as the outcome is known.  The readable side
delivers the trailer item and the `end` event on the usual stream schedule,
which may be a later tick — so code that inspects items collected from `data`
events should await `end` (or use `for await`) before reading them.

## Module layout

| File                | Responsibility                                            |
|---------------------|-----------------------------------------------------------|
| `src/index.ts`      | public entry point                                        |
| `src/decoder.ts`    | incremental decoder (`write`/`next`/`finish`)             |
| `src/frame.ts`      | frame header parsing, flag and size validation             |
| `src/base64.ts`     | streaming base64 with independent-segment support          |
| `src/trailer.ts`    | strict trailer field parsing and `grpc-status` validation  |
| `src/content-type.ts` | media-type → mode negotiation                            |
| `src/http.ts`       | HTTP status/content-type checks, end-to-end helper         |
| `src/stream.ts`     | `Duplex` adapter with backpressure, cancel and `completion` |
| `src/errors.ts`     | error hierarchy and stable `code`s                         |
| `examples/basic.ts` | runnable end-to-end demo (`npm run example`)               |

## Notes on strictness

* Trailer field names must be **lower-case** tokens; a bare CR or LF, an empty
  line, or a field without `:` is rejected.
* `grpc-status` must appear **exactly once** and be one of the defined codes
  0–16.  Duplicates are rejected with `DUPLICATE_GRPC_STATUS`.
* `grpc-message` is percent-decoded as UTF-8; invalid escapes are preserved
  literally rather than corrupting the string.
* A compressed frame is refused at the moment its **header** is read — the
  payload is never buffered.
* Bytes after the trailer (even a partial frame header) are a
  `FRAME_AFTER_TRAILER` failure, not an ignored tail.

## Tests

`npm test` runs everything with the built-in `node:test` runner:

| Suite                     | Covers                                                    |
|---------------------------|-----------------------------------------------------------|
| `frames.test.ts`          | frame header flags, compression rejection, size limits, every two-way split, random chunkings |
| `base64.test.ts`          | multi-segment base64, padding, quartet splits, invalid input, cuts inside trailer lines |
| `trailer.test.ts`         | field syntax, duplicate/missing/invalid `grpc-status`, message decoding, frame-after-trailer |
| `terminal.test.ts`        | success only after full validation; non-zero vs malformed |
| `disconnect.test.ts`      | every truncated prefix, socket resets, `destroy()` mid-body |
| `limits.test.ts`          | both limits independently, progressive enforcement        |
| `interleaving.test.ts`    | several decoders interleaved without shared state         |
| `stream.test.ts`          | item order, terminal states, backpressure, cancel, pipeline |
| `http.test.ts`            | HTTP status, Content-Type, end-to-end helper              |

All fixtures are generated locally; no network or external service is used.
