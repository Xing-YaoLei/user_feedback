/**
 * 本地合成传输适配器:模拟乱序、重复、延迟的传输,
 * 并收集全节点事件轨迹(发送/接收/记录截面),供测试复验切面。
 */
import type {
  NodeEvent,
  NodeId,
  Payload,
  RoundId,
  SnapshotNode,
  Transport,
  WireMessage,
} from './snapshot.ts';

export interface InflightItem {
  from: NodeId;
  to: NodeId;
  msg: WireMessage;
}

export interface TraceEvent {
  index: number;
  node: NodeId;
  type: NodeEvent['type'];
  round?: RoundId;
  to?: NodeId;
  from?: NodeId;
  seq?: number;
  rounds?: RoundId[];
  payload?: Payload;
}

/** 确定性伪随机数生成器(mulberry32) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Harness implements Transport {
  readonly inflight: InflightItem[] = [];
  readonly trace: TraceEvent[] = [];
  private readonly nodes = new Map<NodeId, SnapshotNode>();

  register(node: SnapshotNode): void {
    this.nodes.set(node.id, node);
  }

  /** 节点事件轨迹收集器 */
  eventSink(nodeId: NodeId): (e: NodeEvent) => void {
    return (e) => {
      this.trace.push({ index: this.trace.length, node: nodeId, ...e } as TraceEvent);
    };
  }

  /** Transport 实现:不直接投递,进入在途队列(可延迟、乱序、重复) */
  send(from: NodeId, to: NodeId, msg: WireMessage): void {
    this.inflight.push({ from, to, msg });
  }

  findInflight(pred: (item: InflightItem) => boolean): number[] {
    const out: number[] = [];
    this.inflight.forEach((it, i) => {
      if (pred(it)) out.push(i);
    });
    return out;
  }

  /** 投递指定下标的在途消息,copies > 1 时模拟重复投递 */
  deliverAt(index: number, copies = 1): void {
    const [item] = this.inflight.splice(index, 1);
    if (!item) throw new Error(`no inflight message at index ${index}`);
    const node = this.nodes.get(item.to);
    if (!node) throw new Error(`unknown node ${item.to}`);
    for (let i = 0; i < copies; i++) node.receive(item.msg);
  }

  /** 投递第一条匹配的在途消息 */
  deliverOne(pred: (item: InflightItem) => boolean, copies = 1): boolean {
    const i = this.inflight.findIndex(pred);
    if (i < 0) return false;
    this.deliverAt(i, copies);
    return true;
  }

  /** 投递当前所有匹配的在途消息,返回投递条数 */
  deliverWhere(pred: (item: InflightItem) => boolean, copies = 1): number {
    const idxs = this.findInflight(pred);
    for (const i of [...idxs].sort((a, b) => b - a)) this.deliverAt(i, copies);
    return idxs.length;
  }

  /**
   * 投递全部在途消息(投递过程中产生的新消息也会被投递)。
   * 传入 seed 时按确定性随机顺序投递,dupProb 控制重复投递比例。
   */
  flush(opts: { seed?: number; dupProb?: number } = {}): void {
    const rand = opts.seed !== undefined ? mulberry32(opts.seed) : null;
    let guard = 0;
    while (this.inflight.length > 0) {
      if (++guard > 100000) throw new Error('flush did not terminate');
      const i = rand ? Math.floor(rand() * this.inflight.length) : 0;
      const copies = rand && opts.dupProb && rand() < opts.dupProb ? 2 : 1;
      this.deliverAt(i, copies);
    }
  }
}
