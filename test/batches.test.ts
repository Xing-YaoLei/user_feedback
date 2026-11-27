import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, CANDIDATE, ORIGINAL } from './helpers.ts';

test('a healthy release advances batch by batch and replaces the original config', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL, c: ORIGINAL }, start: 1_000 });
  h.autoReport();

  const id = h.controller.startRelease({
    releaseId: 'r1',
    candidate: CANDIDATE,
    batches: [['a', 'b'], ['c']],
    observationMs: 1_000,
    minValidSamples: 1,
    successRatio: 1,
  });

  // Batch 0 froze identities and opened its window at start time.
  let view = h.controller.explain(id);
  assert.equal(view.status, 'running');
  assert.equal(view.currentBatchIndex, 0);
  assert.equal(view.batches[0].status, 'observing');
  assert.deepEqual(view.batches[0].frozen, [
    { instanceId: 'a', generation: 1 },
    { instanceId: 'b', generation: 1 },
  ]);
  assert.equal(view.batches[0].window.openedAt, 1_000);
  assert.equal(view.batches[0].window.closesAt, 2_000);
  assert.equal(view.batches[1].status, 'pending');
  assert.equal(view.batches[1].frozen.length, 0);
  assert.equal(view.batches[0].live.confirmedInstalls, 2);
  assert.equal(view.batches[0].live.validSamples, 2);

  // Installs already applied; each receipt reported the actual old config.
  assert.deepEqual(h.adapter('a').snapshot().config, CANDIDATE);
  assert.deepEqual(view.batches[0].instances[0].install.replacedConfig, ORIGINAL);

  h.clock.advance(999);
  assert.equal(h.controller.tick().decisions.length, 0, 'window not closed yet');

  h.clock.advance(1);
  const tick = h.controller.tick();
  assert.equal(tick.decisions.length, 1);
  assert.equal(tick.decisions[0].advanced, true);
  assert.deepEqual(tick.decisions[0].reasons, ['ratio-met']);

  // Batch 1 starts fresh at the moment batch 0 closed.
  view = h.controller.explain(id);
  assert.equal(view.batches[0].status, 'passed');
  assert.equal(view.batches[1].status, 'observing');
  assert.equal(view.batches[1].window.openedAt, 2_000);
  assert.equal(view.batches[1].window.closesAt, 3_000);

  h.clock.advance(1_000);
  h.controller.tick();
  view = h.controller.explain(id);
  assert.equal(view.status, 'succeeded');
  assert.equal(view.active, false);
  assert.equal(view.finishedAt, 3_000);
  assert.deepEqual(
    view.batches.map((batch) => batch.status),
    ['passed', 'passed'],
  );
  for (const instanceId of ['a', 'b', 'c']) {
    assert.deepEqual(h.adapter(instanceId).snapshot().config, CANDIDATE);
  }
  assert.equal(view.restoreRequested, false);
});

test('the window is measured from when the batch starts, not from release start', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.autoReport();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a'], ['b']],
    observationMs: 500,
    minValidSamples: 1,
    successRatio: 1,
  });

  h.clock.advance(3_000);
  h.controller.tick(); // decides batch 0 and opens batch 1 at t=3000
  const view = h.controller.explain(id);
  assert.equal(view.batches[0].window.openedAt, 0);
  assert.equal(view.batches[0].window.closedAt, 3_000);
  assert.equal(view.batches[1].window.openedAt, 3_000);
  assert.equal(view.batches[1].window.closesAt, 3_500);
  // The next batch cannot piggyback on the previous window.
  h.clock.advance(100);
  assert.equal(h.controller.tick().decisions.length, 0);
});

test('success requires enough valid samples even when every counted sample is healthy', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL, c: ORIGINAL } });
  h.autoReport({ healthy: () => true });
  // c's install receipt is stuck in transit, so c never becomes a sample.
  h.adapter('c').beginHold();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b', 'c']],
    observationMs: 1_000,
    minValidSamples: 3,
    successRatio: 0.6,
  });

  h.clock.advance(1_000);
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.advanced, false);
  assert.equal(decision.validSamples, 2);
  assert.equal(decision.ratio, 2 / 3);
  assert.ok(decision.reasons.includes('insufficient-valid-samples'));
  assert.equal(h.controller.explain(id).status, 'failed');
});

test('the success ratio denominator is the frozen instance count', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL, c: ORIGINAL, d: ORIGINAL } });
  h.autoReport({ healthy: (instanceId) => instanceId !== 'd' });
  h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b', 'c', 'd']],
    observationMs: 1_000,
    minValidSamples: 3,
    successRatio: 0.8,
  });

  h.clock.advance(1_000);
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.frozenTotal, 4);
  assert.equal(decision.successes, 3);
  assert.equal(decision.ratio, 0.75);
  assert.equal(decision.advanced, false);
  assert.ok(decision.reasons.includes('ratio-below-threshold'));
});

test('an unhealthy instance and a missing report both count as failures, not samples', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL, c: ORIGINAL } });
  h.autoReport({ healthy: (instanceId) => instanceId === 'a' });
  h.adapter('c').beginHold();
  h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b', 'c']],
    observationMs: 1_000,
    minValidSamples: 1,
    successRatio: 1,
  });

  h.clock.advance(1_000);
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.validSamples, 2);
  assert.equal(decision.successes, 1);
  assert.equal(decision.unhealthy, 1);
  assert.equal(decision.pendingReceipt, 1);
  assert.equal(decision.advanced, false);
});

test('runTo drives the clock and ticks until the release finishes', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.autoReport();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a'], ['b']],
    observationMs: 500,
    minValidSamples: 1,
    successRatio: 1,
  });

  h.runTo(2_000, 50);
  const view = h.controller.explain(id);
  assert.equal(view.status, 'succeeded');
  assert.equal(view.finishedAt, 1_000, 'the second window closes at t=1000');
  assert.equal(h.clock.now(), 2_000);
});

test('a batch can advance with an unconfirmed install when the ratio allows it', () => {
  const h = makeHarness({
    instances: { a: ORIGINAL, b: ORIGINAL, c: ORIGINAL, d: ORIGINAL },
  });
  h.autoReport();
  h.adapter('d').beginHold(); // d is installed but its receipt is late
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a', 'b', 'c', 'd']],
    observationMs: 1_000,
    minValidSamples: 3,
    successRatio: 0.7,
  });

  h.clock.advance(1_000);
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.validSamples, 3);
  assert.equal(decision.successes, 3);
  assert.equal(decision.ratio, 0.75);
  assert.equal(decision.pendingReceipt, 1);
  assert.equal(decision.advanced, true);

  const d = h.controller.explain(id).batches[0].instances.find(
    (instance) => instance.instanceId === 'd',
  )!;
  assert.equal(d.install.status, 'pending-receipt');
  assert.equal(d.health.sampleStatus, 'install-unconfirmed');
  // The unobserved instance still runs the candidate; it is not retried or
  // counted, and the decision record keeps the pending count.
  assert.deepEqual(h.adapter('d').snapshot().config, CANDIDATE);
  assert.equal(h.controller.explain(id).batches[0].decision!.pendingReceipt, 1);
});
