# layered-config-evaluator

A TypeScript module for evaluating conditional configuration built from
ordered override layers, path-registered expressions, and an immutable request
context. It answers not just *what* a value is but *why*: every result carries
the definition layer, the context and configuration paths actually read, and
the reference chain that produced it.

Runs directly on Node.js (>= 22.18) using native TypeScript type stripping —
no build step, no compiler, no runtime dependencies, no `node_modules`.

## Quick start

```bash
npm test      # full assertion suite (89 tests), incl. interleaving/crash cases
npm run demo  # prints an annotated evaluation report
```

```ts
import { createConfigEvaluator, expr, deletePath } from './src/index.ts';

const evaluator = createConfigEvaluator({
  layers: [
    // Highest priority first.
    {
      id: 'tenant',
      values: {
        // An inline expression overrides the environment value while still
        // seeing what it overrides.
        'service.retries': expr({ $add: [{ $base: true }, { $const: 2 }] }),
      },
    },
    { id: 'env', values: { 'service.timeout': '500ms', 'service.retries': 3 } },
  ],
  expressions: {
    // Registered expressions are the computed definition of a path.
    'service.effectiveTimeout': {
      $if: [
        { $eq: [{ $ctx: 'region' }, { $const: 'eu' }] },
        { $add: [{ $ref: 'service.timeout' }, { $qty: '100ms' }] },
        { $ref: 'service.timeout' },
      ],
    },
  },
  context: { region: 'eu' },
});

const result = evaluator.evaluate(['service.effectiveTimeout', 'service.retries']);

result.values['service.effectiveTimeout'].value;                 // { kind: 'number', value: '600', unit: 'ms' }
result.values['service.effectiveTimeout'].definition.layer;      // '<expression>'
result.values['service.effectiveTimeout'].definition.refs;       // [{ path: 'service.timeout', layer: 'env', via: 'ref' }]
result.values['service.retries'].value;                          // 5 (env's 3, plus 2)
```

## Concepts

### Layers and priority

Layers are supplied **highest priority first**. Values are a flat map of
dot-separated paths. `.` and any other characters are taken literally, so
`service.timeout` is one key.

The expression registry is modelled as the highest-priority computed source: a
path registered there is *defined by that expression*, and the expression may
read lower layer values through `$base`. Paths without a registered expression
resolve to their winning layer value.

### Deletions vs. null

`deletePath()` (or `DELETE`, or `{ $delete: true }` as a layer value) removes
the path from that layer downward: every lower definition is hidden, and the
path reports as missing with reason `deleted`. An explicit `null` is a real
value and propagates normally. A deletion also suppresses a registered
expression for that path — removal is an operator decision, not a gap to fill.

### `$base`: the nearest definition below

`{ $base: true }` (or `{ $base: { path } }`) resolves **the nearest definition
strictly below the layer hosting the expression**:

- in a registered expression, that is the winning layer value — the "keep
  computing on top of the configured value" pattern;
- in an expression written inline in a layer (e.g. a tenant layer), it is the
  nearest definition in the lower layers, so a tenant can adjust an environment
  value without hard-coding it.

A deletion met during the search stops it (`deleted`), rather than being
skipped. No lower definition is *missing*, not an error — combine with
`$coalesce` or `$exists` to supply a default.

### `$ref`: the final value

`{ $ref: 'other.path' }` reads the final resolved value of another path,
following the same overrides a caller would see. Dependencies are tracked
transitively.

### Lazy conditionals

`$if`, `$and`, `$or` and `$coalesce` evaluate only what they need. An
unselected branch contributes **no dependencies and is never cycle-checked or
type-checked**, so a cycle that exists only in an unreachable branch cannot fail
a result. Switching the branch later does introduce the new dependencies, which
then correctly invalidate the result.

### Exact units

Numbers carry a dimension (`count`, `time`, `bytes`):

| Dimension | Units |
| --- | --- |
| time | `ns` `us` `ms` `s` `min` `h` `d` |
| bytes | `b` `kb` `mb` `gb` `tb` `kib` `mib` `gib` `tib` |
| count | `count` |

All parsing and arithmetic uses exact `bigint` rationals. `0.1s + 0.2s` is
exactly `0.3s`; `1GiB == 1024MiB`; `1GiB - 1MiB` is exactly
`0.9990234375GiB`. Addition and subtraction keep the left operand's unit;
comparison converts automatically. Multiplication and division accept a
`count` on either side; dividing equal dimensions yields `count`.

Mixing dimensions or types yields a structured error whose `source` names the
offending definition path (e.g. `unit_mismatch` with
`source: 'service.timeout'`, `sources: ['service.timeout', 'service.disk']`).
A dependent expression reports the same root cause, and the error carries the
reference chain leading there.

### Provenance

Every result reports:

- `layer` / `layerIndex` / `kind` — where the winning definition lives,
- `expression` or `literal` — the selected source,
- `dependencies` — labelled reads (`ctx:…`, `ref:…`, `base:…`, `const`, `$add`, …),
- `refs` — the reference chain, each hop tagged `via: 'ref' | 'base'` with the
  layer it landed in,
- `referencedPaths` and `contextKeys` — every transitive dependency,
- `baseLookups` — each base search with its boundary and outcome,
- `evaluatedAtRevision` — the revision the result is interpreted under.

### Batches, revisions and incremental recomputation

A batch pins **one revision**: the layer stack, context snapshot and revision
number are captured when the batch begins. All reference resolution, branch
selection and type checking in that batch are interpreted against that
revision, even if the evaluator is mutated while the batch is alive.

Caching is dependency-driven. Each cached node records its winning definition,
the signatures of context fields read directly, and the signature of every node
it referenced. A node is reused only when all of those still match, validated
recursively. So:

- an **unread** context field or unrelated layer change forces no
  recomputation;
- a change that alters an output propagates to all transitive dependents;
- a path that was previously missing or deleted, then filled in / restored,
  invalidates exactly the results that reached that absence;
- results reused after an unrelated change keep an accurate dependency chain.

`getStats()` exposes `evaluations`, `cacheHits`, `cacheMisses`, `hitsByPath`,
`recomputationsByPath`, `expressionEvaluationsByPath` and `nodeHitsByPath`.

Updates are atomic: an invalid update (unknown layer, duplicate id, malformed
value) throws and leaves the evaluator byte-for-byte unchanged.

## API

| Export | Purpose |
| --- | --- |
| `createConfigEvaluator(options)` | Build an evaluator from `{ layers, expressions?, context?, revision? }`. |
| `new ConfigEvaluator(options)` | Class form. |
| `evaluator.evaluate(paths, context?)` | Batch-evaluate roots under one revision. |
| `evaluator.evaluateOne(path, context?)` | Convenience for a single path. |
| `evaluator.beginBatch({ context?, revision? })` | Pin a revision and call `evaluate` repeatedly. |
| `evaluator.update(layerUpdate)` | Atomic in-place layer/expression change; returns the new revision. |
| `evaluator.setContext(context)` | Replace the immutable context; returns the new revision. |
| `evaluator.withLayerUpdate(update)` | Immutable variant returning a new evaluator with a copied cache. |
| `evaluator.removeEntry(layer, path)` | Delete a layer entry (distinct from a deletion marker). |
| `evaluator.getStats()` / `resetStats()` / `recomputations(path)` | Cache and recomputation counters. |
| `expr(node)` | Wrap an inline layer expression. |
| `deletePath()` / `DELETE` | Deletion marker. |
| `makeQuantity`, `formatQuantity`, `addQuantities`, `convertQuantity`, … | Exact unit helpers. |

Expression nodes:

```ts
type Expr =
  | { $const: LiteralValue | string | number | boolean | null }
  | { $qty: string | { value: string | number; unit: string } } // "250ms" | {value: '1.5', unit: 'GiB'}
  | { $ctx: string }                             // request-context field
  | { $ref: string }                             // final value of a path
  | { $base: true | {} | { path?: string } }     // nearest definition below the current layer
  | { $if: [Expr, Expr, Expr] }
  | { $exists: Expr }
  | { $coalesce: [Expr, ...Expr[]] }
  | { $eq | $ne | $lt | $lte | $gt | $gte: [Expr, Expr] }
  | { $and: [Expr, Expr, ...Expr[]] } | { $or: [Expr, Expr, ...Expr[]] } | { $not: Expr }
  | { $add: [Expr, Expr, ...Expr[]] }             // folds left to right
  | { $sub | $mul | $div: [Expr, Expr] };
```

Layer update forms:

```ts
{ type: 'set', layer, path, value }
{ type: 'delete', layer, path }              // remove the entry entirely
{ type: 'addLayer', layer, at? }
{ type: 'removeLayer', layer }
{ type: 'setExpressions', expressions }
```

## Layout

```
src/
  index.ts       public entry point
  types.ts       public type contracts
  internal.ts    internal node/cache contracts
  quantity.ts    exact rational and unit arithmetic
  values.ts      literal normalization, canonicalization, context lookup
  signature.ts   stable hashing for cache signatures
  layers.ts      ordered sources, deletions, definition lookup, $base search
  expression.ts  expression evaluation, laziness, type/unit errors
  engine.ts      batches, revisions, dependency-driven caching, stats
  demo.ts        annotated example run
test/
  quantity.test.ts     exact units and arithmetic
  layers.test.ts       priority, deletions, null, $base, provenance
  expressions.test.ts  constants, context, laziness, cycles, errors
  incremental.test.ts  caching, invalidation, revision pinning
  scenarios.test.ts    end-to-end configuration scenarios
  sharing.test.ts      shared subexpressions, fan-out, deep chains
  acceptance.test.ts   the five acceptance scenarios, value + recompute counts
  interleaving.test.ts crash and interleaving consistency
```

## Verification notes

`npm test` runs real assertions with Node's built-in test runner against
locally synthesized data — no external services, no network, and no files
written outside the workspace. Failing assertions exit non-zero. Temporary
state is created per test in memory only.
