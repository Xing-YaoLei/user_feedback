/**
 * Durable, append-only local journal.
 *
 * Every dispatch is written (and fsynced) *before* the adapter is invoked, so a
 * process that dies after the participant applied the effect but before the
 * local result was recorded still leaves a `*_dispatched` record behind. On
 * recovery that record is turned into an in-doubt operation, and the participant
 * is queried with the very same operation id.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export type JournalEventType =
  | 'change_started'
  | 'cancel_accepted'
  | 'abort_recorded'
  | 'execute_dispatched'
  | 'execute_unresolved'
  | 'execute_resolved'
  | 'compensation_dispatched'
  | 'compensation_unresolved'
  | 'compensation_resolved'
  | 'compensation_retry_scheduled';

export interface JournalEvent {
  version: 1;
  at: string;
  changeId: string;
  type: JournalEventType;
  stepId?: string;
  data?: Record<string, unknown>;
}

export interface Journal {
  /** Must be durable before the call returns. */
  append(event: JournalEvent): void;
  readAll(): JournalEvent[];
}

export interface FileJournalOptions {
  /** Fsync every append. Defaults to true; only turn off for throw-away tests. */
  fsync?: boolean;
}

export class FileJournal implements Journal {
  readonly path: string;
  private readonly doFsync: boolean;

  constructor(path: string, options: FileJournalOptions = {}) {
    this.path = path;
    this.doFsync = options.fsync !== false;
    mkdirSync(dirname(path), { recursive: true });
  }

  append(event: JournalEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, line);
      if (this.doFsync) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  readAll(): JournalEvent[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    if (text.length === 0) return [];

    const lines = text.split('\n');
    const events: JournalEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index].trim();
      if (raw.length === 0) continue;
      try {
        const parsed = JSON.parse(raw) as JournalEvent;
        validateEvent(parsed);
        events.push(parsed);
      } catch (error) {
        const isTrailingLine = lines.slice(index + 1).every((line) => line.trim().length === 0);
        // A torn final line is what a crash in the middle of append looks like.
        if (isTrailingLine) break;
        throw new Error(
          `corrupt journal at ${this.path} line ${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return events;
  }
}

function validateEvent(event: JournalEvent): void {
  if (event === null || typeof event !== 'object') throw new Error('event is not an object');
  if (event.version !== 1) throw new Error('unsupported journal version');
  if (typeof event.changeId !== 'string' || event.changeId.length === 0) {
    throw new Error('event has no changeId');
  }
  if (typeof event.type !== 'string') throw new Error('event has no type');
  if (typeof event.at !== 'string') throw new Error('event has no timestamp');
}
