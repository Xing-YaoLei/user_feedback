# message-router

An embeddable, synchronous message router for Node.js, written in TypeScript
and runnable directly by Node's built-in TypeScript support (no build step, no
dependencies).

It models the routing problem where **one publish can reach the same queue
along several switch branches**, ordinary bindings may form cycles, and an
**alternate exchange** must only be used when the ordinary path genuinely has
nowhere to deliver.

## Quick start

```bash
npm test      # 64 real assertions + interleaving/crash scenarios
npm run example   # walks examples/topology.json and prints each route result
```

Node **22.18+** is required (native type stripping). Tested on Node 26.8.1.

## Embedding

```ts
import { Router } from './src/index.ts';

const router = new Router({
  exchanges: [
    { name: 'events', kind: 'topic', alternateExchange: 'dlx' },
    { name: 'dlx', kind: 'fanout' },
  ],
  queues: [{ name: 'orders' }, { name: 'dead' }],
  bindings: [
    { id: 'b1', source: 'events', destination: 'orders', destinationKind: 'queue', routingKey: 'order.*' },
    { id: 'b2', source: 'dlx', destination: 'dead', destinationKind: 'queue' },
  ],
});

router.route({ exchange: 'events', routingKey: 'order.created' });
// {
//   routable: true,
//   exchange: 'events',
//   routingKey: 'order.created',
//   resolvedFrom: 'events',
//   alternates: [],
//   targets: [{ queue: 'orders', bindingPath: ['b1'] }],
//   topologyVersion: 0
// }
```

The package entry is `src/index.ts`; the important exports are:

| Export | Purpose |
| --- | --- |
| `Router` | Stateful facade: batch topology replacement + versioned routing. |
| `compileTopology` | Validate a description into an immutable snapshot. |
| `routeOnTopology` | Pure routing against a snapshot you own. |
| `traverseNormal` | The ordinary-binding walk, exported for inspection. |
| `parseRoutingKey` / `parseTopicPattern` / `topicMatches` | Key and pattern semantics. |
| `saveSnapshot` / `loadSnapshot` | Crash-safe topology persistence (optional). |
| `RouterError` | Errors carry a stable `code`. |

## Topology model

- **Exchanges** are `direct`, `fanout` or `topic`.
- **Bindings** go from an exchange to a queue *or to another exchange*.
  `destinationKind` may be omitted when the destination name is unambiguous.
- **Routing keys** are dot-separated; an empty key means **zero segments**, and
  empty segments (`a..b`, `.a`) are rejected.
- **Topic patterns** use one segment per wildcard: `*` matches exactly one
  segment, `#` matches zero or more. A wildcard may not be glued to text
  (`order*` is rejected), and adjacent `#.#` is accepted and behaves like a
  single `#`.

## Routing semantics

1. Starting at the publish's entry exchange, walk **all matching ordinary
   bindings**, following exchange destinations transitively.
2. Collect **every reachable queue exactly once**. For each queue keep the
   **shortest** binding-id path; equal-length paths are decided by comparing
   binding-id sequences lexicographically.
3. If that set is non-empty, the publish is routed. **No alternate exchange is
   consulted anywhere** — not the entry's, and not any downstream exchange's.
4. If the set is empty, jump to the entry exchange's `alternateExchange`, record
   the hop, and repeat from step 1 with that exchange as the new root. Each
   further empty result advances along the chain the same way.
5. If a chain step revisits an exchange, the chain is cyclic: return
   `routable: false` with `alternateCycle.exchanges` naming the loop (e.g.
   `['alt-a', 'alt-b', 'alt-a']`). If the chain ends at an exchange with no
   alternate, return `routable: false` with no cycle.

The result also reports `resolvedFrom` — the exchange whose ordinary bindings
produced the targets — and `alternates`, the hops actually taken.

### Why cycles and diamonds stay cheap

- The ordinary walk is a breadth-first expansion over **binding hops**. Each
  exchange is expanded at most once, and only one best prefix is retained per
  exchange and depth, so total binding evaluations are bounded by the number of
  bindings. Normal cycles terminate; criss-crossing back edges do not multiply.
- Topic matching is a **dynamic program** over `(pattern segment, key segment)`,
  so consecutive `#` segments and overlapping prefixes cannot cause exponential
  backtracking. `test/graph.test.ts` builds deliberately dense cyclic graphs and
  asserts the expansion counts stay linear.

## Topology replacement and versions

`Router` holds one immutable snapshot at a time.

- `replaceTopology(input)` compiles and validates the **whole** batch first,
  then swaps atomically. A rejected replacement leaves the old topology and
  version untouched.
- Every `route()` captures the current snapshot and version before doing work,
  so a message is always routed against **one** version. The version is echoed
  as `topologyVersion`.
- `routeBatch(publishes)` pins a single version for the whole batch.
- `capture()` returns a `TopologySnapshot` handle you can hold across `await`
  points; routes through it never see later replacements.
- `Router.fromSnapshot({ topology, version })` restores a router from a loaded
  snapshot and continues its version sequence.

Adding one ordinary binding for a key that previously fell through immediately
stops the alternate chain on the very next route (see
`test/versioning.test.ts` and `npm run example`).

## Crash-safe persistence (optional)

`saveSnapshot` / `loadSnapshot` store a topology in a checksummed envelope:

1. compile and canonicalise the topology,
2. write a temp file and flush it,
3. `rename` it over the target.

A crash before the rename leaves the previous file intact and cleans up the
temp file; a truncated or edited file fails its SHA-256 checksum and is
rejected with `CORRUPT_SNAPSHOT` rather than being routed against. Inject a
`SnapshotFileAdapter` to simulate failures — `test/store.test.ts` drives
crashes at each step.

## Local verification topology

`examples/topology.json` (mirrored by `test/fixtures.ts`) contains:

- a **diamond merge** (`ingress → split → {left, right} → q-left`),
- a **normal binding cycle** (`left → cycle-a → cycle-b → left`),
- a **downstream alternate** (`right → shadow-dlx`) that must stay dormant,
- equal-length tie-break paths and a shorter-path-beats-smaller-id case,
- a **multi-hop alternate chain** (`chain-a → chain-b → chain-c`) and an
  **alternate cycle** (`alt-a ↔ alt-b`).

`npm run example` asserts the expected target sets for each, then adds one
binding and shows the alternate chain stop firing.

## Layout

```
src/
  types.ts       value types, RouteResult, RouterError
  matching.ts    key parsing + DP topic matcher
  topology.ts    validation/compilation, binding-path comparison
  traversal.ts   ordinary-binding BFS (alternate-blind)
  routing.ts     normal-first route with alternate chain
  router.ts      stateful facade, versioning, snapshot capture
  store.ts       atomic, checksummed snapshot persistence
  index.ts       public entry point
test/            node:test suites (matching, topology, routing, alternates,
                 graph bounds, versioning/interleaving, store crashes)
examples/        runnable topology walkthrough + JSON topology
```
