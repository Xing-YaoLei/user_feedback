import { hostname } from 'node:os';
import {
  GatewayError,
  IndeterminateError,
  InvalidInputError,
  KeyConflictError,
  ProofMismatchError,
  ProofReplayedError,
  ResultExpiredError,
  StoreCorruptError,
  TicketNotFoundError,
  TicketNotIndeterminateError,
  TicketNotTerminalError,
  WaiterCancelledError,
  isBusinessError,
  toErrorShape,
} from './errors.ts';
import { TicketStore } from './store.ts';
import {
  assertIdentity,
  assertPlainString,
  canonicalJson,
  keyHashFor,
  makeTicketId,
  normalizeBody,
  nowIso,
  sha256Hex,
} from './util.ts';
import type {
  DerivedStatus,
  EntryRecord,
  ExecutionAdapter,
  ExecutionIntentRecord,
  IdempotencyIdentity,
  InvokeInput,
  InvokeResult,
  KeyView,
  ProofRecord,
  ReclaimExpiredResult,
  ReclaimResult,
  ReconcileInput,
  ReconciliationProof,
  ReconciliationRecord,
  RecoveryReport,
  TerminalOutcome,
  TicketRecord,
  TicketView,
} from './types.ts';
import { isTerminalOutcome } from './types.ts';

export interface GatewayOptions {
  stateDirectory: string;
  adapter: ExecutionAdapter;
  /** How long a stored result payload stays readable. Default 24h. */
  outcomeTtlMs?: number;
  /** Injectable clock, mostly for TTL tests. */
  clock?: () => Date;
  /** Run crash recovery on construction. Default true. */
  recoverOnStart?: boolean;
  /**
   * Testing aid: crash the process before the (n+1)-th durable write.
   * See {@link StoreOptions.faultAfterWrites}.
   */
  faultAfterWrites?: number;
  logger?: (line: string) => void;
}

interface InflightExecution {
  ticketId: string;
  identity: IdempotencyIdentity;
  started: boolean;
  start: () => void;
  promise: Promise<InvokeResult>;
}

type Plan =
  | { kind: 'respond'; result: InvokeResult }
  | { kind: 'wait'; inflight: InflightExecution }
  | { kind: 'execute'; inflight: InflightExecution };

const DEFAULT_OUTCOME_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Single-process idempotent RPC entry point.
 *
 * Invariants:
 * 1. Ticket + execution-intent records are fsynced before the adapter runs.
 * 2. A result is handed to callers only after it has been fsynced.
 * 3. A ticket still `pending` after a manager restart becomes
 *    `indeterminate` and is never executed automatically.
 * 4. Once a key accepts request bytes, no later call with the same bytes can
 *    cause a second execution — not after a crash, not after payload
 *    reclamation. Only an executor's `not_executed` proof re-opens the key.
 *
 * The plan step of {@link invoke} is fully synchronous (reads + fsynced
 * writes), and Node runs one thread, so two concurrent callers cannot
 * interleave inside a state transition.
 */
export class IdempotencyGateway {
  readonly store: TicketStore;
  readonly startupReport: RecoveryReport | null = null;
  private readonly adapter: ExecutionAdapter;
  private readonly inflight = new Map<string, InflightExecution>();
  private readonly outcomeTtlMs: number;
  private readonly clock: () => Date;
  private readonly logger: (line: string) => void;
  private closed = false;

  constructor(options: GatewayOptions) {
    if (!options?.stateDirectory) throw new InvalidInputError('stateDirectory is required');
    if (!options.adapter || typeof options.adapter.execute !== 'function') {
      throw new InvalidInputError('adapter with an execute(input) method is required');
    }
    this.adapter = options.adapter;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? (() => {});
    this.outcomeTtlMs = options.outcomeTtlMs ?? DEFAULT_OUTCOME_TTL_MS;
    if (!Number.isFinite(this.outcomeTtlMs) || this.outcomeTtlMs < 0) {
      throw new InvalidInputError('outcomeTtlMs must be a non-negative number');
    }
    this.store = new TicketStore({
      directory: options.stateDirectory,
      faultAfterWrites: options.faultAfterWrites,
      logger: this.logger,
    });
    if (options.recoverOnStart !== false) this.startupReport = this.recover();
  }

  /** Releases the single-owner lock. State on disk is untouched. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }

  /** Removes the state directory. Tests/tools only. */
  destroy(): void {
    this.closed = true;
    this.store.destroy();
  }

  private assertOpen(): void {
    if (this.closed) throw new GatewayError('INTERNAL', 'gateway is closed');
  }

  // ---------------------------------------------------------------------
  // Invoke
  // ---------------------------------------------------------------------

  async invoke(input: InvokeInput): Promise<InvokeResult> {
    this.assertOpen();
    const identity = assertIdentity(input);
    const body = normalizeBody(input.body);
    if (input.signal?.aborted) throw this.cancelled(identity);

    const keyHash = keyHashFor(identity);
    const digest = sha256Hex(body);

    // Synchronous decision: answer from state, join a live execution, or
    // durably create a ticket and register a new execution.
    const plan = this.planInvoke(identity, keyHash, digest, body);
    if (plan.kind === 'respond') return plan.result;
    if (plan.kind === 'execute') plan.inflight.start();
    return this.awaitShared(plan.inflight, input.signal);
  }

  private planInvoke(
    identity: IdempotencyIdentity,
    keyHash: string,
    digest: string,
    body: Uint8Array,
  ): Plan {
    const entry = this.loadEntry(keyHash);
    const now = nowIso(this.clock);

    if (!entry) {
      const ticket = this.createTicket(identity, keyHash, digest, body.length, 1, now);
      this.writeNewTicket(ticket, null);
      return { kind: 'execute', inflight: this.registerExecution(ticket, body) };
    }

    // Raw-byte identity: a key is permanently bound to its first body.
    if (entry.requestDigest !== digest) {
      throw new KeyConflictError(
        identity.tenant,
        identity.method,
        identity.idempotencyKey,
        entry.requestDigest,
        digest,
      );
    }

    const head = entry.headTicketId ? this.store.readTicket(keyHash, entry.headTicketId) : null;
    if (entry.headTicketId && !head) {
      throw new StoreCorruptError(
        this.store.entryPath(keyHash),
        `ledger head ${entry.headTicketId} has no ticket file`,
      );
    }

    if (!head) {
      const ticket = this.createTicket(identity, keyHash, digest, body.length, 1, now);
      this.writeNewTicket(ticket, entry);
      return { kind: 'execute', inflight: this.registerExecution(ticket, body) };
    }

    switch (head.status) {
      case 'succeeded':
      case 'business_error':
        if (head.outcome) return { kind: 'respond', result: this.resultOf(head) };
        // Terminal but payload reclaimed: never execute again.
        throw new ResultExpiredError(head.ticketId, head.outcomeReclaimedAt, head.reclaimReason);

      case 'indeterminate':
        throw new IndeterminateError(
          head.ticketId,
          `ticket ${head.ticketId} may already have executed; reconcile it with an executor proof before retrying`,
        );

      case 'not_executed': {
        const sequence = this.nextSequence(keyHash, entry);
        const ticket = this.createTicket(identity, keyHash, digest, body.length, sequence, now);
        this.writeNewTicket(ticket, entry);
        return { kind: 'execute', inflight: this.registerExecution(ticket, body) };
      }

      case 'pending': {
        const live = this.inflight.get(keyHash);
        if (live && live.ticketId === head.ticketId) return { kind: 'wait', inflight: live };
        // A pending ticket with no live execution means a previous manager
        // stopped mid-flight. It may have executed; never run it again.
        try {
          this.markIndeterminate(head, 'pending ticket had no live execution (previous manager stopped)');
        } catch (err) {
          // If the store is failing we still refuse to execute; the ticket
          // remains 'pending' and recovery will settle it on restart.
          this.logger(`warning: could not mark ${head.ticketId} indeterminate: ${(err as Error).message}`);
        }
        throw new IndeterminateError(
          head.ticketId,
          `ticket ${head.ticketId} was left pending and may have executed; reconcile it before retrying`,
        );
      }

      default:
        throw new GatewayError('INTERNAL', `unknown ticket status ${String((head as TicketRecord).status)}`);
    }
  }

  private createTicket(
    identity: IdempotencyIdentity,
    keyHash: string,
    digest: string,
    size: number,
    sequence: number,
    now: string,
  ): TicketRecord {
    return {
      schemaVersion: 1,
      ticketId: makeTicketId(keyHash, sequence, `${process.pid}-${Date.now()}-${Math.random()}`),
      keyHash,
      tenant: identity.tenant,
      method: identity.method,
      idempotencyKey: identity.idempotencyKey,
      requestDigest: digest,
      requestSize: size,
      sequence,
      createdAt: now,
      updatedAt: now,
      ownerPid: process.pid,
      ownerHostname: hostname(),
      status: 'pending',
      outcome: null,
      outcomeStoredAt: null,
      outcomeExpiresAt: null,
      outcomeReclaimedAt: null,
      reclaimedOutcomeDigest: null,
      reclaimReason: null,
      indeterminateReason: null,
      lastError: null,
      reconciliation: null,
    };
  }

  /**
   * Persist order: ticket, then ledger (so the ticket is discoverable as
   * head), then the execution-intent fact. The adapter is only invoked after
   * this method returns.
   */
  private writeNewTicket(ticket: TicketRecord, existingEntry: EntryRecord | null): void {
    this.store.writeTicket(ticket);
    const entry: EntryRecord = existingEntry ?? {
      schemaVersion: 1,
      keyHash: ticket.keyHash,
      tenant: ticket.tenant,
      method: ticket.method,
      idempotencyKey: ticket.idempotencyKey,
      requestDigest: ticket.requestDigest,
      requestSize: ticket.requestSize,
      createdAt: ticket.createdAt,
      updatedAt: ticket.createdAt,
      ticketIds: [],
      headTicketId: null,
    };
    if (!entry.ticketIds.includes(ticket.ticketId)) entry.ticketIds.push(ticket.ticketId);
    entry.headTicketId = ticket.ticketId;
    entry.updatedAt = nowIso(this.clock);
    this.store.writeEntry(entry);

    const intent: ExecutionIntentRecord = {
      schemaVersion: 1,
      ticketId: ticket.ticketId,
      keyHash: ticket.keyHash,
      sequence: ticket.sequence,
      requestDigest: ticket.requestDigest,
      createdAt: nowIso(this.clock),
    };
    this.store.writeIntent(intent);
  }

  private registerExecution(ticket: TicketRecord, body: Uint8Array): InflightExecution {
    const identity: IdempotencyIdentity = {
      tenant: ticket.tenant,
      method: ticket.method,
      idempotencyKey: ticket.idempotencyKey,
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inflight: InflightExecution = {
      ticketId: ticket.ticketId,
      identity,
      started: false,
      start: () => {
        if (inflight.started) return;
        inflight.started = true;
        release();
      },
      promise: undefined as unknown as Promise<InvokeResult>,
    };
    inflight.promise = gate
      .then(() => this.executeTicket(ticket, body))
      .finally(() => {
        const current = this.inflight.get(ticket.keyHash);
        if (current && current.ticketId === ticket.ticketId) this.inflight.delete(ticket.keyHash);
      });
    // Internal safety net: a caller that fully cancels must not trigger an
    // unhandled rejection. Real waiters attach their own handlers.
    inflight.promise.catch(() => {});
    this.inflight.set(ticket.keyHash, inflight);
    return inflight;
  }

  private async executeTicket(ticket: TicketRecord, body: Uint8Array): Promise<InvokeResult> {
    let outcome: TerminalOutcome;
    try {
      const value = await this.adapter.execute({
        tenant: ticket.tenant,
        method: ticket.method,
        idempotencyKey: ticket.idempotencyKey,
        ticketId: ticket.ticketId,
        sequence: ticket.sequence,
        body,
      });
      outcome = { type: 'success', value };
    } catch (err) {
      if (isBusinessError(err)) {
        // Deterministic completed rejection: a real terminal outcome.
        outcome = err.toOutcome();
      } else {
        const shape = toErrorShape(err);
        const current = this.store.readTicket(ticket.keyHash, ticket.ticketId) ?? ticket;
        if (current.status === 'pending') {
          try {
            this.markIndeterminate(current, `adapter error: ${shape.name}: ${shape.message}`);
          } catch (markErr) {
            // Store failure: leave 'pending' on disk. Recovery settles it, and
            // in-process retries are still refused below.
            this.logger(`warning: could not mark ${ticket.ticketId} indeterminate: ${(markErr as Error).message}`);
          }
        }
        throw new IndeterminateError(
          ticket.ticketId,
          `adapter failed with unknown execution state (${shape.name}: ${shape.message}); ticket is indeterminate`,
        );
      }
    }
    return this.persistOutcome(ticket, outcome);
  }

  private persistOutcome(ticket: TicketRecord, outcome: TerminalOutcome): InvokeResult {
    const now = nowIso(this.clock);
    const expiresAt = new Date(this.clock().getTime() + this.outcomeTtlMs).toISOString();
    const updated: TicketRecord = {
      ...ticket,
      status: outcome.type === 'success' ? 'succeeded' : 'business_error',
      outcome,
      outcomeStoredAt: now,
      outcomeExpiresAt: expiresAt,
      updatedAt: now,
    };
    try {
      this.store.writeTicket(updated);
    } catch (err) {
      // The result may or may not have reached disk. Never claim success and
      // never leave the key looking safely retryable.
      const onDisk = this.safeReadTicket(ticket.keyHash, ticket.ticketId);
      if (onDisk && onDisk.outcome && onDisk.status !== 'pending') {
        return this.resultOf(onDisk); // the write landed despite the error
      }
      if (onDisk && onDisk.status === 'pending') {
        try {
          this.markIndeterminate(onDisk, `result could not be persisted: ${(err as Error).message}`);
        } catch (markErr) {
          // The store is failing. The ticket stays 'pending' on disk, which
          // recovery converts to 'indeterminate' on the next start.
          this.logger(`warning: could not mark ${ticket.ticketId} indeterminate: ${(markErr as Error).message}`);
        }
      }
      throw new IndeterminateError(
        ticket.ticketId,
        `the effect ran but its result could not be persisted (${(err as Error).message}); ticket is indeterminate`,
      );
    }
    try {
      this.store.deleteIntent(ticket.keyHash, ticket.ticketId);
    } catch (err) {
      // A stale intent is harmless: recovery deletes intents for terminal
      // tickets. Do not fail a completed call over it.
      this.logger(`warning: could not clear intent for ${ticket.ticketId}: ${(err as Error).message}`);
    }
    return this.resultOf(updated);
  }

  private safeReadTicket(keyHash: string, ticketId: string): TicketRecord | null {
    try {
      return this.store.readTicket(keyHash, ticketId);
    } catch {
      return null;
    }
  }

  private resultOf(ticket: TicketRecord): InvokeResult {
    if (!ticket.outcome) {
      throw new ResultExpiredError(ticket.ticketId, ticket.outcomeReclaimedAt, ticket.reclaimReason);
    }
    return {
      tenant: ticket.tenant,
      method: ticket.method,
      idempotencyKey: ticket.idempotencyKey,
      ticketId: ticket.ticketId,
      outcome: ticket.outcome,
    };
  }

  private cancelled(identity: IdempotencyIdentity): WaiterCancelledError {
    return new WaiterCancelledError(identity.tenant, identity.method, identity.idempotencyKey);
  }

  private awaitShared(inflight: InflightExecution, signal?: AbortSignal): Promise<InvokeResult> {
    if (!signal) return inflight.promise;
    if (signal.aborted) return Promise.reject(this.cancelled(inflight.identity));
    return new Promise<InvokeResult>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(this.cancelled(inflight.identity));
      };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      inflight.promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (err) => {
          cleanup();
          reject(err);
        },
      );
    });
  }

  // ---------------------------------------------------------------------
  // Ledger helpers
  // ---------------------------------------------------------------------

  /**
   * Reads the ledger. If a crash landed between the ticket write and the
   * ledger write, rebuilds the ledger from the ticket files.
   */
  private loadEntry(keyHash: string): EntryRecord | null {
    const entry = this.store.readEntry(keyHash);
    if (entry) return entry;
    const ticketIds = this.store.listTicketIds(keyHash);
    if (ticketIds.length === 0) return null;

    const tickets = ticketIds
      .map((id) => this.store.readTicket(keyHash, id))
      .filter((t): t is TicketRecord => t !== null)
      .sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt));
    if (tickets.length === 0) return null;
    const first = tickets[0]!;
    const head = tickets[tickets.length - 1]!;
    const rebuilt: EntryRecord = {
      schemaVersion: 1,
      keyHash,
      tenant: first.tenant,
      method: first.method,
      idempotencyKey: first.idempotencyKey,
      requestDigest: first.requestDigest,
      requestSize: first.requestSize,
      createdAt: first.createdAt,
      updatedAt: head.updatedAt,
      ticketIds: tickets.map((t) => t.ticketId),
      headTicketId: head.ticketId,
    };
    this.logger(`store: rebuilt missing ledger for key ${keyHash.slice(0, 12)} from ${tickets.length} ticket(s)`);
    this.store.writeEntry(rebuilt);
    return rebuilt;
  }

  private nextSequence(keyHash: string, entry: EntryRecord): number {
    let max = 0;
    for (const id of entry.ticketIds) {
      const t = this.store.readTicket(keyHash, id);
      if (t && t.sequence > max) max = t.sequence;
    }
    return max + 1;
  }

  private markIndeterminate(ticket: TicketRecord, reason: string): void {
    if (ticket.status !== 'pending') return;
    this.store.writeTicket({
      ...ticket,
      status: 'indeterminate',
      indeterminateReason: reason,
      updatedAt: nowIso(this.clock),
    });
    this.logger(`ticket ${ticket.ticketId} marked indeterminate (${reason})`);
  }

  // ---------------------------------------------------------------------
  // Crash recovery
  // ---------------------------------------------------------------------

  /**
   * Converts every ticket without a terminal state into `indeterminate`.
   * Never executes anything. Runs before the gateway accepts traffic.
   */
  recover(): RecoveryReport {
    const recoveredAt = nowIso(this.clock);
    const indeterminateTicketIds: string[] = [];
    const sweptTempFiles = this.store.sweepTmp();

    for (const keyHash of this.store.listKeyHashes()) {
      const entry = this.loadEntry(keyHash);
      if (!entry) continue;
      for (const ticketId of entry.ticketIds) {
        const ticket = this.store.readTicket(keyHash, ticketId);
        if (!ticket) continue;
        if (ticket.status === 'pending') {
          const intent = this.store.readIntent(keyHash, ticketId);
          const reason = intent
            ? 'manager restart after persisting execution intent (adapter may have run)'
            : 'manager restart before execution intent was recorded';
          this.markIndeterminate(ticket, reason);
          indeterminateTicketIds.push(ticketId);
        } else {
          // Terminal or denied ticket: any leftover intent is stale.
          this.store.deleteIntent(keyHash, ticketId);
        }
      }
      for (const orphan of this.store.listIntentTicketIds(keyHash)) {
        if (!entry.ticketIds.includes(orphan)) this.store.deleteIntent(keyHash, orphan);
      }
    }

    if (indeterminateTicketIds.length > 0) {
      this.logger(
        `recovery: ${indeterminateTicketIds.length} ticket(s) marked indeterminate; reconcile with executor proofs`,
      );
    }
    return { recoveredAt, indeterminateTicketIds, sweptTempFiles };
  }

  // ---------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------

  /**
   * Applies an executor's irreversible terminal attestation.
   *
   * - `completed` carries the final result; the ticket becomes terminal with
   *   that result and later calls return it without executing.
   * - `not_executed` certifies that no effect happened and none ever will;
   *   only this proof kind lets the next invoke create a fresh ticket.
   *
   * Attestations are irreversible and single-purpose:
   * - A ticket's *first* attestation is pinned in an attestation record before
   *   the proof is stored. Any later, different attestation for that ticket is
   *   refused (`PROOF_MISMATCH`), even if a crash left the ticket
   *   indeterminate. This closes the window where a contradictory proof could
   *   otherwise unlock a second execution.
   * - A proof id is single-use across the store (`PROOF_REPLAYED`).
   * - The exact same proof may be re-sent; this repairs a crash between the
   *   proof write and the ticket write, and is otherwise idempotent.
   */
  reconcile(input: ReconcileInput): TicketView {
    this.assertOpen();
    if (!input || typeof input !== 'object') throw new InvalidInputError('reconcile input is required');
    const proof = this.validateProof(input.proof);
    const { keyHash, ticket } = this.findTicket(input);

    const contentHash = sha256Hex(canonicalJson(proof));
    const proofIdHash = sha256Hex(proof.proofId);

    if (ticket.status !== 'indeterminate') {
      if (ticket.reconciliation?.proofId === proof.proofId) {
        // Idempotent re-send. Guard against the same id with a different body.
        const stored = this.store.readProof(proofIdHash);
        if (stored && stored.contentHash !== contentHash) {
          throw new ProofMismatchError(ticket.ticketId, 'proof id was re-sent with different content', {
            proofId: proof.proofId,
          });
        }
        return this.viewOf(ticket);
      }
      throw new TicketNotIndeterminateError(ticket.ticketId, ticket.status);
    }
    this.assertProofBinding(ticket, input);

    // A proof id is single-use across the whole store. Check this *before*
    // pinning the attestation, so a rejected replay attempt never leaves a
    // ticket pinned to a proof that can never be applied.
    const existing = this.store.readProof(proofIdHash);
    if (existing) {
      const sameBindings =
        existing.proofId === proof.proofId &&
        existing.contentHash === contentHash &&
        existing.ticketId === ticket.ticketId &&
        existing.keyHash === keyHash;
      if (!sameBindings) throw new ProofReplayedError(ticket.ticketId, proof.proofId);
    }

    // Pin (or verify) the first attestation for this ticket *before* writing
    // anything else. Re-sending the identical attestation is fine; a
    // contradictory one is refused even though the ticket is still
    // indeterminate (e.g. a crash interrupted the application).
    const pinned = this.store.readAttestation(keyHash, ticket.ticketId);
    if (pinned) {
      if (pinned.proofId !== proof.proofId || pinned.contentHash !== contentHash) {
        throw new ProofMismatchError(
          ticket.ticketId,
          'a different attestation was already recorded for this ticket; attestations are irreversible',
          { pinnedProofId: pinned.proofId, receivedProofId: proof.proofId },
        );
      }
    } else {
      this.store.writeAttestation({
        schemaVersion: 1,
        ticketId: ticket.ticketId,
        keyHash,
        proofId: proof.proofId,
        contentHash,
        kind: proof.kind,
        recordedAt: nowIso(this.clock),
      });
    }

    if (!existing) {
      const record: ProofRecord = {
        schemaVersion: 1,
        proofId: proof.proofId,
        proofIdHash,
        contentHash,
        keyHash,
        ticketId: ticket.ticketId,
        kind: proof.kind,
        recordedAt: nowIso(this.clock),
        proof,
      };
      this.store.writeProof(record);
    }

    const now = nowIso(this.clock);
    const reconciliation: ReconciliationRecord = {
      proofId: proof.proofId,
      kind: proof.kind,
      attestedAt: proof.attestedAt ?? now,
      recordedAt: now,
      note: proof.note ?? null,
    };

    let updated: TicketRecord;
    if (proof.kind === 'completed') {
      updated = {
        ...ticket,
        status: proof.outcome.type === 'success' ? 'succeeded' : 'business_error',
        outcome: proof.outcome,
        outcomeStoredAt: now,
        outcomeExpiresAt: new Date(this.clock().getTime() + this.outcomeTtlMs).toISOString(),
        outcomeReclaimedAt: null,
        reclaimedOutcomeDigest: null,
        reclaimReason: null,
        updatedAt: now,
        reconciliation,
      };
    } else {
      updated = {
        ...ticket,
        status: 'not_executed',
        outcome: null,
        outcomeStoredAt: null,
        outcomeExpiresAt: null,
        updatedAt: now,
        reconciliation,
      };
    }
    this.store.writeTicket(updated);
    try {
      this.store.deleteIntent(keyHash, ticket.ticketId);
    } catch (err) {
      this.logger(`warning: could not clear intent for ${ticket.ticketId}: ${(err as Error).message}`);
    }
    return this.viewOf(updated);
  }

  private validateProof(proof: ReconciliationProof): ReconciliationProof {
    if (!proof || typeof proof !== 'object') throw new InvalidInputError('proof is required');
    const proofId = assertPlainString(proof.proofId, 'proof.proofId');
    if (proof.kind !== 'completed' && proof.kind !== 'not_executed') {
      throw new InvalidInputError(`unknown proof kind ${String((proof as { kind: unknown }).kind)}`);
    }
    const attestedAt =
      proof.attestedAt !== undefined ? assertPlainString(proof.attestedAt, 'proof.attestedAt') : undefined;
    const note = proof.note !== undefined ? assertPlainString(proof.note, 'proof.note') : undefined;

    if (proof.kind === 'not_executed') {
      return { kind: 'not_executed', proofId, ...(attestedAt ? { attestedAt } : {}), ...(note ? { note } : {}) };
    }

    const outcome = proof.outcome;
    if (!isTerminalOutcome(outcome)) {
      throw new InvalidInputError('completed proof requires a terminal outcome (success or business_error)');
    }
    if (outcome.type === 'success') {
      if (!('value' in outcome)) throw new InvalidInputError('completed proof outcome.value is required');
    } else {
      const error = outcome.error;
      if (!error || typeof error !== 'object') {
        throw new InvalidInputError('completed proof business_error requires an error');
      }
      assertPlainString(error.code, 'proof.outcome.error.code');
      assertPlainString(error.message, 'proof.outcome.error.message');
    }
    return { kind: 'completed', proofId, outcome, ...(attestedAt ? { attestedAt } : {}), ...(note ? { note } : {}) };
  }

  private assertProofBinding(ticket: TicketRecord, input: ReconcileInput): void {
    if (input.tenant !== undefined && input.tenant !== ticket.tenant) {
      throw new ProofMismatchError(ticket.ticketId, 'proof tenant does not match ticket', {
        expected: ticket.tenant,
        received: input.tenant,
      });
    }
    if (input.method !== undefined && input.method !== ticket.method) {
      throw new ProofMismatchError(ticket.ticketId, 'proof method does not match ticket', {
        expected: ticket.method,
        received: input.method,
      });
    }
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== ticket.idempotencyKey) {
      throw new ProofMismatchError(ticket.ticketId, 'proof idempotency key does not match ticket', {
        expected: ticket.idempotencyKey,
        received: input.idempotencyKey,
      });
    }
  }

  private findTicket(input: { ticketId?: unknown; tenant?: string; method?: string; idempotencyKey?: string }): {
    keyHash: string;
    ticket: TicketRecord;
  } {
    const ticketId = assertPlainString(input.ticketId, 'ticketId');
    const hasFullIdentity =
      input.tenant !== undefined && input.method !== undefined && input.idempotencyKey !== undefined;
    if (hasFullIdentity) {
      const identity = assertIdentity({
        tenant: input.tenant!,
        method: input.method!,
        idempotencyKey: input.idempotencyKey!,
      });
      const keyHash = keyHashFor(identity);
      const ticket = this.store.readTicket(keyHash, ticketId);
      if (ticket) return { keyHash, ticket };
      // Not under the supplied identity. Fall through to a global lookup so
      // the caller learns it is a binding mismatch rather than "not found"
      // when the ticket really exists under another key.
    }
    for (const keyHash of this.store.listKeyHashes()) {
      const ticket = this.store.readTicket(keyHash, ticketId);
      if (ticket) return { keyHash, ticket };
    }
    throw new TicketNotFoundError(ticketId);
  }

  // ---------------------------------------------------------------------
  // Result reclamation
  // ---------------------------------------------------------------------

  /**
   * Drops the result payload while keeping the key, the ledger and the
   * execution fact. Reclaimed tickets answer RESULT_EXPIRED forever.
   */
  reclaim(ticketId: string, options: { reason?: 'ttl' | 'admin' } = {}): ReclaimResult {
    this.assertOpen();
    const found = this.findTicket({ ticketId });
    return this.reclaimTicket(found.keyHash, found.ticket, options.reason ?? 'admin');
  }

  private reclaimTicket(keyHash: string, ticket: TicketRecord, reason: 'ttl' | 'admin'): ReclaimResult {
    const terminal = ticket.status === 'succeeded' || ticket.status === 'business_error';
    if (!terminal) throw new TicketNotTerminalError(ticket.ticketId, ticket.status);
    if (!ticket.outcome) {
      return {
        ticketId: ticket.ticketId,
        reclaimed: false,
        alreadyReclaimed: true,
        ticket: this.viewOf(ticket),
      };
    }
    const now = nowIso(this.clock);
    const updated: TicketRecord = {
      ...ticket,
      outcome: null,
      reclaimedOutcomeDigest: sha256Hex(canonicalJson(ticket.outcome)),
      outcomeReclaimedAt: now,
      reclaimReason: reason,
      updatedAt: now,
    };
    this.store.writeTicket(updated);
    return {
      ticketId: ticket.ticketId,
      reclaimed: true,
      alreadyReclaimed: false,
      ticket: this.viewOf(updated),
    };
  }

  /** Reclaims every result payload whose TTL has elapsed. */
  reclaimExpired(): ReclaimExpiredResult {
    this.assertOpen();
    const checkedAt = nowIso(this.clock);
    const nowMs = this.clock().getTime();
    const reclaimed: ReclaimResult[] = [];
    for (const keyHash of this.store.listKeyHashes()) {
      for (const ticketId of this.store.listTicketIds(keyHash)) {
        const ticket = this.store.readTicket(keyHash, ticketId);
        if (!ticket) continue;
        if (ticket.status !== 'succeeded' && ticket.status !== 'business_error') continue;
        if (!ticket.outcome || !ticket.outcomeExpiresAt) continue;
        if (new Date(ticket.outcomeExpiresAt).getTime() > nowMs) continue;
        reclaimed.push(this.reclaimTicket(keyHash, ticket, 'ttl'));
      }
    }
    return { reclaimed, checkedAt };
  }

  // ---------------------------------------------------------------------
  // Inspection
  // ---------------------------------------------------------------------

  inspectKey(identity: IdempotencyIdentity): KeyView | null {
    this.assertOpen();
    const valid = assertIdentity(identity);
    const keyHash = keyHashFor(valid);
    const entry = this.store.readEntry(keyHash);
    if (!entry) return null;
    const tickets = entry.ticketIds
      .map((id) => this.store.readTicket(keyHash, id))
      .filter((t): t is TicketRecord => t !== null)
      .sort((a, b) => a.sequence - b.sequence);
    return {
      tenant: entry.tenant,
      method: entry.method,
      idempotencyKey: entry.idempotencyKey,
      keyHash,
      requestDigest: entry.requestDigest,
      requestSize: entry.requestSize,
      headTicketId: entry.headTicketId,
      ticketIds: entry.ticketIds.slice(),
      derivedStatus: this.deriveStatus(entry, tickets),
      tickets: tickets.map((t) => this.viewOf(t)),
    };
  }

  getTicket(ticketId: string): TicketView | null {
    try {
      const found = this.findTicket({ ticketId });
      return this.viewOf(found.ticket);
    } catch (err) {
      if (err instanceof TicketNotFoundError) return null;
      throw err;
    }
  }

  /** All tickets in the store, for reconciliation/ops tooling. */
  listTickets(): TicketView[] {
    this.assertOpen();
    const out: TicketView[] = [];
    for (const keyHash of this.store.listKeyHashes()) {
      for (const ticketId of this.store.listTicketIds(keyHash)) {
        const t = this.store.readTicket(keyHash, ticketId);
        if (t) out.push(this.viewOf(t));
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private deriveStatus(entry: EntryRecord, tickets: TicketRecord[]): DerivedStatus {
    const head = entry.headTicketId ? tickets.find((t) => t.ticketId === entry.headTicketId) : undefined;
    if (!head) return 'corrupt';
    switch (head.status) {
      case 'pending':
        return 'pending';
      case 'indeterminate':
        return 'indeterminate';
      case 'not_executed':
        return 'not_executed';
      case 'succeeded':
      case 'business_error':
        return head.outcome ? 'completed' : 'expired';
      default:
        return 'corrupt';
    }
  }

  private viewOf(ticket: TicketRecord): TicketView {
    return {
      ticketId: ticket.ticketId,
      keyHash: ticket.keyHash,
      tenant: ticket.tenant,
      method: ticket.method,
      idempotencyKey: ticket.idempotencyKey,
      requestDigest: ticket.requestDigest,
      sequence: ticket.sequence,
      status: ticket.status,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      hasOutcome: ticket.outcome !== null,
      outcomeType: ticket.outcome ? ticket.outcome.type : null,
      outcomeStoredAt: ticket.outcomeStoredAt,
      outcomeExpiresAt: ticket.outcomeExpiresAt,
      outcomeReclaimedAt: ticket.outcomeReclaimedAt,
      reclaimedOutcomeDigest: ticket.reclaimedOutcomeDigest,
      reclaimReason: ticket.reclaimReason,
      indeterminateReason: ticket.indeterminateReason,
      reconciliation: ticket.reconciliation,
      ownerPid: ticket.ownerPid,
    };
  }
}
