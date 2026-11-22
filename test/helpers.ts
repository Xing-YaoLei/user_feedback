/**
 * Shared helpers for the test suite: deterministic cluster construction on
 * temporary in-workspace directories, leader discovery and log assertions.
 */

import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterNode, bootstrapConfigFor, nodeDataDir } from '../src/cluster.ts';
import { kvStateMachine } from '../src/kv.ts';
import type { KvState } from '../src/kv.ts';
import { Network } from '../src/network.ts';
import { RaftNode } from '../src/raft.ts';
import { Scheduler } from '../src/scheduler.ts';
import { RaftError } from '../src/types.ts';
import type { LogEntry, NodeId, RaftConfig } from '../src/types.ts';

export interface Harness {
  baseDir: string;
  scheduler: Scheduler;
  network: Network;
  config: RaftConfig;
  nodes: Map<NodeId, ClusterNode<KvState>>;
  cleanup: () => void;
}

let counter = 0;
// Every harness registers process-level cleanup so live virtual timers cannot
// keep the Node test process alive after the test finishes.
const cleanups: Array<() => void> = [];
after(() => {
  while (cleanups.length) cleanups.pop()!();
});

export function makeHarness(
  ids: NodeId[],
  opts: { seed?: number; chaos?: ConstructorParameters<typeof Network>[1] } = {},
): Harness {
  const baseDir = mkdtempSync(
    join(tmpdir(), `raft-test-${process.pid}-${counter++}-`),
  );
  const scheduler = new Scheduler(opts.seed ?? 42);
  const network = new Network(scheduler, opts.chaos ?? {});
  const config = bootstrapConfigFor(ids);
  const nodes = new Map<NodeId, ClusterNode<KvState>>();
  for (const id of ids) {
    nodes.set(
      id,
      new ClusterNode(
        id,
        kvStateMachine,
        scheduler,
        network,
        nodeDataDir(baseDir, id),
        config,
      ),
    );
  }
  const cleanup = (): void => {
    for (const n of nodes.values()) {
      if (n.running) n.shutdown();
    }
    rmSync(baseDir, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return {
    baseDir,
    scheduler,
    network,
    config,
    nodes,
    cleanup,
  };
}

export function addNode(
  h: Harness,
  id: NodeId,
): ClusterNode<KvState> {
  const node = new ClusterNode(
    id,
    kvStateMachine,
    h.scheduler,
    h.network,
    nodeDataDir(h.baseDir, id),
    h.config,
  );
  h.nodes.set(id, node);
  return node;
}

export function leader(h: Harness): RaftNode<KvState> | undefined {
  for (const n of h.nodes.values()) {
    if (n.running && n.api.getRole() === 'leader') return n.api;
  }
  return undefined;
}

/**
 * Client-style write that follows leadership changes: on NOT_LEADER/DEPOSED
 * it waits for a new leader and retries the same idempotent command.
 */
export async function writeThroughLeader(
  h: Harness,
  command: import('../src/kv.ts').KvCommand,
  attempts = 8,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = leader(h);
    if (!current) {
      await h.scheduler.advance(100);
      continue;
    }
    try {
      const entry = await current.write(command, 800);
      await waitForApply(h, entry.index, 1500);
      return;
    } catch (err) {
      if (
        err instanceof RaftError &&
        (err.code === 'NOT_LEADER' || err.code === 'DEPOSED' || err.code === 'TIMEOUT')
      ) {
        await h.scheduler.advance(120);
        continue;
      }
      throw err;
    }
  }
  throw new Error('writeThroughLeader: exhausted retries');
}

export async function waitForLeader(
  h: Harness,
  timeoutMs = 3000,
): Promise<RaftNode<KvState>> {
  await h.scheduler.runUntil(() => leader(h) !== undefined, timeoutMs);
  return leader(h)!;
}

/**
 * Advance the cluster until every live, reachable member has applied through
 * `index`. Nodes explicitly listed in `except` (e.g. an intentionally
 * partitioned node) are skipped.
 */
export async function waitForApply(
  h: Harness,
  index: number,
  timeoutMsOrExcept?: number | NodeId[],
  maybeTimeout?: number,
): Promise<void> {
  const except = Array.isArray(timeoutMsOrExcept) ? timeoutMsOrExcept : [];
  const timeoutMs =
    typeof timeoutMsOrExcept === 'number' ? timeoutMsOrExcept : (maybeTimeout ?? 3000);
  const skipped = new Set(except);
  await h.scheduler.runUntil(
    () =>
      [...h.nodes.values()].every(
        (n) =>
          !n.running ||
          skipped.has(n.id) ||
          n.api.getLastApplied() >= index,
      ),
    timeoutMs,
  );
}

export function commandEntries(h: Harness): LogEntry[] {
  const anyNode = [...h.nodes.values()].find((n) => n.running)!;
  return anyNode.api
    .getLog()
    .filter(
      (e) =>
        e.index > 0 &&
        !(e.command as { type?: string } | null)?.type?.startsWith?.('__'),
    );
}

/** The same log position must hold the same command on every live node. */
export function assertLogsConverged(h: Harness): void {
  const reference = [...h.nodes.values()]
    .find((n) => n.running)!
    .api.getLog()
    .map((e) => ({ index: e.index, term: e.term, command: e.command }));
  for (const n of h.nodes.values()) {
    if (!n.running) continue;
    const got = n.api
      .getLog()
      .map((e) => ({ index: e.index, term: e.term, command: e.command }));
    if (JSON.stringify(got) !== JSON.stringify(reference)) {
      throw new Error(
        `log divergence on node ${n.id}:\n${JSON.stringify(got, null, 2)}\nvs\n${JSON.stringify(reference, null, 2)}`,
      );
    }
  }
}

export function assertCommittedState(
  h: Harness,
  expected: KvState,
): void {
  for (const n of h.nodes.values()) {
    if (!n.running) continue;
    const got = n.api.getAppliedState();
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      throw new Error(
        `applied state mismatch on ${n.id}: ${JSON.stringify(got)} !== ${JSON.stringify(expected)}`,
      );
    }
  }
}
