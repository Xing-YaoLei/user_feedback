import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, CANDIDATE, ORIGINAL } from './helpers.ts';
import type { CommandReceipt } from '../src/types.ts';

const OTHER_OPERATOR_CONFIG = { feature: { enabled: true, rollout: 99 } };

function ids(view: ReturnType<ReturnType<typeof makeHarness>['controller']['explain']>) {
  const byInstance = new Map(
    view.batches.flatMap((batch) => batch.instances).map((instance) => [
      instance.instanceId,
      instance.installId,
    ]),
  );
  return byInstance;
}

test('a failed batch stops later batches and restores every touched instance', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL, c: ORIGINAL } });
  h.autoReport({ healthy: (instanceId) => instanceId === 'a' });
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a'], ['b'], ['c']],
    observationMs: 1_000,
    minValidSamples: 1,
    successRatio: 1,
  });

  h.clock.advance(1_000);
  h.controller.tick(); // batch 0 passes, batch 1 opens

  h.clock.advance(1_000);
  const tick = h.controller.tick(); // batch 1 fails on b
  assert.equal(tick.decisions.length, 1);
  assert.equal(tick.decisions[0].advanced, false);

  const view = h.controller.explain(id);
  assert.equal(view.status, 'failed');
  assert.deepEqual(view.batches.map((batch) => batch.status), ['passed', 'failed', 'skipped']);
  // c was never touched.
  assert.equal(view.batches[2].instances.length, 0);
  assert.deepEqual(h.adapter('c').snapshot().config, ORIGINAL);

  // Both touched instances were rolled back to their exact prior configs.
  for (const instanceId of ['a', 'b']) {
    const snapshot = h.adapter(instanceId).snapshot();
    assert.deepEqual(snapshot.config, ORIGINAL, `${instanceId} restored`);
    assert.equal(snapshot.owner.kind, 'restored');
  }
  assert.deepEqual(view.restoreSummary.restored.sort(), ['a', 'b']);
  assert.equal(view.restoreSummary.awaitingInstallReceipt.length, 0);

  for (const instance of view.batches.flatMap((batch) => batch.instances)) {
    assert.equal(instance.restore.status, 'restored');
    assert.deepEqual(instance.restore.targetConfig, ORIGINAL);
  }
});

test('rollback targets the config each receipt reported, not a shared assumption', () => {
  const aOriginal = { db: { host: 'a-db' } };
  const bOriginal = { db: { host: 'b-db' } };
  const h = makeHarness({ instances: { a: aOriginal, b: bOriginal } });
  h.autoReport({ healthy: () => false });
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });

  // b was changed by an operator between install and rollback.
  h.adapter('b').applyExternalConfig(OTHER_OPERATOR_CONFIG, 'operator hotfix');
  h.clock.advance(100);
  h.controller.tick();

  const view = h.controller.explain(id);
  assert.deepEqual(h.adapter('a').snapshot().config, aOriginal);
  assert.deepEqual(
    h.adapter('b').snapshot().config,
    OTHER_OPERATOR_CONFIG,
    'external change must survive the rollback',
  );
  assert.deepEqual(view.restoreSummary.restored, ['a']);
  assert.deepEqual(view.restoreSummary.skippedCondition, ['b']);

  const b = view.batches[0].instances.find((instance) => instance.instanceId === 'b')!;
  assert.equal(b.restore.status, 'skipped-condition');
  assert.match(b.restore.reason ?? '', /changed outside this release/);
});

test('a rollback parked for a missing install receipt is issued when the receipt lands late', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  const slow = h.adapter('b');
  slow.beginHold(); // b's install receipt is held while the config already changed

  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b']],
    observationMs: 100,
    minValidSamples: 2,
    successRatio: 1,
  });
  const installId = ids(h.controller.explain(id)).get('b')!;

  // a is healthy, b's receipt is late so b is not even a valid sample.
  h.controller.reportHealth({ instanceId: 'a', generation: 1, installId: ids(h.controller.explain(id)).get('a')!, seq: 1, healthy: true });
  h.clock.advance(100);
  h.controller.tick();

  let view = h.controller.explain(id);
  assert.equal(view.status, 'failed');
  assert.deepEqual(view.restoreSummary.awaitingInstallReceipt, ['b']);
  assert.equal(view.restoreSummary.restored.includes('a'), true);
  assert.deepEqual(slow.snapshot().config, CANDIDATE, 'b still runs the candidate until receipt');

  // The delayed install receipt finally arrives.
  const held = slow.releaseHeld();
  assert.equal(held.length, 1);
  for (const receipt of held) slow.deliver(receipt);

  view = h.controller.explain(id);
  assert.deepEqual(view.restoreSummary.awaitingInstallReceipt, []);
  assert.deepEqual(view.restoreSummary.restored.sort(), ['a', 'b']);
  assert.deepEqual(slow.snapshot().config, ORIGINAL);
  assert.equal(view.ignoredReceipts, 0);
  const b = view.batches[0].instances.find((instance) => instance.instanceId === 'b')!;
  assert.equal(b.install.status, 'confirmed', 'late receipt is still recorded for the record');
  assert.equal(b.installId, installId);
});

test('an install rejected by the adapter needs no rollback', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.autoReport({ healthy: () => true });
  // a's process generation moves between planning and command delivery: the
  // command was already built for generation 1, so it is refused.
  const a = h.adapter('a');
  a.holdCommands();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b']],
    observationMs: 100,
    minValidSamples: 2,
    successRatio: 1,
  });
  a.restart({ bumpGeneration: true });
  a.releaseCommands('fifo');

  h.clock.advance(100);
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.advanced, false);
  assert.equal(decision.installRejected, 1);

  const view = h.controller.explain(id);
  const record = view.batches[0].instances.find((instance) => instance.instanceId === 'a')!;
  assert.equal(record.install.status, 'rejected');
  assert.equal(record.install.rejectionReason, 'wrong-generation');
  assert.equal(record.restore.status, 'not-needed');
  assert.deepEqual(a.snapshot().config, ORIGINAL);
  assert.deepEqual(view.restoreSummary.restored, ['b']);
});

test('an instance whose process is down is reported as not delivered and not rolled back', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.autoReport({ healthy: () => true });
  h.adapter('b').crash();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });

  const view0 = h.controller.explain(id);
  const b0 = view0.batches[0].instances.find((instance) => instance.instanceId === 'b')!;
  assert.equal(b0.install.status, 'not-delivered');
  assert.equal(view0.batches[0].live.notDelivered, 1);

  h.clock.advance(100);
  h.controller.tick();
  const view = h.controller.explain(id);
  assert.equal(view.status, 'failed');
  const b = view.batches[0].instances.find((instance) => instance.instanceId === 'b')!;
  assert.equal(b.restore.status, 'not-needed');
  assert.deepEqual(h.adapter('b').snapshot().config, ORIGINAL);
  assert.deepEqual(view.restoreSummary.restored, ['a']);
});

test('a restore receipt whose intent was never sent is ignored without changing state', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.autoReport({ healthy: () => false });
  const a = h.adapter('a');
  a.beginHold();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  h.clock.advance(100);
  h.controller.tick();

  // a's install receipt is still in flight, so its rollback is parked.
  let view = h.controller.explain(id);
  let record = view.batches[0].instances.find((instance) => instance.instanceId === 'a')!;
  assert.equal(record.restore.status, 'awaiting-install-receipt');
  assert.equal(record.install.status, 'pending-receipt');

  // A forged restore receipt (as if from an earlier attempt) arrives first.
  a.deliver({
    kind: 'restore',
    ok: true,
    intent: 999,
    instanceId: 'a',
    releaseId: id,
    restoreId: 'bogus',
    restoredConfig: ORIGINAL,
    previousOwner: { kind: 'release', releaseId: id, installId: 'x' },
    appliedAt: h.clock.now(),
    revision: 99,
  } as CommandReceipt);
  view = h.controller.explain(id);
  record = view.batches[0].instances.find((instance) => instance.instanceId === 'a')!;
  assert.equal(record.restore.status, 'awaiting-install-receipt');
  assert.equal(record.ignoredReceipts.length, 1);

  // The real install receipt then lands and triggers the actual rollback.
  for (const receipt of a.releaseHeld()) a.deliver(receipt);
  view = h.controller.explain(id);
  record = view.batches[0].instances.find((instance) => instance.instanceId === 'a')!;
  assert.equal(record.install.status, 'confirmed');
  assert.equal(record.restore.status, 'restored');
  assert.deepEqual(a.snapshot().config, ORIGINAL);
});
