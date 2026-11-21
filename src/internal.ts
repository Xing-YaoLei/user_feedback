import type {
  CursorCloseReason,
  CursorExpiredInfo,
  CursorCloseResult,
  InstanceInput,
  InstanceView,
  LeaseView,
  PollLimit,
  PollResult,
  RegisterResult,
  Revision,
  SubscriptionCloseReason,
  UnregisterResult,
  CloseLeaseResult,
} from './types.ts';

/** Mutable lease bookkeeping kept by the directory. */
export interface LeaseRecord {
  leaseId: string;
  sessionId: string;
  sessionGeneration: number;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  closed: boolean;
  closedReason: 'caller' | 'expired' | null;
  /** name -> per-name generation this lease owns. */
  entries: Map<string, number>;
}

/** Open pagination snapshot pinned to a revision. */
export interface PageCursorRecord {
  cursorId: string;
  revision: Revision;
  prefix: string;
  pageSize: number;
  createdAt: number;
  expiresAt: number;
  lastAccessAt: number;
}

/** Retained record of a closed/expired cursor, so late use has a precise signal. */
export interface ClosedCursorRecord {
  cursorId: string;
  kind: 'page' | 'subscription';
  reason: CursorCloseReason;
  /** Position/revision the cursor had reached when it closed. */
  revision: Revision;
  prefix: string;
  closedAt: number;
  abnormal: boolean;
  expired: CursorExpiredInfo | null;
}

/** Operations a Session handle needs from its directory. */
export interface SessionFacade {
  registerFor(handle: HandleLike, inputs: readonly InstanceInput[]): RegisterResult;
  unregisterFor(handle: HandleLike, names: readonly string[]): UnregisterResult;
  renewFor(handle: HandleLike, ttlMs?: number): LeaseView;
  closeFor(handle: HandleLike): CloseLeaseResult;
  leaseViewFor(leaseId: string): LeaseView | null;
}

/** Operations a Subscription handle needs from its directory. */
export interface SubscriptionFacade {
  pollSubscription(cursorId: string, limit?: PollLimit): PollResult;
  closeSubscription(cursorId: string): CursorCloseResult;
}

export interface HandleLike {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
}

export type StopReason = SubscriptionCloseReason;

export function subscriptionStopReason(reason: SubscriptionCloseReason): SubscriptionCloseReason {
  return reason;
}

/** Public view helpers shared by directory and handles. */
export function isInstanceOwnedBy(
  instance: InstanceView,
  handle: HandleLike,
): boolean {
  return (
    instance.leaseId === handle.leaseId &&
    instance.sessionId === handle.sessionId &&
    instance.sessionGeneration === handle.sessionGeneration
  );
}
