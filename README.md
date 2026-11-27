# Quota coordinator with leased edge admission

A TypeScript implementation, running on Node.js, of a fixed-window quota
coordinator plus a node-side admission module. It combines three ideas:

- **two budget dimensions** — every fixed window limits both a global budget and
  a per-tenant budget, and a successful borrow reserves both atomically;
- **leases at the edge** — nodes borrow a bounded, expiring slice of quota and
  then admit requests locally, one by one, with no coordinator round trip;
- **unreliable messaging and clocks** — messages can be duplicated, reordered,
  delayed, or lost, nodes can restart into a new generation, and every clock may
  be off from the coordinator by a caller-declared bound.

Everything runs with Node's built-in test runner and native TypeScript support;
there is no build step and no third-party dependency.

## Quick start

```bash
npm test          # all assertions, including the transfer scenario
npm run demo      # the reproducible transfer scenario, human-readable
```

Requires Node **≥ 22.6** (type stripping). Verified on Node 26.8.

## Module entry points

`src/index.ts` re-exports the public surface. The important modules:

| File | Responsibility |
| --- | --- |
| `src/protocol.ts` | Wire messages, ids, and validation helpers |
| `src/clock.ts` | Clock abstraction, skew interval arithmetic |
| `src/coordinator.ts` | Budget accounting, leases, idempotent decisions, audit records |
| `src/node.ts` | Local admission, freezing returns, generations, durable intents |
| `src/client.ts` | `DirectClient` (in-process) and `SimulatedClient` (transport) |
| `src/network.ts` | Deterministic delivery simulator (drop/dup/delay/partition) |
| `src/sim.ts` | End-to-end harness, budget report, limit checker |
| `src/scenario.ts` | The reproducible quota-transfer scenario |
| `src/audit.ts` | Post-hoc reconciliation of admissions vs. coordinator records |

## Using it

### Coordinator

```ts
import { Coordinator, ManualClock } from './src/index.ts';

const clock = new ManualClock(0);
const coordinator = new Coordinator({
  clock,
  windowMs: 1000,          // fixed windows
  skewMs: 10,              // caller-declared clock skew bound
  globalLimitPerWindow: 100,
  tenantLimitsPerWindow: { A: 60, B: 60 },
  leaseTtlMs: 400,         // optional; defaults to windowMs / 2
});
```

`coordinator.handle(message)` accepts `borrow.request`, `return.intent`, and
`consume.report`, and returns the reply. Decisions are recorded permanently:
`coordinator.records()` returns the auditable log of borrows, rejections,
consumption, and returns; `recordsOfKind('borrow_granted')` etc. filter it.

### Node

```ts
import { QuotaNode, DirectClient } from './src/index.ts';

const node = new QuotaNode({
  nodeId: 'alpha',
  clock,                   // may be offset from the coordinator's clock
  skewMs: 10,
  borrowAmount: 40,
  tenantId: 'A',
});
const client = new DirectClient(coordinator);

await node.borrow(client, 'req-1', 40);   // I/O
node.tryAdmit(10);                        // synchronous, no I/O
const intent = node.prepareReturn('ret-1'); // synchronous stop boundary
await node.submitReturn(client, intent);  // retryable, idempotent
node.reboot();                            // new generation
```

`tryAdmit` never touches the network, so local admission continues through
coordinator outages. `prepareReturn` freezes the unconsumed remainder in the
same synchronous step, and the frozen units become inadmissible immediately —
so a unit can be either consumed or returned, never both.

### Simulated network

```ts
import { Simulation, uniformPolicy } from './src/index.ts';

const sim = new Simulation({
  windowMs: 1000, skewMs: 10,
  globalLimitPerWindow: 100,
  tenantLimitsPerWindow: { A: 60 },
  policy: uniformPolicy({ minLatencyMs: 1, maxLatencyMs: 25, dropRate: 0.1, duplicateRate: 0.2, seed: 7 }),
});
const alpha = sim.addNode({ nodeId: 'alpha', tenantId: 'A', borrowAmount: 40, clockOffsetMs: -5 });
const tracked = sim.track(alpha.node.borrow(alpha.client, 'r1', 40));
await sim.settle(tracked);       // advances simulated time until the reply lands
```

`sim.budgetReport()` aggregates *real admission ledgers* per window and tenant;
`checkBudget(report, limits)` returns a list of violations (empty means all good).

Transport-level recovery is built in: `network.heal(nodeId)` invokes the
endpoint's `onReconnect()`, which re-sends every request still awaiting a reply
using its original id. Satisfiable borrows therefore resume without the caller
retrying by hand.

## Design notes

### Conservative skew handling

A node reading `r` is only consistent with true time in `[r - skew, r + skew]`.
An admission therefore requires the *whole* interval to fit inside both the
window and the lease:

```
r - skew >= windowStart
r + skew <= expiresAt        (coordinator always grants expiresAt <= windowEnd - skew)
```

This bounds the real admission strictly inside the fixed window even for the
worst permitted clock offset. The coordinator additionally refuses any grant
that would leave less than `> 2*skew` of usable life before the window ends, and
its constructor rejects `windowMs <= 4*skew + 2`, so a safely-usable reading
always exists.

### Budget accounting model

Three per-window figures, per dimension (global and each tenant):

- **committed** (`globalReserved`) — every granted amount not yet credited back.
  This is what `limit - committed` gates new grants. Confirmed consumption stays
  in it: used quota is spent, not returned.
- **consumed** (`globalConsumed`) — the part of committed quota already
  confirmed by consumption reports.
- **outstanding** — `committed - consumed`: granted but neither consumed nor
  returned. This is the slice a live lease can still spend or hand back.

Only an accepted return lowers `committed`. A dead node's unconfirmed remainder
therefore keeps occupying its window, and an old-window lease simply vanishes
with its window rather than carrying over.

### Window and lease semantics

- Budgets are per fixed window; nothing carries forward. Quota from an earlier
  window that arrives late is **refused** (`stale_window`) and never credits the
  current window.
- An unconfirmed lease remainder keeps occupying its window until the window
  ends. Once the window ends it simply ceases to exist.
- A node may return only the part of a lease it did not consume. The return
  intent states the stop boundary (`frozenFromSeq`) and the amount consumed up to
  that boundary; the coordinator accepts only when
  `consumedAtBoundary + amount + previouslyCreditedReturns === lease.amount`.
  This makes each unit exactly once: consumed or returned.

### Idempotence and generations

- Every borrow/return carries a caller id. Replaying an id returns the original
  decision with `duplicate: true` and has no accounting effect. Borrow idempotence
  is scoped to `(node, generation, requestId)`, so a restarted node can reuse an
  id without colliding with its dead generation's decision.
- Consumption reports are keyed by `(nodeId, generation, seq)`, so duplicated
  reports are de-duplicated while a new generation's ledger cannot collide with
  an old one.
- A node restart increments the generation and abandons the in-memory lease. A
  borrow from a retired generation is refused (`stale_generation`) and cannot
  reserve fresh budget.
- A durable return intent (id + lease id + generation + boundary) survives a
  restart; replaying it after recovery is a trustworthy final account and is
  accepted, while a *successor generation* claiming the old lease's remainder
  under its own generation is refused (`generation_mismatch`).

### Auditable records

The coordinator logs every decision with its inputs and resulting counters
(`globalReservedAfter`, `tenantReservedAfter`, `leaseOutstandingAfter`, …). The
`Simulation`/`scenario` helpers reconstruct per-window, per-tenant consumption
from the nodes' local ledgers and compare it with the coordinator's accounting;
`auditConsumption` only reports the coordinator as over-counting, never under.

## The reproducible demo

`npm run demo` runs one fixed schedule with deterministic delivery and prints:

1. the timed schedule (partition, freeze, reboot, retry, duplicate return,
   second outage, window switch),
2. the coordinator's decision log,
3. every real local admission,
4. the per-window/per-tenant budget check computed from those admissions,
5. the key facts the tests assert.

It exercises: a node losing its link mid-window, freezing and preparing a return
while partitioned, rebooting into a new generation, its queued borrow and
durable return resuming automatically when the link heals, a duplicated grant
that must not reset local quota, a duplicated return that must credit once, the
same units re-offered under a new id (refused), a dead node's unconfirmed
remainder that keeps occupying only its own window, and a window switch where an
old-window return and a retired-generation borrow are both refused.

## Tests

`npm test` runs everything with the Node built-in runner and exits non-zero on
failure. The suites are:

- `test/clock.test.ts` — skew interval arithmetic, adversarial ±skew clock
  offsets swept across a whole lease, coordinator grant margins.
- `test/coordinator.test.ts` — budget dimensions, local admission during
  outages, boundary/expiry semantics, return accounting, fencing, generations,
  idempotence, records.
- `test/network.test.ts` — dropped/duplicated/out-of-order delivery, partition
  and recovery (including automatic retry on heal), the full scenario, budget
  invariants from real admissions.
- `test/audit.test.ts` — reconciliation of real admissions with coordinator
  accounting, including a deliberately inconsistent case.
- `test/fuzz.test.ts` and `test/extended-fuzz.test.ts` — seeded random schedules
  (borrow/admit/return/reboot/partition) under lossy duplicated delivery,
  checking every window stays inside budget, every lease is fully accounted, and
  committed quota never exceeds its window/tenant limit.

All temporary data stays inside this workspace; no external service is used.
