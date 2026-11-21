import type {
  CursorCloseResult,
  InstanceInput,
  LeaseHandle,
  LeaseView,
  RegisterResult,
  UnregisterResult,
  CloseLeaseResult,
} from './types.ts';
import type { LeaseRecord, SessionFacade } from './internal.ts';

/** Caller-side session handle bound to exactly one lease generation. */
export class Session implements LeaseHandle {
  private readonly facade: SessionFacade;
  readonly leaseId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly expiresAt: number;
  readonly ttlMs: number;

  constructor(facade: SessionFacade, record: LeaseRecord) {
    this.facade = facade;
    this.leaseId = record.leaseId;
    this.sessionId = record.sessionId;
    this.sessionGeneration = record.sessionGeneration;
    this.expiresAt = record.expiresAt;
    this.ttlMs = record.ttlMs;
  }

  /** Alias for sessionGeneration. */
  get generation(): number {
    return this.sessionGeneration;
  }

  register(inputs: readonly InstanceInput[]): RegisterResult {
    return this.facade.registerFor(this, inputs);
  }

  unregister(names: readonly string[]): UnregisterResult {
    return this.facade.unregisterFor(this, names);
  }

  renew(options: { ttlMs?: number } = {}): LeaseView {
    return this.facade.renewFor(this, options.ttlMs);
  }

  close(): CloseLeaseResult {
    return this.facade.closeFor(this);
  }

  view(): LeaseView | null {
    return this.facade.leaseViewFor(this.leaseId);
  }
}

export type { CursorCloseResult };
