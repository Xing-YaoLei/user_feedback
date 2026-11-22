/**
 * Test/caller convenience layer: owns one RaftNode plus its durable store and
 * can recreate the node process against the same data directory (restart).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Network } from './network.ts';
import { PersistentStore } from './persistence.ts';
import { RaftNode } from './raft.ts';
import type { RaftNodeOptions } from './raft.ts';
import type { Scheduler } from './scheduler.ts';
import type { NodeId, RaftConfig, StateMachine } from './types.ts';

export class ClusterNode<S> {
  readonly id: NodeId;
  private node: RaftNode<S> | null = null;
  private store: PersistentStore<S>;
  private readonly sm: StateMachine<S>;
  private readonly scheduler: Scheduler;
  private readonly network: Network;
  readonly dataDir: string;
  private readonly bootstrapConfig: RaftConfig;
  private readonly options: RaftNodeOptions;

  constructor(
    id: NodeId,
    sm: StateMachine<S>,
    scheduler: Scheduler,
    network: Network,
    dataDir: string,
    bootstrapConfig: RaftConfig,
    options: RaftNodeOptions = {},
  ) {
    this.id = id;
    this.sm = sm;
    this.scheduler = scheduler;
    this.network = network;
    this.dataDir = dataDir;
    this.bootstrapConfig = bootstrapConfig;
    this.options = options;
    mkdirSync(dataDir, { recursive: true });
    this.store = new PersistentStore(dataDir, sm.initial, bootstrapConfig);
    this.boot();
  }

  private boot(): void {
    this.node = new RaftNode(
      this.id,
      this.sm,
      this.scheduler,
      this.network,
      this.store,
      this.bootstrapConfig,
      this.options,
    );
    this.node.start();
  }

  get api(): RaftNode<S> {
    if (!this.node) throw new Error(`node ${this.id} is stopped`);
    return this.node;
  }

  get running(): boolean {
    return this.node !== null;
  }

  /** Simulate a process crash + restart: durable state survives, volatile state resets. */
  restart(): void {
    this.node?.stop();
    this.node = null;
    // Recreate the store too, exactly like a fresh process opening the directory.
    this.store = new PersistentStore(
      this.dataDir,
      this.sm.initial,
      this.bootstrapConfig,
    );
    this.boot();
  }

  /** Permanent shutdown (files remain on disk). */
  shutdown(): void {
    this.node?.stop();
    this.node = null;
  }
}

export interface ClusterSpec {
  ids: NodeId[];
  baseDir: string;
}

export function bootstrapConfigFor(ids: NodeId[]): RaftConfig {
  return { id: 0, voters: [...ids].sort() };
}

export function nodeDataDir(baseDir: string, id: NodeId): string {
  return join(baseDir, `node-${id}`);
}
