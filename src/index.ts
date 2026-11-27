/**
 * Capability negotiation: public module entry point.
 *
 * @example
 * import { negotiate, NegotiationSession } from './src/index.ts';
 *
 * const outcome = negotiate(offers, { audio: 1, video: 5 });
 * if (outcome.status === 'success') console.log(outcome.features);
 */

export { negotiate, solveNormalized, DEFAULT_MAX_STEPS } from './core.ts';
export { NegotiationSession } from './session.ts';
export {
  NegotiationInputError,
  OfferVersionConflictError,
  UnknownPartyError,
  StaleProgressError,
  InvalidProgressError,
} from './errors.ts';
export { verifySuccessOutcome, verifyUnsatisfiableOutcome } from './verify.ts';
export type { VerificationReport } from './verify.ts';
export {
  referenceSolve,
  checkCore,
  coreIsUnsatisfiable,
  coreIsMinimal,
  witnessSatisfiesCoreMinus,
  referenceAssignmentSatisfies,
} from './reference.ts';
export type { ReferenceResult, ReferenceSolution, CoreCheck } from './reference.ts';
export type * from './types.ts';
