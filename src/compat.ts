import type {
  Type,
  TypePath,
  WireValue,
} from './types.ts';
import type { ValidatedSchema } from './validate.ts';
import { isLeaf } from './validate.ts';

export interface CheckFailure {
  reason: string;
  path: TypePath;
  counterexample: WireValue;
}

export type CheckOutcome = { ok: true } | { ok: false; failure: CheckFailure };

interface PairKey {
  w: Type;
  r: Type;
}

/**
 * Stateful checker for one ordered pair of schemas (writer -> reader).
 * Node-pair memoization makes recursive type analysis terminate: a pair
 * revisited while still being evaluated is optimistically assumed
 * compatible (coinductive guarded-recursion rule), and the assumption is only
 * finalized when the whole descent succeeds. A real mismatch underneath the
 * cycle propagates an error on the way back up, so soundness is preserved for
 * every finite nesting depth.
 */
export class CompatChecker {
  readonly writer: ValidatedSchema;
  readonly reader: ValidatedSchema;
  /** Finalized results only; both failures and successes land here. */
  private readonly memo = new Map<Type, Map<Type, CheckOutcome>>();
  /**
   * Pairs currently being evaluated. A hit means guarded recursion: the pair
   * is optimistically assumed compatible for the duration of the descent. The
   * assumption is never written into `memo`, so a real failure underneath the
   * cycle still propagates and can never be masked by a stale cached success.
   */
  private readonly inProgress = new Set<string>();

  constructor(writer: ValidatedSchema, reader: ValidatedSchema) {
    this.writer = writer;
    this.reader = reader;
  }

  checkRoot(): CheckOutcome {
    return this.check(this.writer.schema.root, this.reader.schema.root, [
      { kind: 'root' },
    ]);
  }

  check(w: Type, r: Type, path: TypePath): CheckOutcome {
    const cached = this.memo.get(w)?.get(r);
    if (cached) return cached;

    const key = pairKey(w, r);
    if (this.inProgress.has(key)) {
      // Coinductive assumption for guarded recursion; never finalized here.
      return { ok: true };
    }
    this.inProgress.add(key);
    const outcome = this.dispatch(w, r, path);
    this.inProgress.delete(key);

    this.store(w, r, outcome);
    return outcome;
  }

  private store(w: Type, r: Type, outcome: CheckOutcome): void {
    let inner = this.memo.get(w);
    if (!inner) {
      inner = new Map();
      this.memo.set(w, inner);
    }
    inner.set(r, outcome);
  }

  private dispatch(w: Type, r: Type, path: TypePath): CheckOutcome {
    if (w.kind === 'ref') {
      return this.check(this.writer.schema.types[w.name], r, path);
    }
    if (r.kind === 'ref') {
      return this.check(w, this.reader.schema.types[r.name], path);
    }

    if (isLeaf(w.kind) || isLeaf(r.kind)) {
      return this.checkLeaf(w, r, path);
    }
    if (w.kind !== r.kind) {
      return this.fail(
        'kind-mismatch',
        path,
        `writer kind '${w.kind}' cannot be read as reader kind '${r.kind}'`,
        this.minimalOf(w),
      );
    }

    switch (w.kind) {
      case 'array': {
        const arr = w as Type & { kind: 'array' };
        const rArr = r as Type & { kind: 'array' };
        return this.check(arr.items, rArr.items, [
          ...path,
          { kind: 'array-item', index: 0 },
        ]);
      }
      case 'record':
        return this.checkRecord(
          w as Type & { kind: 'record' },
          r as Type & { kind: 'record' },
          path,
        );
      case 'union':
        return this.checkUnion(
          w as Type & { kind: 'union' },
          r as Type & { kind: 'union' },
          path,
        );
      default:
        return this.fail('internal', path, 'unreachable dispatch', this.minimalOf(w));
    }
  }

  private checkLeaf(w: Type, r: Type, path: TypePath): CheckOutcome {
    if (!isLeaf(w.kind) || !isLeaf(r.kind) || w.kind !== r.kind) {
      if (isLeaf(w.kind) && isLeaf(r.kind) && numericLossless(w.kind, r.kind)) {
        return { ok: true };
      }
      return this.fail(
        'leaf-mismatch',
        path,
        `writer leaf '${w.kind}' is not losslessly representable by reader leaf '${r.kind}'`,
        this.minimalOf(w),
      );
    }
    return { ok: true };
  }

  private checkRecord(
    w: Type & { kind: 'record' },
    r: Type & { kind: 'record' },
    path: TypePath,
  ): CheckOutcome {
    const readerById = new Map(r.fields.map((f) => [f.id, f]));
    for (const wf of w.fields) {
      const rf = readerById.get(wf.id);
      if (!rf) continue; // reader ignores unknown fields
      const outcome = this.check(wf.type, rf.type, [
        ...path,
        { kind: 'field', id: wf.id, name: wf.name },
      ]);
      if (!outcome.ok) return outcome;
    }
    // A reader-required field breaks when a legal writer message may omit it:
    // either the writer schema does not carry the field id at all, or it
    // carries the id as an optional field with a default.
    const writerById = new Map(w.fields.map((f) => [f.id, f]));
    for (const rf of r.fields) {
      if (rf.hasDefault) continue;
      const wf = writerById.get(rf.id);
      if (!wf || wf.hasDefault) {
        const counterexample = this.minimalOf(w);
        return this.fail(
          'missing-required-field',
          [...path, { kind: 'field', id: rf.id, name: rf.name }],
          `reader requires field #${rf.id} ('${rf.name}') but a legal writer message may omit it`,
          counterexample,
        );
      }
    }
    return { ok: true };
  }

  private checkUnion(
    w: Type & { kind: 'union' },
    r: Type & { kind: 'union' },
    path: TypePath,
  ): CheckOutcome {
    const readerByTag = new Map(r.branches.map((b) => [b.tag, b]));
    for (const wb of w.branches) {
      const rb = readerByTag.get(wb.tag);
      if (!rb) {
        // The terminal value is the branch payload; buildAlong wraps it in
        // the union envelope while walking the type path.
        return this.fail(
          'unknown-union-tag',
          [...path, { kind: 'union-branch', tag: wb.tag }],
          `reader union has no branch tagged '${wb.tag}'`,
          this.minimalOf(wb.type),
        );
      }
      const outcome = this.check(wb.type, rb.type, [
        ...path,
        { kind: 'union-branch', tag: wb.tag },
      ]);
      if (!outcome.ok) return outcome;
    }
    return { ok: true };
  }

  private fail(
    reason: string,
    path: TypePath,
    message: string,
    counterexample: WireValue,
  ): CheckOutcome {
    return {
      ok: false,
      failure: { reason, path: [...path], counterexample },
    };
  }

  /**
   * Build a minimal finite wire value of a writer-side type using the
   * inhabitants computed during writer schema validation.
   */
  minimalOf(t: Type): WireValue {
    return minimalOf(this.writer, t);
  }
}

function pairKey(w: Type, r: Type): string {
  return `${nodeId(w)}->${nodeId(r)}`;
}

let nextNodeId = 1;
const nodeIds = new WeakMap<object, number>();

function nodeId(t: Type): number {
  let id = nodeIds.get(t);
  if (id === undefined) {
    id = nextNodeId++;
    nodeIds.set(t, id);
  }
  return id;
}

/**
 * Numeric promotion rule: valid iff every value of the writer domain is
 * losslessly representable in the reader domain.
 *
 *   i32 -> i32, i32 -> i64, i32 -> f64   (all 2^32 values exact as f64)
 *   i64 -> i64                            (f64 cannot hold all 2^64 values)
 *   f64 -> f64
 * Everything else (including i64 -> f64 and f64 -> integer kinds) is rejected.
 */
export function numericLossless(
  writerKind: Type['kind'],
  readerKind: Type['kind'],
): boolean {
  if (writerKind === readerKind) return true;
  if (writerKind === 'i32' && (readerKind === 'i64' || readerKind === 'f64')) {
    return true;
  }
  return false;
}

export function minimalOf(vs: ValidatedSchema, t: Type): WireValue {
  switch (t.kind) {
    case 'bool':
      return false;
    case 'string':
      return '';
    case 'i32':
      return 0;
    case 'i64':
      return 0n;
    case 'f64':
      return 0;
    case 'array':
      return [];
    case 'ref':
      return vs.samples.get(t.name) as WireValue;
    case 'record': {
      const out: Record<string, WireValue> = {};
      for (const f of t.fields) {
        if (f.hasDefault) continue;
        out[String(f.id)] = minimalOf(vs, f.type);
      }
      return out;
    }
    case 'union': {
      const branch = t.branches[0];
      return { tag: branch.tag, value: minimalOf(vs, branch.type) };
    }
  }
}

/**
 * Given the writer type at which a mismatch was found and the static type
 * path to it, construct a finite wire message of the writer root that reaches
 * the mismatch. Every non-terminal step is filled with minimal values, so the
 * resulting message is guaranteed encodable and finite, including for
 * recursive named types (references resolve to precomputed finite samples).
 */
export function buildCounterexample(
  vs: ValidatedSchema,
  root: Type,
  path: TypePath,
  terminalValue: WireValue,
): WireValue {
  const steps = path.filter((s) => s.kind !== 'root');
  return buildAlong(vs, root, steps, 0, terminalValue);
}

function buildAlong(
  vs: ValidatedSchema,
  t: Type,
  steps: TypePath,
  index: number,
  terminalValue: WireValue,
): WireValue {
  if (t.kind === 'ref') {
    return buildAlong(vs, vs.schema.types[t.name], steps, index, terminalValue);
  }
  const step = steps[index];
  if (!step) return terminalValue;

  switch (step.kind) {
    case 'array-item': {
      const at = t as Type & { kind: 'array' };
      const inner = buildAlong(vs, at.items, steps, index + 1, terminalValue);
      const arr: WireValue[] = [];
      for (let i = 0; i < step.index; i++) arr.push(minimalOf(vs, at.items));
      arr.push(inner);
      return arr;
    }
    case 'field': {
      const rt = t as Type & { kind: 'record' };
      const out: Record<string, WireValue> = {};
      for (const f of rt.fields) {
        if (f.hasDefault) continue;
        if (f.id === step.id) {
          out[String(f.id)] = buildAlong(
            vs,
            f.type,
            steps,
            index + 1,
            terminalValue,
          );
        } else {
          out[String(f.id)] = minimalOf(vs, f.type);
        }
      }
      return out;
    }
    case 'union-branch': {
      const ut = t as Type & { kind: 'union' };
      const branch = ut.branches.find((b) => b.tag === step.tag);
      if (!branch) {
        // Terminal unknown-tag position: wrap the (already built) payload.
        return { tag: step.tag, value: terminalValue };
      }
      return {
        tag: branch.tag,
        value: buildAlong(vs, branch.type, steps, index + 1, terminalValue),
      };
    }
    case 'root':
      return buildAlong(vs, t, steps, index + 1, terminalValue);
  }
}

export { F64_EXACT_INT_MAX, F64_EXACT_INT_MIN } from './types.ts';
