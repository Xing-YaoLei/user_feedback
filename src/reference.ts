/**
 * Deliberately independent brute-force reference solver.
 *
 * It shares no search code with `core.ts`: it works on raw offers, evaluates
 * expressions with its own recursive interpreter, and enumerates the full
 * (protocol x feature-subset) space. Tests use it to cross-check optimality
 * and core diagnoses on small instances.
 */

import type {
  CoreConstraint,
  Expr,
  FeatureId,
  Offer,
  ProtocolVersion,
  Witness,
} from './types.ts';
import { compareIds } from './normalize.ts';

export interface ReferenceSolution {
  readonly protocolVersion: ProtocolVersion;
  readonly features: readonly FeatureId[];
  readonly totalBenefit: number;
}

export interface ReferenceResult {
  readonly satisfiable: boolean;
  readonly solution: ReferenceSolution | null;
  /** Number of (protocol, subset) combinations examined. */
  readonly examined: number;
}

/* -------------------------------------------------------------------------- */
/* Raw-offer evaluation                                                       */
/* -------------------------------------------------------------------------- */

function evalRaw(expr: Expr, on: ReadonlySet<FeatureId>): boolean {
  switch (expr.op) {
    case 'feature':
      return on.has(expr.feature);
    case 'not':
      return !evalRaw(expr.arg, on);
    case 'and':
      return expr.args.every((arg) => evalRaw(arg, on));
    case 'or':
      return expr.args.some((arg) => evalRaw(arg, on));
    case 'atMost':
      return expr.features.filter((f) => on.has(f)).length <= expr.count;
    case 'atLeast':
      return expr.features.filter((f) => on.has(f)).length >= expr.count;
    case 'exactly':
      return expr.features.filter((f) => on.has(f)).length === expr.count;
  }
}

export function rawUniverse(offers: readonly Offer[]): FeatureId[] {
  const set = new Set<FeatureId>();
  const visit = (expr: Expr): void => {
    switch (expr.op) {
      case 'feature':
        set.add(expr.feature);
        break;
      case 'not':
        visit(expr.arg);
        break;
      case 'and':
      case 'or':
        expr.args.forEach(visit);
        break;
      case 'atMost':
      case 'atLeast':
      case 'exactly':
        expr.features.forEach((f) => set.add(f));
        break;
    }
  };
  for (const offer of offers) {
    offer.supportedFeatures.forEach((f) => set.add(f));
    (offer.requiredFeatures ?? []).forEach((f) => set.add(f));
    (offer.constraints ?? []).forEach((c) => visit(c.expr));
  }
  return [...set].sort(compareIds);
}

function rawBenefits(
  universe: readonly FeatureId[],
  benefits: Readonly<Record<FeatureId, number>>,
): Map<FeatureId, number> {
  return new Map(universe.map((f) => [f, benefits[f] ?? 0] as const));
}

function partyAcceptsProtocols(offers: readonly Offer[], version: ProtocolVersion): boolean {
  return offers.every((offer) => offer.protocolVersions.includes(version));
}

function partyAllows(
  offer: Offer,
  selected: ReadonlySet<FeatureId>,
): boolean {
  for (const feature of selected) {
    if (!offer.supportedFeatures.includes(feature)) return false;
  }
  for (const feature of offer.requiredFeatures ?? []) {
    if (!selected.has(feature)) return false;
  }
  for (const constraint of offer.constraints ?? []) {
    if (!evalRaw(constraint.expr, selected)) return false;
  }
  return true;
}

/** Does a concrete assignment satisfy every offer? */
export function referenceAssignmentSatisfies(
  offers: readonly Offer[],
  protocolVersion: ProtocolVersion,
  features: readonly FeatureId[],
): boolean {
  if (!partyAcceptsProtocols(offers, protocolVersion)) return false;
  const selected = new Set(features);
  return offers.every((offer) => partyAllows(offer, selected));
}

/** Lexicographically smallest ascending feature-id list wins ties. */
export function referenceTieBreak(a: readonly FeatureId[], b: readonly FeatureId[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const delta = compareIds(a[i], b[i]);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

/**
 * Exhaustively enumerate protocols and feature subsets, returning the
 * benefit-maximal assignment with the reference tie-break. Intended for small
 * universes (<= 20 features) in tests.
 */
export function referenceSolve(
  offers: readonly Offer[],
  benefits: Readonly<Record<FeatureId, number>>,
): ReferenceResult {
  if (offers.length === 0) throw new Error('referenceSolve requires offers.');
  const universe = rawUniverse(offers);
  if (universe.length > 24) {
    throw new Error(`referenceSolve enumeration limit exceeded (${universe.length} features).`);
  }
  const benefitOf = rawBenefits(universe, benefits);
  const protocols = [...new Set(offers.flatMap((offer) => offer.protocolVersions))].sort(compareIds);

  let examined = 0;
  let best: ReferenceSolution | null = null;

  for (const protocolVersion of protocols) {
    if (!partyAcceptsProtocols(offers, protocolVersion)) {
      examined += 1;
      continue;
    }
    for (let raw = 0; raw < 1 << universe.length; raw++) {
      examined += 1;
      const features: FeatureId[] = [];
      for (let i = 0; i < universe.length; i++) {
        if ((raw & (1 << i)) !== 0) features.push(universe[i]);
      }
      const selected = new Set(features);
      if (!offers.every((offer) => partyAllows(offer, selected))) continue;
      let totalBenefit = 0;
      for (const feature of features) totalBenefit += benefitOf.get(feature) ?? 0;
      const candidate: ReferenceSolution = { protocolVersion, features, totalBenefit };
      if (best === null) {
        best = candidate;
        continue;
      }
      if (totalBenefit > best.totalBenefit) {
        best = candidate;
      } else if (totalBenefit === best.totalBenefit) {
        // Prefer smaller protocol, then lexicographic feature tie-break.
        const protoDelta = compareIds(protocolVersion, best.protocolVersion);
        if (protoDelta < 0) {
          best = candidate;
        } else if (protoDelta === 0 && referenceTieBreak(features, best.features) < 0) {
          best = candidate;
        }
      }
    }
  }

  return { satisfiable: best !== null, solution: best, examined };
}

/* -------------------------------------------------------------------------- */
/* Core verification by enumeration                                           */
/* -------------------------------------------------------------------------- */

const coreEval = (entry: CoreConstraint, protocolVersion: ProtocolVersion, on: ReadonlySet<FeatureId>): boolean => {
  switch (entry.kind) {
    case 'protocol':
      return entry.protocolVersions?.includes(protocolVersion) ?? false;
    case 'support':
      return entry.feature !== undefined && !on.has(entry.feature);
    case 'required':
      return entry.feature !== undefined && on.has(entry.feature);
    case 'custom':
      return entry.expr !== undefined && evalRaw(entry.expr, on);
  }
};

export interface CoreCheck {
  readonly satisfiable: boolean;
  readonly witness: Witness | null;
  readonly removedId?: string;
}

function coreFeatures(core: readonly CoreConstraint[]): FeatureId[] {
  const set = new Set<FeatureId>();
  const visit = (expr: Expr): void => {
    switch (expr.op) {
      case 'feature':
        set.add(expr.feature);
        break;
      case 'not':
        visit(expr.arg);
        break;
      case 'and':
      case 'or':
        expr.args.forEach(visit);
        break;
      case 'atMost':
      case 'atLeast':
      case 'exactly':
        expr.features.forEach((f) => set.add(f));
        break;
    }
  };
  for (const entry of core) {
    if (entry.feature !== undefined) set.add(entry.feature);
    if (entry.expr !== undefined) visit(entry.expr);
  }
  return [...set].sort(compareIds);
}

/**
 * Enumerate protocol x feature assignments for a core (or core minus one
 * member). Protocols considered are the union of protocol versions mentioned
 * by the core; when the core has no protocol entry, a single symbolic
 * sentinel `'*'` is used because protocols are then unconstrained.
 */
export function checkCore(core: readonly CoreConstraint[], removeId?: string): CoreCheck {
  const active = core.filter((entry) => entry.id !== removeId);
  const features = coreFeatures(active);
  if (features.length > 20) {
    throw new Error(`checkCore enumeration limit exceeded (${features.length} features).`);
  }
  const protocolVersions = [
    ...new Set(
      active.flatMap((entry) =>
        entry.kind === 'protocol' ? (entry.protocolVersions ?? []) : [],
      ),
    ),
  ].sort(compareIds);
  const protocols = protocolVersions.length > 0 ? protocolVersions : ['*'];

  for (const protocolVersion of protocols) {
    for (let raw = 0; raw < 1 << features.length; raw++) {
      const on = new Set<FeatureId>();
      for (let i = 0; i < features.length; i++) {
        if ((raw & (1 << i)) !== 0) on.add(features[i]);
      }
      if (active.every((entry) => coreEval(entry, protocolVersion, on))) {
        return {
          satisfiable: true,
          witness: { protocolVersion, features: [...on].sort(compareIds) },
        };
      }
    }
  }
  return { satisfiable: false, witness: null };
}

/** True iff the core is unsatisfiable. */
export function coreIsUnsatisfiable(core: readonly CoreConstraint[]): boolean {
  return !checkCore(core).satisfiable;
}

/** Every core minus one member must be satisfiable. */
export function coreIsMinimal(core: readonly CoreConstraint[]): boolean {
  return core.every((entry) => checkCore(core, entry.id).satisfiable);
}

/**
 * Check that a witness satisfies every core member except `removedId`.
 * Protocol-witnesses use '*' when no protocol entry is present, so treat that
 * sentinel as "any protocol".
 */
export function witnessSatisfiesCoreMinus(
  core: readonly CoreConstraint[],
  removedId: string,
  witness: Witness,
): boolean {
  const on = new Set(witness.features);
  return core.every((entry) => {
    if (entry.id === removedId) return true;
    if (entry.kind === 'protocol') {
      return entry.protocolVersions?.includes(witness.protocolVersion) ?? false;
    }
    return coreEval(entry, witness.protocolVersion, on);
  });
}
