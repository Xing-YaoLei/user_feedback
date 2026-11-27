# response-coding

A response encoder for a Node.js HTTP gateway. It negotiates `gzip`, `br` or
`identity` from the request's `Accept-Encoding` preferences, and — when it
actually changes the bytes — keeps `Content-Length`, `ETag` and `Vary` honest
about what goes on the wire.

Written for Node 26's built-in TypeScript support: no build step, no runtime
dependencies.

## Requirements

- Node.js ≥ 22.6 (tested on 26.8.1). Erasable TypeScript is executed directly;
  there is nothing to build and no runtime dependency.

## Run the tests

```sh
npm test
```

`npm test` runs the full suite with `node --test`. It uses only local synthetic
data: an in-process "gateway" adapter and, for the end-to-end tests, a real
HTTP server bound to `127.0.0.1` on an ephemeral port. No external services,
no network access, no files written outside the workspace.

Covered scenarios include the required 200 → compression → failure sequence:
a 200 response with a strong `ETag` and a known `Content-Length` is streamed
through the encoder in chunks; the healthy path decompresses back to the
original payload, while a response that dies after its first output chunk
aborts — its partial bytes never decode and are never mistaken for a valid
empty gzip/br representation.

Optional static check (needs the dev dependencies installed via `npm install`):

```sh
npm run typecheck
```

## Run the demo

```sh
node src/cli.ts
```

Prints a set of `curl` commands that exercise gzip/br/identity, 406 and 206
pass-through against a local fixture server. `scripts/demo.sh` does the same in
one shot if you have `curl` and `gunzip` available.

## API

```ts
import { encodeResponse, NotAcceptableError } from './src/index.ts';

try {
  const encoded = encodeResponse({
    // Parsed Accept-Encoding preferences, or the raw header value.
    preferences: 'gzip;q=0.8, br;q=1.0, identity;q=0.5',
    response: {
      status: 200, // 200 or 206 only
      headers: {
        'Content-Type': 'text/html',
        'Content-Length': '4096',
        ETag: '"v1"',
        Vary: 'Accept-Language',
      },
    },
    body: upstreamStream, // Readable | (async) iterable | string | Uint8Array
  });

  // Use these on the wire:
  serverResponse.writeHead(encoded.status, encoded.headers.toObject());
  for await (const chunk of encoded.body) serverResponse.write(chunk);
  serverResponse.end();
  await encoded.completion; // settles only after the compressor trailer
} catch (error) {
  if (error instanceof NotAcceptableError) {
    serverResponse.writeHead(error.status, error.headers.toObject()).end();
  } else {
    throw error;
  }
}
```

### Inputs

| Field | Meaning |
| --- | --- |
| `preferences` | An `Accept-Encoding` header string, or an array/record/`Map` of `{ coding, q }` / `[coding, q]` / `{ gzip: 0.8 }` entries. `*` is supported. |
| `response.status` | `200` or `206`. Anything else throws `InvalidResponseError`. |
| `response.headers` | A `ResponseHeaders`, an array of `[name, value]` tuples, or a plain record. The input is never mutated. |
| `body` | Node `Readable`, async iterable, iterable, `string`, `Uint8Array`, or `null`. `null`/omitted means "no body". |

### Outputs

| Field | Meaning |
| --- | --- |
| `status`, `headers` | The response to send. Headers are case-insensitive; `headers.toObject()` gives a lower-case record. |
| `coding` | Coding of the **output** representation (`gzip`, `br`, `identity`, or a pre-existing chain such as `gzip, br`). |
| `compressed` | `true` only when this module applied a coding. |
| `body` | `AsyncIterable<Uint8Array>`. Reading it is what starts the upstream. |
| `completion` | Resolves after the last compressed byte (trailer included). Rejects on upstream/compressor failure or cancellation. |
| `cancel(reason?)` | Stops the upstream, closes the compressor, rejects `completion`. |

`negotiateResponse(preferences, response, options?)` and
`encoder.negotiate(...)` perform the same negotiation without touching the
body, for callers that want the decision (and any 406) before committing.

`createResponseEncoder(defaults)` returns a reusable encoder that merges
gateway-wide defaults (`codings`, `highWaterMark`, `gzipOptions`,
`brotliOptions`, `signal`, `compressorFactory`) with per-call options.

## Behaviour, precisely

### Negotiation

- Every candidate coding gets its effective q value. An explicit entry beats
  the `*` wildcard. Codings that are not named and not covered by a wildcard
  have q=0.
- `identity` is acceptable by default with **q=1** when it is not mentioned.
  A `*;q=0` wildcard removes that implicit entry unless `identity` is also
  spelled out explicitly.
- The highest q wins; ties are broken by configuration order
  (`options.codings`, default `['gzip', 'br']`, with `identity` last).
- If nothing is acceptable, `NotAcceptableError` is thrown **before any body
  byte is read**. Its `headers` already carry the merged `Vary` and drop
  representation metadata (`Content-Length`, `Content-Encoding`, `ETag`,
  `Last-Modified`, `Content-Range`) that would describe a different body.

### What is never re-compressed

- **206 responses** are forwarded byte-for-byte.
- **Responses that already carry `Content-Encoding`** are forwarded
  byte-for-byte; the coding is not doubled.
- In both cases the existing representation's coding(s) must be acceptable to
  the client, otherwise the result is a 406 before output.

### Metadata follows the bytes

- When this module compresses: it sets `Content-Encoding`, **removes**
  `Content-Length`, and **weakens a strong `ETag`** (`"x"` → `W/"x"`). An
  already-weak ETag is left alone.
- When it does not change the bytes (identity, 206, pre-encoded): the original
  `Content-Length` and validator are preserved exactly.
- `Vary: Accept-Encoding` is merged into the existing `Vary` value. An
  existing `Vary: *` stays `*`.

### Streaming and memory

- The upstream is read at the pace of the consumer. The pipeline uses bounded
  high-water marks (`options.highWaterMark`, default 64 KiB), so a paused
  client stops the upstream within a few buffers rather than draining it.
- The compressor is flushed after every chunk, so the first compressed bytes
  leave before the upstream has finished.

### Failure and cancellation

- After the first output byte has been handed over, an upstream or compressor
  failure can only **abort this response**. There is no retry, no re-encoding
  and no switch to identity: the declared `Content-Encoding` has already been
  sent.
- `completion` stays pending until the compressor's trailer is written; a
  truncated body therefore never resolves successfully.
- `cancel()` (or an aborted `options.signal`) destroys the compressor, destroys
  the upstream, and settles `completion` with `BodyAbortedError`
  (`code: 'ABORT_ERR'`). Breaking out of `for await` does the same.

## Layout

```
src/
  index.ts        public exports
  encoder.ts      negotiation plan + streaming body
  preferences.ts  Accept-Encoding parsing and q-value rules
  headers.ts      case-insensitive header collection, Vary merge, ETag weakening
  errors.ts       error types
  cli.ts          local demo server
test/
  negotiation.test.ts     parsing, q rules, selection, Vary, ETag
  passthrough.test.ts     206 and pre-encoded responses, 406 decisions
  streaming.test.ts       round-trips, incremental output, backpressure, trailer
  failure-and-cancel.test.ts  failure after output, cancellation, "not an empty body"
  http-integration.test.ts    end-to-end over a real socket
  api.test.ts             AbortSignal, reusable encoder, demo server
  support/gateway.ts      caller adapter used by the unit suites
```
