/**
 * Adaptors that expose the coordinator to nodes.
 *
 * `DirectClient` is the in-process adapter used by unit tests: it calls the
 * coordinator synchronously and returns an already-resolved promise, so a test
 * can await a node method without any scheduler.
 *
 * `SimulatedClient` is the transport adapter for `SimulatedNetwork`: requests
 * are handed to the network, and the returned promise resolves only when the
 * matching response is actually *delivered* back to the node endpoint.  This is
 * what lets a scenario drop, duplicate, delay, or partition traffic while the
 * node code stays identical.
 *
 * Both adapters implement the same `CoordinatorClient` interface, so nothing in
 * `QuotaNode` knows which is in use.
 */

import type { Coordinator } from './coordinator.ts';
import type {
  BorrowRequest,
  BorrowResponse,
  ConsumeAck,
  ConsumeReport,
  CoordinatorToNodeMessage,
  ReturnConfirm,
  ReturnIntent,
} from './protocol.ts';
import { isBorrowResponse, isConsumeAck, isReturnConfirm } from './protocol.ts';
import type { CoordinatorClient, QuotaNode } from './node.ts';
import type { NodeEndpoint, SimulatedNetwork } from './network.ts';

/** Synchronous in-process adapter; every call is answered immediately. */
export class DirectClient implements CoordinatorClient {
  private readonly coordinator: Coordinator;
  private readonly optionsAt: () => number | undefined;

  constructor(coordinator: Coordinator, options?: { at?: () => number | undefined }) {
    this.coordinator = coordinator;
    this.optionsAt = options?.at ?? (() => undefined);
  }

  async borrow(request: BorrowRequest): Promise<BorrowResponse> {
    const reply = this.coordinator.handle(request, { at: this.optionsAt() });
    if (!isBorrowResponse(reply)) throw new Error('unexpected reply to borrow request');
    return reply;
  }

  async returnQuota(intent: ReturnIntent): Promise<ReturnConfirm> {
    const reply = this.coordinator.handle(intent, { at: this.optionsAt() });
    if (!isReturnConfirm(reply)) throw new Error('unexpected reply to return intent');
    return reply;
  }

  async reportConsumption(report: ConsumeReport): Promise<ConsumeAck> {
    const reply = this.coordinator.handle(report, { at: this.optionsAt() });
    if (!isConsumeAck(reply)) throw new Error('unexpected reply to consume report');
    return reply;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Transport adapter over `SimulatedNetwork`.
 *
 * The client is also the node's network endpoint: when a coordinator reply is
 * delivered it is handed to `node.receive(...)` first (so local state is
 * updated in delivery order), then any matching pending promise is resolved.
 */
export class SimulatedClient implements CoordinatorClient, NodeEndpoint {
  readonly nodeId: string;
  private readonly network: SimulatedNetwork;
  private readonly node: QuotaNode;
  private readonly pendingBorrow = new Map<string, { deferred: Deferred<BorrowResponse>; request: BorrowRequest }>();
  private readonly pendingReturn = new Map<string, { deferred: Deferred<ReturnConfirm>; intent: ReturnIntent }>();
  private readonly pendingReport = new Map<string, { deferred: Deferred<ConsumeAck>; report: ConsumeReport }>();

  constructor(network: SimulatedNetwork, node: QuotaNode) {
    this.network = network;
    this.node = node;
    this.nodeId = node.nodeId;
  }

  borrow(request: BorrowRequest): Promise<BorrowResponse> {
    let pending = this.pendingBorrow.get(request.requestId);
    if (!pending) {
      pending = { deferred: deferred<BorrowResponse>(), request };
      this.pendingBorrow.set(request.requestId, pending);
    }
    // Always re-send: a retry reuses the same id, and the coordinator replays
    // its original decision idempotently.  The first delivered reply resolves.
    this.network.sendFromNode(this.nodeId, request);
    return pending.deferred.promise;
  }

  returnQuota(intent: ReturnIntent): Promise<ReturnConfirm> {
    let pending = this.pendingReturn.get(intent.returnId);
    if (!pending) {
      pending = { deferred: deferred<ReturnConfirm>(), intent };
      this.pendingReturn.set(intent.returnId, pending);
    }
    this.network.sendFromNode(this.nodeId, intent);
    return pending.deferred.promise;
  }

  report(report: ConsumeReport): Promise<ConsumeAck> {
    let pending = this.pendingReport.get(report.reportId);
    if (!pending) {
      pending = { deferred: deferred<ConsumeAck>(), report };
      this.pendingReport.set(report.reportId, pending);
    }
    this.network.sendFromNode(this.nodeId, report);
    return pending.deferred.promise;
  }

  reportConsumption(report: ConsumeReport): Promise<ConsumeAck> {
    return this.report(report);
  }

  /** Number of requests still awaiting a delivered reply (e.g. after a drop). */
  pendingCount(): number {
    return this.pendingBorrow.size + this.pendingReturn.size + this.pendingReport.size;
  }

  /**
   * Partition healed: re-send every request still awaiting a reply.
   *
   * Re-sending reuses the original request ids, so the coordinator's idempotent
   * replay makes this safe even if the earlier copies were actually delivered
   * but their responses lost.  This is how satisfiable borrows continue
   * automatically after recovery.
   */
  onReconnect(): void {
    for (const { request } of this.pendingBorrow.values()) {
      this.network.sendFromNode(this.nodeId, request);
    }
    for (const { intent } of this.pendingReturn.values()) {
      this.network.sendFromNode(this.nodeId, intent);
    }
    for (const { report } of this.pendingReport.values()) {
      this.network.sendFromNode(this.nodeId, report);
    }
  }

  /** Called by the network for every delivered coordinator->node message. */
  receive(message: CoordinatorToNodeMessage): void {
    this.node.receive(message);
    if (isBorrowResponse(message)) {
      const pending = this.pendingBorrow.get(message.requestId);
      if (pending) {
        this.pendingBorrow.delete(message.requestId);
        pending.deferred.resolve(message);
      }
      return;
    }
    if (isReturnConfirm(message)) {
      const pending = this.pendingReturn.get(message.returnId);
      if (pending) {
        this.pendingReturn.delete(message.returnId);
        pending.deferred.resolve(message);
      }
      return;
    }
    if (isConsumeAck(message)) {
      const pending = this.pendingReport.get(message.reportId);
      if (pending) {
        this.pendingReport.delete(message.reportId);
        pending.deferred.resolve(message);
      }
    }
  }
}
