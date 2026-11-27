/**
 * Stateful negotiation session.
 *
 * A session owns one immutable offer per party. Updating an offer requires a
 * fresh `offerVersion`; reusing a version with different content is rejected,
 * which keeps every published version a permanent, auditable artifact.
 *
 * Every solution and every resume token is bound to the exact set of offer
 * versions used. Progress from an older offer set can never be applied to a
 * newer one: the request snapshot check rejects it with `StaleProgressError`.
 */

import type {
  FeatureId,
  NegotiationOutcome,
  NegotiationParams,
  Offer,
  SolveOptions,
} from './types.ts';
import {
  OfferVersionConflictError,
  UnknownPartyError,
} from './errors.ts';
import {
  compareIds,
  normalizeOffer,
  normalizeRequest,
  type NormalizedOffer,
} from './normalize.ts';
import { solveNormalized } from './core.ts';

export class NegotiationSession {
  /** Party id -> current normalized offer. */
  private readonly offers = new Map<string, NormalizedOffer>();
  /** partyId -> offerVersion -> canonical content key, for immutability checks. */
  private readonly history = new Map<string, Map<string, string>>();
  private readonly benefits: Readonly<Record<FeatureId, number>>;
  /** Monotonic counter bumped on every accepted offer change. */
  private generation = 0;

  constructor(params: NegotiationParams) {
    if (params === null || typeof params !== 'object' || !Array.isArray(params.offers)) {
      throw new TypeError('NegotiationSession requires an offers array.');
    }
    const normalized = normalizeRequest(params.offers, params.benefits);
    this.benefits = normalized.benefits;
    for (const offer of normalized.offers) {
      this.offers.set(offer.partyId, offer);
      this.history.set(offer.partyId, new Map([[offer.offerVersion, offerKey(offer)]]));
    }
  }

  /** Current offer for one party (frozen copy), or undefined. */
  getOffer(partyId: string): NormalizedOffer | undefined {
    return this.offers.get(partyId);
  }

  /** All current offers, sorted by party id. */
  listOffers(): NormalizedOffer[] {
    return [...this.offers.values()].sort((a, b) => compareIds(a.partyId, b.partyId));
  }

  /** Party id -> current offer version. */
  currentVersions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const offer of this.listOffers()) out[offer.partyId] = offer.offerVersion;
    return out;
  }

  /** Increments whenever an offer changes; useful for cache invalidation. */
  get epoch(): number {
    return this.generation;
  }

  /**
   * Replace one party's offer. The new offer must carry a new `offerVersion`
   * unless its content is identical to the currently published version.
   * Returns the previous offer (or undefined) for auditing.
   */
  updateOffer(offer: Offer): NormalizedOffer | undefined {
    const normalized = normalizeOffer(offer);
    const history = this.history.get(normalized.partyId);
    if (history === undefined) {
      throw new UnknownPartyError(normalized.partyId);
    }
    const key = offerKey(normalized);
    const previouslyPublished = history.get(normalized.offerVersion);
    if (previouslyPublished !== undefined && previouslyPublished !== key) {
      throw new OfferVersionConflictError(normalized.partyId, normalized.offerVersion);
    }
    const previous = this.offers.get(normalized.partyId);
    this.offers.set(normalized.partyId, normalized);
    if (previouslyPublished === undefined) {
      history.set(normalized.offerVersion, key);
    }
    if (previous === undefined || offerKey(previous) !== key) {
      this.generation += 1;
    }
    return previous;
  }

  /**
   * Solve using the session's current offers. `resume` is validated against
   * the current offer snapshot, so progress from an older generation is
   * rejected rather than silently reused.
   */
  solve(options: SolveOptions = {}): NegotiationOutcome {
    const request = normalizeRequest(this.listOffers(), this.benefits);
    return solveNormalized(request, options);
  }

  /** Frozen benefits map (copied at construction; not replaceable). */
  getBenefit(feature: FeatureId): number {
    return this.benefits[feature] ?? 0;
  }
}

/** Canonical content key for an offer, ignoring presentation-only ordering. */
function offerKey(offer: NormalizedOffer): string {
  return JSON.stringify({
    partyId: offer.partyId,
    protocolVersions: offer.protocolVersions,
    supportedFeatures: offer.supportedFeatures,
    requiredFeatures: offer.requiredFeatures,
    constraints: offer.constraints.map((c) => ({ id: c.id, key: c.key, description: c.description ?? null })),
  });
}
