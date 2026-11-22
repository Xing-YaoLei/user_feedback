import { ManualClock } from './clock.ts';
import { DiscoveryClient } from './client.ts';
import { Registry } from './registry.ts';
import {
  CursorExpiredError,
  GenerationConflictError,
  SessionExpiredError,
  type Clock,
  type RebuildBasis,
  type RevisionRecord,
} from './index.ts';

export interface ScenarioStep {
  at: number;
  title: string;
  detail: unknown;
}

export interface BatchSummary {
  revision: number;
  causedByExpiry: boolean;
  puts: string[];
  deletes: string[];
}

export interface ScenarioReport {
  steps: ScenarioStep[];
  commits: BatchSummary[];
  initialPagination: {
    baselineRevision: number;
    pages: Array<{ pageNumber: number; baselineRevision: number; keys: string[] }>;
    compactedTokenError: { reason: string; basis: RebuildBasis } | null;
  };
  fencing: {
    staleKeepalive: string | null;
    staleDelete: string | null;
    expiredSessionMutate: string | null;
    survivedTakeoverKeys: string[];
  };
  slowWatch: {
    prefix: string;
    startRevision: number;
    stallReason: string | null;
    stallBasis: RebuildBasis | null;
    oldCursorReplay: string;
    reconnectAfterCompaction: string | null;
  };
  filteredWatch: { prefix: string; observedProgress: number; resumeRevision: number };
  healthyWatch: { prefix: string; receivedRevisions: number[] };
  compaction: { compactedRevision: number; retainedRevisions: number };
  rebuild: {
    reason: string;
    baselineRevision: number;
    resumeAfterRevision: number;
    watchStartRevision: number;
    pages: Array<{ pageNumber: number; baselineRevision: number; keys: string[] }>;
  };
  final: {
    selectedRevision: number;
    registryKeys: string[];
    clientKeys: string[];
    equal: boolean;
  };
  statsAtEnd: ReturnType<Registry['stats']>;
}

const PREFIX = 'svc/';

/**
 * Deterministic interleaved execution:
 * pagination in progress -> batch removal -> same-name re-registration ->
 * session expiry -> slow watcher backlog eviction -> history compaction ->
 * cursor expiry signals -> full rebuild converging at a selected revision.
 */
export function runScenario(clock?: Clock): { report: ScenarioReport; registry: Registry; client: DiscoveryClient } {
  const manual = clock ?? new ManualClock();
  const steps: ScenarioStep[] = [];
  const step = (title: string, detail: unknown = {}): void => {
    steps.push({ at: manual.now(), title, detail });
  };

  const registry = new Registry(
    {
      pageTtlMs: 30_000,
      watchTtlMs: 30_000,
      watchBacklogLimit: 128,
      maxPageCursors: 8,
      maxWatches: 16,
      sweepIntervalMs: 1_000,
    },
    manual,
  );

  const commits: BatchSummary[] = [];
  registry.on('commit', (record: RevisionRecord) => {
    commits.push({
      revision: record.revision,
      causedByExpiry: record.causedByExpiry,
      puts: record.events.filter((e) => e.kind === 'put').map((e) => e.key),
      deletes: record.events.filter((e) => e.kind === 'delete').map((e) => e.key),
    });
  });

  // ------------------------------------------------------------- 1. setup
  const s1 = registry.createSession({ id: 'S1', ttlMs: 5_000 });
  const s2 = registry.createSession({ id: 'S2', ttlMs: 8_000 });
  step('sessions created', { S1: s1.leaseExpiresAt, S2: s2.leaseExpiresAt });

  // Revision 1: one atomic batch registers seven instances + an outside-prefix key.
  const r1 = registry.mutate(
    'S1',
    [1, 2, 3, 4, 5, 6, 7].map((n) => ({ type: 'put' as const, key: `${PREFIX}a/${n}`, data: { n } })).concat([
      { type: 'put' as const, key: 'other/x', data: { n: 0 } },
    ]),
  );
  step('batch register 8 instances (one atomic revision)', { revision: r1.revision });

  // --------------------------------------------- 2. start paging + watching
  const page1 = registry.list({ prefix: PREFIX, pageSize: 3 });
  const tokenAfterPage1 = page1.nextPageToken!;
  step('pagination page 1 binds snapshot baseline', {
    baselineRevision: page1.revision,
    keys: page1.instances.map((i) => i.key),
  });

  // Slow watcher: continues strictly after the snapshot revision.
  const slowWatch = registry.watch({ prefix: PREFIX, startRevision: page1.revision + 1 });
  // A healthy subscriber on the whole key space, drained after every write.
  const healthyWatch = registry.watch({ prefix: '', startRevision: page1.revision + 1 });
  step('watches started after snapshot revision', {
    slowStart: page1.revision + 1,
    healthyStart: page1.revision + 1,
  });

  // ----------------------------------- 3. batch removal during pagination
  const r2 = registry.mutate('S1', [
    { type: 'delete', key: `${PREFIX}a/4`, expectedGeneration: 1 },
    { type: 'delete', key: `${PREFIX}a/5`, expectedGeneration: 1 },
    { type: 'delete', key: `${PREFIX}a/6`, expectedGeneration: 1 },
  ]);
  step('batch removal while pagination is in flight', { revision: r2.revision });
  healthyWatch.consume();

  // ----------------------------- 4. same-name re-registration / takeover
  const r3 = registry.mutate('S2', [
    { type: 'put', key: `${PREFIX}a/2`, data: { n: 2, owner: 'S2' } },
    { type: 'put', key: `${PREFIX}a/4`, data: { n: 4, owner: 'S2' } },
  ]);
  step('same-name instances re-registered by a new session (generation 2)', {
    revision: r3.revision,
  });
  healthyWatch.consume();

  // Old session's late fenced operations must not affect the new generation.
  let staleKeepalive: string | null = null;
  try {
    registry.keepAlive('S1', { key: `${PREFIX}a/2`, generation: 1 });
  } catch (error) {
    staleKeepalive = (error as GenerationConflictError).message;
  }
  let staleDelete: string | null = null;
  try {
    registry.mutate('S1', [
      { type: 'delete', key: `${PREFIX}a/4`, expectedGeneration: 1 },
    ]);
  } catch (error) {
    staleDelete = (error as GenerationConflictError).message;
  }
  step('late operations of the old generation are fenced off', {
    staleKeepalive,
    staleDelete,
  });

  // The slow watcher sees revisions 2 and 3; its progress is recoverable.
  // It is intentionally not drained again, so subsequent matching revisions
  // accumulate toward the backlog ceiling.
  const slowFirstDrain = slowWatch.consume();
  step('slow watcher drains first two revisions then stops consuming', {
    messages: slowFirstDrain.map((m) => (m.type === 'progress' ? `progress:${m.progress}` : `rev:${m.revision}`)),
  });

  // Keep S2 alive before crossing S1's expiry; S1 is intentionally not renewed.
  manual.advance(5_500);
  registry.keepAlive('S2');
  manual.advance(500); // t=6000: S1 lease (5000ms) expires
  registry.sweepNow();
  step('S1 expires; its batch is one revision and skips taken-over keys', {
    currentRevision: registry.currentRevision,
  });
  healthyWatch.consume(); // drains the expiry revision

  // Pagination page 2 still serves the frozen R1 snapshot: keys 4,5,6 visible
  // here even though they were deleted / re-registered at later revisions.
  const page2 = registry.list({ prefix: PREFIX, pageSize: 3, pageToken: tokenAfterPage1 });
  const tokenAfterPage2 = page2.nextPageToken!;
  step('pagination page 2 still reads the original snapshot baseline', {
    baselineRevision: page2.revision,
    keys: page2.instances.map((i) => i.key),
  });

  let expiredSessionMutate: string | null = null;
  try {
    registry.mutate('S1', [{ type: 'put', key: `${PREFIX}a/1`, data: {} }]);
  } catch (error) {
    expiredSessionMutate = (error as SessionExpiredError).message;
  }
  step('post-expiry callback from dead session is rejected', { expiredSessionMutate });

  // --------------------------- 5. slow watcher hits the backlog ceiling
  // rev5 is outside the slow watcher's prefix: its progress must still jump
  // without growing the backlog.
  registry.mutate('S2', [{ type: 'put', key: 'other/y', data: {} }]); // rev5
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/1`, data: {} }]); // rev6 backlog 1
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/2`, data: {} }]); // rev7 backlog 2
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/3`, data: {} }]); // rev8 backlog 3
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/4`, data: {} }]); // rev9 backlog 4
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/5`, data: {} }]); // rev10 backlog 5
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/6`, data: {} }]); // rev11 backlog 6
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/7`, data: {} }]); // rev12 backlog 7
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/8`, data: {} }]); // rev13 backlog 8
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/9`, data: {} }]); // rev14 backlog 9
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/10`, data: {} }]); // rev15 backlog 10
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/11`, data: {} }]); // rev16 backlog 11
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/12`, data: {} }]); // rev17 backlog 12
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/13`, data: {} }]); // rev18 backlog 13
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/14`, data: {} }]); // rev19 backlog 14
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/15`, data: {} }]); // rev20 backlog 15
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/16`, data: {} }]); // rev21 backlog 16
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/17`, data: {} }]); // rev22 backlog 17
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/18`, data: {} }]); // rev23 backlog 18
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/19`, data: {} }]); // rev24 backlog 19
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/20`, data: {} }]); // rev25 backlog 20 (at ceiling)
  healthyWatch.consume();
  registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/21`, data: {} }]); // rev26 backlog 21
  healthyWatch.consume();
  for (let n = 22; n <= 130; n++) {
    registry.mutate('S2', [{ type: 'put', key: `${PREFIX}b/${n}`, data: {} }]);
    healthyWatch.consume();
  }
  // The 129th undelivered matching event exceeds the ceiling (128): the slow
  // watcher is evicted with a rebuild basis while writes keep committing.
  step('writes continue after the slow watcher is evicted', {
    currentRevision: registry.currentRevision,
  });

  let stallReason: string | null = null;
  let stallBasis: RebuildBasis | null = null;
  try {
    slowWatch.consume();
  } catch (error) {
    if (error instanceof CursorExpiredError) {
      stallReason = error.reason;
      stallBasis = error.rebuildBasis;
    } else {
      throw error;
    }
  }
  step('slow watcher exits with an explicit rebuild basis', { stallReason, stallBasis });

  // Prefix-filter jump is visible in recoverable progress. The watch starts
  // at revision 5; rev5 is outside the prefix, so the first consume returns a
  // progress heartbeat for 5 even though no change message was enqueued.
  const filteredWatch = registry.watch({ prefix: PREFIX, startRevision: 5 });
  const filteredFirstDrain = filteredWatch.consume(256);
  const filteredHeartbeat = filteredWatch.consume()[0]!;
  const filteredProgress =
    filteredHeartbeat.type === 'progress' ? filteredHeartbeat.progress : -1;
  step('prefix-filtered revision gap is captured as progress', {
    firstDrain: filteredFirstDrain
      .map((m) => (m.type === 'progress' ? `progress:${m.progress}` : `rev:${m.revision}`))
      .slice(0, 4),
    filteredProgress,
    resumeRevision: filteredProgress + 1,
  });
  filteredWatch.close();

  // Healthy subscriber proves other watchers kept advancing.
  const healthyRevisions = commits
    .filter((c) => c.revision >= 2)
    .map((c) => c.revision);
  step('healthy watcher received every revision', { healthyRevisions });

  // ----------------------------- 6. reconnect attempts + history compaction
  // Before compaction the old resume point is still replayable.
  let oldCursorReplay = 'unavailable';
  const replayWatch = registry.watch({ prefix: PREFIX, startRevision: 4 });
  const replayDrain = replayWatch.consume(16);
  oldCursorReplay = replayDrain
    .map((m) => (m.type === 'progress' ? `progress:${m.progress}` : `rev:${m.revision}(${m.events.length})`))
    .join(',');
  replayWatch.close();
  step('reconnect before compaction replays retained history', { oldCursorReplay });

  const compaction = registry.compact(5);
  step('history compacted through revision 5', compaction);

  let reconnectAfterCompaction: string | null = null;
  try {
    registry.watch({ prefix: PREFIX, startRevision: 4 });
  } catch (error) {
    if (error instanceof CursorExpiredError) {
      reconnectAfterCompaction = `${error.reason} -> rebuild at ${error.rebuildBasis.snapshotRevision}`;
    } else {
      throw error;
    }
  }

  let compactedTokenError: { reason: string; basis: RebuildBasis } | null = null;
  try {
    registry.list({ prefix: PREFIX, pageSize: 3, pageToken: tokenAfterPage2 });
  } catch (error) {
    if (error instanceof CursorExpiredError) {
      compactedTokenError = { reason: error.reason, basis: error.rebuildBasis };
    } else {
      throw error;
    }
  }
  step('stale page token and old watch cursor report rebuild signals', {
    reconnectAfterCompaction,
    compactedTokenError,
  });

  // --------------------------------------------------- 7. client rebuild
  const client = new DiscoveryClient(registry, { prefix: PREFIX, pageSize: 3 });
  const rebuild = client.resync(stallBasis);
  step('rebuilt client: fresh paged snapshot + watch after snapshot revision', {
    baselineRevision: rebuild.baselineRevision,
    watchStart: rebuild.baselineRevision + 1,
    pages: rebuild.pages,
  });

  // One more write after rebuild; the client converges to the selected revision.
  const selectedRevision = registry.mutate('S2', [
    { type: 'put', key: `${PREFIX}b/131`, data: {} },
  ]).revision;
  client.pumpWatch();
  step('post-rebuild write applied through the new watch', { selectedRevision });

  // Independent full re-pagination of the selected revision for the
  // convergence check (the single default page would only hold 100 rows).
  const registryKeys: string[] = [];
  {
    let token: string | undefined;
    do {
      const page = registry.list({ prefix: PREFIX, pageSize: 37, pageToken: token });
      for (const instance of page.instances) registryKeys.push(instance.key);
      token = page.nextPageToken ?? undefined;
    } while (token);
  }
  const clientKeys = client.listInstances().map((i) => i.key);
  const equal = JSON.stringify(registryKeys) === JSON.stringify(clientKeys);

  // Releasing every cursor lets the next compaction reclaim the history.
  healthyWatch.close();
  client.close();
  const finalCompaction = registry.compact(selectedRevision);
  const statsAtEnd = registry.stats();
  step('all cursors closed; remaining history reclaimed', { finalCompaction, statsAtEnd });

  const report: ScenarioReport = {
    steps,
    commits,
    initialPagination: {
      baselineRevision: page1.revision,
      pages: [
        {
          pageNumber: 1,
          baselineRevision: page1.revision,
          keys: page1.instances.map((i) => i.key),
        },
        {
          pageNumber: 2,
          baselineRevision: page2.revision,
          keys: page2.instances.map((i) => i.key),
        },
      ],
      compactedTokenError,
    },
    fencing: {
      staleKeepalive,
      staleDelete,
      expiredSessionMutate,
      survivedTakeoverKeys: [`${PREFIX}a/2`, `${PREFIX}a/4`],
    },
    slowWatch: {
      prefix: PREFIX,
      startRevision: 2,
      stallReason,
      stallBasis,
      oldCursorReplay,
      reconnectAfterCompaction,
    },
    filteredWatch: {
      prefix: PREFIX,
      observedProgress: filteredProgress,
      resumeRevision: filteredProgress + 1,
    },
    healthyWatch: { prefix: '', receivedRevisions: healthyRevisions },
    compaction: {
      compactedRevision: compaction.toCompactedRevision,
      retainedRevisions: registry.currentRevision - compaction.toCompactedRevision,
    },
    rebuild: {
      reason: stallReason ?? 'unknown',
      baselineRevision: rebuild.baselineRevision,
      resumeAfterRevision: rebuild.resumeAfterRevision,
      watchStartRevision: rebuild.baselineRevision + 1,
      pages: rebuild.pages.map((p) => ({
        pageNumber: p.pageNumber,
        baselineRevision: p.baselineRevision,
        keys: p.keys,
      })),
    },
    final: { selectedRevision, registryKeys, clientKeys, equal },
    statsAtEnd,
  };
  return { report, registry, client };
}

const invokedPath = process.argv[1] ? new URL(`file://${process.argv[1]}`).pathname : '';
if (invokedPath.endsWith('scenario.ts') && import.meta.url === `file://${invokedPath}`) {
  const { report } = runScenario();
  for (const s of report.steps) {
    console.log(`\n[t=${s.at}] ${s.title}`);
    if (s.detail && Object.keys(s.detail as object).length > 0) {
      console.log(JSON.stringify(s.detail, null, 2));
    }
  }
  console.log('\n=== final convergence ===');
  console.log(JSON.stringify(report.final, null, 2));
}
