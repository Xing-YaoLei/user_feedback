/**
 * 复制适配器接口与测试用手动适配器。
 *
 * 适配器负责与真实（或模拟的）复制子系统交互：
 * - startReplication 启动一次复制，返回控制句柄；
 * - 复制完成后通过 done Promise 通知执行器（成功 / 失败）；
 * - deleteReplica 是带确认的异步删除，resolve 时槽位才真正释放；
 * - stopReplication 用于 Broker 退出等场景中止复制。
 */

export interface ReplicationHandle {
  partitionId: string;
  brokerId: string;
  /** 复制结束时 settle：true 成功（可追平），false 失败（需清理或重试）。 */
  done: Promise<boolean>;
  /** 中止复制；返回后适配器保证 done 不再以成功结束。 */
  cancel: () => Promise<void>;
}

export interface ReplicationAdapter {
  startReplication(partitionId: string, brokerId: string): ReplicationHandle;
  deleteReplica(partitionId: string, brokerId: string): Promise<void>;
}

interface PendingManual {
  handle: ReplicationHandle;
  resolve: (ok: boolean) => void;
  cancelled: boolean;
}

/**
 * 手动可控适配器：复制启动后挂起，测试通过 succeed/fail 决定结果，
 * 可精确制造「迟到结果」「复制中途 Broker 退出」等交错场景。
 */
export class ManualReplicationAdapter implements ReplicationAdapter {
  private readonly pending = new Map<string, PendingManual>();
  private readonly deleted: Array<{ partitionId: string; brokerId: string }> = [];
  /** 删除动作的延迟（毫秒），默认立即确认。 */
  public deleteDelayMs = 0;

  private key(partitionId: string, brokerId: string): string {
    return `${partitionId}@${brokerId}`;
  }

  startReplication(partitionId: string, brokerId: string): ReplicationHandle {
    const key = this.key(partitionId, brokerId);
    if (this.pending.has(key)) {
      throw new Error(`复制已在进行中: ${key}`);
    }
    let resolve!: (ok: boolean) => void;
    const done = new Promise<boolean>((res) => {
      resolve = res;
    });
    const entry: PendingManual = { handle: null as never, resolve, cancelled: false };
    const handle: ReplicationHandle = {
      partitionId,
      brokerId,
      done,
      cancel: async () => {
        entry.cancelled = true;
        this.pending.delete(key);
        entry.resolve(false);
      },
    };
    entry.handle = handle;
    this.pending.set(key, entry);
    return handle;
  }

  /** 测试辅助：让指定复制成功结束。 */
  succeed(partitionId: string, brokerId: string): void {
    const entry = this.pending.get(this.key(partitionId, brokerId));
    if (!entry) throw new Error(`没有进行中的复制: ${this.key(partitionId, brokerId)}`);
    this.pending.delete(this.key(partitionId, brokerId));
    entry.resolve(true);
  }

  /** 测试辅助：让指定复制失败结束。 */
  fail(partitionId: string, brokerId: string): void {
    const entry = this.pending.get(this.key(partitionId, brokerId));
    if (!entry) throw new Error(`没有进行中的复制: ${this.key(partitionId, brokerId)}`);
    this.pending.delete(this.key(partitionId, brokerId));
    entry.resolve(false);
  }

  hasPending(partitionId: string, brokerId: string): boolean {
    return this.pending.has(this.key(partitionId, brokerId));
  }

  pendingKeys(): string[] {
    return [...this.pending.keys()].sort();
  }

  async deleteReplica(partitionId: string, brokerId: string): Promise<void> {
    if (this.deleteDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.deleteDelayMs));
    }
    this.deleted.push({ partitionId, brokerId });
  }

  /** 测试辅助：查看已确认删除的副本。 */
  deletedReplicas(): Array<{ partitionId: string; brokerId: string }> {
    return [...this.deleted];
  }
}

/** 自动适配器：复制经过固定延迟后成功，用于无需精细交错的场景。 */
export class AutoReplicationAdapter implements ReplicationAdapter {
  private readonly replicationDelayMs: number;

  constructor(replicationDelayMs = 5) {
    this.replicationDelayMs = replicationDelayMs;
  }

  startReplication(partitionId: string, brokerId: string): ReplicationHandle {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolve!: (ok: boolean) => void;
    const done = new Promise<boolean>((res) => {
      resolve = res;
    });
    timer = setTimeout(() => resolve(true), this.replicationDelayMs);
    return {
      partitionId,
      brokerId,
      done,
      cancel: async () => {
        if (timer) clearTimeout(timer);
        resolve(false);
      },
    };
  }

  async deleteReplica(): Promise<void> {
    // 自动适配器立即确认删除。
  }
}
