/**
 * Public data model for the capability negotiation module.
 *
 * Everything here is plain, JSON-serializable data. Functions in this package
 * never mutate caller objects; inputs are validated, copied and frozen.
 */

export type FeatureId = string;
export type ProtocolVersion = string;

/* -------------------------------------------------------------------------- */
/* Boolean constraint language                                                */
/* -------------------------------------------------------------------------- */

export type Expr =
  | FeatureExpr
  | NotExpr
  | AndExpr
  | OrExpr
  | CardinalityExpr;

export interface FeatureExpr {
  readonly op: 'feature';
  readonly feature: FeatureId;
}

export interface NotExpr {
  readonly op: 'not';
  readonly arg: Expr;
}

export interface AndExpr {
  readonly op: 'and';
  readonly args: readonly Expr[];
}

export interface OrExpr {
  readonly op: 'or';
  readonly args: readonly Expr[];
}

export interface CardinalityExpr {
  /** Enabled features among `features` must be exactly / at most / at least
   *  `count`. */
  readonly op: 'atMost' | 'atLeast' | 'exactly';
  readonly features: readonly FeatureId[];
  readonly count: number;
}

/* -------------------------------------------------------------------------- */
/* Offers                                                                     */
/* -------------------------------------------------------------------------- */

export interface FeatureConstraint {
  /** Stable identifier, unique within its offer. */
  readonly id: string;
  /** Must evaluate to true for every admitted solution. */
  readonly expr: Expr;
  readonly description?: string;
}

/**
 * An immutable capability declaration from one participant.
 *
 * `offerVersion` identifies the exact declaration. When any part of an offer
 * changes the participant must publish a new version string; a given
 * (partyId, offerVersion) pair can never be reused for different content.
 */
export interface Offer {
  readonly partyId: string;
  readonly offerVersion: string;
  /** Protocol versions this party accepts. Must be non-empty. */
  readonly protocolVersions: readonly ProtocolVersion[];
  /** Features this party can execute. */
  readonly supportedFeatures: readonly FeatureId[];
  /** Features the party requires in every solution. */
  readonly requiredFeatures?: readonly FeatureId[];
  /** Dependencies, exclusions, cardinality limits and other boolean rules. */
  readonly constraints?: readonly FeatureConstraint[];
}

export interface SolveOptions {
  /** Maximum number of search nodes for this call. Defaults to 200000. */
  readonly maxSteps?: number;
  /** Progress token returned by a previous `undetermined` outcome. */
  readonly resume?: SearchProgress;
  /**
   * What to do when `resume` was produced for a different request snapshot
   * (for example after an offer update):
   *  - 'throw' (default): raise `StaleProgressError`;
   *  - 'restart': ignore the stale token and solve against the current
   *    constraints from scratch.
   * Either way, stale search information is never applied to current offers.
   */
  readonly staleProgress?: 'throw' | 'restart';
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export type NegotiationOutcome =
  | NegotiationSuccess
  | NegotiationUnsatisfiable
  | NegotiationUndetermined;

export interface OfferBinding {
  /** Party id -> the exact offer version used to compute this outcome. */
  readonly offerVersions: Readonly<Record<string, string>>;
  /** SHA-256 over the canonical request snapshot (offers + benefits). */
  readonly offersFingerprint: string;
}

export interface PartyConstraintCheck {
  readonly id: string;
  readonly description?: string;
  readonly expr: Expr;
  readonly satisfied: true;
}

/**
 * Independently re-checkable per-party view of a solution. It lists every
 * input the party supplied and every check that was performed against it.
 */
export interface PartyCertificate {
  readonly partyId: string;
  readonly offerVersion: string;
  readonly protocolVersion: ProtocolVersion;
  readonly acceptedProtocolVersions: readonly ProtocolVersion[];
  readonly selectedFeatures: readonly FeatureId[];
  readonly supportedFeatures: readonly FeatureId[];
  readonly requiredFeatures: readonly FeatureId[];
  readonly checks: {
    readonly protocolAccepted: true;
    readonly allSelectedFeaturesSupported: true;
    readonly allRequiredFeaturesSelected: true;
    readonly constraints: readonly PartyConstraintCheck[];
  };
}

export interface SearchSummary {
  /** Total search nodes consumed, including nodes from resumed calls. */
  readonly explored: number;
  readonly exhaustedBudget: boolean;
  readonly resumed: boolean;
  readonly phase: 'optimize' | 'unsatisfiable-core' | 'complete';
}

export interface NegotiationSuccess extends OfferBinding {
  readonly status: 'success';
  readonly protocolVersion: ProtocolVersion;
  readonly features: readonly FeatureId[];
  readonly totalBenefit: number;
  /** Integer benefit of every feature in the universe (selected or not). */
  readonly featureBenefits: Readonly<Record<FeatureId, number>>;
  readonly parties: readonly PartyCertificate[];
  readonly search: SearchSummary;
}

/**
 * One member of a minimal unsatisfiable core. For every member m, the core
 * without m is satisfiable (see `removalWitnesses`), while the core as a whole
 * is not. Cores are pure: they consist either entirely of protocol rules or
 * entirely of feature rules, because the two dimensions are independent.
 */
export interface CoreConstraint {
  readonly id: string;
  readonly partyId: string;
  readonly kind: 'protocol' | 'support' | 'required' | 'custom';
  readonly description: string;
  readonly expr?: Expr;
  readonly feature?: FeatureId;
  readonly protocolVersions?: readonly ProtocolVersion[];
  /** Original `FeatureConstraint.id` for custom constraints. */
  readonly sourceId?: string;
}

export interface Witness {
  readonly protocolVersion: ProtocolVersion;
  readonly features: readonly FeatureId[];
}

export interface RemovalWitness {
  readonly removedConstraintId: string;
  /** Satisfies the core minus `removedConstraintId`. */
  readonly witness: Witness;
}

export interface NegotiationUnsatisfiable extends OfferBinding {
  readonly status: 'unsatisfiable';
  readonly core: readonly CoreConstraint[];
  /** One satisfiable witness for core \ {removedConstraintId}, for every id. */
  readonly removalWitnesses: readonly RemovalWitness[];
  readonly search: SearchSummary;
}

export interface NegotiationUndetermined extends OfferBinding {
  readonly status: 'undetermined';
  readonly progress: SearchProgress;
  readonly search: SearchSummary;
}

/* -------------------------------------------------------------------------- */
/* Resumable search progress (opaque; pass back as `resume`)                  */
/* -------------------------------------------------------------------------- */

/** Bit masks are encoded as lowercase hexadecimal strings for JSON safety. */
export interface SerializedOptimizeFrame {
  readonly depth: number;
  readonly mask: string;
  readonly benefit: number;
  /** 0 = include branch pending, 1 = exclude branch pending, 2 = both done. */
  readonly nextBranch: 0 | 1 | 2;
}

export interface SerializedSatFrame {
  readonly depth: number;
  readonly mask: string;
  /** 0 = exclude pending, 1 = include pending, 2 = both done. */
  readonly branch: 0 | 1 | 2;
}

export interface OptimizeSearchProgress {
  readonly stack: readonly SerializedOptimizeFrame[];
  readonly bestFeatures: readonly FeatureId[] | null;
  readonly bestBenefit: number | null;
  readonly complete: boolean;
}

export interface SatSearchProgress {
  readonly stack: readonly SerializedSatFrame[];
  readonly foundFeatures: readonly FeatureId[] | null;
  readonly complete: boolean;
}

export interface MusCheckProgress {
  /** The constraint subset under test, as ordered rule ids. */
  readonly subsetIds: readonly string[];
  /** Constraint whose removal is being tested. */
  readonly testedId: string;
  /** Smallest protocol accepted by the subset, or null on protocol conflict. */
  readonly protocolVersion: ProtocolVersion | null;
  /** null when no feature search is needed (protocol conflict / decided). */
  readonly sat: SatSearchProgress | null;
  readonly satisfiable: boolean | null;
  readonly witness: Witness | null;
}

export interface MusSearchProgress {
  readonly dimension: 'protocol' | 'feature';
  /** Stable, ascending rule id order used by the deletion pass. */
  readonly ruleOrder: readonly string[];
  /** Constraints still present in the candidate core. */
  readonly currentIds: readonly string[];
  /** Next index into `ruleOrder`. */
  readonly cursor: number;
  /** Witness for every retained constraint. */
  readonly witnesses: readonly RemovalWitness[];
  readonly check: MusCheckProgress | null;
  readonly complete: boolean;
  readonly coreIds: readonly string[] | null;
}

export interface SearchProgress {
  readonly token: 'capability-negotiation/progress@1';
  readonly snapshot: string;
  readonly offerVersions: Readonly<Record<string, string>>;
  /** Total nodes explored across every call that produced this token. */
  readonly explored: number;
  readonly phase: 'optimize' | 'core';
  readonly optimize: OptimizeSearchProgress | null;
  readonly mus: MusSearchProgress | null;
}
