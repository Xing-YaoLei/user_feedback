# Exclusive connection lease pool

A dependency-free TypeScript implementation of an exclusive connection lease
pool for Node.js. A connection is held by at most one caller at a time, and it
is never handed to the next caller until the adapter has finished resetting it.

The pool is deliberately strict about capacity: a slot is consumed from the
moment a connection's creation starts and is returned only when creation fails
or closing completes. Returning a connection does not free a slot — the
connection is reset first and then either becomes idle or is closed.

## Requirements

- Node.js 22.6 or newer (this repo was verified on Node.js 26.8.1).
- No install step, no compiler, no external service. Node's built-in
  TypeScript type-stripping runs `.ts` files directly, and the test suite uses
  the built-in `node:test` runner.

## Run it

```sh
npm test      # all tests, real assertions, non-zero exit on failure
npm run demo  # a small runnable example of three callers sharing one connection
```

`npm test` runs `node --test --test-timeout=15000 test/*.test.ts`. Every test
uses local, synthetic adapters and an injected fake clock; nothing touches the
network, a database, or the system clock. All temporary state lives in memory
inside the test process.

## Module entry point

`src/index.ts` is the public entry point. It re-exports:

- `ConnectionLeasePool` — the pool itself.
- `PoolAdapter<C>`, `ConnectionLeasePoolOptions<C>`, `AcquireOptions`,
  `ConnectionLease<C>`, `PoolStatus`, `PoolPhase`, `AdapterErrorInfo<C>`.
- `Clock`, `TimerHandle`, `systemClock`.
- The error classes, each with a stable `code`.

```ts
import { ConnectionLeasePool } from './src/index.ts';

const pool = new ConnectionLeasePool<MyConnection>({
  capacity: 4,
  adapter: {
    create: () => openConnection(),
    reset: (connection) => connection.resetSessionState(),
    close: (connection) => connection.close(),
  },
  maxLifetimeMs: 5 * 60_000,
  acquireTimeoutMs: 5_000,
  // clock: myClock, // optional; defaults to systemClock
});

const lease = await pool.acquire({ timeoutMs: 2_000, signal });
try {
  use(lease.connection);
} finally {
  await lease.release(); // resolves once the connection is idle again, or closed
}
```

## Contract

### Construction

| Option | Meaning |
| --- | --- |
| `capacity` | Maximum number of connections that may exist in any live state. Integer ≥ 1, required. |
| `adapter` | `create`, `reset`, `close`; each may be async and may take arbitrarily long. |
| `maxLifetimeMs` | Absolute lifetime measured from the instant `create()` fulfils. Positive number, or `Infinity` (default) to disable. |
| `acquireTimeoutMs` | Default borrow deadline. Default `Infinity`. |
| `clock` | Injected time source for lifetimes and deadlines. Default `systemClock`. |
| `onAdapterError` | Optional observer for adapter rejections. Never allowed to break accounting. |

Invalid configuration throws `PoolConfigurationError`.

### Capacity accounting

`status()` reports `creating`, `leased`, `idle`, `resetting`, `closing`,
`retired`, `used`, `available` and `pendingBorrowers`. `used` always equals the
sum of the five live states and never exceeds `capacity`. A slot is released in
exactly two situations:

1. `create()` fails (or resolves with no connection) — `createFailures` is
   incremented and, if a waiter was waiting on that creation, it receives
   `ConnectionCreateError`.
2. `close()` completes for a connection — a rejected `close()` still counts as
   completed (the resource is gone or abandoned) and increments `closeFailures`.

### Borrowing

- Waiters are served in arrival order.
- Each `acquire()` accepts `timeoutMs` and an `AbortSignal`. An expired deadline
  rejects with `BorrowTimeoutError`; an aborted signal rejects with
  `BorrowAbortedError`; an already-aborted signal rejects immediately without
  starting any work.
- If a connection's creation is still in flight when its original waiter times
  out or cancels, the late connection goes to the earliest still-valid waiter,
  or it becomes idle. It is never left attributed to a wait that has ended, and
  a late creation failure is never pinned on a caller who arrived afterwards.
- A creation failure is reported to the waiter whose demand started that
  creation if it is still waiting. Otherwise the earliest waiter not already
  backed by another in-flight creation receives `ConnectionCreateError`. This
  avoids silently retrying a permanently failing adapter forever; a caller that
  wants another attempt simply calls `acquire()` again.

### Returning

- `release()` resolves only once the pool has finished with the connection:
  either its reset completed and it is idle, or it has been fully closed.
- Every borrow has its own credential object (`lease.id`). A second `release()`
  on the same lease rejects with `LEASE_ALREADY_RELEASED`. The same error is
  returned if an old credential is used after the same underlying connection has
  been borrowed again, so an old token can never return a newer borrow. No reset
  is performed for a rejected return.
- A failed reset is never followed by a hand-off. The connection is closed, its
  slot is freed only when that close completes, and `resetFailures` is
  incremented.

### Lifetime

- The lifetime starts when `create()` fulfils.
- If it expires while the connection is **leased** (or mid-reset), it is only
  *retired*: the holder keeps it until `release()`, which then resets and closes
  it instead of making it idle.
- If it expires while **idle**, the pool closes it instead of lending it out.

### Closing the pool

- `close()` immediately stops accepting borrows (`acceptingBorrows: false`),
  rejects every outstanding waiter with `PoolClosedError`, and returns one
  shared promise.
- In-flight creation finishes its handshake and the resulting connection is
  closed without being lent. In-flight returns finish their teardown and are
  closed rather than returned to idle.
- A leased connection is only marked retired; it is closed when its holder
  returns it.
- Querying distinguishes "no longer lending" (`acceptingBorrows: false`,
  `phase: 'closing'`) from "everything is gone" (`allResourcesClosed: true`,
  `phase: 'closed'`, `used: 0`). The close promise resolves only in the latter
  state.

## Verification

`npm test` contains 37 tests across five files:

- `test/behavior.test.ts` — capacity accounting, FIFO order, credentials,
  deadlines, cancellation, lifetime retirement, configuration.
- `test/lifecycle.test.ts` — close during creation/borrow/reset, reset failure,
  closing a retired connection, close/borrow attribution, slow close.
- `test/capacity-one.test.ts` — the three capacity-one hazards threaded
  together: cancel while `create()` is pending, a reset that fails, and a close
  that hangs. Asserts the real number of opened connections, every waiter's
  outcome, and which connection each reset/close was applied to.
- `test/protocol.test.ts` — injected clock isolation, timer cleanup, adapters
  that throw synchronously or resolve `undefined`, credential reuse, concurrent
  double release, distinct "stopped lending" vs "all resources closed".
- `test/interleaving.test.ts` — a seeded, reproducible randomized driver over
  five seeds that settles adapter operations in arbitrary orders and checks the
  capacity invariant, lease uniqueness, no double close, and full drain after
  every step. It also asserts that the interesting paths (grants, resets,
  closes, create failures, borrow timeouts) were actually exercised, so the
  invariant checks are not vacuous.

Each of these uses `FakeClock` from `test/helpers.ts`; deadlines and lifetimes
move only when a test calls `advance()`. The test adapter's `create`, `reset`
and `close` stay pending until the test settles them, giving full control over
interleavings. Test helper code is in `test/helpers.ts` and is not part of the
public API.

Two quick source-level checks were also used during development: the
credential guard was disabled temporarily (suite failed), and the slot was
freed on reset completion rather than close completion (suite failed, including
the randomized invariants).
