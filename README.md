# Deadline propagation for Node.js

Exact-integer deadline propagation across a request graph, with two wire
protocols, per-call cancellation scopes, and a transport adapter that computes
the outgoing timeout only at the moment a call really leaves its queue.

No dependencies. TypeScript executed directly by Node's type stripping
(Node.js 22.18+ / 26.x), using only built-in modules.

## Quick start

```bash
npm test     # full suite: protocols, scopes, adapter, timers, interleaved scenarios
npm run demo # deterministic end-to-end walkthrough (manual clock, no sleeps)
```

Tests use Node's built-in runner with real assertions. Any failure exits
non-zero. All data is synthetic and local; no external services are contacted.

## The problem this solves

A parent request may sit in an adapter queue for a while before it actually
sends a downstream call. If you compute the outgoing timeout from the budget
you *received*, the wait is silently given away: the child gets a full fresh
budget that can exceed the parent's real remaining time. This module fixes the
contract at four points:

1. **Relative in, absolute out, immediately.** On receipt, a relative budget is
   converted to an absolute deadline on the process monotonic clock
   (`process.hrtime.bigint()`). From then on only absolute deadlines move
   around.
2. **Child deadline is the earlier requirement.**
   `child.deadline = min(parent.deadline, now + child.budget)`. A child can ask
   for a tighter deadline, never a looser one.
3. **Budget is computed at dequeue.** The transport adapter calls `dispatch()`
   when the call truly leaves the queue. Remaining time is sampled from the
   absolute deadline at that instant, and only then is the wire value encoded.
4. **Round inward only.** Both encoders pick the largest representable value
   that does **not** exceed the true remaining nanoseconds. A positive budget
   too small for the protocol is an explicit failure, never `0` (which means
   "no deadline" / infinite wait on the wire).

## Layout

```
src/
  index.ts     public entry points and re-exports
  scope.ts     Scope tree: deadlines, cancellation, cleanup, end state
  adapter.ts   DeadlineDispatcher: queue, dequeue-time encoding, timers
  protocol.ts  Protocol A / B encoders and decoders
  time.ts      exact bigint nanosecond helpers and accepted budget shapes
  clock.ts     monotonic clock interface, ManualClock for tests
  context.ts   AsyncLocalStorage scope context
  errors.ts    end-state types and typed errors
test/
  protocol.test.ts     encoders, decoders, rounding, boundaries
  scope.test.ts        propagation, isolation, cancellation, cleanup
  adapter.test.ts      dequeue-time budget, late notifications, siblings
  lifecycle.test.ts    queue-wait semantics, no-deadline, withCall
  timers.test.ts       wall-clock timer arming, early fire, cleanup
  integration.test.ts  the interleaved scenario below
```

## Core API

```ts
import {
  ManualClock, DeadlineDispatcher, receiveCall, withCall,
  parseProtocolABudget, parseProtocolBBudget,
} from './src/index.ts';

const clock = new ManualClock(0n);          // tests; real code omits the clock
const dispatcher = new DeadlineDispatcher({ clock });

// Inbound: relative budget -> absolute monotonic deadline, immediately.
const root = receiveCall(parseProtocolABudget(2_147_483_647), { clock, root: true });

// Queue a downstream call. No timeout is assigned yet.
const call = dispatcher.submit({ parent: root, protocol: 'B', budget: '10S' });

clock.advance(9_999_000_000n);              // time passes in the queue

// The transport really dequeues the call now. Remaining = 1ms.
const outcome = dispatcher.dispatch(call);
// outcome.status === 'sent'
// outcome.wire === '1000000n'  (encoded from the 1ms that is actually left)
// outcome.budget.encodedNanos <= outcome.remainingNanos  always
```

`withCall` runs a body inside its own scope (via `AsyncLocalStorage`), which is
how concurrent roots stay isolated:

```ts
await withCall({ budget: '5S', root: true }, async (scope) => {
  // scope is the ambient parent for beginCall / nested work here
});
```

## Protocol encodings

### Protocol A
Integer milliseconds, at most `2147483647`. Encoding truncates to whole
milliseconds.

| remaining ns   | wire value | note                       |
|----------------|------------|----------------------------|
| `1_500_000`    | `1`        | loss 500µs                 |
| `250_000_000`  | `250`      | exact                      |
| `1_000_000`    | `1`        | smallest representable     |
| `999_999`      | —          | `InsufficientBudgetError`  |
| `0` or below   | —          | `ExpiredBudgetError`       |
| > 2^31-1 ms    | `2147483647` | clamped, still ≤ remaining |

A positive budget below 1ms is **never** emitted as `0`: on this wire zero
means "no deadline", i.e. an infinite wait. The adapter reports
`status: 'insufficient'` and does not send.

### Protocol B
`1-8 digits` + unit `H`, `M`, `S`, `m`, `u`, `n`. Encoding picks the
representable value with the **smallest loss** that does **not exceed** the
remaining nanoseconds. If two units encode the same duration, the **finer**
unit wins (e.g. 1µs is `1000n`, not `1u`).

| remaining ns   | wire        | note                                  |
|----------------|-------------|---------------------------------------|
| `1`            | `1n`        | exact                                 |
| `1_000`        | `1000n`     | tie `1u`, finer unit wins             |
| `250_000_000`  | `250000u`   | tie `250m`, finer unit wins           |
| `99_999_999_999` | `99999999u` | 999ns loss; µs would need 9 digits  |
| `100_000_000_000` | `100000m` | exact; µs capped out, move coarser    |
| `3_600_000_000_000` | `3600000m` | exact; µs would need 10 digits    |

Because the nanosecond unit exists, every positive integer-nanosecond budget is
representable in B. The insufficient-budget guard is still implemented and
tested at the protocol minimum.

## Scopes and cancellation

- A scope owns one absolute deadline. Its **effective** deadline is the earlier
  of its own requirement and its parent's effective deadline. `deadlineOrigin`
  tells you which won (`own`, `ancestor`, `both`, `none`).
- **Parent cancels → descendants end.** Every descendant receives
  `reason: 'cancelled', cause: 'ancestor'`.
- **Child cancels → only its own descendants end.** The parent and siblings are
  untouched; their deadlines and end states do not change.
- **Ending is final.** Late notifications — a parent cancel after a child
  already ended, or a dequeue callback arriving after expiry — never change an
  existing end state and never revive a scope.
- Concurrent roots are independent because each `withCall` runs in its own
  `AsyncLocalStorage` context; one root's clock or cancellation cannot reach
  another.
- On end: `AbortSignal` fires, waiters resolve, cleanups run (queue slot
  released, deadline timer cleared), and the scope detaches from its parent.

## The queue-hold scenario (`test/integration.test.ts`)

One test sets up four sibling calls under a common parent:

- **A** (protocol A) waits in the queue until **999_999ns** remain → reports
  `insufficient`, sends nothing, does not emit `0`.
- **B** (protocol B) waits to the same **999_999ns** → sends `999999n`,
  exactly the remaining amount.
- **C** (protocol B) is held so its remaining is **99_999_999_999ns** → crosses
  the eight-digit µs boundary and sends `99999999u` (900ns loss), proven `≤`
  remaining.
- **D** is a sibling cancelled while the others wait; its grandchild ends with
  cause `ancestor`, and none of A, B, C or the parent is affected.

Throughout, every sent outcome satisfies `encodedNanos ≤ remainingNanos`, and
each sibling keeps its own deadline and end state.

## Design notes

- **Exact integers only.** Durations, deadlines and remaining time are `bigint`
  nanoseconds. `number` budgets are rejected rather than coerced, so a float
  can never enter the deadline arithmetic.
- **One clock per tree.** A child must use the same monotonic clock object as
  its parent; otherwise construction throws.
- **Timers are advisory.** With the system clock, the dispatcher arms
  `setTimeout` for each queued call so expired calls leave the queue without a
  dequeue notification. A timer that fires early re-arms for the remainder
  instead of expiring the call. With `ManualClock` (the default), no wall-clock
  timers are armed; time only moves when the test advances it.
- **Transport-agnostic.** `onSend` / `onExpire` callbacks let a real transport
  receive the encoded budget and the exact remaining amount.
