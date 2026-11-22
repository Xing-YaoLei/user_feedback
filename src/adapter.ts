/**
 * 可控异步复制适配器。
 *
 * 真实环境里复制由外部系统异步完成；这里提供一个手工/可控的实现，
 * 让测试可以决定每个复制何时成功、何时失败，以及模拟“迟到结果”：
 * 复制完成前 Broker 已退出或规划已变更，结果回来时仍要先计入占用
 * 再决定接纳还是清理。
 *
 * 适配器本身只负责模拟复制请求的生命周期，槽位语义由执行器维护。
 */

import type { BrokerId, PartitionId } from './types.ts';

export interface ReplicationRequest {
  requestId: string;
  partition: PartitionId;
  source: BrokerId;
  target: BrokerId;
  settled: boolean;
  succeeded: boolean;
}

export interface ReplicationAdapter {
  /** 发起一次异步复制，返回请求标识；结果通过 succeed/fail 控制。 */
  replicate(
    requestId: string,
    partition: PartitionId,
    source: BrokerId,
    target: BrokerId,
  ): void;
  /** 标记复制成功（副本已确认追平）。 */
  succeed(requestId: string): void;
  /** 标记复制失败（副本未形成，应释放槽位）。 */
  fail(requestId: string): void;
  /** Broker 退出：与该 Broker 相关的所有进行中复制全部失败。 */
  brokerDown(broker: BrokerId): string[];
  getRequest(requestId: string): ReplicationRequest | undefined;
  /** 尚未结算的请求（复制仍在进行）。 */
  pendingRequests(): ReplicationRequest[];
  /** 已经结算（成功或失败）、等待执行器对账的请求。 */
  settledRequests(): ReplicationRequest[];
}

export class ManualReplicationAdapter implements ReplicationAdapter {
  private readonly requests = new Map<string, ReplicationRequest>();

  replicate(
    requestId: string,
    partition: PartitionId,
    source: BrokerId,
    target: BrokerId,
  ): void {
    if (this.requests.has(requestId)) {
      throw new Error(`重复的复制请求 ID: ${requestId}`);
    }
    this.requests.set(requestId, {
      requestId,
      partition,
      source,
      target,
      settled: false,
      succeeded: false,
    });
  }

  private checkOpen(requestId: string): ReplicationRequest {
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`未知的复制请求: ${requestId}`);
    if (req.settled) throw new Error(`复制请求 ${requestId} 已经结算，不能重复结算`);
    return req;
  }

  succeed(requestId: string): void {
    const req = this.checkOpen(requestId);
    req.settled = true;
    req.succeeded = true;
  }

  fail(requestId: string): void {
    const req = this.checkOpen(requestId);
    req.settled = true;
    req.succeeded = false;
  }

  brokerDown(broker: BrokerId): string[] {
    const failed: string[] = [];
    for (const req of this.requests.values()) {
      if (!req.settled && (req.target === broker || req.source === broker)) {
        req.settled = true;
        req.succeeded = false;
        failed.push(req.requestId);
      }
    }
    return failed.sort();
  }

  getRequest(requestId: string): ReplicationRequest | undefined {
    return this.requests.get(requestId);
  }

  pendingRequests(): ReplicationRequest[] {
    return [...this.requests.values()]
      .filter((r) => !r.settled)
      .sort((a, b) => a.requestId.localeCompare(b.requestId));
  }

  settledRequests(): ReplicationRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.settled)
      .sort((a, b) => a.requestId.localeCompare(b.requestId));
  }
}
