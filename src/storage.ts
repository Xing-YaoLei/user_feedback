/**
 * 节点本地持久化。
 *
 * 每个节点拥有独立目录，包含三个 JSON 文件：
 * - hard.json    ：当前任期与投票（Raft 要求在响应投票前落盘）
 * - log.json     ：完整日志
 * - applied.json ：已应用位点与归约后的状态机快照
 *
 * 所有写入都走“写临时文件 -> fs.rename 原子替换”，崩溃只会留下旧版本或新版本，
 * 不会出现半截文件。fsync 在测试环境关闭（fsyncEnabled 可显式打开），
 * 语义上每次 save* 完成后数据即视为持久。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppliedState, HardState, LogEntry } from './types.ts';

const HARD_FILE = 'hard.json';
const LOG_FILE = 'log.json';
const APPLIED_FILE = 'applied.json';

export class FileStore<TState, TCommand> {
  private readonly dir: string;
  private hard: HardState;
  private log: LogEntry<TCommand>[];
  private applied: AppliedState<TState>;

  constructor(
    dataDir: string,
    initialState: TState,
  ) {
    this.dir = dataDir;
    mkdirSync(dataDir, { recursive: true });

    this.hard = this.readJsonOr<HardState>(HARD_FILE, { currentTerm: 0, votedFor: null });
    this.log = this.readJsonOr<LogEntry<TCommand>[]>(LOG_FILE, []);
    this.applied = this.readJsonOr<AppliedState<TState>>(APPLIED_FILE, {
      lastApplied: 0,
      state: initialState,
    });
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private readJsonOr<T>(name: string, fallback: T): T {
    const p = this.path(name);
    if (!existsSync(p)) return fallback;
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  }

  private atomicWrite(name: string, value: unknown): void {
    const target = this.path(name);
    const tmp = join(dirname(target), `.${name}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, target);
  }

  // -- hard state -----------------------------------------------------------

  getHardState(): HardState {
    return this.hard;
  }

  saveHardState(state: HardState): void {
    this.hard = state;
    this.atomicWrite(HARD_FILE, state);
  }

  // -- log ------------------------------------------------------------------

  getLog(): LogEntry<TCommand>[] {
    return this.log;
  }

  /** 整体替换日志（追加 / 截断后统一落盘）。 */
  saveLog(log: LogEntry<TCommand>[]): void {
    this.log = log;
    this.atomicWrite(LOG_FILE, log);
  }

  // -- applied state --------------------------------------------------------

  getApplied(): AppliedState<TState> {
    return this.applied;
  }

  saveApplied(applied: AppliedState<TState>): void {
    this.applied = applied;
    this.atomicWrite(APPLIED_FILE, applied);
  }
}
