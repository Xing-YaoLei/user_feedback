/**
 * 仿真消息传输层。
 *
 * 由注入的调度器驱动投递，可复现 Raft 要求面对的全部网络故障：
 * - 丢失：dropPolicy 返回 true 的消息直接丢弃（可统计）
 * - 重复：duplicatePolicy 触发时额外再投递一份
 * - 延迟：delayPolicy 给出每消息的虚拟毫秒延迟（乱序自然由不同延迟产生）
 * - 滞留/分区：holdPolicy 返回 true 的消息进入保留队列，不投递也不丢失，
 *   直到测试显式 releaseHeld()，用于“先隔离、后补投滞留消息”的场景
 *
 * 所有策略缺省为“无损即时投递”。策略函数同样可基于调度器 RNG 做确定性故障注入。
 * 寻址约定：RaftNode 发送前在消息上盖写内部字段 __to，传输层据此路由。
 */

import type { NodeId, RaftMessage, Scheduler, Transport } from './types.ts';

export interface TransportPolicy<TCommand = unknown> {
  /** 返回 true 则消息丢失。 */
  dropPolicy?: (message: RaftMessage<TCommand>) => boolean;
  /** 返回 true 则消息额外复制一份。 */
  duplicatePolicy?: (message: RaftMessage<TCommand>) => boolean;
  /** 返回该消息的投递延迟（虚拟毫秒）。 */
  delayPolicy?: (message: RaftMessage<TCommand>) => number;
  /** 返回 true 则消息滞留（分区隔离），等待 releaseHeld 统一补投。 */
  holdPolicy?: (message: RaftMessage<TCommand>) => boolean;
}

/** 内部寻址字段，节点发送时盖写，传输层读取。 */
export type Addressed<TCommand = unknown> = RaftMessage<TCommand> & { __to: NodeId };

interface HeldEnvelope<TCommand> {
  message: Addressed<TCommand>;
}

export class SimTransport<TCommand = unknown> implements Transport<TCommand> {
  private readonly receivers = new Map<NodeId, (message: RaftMessage<TCommand>) => void>();
  private readonly scheduler: Scheduler;
  private policy: TransportPolicy<TCommand>;
  private readonly held: HeldEnvelope<TCommand>[] = [];

  dropped = 0;
  delivered = 0;
  duplicated = 0;
  heldCount = 0;

  constructor(scheduler: Scheduler, policy: TransportPolicy<TCommand> = {}) {
    this.scheduler = scheduler;
    this.policy = policy;
  }

  setPolicy(policy: TransportPolicy<TCommand>): void {
    this.policy = policy;
  }

  registerReceiver(id: NodeId, receiver: (message: RaftMessage<TCommand>) => void): void {
    // 节点重启会以同一 id 构造新实例，允许替换旧的（已停止的）接收器。
    this.receivers.set(id, receiver);
  }

  send(raw: RaftMessage<TCommand>): void {
    const message = raw as Addressed<TCommand>;
    if (!message.__to) throw new Error(`outbound ${message.type} missing destination (__to)`);
    const to = message.__to;

    if (this.policy.holdPolicy?.(message)) {
      this.held.push({ message });
      this.heldCount++;
      return;
    }
    if (this.policy.dropPolicy?.(message)) {
      this.dropped++;
      return;
    }

    this.queue(message, to);
    if (this.policy.duplicatePolicy?.(message)) {
      this.duplicated++;
      this.queue(message, to);
    }
  }

  /**
   * 补投全部滞留消息（按滞留顺序）。
   * 滞留队列可能很大（例如长期分区累积的选举消息），同刻全部零延迟投递会
   * 造成调度风暴；这里按每批间隔 staggerMs 错峰释放，且不再经过 hold/drop 策略。
   */
  releaseHeld(staggerMs = 2): number {
    const pending = this.held.splice(0, this.held.length);
    pending.forEach((envelope, i) => {
      const delay = (this.policy.delayPolicy?.(envelope.message) ?? 0) + i * staggerMs;
      this.scheduler.schedule(delay, () => {
        const receiver = this.receivers.get(envelope.message.__to);
        if (receiver) {
          this.delivered++;
          receiver(envelope.message);
        } else {
          this.dropped++;
        }
      });
    });
    return pending.length;
  }

  /** 丢弃滞留消息（分区永久化时使用）。 */
  discardHeld(): number {
    const n = this.held.length;
    this.held.splice(0, n);
    return n;
  }

  currentlyHeld(): number {
    return this.held.length;
  }

  private queue(message: Addressed<TCommand>, to: NodeId): void {
    const delay = this.policy.delayPolicy?.(message) ?? 0;
    this.scheduler.schedule(delay, () => {
      const receiver = this.receivers.get(to);
      // 目标节点未注册（尚未启动）时静默丢弃，与真实网络不可达等价。
      if (receiver) {
        this.delivered++;
        receiver(message);
      } else {
        this.dropped++;
      }
    });
  }
}
