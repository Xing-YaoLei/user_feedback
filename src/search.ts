/**
 * Resumable search engines.
 *
 * Both engines are explicit-stack depth-first searches whose entire live state
 * is plain data (frames, masks, incumbents). `advanceOptimize` /
 * `advanceSat` each perform exactly one node of work, so a caller can stop
 * between nodes, serialize the state, and later continue without redoing work
 * or changing the answer.
 */

import type { Expr, FeatureId } from './types.ts';
import { FALSE, evaluatePartial } from './eval.ts';
import type { Problem } from './problem.ts';
import { compareIds } from './normalize.ts';

/* -------------------------------------------------------------------------- */
/* Decision space                                                             */
/* -------------------------------------------------------------------------- */

export interface DecisionSpace {
  /** Features considered, in decision order; all others are fixed false. */
  readonly order: readonly FeatureId[];
  /** Bits of features at positions >= depth (suffix OR). */
  readonly undecided: readonly bigint[];
  /** Expressions that must all hold. */
  readonly expressions: readonly Expr[];
  readonly bits: ReadonlyMap<FeatureId, bigint>;
}

/**
 * Build a decision space for a constraint subset. Features vetoed by a support
 * rule inside the subset are fixed false; every other feature of `universe`
 * is a decision. This is exact: a support rule is equivalent to its feature
 * being unavailable, and all remaining rules are ordinary expressions.
 */
export function buildSpace(
  problem: Problem,
  subset: ReadonlySet<string>,
  universe: readonly FeatureId[],
): DecisionSpace {
  const forbidden = new Set<FeatureId>();
  const expressions: Expr[] = [];
  for (const rule of problem.featureRules) {
    if (!subset.has(rule.id)) continue;
    expressions.push(rule.expr);
    if (rule.kind === 'support' && rule.expr.op === 'not' && rule.expr.arg.op === 'feature') {
      forbidden.add(rule.expr.arg.feature);
    }
  }
  const order = universe
    .filter((feature) => !forbidden.has(feature))
    .sort((a, b) => {
      const delta = problem.benefitOf(b) - problem.benefitOf(a);
      return delta !== 0 ? delta : compareIds(a, b);
    });
  const undecided = new Array<bigint>(order.length + 1).fill(0n);
  for (let i = order.length - 1; i >= 0; i--) {
    undecided[i] = undecided[i + 1] | problem.bits.get(order[i])!;
  }
  return { order, undecided, expressions, bits: problem.bits };
}

/** True unless some expression is already definitely false. */
export function partialFeasible(space: DecisionSpace, mask: bigint, depth: number): boolean {
  const undecided = space.undecided[depth];
  for (const expr of space.expressions) {
    if (evaluatePartial(expr, mask, undecided, space.bits) === FALSE) return false;
  }
  return true;
}

/** True when every expression holds under a complete assignment. */
export function fullySatisfies(space: DecisionSpace, mask: bigint): boolean {
  for (const expr of space.expressions) {
    if (evaluatePartial(expr, mask, 0n, space.bits) !== 1) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Optimizer: maximize benefit, then lexicographically smallest feature set   */
/* -------------------------------------------------------------------------- */

export interface OptimizeFrame {
  depth: number;
  mask: bigint;
  benefit: number;
  /** 0 = include pending, 1 = exclude pending, 2 = both done. */
  nextBranch: 0 | 1 | 2;
}

export interface OptimizeState {
  space: DecisionSpace;
  stack: OptimizeFrame[];
  bestFeatures: FeatureId[] | null;
  bestBenefit: number | null;
  suffixPositive: number[];
  done: boolean;
}

export function createOptimizeState(problem: Problem, space: DecisionSpace): OptimizeState {
  const suffixPositive = new Array<number>(space.order.length + 1).fill(0);
  for (let i = space.order.length - 1; i >= 0; i--) {
    suffixPositive[i] = suffixPositive[i + 1] + Math.max(0, problem.benefitOf(space.order[i]));
  }
  return {
    space,
    stack: [{ depth: 0, mask: 0n, benefit: 0, nextBranch: 0 }],
    bestFeatures: null,
    bestBenefit: null,
    suffixPositive,
    done: false,
  };
}

/**
 * Perform exactly one unit of search and return what happened.
 *
 * Pruning is sound: a branch is cut only when even the optimistic upper bound
 * (current benefit + all remaining positive benefits) is strictly below the
 * incumbent. Equal bounds are explored so the lexicographic tie-break is
 * exact. Branch order only affects speed; the accepted optimum is unique and
 * independent of it.
 */
export function advanceOptimize(problem: Problem, state: OptimizeState): 'node' | 'leaf' | 'done' {
  const { space } = state;
  const n = space.order.length;

  while (state.stack.length > 0) {
    const frame = state.stack[state.stack.length - 1];

    if (frame.depth === n) {
      state.stack.pop();
      if (fullySatisfies(space, frame.mask)) {
        consider(problem, state, frame.mask, frame.benefit);
        return 'leaf';
      }
      return 'node';
    }

    if (frame.nextBranch >= 2) {
      state.stack.pop();
      return 'node';
    }

    const feature = space.order[frame.depth];
    const featureBenefit = problem.benefitOf(feature);
    // Try the promising side first: include positive features, exclude
    // negative ones. This does not change the final optimum.
    const includeFirst = featureBenefit >= 0;
    const branch = frame.nextBranch;
    frame.nextBranch = (frame.nextBranch + 1) as 1 | 2;
    const bit = space.bits.get(feature)!;
    const depth = frame.depth + 1;
    const takeInclude = includeFirst ? branch === 0 : branch === 1;

    if (takeInclude) {
      const mask = frame.mask | bit;
      const benefit = frame.benefit + featureBenefit;
      if (partialFeasible(space, mask, depth) && !boundPrunes(state, benefit, depth)) {
        state.stack.push({ depth, mask, benefit, nextBranch: 0 });
      }
      return 'node';
    }

    if (!boundPrunes(state, frame.benefit, depth)) {
      state.stack.push({ depth, mask: frame.mask, benefit: frame.benefit, nextBranch: 0 });
    }
    return 'node';
  }

  state.done = true;
  return 'done';
}

function boundPrunes(state: OptimizeState, benefit: number, depth: number): boolean {
  if (state.bestBenefit === null) return false;
  return benefit + state.suffixPositive[depth] < state.bestBenefit;
}

function consider(problem: Problem, state: OptimizeState, mask: bigint, benefit: number): void {
  const features = selectedFeatures(problem, mask);
  if (state.bestBenefit === null || benefit > state.bestBenefit) {
    state.bestBenefit = benefit;
    state.bestFeatures = features;
    return;
  }
  if (benefit === state.bestBenefit && state.bestFeatures !== null) {
    if (compareFeatureSets(features, state.bestFeatures) < 0) {
      state.bestFeatures = features;
    }
  }
}

export function selectedFeatures(problem: Problem, mask: bigint): FeatureId[] {
  const out: FeatureId[] = [];
  for (const feature of problem.request.featureUniverse) {
    if ((mask & problem.bits.get(feature)!) !== 0n) out.push(feature);
  }
  return out;
}

/** Lexicographic comparison of ascending feature-id lists (shorter prefix first). */
export function compareFeatureSets(a: readonly string[], b: readonly string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const delta = compareIds(a[i], b[i]);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

/* -------------------------------------------------------------------------- */
/* Satisfiability                                                             */
/* -------------------------------------------------------------------------- */

export interface SatFrame {
  depth: number;
  mask: bigint;
  /** 0 = exclude pending, 1 = include pending, 2 = done. */
  branch: 0 | 1 | 2;
}

export interface SatState {
  space: DecisionSpace;
  stack: SatFrame[];
  foundMask: bigint | null;
  done: boolean;
}

export function createSatState(space: DecisionSpace): SatState {
  return {
    space,
    stack: [{ depth: 0, mask: 0n, branch: 0 }],
    foundMask: null,
    done: false,
  };
}

/**
 * Perform exactly one unit of SAT search. Exclude-before-include yields a
 * deterministic witness when several assignments exist.
 */
export function advanceSat(state: SatState): 'node' | 'found' | 'unsat' {
  const { space } = state;
  const n = space.order.length;

  while (state.stack.length > 0) {
    const frame = state.stack[state.stack.length - 1];

    if (frame.depth === n) {
      state.stack.pop();
      if (fullySatisfies(space, frame.mask)) {
        state.foundMask = frame.mask;
        state.done = true;
        return 'found';
      }
      return 'node';
    }

    if (frame.branch >= 2) {
      state.stack.pop();
      return 'node';
    }

    const branch = frame.branch;
    frame.branch = (frame.branch + 1) as 1 | 2;
    const feature = space.order[frame.depth];
    const bit = space.bits.get(feature)!;
    const depth = frame.depth + 1;

    if (branch === 0) {
      if (partialFeasible(space, frame.mask, depth)) {
        state.stack.push({ depth, mask: frame.mask, branch: 0 });
      }
      return 'node';
    }

    const mask = frame.mask | bit;
    if (partialFeasible(space, mask, depth)) {
      state.stack.push({ depth, mask, branch: 0 });
    }
    return 'node';
  }

  state.done = true;
  return 'unsat';
}
