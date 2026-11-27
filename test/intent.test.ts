import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, CANDIDATE, ORIGINAL } from './helpers.ts';
import type { InstallCommand } from '../src/types.ts';

const NEWER_CANDIDATE = { feature: { enabled: true, rollout: 100 }, note: 'second release' };

test('the adapter refuses an install whose intent is older than one already applied', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  const adapter = h.adapter('a');
  adapter.holdCommands();
  const first = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  const [firstCommand] = adapter.drainHeldCommands() as InstallCommand[];
  assert.equal(firstCommand.intent, 1);

  // A second release raises the intent for the same instance; its command is
  // also held in transit so both can be replayed out of order.
  adapter.holdCommands();
  const second = h.controller.startRelease({
    candidate: NEWER_CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  const [secondCommand] = adapter.drainHeldCommands() as InstallCommand[];
  assert.equal(secondCommand.intent, 2);

  // Newer intent lands first; then the delayed older command shows up.
  adapter.deliverCommand(secondCommand);
  assert.deepEqual(adapter.snapshot().config, NEWER_CANDIDATE);
  adapter.deliverCommand(firstCommand);

  const snapshot = adapter.snapshot();
  assert.deepEqual(snapshot.config, NEWER_CANDIDATE, 'stale install must not overwrite');
  assert.equal(snapshot.lastIntent, 2);
  assert.equal(snapshot.owner.kind, 'release');
  assert.equal(snapshot.owner.kind === 'release' && snapshot.owner.releaseId, second);

  // The first release was superseded by the second and is no longer active.
  assert.equal(h.controller.explain(first).status, 'superseded');
  assert.equal(h.controller.explain(second).status, 'running');
});

test('receipts from a superseded release never overwrite the new release state', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.autoReport();
  const first = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b']],
    observationMs: 10_000,
    minValidSamples: 2,
    successRatio: 1,
  });

  const second = h.controller.startRelease({
    candidate: NEWER_CANDIDATE,
    batches: [['a', 'b']],
    observationMs: 1_000,
    minValidSamples: 2,
    successRatio: 1,
  });

  const firstView = h.controller.explain(first);
  assert.equal(firstView.status, 'superseded');
  assert.equal(firstView.batches[0].status, 'abandoned');

  // Delayed health reports for the old install are refused outright.
  const oldInstallId = firstView.batches[0].instances[0].installId;
  const outcome = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId: oldInstallId,
    seq: 50,
    healthy: false,
  });
  assert.equal(outcome.accepted, false);

  // The new release is unaffected and can still succeed.
  h.clock.advance(1_000);
  h.controller.tick();
  const secondView = h.controller.explain(second);
  assert.equal(secondView.status, 'succeeded');
  assert.deepEqual(h.adapter('a').snapshot().config, NEWER_CANDIDATE);
  for (const instance of secondView.batches[0].instances) {
    assert.equal(instance.health.sampleStatus, 'healthy');
  }
});

test('a stale restore command cannot roll back a newer install', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  h.autoReport({ healthy: () => false });
  const adapter = h.adapter('a');
  adapter.holdCommands();

  const first = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  // Delivering the install lets it apply, then the release fails at the
  // window and queues a rollback — also held in transit.
  const [installCommand] = adapter.drainHeldCommands();
  adapter.deliverCommand(installCommand);
  h.clock.advance(100);
  adapter.holdCommands();
  h.controller.tick();
  const [restoreCommand] = adapter.drainHeldCommands();

  // Before the rollback is delivered, a fresh release installs a newer config.
  adapter.holdCommands();
  const second = h.controller.startRelease({
    candidate: NEWER_CANDIDATE,
    batches: [['a']],
    observationMs: 1_000,
    minValidSamples: 1,
    successRatio: 1,
  });
  const [secondInstall] = adapter.drainHeldCommands();
  adapter.deliverCommand(secondInstall);
  // Now the orphaned rollback arrives.
  adapter.deliverCommand(restoreCommand);

  const snapshot = adapter.snapshot();
  assert.deepEqual(snapshot.config, NEWER_CANDIDATE, 'stale rollback must not win');
  assert.equal(snapshot.lastIntent, secondInstall.intent);
  // The first release already failed before the second existed; its rollback
  // was fenced out when it finally arrived, and is reported as skipped.
  const firstView = h.controller.explain(first);
  assert.equal(firstView.status, 'failed');
  assert.equal(firstView.restoreSummary.awaitingRestoreReceipt.length, 0);
  assert.deepEqual(firstView.restoreSummary.skippedCondition, ['a']);
  assert.equal(h.controller.explain(second).status, 'running');
});

test('a rollback still parked when a new release starts is withdrawn, not left hanging', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  const adapter = h.adapter('a');
  adapter.beginHold(); // a's install receipt never arrives before the failure
  const first = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });

  h.clock.advance(100);
  h.controller.tick();
  let firstView = h.controller.explain(first);
  assert.equal(firstView.status, 'failed');
  assert.deepEqual(firstView.restoreSummary.awaitingInstallReceipt, ['a']);

  // Before the receipt shows up, a new release takes over the instance.
  const second = h.controller.startRelease({
    candidate: NEWER_CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  firstView = h.controller.explain(first);
  // The release already failed before the new one existed; it stays failed,
  // but the rollback it could not deliver is withdrawn.
  assert.equal(firstView.status, 'failed');
  assert.deepEqual(firstView.restoreSummary.awaitingInstallReceipt, []);
  assert.deepEqual(firstView.restoreSummary.skippedCondition, ['a']);
  const record = firstView.batches[0].instances[0];
  assert.match(record.restore.reason ?? '', /superseded by a newer release/);

  // The late receipt for the old release is recorded as history (the install
  // really did happen) but triggers no restore, and the new release's install
  // still stands.
  for (const receipt of adapter.releaseHeld()) adapter.deliver(receipt);
  const lateView = h.controller.explain(first);
  assert.equal(lateView.ignoredReceipts, 0);
  assert.equal(lateView.batches[0].instances[0].install.status, 'confirmed');
  assert.equal(lateView.batches[0].instances[0].restore.status, 'skipped-condition');
  assert.equal(h.controller.explain(second).status, 'running');
  assert.deepEqual(adapter.snapshot().config, NEWER_CANDIDATE);
});

test('a new release withdraws only the parked rollbacks for instances it claims', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.adapter('a').beginHold();
  h.adapter('b').beginHold();
  const first = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  h.clock.advance(100);
  h.controller.tick();
  assert.deepEqual(
    h.controller.explain(first).restoreSummary.awaitingInstallReceipt.sort(),
    ['a', 'b'],
  );

  // The new release only claims a.
  h.clock.advance(10);
  h.controller.startRelease({
    candidate: NEWER_CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });

  const view = h.controller.explain(first);
  assert.deepEqual(view.restoreSummary.skippedCondition, ['a']);
  assert.deepEqual(view.restoreSummary.awaitingInstallReceipt, ['b']);

  // b's receipt finally lands; its rollback was never withdrawn and fires.
  for (const receipt of h.adapter('b').releaseHeld()) h.adapter('b').deliver(receipt);
  assert.deepEqual(h.adapter('b').snapshot().config, ORIGINAL);
  assert.deepEqual(h.controller.explain(first).restoreSummary.awaitingInstallReceipt, []);
});

test('a superseded release stops deciding and opens no further batches', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL, c: ORIGINAL } });
  h.autoReport();
  const first = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a'], ['b'], ['c']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  const second = h.controller.startRelease({
    candidate: NEWER_CANDIDATE,
    batches: [['c']],
    observationMs: 1_000,
    minValidSamples: 1,
    successRatio: 1,
  });

  h.clock.advance(5_000);
  const tick = h.controller.tick();
  // Only the active release is ticked.
  assert.ok(tick.decisions.every((decision) => decision.advanced));
  assert.equal(h.controller.explain(first).currentBatchIndex, null);
  const firstView = h.controller.explain(first);
  assert.deepEqual(firstView.batches.map((batch) => batch.status), [
    'abandoned',
    'abandoned',
    'abandoned',
  ]);
  const secondView = h.controller.explain(second);
  assert.equal(secondView.status, 'succeeded');
  // a and b still run the abandoned release's candidate until someone acts.
  assert.deepEqual(h.adapter('a').snapshot().config, CANDIDATE);
  assert.deepEqual(h.adapter('c').snapshot().config, NEWER_CANDIDATE);
});

test('a late install receipt from a superseded release is counted, not applied', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  const adapter = h.adapter('a');
  adapter.beginHold();
  const first = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  h.controller.startRelease({
    candidate: NEWER_CANDIDATE,
    batches: [['a']],
    observationMs: 1_000,
    minValidSamples: 1,
    successRatio: 1,
  });

  const held = adapter.releaseHeld();
  // The first release had two held receipts: its install receipt and the
  // install receipt of the second. Deliver both late.
  assert.equal(held.length, 2);
  for (const receipt of held) adapter.deliver(receipt);

  const firstView = h.controller.explain(first);
  const secondView = h.controller.explain(h.controller.activeReleaseId!);
  assert.equal(firstView.status, 'superseded');
  assert.equal(firstView.ignoredReceipts, 1);
  assert.equal(secondView.ignoredReceipts, 0);
  assert.equal(secondView.batches[0].instances[0].install.status, 'confirmed');
  assert.deepEqual(adapter.snapshot().config, NEWER_CANDIDATE);
});
