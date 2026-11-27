import type {
  AdapterPort,
  BatchCounts,
  BatchDecision,
  BatchExplanation,
  BatchStatus,
  Clock,
  ConfigValue,
  DecisionReason,
  HealthOutcome,
  HealthReport,
  InstallCommand,
  InstallReceipt,
  InstanceExplanation,
  ReleaseExplanation,
  ReleaseRequest,
  ReleaseStatus,
  RestoreCommand,
  RestoreReceipt,
  RestoreStatus,
  RestoreSummary,
  SampleStatus,
} from './types.ts';
import { cloneConfig } from './clock.ts';

type InstallState = 'pending-receipt' | 'confirmed' | 'rejected' | 'not-delivered';

type HealthState = {
  hasReport: boolean;
  /** Highest sequence number observed for this identity, sample or not. */
  highestSeq?: number;
  latestSeq?: number;
  healthy?: boolean;
  receivedAt?: number;
  acceptedReports: number;
  lastRejection?: string;
};

type RestoreState = {
  status: RestoreStatus;
  intent?: number;
  targetConfig?: ConfigValue;
  requestedAt?: number;
  settledAt?: number;
  reason?: string;
};

type InstanceRecord = {
  instanceId: string;
  batchIndex: number;
  generation: number;
  installId: string;
  installIntent: number;
  install: {
    status: InstallState;
    commandSentAt: number;
    confirmedAt?: number;
    replacedConfig?: ConfigValue;
    rejectionReason?: string;
    note?: string;
  };
  health: HealthState;
  restore: RestoreState;
  ignoredReceipts: string[];
};

type BatchRecord = {
  index: number;
  plannedInstanceIds: string[];
  frozen: { instanceId: string; generation: number }[];
  openedAt: number | null;
  closesAt: number | null;
  closedAt?: number;
  status: BatchStatus;
  decision?: BatchDecision;
  instances: Map<string, InstanceRecord>;
};

type ReleaseRecord = {
  id: string;
  candidate: ConfigValue;
  observationMs: number;
  minValidSamples: number;
  successRatio: number;
  createdAt: number;
  finishedAt?: number;
  supersededAt?: number;
  status: ReleaseStatus;
  currentBatchIndex: number | null;
  batches: BatchRecord[];
  restoreRequested: boolean;
  ignoredReceipts: number;
};

export type TickResult = {
  /** Batches decided during this tick, in order. */
  decisions: BatchDecision[];
  releaseStatus: ReleaseStatus | null;
};

export type ControllerOptions = {
  clock: Clock;
  /** Prefix used for generated release ids. */
  idPrefix?: string;
};

const EPSILON = 1e-9;

/**
 * Batched configuration release controller.
 *
 * Lifecycle:
 *   startRelease(request) -> batch 0 opens. The batch freezes the instance ids
 *   and their process generations, starts the observation window at the
 *   current clock time, and sends install commands carrying a per-instance
 *   monotonic intent and a unique install id.
 *
 *   reportHealth(report) -> a report only becomes a sample when its
 *   (instanceId, generation) matches the frozen identity, its installId
 *   matches the candidate install this batch confirmed, its sequence number
 *   is newer than anything seen, and the window is still open.
 *
 *   tick() -> once the window has closed, the batch is decided. Success
 *   requires both the minimum number of valid samples and a success ratio of
 *   successes / frozen instance count. A pass opens the next batch (fresh
 *   freeze and fresh window, starting now); the last pass finishes the
 *   release. A failure stops later batches and starts a conditional rollback
 *   of every touched instance, targeting exactly the config each install
 *   receipt reported as replaced.
 */
export class ConfigReleaseController {
  #adapters = new Map<string, AdapterPort>();
  #releases = new Map<string, ReleaseRecord>();
  #releaseOrder: string[] = [];
  #activeReleaseId: string | null = null;
  /** Per-instance monotonic intent, shared across releases. */
  #intents = new Map<string, number>();
  #idPrefix: string;
  #releaseSeq = 0;
  #installSeq = 0;
  #restoreSeq = 0;
  #ignoredForeignReceipts = 0;
  #now: () => number;

  constructor(options: ControllerOptions) {
    this.#now = () => options.clock.now();
    this.#idPrefix = options.idPrefix ?? 'rel';
  }

  registerAdapter(adapter: AdapterPort): this {
    if (this.#adapters.has(adapter.instanceId)) {
      throw new Error(`adapter for instance "${adapter.instanceId}" is already registered`);
    }
    this.#adapters.set(adapter.instanceId, adapter);
    adapter.setReceiptSink((receipt) => this.receiveReceipt(receipt));
    return this;
  }

  getAdapter(instanceId: string): AdapterPort | undefined {
    return this.#adapters.get(instanceId);
  }

  get activeReleaseId(): string | null {
    return this.#activeReleaseId;
  }

  get ignoredForeignReceipts(): number {
    return this.#ignoredForeignReceipts;
  }

  /**
   * Starts a new release. Any running release is superseded: it stops making
   * decisions immediately, and its outstanding commands and receipts become
   * ineligible to change controller state. Its installs are left in place;
   * the new release's installs supersede them through the intent fence.
   */
  startRelease(request: ReleaseRequest): string {
    this.#validateRequest(request);

    for (const batch of request.batches) {
      for (const instanceId of batch) {
        if (!this.#adapters.has(instanceId)) {
          throw new Error(`no adapter registered for instance "${instanceId}"`);
        }
      }
    }

    // Resolve the id before anything destructive: a duplicate id must throw
    // without superseding the release that is currently running.
    const candidateSeq = this.#releaseSeq + 1;
    const id = request.releaseId ?? `${this.#idPrefix}-${candidateSeq}`;
    if (this.#releases.has(id)) {
      throw new Error(`release id "${id}" already exists`);
    }

    if (this.#activeReleaseId !== null) {
      const previous = this.#releases.get(this.#activeReleaseId)!;
      previous.status = 'superseded';
      previous.supersededAt = this.#now();
      previous.currentBatchIndex = null;
      for (const batch of previous.batches) {
        if (batch.status === 'observing' || batch.status === 'pending') {
          batch.status = 'abandoned';
        }
      }
      this.#activeReleaseId = null;
    }

    // Any rollback parked on another release is now withdrawn for instances
    // this new release is taking over: a restore built from an old install
    // must not fire once its receipt eventually shows up. Instances outside
    // this release keep their parked rollback, because nothing newer owns them.
    const claimed = new Set(request.batches.flatMap((batch) => batch));
    for (const other of this.#releases.values()) {
      for (const batch of other.batches) {
        for (const [instanceId, record] of batch.instances) {
          if (
            record.restore.status === 'awaiting-install-receipt' &&
            claimed.has(instanceId)
          ) {
            record.restore.status = 'skipped-condition';
            record.restore.reason = 'rollback withdrawn: superseded by a newer release';
          }
        }
      }
    }

    this.#releaseSeq = candidateSeq;

    const release: ReleaseRecord = {
      id,
      candidate: cloneConfig(request.candidate),
      observationMs: request.observationMs,
      minValidSamples: request.minValidSamples,
      successRatio: request.successRatio,
      createdAt: this.#now(),
      status: 'running',
      currentBatchIndex: 0,
      batches: request.batches.map((planned, index) => ({
        index,
        plannedInstanceIds: [...planned],
        frozen: [],
        openedAt: null,
        closesAt: null,
        status: 'pending' as BatchStatus,
        instances: new Map<string, InstanceRecord>(),
      })),
      restoreRequested: false,
      ignoredReceipts: 0,
    };

    this.#releases.set(id, release);
    this.#releaseOrder.push(id);
    this.#activeReleaseId = id;

    this.#openBatch(release, 0);
    return id;
  }

  #validateRequest(request: ReleaseRequest): void {
    if (request === null || typeof request !== 'object') {
      throw new TypeError('release request must be an object');
    }
    if (!Array.isArray(request.batches) || request.batches.length === 0) {
      throw new RangeError('release request needs at least one batch');
    }
    const seen = new Set<string>();
    request.batches.forEach((batch, index) => {
      if (!Array.isArray(batch) || batch.length === 0) {
        throw new RangeError(`batch ${index} must contain at least one instance id`);
      }
      for (const instanceId of batch) {
        if (typeof instanceId !== 'string' || instanceId.length === 0) {
          throw new TypeError(`batch ${index} contains a non-string instance id`);
        }
        if (seen.has(instanceId)) {
          throw new RangeError(`instance "${instanceId}" appears in more than one batch`);
        }
        seen.add(instanceId);
      }
    });
    if (!Number.isFinite(request.observationMs) || request.observationMs < 0) {
      throw new RangeError('observationMs must be a finite non-negative number');
    }
    if (!Number.isInteger(request.minValidSamples) || request.minValidSamples < 0) {
      throw new RangeError('minValidSamples must be a non-negative integer');
    }
    // A minimum larger than a batch is not a malformed request: that batch
    // simply fails at decision time with insufficient samples.
    if (
      !Number.isFinite(request.successRatio) ||
      request.successRatio < 0 ||
      request.successRatio > 1
    ) {
      throw new RangeError('successRatio must be a finite number in [0, 1]');
    }
  }

  /** Marks a batch as observing, freezing identities and sending installs. */
  #openBatch(release: ReleaseRecord, index: number): void {
    const batch = release.batches[index];
    if (!batch) {
      throw new Error(`release "${release.id}" has no batch ${index}`);
    }
    const openedAt = this.#now();
    batch.openedAt = openedAt;
    batch.closesAt = openedAt + release.observationMs;
    batch.status = 'observing';
    release.currentBatchIndex = index;

    for (const instanceId of batch.plannedInstanceIds) {
      const adapter = this.#adapters.get(instanceId)!;
      const generation = adapter.generation;
      batch.frozen.push({ instanceId, generation });

      const installId = `${release.id}-ins-${++this.#installSeq}`;
      const intent = this.#nextIntent(instanceId);
      const record: InstanceRecord = {
        instanceId,
        batchIndex: index,
        generation,
        installId,
        installIntent: intent,
        install: { status: 'pending-receipt', commandSentAt: openedAt },
        health: { hasReport: false, acceptedReports: 0 },
        restore: { status: 'not-needed' },
        ignoredReceipts: [],
      };
      batch.instances.set(instanceId, record);

      const command: InstallCommand = {
        kind: 'install',
        intent,
        instanceId,
        releaseId: release.id,
        installId,
        generation,
        config: cloneConfig(release.candidate),
      };
      const accepted = adapter.enqueue(command);
      // A synchronous receipt may already have settled the record; only a
      // still-pending record can be marked as never delivered.
      if (accepted === false && record.install.status === 'pending-receipt') {
        record.install.status = 'not-delivered';
        record.install.note = 'adapter did not accept the command';
      }
    }
  }

  #nextIntent(instanceId: string): number {
    const next = (this.#intents.get(instanceId) ?? 0) + 1;
    this.#intents.set(instanceId, next);
    return next;
  }

  /**
   * Decides every observing batch whose observation window has elapsed.
   * Opening the next batch happens at the current clock time, so a fresh
   * window is never backdated to the previous batch's end.
   */
  tick(): TickResult {
    const decisions: BatchDecision[] = [];
    const releaseId = this.#activeReleaseId;
    if (releaseId === null) {
      return { decisions, releaseStatus: null };
    }
    const release = this.#releases.get(releaseId)!;

    let guard = 0;
    while (release.status === 'running' && guard < 10_000) {
      guard += 1;
      const index = release.currentBatchIndex;
      if (index === null) break;
      const batch = release.batches[index];
      if (!batch || batch.status !== 'observing') break;
      if (this.#now() < batch.closesAt!) break;
      decisions.push(this.#decide(release, batch));
    }

    return { decisions, releaseStatus: release.status };
  }

  #decide(release: ReleaseRecord, batch: BatchRecord): BatchDecision {
    // Reports at or after closesAt were already refused, so the sample set
    // here is exactly what existed when the window closed, even if this tick
    // arrives late. closedAt records when the decision was actually taken.
    batch.closedAt = this.#now();
    const counts = this.#countBatch(batch);
    const reasons: DecisionReason[] = [];
    const enoughSamples = counts.validSamples >= release.minValidSamples;
    const ratioMet = counts.ratio + EPSILON >= release.successRatio;
    if (!enoughSamples) reasons.push('insufficient-valid-samples');
    if (!ratioMet) reasons.push('ratio-below-threshold');
    const advanced = enoughSamples && ratioMet;
    if (advanced) reasons.push('ratio-met');

    const message = advanced
      ? `advanced: ${counts.successes}/${counts.frozenTotal} successful ` +
        `(ratio ${formatRatio(counts.ratio)} >= ${formatRatio(release.successRatio)}), ` +
        `${counts.validSamples} valid samples >= ${release.minValidSamples}`
      : `failed: ${counts.successes}/${counts.frozenTotal} successful ` +
        `(ratio ${formatRatio(counts.ratio)} vs required ${formatRatio(release.successRatio)}), ` +
        `${counts.validSamples} valid samples (need ${release.minValidSamples}); ` +
        `${counts.pendingReceipt} install(s) unconfirmed, ` +
        `${counts.missingReport} missing health report, ` +
        `${counts.unhealthy} unhealthy`;

    const decision: BatchDecision = {
      ...counts,
      advanced,
      requiredRatio: release.successRatio,
      minValidSamples: release.minValidSamples,
      reasons,
      message,
      decidedAt: batch.closedAt!,
    };
    batch.decision = decision;

    if (advanced) {
      batch.status = 'passed';
      if (batch.index === release.batches.length - 1) {
        release.status = 'succeeded';
        release.finishedAt = this.#now();
        release.currentBatchIndex = null;
        this.#activeReleaseId = null;
      } else {
        this.#openBatch(release, batch.index + 1);
      }
    } else {
      batch.status = 'failed';
      release.status = 'failed';
      release.finishedAt = this.#now();
      release.currentBatchIndex = null;
      this.#activeReleaseId = null;
      for (const later of release.batches.slice(batch.index + 1)) {
        later.status = 'skipped';
      }
      this.#beginRollback(release);
    }

    return decision;
  }

  // ---------------------------------------------------------------- rollback

  /**
   * Requests rollback for every instance this release touched. Instances whose
   * install receipt has not arrived yet are parked; their restore is issued as
   * soon as that receipt arrives, using the replacedConfig it reports.
   *
   * Every restore intent is reserved here, at failure time. A parked restore
   * that is only sent much later therefore still ranks below any release that
   * started afterwards, so it can never outbid a newer release's install.
   */
  #beginRollback(release: ReleaseRecord): void {
    if (release.restoreRequested) return;
    release.restoreRequested = true;

    for (const batch of release.batches) {
      for (const record of batch.instances.values()) {
        switch (record.install.status) {
          case 'confirmed':
            this.#sendRestore(release, record, this.#nextIntent(record.instanceId));
            break;
          case 'pending-receipt':
            record.restore = {
              status: 'awaiting-install-receipt',
              intent: this.#nextIntent(record.instanceId),
              requestedAt: this.#now(),
              reason: 'install receipt not seen yet; restore target unknown',
            };
            break;
          case 'rejected':
          case 'not-delivered':
            record.restore = {
              status: 'not-needed',
              reason:
                record.install.status === 'rejected'
                  ? 'install was rejected, so nothing was changed'
                  : 'install command was never delivered',
            };
            break;
        }
      }
    }
  }

  #sendRestore(
    release: ReleaseRecord,
    record: InstanceRecord,
    reservedIntent?: number,
  ): void {
    const adapter = this.#adapters.get(record.instanceId);
    const targetConfig = cloneConfig(record.install.replacedConfig);
    const intent = reservedIntent ?? record.restore.intent ?? this.#nextIntent(record.instanceId);
    const restoreId = `${release.id}-rst-${++this.#restoreSeq}`;
    const requestedAt = this.#now();
    record.restore = {
      status: 'pending',
      intent,
      targetConfig,
      requestedAt,
      reason: 'restore requested; awaiting receipt',
    };
    if (!adapter) {
      record.restore.status = 'not-delivered';
      record.restore.reason = 'no adapter';
      return;
    }
    const command: RestoreCommand = {
      kind: 'restore',
      intent,
      instanceId: record.instanceId,
      releaseId: release.id,
      restoreId,
      expectedReleaseId: release.id,
      targetConfig,
    };
    const accepted = adapter.enqueue(command);
    if (accepted === false && record.restore.status === 'pending') {
      record.restore.status = 'not-delivered';
      record.restore.reason = 'adapter did not accept the restore command';
    }
  }

  // ---------------------------------------------------------------- receipts

  /**
   * Public receipt entry point; adapters are wired to it by registerAdapter.
   * Receipts for superseded releases never change state.
   */
  receiveReceipt(receipt: InstallReceipt | RestoreReceipt): void {
    const release = this.#releases.get(receipt.releaseId);
    if (!release) {
      this.#ignoredForeignReceipts += 1;
      return;
    }
    if (release.status === 'superseded') {
      release.ignoredReceipts += 1;
      return;
    }
    const record = this.#findRecord(release, receipt.instanceId);
    if (!record) {
      release.ignoredReceipts += 1;
      return;
    }
    if (receipt.kind === 'install') {
      this.#onInstallReceipt(release, record, receipt);
    } else {
      this.#onRestoreReceipt(release, record, receipt);
    }
  }

  #findRecord(release: ReleaseRecord, instanceId: string): InstanceRecord | undefined {
    for (const batch of release.batches) {
      const record = batch.instances.get(instanceId);
      if (record) return record;
    }
    return undefined;
  }

  #onInstallReceipt(
    release: ReleaseRecord,
    record: InstanceRecord,
    receipt: InstallReceipt,
  ): void {
    if (receipt.installId !== record.installId) {
      record.ignoredReceipts.push(
        `install receipt for installId ${receipt.installId} does not match ${record.installId}`,
      );
      release.ignoredReceipts += 1;
      return;
    }
    if (record.install.status === 'confirmed' || record.install.status === 'rejected') {
      record.ignoredReceipts.push(`duplicate install receipt for installId ${receipt.installId}`);
      release.ignoredReceipts += 1;
      return;
    }
    if (receipt.intent !== record.installIntent) {
      record.ignoredReceipts.push(
        `install receipt intent ${receipt.intent} != sent intent ${record.installIntent}`,
      );
      release.ignoredReceipts += 1;
      return;
    }

    if (receipt.ok) {
      record.install.status = 'confirmed';
      record.install.confirmedAt = this.#now();
      record.install.replacedConfig = cloneConfig(receipt.replacedConfig);
      if (release.restoreRequested && record.restore.status === 'awaiting-install-receipt') {
        this.#sendRestore(release, record, record.restore.intent);
      }
      return;
    }

    record.install.status = 'rejected';
    record.install.rejectionReason = receipt.reason;
    if (receipt.reason === 'wrong-generation') {
      record.install.note =
        `adapter reports generation ${receipt.actualGeneration ?? '?'}, ` +
        `batch froze ${record.generation}`;
    } else if (receipt.reason === 'stale-intent') {
      record.install.note =
        `adapter already saw intent ${receipt.lastIntent}; this install never applied`;
    }
    if (record.restore.status === 'awaiting-install-receipt') {
      record.restore = {
        status: 'not-needed',
        reason: `install was rejected (${receipt.reason}); nothing to roll back`,
      };
    }
  }

  #onRestoreReceipt(
    release: ReleaseRecord,
    record: InstanceRecord,
    receipt: RestoreReceipt,
  ): void {
    if (record.restore.intent !== receipt.intent) {
      record.ignoredReceipts.push(
        `restore receipt intent ${receipt.intent} != current ${record.restore.intent ?? 'none'}`,
      );
      release.ignoredReceipts += 1;
      return;
    }
    if (record.restore.status !== 'pending') {
      record.ignoredReceipts.push('duplicate or out-of-order restore receipt');
      release.ignoredReceipts += 1;
      return;
    }

    record.restore.settledAt = this.#now();
    if (receipt.ok) {
      record.restore.status = 'restored';
      record.restore.reason = 'conditional restore applied';
      return;
    }
    if (receipt.reason === 'condition-mismatch') {
      record.restore.status = 'skipped-condition';
      record.restore.reason = describeForeignOwner(receipt.currentOwner);
      return;
    }
    if (receipt.reason === 'stale-intent') {
      // A newer command (typically a newer release's install) already won the
      // instance. The rollback is skipped, and that newer state is preserved.
      record.restore.status = 'skipped-condition';
      record.restore.reason =
        `a newer intent (${receipt.lastIntent}) already owns the instance; rolled back nothing`;
      return;
    }
    record.restore.status = 'rejected';
    record.restore.reason = `restore rejected: ${receipt.reason}`;
  }

  // ------------------------------------------------------------ health input

  /**
   * Records a health report. A report becomes a sample only when:
   *  - the instance belongs to the batch currently observing;
   *  - the window is still open;
   *  - its process generation equals the frozen generation;
   *  - its installId equals the install this batch confirmed;
   *  - its seq is newer than any seen for this identity (duplicates never
   *    add samples, and the latest report wins).
   */
  reportHealth(report: HealthReport): HealthOutcome {
    if (
      report === null ||
      typeof report !== 'object' ||
      typeof report.instanceId !== 'string' ||
      !Number.isFinite(report.seq) ||
      typeof report.healthy !== 'boolean'
    ) {
      throw new TypeError('health report needs instanceId, generation, installId, seq, healthy');
    }
    const releaseId = this.#activeReleaseId;
    if (releaseId === null) {
      return {
        accepted: false,
        reason: 'release-not-active',
        note: this.#inactiveNote(report.instanceId),
      };
    }
    const release = this.#releases.get(releaseId)!;
    const location = this.#locate(release, report.instanceId);
    if (!location) {
      const planned = this.#pendingBatchFor(release, report.instanceId);
      if (planned) {
        return {
          accepted: false,
          reason: 'unknown-instance',
          note: `instance is planned for batch ${planned.index}, which has not started`,
        };
      }
      // The instance may belong to a release that is no longer active; saying
      // so is far more useful than "unknown instance".
      const other = this.#releaseContaining(report.instanceId);
      if (other && other.id !== release.id) {
        return {
          accepted: false,
          reason: 'release-not-active',
          note:
            `instance belongs to release "${other.id}" which is ` +
            `${other.status}; only the active release accepts reports`,
        };
      }
      return { accepted: false, reason: 'unknown-instance' };
    }
    const { batch, record } = location;
    const latest = record.health.latestSeq;

    if (batch.status !== 'observing') {
      return this.#rejectHealth(record, 'window-closed', 'batch already decided', latest);
    }
    if (this.#now() >= batch.closesAt!) {
      return this.#rejectHealth(
        record,
        'window-closed',
        'report arrived after the observation window closed',
        latest,
      );
    }
    if (report.generation !== record.generation) {
      return this.#rejectHealth(
        record,
        'generation-mismatch',
        `report generation ${report.generation} != frozen ${record.generation}`,
        latest,
      );
    }
    if (report.installId !== record.installId) {
      return this.#rejectHealth(
        record,
        'install-mismatch',
        `installId ${report.installId} != ${record.installId}`,
        latest,
      );
    }
    // Sequence ordering is enforced against every report seen for this
    // identity, including ones that arrived before the install was confirmed.
    // Otherwise an older, healthier report could land after confirmation and
    // masquerade as the latest state.
    if (record.health.highestSeq !== undefined && report.seq <= record.health.highestSeq) {
      return this.#rejectHealth(
        record,
        'duplicate-or-stale-seq',
        `seq ${report.seq} <= highest seen ${record.health.highestSeq}`,
        latest,
      );
    }
    record.health.highestSeq = report.seq;
    if (record.install.status !== 'confirmed') {
      return this.#rejectHealth(
        record,
        'install-not-confirmed',
        `install ${record.install.status}; health only counts after install confirmation`,
        latest,
      );
    }

    record.health = {
      hasReport: true,
      highestSeq: report.seq,
      latestSeq: report.seq,
      healthy: report.healthy,
      receivedAt: this.#now(),
      acceptedReports: record.health.acceptedReports + 1,
    };
    return { accepted: true, reason: 'accepted', latestSeq: report.seq };
  }

  #rejectHealth(
    record: InstanceRecord,
    reason: HealthOutcome['reason'],
    note: string,
    latest: number | undefined,
  ): HealthOutcome {
    record.health.lastRejection = note;
    return { accepted: false, reason, latestSeq: latest, note };
  }

  /** Finds any release (active or not) that includes an instance in a batch. */
  #releaseContaining(instanceId: string): ReleaseRecord | undefined {
    for (const release of this.#releases.values()) {
      for (const batch of release.batches) {
        if (batch.instances.has(instanceId)) return release;
      }
    }
    return undefined;
  }

  /** Finds a not-yet-started batch that names this instance. */
  #pendingBatchFor(
    release: ReleaseRecord,
    instanceId: string,
  ): BatchRecord | undefined {
    return release.batches.find(
      (batch) =>
        batch.status === 'pending' && batch.plannedInstanceIds.includes(instanceId),
    );
  }

  #inactiveNote(instanceId: string): string {
    const other = this.#releaseContaining(instanceId);
    if (!other) return 'no release is active';
    return `release "${other.id}" is ${other.status}; no release is active`;
  }

  #locate(
    release: ReleaseRecord,
    instanceId: string,
  ): { batch: BatchRecord; record: InstanceRecord } | undefined {
    for (const batch of release.batches) {
      const record = batch.instances.get(instanceId);
      if (record) return { batch, record };
    }
    return undefined;
  }

  // ---------------------------------------------------------------- queries

  /**
   * Explains a release (latest by default): every batch, whether it advanced
   * and why, plus per-instance install, health, and rollback state.
   */
  explain(releaseId?: string): ReleaseExplanation {
    const id = releaseId ?? this.#releaseOrder.at(-1);
    if (!id) throw new Error('no releases have been started');
    const release = this.#releases.get(id);
    if (!release) throw new Error(`unknown release "${id}"`);
    return this.#explain(release);
  }

  listReleaseIds(): string[] {
    return [...this.#releaseOrder];
  }

  #explain(release: ReleaseRecord): ReleaseExplanation {
    const summary: string[] = [];
    const now = this.#now();
    const batches = release.batches.map((batch) => this.#explainBatch(batch, now));

    for (const batch of batches) {
      if (batch.status === 'pending') {
        summary.push(
          `batch ${batch.index}: not started (${batch.plannedInstanceIds.length} instance(s) planned)`,
        );
      } else if (batch.status === 'observing') {
        const remaining = batch.window.closesAt! - now;
        summary.push(
          `batch ${batch.index}: observing, window closes in ${Math.max(0, remaining)}ms, ` +
            `${batch.live.confirmedInstalls}/${batch.live.frozenTotal} installs confirmed, ` +
            `${batch.live.validSamples} valid sample(s)`,
        );
      } else if (batch.status === 'skipped') {
        summary.push(`batch ${batch.index}: skipped because an earlier batch failed`);
      } else if (batch.status === 'abandoned') {
        summary.push(`batch ${batch.index}: abandoned when the release was superseded`);
      } else {
        summary.push(`batch ${batch.index}: ${batch.decision!.message}`);
      }
    }

    const restoreSummary = this.#restoreSummary(release);
    if (release.restoreRequested) {
      summary.push(
        `rollback: ${restoreSummary.restored.length} restored, ` +
          `${restoreSummary.awaitingInstallReceipt.length} waiting for install receipt, ` +
          `${restoreSummary.awaitingRestoreReceipt.length} waiting for restore receipt, ` +
          `${restoreSummary.notDelivered.length} not delivered, ` +
          `${restoreSummary.skippedCondition.length} skipped (install changed by someone else), ` +
          `${restoreSummary.rejected.length} rejected`,
      );
      for (const instanceId of restoreSummary.awaitingInstallReceipt) {
        summary.push(`  ${instanceId}: rollback parked until its install receipt arrives`);
      }
      for (const instanceId of restoreSummary.skippedCondition) {
        const record = this.#findRecord(release, instanceId)!;
        summary.push(
          `  ${instanceId}: rollback skipped — ${record.restore.reason ?? 'condition mismatch'}`,
        );
      }
      for (const instanceId of restoreSummary.notDelivered) {
        const record = this.#findRecord(release, instanceId)!;
        summary.push(
          `  ${instanceId}: restore not delivered — ${record.restore.reason ?? 'adapter refused'}`,
        );
      }
      for (const instanceId of restoreSummary.awaitingRestoreReceipt) {
        summary.push(`  ${instanceId}: restore sent, receipt still outstanding`);
      }
      if (release.status === 'superseded') {
        summary.push(
          'release superseded: outstanding commands and receipts no longer change state',
        );
      }
    } else if (release.status === 'superseded') {
      summary.push('release superseded: outstanding commands and receipts are ignored');
    }

    return {
      releaseId: release.id,
      status: release.status,
      active: this.#activeReleaseId === release.id,
      candidate: cloneConfig(release.candidate),
      observationMs: release.observationMs,
      minValidSamples: release.minValidSamples,
      successRatio: release.successRatio,
      createdAt: release.createdAt,
      finishedAt: release.finishedAt,
      supersededAt: release.supersededAt,
      currentBatchIndex: release.currentBatchIndex,
      batches,
      ignoredReceipts: release.ignoredReceipts,
      restoreRequested: release.restoreRequested,
      restoreSummary,
      summary,
    };
  }

  #explainBatch(batch: BatchRecord, now: number): BatchExplanation {
    const live = batch.openedAt === null ? emptyCounts() : this.#countBatch(batch);
    const instances: InstanceExplanation[] = [...batch.instances.values()].map((record) =>
      this.#explainInstance(record),
    );
    return {
      index: batch.index,
      status: batch.status,
      plannedInstanceIds: [...batch.plannedInstanceIds],
      frozen: batch.frozen.map((f) => ({ ...f })),
      window: {
        openedAt: batch.openedAt,
        closesAt: batch.closesAt,
        closedAt: batch.closedAt,
        elapsed: batch.closesAt !== null && now >= batch.closesAt,
        pendingDecision:
          batch.status === 'observing' && batch.closesAt !== null && now >= batch.closesAt,
      },
      live,
      decision: batch.decision
        ? { ...batch.decision, reasons: [...batch.decision.reasons] }
        : undefined,
      instances,
    };
  }

  #explainInstance(record: InstanceRecord): InstanceExplanation {
    let sampleStatus: SampleStatus;
    if (record.install.status !== 'confirmed') {
      sampleStatus = 'install-unconfirmed';
    } else if (!record.health.hasReport) {
      sampleStatus = 'missing-report';
    } else {
      sampleStatus = record.health.healthy ? 'healthy' : 'unhealthy';
    }
    return {
      instanceId: record.instanceId,
      batchIndex: record.batchIndex,
      generation: record.generation,
      installId: record.installId,
      install: {
        status: record.install.status,
        intent: record.installIntent,
        commandSentAt: record.install.commandSentAt,
        confirmedAt: record.install.confirmedAt,
        replacedConfig: cloneConfig(record.install.replacedConfig),
        rejectionReason: record.install.rejectionReason,
        note: record.install.note,
      },
      health: {
        hasReport: record.health.hasReport,
        latestSeq: record.health.latestSeq,
        healthy: record.health.healthy,
        receivedAt: record.health.receivedAt,
        acceptedReports: record.health.acceptedReports,
        sampleStatus,
        lastRejection: record.health.lastRejection,
      },
      restore: {
        status: record.restore.status,
        intent: record.restore.intent,
        targetConfig: cloneConfig(record.restore.targetConfig),
        requestedAt: record.restore.requestedAt,
        settledAt: record.restore.settledAt,
        reason: record.restore.reason,
      },
      ignoredReceipts: [...record.ignoredReceipts],
    };
  }

  #countBatch(batch: BatchRecord): BatchCounts {
    const counts = emptyCounts();
    counts.frozenTotal = batch.frozen.length;
    for (const record of batch.instances.values()) {
      if (record.install.status === 'confirmed') {
        counts.confirmedInstalls += 1;
        if (record.health.hasReport) {
          counts.validSamples += 1;
          if (record.health.healthy) counts.successes += 1;
          else counts.unhealthy += 1;
        } else {
          counts.missingReport += 1;
        }
      } else if (record.install.status === 'pending-receipt') {
        counts.pendingReceipt += 1;
      } else if (record.install.status === 'rejected') {
        counts.installRejected += 1;
      } else {
        counts.notDelivered += 1;
      }
    }
    counts.ratio = counts.frozenTotal === 0 ? 0 : counts.successes / counts.frozenTotal;
    return counts;
  }

  #restoreSummary(release: ReleaseRecord): RestoreSummary {
    const summary: RestoreSummary = {
      restored: [],
      awaitingInstallReceipt: [],
      awaitingRestoreReceipt: [],
      notDelivered: [],
      skippedCondition: [],
      rejected: [],
      notNeeded: 0,
    };
    for (const batch of release.batches) {
      for (const record of batch.instances.values()) {
        switch (record.restore.status) {
          case 'restored':
            summary.restored.push(record.instanceId);
            break;
          case 'awaiting-install-receipt':
            summary.awaitingInstallReceipt.push(record.instanceId);
            break;
          case 'pending':
            summary.awaitingRestoreReceipt.push(record.instanceId);
            break;
          case 'not-delivered':
            summary.notDelivered.push(record.instanceId);
            break;
          case 'skipped-condition':
            summary.skippedCondition.push(record.instanceId);
            break;
          case 'rejected':
            summary.rejected.push(record.instanceId);
            break;
          default:
            summary.notNeeded += 1;
        }
      }
    }
    return summary;
  }
}

function emptyCounts(): BatchCounts {
  return {
    frozenTotal: 0,
    confirmedInstalls: 0,
    validSamples: 0,
    successes: 0,
    unhealthy: 0,
    pendingReceipt: 0,
    installRejected: 0,
    notDelivered: 0,
    missingReport: 0,
    ratio: 0,
  };
}

function formatRatio(value: number): string {
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function describeForeignOwner(owner: { kind: string }): string {
  switch (owner.kind) {
    case 'release':
      return 'current install belongs to a different release';
    case 'restored':
      return 'current install was already restored';
    case 'external':
      return 'current install was changed outside this release';
    default:
      return 'current install no longer belongs to this release';
  }
}

export { cloneConfig };
