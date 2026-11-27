# discovery-view-synthesis

Synthesise one service-discovery view from several discovery sources with fixed
precedence, handling generations, sequence numbers, declared validity windows,
authoritative deletion markers (tombstones) and source conflicts.

Written in TypeScript, runs directly on Node's built-in TypeScript support. No
dependencies, no build step, no clock, no I/O.

```bash
node --version   # >= 22.6 (tested on 26.8.1)
npm test         # full suite, 51 tests, real assertions
npm start        # runnable end-to-end demo on synthetic data
```

## Why this exists

A service instance is usually visible through more than one discovery source: a
primary registry and one or more fallbacks or mirrors. Naively merging them
resurrects instances that were deliberately deregistered: the primary says
"gone", the fallback still has a stale record, and the merged view keeps serving
it.

This module encodes the rules that avoid that, plus the mechanics you need to
make it trustworthy in production: full snapshots, sequenced deltas, declared
validity windows, and explicit reporting of *which source* an answer came from
and *what it overrode*.

## Model

A fact is keyed by `(serviceId, instanceId)` and is one of:

| record | meaning |
| --- | --- |
| `{ kind: "value", value }` | the instance is up; `value` is an opaque, caller-owned payload |
| `{ kind: "tombstone" }` | an authoritative deletion marker |

A source publishes either:

- a **snapshot** — the complete, exhaustive contents of its view for that
  generation, or
- a **delta** — exactly one `(service, instance)` fact changed, either to a new
  record or to *absent* (`record: undefined` drops the source's own fact).

Every update carries:

| field | purpose |
| --- | --- |
| `generation` | monotonically increasing epoch; higher supersedes lower |
| `sequence` | per-generation counter; a delta must be exactly the previous `+ 1` |
| `ttlMs` | validity of the whole source view, measured from local receipt |
| `receivedAt` | **caller-supplied** local receipt timestamp (the module never reads a clock) |

## The rules, and how they are enforced

1. **Fixed source priority.** Lower `priority` number wins. Priorities must be
   unique, so precedence is a total order and can never be ambiguous.

2. **Deletion beats stale presence.** A valid tombstone from a higher-priority
   source wins over any value from a lower-priority source. When the primary
   deletes an instance, a fallback's stale record cannot resurrect it. The
   tombstone is returned as `state: "deleted"` with the fallback recorded in
   `shadowed` as `overridden-by-tombstone`.

3. **Absence is not deletion.** An instance missing from a snapshot means *this
   source no longer holds a fact for it*, not that it is gone. Resolution falls
   back to the next source. Only an explicit tombstone suppresses lower sources.

4. **Snapshot is the baseline; deltas only continue it.** A delta is accepted
   only when it continues the current generation at exactly `sequence + 1`, on
   top of a view a snapshot established. A skipped sequence (a **gap**) stops
   the source's *entire* view being used — every instance from it, not just the
   one in the missing delta — until a fresh full snapshot arrives.

5. **Outdated input is inert.** A lower generation, or a lower sequence within
   the active generation, never changes state and is reported as `ignored`.

6. **Conflicts are reported, not destructive.** A same-generation,
   same-sequence update whose *content* differs from what was already applied is
   a `source-conflict`: it is reported on the source, and the current view is
   kept exactly as it was.

7. **Validity is declared, not assumed.** Each accepted update declares the
   whole view's validity from its own receipt instant, so a source's values and
   tombstones live and lapse together. At `receivedAt + ttlMs` the source
   contributes nothing. A **repeated** (content-identical) update is a replay:
   inert, and it does **not** extend the window.

8. **Different failures, different reasons.** `sourceIssue()` distinguishes a
   synchronisation failure (`gap`, `source-conflict`) from ordinary expiry
   (`expired`), and from malformed input (`invalid`).

9. **Batches are atomic.** `apply(receipts)` computes on a private working copy
   and publishes in one assignment. A query sees all of a batch or none of it,
   and a thrown error leaves prior state untouched.

10. **Independent sources commute.** Per-source state is only touched by that
    source's own updates, and resolution is a pure function of all per-source
    states. Reordering updates from *different* sources yields an identical
    view. (Within one source, order must be monotonic — that is what sequence
    numbers are for.)

11. **Every answer carries provenance.** Each resolution reports the `source`
    actually used (`sourceId`, `generation`, `sequence`) and `shadowed`: the
    facts that lost, and *why* — `lower-priority`, `overridden-by-tombstone`, or
    `source-unusable` (the source holds the fact but its view is gapped or
    lapsed).

## API

```ts
import { DiscoverySynthesizer } from "./src/index.ts";

const synth = new DiscoverySynthesizer({
  sources: [
    { sourceId: "primary", priority: 0 },
    { sourceId: "fallback", priority: 10 },
  ],
});

// Feed a batch. `receivedAt` is supplied by the caller.
const result = synth.apply([
  {
    receivedAt: 1_000,
    update: {
      kind: "snapshot",
      sourceId: "primary",
      generation: 1,
      sequence: 0,
      ttlMs: 30_000,
      records: new Map([
        ["checkout", new Map([["i-1", { kind: "value", value: { host: "10.0.0.1" } }]])],
      ]),
    },
  },
]);

// Query the synthesised view at a caller-supplied instant.
const view = synth.query(2_000);
// view.instances[0].state === "available"
// view.instances[0].source === { sourceId: "primary", generation: 1, sequence: 0 }
```

| member | purpose |
| --- | --- |
| `new DiscoverySynthesizer({ sources })` | configure fixed source priorities |
| `apply(receipts)` | apply a batch atomically; returns per-update dispositions |
| `query(now, options?)` | full view: resolutions + per-source status |
| `resolve(serviceId, instanceId, now)` | one resolution, even if absent |
| `status(sourceId, now)` | one source's diagnostics |
| `issueOf(sourceId, now)` | why a source is not contributing (`gap` / `expired` / …) |
| `sourceIds()` | configured sources, highest priority first |

`apply` returns `{ outcome, results, applied, ignored, rejected }`, where each
`results[i]` is one of `applied`, `ignored` (`outdated-generation`,
`outdated-sequence`, `duplicate`) or `rejected` (`gap`, `conflict`, `expired`,
`invalid`, `unknown-source`).

Resolutions are `available` (with `value`), `deleted` (an authoritative
tombstone is in force), or `absent` (no source contributes a fact).

## Interleaving, crashes and the caller's clock

The module holds no ambient state, so it can be driven by any transport:

- **Interleaving** updates from different sources is safe by construction, and
  `test/commutativity.test.ts` asserts that three different interleavings of
  the same updates produce byte-identical views.
- **Crash safety** comes from batch atomicity: an interrupted batch publishes
  nothing, so replaying a committed receipt log reproduces the same view.
  `test/crash.test.ts` resumes from a crash at every possible point of a stream
  and checks the resumed view equals an uninterrupted run, including a
  file-backed JSON round-trip of the receipt log.
- **The clock is yours.** Every `apply` carries `receivedAt`; every query
  carries `now`. Tests advance time by passing larger `now` values, so
  expiry is exercised deterministically and instantly.

## Layout

```
src/
  index.ts         public entry point and re-exports
  synthesizer.ts   the engine
  types.ts         public data types
  errors.ts        structured errors for programmer/configuration mistakes
  cli.ts           runnable demo (npm start)
test/
  priority.test.ts      precedence, tombstones, fallback disclosure
  gaps.test.ts          sequence gaps, disable/recover, lapse of tombstones
  ordering.test.ts      generations, outdated input, conflicts, replays, expiry
  ttl.test.ts           validity windows, renewal rules, shared lapse
  batch.test.ts         atomicity, partial batches, crash behaviour, config errors
  commutativity.test.ts interleaving independence
  interleaving.property.test.ts  randomized cross-source interleavings; query purity
  crash.test.ts         crash at every point, JSON round-trip, retry
  services.test.ts      service scoping, filtering, source ordering
  edge-cases.test.ts    shadow ordering, unknown sources, odd priorities, key order
```

Errors (`DiscoveryViewError`) are reserved for programmer/configuration
mistakes. Recoverable source problems are always reported on the view, so one
misbehaving source can never take the whole view down.
