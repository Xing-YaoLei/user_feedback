# Mesh Traffic Planner

Exact, deterministic traffic planning for a multi-region service mesh. Given
the requests each source region wants to send this round, the capacity each
receiving cluster can absorb, and the allowed (source, cluster) routes with
their per-unit costs, it decides how many requests to send on every allowed
route.

The solver runs on Node.js as TypeScript (Node's built-in type stripping — no
compiler, no dependencies) and does all arithmetic in `bigint`, so counts and
total cost stay exact far beyond `Number.MAX_SAFE_INTEGER`.

## What it optimises

Objectives, applied strictly in order:

1. **Maximise accepted requests** — serve as much of the total demand as the
   allowed routes permit.
2. **Minimise total routing cost** among all maximum-throughput plans. Local
   (same-region) routes normally cost 0, cross-region routes cost more.
3. **Lexicographically smallest share vector** among the plans meeting 1 and 2.
   The vector lists one coordinate per allowed route in `(source id, cluster
   id)` order (UTF-16 code-unit order), zero flows included, and the smallest
   such vector wins. This makes ties fully deterministic.

The plan respects source demands and cluster capacities simultaneously. Edges
absent from the input are forbidden and always receive zero traffic.

The greedy trap this design avoids: two regions can both reach a shared
cluster, but one of them has no other outlet. Allocating cluster capacity
region-by-region greedily lets the flexible region take the shared capacity
and starve the constrained one, lowering total throughput. Maximising global
flow first forces the flexible region back to its own clusters.

## When demand cannot all be served

If some requests are left unaccepted, the result carries a **capacity cut**
certificate you can re-check from the raw input alone:

- `sourceRegion` — a non-empty set of source regions `S`;
- `clusterRegion` — a set of clusters `T`;
- **closure** — every allowed route leaving `S` lands in `T`;
- so `S` can only ever place traffic on `T`, absorbing at most
  `clusterCapacity` requests;
- everything outside `S` adds at most `totalDemand - sourceDemand`, hence no
  feasible plan can accept more than

  ```
  cutCapacity = (totalDemand - sourceDemand) + clusterCapacity
  ```

  and the returned plan accepts exactly `cutCapacity` (`tight: true`).

`unserved` reports the gap `sourceDemand - clusterCapacity` inside the cut.
Because the plan attains the bound, no allowed route can carry one more
request — the cut is an exhaustive proof, not a heuristic.

## Install and run

Requires Node.js ≥ 22.6 (for built-in TypeScript type stripping). No
dependencies to install.

```sh
# run the test suite (real assertions, non-zero exit on failure)
npm test

# plan a JSON document from a file
node src/cli.ts examples/basic.json

# or pipe one on stdin
node src/cli.ts < examples/greedy-trap.json
```

The CLI reads JSON (quantities may be numbers or decimal strings) and prints
JSON with every quantity as a decimal string, so huge values survive the
round-trip.

## Library API

```ts
import { plan } from './src/index.ts';

const result = plan({
  sources: [
    { id: 'us-east', demand: 1200n },
    { id: 'eu-west', demand: 800n },
  ],
  clusters: [
    { id: 'us-cluster', capacity: 1000n },
    { id: 'eu-cluster', capacity: 900n },
  ],
  edges: [
    { source: 'us-east', cluster: 'us-cluster', cost: 0n },
    { source: 'us-east', cluster: 'eu-cluster', cost: 5n },
    { source: 'eu-west', cluster: 'eu-cluster', cost: 0n },
  ],
});

result.summary;        // { served: 1900n, unserved: 100n, totalCost: 500n, ... }
result.assignments;    // positive flows sorted by (source, cluster)
result.servedBySource; // Map<string, bigint>
result.cut;            // CapacityCut when anything is unserved, else null
```

Quantities may be `bigint`, a safe integer `number`, or a decimal `string`.
Unsafe `number`s are rejected rather than silently rounded.

Also exported:

- `verifyPlan(input, result)` / `verifyCut(input, cut)` — independent audit of
  legality, conservation, totals, cost and the cut certificate.
- `shareVector(input, result)` / `compareShareVectors` — the canonical share
  vector and its ordering.
- `toJson(result)` / `fromJson(document)` — bigint-safe JSON adapters.

## How it works

The planner builds the transport network

```
SS --demand_i--> source_i --cost_ij--> cluster_j --capacity_j--> TT
```

and runs **bigint successive-shortest-path min-cost max-flow**. Each route is
one edge whose capacity is a request count; a single augmenting path pushes a
whole bulk of units. The number of augmentations is bounded by the graph
structure, **never by the magnitude of the demands** — requests are never
expanded into per-request nodes, so a demand of 10¹⁵ costs the same as a demand
of 10.

The lexicographic tie-break then operates on the zero-reduced-cost residual
graph of the optimum: the alternative optimal plans are exactly the
circulations of reduced cost 0. Routes are visited in `(source, cluster)`
order and each one's flow is lowered as far as possible via a filtered max-flow,
then frozen. Every step is a bulk circulation.

If demand is left over, the residual min cut (source side reachable from `SS`)
is read back and reported as the capacity cut.

## Layout

```
src/
  types.ts     public data model and cut documentation
  flow.ts      bigint min-cost max-flow + filtered max-flow + residual helpers
  planner.ts   validation, optimisation, lexicographic tie-break, cut extraction
  verify.ts    independent plan / cut verifiers and share-vector utilities
  json.ts      bigint-safe JSON adapters
  cli.ts       command-line front end
  index.ts     public entry point
examples/      sample JSON inputs
test/          node:test suites (behaviour, differential, exactness, cut, JSON/CLI, interleaving)
```

## Tests

`npm test` runs `node --test test/` and covers:

- the greedy-trap instance and other objective-order cases;
- **differential testing** against an exhaustive reference solver on thousands
  of random tiny instances, checking served total, total cost and the exact
  share vector;
- exactness beyond `Number.MAX_SAFE_INTEGER` and absence of per-request work;
- the capacity cut as an independently re-derived upper bound;
- JSON/CLI round-trips and error exits;
- interleaved, re-entrant and mid-call-failure executions (the planner holds no
  module-level mutable state, so concurrent and nested calls cannot interfere).

Temporary data written by tests stays inside per-test temp directories and is
removed afterwards.
