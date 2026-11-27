# Cross-service capability negotiation

A dependency-free TypeScript module that selects, from several participants'
capability declarations, **one protocol version and one feature set** that every
participant accepts, while maximizing an integer benefit total. When no such
selection exists it returns a **minimal unsatisfiable core** with a satisfiability
witness for every "remove this one constraint" variant.

Runs on Node.js (v22.6+ for built-in TypeScript type-stripping; developed and
verified on Node 26) — no compiler, bundler, or `node_modules` required.

## Quick start

```bash
npm test        # full suite: 54 tests across 6 files, real search and replay
npm run demo    # human-readable walkthrough of the main flows
```

Library use:

```ts
import { negotiate, NegotiationSession, verifySuccessOutcome } from './src/index.ts';

const outcome = negotiate(
  [
    {
      partyId: 'media-core',
      offerVersion: '2026.1',
      protocolVersions: ['rtp/2', 'rtp/3'],
      supportedFeatures: ['audio', 'video', 'hdr'],
      requiredFeatures: ['audio'],
    },
    {
      partyId: 'edge-relay',
      offerVersion: 'edge-7',
      protocolVersions: ['rtp/3'],
      supportedFeatures: ['audio', 'video', 'hdr', 'low-latency'],
      constraints: [
        {
          id: 'hdr-needs-low-latency',
          expr: {
            op: 'or',
            args: [
              { op: 'not', arg: { op: 'feature', feature: 'hdr' } },
              { op: 'feature', feature: 'low-latency' },
            ],
          },
        },
      ],
    },
  ],
  { audio: 1, video: 4, hdr: 6, 'low-latency': 5 },
);

if (outcome.status === 'success') {
  outcome.protocolVersion; // 'rtp/3'
  outcome.features;        // ['audio', 'hdr', 'low-latency', 'video']
  outcome.totalBenefit;    // 16
  verifySuccessOutcome(outcome, offers, benefits).ok; // true
}
```

## Model

### Offers

```ts
interface Offer {
  partyId: string;                 // unique participant id
  offerVersion: string;            // immutable version stamp
  protocolVersions: string[];      // non-empty
  supportedFeatures: string[];     // features this party can execute
  requiredFeatures?: string[];     // must appear in every solution
  constraints?: FeatureConstraint[]; // boolean rules, each with a unique id
}
```

### Constraint language

`Expr` is a small boolean language over feature ids:

| Operator | Shape | Meaning |
| --- | --- | --- |
| `feature` | `{ op:'feature', feature:'hdr' }` | feature is enabled |
| `not` | `{ op:'not', arg:Expr }` | negation |
| `and` / `or` | `{ op:'and', args:Expr[] }` | n-ary conjunction / disjunction |
| `atMost` / `atLeast` / `exactly` | `{ op:'atMost', features:string[], count:n }` | cardinality |

Alternative dependencies are ordinary disjunctions, e.g. "A requires B or C":

```json
{ "op": "or", "args": [
    { "op": "not", "arg": { "op": "feature", "feature": "A" } },
    { "op": "feature", "feature": "B" },
    { "op": "feature", "feature": "C" } ] }
```

Exclusions use `not` or `atMost`; cardinality budgets use `atMost`/`exactly`.

## Results

All outcomes carry an `OfferBinding`:

- `offerVersions`: party id → version actually used,
- `offersFingerprint`: SHA-256 of the canonical request (offers + benefits).

### `status: 'success'`

- `protocolVersion` — smallest version accepted by every party,
- `features` — ascending feature ids,
- `totalBenefit` — integer sum,
- `featureBenefits` — per-feature contribution,
- `parties` — one `PartyCertificate` per party with `protocolAccepted`,
  `allSelectedFeaturesSupported`, `allRequiredFeaturesSelected`, and every
  custom constraint re-evaluated as `satisfied: true`,
- `search` — nodes explored, budget state, resume flag.

`verifySuccessOutcome(outcome, rawOffers, benefits)` re-derives every claim from
the original offers, independently of the search code.

### `status: 'unsatisfiable'`

- `core` — the **minimal unsatisfiable core**: a set of individually
  identifiable rules (`protocol:<party>`, `support:<party>:<feature>`,
  `required:<party>:<feature>`, `constraint:<party>:<id>`) that cannot all hold,
- `removalWitnesses` — for **every** core member `m`, a concrete
  `{ protocolVersion, features }` satisfying all other members. Removing any
  one member is therefore satisfiable; removing none is not.

Protocol and feature constraints are independent dimensions, so a core is always
purely a protocol core or purely a feature core. This keeps diagnoses precise and
minimal. `verifyUnsatisfiableOutcome` re-checks unsatisfiability, minimality, and
every witness by exhaustive enumeration.

### `status: 'undetermined'`

Returned when `maxSteps` is exhausted before a decision. `progress` is exact,
JSON-serializable continuation state:

```ts
let outcome = negotiate(offers, benefits, { maxSteps: 50 });
while (outcome.status === 'undetermined') {
  outcome = negotiate(offers, benefits, { maxSteps: 50, resume: outcome.progress });
}
```

Resumption never redoes nodes and never changes the answer: every budget value
produces byte-identical results to an unbudgeted run (covered by tests). Progress
is bound to the request snapshot; if any offer changes, reuse is rejected with
`StaleProgressError` instead of silently combining old and new offers. Pass
`staleProgress: 'restart'` to explicitly discard a stale token and solve the
current offers from scratch (the result is still bound to the current versions).

## Sessions and offer updates

`NegotiationSession` holds one immutable offer per party.

```ts
const session = new NegotiationSession({ offers, benefits });
session.updateOffer({ ...offer, offerVersion: '2', supportedFeatures: [...] });
session.solve();
```

- A `(partyId, offerVersion)` pair can never be reused for different content:
  `OfferVersionConflictError`.
- Updating an unknown party: `UnknownPartyError`.
- Re-publishing identical content under the same version is idempotent.
- Every result and every progress token binds all offer versions; an old
  solution is never reported as the answer for a new offer set.

## Determinism

1. Maximize `totalBenefit`.
2. Among equal-benefit sets, choose the lexicographically smallest ascending
   feature-id list (a proper prefix wins).
3. Report the smallest common protocol version.

Offer order, feature declaration order, and duplicate declarations do not change
the result. Inputs are never mutated.

## How it works

- **Normalization** (`src/normalize.ts`): validates, canonicalizes, dedupes, and
  fingerprints.
- **Problem compilation** (`src/problem.ts`): splits declarations into protocol
  rules and feature rules. Support rules become fixed-false variables for the
  relevant subset, which is exact.
- **Search** (`src/search.ts`): explicit-stack depth-first branch-and-bound.
  Decisions are ordered by descending benefit; pruning uses a positive-benefit
  suffix bound that never cuts a possible lexicographic tie. The same file holds
  a resumable SAT engine for core minimization.
- **Diagnosis** (`src/core.ts`): deletion-based MUS. Starting from all rules of
  the failing dimension, test each rule's removal; keep it if the remainder
  becomes satisfiable (recording the witness), drop it otherwise. Because later
  tests only shrink the set, each recorded witness also satisfies the final
  core minus that rule.
- **Reference oracle** (`src/reference.ts`): a deliberately independent
  brute-force enumerator used by tests to confirm optimality, unsatisfiability,
  minimality, and witness validity.

## Layout

```
src/
  index.ts      public entry point
  types.ts      data model
  errors.ts     typed errors
  normalize.ts  validation + canonical fingerprint
  eval.ts       two- and three-valued expression evaluation
  problem.ts    rule compilation, protocol intersection
  search.ts     resumable optimizer and SAT engines
  core.ts       driver, MUS, progress serialization, outcome builders
  session.ts    immutable offers with version enforcement
  verify.ts     independent result verification
  reference.ts  exhaustive oracle
  demo.ts       runnable walkthrough
test/
  negotiation.test.ts  core behavior + reference agreement
  scenarios.test.ts    cross-service scenarios from the brief
  resume.test.ts       budgets, resume, staleness, replay
  replay.test.ts       budget sweep vs uninterrupted outcomes
  crosscheck.test.ts   exhaustive random cross-checks
  validation.test.ts   input validation and determinism
```

## Caveats

- Search is exponential in the worst case. `maxSteps` (default 200000) bounds
  each call; resumable progress makes long runs observable and restartable.
- Features explicitly vetoed by at least one party are removed from the decision
  space (exact, because support is mandatory).
- `referenceSolve`/`checkCore` enumerate assignments and refuse universes over
  24/20 features; they exist for tests, not production use.
