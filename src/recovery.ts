import {
  RecoveryUndeterminedError,
  ResetRequiredError,
  TokenMismatchError,
} from './types.ts';
import type {
  BrokerAdapter,
  EpochQueryResponse,
  FetchBatch,
  RecoveryOutcome,
  RecoveryStats,
} from './types.ts';
import type { TicketStore } from './ticket-store.ts';

export interface RecoveryOptions {
  /** epoch 查询总预算（跨所有轮次累计），耗尽返回未定。 */
  queryBudget: number;
  /** token 变更导致重做的最大轮数，超过返回未定（token 不稳定）。 */
  maxRounds?: number;
}

export interface RecoveryResult {
  outcome: RecoveryOutcome;
  stats: RecoveryStats;
}

const STALE: unique symbol = Symbol('stale-round');

/**
 * 消费位置恢复。
 *
 * 流程：取日志快照绑定 token → 从本地票据最新 epoch 向最旧逐个向 broker
 * 求证 → 第一个双方都有证明的共同 epoch 即恢复点，位置取
 * min(本地该 epoch 已处理边界, broker 该 epoch 有效末端)。
 *
 * 保证：
 * - 没有共同证明、或推得位置早于保留起点 → reset-required，绝不静默跳到最新；
 * - 本轮内 token 变更（查询被拒 / token watch 触发 / 回包 token 不符）→
 *   丢弃本轮全部推导，用新快照重做；
 * - 轮次作废后到达的迟到回包只计入 stats.discardedLateReplies，
 *   不会覆盖已经确定的新恢复结果；
 * - 预算耗尽或 token 持续不稳定 → undetermined。
 */
export async function recoverPosition(
  store: TicketStore,
  adapter: BrokerAdapter,
  options: RecoveryOptions,
): Promise<RecoveryResult> {
  if (!Number.isInteger(options.queryBudget) || options.queryBudget < 0) {
    throw new TypeError('queryBudget must be a non-negative integer');
  }
  const ticket = await store.load();
  const maxRounds = options.maxRounds ?? 4;
  const stats: RecoveryStats = { epochQueries: 0, rounds: 0, discardedLateReplies: 0 };
  let budget = options.queryBudget;
  let generation = 0;

  for (;;) {
    if (stats.rounds >= maxRounds) {
      return {
        outcome: {
          kind: 'undetermined',
          reason: 'token-unstable',
          detail: `log token changed in ${stats.rounds} consecutive rounds; recovery cannot converge`,
        },
        stats,
      };
    }
    stats.rounds += 1;

    const snapshot = await adapter.getLogSnapshot();
    const token = snapshot.token;
    const gen = ++generation;
    const tokenWatch = adapter.waitForTokenChange(token);
    // watch 只在本轮内有意义；避免无人处理的 rejection。
    void Promise.resolve(tokenWatch).catch(() => {});

    let redo = false;
    for (let i = ticket.length - 1; i >= 0; i -= 1) {
      if (budget <= 0) {
        return {
          outcome: {
            kind: 'undetermined',
            reason: 'query-budget-exhausted',
            detail: `epoch query budget exhausted after ${stats.epochQueries} queries`,
          },
          stats,
        };
      }
      budget -= 1;
      stats.epochQueries += 1;

      const entry = ticket[i];
      const query = adapter.queryEpoch(entry.leaderEpoch, token);
      // 迟到回包守卫：轮次作废（generation 前进）后才 settle 的响应只计数、不生效。
      void query.then(
        () => {
          if (gen !== generation) stats.discardedLateReplies += 1;
        },
        () => {
          if (gen !== generation) stats.discardedLateReplies += 1;
        },
      );

      let response: EpochQueryResponse | typeof STALE;
      try {
        response = await Promise.race([query, tokenWatch.then((): typeof STALE => STALE)]);
      } catch (err) {
        if (err instanceof TokenMismatchError) {
          redo = true; // token 已变：丢弃本轮推导
          break;
        }
        throw err;
      }
      if (response === STALE || gen !== generation || response.token !== token) {
        redo = true; // token watch 触发或回包绑定的不是本轮 token
        break;
      }

      if (response.proof.kind === 'diverged') continue; // 该 epoch 已不保留，试更旧的

      const position = Math.min(entry.nextOffset, response.proof.endOffset);
      if (position < snapshot.retentionStart) {
        return {
          outcome: {
            kind: 'reset-required',
            reason: 'before-retention-start',
            detail:
              `recovered position ${position} (epoch ${entry.leaderEpoch}) is before ` +
              `retention start ${snapshot.retentionStart}; explicit reset required`,
          },
          stats,
        };
      }
      return {
        outcome: { kind: 'recovered', position, token, leaderEpoch: entry.leaderEpoch },
        stats,
      };
    }

    if (!redo) {
      return {
        outcome: {
          kind: 'reset-required',
          reason: 'no-common-epoch',
          detail:
            'no leader epoch from the local ticket is retained by the broker; ' +
            'explicit reset required (refusing to silently jump to latest)',
        },
        stats,
      };
    }
    // token 变更：丢弃本轮推导，用新快照重做。
  }
}

/**
 * 调用方继续消费的入口：只有 recovered 结论才能发起首次 fetch，
 * 且 fetch 绑定恢复结论中的 token（适配器原子校验）。
 */
export async function resumeConsumption(
  adapter: BrokerAdapter,
  result: RecoveryResult,
): Promise<FetchBatch> {
  const { outcome } = result;
  if (outcome.kind === 'reset-required') {
    throw new ResetRequiredError(outcome.detail);
  }
  if (outcome.kind === 'undetermined') {
    throw new RecoveryUndeterminedError(outcome.detail);
  }
  return adapter.fetch(outcome.position, outcome.token);
}
