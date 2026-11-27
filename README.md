# Deadline Scheduler

An exact-nanosecond deadline scheduler for Node.js, written in TypeScript. It is
built for the RPC pattern where **the same call is re-armed repeatedly** as it
moves through handling stages: a reschedule never leaves a permanently retained
old timer, RPC ids are reusable, and each registration is a distinct
*generation* whose stale handles can never fire, cancel, or reschedule anything.

- Time is exact integer nanoseconds (`bigint`), so deadlines past
  `Number.MAX_SAFE_INTEGER` stay exact.
- Forward jumps over arbitrary idle intervals cost `O(log n)`, never
  nanosecond-by-nanosecond stepping.
- Selecting due work is `O(log n)` per callback; the scheduler never scans
  registrations that are not due.
- Index size is bounded by the number of **active** registrations, even after a
  single RPC is rescheduled a million times.
- Every registration ends exactly once: cancelled, fired, or timed out.

## Quick start

```bash
npm test     # runs the full executable test suite (node --test)
npm start    # runs the demo in src/demo.ts
```

Requires Node.js ≥ 22.6 (it runs `.ts` sources directly through Node's built-in
type-stripping; no compiler or build step is needed).

## API

```ts
import { DeadlineScheduler } from './src/index.ts';

const scheduler = new DeadlineScheduler({ now: 0n }); // optional starting clock

const handle = scheduler.register('rpc/42', 1_000_000n, (h) => {
  // runs synchronously when the clock reaches the deadline
});

scheduler.reschedule(handle, 2_000_000n); // same generation, new deadline
scheduler.cancel(handle);                 // one terminal outcome

const result = scheduler.advance({ target: 5_000_000n, maxCallbacks: 100 });
```

### `register(rpcId, deadline, callback) → DeadlineHandle`

Registers a fresh generation for `rpcId`. Re-using an id immediately stales the
previous generation: its handle becomes inert and its callback can never run.
`deadline` is `bigint` nanoseconds (or a safe-integer `number`). A deadline at or
before the current clock is due on the next `advance`.

### `reschedule(handle, deadline) → boolean`

Re-arms one registration, keeping the same handle, generation, and registration
sequence (so tie-breaking is stable). Returns `false` for a stale handle. The old
index slot becomes stale and is reclaimed — repeatedly rescheduling one RPC does
*not* accumulate stale nodes.

### `cancel(handle) → boolean`

Cancels a live registration. Idempotent by construction: once a registration has
fired or been cancelled, its handle is stale, so `cancel` returns `false` and no
second terminal record is produced. `cancelAll()` cancels everything active.

### `advance({ target?, maxCallbacks? }) → AdvanceResult`

Moves the monotonic clock forward to `target` (default: current clock, or the
resume target of a previously budget-stopped advance) and runs due callbacks
**synchronously**, in `(deadline, registrationSequence)` order:

- A throwing callback is attributed to its own item, recorded as a timeout, and
  processing continues with the other due items.
- Callbacks may cancel or reschedule other registrations, or register new
  already-due ones; those changes participate in the very next selection.
- When `maxCallbacks` is reached with work still due, the clock stops exactly at
  the last executed deadline, `hasMore` is `true`, and the next `advance()`
  resumes from that position (no arguments needed).
- After the due work is exhausted, the clock jumps to `target` in one step.

`AdvanceResult` contains `now`, `callbacks`, the `expired` records in execution
order, `hasMore`, `purged` (stale index nodes physically dropped), plus
`activeCount`, `indexSize`, and per-advance `access` counts (`heap` and `map`).

### Observation

| Method | Meaning |
| --- | --- |
| `now()` | Current clock in nanoseconds |
| `activeCount()` | Live registrations |
| `indexSize()` | Nodes physically held by the heap |
| `staleIndexCount()` | Dead nodes still in the heap (transient) |
| `heapAccessCount()` / `mapAccessCount()` | Cumulative index accesses |
| `expiries()` / `cancellations()` / `timeouts()` | Terminal records |
| `deadlineOf(handle)` / `isActive(handle)` | Per-handle queries |

## How the bounds are met

**One live node per registration.** Registrations live in a `Map<rpcId, Node>`,
so handle validation is `O(1)`. A binary min-heap keyed by `(deadline, seq)`
supplies the next due item.

**Reschedules are re-arms, not growth.** `reschedule` marks the old heap node
dead, updates the map to a replacement node, and pushes the replacement. Dead
nodes are ignored during selection. Whenever dead nodes outnumber live ones the
heap is rebuilt, so `indexSize ≤ 2·activeCount + 2` at all times. A million
reschedules of one RPC therefore leave one live node and only bounded transient
space, not a million nodes.

**Forward jumps are free.** `advance` compares only the heap minimum's deadline
against the target. Jumping from 0 to 10¹⁸ ns with one registration performs a
handful of heap accesses and never iterates over time.

**Skipping not-yet-due items is free.** The heap orders by deadline, so an
advance that fires 3 of 100 000 deadlines visits only the due ones and their
`O(log n)` paths. The test suite asserts an explicit access-count bound for this.

**Terminal uniqueness.** Firing removes a node from the live map *before* the
callback runs; `cancel` only acts on handles found there. Hence a registration
cannot be both cancelled and fired, nor fire twice.

## Test suite

`npm test` runs `node --test` over `test/`:

- `test/scheduler.test.ts` — ordered/unit guarantees: exact bigint time,
  deadline ordering and tie-breaks, generation invalidation, reschedule
  (earlier/later/million-times), cancellation and single-terminal outcome,
  callback failures, callbacks that mutate the schedule, the advance budget and
  resumption, forward jumps and access-count bounds over 100 000 deadlines, plus
  the required interleaving (cancel the next item and re-register the same RPC id
  inside a callback; the old generation must not act for the new one).
- `test/invariants.test.ts` — 25 seeded random interleavings of register /
  reschedule / cancel / advance with in-callback mutations, asserting the
  index-size bound, monotonic clock, unique terminal per generation, and that no
  generation both fires and cancels.

All data is synthetic and local; no external services are contacted.
