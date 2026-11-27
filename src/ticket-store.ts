import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EpochTicketEntry } from './types.ts';

export class TicketValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketValidationError';
  }
}

/**
 * 校验票据：leaderEpoch 严格递增（按经历顺序保存），nextOffset 单调不减。
 * 票据损坏时宁可报错也不让调用方基于错乱的历史恢复。
 */
export function validateTicket(entries: unknown): EpochTicketEntry[] {
  if (!Array.isArray(entries)) {
    throw new TicketValidationError('ticket must be an array of epoch entries');
  }
  let prevEpoch = -1;
  let prevOffset = -1;
  return entries.map((raw, index) => {
    const e = raw as EpochTicketEntry;
    if (
      e === null ||
      typeof e !== 'object' ||
      !Number.isInteger(e.leaderEpoch) ||
      e.leaderEpoch < 0 ||
      !Number.isInteger(e.nextOffset) ||
      e.nextOffset < 0
    ) {
      throw new TicketValidationError(`invalid ticket entry at index ${index}`);
    }
    if (e.leaderEpoch <= prevEpoch) {
      throw new TicketValidationError('leader epochs must be strictly increasing');
    }
    if (e.nextOffset < prevOffset) {
      throw new TicketValidationError('next offsets must be non-decreasing');
    }
    prevEpoch = e.leaderEpoch;
    prevOffset = e.nextOffset;
    return { leaderEpoch: e.leaderEpoch, nextOffset: e.nextOffset };
  });
}

/** 本地票据存储：按顺序保存已经历的 leaderEpoch 及各自确认处理到的下一 offset。 */
export interface TicketStore {
  load(): Promise<EpochTicketEntry[]>;
  save(entries: EpochTicketEntry[]): Promise<void>;
}

export class InMemoryTicketStore implements TicketStore {
  private entries: EpochTicketEntry[];
  constructor(initial: EpochTicketEntry[] = []) {
    this.entries = validateTicket(initial);
  }
  load(): Promise<EpochTicketEntry[]> {
    return Promise.resolve(this.entries.map((e) => ({ ...e })));
  }
  save(entries: EpochTicketEntry[]): Promise<void> {
    this.entries = validateTicket(entries);
    return Promise.resolve();
  }
}

/** 文件票据：先写临时文件再 rename，崩溃时不会留下半截票据。 */
export class FileTicketStore implements TicketStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<EpochTicketEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TicketValidationError(`ticket file ${this.path} is not valid JSON`);
    }
    return validateTicket(parsed);
  }

  async save(entries: EpochTicketEntry[]): Promise<void> {
    const valid = validateTicket(entries);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(valid, null, 2));
    await rename(tmp, this.path);
  }
}
