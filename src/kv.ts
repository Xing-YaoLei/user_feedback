/**
 * Example caller-supplied state machine: a string key/value store reduced by
 * deterministic SET/DELETE commands. Commands are JSON-serialisable so the
 * applied snapshot can be persisted verbatim.
 */

import type { Command, StateMachine } from './types.ts';

export interface KvCommand {
  op: 'SET' | 'DELETE';
  key: string;
  value?: string;
}

export type KvState = Record<string, string>;

export const kvStateMachine: StateMachine<KvState> = {
  initial(): KvState {
    return {};
  },
  reduce(state: KvState, command: Command): KvState {
    const cmd = command as KvCommand;
    const next: KvState = { ...state };
    if (cmd.op === 'SET') {
      next[cmd.key] = cmd.value ?? '';
    } else if (cmd.op === 'DELETE') {
      delete next[cmd.key];
    }
    return next;
  },
};

/**
 * A command builder whose SET operations are idempotent: re-driving the same
 * logical command after a crash/timeout produces the same state and the same
 * log entry payload, which chaos tests rely on.
 */
export function setCmd(key: string, value: string): KvCommand {
  return { op: 'SET', key, value };
}

export function deleteCmd(key: string): KvCommand {
  return { op: 'DELETE', key };
}
