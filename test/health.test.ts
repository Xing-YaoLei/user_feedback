import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, CANDIDATE, ORIGINAL } from './helpers.ts';

function startSimple(
  h: ReturnType<typeof makeHarness>,
  overrides: Partial<{
    observationMs: number;
    minValidSamples: number;
    successRatio: number;
    batches: string[][];
  }> = {},
) {
  return h.controller.startRelease({
    candidate: CANDIDATE,
    batches: overrides.batches ?? [['a', 'b']],
    observationMs: overrides.observationMs ?? 1_000,
    minValidSamples: overrides.minValidSamples ?? 1,
    successRatio: overrides.successRatio ?? 0.5,
  });
}

function installIdFor(
  h: ReturnType<typeof makeHarness>,
  releaseId: string,
  instanceId: string,
): string {
  const view = h.controller.explain(releaseId);
  const instance = view.batches
    .flatMap((batch) => batch.instances)
    .find((candidate) => candidate.instanceId === instanceId);
  assert.ok(instance, `no record for ${instanceId}`);
  return instance.installId;
}

test('a latest-seq report from a confirmed install of the frozen identity is accepted', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  const id = startSimple(h);
  const installId = installIdFor(h, id, 'a');

  const outcome = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 1,
    healthy: true,
  });
  assert.deepEqual(outcome, { accepted: true, reason: 'accepted', latestSeq: 1 });
});

test('duplicate and stale sequence numbers never add another sample', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  const id = startSimple(h, { batches: [['a']] });
  const installId = installIdFor(h, id, 'a');

  assert.equal(
    h.controller.reportHealth({ instanceId: 'a', generation: 1, installId, seq: 5, healthy: true })
      .accepted,
    true,
  );
  const duplicate = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 5,
    healthy: false,
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'duplicate-or-stale-seq');
  const stale = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 4,
    healthy: false,
  });
  assert.equal(stale.reason, 'duplicate-or-stale-seq');

  h.clock.advance(1_000);
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.validSamples, 1);
  assert.equal(decision.successes, 1, 'the duplicate unhealthy report must not count');
});

test('the newest report wins: a late deterioration flips the single sample to unhealthy', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  const id = startSimple(h);
  const aInstall = installIdFor(h, id, 'a');
  const bInstall = installIdFor(h, id, 'b');

  // Both look healthy early in the window.
  h.controller.reportHealth({ instanceId: 'a', generation: 1, installId: aInstall, seq: 1, healthy: true });
  h.controller.reportHealth({ instanceId: 'b', generation: 1, installId: bInstall, seq: 1, healthy: true });

  h.clock.advance(900);
  h.controller.reportHealth({ instanceId: 'b', generation: 1, installId: bInstall, seq: 2, healthy: false });

  h.clock.advance(100);
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.validSamples, 2, 'still exactly one sample per instance');
  assert.equal(decision.successes, 1);
  assert.equal(decision.unhealthy, 1);
  assert.equal(decision.ratio, 0.5);

  const view = h.controller.explain(id);
  const b = view.batches[0].instances.find((instance) => instance.instanceId === 'b')!;
  assert.equal(b.health.sampleStatus, 'unhealthy');
  assert.equal(b.health.latestSeq, 2);
  assert.equal(b.health.acceptedReports, 2);

  const a = view.batches[0].instances.find((instance) => instance.instanceId === 'a')!;
  assert.equal(a.health.sampleStatus, 'healthy');
});

test('reports for an install that is not confirmed do not count', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  h.adapter('a').beginHold();
  const id = startSimple(h, { batches: [['a']] });
  const installId = installIdFor(h, id, 'a');

  const before = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 1,
    healthy: true,
  });
  assert.equal(before.accepted, false);
  assert.equal(before.reason, 'install-not-confirmed');

  // The install had in fact been applied on the instance; only its reply was
  // delayed. Once the receipt lands, later reports count.
  const held = h.adapter('a').releaseHeld();
  assert.equal(held.length, 1);
  for (const receipt of held) h.adapter('a').deliver(receipt);

  const after = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 2,
    healthy: true,
  });
  assert.equal(after.accepted, true);

  h.clock.advance(1_000);
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.validSamples, 1);
  assert.equal(decision.successes, 1);
});

test('reports bound to the wrong install id, generation or instance are refused', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  const id = startSimple(h, { batches: [['a']] });
  const installId = installIdFor(h, id, 'a');

  const wrongInstall = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId: 'someone-else',
    seq: 1,
    healthy: true,
  });
  assert.equal(wrongInstall.reason, 'install-mismatch');

  const wrongGeneration = h.controller.reportHealth({
    instanceId: 'a',
    generation: 2,
    installId,
    seq: 1,
    healthy: true,
  });
  assert.equal(wrongGeneration.reason, 'generation-mismatch');

  const unknown = h.controller.reportHealth({
    instanceId: 'zzz',
    generation: 1,
    installId,
    seq: 1,
    healthy: true,
  });
  assert.equal(unknown.reason, 'unknown-instance');

  h.clock.advance(1_000);
  assert.equal(h.controller.tick().decisions[0].validSamples, 0);
});

test('a report arriving at or after the window close is not a sample', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  const id = startSimple(h, { batches: [['a']] });
  const installId = installIdFor(h, id, 'a');

  h.clock.advance(1_000);
  const late = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 1,
    healthy: true,
  });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, 'window-closed');

  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.validSamples, 0);

  const afterDecision = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 2,
    healthy: true,
  });
  assert.equal(afterDecision.reason, 'release-not-active');
});

test('reports for a batch already decided are refused while a later batch observes', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.autoReport();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a'], ['b']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  const aInstall = installIdFor(h, id, 'a');
  h.clock.advance(100);
  h.controller.tick();

  const outcome = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId: aInstall,
    seq: 99,
    healthy: false,
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'window-closed');
});

test('reports for instances in a batch that has not started are ignored', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  h.autoReport();
  const id = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a'], ['b']],
    observationMs: 500,
    minValidSamples: 1,
    successRatio: 1,
  });

  // b's install has not been issued yet; a forged report cannot count.
  const view = h.controller.explain(id);
  assert.equal(view.batches[1].instances.length, 0);
  const outcome = h.controller.reportHealth({
    instanceId: 'b',
    generation: 1,
    installId: 'guess',
    seq: 1,
    healthy: true,
  });
  assert.equal(outcome.reason, 'unknown-instance');
  assert.match(outcome.note ?? '', /batch 1, which has not started/);
});

test('an older report replayed after install confirmation cannot become the latest', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  h.adapter('a').beginHold();
  const id = startSimple(h, { batches: [['a']] });
  const installId = installIdFor(h, id, 'a');

  // Before confirmation the agent already reported seq 7 as unhealthy.
  const early = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 7,
    healthy: false,
  });
  assert.equal(early.reason, 'install-not-confirmed');

  // Confirmation lands, then a replayed copy of seq 7 arrives claiming health.
  for (const receipt of h.adapter('a').releaseHeld()) h.adapter('a').deliver(receipt);
  const replay = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 7,
    healthy: true,
  });
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, 'duplicate-or-stale-seq');

  const newer = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 8,
    healthy: false,
  });
  assert.equal(newer.accepted, true);

  h.clock.advance(1_000);
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.validSamples, 1);
  assert.equal(decision.successes, 0, 'the unhealthy report is the latest state');
});

test('reports after the release finished are refused with a clear reason', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  h.autoReport();
  const id = startSimple(h, { batches: [['a']], observationMs: 100, minValidSamples: 1, successRatio: 1 });
  h.clock.advance(100);
  h.controller.tick();
  const installId = installIdFor(h, id, 'a');

  const outcome = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId,
    seq: 99,
    healthy: true,
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'release-not-active');
  assert.match(outcome.note ?? '', /rel-1" is succeeded/);
});

test('a report for an instance of a superseded release is explained, not mislabelled', () => {
  const h = makeHarness({ instances: { a: ORIGINAL, b: ORIGINAL } });
  const first = startSimple(h, { batches: [['a']] });
  const aInstall = installIdFor(h, first, 'a');
  h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['b']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });

  const outcome = h.controller.reportHealth({
    instanceId: 'a',
    generation: 1,
    installId: aInstall,
    seq: 2,
    healthy: true,
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, 'release-not-active');
  assert.match(outcome.note ?? '', /superseded/);
});

test('a process restart inside the window invalidates newer reports but keeps earlier samples', () => {
  const h = makeHarness({ instances: { a: ORIGINAL } });
  const id = startSimple(h, { batches: [['a']] });
  const installId = installIdFor(h, id, 'a');

  h.controller.reportHealth({ instanceId: 'a', generation: 1, installId, seq: 1, healthy: true });
  h.adapter('a').restart({ bumpGeneration: true });

  const fromNewProcess = h.controller.reportHealth({
    instanceId: 'a',
    generation: 2,
    installId,
    seq: 2,
    healthy: false,
  });
  assert.equal(fromNewProcess.accepted, false);
  assert.equal(fromNewProcess.reason, 'generation-mismatch');

  h.clock.advance(1_000);
  const decision = h.controller.tick().decisions[0];
  assert.equal(decision.validSamples, 1);
  assert.equal(decision.successes, 1, 'the sample from the frozen generation stands');
});
