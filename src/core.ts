/**
 * Negotiation driver.
 *
 * Satisfiability splits into two independent dimensions:
 *   (a) there is a protocol version accepted by every party, and
 *   (b) there is a feature assignment satisfying every support / required /
 *       custom rule.
 * A solution exists iff both hold, so an unsatisfiable core lies wholly in one
 * dimension (a protocol core or a feature core). The driver relies on that:
 * it intersects protocols first, then optimizes features by benefit.
 *
 * Every search is an explicit stack machine advanced one unit at a time,
 * which makes step budgets and serialized progress exact and replayable.
 *
 * Determinism, in priority order:
 *   1. maximize total benefit of selected features,
 *   2. among optima, smallest ascending feature-id list (a proper prefix wins),
 *   3. protocol version is the smallest version accepted by all parties.
 */

import type {
  CoreConstraint,
  FeatureId,
  NegotiationOutcome,
  NegotiationSuccess,
  NegotiationUnsatisfiable,
  NegotiationUndetermined,
  Offer,
  PartyCertificate,
  ProtocolVersion,
  RemovalWitness,
  SearchProgress,
  SearchSummary,
  SolveOptions,
  Witness,
} from './types.ts';
import { evaluate } from './eval.ts';
import {
  buildProblem,
  commonProtocols,
  maskFromString,
  maskToString,
  toCoreConstraint,
  type Problem,
} from './problem.ts';
import { normalizeRequest, type NormalizedRequest } from './normalize.ts';
import {
  advanceOptimize,
  advanceSat,
  buildSpace,
  createOptimizeState,
  createSatState,
  selectedFeatures,
  type OptimizeState,
  type SatState,
} from './search.ts';
import {
  InvalidProgressError,
  NegotiationInputError,
  StaleProgressError,
} from './errors.ts';

const PROGRESS_TOKEN = 'capability-negotiation/progress@1' as const;
export const DEFAULT_MAX_STEPS = 200_000;

/* -------------------------------------------------------------------------- */
/* Public entry points                                                        */
/* -------------------------------------------------------------------------- */

/** Negotiate over one offer per party. */
export function negotiate(
  offers: readonly Offer[],
  benefits: Readonly<Record<FeatureId, number>>,
  options: SolveOptions = {},
): NegotiationOutcome {
  return solveNormalized(normalizeRequest(offers, benefits), options);
}

/** Solve a request that was already normalized (used by sessions). */
export function solveNormalized(
  request: NormalizedRequest,
  options: SolveOptions = {},
): NegotiationOutcome {
  const maxSteps = normalizeBudget(options.maxSteps);
  const problem = buildProblem(request);
  let resume = options.resume;
  if (resume !== undefined) {
    // Always validate the envelope first, so malformed tokens report precisely
    // and cannot be mistaken for merely stale ones.
    validateProgressEnvelope(resume);
    if (resume.snapshot !== problem.request.snapshot) {
      if (options.staleProgress === 'restart') {
        resume = undefined;
      } else {
        throw new StaleProgressError(resume.snapshot, problem.request.snapshot);
      }
    }
  }
  const resumed = resume !== undefined;

  const state: DriverState =
    resume !== undefined ? restoreProgress(problem, resume) : initialState(problem);

  let spent = 0;
  while (true) {
    if (state.phase === 'optimize') {
      const optimize = state.optimize!;
      if (!optimize.done) {
        if (spent >= maxSteps) break;
        advanceOptimize(problem, optimize);
        state.explored += 1;
        spent += 1;
        continue;
      }
      if (optimize.bestFeatures !== null) {
        return buildSuccess(problem, optimize.bestFeatures, optimize.bestBenefit ?? 0, {
          explored: state.explored,
          exhaustedBudget: false,
          resumed,
          phase: 'complete',
        });
      }
      // Feature dimension unsatisfiable: diagnose it.
      state.phase = 'core';
      state.optimize = null;
      state.mus = createMus(problem, 'feature');
      continue;
    }

    const mus = state.mus!;
    if (!mus.done) {
      if (spent >= maxSteps) break;
      const nodes = stepMus(problem, mus);
      state.explored += nodes;
      spent += nodes;
      continue;
    }
    return buildUnsat(problem, mus, {
      explored: state.explored,
      exhaustedBudget: false,
      resumed,
      phase: 'complete',
    });
  }

  // Budget exhausted before a decision: hand back exact continuation state.
  return buildUndetermined(problem, serializeProgress(problem, state), {
    explored: state.explored,
    exhaustedBudget: true,
    resumed,
    phase: state.phase === 'optimize' ? 'optimize' : 'unsatisfiable-core',
  });
}

function normalizeBudget(maxSteps: number | undefined): number {
  if (maxSteps === undefined) return DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new NegotiationInputError('maxSteps must be a positive integer when provided.');
  }
  return maxSteps;
}

/* -------------------------------------------------------------------------- */
/* Driver state                                                               */
/* -------------------------------------------------------------------------- */

type Phase = 'optimize' | 'core';
type Dimension = 'protocol' | 'feature';

interface DriverState {
  phase: Phase;
  explored: number;
  optimize: OptimizeState | null;
  mus: MusState | null;
}

interface PendingCheck {
  readonly subset: readonly string[];
  readonly testedId: string;
  readonly protocolVersion: ProtocolVersion | null;
  readonly sat: SatState | null;
  readonly satisfiable: boolean | null;
  readonly witness: Witness | null;
}

interface MusState {
  readonly dimension: Dimension;
  readonly ruleOrder: readonly string[];
  current: Set<string>;
  cursor: number;
  readonly witnesses: Map<string, Witness>;
  check: PendingCheck | null;
  done: boolean;
  core: string[] | null;
}

function initialState(problem: Problem): DriverState {
  const allRuleIds = new Set(problem.ruleIds);
  if (commonProtocols(problem, allRuleIds).length === 0) {
    return { phase: 'core', explored: 0, optimize: null, mus: createMus(problem, 'protocol') };
  }
  const featureSpace = buildSpace(
    problem,
    new Set(problem.featureRules.map((rule) => rule.id)),
    problem.request.featureUniverse,
  );
  return {
    phase: 'optimize',
    explored: 0,
    optimize: createOptimizeState(problem, featureSpace),
    mus: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Minimal unsatisfiable core (deletion based)                                */
/* -------------------------------------------------------------------------- */

function createMus(problem: Problem, dimension: Dimension): MusState {
  const ruleOrder = (
    dimension === 'protocol'
      ? problem.protocolRules.map((rule) => rule.id)
      : problem.featureRules.map((rule) => rule.id)
  )
    .slice()
    .sort();
  return {
    dimension,
    ruleOrder,
    current: new Set(ruleOrder),
    cursor: 0,
    witnesses: new Map(),
    check: null,
    done: false,
    core: null,
  };
}

/**
 * Advance the deletion loop by one budgeted unit, returning nodes consumed.
 *
 * Invariant: `current` starts as the full dimension and is always
 * unsatisfiable. For each candidate id, test `current \ {id}`:
 *  - satisfiable  -> id is necessary; keep it and remember a witness,
 *  - unsatisfiable -> id is redundant; drop it.
 * Later test sets only shrink, so a witness for a larger satisfiable set also
 * satisfies the final core minus that constraint.
 */
function stepMus(problem: Problem, mus: MusState): number {
  if (mus.check !== null) {
    return advanceCheck(problem, mus);
  }

  if (mus.cursor < mus.ruleOrder.length) {
    const testedId = mus.ruleOrder[mus.cursor];
    if (!mus.current.has(testedId)) {
      mus.cursor += 1;
      return 0;
    }
    const subset = mus.ruleOrder.filter((id) => id !== testedId && mus.current.has(id));
    mus.check = startCheck(problem, mus.dimension, subset, testedId);
    return 1;
  }

  mus.done = true;
  mus.core = mus.ruleOrder.filter((id) => mus.current.has(id));
  return 1;
}

function advanceCheck(problem: Problem, mus: MusState): number {
  const pending = mus.check!;
  if (pending.satisfiable !== null) {
    applyCheck(mus);
    return 0;
  }
  const sat = pending.sat;
  if (sat === null) {
    mus.check = { ...pending, satisfiable: false, witness: null };
    return 0;
  }
  const verdict = advanceSat(sat);
  if (verdict === 'found') {
    mus.check = {
      ...pending,
      satisfiable: true,
      witness: {
        protocolVersion: pending.protocolVersion!,
        features: selectedFeatures(problem, sat.foundMask ?? 0n),
      },
    };
  } else if (verdict === 'unsat') {
    mus.check = { ...pending, satisfiable: false, witness: null };
  }
  return 1;
}

function startCheck(
  problem: Problem,
  dimension: Dimension,
  subset: readonly string[],
  testedId: string,
): PendingCheck {
  const protocols = commonProtocols(problem, new Set(subset));

  if (dimension === 'protocol') {
    if (protocols.length === 0) {
      return {
        subset,
        testedId,
        protocolVersion: null,
        sat: null,
        satisfiable: false,
        witness: null,
      };
    }
    return {
      subset,
      testedId,
      protocolVersion: protocols[0],
      sat: null,
      satisfiable: true,
      witness: { protocolVersion: protocols[0], features: [] },
    };
  }

  const globalProtocols = commonProtocols(problem, new Set(problem.ruleIds));
  if (globalProtocols.length === 0) {
    throw new Error('Feature core requested although no common protocol exists.');
  }
  return {
    subset,
    testedId,
    protocolVersion: globalProtocols[0],
    sat: createSatState(buildSpace(problem, new Set(subset), problem.request.featureUniverse)),
    satisfiable: null,
    witness: null,
  };
}

function applyCheck(mus: MusState): void {
  const check = mus.check;
  if (check === null || check.satisfiable === null) {
    throw new Error('applyCheck called before the check was resolved.');
  }
  if (check.satisfiable) {
    mus.witnesses.set(check.testedId, check.witness!);
  } else {
    mus.current.delete(check.testedId);
  }
  mus.cursor += 1;
  mus.check = null;
}

/* -------------------------------------------------------------------------- */
/* Outcome construction                                                       */
/* -------------------------------------------------------------------------- */

function binding(problem: Problem) {
  return {
    offerVersions: problem.request.offerVersions,
    offersFingerprint: problem.request.snapshot,
  };
}

function buildSuccess(
  problem: Problem,
  features: readonly FeatureId[],
  totalBenefit: number,
  search: SearchSummary,
): NegotiationSuccess {
  const protocolVersion = commonProtocols(problem, new Set(problem.ruleIds))[0];
  if (protocolVersion === undefined) {
    throw new Error('Internal error: success without a common protocol.');
  }
  const mask = featureMask(problem, features);
  const selected = new Set(features);

  const parties: PartyCertificate[] = problem.request.offers.map((offer) => {
    const constraints = offer.constraints.map((constraint) => {
      if (!evaluate(constraint.expr, mask, problem.bits)) {
        throw new Error(
          `Internal error: ${offer.partyId}/${constraint.id} is violated by the solution.`,
        );
      }
      return {
        id: constraint.id,
        ...(constraint.description === undefined ? {} : { description: constraint.description }),
        expr: constraint.expr,
        satisfied: true as const,
      };
    });
    if (!features.every((feature) => offer.supportedFeatures.includes(feature))) {
      throw new Error(`Internal error: ${offer.partyId} does not support a selected feature.`);
    }
    if (!offer.requiredFeatures.every((feature) => selected.has(feature))) {
      throw new Error(`Internal error: ${offer.partyId} has an unsatisfied requirement.`);
    }
    return {
      partyId: offer.partyId,
      offerVersion: offer.offerVersion,
      protocolVersion,
      acceptedProtocolVersions: [...offer.protocolVersions],
      selectedFeatures: [...features],
      supportedFeatures: [...offer.supportedFeatures],
      requiredFeatures: [...offer.requiredFeatures],
      checks: {
        protocolAccepted: true as const,
        allSelectedFeaturesSupported: true as const,
        allRequiredFeaturesSelected: true as const,
        constraints,
      },
    };
  });

  const featureBenefits: Record<FeatureId, number> = {};
  for (const feature of problem.request.featureUniverse) {
    featureBenefits[feature] = problem.benefitOf(feature);
  }

  return {
    status: 'success',
    ...binding(problem),
    protocolVersion,
    features: [...features],
    totalBenefit,
    featureBenefits,
    parties,
    search,
  };
}

function featureMask(problem: Problem, features: readonly FeatureId[]): bigint {
  let mask = 0n;
  for (const feature of features) {
    const bit = problem.bits.get(feature);
    if (bit !== undefined) mask |= bit;
  }
  return mask;
}

function buildUnsat(
  problem: Problem,
  mus: MusState,
  search: SearchSummary,
): NegotiationUnsatisfiable {
  const coreIds = mus.core;
  if (coreIds === null || coreIds.length === 0) {
    throw new Error('Internal error: unsatisfiable outcome without a core.');
  }
  const core: CoreConstraint[] = coreIds.map((id) => {
    const rule = problem.ruleById.get(id);
    if (rule === undefined) throw new Error(`Internal error: unknown rule ${id}.`);
    return toCoreConstraint(rule);
  });
  const removalWitnesses: RemovalWitness[] = coreIds.map((id) => {
    const witness = mus.witnesses.get(id);
    if (witness === undefined) {
      throw new Error(`Internal error: no removal witness for ${id}.`);
    }
    return { removedConstraintId: id, witness };
  });
  return {
    status: 'unsatisfiable',
    ...binding(problem),
    core,
    removalWitnesses,
    search,
  };
}

function buildUndetermined(
  problem: Problem,
  progress: SearchProgress,
  search: SearchSummary,
): NegotiationUndetermined {
  return {
    status: 'undetermined',
    ...binding(problem),
    progress,
    search,
  };
}

/* -------------------------------------------------------------------------- */
/* Progress serialization / restore                                           */
/* -------------------------------------------------------------------------- */

function serializeProgress(problem: Problem, state: DriverState): SearchProgress {
  const optimize = state.optimize;
  const mus = state.mus;
  return {
    token: PROGRESS_TOKEN,
    snapshot: problem.request.snapshot,
    offerVersions: problem.request.offerVersions,
    explored: state.explored,
    phase: state.phase,
    optimize:
      optimize === null
        ? null
        : {
            stack: optimize.stack.map((frame) => ({
              depth: frame.depth,
              mask: maskToString(frame.mask),
              benefit: frame.benefit,
              nextBranch: frame.nextBranch,
            })),
            bestFeatures: optimize.bestFeatures === null ? null : [...optimize.bestFeatures],
            bestBenefit: optimize.bestBenefit,
            complete: optimize.done,
          },
    mus:
      mus === null
        ? null
        : {
            dimension: mus.dimension,
            ruleOrder: [...mus.ruleOrder],
            currentIds: mus.ruleOrder.filter((id) => mus.current.has(id)),
            cursor: mus.cursor,
            witnesses: [...mus.witnesses.entries()]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([removedConstraintId, witness]) => ({ removedConstraintId, witness })),
            check:
              mus.check === null
                ? null
                : {
                    subsetIds: [...mus.check.subset],
                    testedId: mus.check.testedId,
                    protocolVersion: mus.check.protocolVersion,
                    sat:
                      mus.check.sat === null
                        ? null
                        : {
                            stack: mus.check.sat.stack.map((frame) => ({
                              depth: frame.depth,
                              mask: maskToString(frame.mask),
                              branch: frame.branch,
                            })),
                            foundFeatures:
                              mus.check.sat.foundMask === null
                                ? null
                                : selectedFeatures(problem, mus.check.sat.foundMask),
                            complete: mus.check.sat.done,
                          },
                    satisfiable: mus.check.satisfiable,
                    witness: mus.check.witness,
                  },
            complete: mus.done,
            coreIds: mus.core === null ? null : [...mus.core],
          },
  };
}

function restoreProgress(problem: Problem, progress: SearchProgress): DriverState {
  validateProgressEnvelope(progress);
  if (progress.snapshot !== problem.request.snapshot) {
    throw new StaleProgressError(progress.snapshot, problem.request.snapshot);
  }
  validateProgressAgainstProblem(problem, progress);
  if (progress.phase === 'optimize') {
    const optimize = progress.optimize!;
    const space = buildSpace(
      problem,
      new Set(problem.featureRules.map((rule) => rule.id)),
      problem.request.featureUniverse,
    );
    const state = createOptimizeState(problem, space);
    state.stack.length = 0;
    for (const frame of optimize.stack) {
      state.stack.push({
        depth: frame.depth,
        mask: maskFromString(frame.mask),
        benefit: frame.benefit,
        nextBranch: frame.nextBranch,
      });
    }
    state.bestFeatures = optimize.bestFeatures === null ? null : [...optimize.bestFeatures];
    state.bestBenefit = optimize.bestBenefit;
    state.done = optimize.complete;
    return { phase: 'optimize', explored: progress.explored, optimize: state, mus: null };
  }

  const serialized = progress.mus!;
  const mus: MusState = {
    dimension: serialized.dimension,
    ruleOrder: [...serialized.ruleOrder],
    current: new Set(serialized.currentIds),
    cursor: serialized.cursor,
    witnesses: new Map(serialized.witnesses.map((w) => [w.removedConstraintId, w.witness])),
    check: null,
    done: serialized.complete,
    core: serialized.coreIds === null ? null : [...serialized.coreIds],
  };

  if (serialized.check !== null) {
    const check = serialized.check;
    let sat: SatState | null = null;
    if (check.sat !== null) {
      sat = createSatState(buildSpace(problem, new Set(check.subsetIds), problem.request.featureUniverse));
      sat.stack.length = 0;
      for (const frame of check.sat.stack) {
        sat.stack.push({
          depth: frame.depth,
          mask: maskFromString(frame.mask),
          branch: frame.branch,
        });
      }
      sat.foundMask = null;
      sat.done = check.sat.complete;
    }
    mus.check = {
      subset: [...check.subsetIds],
      testedId: check.testedId,
      protocolVersion: check.protocolVersion,
      sat,
      satisfiable: check.satisfiable,
      witness: check.witness,
    };
  }

  return { phase: 'core', explored: progress.explored, optimize: null, mus };
}

function validateProgressEnvelope(progress: SearchProgress): void {
  if (progress === null || typeof progress !== 'object') {
    throw new InvalidProgressError('resume must be a progress object.');
  }
  if (progress.token !== PROGRESS_TOKEN) {
    throw new InvalidProgressError(
      `Unknown progress token ${JSON.stringify((progress as { token?: unknown }).token)}.`,
    );
  }
  if (typeof progress.snapshot !== 'string' || !/^[0-9a-f]{64}$/.test(progress.snapshot)) {
    throw new InvalidProgressError('progress.snapshot must be a 64-char hex digest.');
  }
  if (!Number.isInteger(progress.explored) || progress.explored < 0) {
    throw new InvalidProgressError('progress.explored must be a non-negative integer.');
  }
  if (progress.phase !== 'optimize' && progress.phase !== 'core') {
    throw new InvalidProgressError(`Unknown progress phase ${JSON.stringify(progress.phase)}.`);
  }
  if (progress.phase === 'optimize' && progress.optimize === null) {
    throw new InvalidProgressError('Optimize-phase progress is missing its optimize state.');
  }
  if (progress.phase === 'core' && progress.mus === null) {
    throw new InvalidProgressError('Core-phase progress is missing its MUS state.');
  }
}

function validateProgressAgainstProblem(problem: Problem, progress: SearchProgress): void {
  const checkMask = (mask: unknown, where: string): void => {
    if (typeof mask !== 'string' || !/^[0-9a-f]+$/.test(mask)) {
      throw new InvalidProgressError(`${where}: mask must be a lowercase hex string.`);
    }
  };
  if (progress.optimize !== null) {
    for (const frame of progress.optimize.stack) checkMask(frame.mask, 'optimize frame');
  }
  if (progress.mus !== null) {
    for (const id of progress.mus.ruleOrder) {
      if (!problem.ruleById.has(id)) {
        throw new InvalidProgressError(`Progress references unknown constraint ${JSON.stringify(id)}.`);
      }
    }
    for (const proven of progress.mus.witnesses) {
      if (!problem.ruleById.has(proven.removedConstraintId)) {
        throw new InvalidProgressError(
          `Progress witness references unknown constraint ${JSON.stringify(proven.removedConstraintId)}.`,
        );
      }
    }
    if (progress.mus.check !== null) {
      for (const id of progress.mus.check.subsetIds) {
        if (!problem.ruleById.has(id)) {
          throw new InvalidProgressError(
            `Progress check references unknown constraint ${JSON.stringify(id)}.`,
          );
        }
      }
      if (progress.mus.check.sat !== null) {
        for (const frame of progress.mus.check.sat.stack) checkMask(frame.mask, 'sat frame');
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Internals exposed for tests and verification                               */
/* -------------------------------------------------------------------------- */

/** Compile raw offers into a problem (for advanced integrations and tests). */
export function buildProblemForTest(
  offers: readonly Offer[],
  benefits: Readonly<Record<FeatureId, number>>,
): Problem {
  return buildProblem(normalizeRequest(offers, benefits));
}

export type { Problem } from './problem.ts';
