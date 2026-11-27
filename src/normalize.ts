/**
 * Canonicalization helpers.
 *
 * Two goals:
 *  1. Produce a stable, order-insensitive representation so that semantic
 *     duplicates collapse (same feature listed twice) and fingerprints do not
 *     depend on incidental array order.
 *  2. Never mutate caller data.
 */

import { createHash } from 'node:crypto';
import type {
  Expr,
  FeatureConstraint,
  FeatureId,
  Offer,
  ProtocolVersion,
} from './types.ts';
import { NegotiationInputError } from './errors.ts';
import { featuresOf } from './eval.ts';

export interface NormalizedConstraint {
  readonly id: string;
  readonly description: string | undefined;
  readonly expr: Expr;
  /** Canonical string key of `expr` (used for dedupe and display). */
  readonly key: string;
}

export interface NormalizedOffer {
  readonly partyId: string;
  readonly offerVersion: string;
  readonly protocolVersions: readonly ProtocolVersion[];
  readonly supportedFeatures: readonly FeatureId[];
  readonly requiredFeatures: readonly FeatureId[];
  readonly constraints: readonly NormalizedConstraint[];
}

export interface NormalizedRequest {
  readonly offers: readonly NormalizedOffer[];
  readonly featureUniverse: readonly FeatureId[];
  readonly featureIndex: ReadonlyMap<FeatureId, number>;
  readonly benefits: Readonly<Record<FeatureId, number>>;
  readonly snapshot: string;
  readonly offerVersions: Readonly<Record<string, string>>;
}

function fail(message: string): never {
  throw new NegotiationInputError(message);
}

function assertString(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${what} must be a non-empty string.`);
  }
}

function sortedUnique(values: readonly string[], what: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    assertString(value, `${what} entry`);
    seen.add(value);
  }
  return [...seen].sort(compareIds);
}

/** Deterministic id ordering: plain UTF-16 code unit order. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeExpr(expr: Expr): Expr {
  if (expr === null || typeof expr !== 'object') {
    fail('Constraint expression must be an object.');
  }
  switch (expr.op) {
    case 'feature':
      assertString(expr.feature, 'feature expression operand');
      return Object.freeze({ op: 'feature', feature: expr.feature });
    case 'not':
      return Object.freeze({ op: 'not', arg: normalizeExpr(expr.arg) });
    case 'and':
    case 'or': {
      if (!Array.isArray(expr.args) || expr.args.length === 0) {
        fail(`"${expr.op}" expression must have at least one operand.`);
      }
      const args = expr.args.map(normalizeExpr);
      // Sort operands for canonical form; AND/OR are commutative.
      args.sort((a, b) => compareIds(exprKey(a), exprKey(b)));
      return Object.freeze({ op: expr.op, args: Object.freeze(args) });
    }
    case 'atMost':
    case 'atLeast':
    case 'exactly': {
      if (!Array.isArray(expr.features)) {
        fail(`"${expr.op}" expression requires a features array.`);
      }
      if (!Number.isInteger(expr.count) || expr.count < 0) {
        fail(`"${expr.op}" count must be a non-negative integer.`);
      }
      const features = sortedUnique(expr.features, `${expr.op} feature`);
      if (expr.op === 'exactly' && expr.count > features.length) {
        fail(`"exactly" count ${expr.count} exceeds feature count ${features.length}.`);
      }
      return Object.freeze({ op: expr.op, features: Object.freeze(features), count: expr.count });
    }
    default:
      return fail(`Unknown expression operator ${JSON.stringify((expr as { op: unknown }).op)}.`);
  }
}

/** Canonical, order-insensitive string representation of an expression. */
export function exprKey(expr: Expr): string {
  switch (expr.op) {
    case 'feature':
      return `f:${expr.feature}`;
    case 'not':
      return `!(${exprKey(expr.arg)})`;
    case 'and':
      return `and(${expr.args.map(exprKey).join(',')})`;
    case 'or':
      return `or(${expr.args.map(exprKey).join(',')})`;
    case 'atMost':
      return `atMost(${expr.count};${expr.features.join(',')})`;
    case 'atLeast':
      return `atLeast(${expr.count};${expr.features.join(',')})`;
    case 'exactly':
      return `exactly(${expr.count};${expr.features.join(',')})`;
  }
}

function normalizeConstraints(
  constraints: readonly FeatureConstraint[] | undefined,
): NormalizedConstraint[] {
  if (constraints === undefined) return [];
  if (!Array.isArray(constraints)) {
    fail('Offer constraints must be an array.');
  }
  const byId = new Map<string, NormalizedConstraint>();
  for (const constraint of constraints) {
    if (constraint === null || typeof constraint !== 'object') {
      fail('Each constraint must be an object.');
    }
    assertString(constraint.id, 'constraint id');
    if (byId.has(constraint.id)) {
      fail(`Duplicate constraint id ${JSON.stringify(constraint.id)} within one offer.`);
    }
    if (constraint.description !== undefined) {
      assertString(constraint.description, 'constraint description');
    }
    const expr = normalizeExpr(constraint.expr);
    byId.set(constraint.id, {
      id: constraint.id,
      description: constraint.description,
      expr,
      key: exprKey(expr),
    });
  }
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

export function normalizeOffer(offer: Offer): NormalizedOffer {
  if (offer === null || typeof offer !== 'object') {
    fail('Each offer must be an object.');
  }
  assertString(offer.partyId, 'offer partyId');
  assertString(offer.offerVersion, 'offer offerVersion');
  if (!Array.isArray(offer.protocolVersions) || offer.protocolVersions.length === 0) {
    fail(`Party ${JSON.stringify(offer.partyId)} must accept at least one protocol version.`);
  }
  if (!Array.isArray(offer.supportedFeatures)) {
    fail(`Party ${JSON.stringify(offer.partyId)} must provide supportedFeatures.`);
  }
  const supported = sortedUnique(offer.supportedFeatures, 'supported feature');
  const required =
    offer.requiredFeatures === undefined
      ? []
      : sortedUnique(offer.requiredFeatures, 'required feature');
  for (const feature of required) {
    if (!supported.includes(feature)) {
      fail(
        `Party ${JSON.stringify(offer.partyId)} requires unsupported feature ` +
          `${JSON.stringify(feature)}; required features must be supported.`,
      );
    }
  }
  return {
    partyId: offer.partyId,
    offerVersion: offer.offerVersion,
    protocolVersions: sortedUnique(offer.protocolVersions, 'protocol version'),
    supportedFeatures: supported,
    requiredFeatures: required,
    constraints: normalizeConstraints(offer.constraints),
  };
}

/**
 * Build the normalized request. `snapshot` is a SHA-256 over a canonical JSON
 * encoding; it binds any produced result or resume token to the exact offers
 * and benefits used.
 */
export function normalizeRequest(
  offersInput: readonly Offer[],
  benefitsInput: Readonly<Record<FeatureId, number>>,
): NormalizedRequest {
  if (!Array.isArray(offersInput) || offersInput.length === 0) {
    fail('Negotiation requires at least one offer.');
  }
  if (benefitsInput === null || typeof benefitsInput !== 'object') {
    fail('benefits must be an object mapping feature ids to integers.');
  }

  const offers = offersInput.map(normalizeOffer);
  const partyIds = new Set<string>();
  for (const offer of offers) {
    if (partyIds.has(offer.partyId)) {
      fail(`Duplicate party id ${JSON.stringify(offer.partyId)}.`);
    }
    partyIds.add(offer.partyId);
  }
  // Canonical party ordering keeps fingerprints and search deterministic.
  offers.sort((a, b) => compareIds(a.partyId, b.partyId));

  const benefits: Record<FeatureId, number> = {};
  for (const [feature, benefit] of Object.entries(benefitsInput)) {
    assertString(feature, 'benefit feature id');
    if (typeof benefit !== 'number' || !Number.isFinite(benefit) || !Number.isInteger(benefit)) {
      fail(`Benefit for feature ${JSON.stringify(feature)} must be an integer.`);
    }
    benefits[feature] = benefit;
  }

  const universe = new Set<FeatureId>();
  for (const offer of offers) {
    for (const feature of offer.supportedFeatures) universe.add(feature);
    for (const feature of offer.requiredFeatures) universe.add(feature);
    // Constraints may mention features that no party declares as supported;
    // those still need a decision variable so they evaluate correctly (every
    // party's support rule will then veto them).
    for (const constraint of offer.constraints) {
      featuresOf(constraint.expr, universe);
    }
  }
  const featureUniverse = [...universe].sort(compareIds);
  const featureIndex = new Map(featureUniverse.map((f, i) => [f, i] as const));

  const offerVersions: Record<string, string> = {};
  for (const offer of offers) offerVersions[offer.partyId] = offer.offerVersion;

  const canonical = {
    offers: offers.map((offer) => ({
      partyId: offer.partyId,
      offerVersion: offer.offerVersion,
      protocolVersions: offer.protocolVersions,
      supportedFeatures: offer.supportedFeatures,
      requiredFeatures: offer.requiredFeatures,
      constraints: offer.constraints.map((c) => ({
        id: c.id,
        description: c.description ?? null,
        key: c.key,
      })),
    })),
    benefits: Object.keys(benefits)
      .sort(compareIds)
      .map((feature) => [feature, benefits[feature]]),
  };
  const snapshot = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');

  return Object.freeze({
    offers: Object.freeze(offers),
    featureUniverse: Object.freeze(featureUniverse),
    featureIndex,
    benefits: Object.freeze(benefits),
    snapshot,
    offerVersions: Object.freeze(offerVersions),
  });
}
