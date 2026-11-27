/**
 * Compiles normalized offers into a global constraint system.
 *
 * Every participant restriction becomes an individually identifiable rule so
 * unsatisfiable cores can name precise causes:
 *
 *  - protocol:<party>            protocols the party accepts
 *  - support:<party>:<feature>   the party cannot enable <feature>
 *  - required:<party>:<feature>  the party requires <feature>
 *  - constraint:<party>:<id>     a custom boolean rule from the offer
 *
 * Support rules are enforced structurally: a feature vetoed by a support rule
 * in a subset is simply not a decision variable for that subset, which is
 * exactly equivalent. Required and custom rules remain expressions.
 */

import type { CoreConstraint, Expr, FeatureId, ProtocolVersion } from './types.ts';
import type { NormalizedRequest } from './normalize.ts';
import { compareIds } from './normalize.ts';
import { formatExpr } from './eval.ts';

export interface ProtocolRule {
  readonly id: string;
  readonly partyId: string;
  readonly allowed: readonly ProtocolVersion[];
  readonly allowedSet: ReadonlySet<ProtocolVersion>;
}

export interface FeatureRule {
  readonly id: string;
  readonly partyId: string;
  readonly kind: 'support' | 'required' | 'custom';
  readonly description: string;
  readonly expr: Expr;
  readonly sourceId?: string;
}

export interface RuleRef {
  readonly id: string;
  readonly partyId: string;
  readonly kind: 'protocol' | 'support' | 'required' | 'custom';
  readonly protocol?: ProtocolRule;
  readonly feature?: FeatureRule;
}

export interface Problem {
  readonly request: NormalizedRequest;
  readonly protocolRules: readonly ProtocolRule[];
  /** Required + custom + support rules over feature assignments. */
  readonly featureRules: readonly FeatureRule[];
  readonly rules: readonly RuleRef[];
  readonly ruleById: ReadonlyMap<string, RuleRef>;
  /** Every rule id, ascending (deterministic deletion order). */
  readonly ruleIds: readonly string[];
  readonly bits: ReadonlyMap<FeatureId, bigint>;
  readonly globalProtocols: readonly ProtocolVersion[];
  readonly benefitOf: (feature: FeatureId) => number;
}

const NOT = (feature: FeatureId): Expr =>
  Object.freeze({ op: 'not' as const, arg: Object.freeze({ op: 'feature' as const, feature }) });

export function buildProblem(request: NormalizedRequest): Problem {
  const protocolRules: ProtocolRule[] = [];
  const featureRules: FeatureRule[] = [];
  const rules: RuleRef[] = [];

  const addFeatureRule = (rule: FeatureRule): void => {
    featureRules.push(rule);
    rules.push({ id: rule.id, partyId: rule.partyId, kind: rule.kind, feature: rule });
  };

  for (const offer of request.offers) {
    const protocolRule: ProtocolRule = Object.freeze({
      id: `protocol:${offer.partyId}`,
      partyId: offer.partyId,
      allowed: Object.freeze([...offer.protocolVersions]),
      allowedSet: new Set(offer.protocolVersions),
    });
    protocolRules.push(protocolRule);
    rules.push({
      id: protocolRule.id,
      partyId: protocolRule.partyId,
      kind: 'protocol',
      protocol: protocolRule,
    });

    for (const constraint of offer.constraints) {
      addFeatureRule(
        Object.freeze({
          id: `constraint:${offer.partyId}:${constraint.id}`,
          partyId: offer.partyId,
          kind: 'custom' as const,
          description:
            constraint.description ??
            `Party ${JSON.stringify(offer.partyId)} constraint ${JSON.stringify(
              constraint.id,
            )}: ${formatExpr(constraint.expr)}`,
          expr: constraint.expr,
          sourceId: constraint.id,
        }),
      );
    }

    for (const feature of offer.requiredFeatures) {
      addFeatureRule(
        Object.freeze({
          id: `required:${offer.partyId}:${feature}`,
          partyId: offer.partyId,
          kind: 'required' as const,
          description: `Party ${JSON.stringify(offer.partyId)} requires feature ${JSON.stringify(
            feature,
          )}.`,
          expr: Object.freeze({ op: 'feature' as const, feature }),
        }),
      );
    }
  }

  for (const feature of request.featureUniverse) {
    for (const offer of request.offers) {
      if (offer.supportedFeatures.includes(feature)) continue;
      addFeatureRule(
        Object.freeze({
          id: `support:${offer.partyId}:${feature}`,
          partyId: offer.partyId,
          kind: 'support' as const,
          description: `Party ${JSON.stringify(offer.partyId)} does not support feature ${JSON.stringify(
            feature,
          )}, so it cannot be enabled.`,
          expr: NOT(feature),
        }),
      );
    }
  }

  rules.sort((a, b) => compareIds(a.id, b.id));
  const ruleById = new Map(rules.map((rule) => [rule.id, rule] as const));

  const bits = new Map<FeatureId, bigint>();
  request.featureUniverse.forEach((feature, index) => {
    bits.set(feature, 1n << BigInt(index));
  });

  const protocolUnion = new Set<ProtocolVersion>();
  for (const offer of request.offers) {
    for (const version of offer.protocolVersions) protocolUnion.add(version);
  }

  return {
    request,
    protocolRules,
    featureRules,
    rules,
    ruleById,
    ruleIds: rules.map((rule) => rule.id),
    bits,
    globalProtocols: [...protocolUnion].sort(compareIds),
    benefitOf: (feature) => request.benefits[feature] ?? 0,
  };
}

/**
 * Protocol versions accepted by every protocol rule whose id is in `subset`.
 * With no protocol rules in the subset, every globally seen version is
 * acceptable. Sorted ascending: the first entry is the deterministic choice.
 */
export function commonProtocols(problem: Problem, subset: ReadonlySet<string>): ProtocolVersion[] {
  let current: ProtocolVersion[] | null = null;
  for (const rule of problem.protocolRules) {
    if (!subset.has(rule.id)) continue;
    if (current === null) {
      current = [...rule.allowed];
    } else {
      current = current.filter((version) => rule.allowedSet.has(version));
    }
    if (current.length === 0) return [];
  }
  return current ?? [...problem.globalProtocols];
}

/** Stable, plain-data description of a core member. */
export function toCoreConstraint(rule: RuleRef): CoreConstraint {
  if (rule.kind === 'protocol' && rule.protocol !== undefined) {
    const { id, partyId, allowed } = rule.protocol;
    return {
      id,
      partyId,
      kind: 'protocol',
      description: `Party ${JSON.stringify(partyId)} accepts only protocol versions [${allowed.join(
        ', ',
      )}].`,
      protocolVersions: [...allowed],
    };
  }
  const featureRule = rule.feature;
  if (featureRule === undefined) throw new Error(`Rule ${rule.id} has no payload.`);
  const { id, partyId, kind, description, expr, sourceId } = featureRule;
  let feature: FeatureId | undefined;
  if (kind === 'support' && expr.op === 'not' && expr.arg.op === 'feature') {
    feature = expr.arg.feature;
  } else if (kind === 'required' && expr.op === 'feature') {
    feature = expr.feature;
  }
  return {
    id,
    partyId,
    kind,
    description,
    expr,
    ...(feature === undefined ? {} : { feature }),
    ...(sourceId === undefined ? {} : { sourceId }),
  };
}

/* -------------------------------------------------------------------------- */
/* Mask encoding                                                              */
/* -------------------------------------------------------------------------- */

export function maskToString(mask: bigint): string {
  return mask.toString(16);
}

export function maskFromString(text: string): bigint {
  if (typeof text !== 'string' || !/^[0-9a-f]+$/.test(text)) {
    throw new Error(`Invalid mask encoding ${JSON.stringify(text)}.`);
  }
  return BigInt(`0x${text}`);
}
