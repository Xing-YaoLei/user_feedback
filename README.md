# Protobuf field rewriter

A byte-preserving Protobuf message rewriter for Node.js, written in TypeScript.
Given a complete message buffer, a field-number keyed description of the
message's known fields, and a table of replacement values, it returns a new
buffer in which **only the requested fields changed**. Every other byte — the
original tag encoding, length varint, and payload — is reproduced verbatim.

## Requirements

- Node.js **≥ 23.6** (native TypeScript type stripping, no flag needed)
- No runtime dependencies

```bash
npm install      # only needed for the optional `npm run typecheck`
npm test         # runs the full suite with node --test
npm start        # runs examples/demo.ts
npm run typecheck
```

There is no build step: Node executes the `.ts` files directly.

## The contract

```ts
import { rewriteMessage } from './src/index.ts';

const output = rewriteMessage(input, schema, replacements, { maxMessageBytes: 1 << 20 });
```

### Supported wire types

| wire type | meaning                | supported |
| --------- | ---------------------- | --------- |
| 0         | varint                 | yes       |
| 1         | 64-bit                 | yes       |
| 2         | length-delimited       | yes       |
| 3 / 4     | group start / end      | **no** — throws `UNSUPPORTED_GROUP` |
| 5         | 32-bit                 | yes       |

Anything else is rejected as `WRONG_WIRE_TYPE`.

### Supported known field types

`uint64`, `sint64`, `fixed64`, `fixed32`, `string`, `bytes`.

Numeric types (`uint64`, `sint64`, `fixed64`, `fixed32`) may be declared
`repeated`. Strings and bytes are singular; `repeated` on them is a schema
error.

### Guarantees

- **Unknown fields are opaque.** A field number not present in the schema is
  copied byte-for-byte: tag bytes (even non-canonical multi-byte encodings),
  length varint (even over-long), and payload (even invalid UTF-8).
- **Untouched known fields are opaque too.** They are only *parsed* enough to
  validate the message structure; their bytes are copied from the input.
- **Replacements land in place.** A replaced field is emitted at the byte
  position of its **first** wire occurrence; its later occurrences are dropped.
- **Missing fields are appended.** A replacement for a field that does not
  appear in the input is appended in ascending field-number order.
- **Singular fields take the last value.** `decodeMessage` reports the last
  occurrence of a singular known field, per protobuf semantics.
- **Repeated numeric fields merge in wire order.** Packed and unpacked
  occurrences are concatenated in the order they appear.
- **Repeated replacements are always packed.** Even if the input was unpacked.
- **64-bit integers keep full precision.** Values are `bigint` end to end.
  Decimal strings and safe `number`s are accepted as input; unsafe numbers are
  rejected rather than silently truncated.
- **Known strings are strict UTF-8.** Invalid input UTF-8 throws
  `INVALID_UTF8` with the offending byte offset; replacement strings with lone
  surrogates throw `INVALID_REPLACEMENT`.
- **Size ceiling.** `maxMessageBytes` applies to the input *and* the produced
  message (default 64 MiB). Exceeding it throws `SIZE_LIMIT` before or during
  assembly.
- **No partial results.** Every failure throws `ProtobufRewriteError`. There is
  no code path that returns a partially written buffer.

### Errors

`ProtobufRewriteError` carries a machine-readable `code` plus byte positions:

| code | meaning | `offset` |
| ---- | ------- | -------- |
| `VARINT_OVERFLOW` | varint needs more than 64 bits | the offending tenth byte |
| `TRUNCATED` | fixed/varint/length payload runs past the end | first byte that is missing |
| `WRONG_WIRE_TYPE` | known field encoded with an incompatible wire type | first tag byte of the field |
| `INVALID_FIELD_NUMBER` | tag with field number 0 or > 2³¹−1 | first tag byte |
| `UNSUPPORTED_GROUP` | wire type 3 or 4 anywhere in the message | first tag byte |
| `SIZE_LIMIT` | input or output exceeds the ceiling | `offset`/`outputOffset` |
| `INVALID_UTF8` | known string holds invalid UTF-8 | the malformed lead byte |
| `INVALID_SCHEMA` | bad field description | — |
| `INVALID_REPLACEMENT` | bad value or replacement for undeclared field | — |
| `INVALID_OPTIONS` / `INVALID_INPUT` | bad options or non-buffer input | — |

`fieldStart` always points at the first tag byte of the field being processed.

## Schema shapes

All of the following are equivalent and accepted:

```ts
{ 1: 'uint64', 2: { type: 'string' } }
new Map([[1, 'uint64'], [2, { type: 'string' }]])
[{ fieldNumber: 1, type: 'uint64' }, { fieldNumber: 2, type: 'string' }]
{ fields: { 1: 'uint64', 2: { type: 'string' } } }
```

Repeated numeric fields use any of `repeated: true`, `label: 'repeated'`, or
`rule: 'repeated'`.

## Replacement values

```ts
rewriteMessage(input, schema, {
  1: 42n,                                  // uint64 (bigint, safe number, or decimal string)
  2: -7n,                                  // sint64 zig-zag
  3: 0xdeadbeefcafef00dn,                  // fixed64
  4: 'text',                               // string
  5: Buffer.from([0x00, 0xff]),            // bytes
  7: [10n, '11', 12],                      // repeated uint64 -> packed
  9: [],                                   // empty repeated list -> field removed
});
```

## Other exports

```ts
import {
  decodeMessage,      // known values + unknown field bytes, no rewriting
  inspectMessage,     // every field span with its raw bytes
  rewriteAndStore,    // rewrite, then hand the complete buffer to a MessageStore
  writeFileAtomic,    // fsync + rename publish, never exposes a partial target
  cleanupStaleTemps,  // sweep temp files left by a crashed writer
} from './src/index.ts';
```

### Crash safety

`rewriteMessage` is pure, so a crash during the rewrite cannot publish
anything. Publishing is the caller's adapter; `writeFileAtomic` gives an
all-or-nothing publish:

1. write the full buffer to `.NAME.tmp-*` in the **same directory** as the target,
2. `fsync`,
3. `rename` over the target.

If the process dies before step 3, the target still holds its previous content
and at most a stale `.tmp-*` file remains, which `cleanupStaleTemps(target)`
removes. `test/crash.test.ts` proves this with a real child process that is
`SIGKILL`ed both before the rename and mid-write.

## Layout

```
src/
  index.ts        public API: rewriteMessage, decodeMessage, inspectMessage, options
  wire.ts         message scanner: tags, wire types, known/unknown handling
  varint.ts       64-bit varint + zig-zag + fixed-width primitives
  utf8.ts         strict UTF-8 validation and encoding
  schema.ts       schema normalization
  replacement.ts  replacement validation and canonical encoding
  types.ts        public types
  errors.ts       ProtobufRewriteError
  atomic.ts       crash-safe file publishing
  gateway.ts      rewrite-then-store orchestration
test/
  rewrite.test.ts   core rewrite semantics
  unknown.test.ts   unknown-field preservation per wire type
  edge.test.ts      buffer views, limits, extrema, malformed lengths
  property.test.ts  randomized identity/preservation properties
  crash.test.ts     atomic publish + real SIGKILL scenarios
  protoc.test.ts    cross-check against the official protoc (auto-skips)
examples/
  demo.ts           runnable walkthrough (`npm start`)
```

All temporary files created by the tests live under `test/.artifacts/`, which
is git-ignored.

## Notes

- The rewriter accepts a `Buffer` or any `Uint8Array`, including a view into a
  larger buffer. The input is never mutated.
- A known singular `bytes` field is surfaced as a `Buffer`; repeated numeric
  values are `bigint[]`.
- `npm test` exits non-zero if any assertion fails.
