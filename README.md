# Route Template Compiler

A dependency-free TypeScript implementation for Node.js that compiles route
templates, decides **exactly** whether their parameter languages overlap,
matches runtime paths and reverse-generates canonical paths from parameters.

## Template syntax

Templates are slash-separated units; every unit is one of:

| Unit | Meaning |
| --- | --- |
| `literal` | literal segment (escape braces/backslashes with `\`) |
| `{name:int[min..max]}` | integer parameter; matches canonical decimal numbers in the inclusive range |
| `{name:[a-z0-9]}` | character-set parameter, default length exactly 1 |
| `{name:[a-z]{2..4}}` | character-set parameter with length constraint (`{n}` or `{min..max}`) |
| `{name:[A-Z]{3}}?` | optional segment (trailing `?`) |
| `{*name:[a-z]{1..8}}` | tail capture: zero or more trailing segments, keeping segment boundaries |

Character sets support literal characters, `a-z` ranges and the escapes
`\-`, `\]`, `\\`.

## Compilation guarantees

`compileRules(rules)` takes rules with stable string ids and integer
priorities and returns either:

- `{ ok: true, rules, shadows }` — rules sorted by priority (high to low);
  `shadows` lists rules whose **entire** parameter language is covered by the
  joint set of strictly higher-priority rules (including coverage assembled
  from several partial covers), with a concrete witness path and the rule
  that actually wins it; or
- `{ ok: false, issues }` — fatal problems, each carrying a concrete witness
  path:
  - `conflict`: two rules at the **same** priority whose languages intersect,
    with the witness path and both parameter bindings;
  - `ambiguity`: one template that can bind the same concrete path in two
    different ways (e.g. an optional segment in front of a tail capture),
    with the two bindings and the differing parameters.

All overlap, containment and shadow decisions operate on the whole parameter
language. Integer × character-set intersection is decided by a range-aware
digit DP, so million-wide integer ranges never get enumerated. Results are
independent of template registration order (output is deterministically
sorted).

## Path decoding / encoding

Input paths are split on the **raw** slashes first; each segment is then
percent-decoded exactly once as strict UTF-8 (overlong encodings, surrogates
and truncated sequences are rejected with a segment/byte-offset location).
A slash produced by decoding `%2F` stays inside its segment, and tail
captures preserve every segment boundary. Reverse generation emits canonical
uppercase percent encoding (only RFC 3986 unreserved characters stay
literal), so re-decoding and re-encoding is idempotent.

## Usage

```ts
import { compileRules, createRouter, reverse } from './src/index.ts';

const result = compileRules([
  { id: 'article', template: '/articles/{id:int[1..99999]}', priority: 10 },
  { id: 'tag',     template: '/articles/t/{tag:[a-z]{2..4}}', priority: 20 },
  { id: 'files',   template: '/files/{*path:[a-zA-Z0-9.-]{1..16}}', priority: 5 },
]);
if (!result.ok) {
  // result.issues contains conflicts/ambiguities with witness paths
  throw new Error(JSON.stringify(result.issues, null, 2));
}

const router = createRouter(result.rules);
router.match('/articles/42');
// { ruleId: 'article', template: '/articles/{id:int[1..99999]}',
//   priority: 10, params: { id: 42 } }

router.match('/files/a/b/c.txt');
// { ruleId: 'files', params: { path: ['a', 'b', 'c.txt'] } }

reverse(router, 'article', { id: 42 });
// { ruleId: 'article', path: '/articles/42', interceptedBy: null }
//
// When another higher-priority rule takes the generated path, the result
// reports the actual winning rule and its bindings as `interceptedBy`.
```

### Public modules

- `src/parser.ts` — template parsing and validation
- `src/encoding.ts` — strict UTF-8 percent decoding / canonical encoding
- `src/segments.ts` — segment-language algebra (membership, intersection
  witnesses, exact set difference via `minus` languages, digit DP)
- `src/compiler.ts` — variant expansion, ambiguity/conflict detection, exact
  joint-shadow analysis
- `src/matcher.ts` — runtime matching
- `src/reverse.ts` — validated reverse generation with interception detection
- `src/index.ts` — public entry point

## Requirements and tests

- Node.js ≥ 22.6 (developed on Node.js 26); TypeScript uses only erasable
  syntax, so the code runs directly with the built-in TypeScript support — no
  compiler or dependency installation is needed.
- Run the full verification (real assertions, conflict/shadow/interception
  scenarios, zero exit only on success):

```sh
npm test
```
