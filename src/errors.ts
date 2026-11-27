/**
 * Error types raised by the capability negotiation package.
 */

export class NegotiationInputError extends Error {
  readonly code = 'ERR_NEGOTIATION_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'NegotiationInputError';
  }
}

export class OfferVersionConflictError extends Error {
  readonly code = 'ERR_OFFER_VERSION_CONFLICT';
  readonly partyId: string;
  readonly offerVersion: string;
  constructor(partyId: string, offerVersion: string) {
    super(
      `Party ${JSON.stringify(partyId)} already published offer version ${JSON.stringify(
        offerVersion,
      )} with different content. Offer versions are immutable; publish a new version.`,
    );
    this.name = 'OfferVersionConflictError';
    this.partyId = partyId;
    this.offerVersion = offerVersion;
  }
}

export class UnknownPartyError extends Error {
  readonly code = 'ERR_UNKNOWN_PARTY';
  readonly partyId: string;
  constructor(partyId: string) {
    super(
      `Party ${JSON.stringify(partyId)} is not part of this negotiation. ` +
        'Only existing participants can update their offer.',
    );
    this.name = 'UnknownPartyError';
    this.partyId = partyId;
  }
}

/** Raised when resumable search state was produced for different offers/benefits. */
export class StaleProgressError extends Error {
  readonly code = 'ERR_STALE_PROGRESS';
  readonly expectedSnapshot: string;
  readonly actualSnapshot: string;
  constructor(expectedSnapshot: string, actualSnapshot: string) {
    super(
      'Search progress was produced for a different request snapshot ' +
        `(${expectedSnapshot} != ${actualSnapshot}). Re-run the negotiation ` +
        'against the current offers instead of reusing stale progress.',
    );
    this.name = 'StaleProgressError';
    this.expectedSnapshot = expectedSnapshot;
    this.actualSnapshot = actualSnapshot;
  }
}

/** Raised when a resume token is structurally invalid or from another module. */
export class InvalidProgressError extends Error {
  readonly code = 'ERR_INVALID_PROGRESS';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProgressError';
  }
}
