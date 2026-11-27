# metadata-dictionary-codec

A paired metadata encoder / decoder for Node.js, written in TypeScript and run
directly by Node's built-in type stripping (no build step, no dependencies).

The encoder turns an ordered list of `{ key, value }` pairs into a **request
block** frame plus, when worthwhile, **dictionary instruction** frames. The two
frame kinds travel on two independent, individually ordered channels, so a
request block can overtake the dictionary insert it depends on. The decoder
withholds such a block until the needed entries arrive, then resumes it.

## Quick start

```bash
npm test     # full assertion suite (node --test)
npm run demo # prints a narrated two-channel exchange
```

Requires Node.js >= 22.6 (verified on Node 26.8.1). No install step is needed
beyond `npm test`; there are no external dependencies.

## API

Everything is exported from `src/index.ts`:

```ts
import {
  MetadataEncoder,
  MetadataDecoder,
  TwoChannelLink,
  createLinkedCodec,
  parseFrame,
} from "./src/index.ts";

const { encoder, decoder, link } = createLinkedCodec({
  maxDictionaryBytes: 256, // total UTF-8 key+value bytes held by the dictionary
  maxSlots: 8,             // optional fixed slot count
  maxBlockedBlocks: 4,     // blocks the decoder will withhold
});

// Encode an ordered list; duplicates and order are preserved exactly.
const encoded = encoder.encode([
  { key: "x-request-id", value: "9f1c…" },
  { key: "x-user-agent", value: "Mozilla/5.0 …" },
]);

encoded.blockFrame;        // Uint8Array on the block channel
encoded.dictionaryFrames;  // Uint8Array[] on the dictionary channel
encoded.blockByteLength;
encoded.dictionaryByteLength;
encoded.totalByteLength;
encoded.literalEquivalentBlockByteLength; // size with literals only

link.send(encoded);
link.deliverBlocks();      // block overtakes its dictionary frames
link.deliverDictionary();  // dictionary catches up; block resumes
link.settle();             // drain both channels and return feedback
```

`createLinkedCodec` wires `decoder.advertisedMaxBlockedBlocks` into
`encoder.peerMaxBlockedBlocks`, so both sides agree on the quota.

### Encoder

| Member | Purpose |
| --- | --- |
| `encode(entries)` | Encodes one request block. Emits dictionary inserts first, then the block. |
| `receiveAck(frame)` | Applies `entry-ack` / `block-ack` feedback. Returns `{ applied, type, reason? }`. |
| `getMetrics()` | Counters plus `dictionaryBytes`, `dictionaryCapacity`, `dictionaryEntryCount`, `blockedBlockCount`, `peerMaxBlockedBlocks`. |
| `referenceProtection()` | Per-entry protection basis: `protectingBlockIds`, `referenceCount`, `acknowledged`, `byteCost`. |
| `evictionCandidates()` | Slot generations with no outstanding block referencing them. |
| `dictionarySnapshot()` | All live entries with slot, generation, key, value, byte cost. |
| `blockedBlockCount` | Outstanding blocks waiting on unacknowledged entries. |
| `dictionaryByteSize` | Current UTF-8 key+value occupancy. |
| `getBlockState(blockId)` | Outstanding/decided state and referenced slot generations. |

### Decoder

| Member | Purpose |
| --- | --- |
| `receiveDictionaryFrame(frame)` | Applies an `insert`/`evict`. Returns any blocks that became decodable. |
| `receiveBlockFrame(frame)` | Applies a request block. Returns the decoded block, or `undefined` if withheld. |
| `receive(frame, channel?)` | Channel-explicit routing, or type inference if no channel is given. |
| `cancelBlock(blockId)` | Abandons a withheld block and emits its `abandoned` acknowledgement. |
| `cancelAllBlocked()` | Abandons every withheld block, returning the ack frames. |
| `drainAcks()` | Pull feedback frames for the encoder, in production order. |
| `blockedBlocks()` | Withheld blocks with the exact missing slot generations. |
| `protectedSlots()` | Entries held only because a withheld block references that generation. |
| `deferredEvictions()` | Evictions postponed to keep a withheld block decodable. |
| `dictionaryBytes`, `dictionaryEntryCount` | Dictionary occupancy. |
| `advertisedMaxBlockedBlocks` | The allowance to pass to `peerMaxBlockedBlocks`. |

### Wire format (`src/wire.ts`)

Every frame is one whole `Uint8Array`:

```
magic(0x4d) version(0x01) type payload…
```

Integers are unsigned LEB128 varints, strings are length-prefixed UTF-8 byte
strings. Frame types: `0x01` insert, `0x02` evict, `0x10` request block,
`0x20` block ack, `0x21` entry ack. Malformed frames throw `ProtocolError`
(`BAD_MAGIC`, `BAD_VERSION`, `TRUNCATED_FRAME`, `TRAILING_BYTES`,
`INVALID_UTF8`, `MALFORMED_VARINT`, `UNKNOWN_FRAME_TYPE`, …) and never leave
partial state. See `parseFrame` for the parsed shape.

## Behaviour and invariants

**Order and duplicates.** A request block is a linear field list. Literal
fields carry the key and value; reference fields carry `(slot, generation)`.
Order and duplicate occurrences are preserved byte for byte through the round
trip. Nothing is de-duplicated at the wire level.

**Dictionary admission.** A brand-new key/value pair becomes a dictionary entry
(making future occurrences references) only when it is already repeating and
the insert is paid back by the savings on the references it enables:
`uses × (literalCost − referenceCost) > insertCost`. A one-off pair therefore
stays literal and never inflates the stream. A reference is only ever used when
it is strictly smaller than the corresponding literal field.

**Slots and generations.** Each slot has a monotonically increasing
generation. Every reuse of a slot bumps the generation, and every reference
names both slot and generation. `(slot, generation)` is the identity of an
entry everywhere: dictionary lookup, acknowledgements and eviction protection.

**Blocked blocks.** A reference to an entry the peer has not yet acknowledged
may only be emitted while fewer than `peerMaxBlockedBlocks` outstanding blocks
are waiting on unacknowledged entries. When the quota is exhausted, or when no
dictionary space can be freed, the field falls back to a literal rather than
putting the peer over its advertised limit. The decoder enforces the same limit
(`maxBlockedBlocks`): a block that would exceed it is abandoned immediately
with an `abandoned` ack.

**Blocking and resumption.** A request block whose references are not all
resolvable is withheld, not failed. Applying a dictionary instruction retries
every withheld block until no further progress is possible. Dictionary
instructions are always processed while request blocks are blocked, so a stuck
block never prevents other traffic from making progress.

**Eviction protection.** The encoder never evicts an entry referenced by any
block that has not been acknowledged as decoded or abandoned. The decoder
additionally defers an `evict` that would remove an entry a withheld block
still needs, and applies it once that block is decided. Both sides expose the
protection basis (`referenceProtection()` / `protectedSlots()`).

**Acknowledgements.** Decoding a block produces a `decoded` block ack listing
its referenced slot generations. Cancelling a withheld block produces an
`abandoned` block ack with the same reference list. Applying a block ack
releases that block's references exactly once: a repeated ack is counted in
`duplicateAcksIgnored` and changes nothing. An ack naming an old generation
cannot touch a slot that has since been reused, because release matches on
`(slot, generation)`; such stale feedback increments `staleAcksIgnored`.

**Repeated metadata is shorter.** Block 1 pays literals; once a pair repeats,
the insert is emitted and later blocks carry references. In the demo, three
typical header pairs cost 161 B literal-only per block and 14 B per warm block,
with a total of 70 B over five warm blocks versus 805 B literal-only.

## Project layout

```
src/wire.ts      frame encoding/parsing, varints, UTF-8 helpers, ProtocolError
src/encoder.ts   MetadataEncoder: admission, allocation, eviction, acks, telemetry
src/decoder.ts   MetadataDecoder: dictionary, withholding, resumption, acks
src/link.ts      TwoChannelLink: caller-side two-channel transport adapter
src/index.ts     public entry point and pairing helpers
src/demo.ts      narrated end-to-end exchange (npm run demo)
test/            assertion suite run by `npm test`
```

## Tests

`npm test` runs `node --test test/` and exits non-zero on any failure. The suite
covers the wire format and malformed input; order/duplicate preservation;
admission and byte savings; slot reuse and generations; blocked-block quota;
cross-channel overtaking; randomized interleavings (25 seeded schedules);
decoder restart / replay; lost and truncated frames; duplicate and stale
acknowledgements; deferred evictions; and the two-channel link adapter. All
data is synthetic and local; no external services are contacted.
