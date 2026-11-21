import type {
  CursorCloseResult,
  PollLimit,
  PollResult,
  Revision,
  Subscription,
  SubscriptionEpoch,
} from './types.ts';
import type { ClosedCursorRecord, SubscriptionFacade } from './internal.ts';

/**
 * Caller-side subscription handle. All state lives in the directory; the
 * handle only delegates, so polling a stale handle after eviction still yields
 * the directory's precise close/expiry signal.
 */
export class SubscriptionHandle implements Subscription {
  private readonly facade: SubscriptionFacade;
  readonly cursorId: string;
  readonly prefix: string;
  epoch: SubscriptionEpoch;
  /** Last revision this handle knows it consumed. */
  position: Revision;
  /** How the directory currently regards this handle. */
  closedReason: string | null = null;
  closed = false;
  /** Set once an expiry signal arrives. */
  expiredRecord: ClosedCursorRecord | null = null;

  constructor(facade: SubscriptionFacade, cursorId: string, prefix: string, epoch: SubscriptionEpoch, position: Revision) {
    this.facade = facade;
    this.cursorId = cursorId;
    this.prefix = prefix;
    this.epoch = Object.freeze(epoch);
    this.position = position;
  }

  poll(limit: PollLimit = {}): PollResult {
    const result = this.facade.pollSubscription(this.cursorId, limit);
    this.position = result.position;
    if (result.closed) {
      this.closed = true;
      this.closedReason = result.closedReason;
    }
    return result;
  }

  close(): CursorCloseResult {
    const result = this.facade.closeSubscription(this.cursorId);
    this.closed = true;
    this.closedReason = result.closedReason ?? 'caller-closed';
    return result;
  }
}
