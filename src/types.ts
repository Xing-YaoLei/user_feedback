/**
 * Shared types for the Raft coordinator.
 *
 * The module is intentionally dependency-free and uses plain JSON-serialisable
 * data so every persistent record can be written to disk as JSON.
 */

export type NodeId = string;

/** A client command is an opaque value interpreted by the supplied reduce function. */
export type Command = unknown;

/** Cluster configuration. During a joint transition voters equals oldVoters ∪ newVoters. */
export interface RaftConfig {
  /** Unique identifier of the configuration (log index of the config entry). */
  id: number;
  voters: NodeId[];
  /** Defined only while a joint (C_old,new) configuration is active. */
  joint?: {
    oldVoters: NodeId[];
    newVoters: NodeId[];
  };
}

export interface LogEntry {
  term: number;
  index: number;
  command: Command;
  /** Configuration entries change the cluster configuration; ordinary entries leave this undefined. */
  config?: RaftConfig;
}

export type Role = 'follower' | 'candidate' | 'leader';

/** Deterministic state reduction supplied by the caller. */
export interface StateMachine<S> {
  /** Initial state, also used when replaying the durable log after a restart. */
  initial(): S;
  reduce(state: S, command: Command, index: number, term: number): S;
}

/* ------------------------------------------------------------------ */
/* Wire messages                                                       */
/* ------------------------------------------------------------------ */

export interface RequestVoteRequest {
  type: 'RequestVote';
  term: number;
  candidateId: NodeId;
  lastLogIndex: number;
  lastLogTerm: number;
}

export interface RequestVoteResponse {
  type: 'RequestVoteResp';
  term: number;
  voterId: NodeId;
  granted: boolean;
}

export interface AppendEntriesRequest {
  type: 'AppendEntries';
  term: number;
  leaderId: NodeId;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: LogEntry[];
  leaderCommit: number;
  /**
   * Heartbeats carry the index the leader needs an acknowledgement for so that
   * read-index quorum confirmation can piggy-back on AppendEntries traffic.
   */
  readBarrier?: number;
  /** Monotonic confirmation round for a linearizable read (ReadIndex). */
  barrierRound?: number;
}

export interface AppendEntriesResponse {
  type: 'AppendEntriesResp';
  term: number;
  followerId: NodeId;
  success: boolean;
  /** Last log index the follower reports (match index on success, conflict hint on failure). */
  matchIndex: number;
  /** Term of the conflicting entry, when known — helps the leader backtrack efficiently. */
  conflictTerm?: number;
  /** Echoes the read barrier index this response acknowledges. */
  readBarrier?: number;
  /** Echoes the confirmation round this response acknowledges. */
  barrierRound?: number;
}

export type RaftMessage =
  | RequestVoteRequest
  | RequestVoteResponse
  | AppendEntriesRequest
  | AppendEntriesResponse;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class RaftError extends Error {
  readonly code:
    | 'NOT_LEADER'
    | 'DEPOSED'
    | 'CONFIG_BUSY'
    | 'TIMEOUT'
    | 'SHUTDOWN'
    | 'BAD_CONFIG';

  constructor(
    message: string,
    code:
      | 'NOT_LEADER'
      | 'DEPOSED'
      | 'CONFIG_BUSY'
      | 'TIMEOUT'
      | 'SHUTDOWN'
      | 'BAD_CONFIG',
  ) {
    super(message);
    this.name = 'RaftError';
    this.code = code;
  }
}

export function quorumSize(n: number): number {
  return Math.floor(n / 2) + 1;
}

export function sameVoters(a: NodeId[], b: NodeId[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
