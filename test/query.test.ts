import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, CANDIDATE, ORIGINAL } from './helpers.ts';

test('malformed release requests are rejected before any install is sent', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  const base = {
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  };

  assert.throws(
    () => h.controller.startRelease({ ...base, batches: [] }),
    /at least one batch/,
  );
  assert.throws(
    () => h.controller.startRelease({ ...base, batches: [['a', 'a']] }),
    /more than one batch/,
  );
  assert.throws(
    () => h.controller.startRelease({ ...base, batches: [['a'], ['a']] }),
    /more than one batch/,
  );
  assert.throws(
    () => h.controller.startRelease({ ...base, batches: [['nope']] }),
    /no adapter registered/,
  );
  assert.throws(
    () => h.controller.startRelease({ ...base, observationMs: Number.NaN }),
    /observationMs/,
  );
  assert.throws(
    () => h.controller.startRelease({ ...base, minValidSamples: 1.5 }),
    /minValidSamples/,
  );
  assert.throws(
    () => h.controller.startRelease({ ...base, successRatio: 1.2 }),
    /successRatio/,
  );

  // Nothing was installed and no release was created.
  assert.deepEqual(h.adapter('a').snapshot().config, ORIGINAL);
  assert.equal(h.controller.activeReleaseId, null);
});

test('an observing window that has elapsed is reported as pending decision until ticked', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  h.autoReport();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });

  h.clock.advance(100);
  const view = h.controller.explain(id);
  const batch = view.batches[0];
  assert.equal(batch.status, 'observing');
  assert.equal(batch.window.elapsed, true);
  assert.equal(batch.window.pendingDecision, true);
  assert.equal(batch.decision, undefined);

  h.controller.tick();
  const after = h.controller.explain(id).batches[0];
  assert.equal(after.status, 'passed');
  assert.equal(after.window.closedAt, 100);
  assert.equal(after.decision!.decidedAt, 100);
  assert.equal(after.decision!.advanced, true);
  assert.equal(after.window.pendingDecision, false);
  assert.ok(after.decision);
});

test('a delayed tick decides on the samples from the window, not the tick time', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  h.autoReport();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  h.clock.advance(50_000);
  // A report after the window closed cannot rescue the batch.
  const view0 = h.controller.explain(id);
  const installId = view0.batches[0].instances[0].installId;
  const late = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 9,
    healthy: true,
  });
  assert.equal(late.reason, 'window-closed');
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.decidedAt, 50_000);
  const batch = h.controller.explain(id).batches[0];
  assert.equal(batch.window.closesAt, 100);
  assert.equal(batch.window.closedAt, 50_000);
  // The auto-report sent at install time is still the only sample.
  assert.equal(decision.validSamples, 1);
  assert.equal(decision.advanced, true);
});

test('a zero-length observation window admits no samples and decides immediately', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.autoReport();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a'], ['b']],
    observationMs: 0,
    minValidSamples: 1,
    successRatio: 1,
  });
  // The window is the half-open interval [openedAt, closesAt); with zero
  // length nothing can ever land inside it.
  const tick = h.controller.tick();
  assert.equal(tick.decisions.length, 1);
  assert.equal(tick.decisions[0].advanced, false);
  assert.equal(tick.decisions[0].validSamples, 0);
  const view = h.controller.explain(id);
  assert.equal(view.status, 'failed');
  assert.equal(view.batches[1].status, 'skipped');
  // The install did happen, so the rollback still runs.
  assert.deepEqual(h.adapter('a').snapshot().config, ORIGINAL);
});

test('explain reflects live progress without mutating anything', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b']],
    observationMs: 1_000,
    minValidSamples: 2,
    successRatio: 1,
  });
  const installIds = new Map(
    h.controller
      .explain(id)
      .batches[0].instances.map((instance) => [instance.instanceId, instance.installId]),
  );

  h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId: installIds.get('a')!,
    seq: 1,
    healthy: true,
  });

  let view = h.controller.explain(id);
  assert.equal(view.batches[0].live.validSamples, 1);
  assert.equal(view.batches[0].live.missingReport, 1);
  const b = view.batches[0].instances.find((instance) => instance.instanceId === 'b')!;
  assert.equal(b.health.sampleStatus, 'missing-report');
  assert.equal(b.health.hasReport, false);

  h.controller.reportHealth({
    instanceId: 'b',
    generation: 1,
    installId: installIds.get('b')!,
    seq: 1,
    healthy: false,
  });
  view = h.controller.explain(id);
  assert.equal(view.batches[0].live.validSamples, 2);
  assert.equal(view.batches[0].live.successes, 1);
  assert.equal(view.batches[0].live.unhealthy, 1);

  // Calling explain repeatedly never changes the outcome.
  const first = h.controller.explain(id).batches[0].live;
  const second = h.controller.explain(id).batches[0].live;
  assert.deepEqual(first, second);
});

test('an open window rejects health reports from earlier batches', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.autoReport();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a'], ['b']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  const aInstall = h.controller.explain(id).batches[0].instances[0].installId;
  h.clock.advance(100);
  h.controller.tick();

  const outcome = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId: aInstall,
    seq: 5,
    healthy: true,
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'window-closed');
  assert.equal(h.controller.explain(id).batches[0].live.validSamples, 1);
});

test('a duplicate release id throws without disturbing the running release', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  h.autoReport();
  const id = h.controller.startRelease({
    releaseId: 'fixed',
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  const before = h.controller.explain(id);

  assert.throws(
    () =>
      h.controller.startRelease({
        releaseId: 'fixed',
        candidate: CANDIDATE,
        batches: [['a']],
        observationMs: 100,
        minValidSamples: 1,
        successRatio: 1,
      }),
    /already exists/,
  );

  const after = h.controller.explain(id);
  assert.equal(after.status, 'running');
  assert.equal(after.active, true);
  assert.equal(after.batches[0].status, 'observing');
  assert.equal(after.currentBatchIndex, before.currentBatchIndex);
  assert.deepEqual(h.controller.listReleaseIds(), ['fixed']);
});

test('reportHealth rejects structurally invalid reports without touching state', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  h.autoReport();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  const before = h.controller.explain(id).batches[0].live;

  assert.throws(() => h.controller.reportHealth(null as never), /health report needs/);
  assert.throws(
    () =>
      h.controller.reportHealth({
        instanceId: 'a',
        generation: 1,
        installId: 'x',
        seq: Number.NaN,
        healthy: true,
      }),
    /health report needs/,
  );
  assert.throws(
    () =>
      h.controller.reportHealth({
        instanceId: 'a',
        generation: 1,
        installId: 'x',
        seq: 1,
        healthy: 'yes' as never,
      }),
    /health report needs/,
  );

  assert.deepEqual(h.controller.explain(id).batches[0].live, before);
});

test('the explanation invents nothing about instances it never touched', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL, c: ORIGINAL } });
  h.autoReport({ healthy: () => false });
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b'], ['c']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  h.clock.advance(100);
  h.controller.tick();

  const view = h.controller.explain(id);
  assert.equal(view.batches[1].status, 'skipped');
  assert.deepEqual(view.batches[1].instances, []);
  assert.deepEqual(view.batches[1].frozen, []);
  assert.equal(view.batches[1].window.openedAt, null);
  assert.equal(view.batches[1].window.elapsed, false);
  assert.equal(view.restoreSummary.notNeeded, 0);
});
