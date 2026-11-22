import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../src/scenario.ts';

describe('interleaved end-to-end scenario', () => {
  const { report, registry } = runScenario();

  it('assigns one monotonic revision per atomic batch', () => {
    const revisions = report.commits.map((c) => c.revision);
    assert.deepEqual(revisions, revisions.map((_, i) => i + 1));
    assert.equal(report.commits.length, registry.currentRevision);
  });

  it('keeps every pagination page on the first-page snapshot baseline', () => {
    const baseline = report.initialPagination.baselineRevision;
    assert.ok(baseline >= 1);
    for (const page of report.initialPagination.pages) {
      assert.equal(page.baselineRevision, baseline);
    }
    // Page 2 still contains keys that later revisions deleted/re-registered.
    assert.deepEqual(report.initialPagination.pages[1]!.keys, [
      'svc/a/4',
      'svc/a/5',
      'svc/a/6',
    ]);
  });

  it('fences every late operation of an old session generation', () => {
    assert.match(report.fencing.staleKeepalive ?? '', /generation conflict/);
    assert.match(report.fencing.staleDelete ?? '', /generation conflict/);
    assert.match(report.fencing.expiredSessionMutate ?? '', /expired or unknown/);
  });

  it('evicts the slow watcher with a backlog rebuild basis while peers advance', () => {
    assert.equal(report.slowWatch.stallReason, 'backlog');
    assert.ok(report.slowWatch.stallBasis);
    assert.equal(
      report.slowWatch.stallBasis!.snapshotRevision,
      report.slowWatch.stallBasis!.resumeAfterRevision,
    );
    // Healthy watcher saw every committed revision it subscribed to (it was
    // closed before the final post-rebuild write).
    const lastHealthyRevision = report.healthyWatch.receivedRevisions.at(-1)!;
    assert.deepEqual(
      report.healthyWatch.receivedRevisions,
      Array.from({ length: lastHealthyRevision - 1 }, (_, i) => i + 2),
    );
  });

  it('reflects prefix-filtered revision gaps in resumable progress', () => {
    assert.ok(report.filteredWatch.observedProgress >= 1);
    assert.equal(report.filteredWatch.resumeRevision, report.filteredWatch.observedProgress + 1);
  });

  it('replays history before compaction and demands a rebuild after it', () => {
    assert.match(report.slowWatch.oldCursorReplay, /rev:4\(3\)/);
    assert.match(report.slowWatch.reconnectAfterCompaction ?? '', /compacted/);
    assert.equal(report.initialPagination.compactedTokenError!.reason, 'compacted');
  });

  it('rebuilds on a fresh snapshot and starts the watch exactly after it', () => {
    const { rebuild } = report;
    assert.equal(rebuild.watchStartRevision, rebuild.baselineRevision + 1);
    assert.equal(rebuild.resumeAfterRevision, rebuild.baselineRevision);
    const baseline = rebuild.baselineRevision;
    assert.ok(rebuild.pages.every((p) => p.baselineRevision === baseline));
    const seen = new Set<string>();
    for (const page of rebuild.pages) {
      for (const key of page.keys) {
        assert.ok(!seen.has(key), `duplicate key ${key} across pages`);
        seen.add(key);
      }
    }
  });

  it('converges the rebuilt client directory with the registry at the selected revision', () => {
    assert.equal(report.final.equal, true);
    assert.equal(report.final.registryKeys.length, report.final.clientKeys.length);
    assert.deepEqual(report.final.clientKeys, report.final.registryKeys);
    assert.equal(report.final.selectedRevision, registry.currentRevision);
  });

  it('reclaims history once every cursor is closed and compaction runs', () => {
    assert.equal(report.statsAtEnd.livePageCursors, 0);
    assert.equal(report.statsAtEnd.liveWatches, 0);
    assert.equal(report.statsAtEnd.retainedRevisions, 0);
    assert.equal(report.statsAtEnd.retainedEvents, 0);
    assert.equal(report.statsAtEnd.oldestPinnedRevision, null);
  });
});
