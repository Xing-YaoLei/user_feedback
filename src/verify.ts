/**
 * Independent result verification.
 *
 * These functions re-derive every claim in an outcome from the original
 * offers, without reusing the search machinery. A caller (or test) can hand
 * an outcome to any other party for re-checking.
 */

import type {
  CoreConstraint,
  FeatureId,
  NegotiationSuccess,
  NegotiationUnsatisfiable,
  Offer,
  PartyCertificate,
  Witness,
} from './types.ts';
import { compareIds } from './normalize.ts';
import {
  checkCore,
  coreIsMinimal,
  coreIsUnsatisfiable,
  referenceAssignmentSatisfies,
  witnessSatisfiesCoreMinus,
} from './reference.ts';

export interface VerificationReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function report(errors: string[]): VerificationReport {
  return { ok: errors.length === 0, errors };
}

/**
 * Re-verify a success outcome against the offers that produced it:
 *  - the reported total benefit equals the sum of selected features,
 *  - every party certificate mirrors its offer and passes all checks,
 *  - the solution satisfies every party independently.
 */
export function verifySuccessOutcome(
  outcome: NegotiationSuccess,
  offers: readonly Offer[],
  benefits: Readonly<Record<FeatureId, number>>,
): VerificationReport {
  const errors: string[] = [];

  const featureSet = new Set(outcome.features);
  if (featureSet.size !== outcome.features.length) {
    errors.push('selected features contain duplicates');
  }
  const ascending = [...outcome.features].sort(compareIds);
  if (ascending.some((feature, i) => feature !== outcome.features[i])) {
    errors.push('selected features are not in ascending id order');
  }

  let sum = 0;
  for (const feature of outcome.features) {
    const expected = benefits[feature] ?? 0;
    if (outcome.featureBenefits[feature] !== expected) {
      errors.push(`benefit for ${feature} is ${outcome.featureBenefits[feature]}, expected ${expected}`);
    }
    sum += expected;
  }
  if (sum !== outcome.totalBenefit) {
    errors.push(`totalBenefit ${outcome.totalBenefit} != sum of selected ${sum}`);
  }

  const certificates = new Map(outcome.parties.map((party) => [party.partyId, party] as const));
  if (certificates.size !== offers.length) {
    errors.push('certificate count does not match offer count');
  }
  for (const offer of offers) {
    const certificate = certificates.get(offer.partyId);
    if (certificate === undefined) {
      errors.push(`missing certificate for ${offer.partyId}`);
      continue;
    }
    errors.push(...verifyCertificate(certificate, offer, outcome));
    if (outcome.offerVersions[offer.partyId] !== offer.offerVersion) {
      errors.push(`${offer.partyId} version binding is wrong`);
    }
  }

  if (!referenceAssignmentSatisfies(offers, outcome.protocolVersion, outcome.features)) {
    errors.push('solution does not satisfy every offer');
  }

  return report(errors);
}

function verifyCertificate(
  certificate: PartyCertificate,
  offer: Offer,
  outcome: NegotiationSuccess,
): string[] {
  const errors: string[] = [];
  const where = certificate.partyId;
  if (certificate.offerVersion !== offer.offerVersion) errors.push(`${where}: version mismatch`);
  if (certificate.protocolVersion !== outcome.protocolVersion) {
    errors.push(`${where}: certificate protocol mismatch`);
  }
  if (!offer.protocolVersions.includes(outcome.protocolVersion)) {
    errors.push(`${where}: protocol ${outcome.protocolVersion} not accepted`);
  }
  for (const feature of outcome.features) {
    if (!offer.supportedFeatures.includes(feature)) {
      errors.push(`${where}: unsupported feature ${feature}`);
    }
  }
  for (const feature of offer.requiredFeatures ?? []) {
    if (!outcome.features.includes(feature)) errors.push(`${where}: required ${feature} missing`);
  }
  const expectedIds = [...(offer.constraints ?? []).map((c) => c.id)].sort(compareIds);
  const reportedIds = certificate.checks.constraints.map((c) => c.id).sort(compareIds);
  if (expectedIds.join('\u0000') !== reportedIds.join('\u0000')) {
    errors.push(`${where}: constraint check set mismatch`);
  }
  for (const check of certificate.checks.constraints) {
    const source = (offer.constraints ?? []).find((c) => c.id === check.id);
    if (source === undefined) {
      errors.push(`${where}: check for unknown constraint ${check.id}`);
      continue;
    }
    if (!certificateSatisfies(source.expr, outcome.features)) {
      errors.push(`${where}: constraint ${check.id} is reported satisfied but fails`);
    }
  }
  return errors;
}

/** Local recursive evaluator over a raw expression and a concrete feature set. */
function certificateSatisfies(expr: unknown, features: readonly FeatureId[]): boolean {
  const on = new Set(features);
  const evalNode = (node: unknown): boolean => {
    const value = node as {
      op?: string;
      feature?: string;
      features?: string[];
      count?: number;
      arg?: unknown;
      args?: unknown[];
    };
    switch (value.op) {
      case 'feature':
        return on.has(value.feature!);
      case 'not':
        return !evalNode(value.arg);
      case 'and':
        return (value.args ?? []).every(evalNode);
      case 'or':
        return (value.args ?? []).some(evalNode);
      case 'atMost':
        return (value.features ?? []).filter((f) => on.has(f)).length <= (value.count ?? 0);
      case 'atLeast':
        return (value.features ?? []).filter((f) => on.has(f)).length >= (value.count ?? 0);
      case 'exactly':
        return (value.features ?? []).filter((f) => on.has(f)).length === (value.count ?? 0);
      default:
        return false;
    }
  };
  return evalNode(expr);
}

/**
 * Re-verify an unsatisfiable outcome:
 *  - core members are distinct and non-empty,
 *  - each removal witness satisfies every other core member,
 *  - enumerating the core finds no solution,
 *  - enumerating each core-minus-one finds a solution (minimality).
 */
export function verifyUnsatisfiableOutcome(
  outcome: NegotiationUnsatisfiable,
): VerificationReport {
  const errors: string[] = [];

  if (outcome.core.length === 0) errors.push('core is empty');
  const ids = new Set<string>();
  for (const entry of outcome.core) {
    if (ids.has(entry.id)) errors.push(`duplicate core member ${entry.id}`);
    ids.add(entry.id);
  }
  const witnessIds = new Set<string>();
  for (const removal of outcome.removalWitnesses) {
    if (!ids.has(removal.removedConstraintId)) {
      errors.push(`witness for non-core member ${removal.removedConstraintId}`);
    }
    if (witnessIds.has(removal.removedConstraintId)) {
      errors.push(`duplicate witness for ${removal.removedConstraintId}`);
    }
    witnessIds.add(removal.removedConstraintId);
    if (!witnessSatisfiesCoreMinus(outcome.core, removal.removedConstraintId, removal.witness)) {
      errors.push(`witness for ${removal.removedConstraintId} violates another core member`);
    }
  }
  for (const entry of outcome.core) {
    if (!witnessIds.has(entry.id)) errors.push(`missing removal witness for ${entry.id}`);
  }

  if (!coreIsUnsatisfiable(outcome.core)) {
    errors.push('core is actually satisfiable');
  }
  if (!coreIsMinimal(outcome.core)) {
    errors.push('core is not minimal');
  }
  return report(errors);
}

/** Exhaustive oracle for the kernel question: is `core` unsat? */
export function coreSatisfiable(core: readonly CoreConstraint[]): boolean {
  return checkCore(core).satisfiable;
}

export type { Witness };
