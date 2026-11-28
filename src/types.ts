// Core type definitions for the membership protocol.
// All syntax in this project is erasable so Node's native TypeScript
// loader (type stripping) can execute the files directly.

/** Lifecycle state of a member identity. */
export type MemberState = 'alive' | 'suspected' | 'dead' | 'left';

/** Terminal states permanently close an identity within its incarnation. */
export const TERMINAL_STATES: ReadonlySet<MemberState> = new Set(['dead', 'left']);

/**
 * A node identity. The same stable id can return after a confirmed death by
 * restarting with a strictly greater incarnation. `seq` (alive-declaration
 * sequence number) lets a live node refute a suspicion within one incarnation.
 */
export interface NodeIdentity {
  id: string;
  incarnation: number;
  seq: number;
}

/**
 * A full member record / gossip update.
 * `suspectDeadline` is only meaningful when state === 'suspected'. It is the
 * absolute virtual time at which a still-unrefuted suspicion becomes death.
 */
export interface MemberUpdate {
  id: string;
  incarnation: number;
  seq: number;
  state: MemberState;
  suspectDeadline?: number;
}

/** Compact digest exchanged periodically to repair lost gossip updates. */
export type DigestEntry = MemberUpdate;

/** A scheduled probe round toward one target. */
export interface OutstandingProbe {
  targetId: string;
  round: number;
  incarnation: number;
  seq: number;
  phase: 'direct' | 'indirect';
  indirectTimeoutAt?: number;
  helpers: string[];
}

/** Probe state kept on a helper node while it relays an indirect probe. */
export interface HelperWait {
  initiatorId: string;
  targetId: string;
  round: number;
  incarnation: number;
  seq: number;
  subRound: number;
  timeoutAt: number;
  cancelTimer: () => void;
}

/** Result of merging one incoming update against the local view. */
export interface MergeDecision {
  accepted: boolean;
  reason:
    | 'new-entry'
    | 'replaced-older'
    | 'incarnation-override'
    | 'suspect-over-alive-same-seq'
    | 'duplicate-noop'
    | 'rejected-stale'
    | 'rejected-terminal'
    | 'rejected-incarnation';
  previous?: MemberUpdate;
}

/** One entry in a node's explainable audit trail. */
export interface AuditEntry {
  at: number;
  nodeId: string;
  event: string;
  detail: Record<string, unknown>;
}

/**
 * Wire messages. Every message carries:
 *  - piggybacked gossip updates (bounded per message),
 *  - a compact digest of the sender's current view.
 * Acks bind to a concrete probe round and the probed target identity.
 */
export type Message =
  | {
      kind: 'ping';
      from: string;
      target: string;
      round: number;
      incarnation: number;
      seq: number;
      /** Set when a helper relays the ping, so its ack can be correlated. */
      subRound?: number;
      updates: MemberUpdate[];
      digest: DigestEntry[];
    }
  | {
      kind: 'ack';
      from: string;
      target: string;
      round: number;
      incarnation: number;
      seq: number;
      updates: MemberUpdate[];
      digest: DigestEntry[];
    }
  | {
      kind: 'indirect-ping';
      from: string;
      helper: string;
      target: string;
      round: number;
      incarnation: number;
      seq: number;
      subRound: number;
      updates: MemberUpdate[];
      digest: DigestEntry[];
    }
  | {
      kind: 'indirect-ack';
      from: string;
      helper: string;
      target: string;
      round: number;
      incarnation: number;
      seq: number;
      subRound: number;
      /** Whether the helper actually received an ack from the target. */
      success: boolean;
      updates: MemberUpdate[];
      digest: DigestEntry[];
    }
  | {
      kind: 'digest-sync';
      from: string;
      to: string;
      syncRound: number;
      updates: MemberUpdate[];
      digest: DigestEntry[];
    };

/** Injectable policy knobs. Every choice is deterministic in tests. */
export interface Selectors {
  /** Pick the next direct-probe target from current candidates. */
  pickTarget: (candidates: string[], selfId: string) => string | undefined;
  /** Pick up to n helper nodes for the indirect phase. */
  pickHelpers: (candidates: string[], targetId: string, n: number) => string[];
  /** Pick a peer for the periodic digest exchange. */
  pickDigestPeer: (candidates: string[], selfId: string) => string | undefined;
}

export interface NodeConfig {
  id: string;
  /** Probe period in virtual milliseconds. */
  probeInterval: number;
  /** Direct ping timeout before escalating to indirect probing. */
  directTimeout: number;
  /** Time budget for the indirect phase. */
  indirectTimeout: number;
  /** Number of helpers asked to relay an indirect probe. */
  indirectHelpers: number;
  /** How long a suspicion may remain unrefuted before it becomes death. */
  suspectTimeout: number;
  /** Period of the digest-based anti-entropy exchange. */
  digestInterval: number;
  /** Maximum gossip updates attached to one outbound message. */
  maxPiggyback: number;
  /** Maximum length of the pending forward (gossip) queue. */
  maxPendingQueue: number;
  /** Peers to probe before any member view has been learned. */
  bootstrapPeers?: string[];
  selectors: Selectors;
}

export interface TransportSendResult {
  delivered: boolean;
  reason: 'delivered' | 'dropped-link-down' | 'dropped-unknown-peer' | 'queued';
}

/** Fully controllable transport abstraction. */
export interface Transport {
  register(nodeId: string, handler: (msg: Message) => void): void;
  unregister(nodeId: string): void;
  send(msg: Message, to: string): TransportSendResult;
  getStats(): Record<string, number>;
}

/** Controllable clock abstraction. */
export interface Clock {
  now(): number;
  setTimer(delayMs: number, fn: () => void): () => void;
}
