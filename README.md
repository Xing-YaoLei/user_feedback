# Sharded RPC routing client

A small, dependency-free TypeScript module that resolves RPC calls against a
generation-versioned shard routing table, following both permanent and
temporary redirect hints from owners.

Runs on Node.js 22.6+ using Node's built-in TypeScript support (type erasure) —
no build step, no compiler, no runtime dependencies.

```bash
npm test        # full assertion suite (node --test)
npm run demo    # end-to-end local demo, prints the routing table
```

## Concepts

- **Key space** — shard keys are unsigned 32-bit integers. The half-open
  interval `[0, 2^32)` is `KEY_SPACE`.
- **Permanent hint** — `{ kind: 'permanent', start, end, address, generation }`.
  Describes ownership of `[start, end)` by `address` at `generation`. It may be
  merged into the shared routing table.
- **Temporary hint** — `{ kind: 'temporary', address }`. A one-off detour that
  applies only to the call that received it.
- **Generation** — a non-negative safe integer. Newer generations supersede
  older ones, point by point.

## Usage

```ts
import { Router, RoutingClient, type TransportAdapter } from './src/index.ts';

const router = new Router({ initialAddress: 'seed:7000', initialGeneration: 0 });

const transport: TransportAdapter = {
  // Must only resolve to `redirect` when the request was NOT executed.
  async send(request, signal) {
    /* ... */
  },
};

const client = new RoutingClient({ router, transport, maxAttempts: 8, deadlineMs: 2000 });

const result = await client.call(42, { op: 'ping' });
if (result.ok) {
  console.log(result.value, 'from', result.address);
} else {
  console.log(result.reason, result.attemptedAddresses);
}
```

## Routing-table semantics

`Router.applyPermanentHint(hint)` is synchronous, which makes each update atomic
with respect to concurrently resolving calls.

- **Point-wise adoption.** Each key inside `[start, end)` adopts the hint only
  if the hint's generation is strictly higher than the route currently covering
  that key. The adoption is per point, not per hint.
- **Overlaps split the original range.** Everything outside the hint keeps its
  existing owner and generation and stays valid.
- **Same generation, different owner.** If any overlapping point has the same
  generation but a different owner, the *whole* hint is rejected as a conflict
  and the table is left completely unchanged (`status: 'conflict'`, plus a
  `conflict` record naming the overlapping interval).
- **Lower generation.** Ignored. `status: 'stale'`, no mutation.
- **Malformed hints.** Rejected as `invalid` before any mutation: empty or
  inverted ranges, endpoints outside `[0, 2^32]`, non-integer keys, empty
  addresses, negative or fractional generations.
- **Coalescing.** Adjacent ranges with the same address and generation merge, so
  the table always stays minimal and gap-free. `assertInvariant()` verifies the
  partition.

`Router.lookup(key)` / `ownerOf(key)` throw `RangeError` for anything that is
not an unsigned 32-bit integer. `snapshot()` returns a defensive copy.

## Call semantics

- The initial owner comes from the shared table. If it answers `ok`, the value
  is returned immediately and is not affected by any later routing change.
- A `redirect` is only honoured under the transport contract that the request
  was *not* executed, so following it is safe.
- **Permanent redirects** are applied to the shared table under the semantics
  above, then the key is re-resolved. Every other in-flight or future call sees
  the update. A stale hint does not regress a newer local route; a hint that
  does not cover the key leaves that key's route alone.
- **Temporary redirects** are used for exactly one hop of the receiving call.
  They are never written to the shared table, and a concurrent call on the same
  key is unaffected.
- **Judged locally.** Hints are evaluated by their own range and generation. A
  disjoint range that already learned a much higher generation does not cause a
  narrower hint to be ignored.
- **Shared budget.** Deadline and attempt limits span the whole redirect chain,
  not each hop. Per-call overrides are accepted via `client.call(key, payload,
  { maxAttempts, deadlineMs })`.
- **De-duplication.** Within one call, the same `address + owner generation`
  pair is never attempted twice. A redirect that repeats a pair terminates as a
  cycle.
- **Failure reporting.** Failures return `ok: false` with `reason`, a message,
  every attempt made (`attempts`, `attemptedAddresses`), and all hints observed.

### Failure reasons

| reason | meaning |
| --- | --- |
| `cycle` | a forwarding loop revisited an already-attempted address/generation |
| `attempt-budget` | the shared attempt budget ran out |
| `deadline` | the shared wall-clock deadline ran out |
| `transport-error` | the adapter threw or rejected |
| `malformed-response` | response was not `ok`/`redirect` or had no valid hint |
| `invalid-hint` | a hint failed validation |
| `route-conflict` | a permanent hint conflicted at equal generation |

## Design notes

- `RoutingClient.call` is fully asynchronous; `Router` is synchronous and
  immutable from the outside, so two concurrent calls on adjacent shards
  interleave only at `await` points and each updates exactly its own range.
- Each attempt is handed an `AbortSignal` that is aborted when the chain
  deadline expires, so a hanging transport cannot outlive the budget.
- The client never mutates a response or a hint object, and copies data into
  its own records, so caller-owned objects are safe to reuse.

## Layout

```
src/router.ts   routing table, hint validation, partition invariants
src/client.ts   async call resolution, budgets, de-duplication
src/index.ts    public module entry point
src/demo.ts     runnable local demo
test/           node:test suites and a scripted local transport
```
