# multicast-reliability

A NACK-based reliable-multicast module for Node.js, written from scratch in
TypeScript (runs directly on Node's built-in type stripping — no build step).

One sending source publishes a monotonic sequence of payloads to many
receivers over an unreliable datagram channel. Receivers detect gaps, merge
them into negative acknowledgements (NACKs) on the multicast feedback channel,
de-duplicate and reorder, and hand payloads to the application exactly once in
sequence order. Peers that observe each other's NACKs defer overlapping
requests. When a receiver falls behind the source's repair window it stops
pretending the stream is continuous and reports an explicit resync requirement
with the boundary the caller must resume from.

## Requirements

- Node.js >= 22.18 (this workspace runs on v26.8.1)
- No dependencies, no compiler, no external services

## Run

```sh
npm install      # no-op: there are no dependencies
npm test         # full suite with real assertions; non-zero exit on failure
npm start        # runnable demo: 4 receivers, loss, duplicates, real delivery
```

`npm test` uses `node --test` with the built-in TypeScript support. All
temporary state stays in memory inside the process; nothing is written outside
the workspace.

## Architecture

```
src/
  types.ts      wire packet shapes (data / repair / announce / nack) and the
                injectable Clock, DatagramNetwork and RandomSource interfaces
  clock.ts      systemClock (production) and ManualClock (deterministic tests)
  ranges.ts     range algebra: normalize, complement, interval sets, coalescing
  source.ts     MulticastSource: sequencing, repair window, announcements
  receiver.ts   MulticastReceiver: dedupe, bounded reorder cache, merged NACKs,
                peer suppression, backoff retry, resync reporting
  network.ts    InMemoryNetwork: datagram adapter with scripted drop/duplicate/
                delay/jitter per direction
  random.ts     seeded PRNG so simulations are reproducible
  index.ts      public entry point
test/
  basic.test.ts        delivery, dedupe, ordering, NACK merging
  protocol.test.ts     source/receiver protocol rules, unicast repair mode
  limits.test.ts       cache and feedback bounds, suppression boundaries
  determinism.test.ts  seeded reproducibility, repair budget, injected RNG
  scenario.test.ts     the required end-to-end fault scenario
  helpers/sim.ts       scripted multi-receiver simulation harness
examples/run.ts        runnable demo over the real components
```

## Usage

```ts
import {
  MulticastSource,
  MulticastReceiver,
  InMemoryNetwork,
  systemClock,
  seededRandom,
} from 'multicast-reliability';

const clock = systemClock;
const random = seededRandom(42);
const network = /* any DatagramNetwork adapter */ new InMemoryNetwork({ clock, random });

const source = new MulticastSource({
  sourceId: 'cam-1',
  network,
  clock,
  repairWindowSize: 256,     // retained packets available for repair
  announceIntervalMs: 250,   // periodic upper-bound / floor announcement
});

const receiver = new MulticastReceiver({
  sourceId: 'cam-1',
  receiverId: 'viewer-a',
  network,
  clock,
  onPayload: (seq, payload) => render(seq, payload),
  onResyncRequired: (request) => {
    // The reported gap is unrecoverable. Pick a new start point >= the floor.
    const startAt = Math.max(request.lowestAvailable, request.buffered[0]?.start ?? 0);
    receiver.resync(startAt);
  },
});

source.publish({ frame: 1 });
```

### Swapping in a real transport

Implement `DatagramNetwork`:

```ts
interface DatagramNetwork {
  broadcast(from: EndpointId, packet: Packet): void;
  unicast(from: EndpointId, to: EndpointId, packet: Packet): void;
  subscribe(endpointId: EndpointId, handler: (packet: Packet, from: EndpointId) => void): () => void;
}
```

Encode packets however you like (JSON, MessagePack, raw bytes). `broadcast` is
the multicast channel used for data, repairs, announcements and NACK feedback;
`unicast` is available for point-to-point repair delivery
(`repairMode: 'unicast'`).

## Protocol behaviour

**Sequencing and generations.** Every payload carries `sourceId`, a
`generation` (bumped on restart) and a 1-based monotonic `seq`. After a
restart, numbering begins at 1 again and all buffered state for the previous
generation is dropped. Packets from an older generation are counted and
discarded, never delivered. NACKs for an older generation are ignored by the
source.

**Repair window and announcements.** The source retains the most recent
`repairWindowSize` payloads and periodically broadcasts an announcement with
`upperBound` (highest sequence emitted) and `floor` (oldest retained
sequence). The announcement is what lets a receiver detect loss of the *tail*
of a burst, where no later packet arrives to reveal the gap.

**NACK merging.** Missing sequence numbers are coalesced into ranges; adjacent
or overlapping ranges are merged before being requested. A receiver requests
ranges only from `nextExpected` up to the highest sequence it has observed.

**Peer suppression.** NACKs travel on the multicast channel, so receivers see
each other's requests. Observing a peer NACK that overlaps a local gap defers
the local request for `peerSuppressMs`. Range merging is split at suppression
boundaries, so a deferred gap is never silently re-requested by a merged range;
once suppression expires the receiver issues its own request.

**Repair waiting and retry.** Each gap tracks its attempt count and a
per-attempt random backoff (`repairWaitMs + jitter`, exponential base
`backoffBaseMs`, capped at `backoffMaxMs`). If the repair does not arrive, the
receiver re-checks and retries. The initial NACK is delayed by
`initialNackDelayMs + jitter` so that mildly reordered packets are not
needlessly re-requested.

**Bounded resources.** The reorder cache holds at most `maxBufferedSeqs`
sequence numbers; when full it evicts the farthest-ahead entry in favour of
numbers closer to the gap. Feedback is bounded both per packet
(`maxNackRanges`) and per evaluation (`maxPendingFeedbackRanges`); overflow is
deferred to the next tick rather than dropped. A slow or stuck receiver
therefore consumes bounded memory and never blocks the source or other
receivers.

**Resync.** If `nextExpected < floor`, the missing range can never be repaired.
The receiver stops requesting and delivering, raises `onResyncRequired` with:

| field | meaning |
| --- | --- |
| `reason` | `'window-lost'` |
| `nextExpected` | sequence the receiver was waiting for |
| `missing` | unrecoverable ranges below the floor |
| `lowestAvailable` | oldest sequence the source can still repair |
| `upperBound` | highest sequence the source has announced |
| `buffered` | undelivered buffered ranges at or above the floor |

The caller then calls `receiver.resync(startAt)`. `startAt` must be at or above
`lowestAvailable` and at or above the first undelivered sequence (to avoid
re-delivering). The already-reported gap is never delivered as if it were
continuous: delivery resumes only at the chosen start point. `resync` rejects
start points outside those bounds.

## Verification

`npm test` covers, with real assertions:

- clean delivery, out-of-order buffering, duplicate suppression, NACK merging;
- stale-generation data and NACKs, restart numbering, foreign-source NACKs;
- tail loss discovered purely from the announcement;
- resync boundary reporting, floor enforcement, and resumption from the
  caller's chosen start point;
- bounded receive cache and bounded feedback (per-packet and per-tick);
- peer suppression, including that a suppressed gap is not merged back into a
  request and that it is requested again after the window expires;
- deterministic reproduction from seeds, and the injected RNG controlling
  backoff timing exactly;
- repair budget deferral and unavailable-repair announcements.

The headline scenario (`test/scenario.test.ts`) drives four receivers through
overlapping loss, a dropped first NACK per receiver, dropped multicast repairs,
duplicated repairs interleaving with live data, a gap that falls out of the
repair window (producing a resync request with the exact boundary), and a
source restart with stale traffic injected afterwards. It asserts, per
receiver: the resumed data sequence is contiguous and exactly-once, the resync
signal and its boundary are correct, feedback was both suppressed and
retransmitted, duplicates were absorbed, and no stale-generation packet
entered the stream.

## Design notes / limits

- Repairs are multicast by default, so one repair can satisfy several
  receivers; a receiver cannot tell whether a lost repair was lost for
  everyone. Suppression is therefore a timing optimisation, not a guarantee.
- The receiver does not itself choose a resync point; that is a policy
  decision for the caller, which is why `onResyncRequired` reports the
  boundary and `resync` applies the caller's choice.
- Sequence numbers are unbounded integers; no wraparound handling is included.
