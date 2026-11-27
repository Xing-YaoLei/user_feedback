/**
 * Shared domain types for the configuration release controller.
 *
 * Configuration values are deliberately opaque JSON-compatible values. The
 * controller never interprets them; it only copies them and hands them to
 * adapters.
 */

export type ConfigValue = unknown;

export type Clock = {
  now(): number;
};

/** Who currently owns the configuration installed on an instance. */
export type InstallOwner =
  | { kind: 'initial' }
  | { kind: 'release'; releaseId: string; installId: string }
  | { kind: 'restored'; releaseId: string; restoreId: string }
  | { kind: 'external'; note?: string };

export type AdapterSnapshot = {
  instanceId: string;
  generation: number;
  config: ConfigValue;
  owner: InstallOwner;
  /** Highest command intent the adapter has seen for this instance. */
  lastIntent: number;
  /** Monotonically increasing counter of physical state changes. */
  revision: number;
};

export type InstallCommand = {
  kind: 'install';
  /** Monotonic intent number; adapters reject intents <= lastIntent. */
  intent: number;
  instanceId: string;
  releaseId: string;
  /** Identifier chosen by the controller for this specific installation. */
  installId: string;
  /** Process generation frozen when the batch opened. */
  generation: number;
  config: ConfigValue;
};

export type RestoreCommand = {
  kind: 'restore';
  intent: number;
  instanceId: string;
  releaseId: string;
  restoreId: string;
  /**
   * Conditional restore: the adapter applies the restore only when the
   * instance is still owned by this release. Anything else is preserved.
   */
  expectedReleaseId: string;
  targetConfig: ConfigValue;
};

export type AdapterCommand = InstallCommand | RestoreCommand;

export type RejectionReason =
  | 'stale-intent'
  | 'condition-mismatch'
  | 'wrong-instance'
  | 'wrong-generation';

export type InstallReceipt =
  | {
      kind: 'install';
      ok: true;
      intent: number;
      instanceId: string;
      releaseId: string;
      installId: string;
      generation: number;
      /** The configuration that was actually replaced by this install. */
      replacedConfig: ConfigValue;
      appliedAt: number;
      revision: number;
    }
  | {
      kind: 'install';
      ok: false;
      intent: number;
      instanceId: string;
      releaseId: string;
      installId: string;
      generation: number;
      reason: RejectionReason;
      lastIntent: number;
      currentOwner: InstallOwner;
      rejectedAt: number;
      /** Present when the command targeted a different process generation. */
      actualGeneration?: number;
    };

export type RestoreReceipt =
  | {
      kind: 'restore';
      ok: true;
      intent: number;
      instanceId: string;
      releaseId: string;
      restoreId: string;
      restoredConfig: ConfigValue;
      previousOwner: InstallOwner;
      appliedAt: number;
      revision: number;
    }
  | {
      kind: 'restore';
      ok: false;
      intent: number;
      instanceId: string;
      releaseId: string;
      restoreId: string;
      reason: RejectionReason;
      lastIntent: number;
      currentOwner: InstallOwner;
      rejectedAt: number;
    };

export type CommandReceipt = InstallReceipt | RestoreReceipt;

/**
 * A health report is bound to both an instance identity (instanceId + process
 * generation) and the installation it observed (installId).
 */
export type HealthReport = {
  instanceId: string;
  generation: number;
  installId: string;
  /** Sequence number chosen by the reporting agent; latest wins. */
  seq: number;
  healthy: boolean;
  /** Optional reporter timestamp; the controller records receipt time. */
  at?: number;
};

export type HealthOutcomeReason =
  | 'accepted'
  | 'duplicate-or-stale-seq'
  | 'generation-mismatch'
  | 'install-mismatch'
  | 'install-not-confirmed'
  | 'unknown-instance'
  | 'window-closed'
  | 'release-not-active';

export type HealthOutcome = {
  accepted: boolean;
  reason: HealthOutcomeReason;
  /** Latest sequence number after processing, if any. */
  latestSeq?: number;
  note?: string;
};

/**
 * The narrow adapter surface the controller depends on.
 *
 * `enqueue` returns false when the adapter could not take the command at all
 * (for example the instance process is down). Commands that are accepted but
 * whose receipt is delayed return true; the controller then waits for the
 * receipt.
 */
export type AdapterPort = {
  readonly instanceId: string;
  readonly generation: number;
  enqueue(command: AdapterCommand): boolean;
  setReceiptSink(sink: ((receipt: CommandReceipt) => void) | null): void;
  snapshot(): AdapterSnapshot;
};

export type ReleaseRequest = {
  /** Optional explicit id. A generated id is used when omitted. */
  releaseId?: string;
  candidate: ConfigValue;
  /** Ordered batches. Every instance may appear at most once overall. */
  batches: readonly (readonly string[])[];
  /** Observation window length in milliseconds. */
  observationMs: number;
  /** Minimum number of valid per-instance samples needed to advance. */
  minValidSamples: number;
  /** Required successes / frozen instance count, in [0, 1]. */
  successRatio: number;
};

export type ReleaseStatus = 'running' | 'succeeded' | 'failed' | 'superseded';

export type BatchStatus =
  | 'pending'
  | 'observing'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'abandoned';

export type DecisionReason =
  | 'ratio-met'
  | 'insufficient-valid-samples'
  | 'ratio-below-threshold';

export type SampleStatus =
  | 'healthy'
  | 'unhealthy'
  | 'missing-report'
  | 'install-unconfirmed';

export type RestoreStatus =
  | 'not-needed'
  | 'not-delivered'
  | 'awaiting-install-receipt'
  | 'pending'
  | 'restored'
  | 'skipped-condition'
  | 'rejected';

export type BatchCounts = {
  /** Denominator for the success ratio: every frozen instance. */
  frozenTotal: number;
  confirmedInstalls: number;
  /** One per confirmed instance with at least one accepted health report. */
  validSamples: number;
  successes: number;
  unhealthy: number;
  /** Install command accepted by the adapter, receipt not seen yet. */
  pendingReceipt: number;
  /** Install receipt arrived but the adapter refused the install. */
  installRejected: number;
  /** Adapter refused the command outright (e.g. process down). */
  notDelivered: number;
  /** Install confirmed but no accepted health report before the window closed. */
  missingReport: number;
  ratio: number;
};

export type BatchDecision = BatchCounts & {
  advanced: boolean;
  requiredRatio: number;
  minValidSamples: number;
  reasons: DecisionReason[];
  message: string;
  decidedAt: number;
};

export type FrozenIdentity = {
  instanceId: string;
  generation: number;
};

export type InstanceExplanation = {
  instanceId: string;
  batchIndex: number;
  generation: number;
  installId: string;
  install: {
    status: 'pending-receipt' | 'confirmed' | 'rejected' | 'not-delivered';
    intent: number;
    commandSentAt: number;
    confirmedAt?: number;
    replacedConfig?: ConfigValue;
    rejectionReason?: string;
    note?: string;
  };
  health: {
    hasReport: boolean;
    latestSeq?: number;
    healthy?: boolean;
    receivedAt?: number;
    acceptedReports: number;
    sampleStatus: SampleStatus;
    lastRejection?: string;
  };
  restore: {
    status: RestoreStatus;
    intent?: number;
    targetConfig?: ConfigValue;
    requestedAt?: number;
    settledAt?: number;
    reason?: string;
  };
  ignoredReceipts: string[];
};

export type BatchExplanation = {
  index: number;
  status: BatchStatus;
  /** Instances named by the release request for this batch. */
  plannedInstanceIds: string[];
  /** Instances and process generations frozen when this batch started. */
  frozen: FrozenIdentity[];
  window: {
    openedAt: number | null;
    closesAt: number | null;
    closedAt?: number;
    /** True once the clock has reached closesAt. */
    elapsed: boolean;
    /** True when the window elapsed but tick() has not decided yet. */
    pendingDecision: boolean;
  };
  live: BatchCounts;
  decision?: BatchDecision;
  instances: InstanceExplanation[];
};

export type RestoreSummary = {
  restored: string[];
  /** Install receipt has not arrived yet, so rollback is waiting. */
  awaitingInstallReceipt: string[];
  /** Restore command was accepted, restore receipt has not arrived yet. */
  awaitingRestoreReceipt: string[];
  /** Adapter refused the command outright; no receipt will arrive. */
  notDelivered: string[];
  /** Current install is no longer owned by this release; left untouched. */
  skippedCondition: string[];
  rejected: string[];
  notNeeded: number;
};

export type ReleaseExplanation = {
  releaseId: string;
  status: ReleaseStatus;
  active: boolean;
  candidate: ConfigValue;
  observationMs: number;
  minValidSamples: number;
  successRatio: number;
  createdAt: number;
  finishedAt?: number;
  supersededAt?: number;
  currentBatchIndex: number | null;
  batches: BatchExplanation[];
  ignoredReceipts: number;
  restoreRequested: boolean;
  restoreSummary: RestoreSummary;
  /** Human-readable account of every batch plus rollback outcomes. */
  summary: string[];
};
