import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, CANDIDATE, ORIGINAL } from './helpers.ts';
import type { InstallCommand } from '../src/types.ts';

const OPERATOR_FIX = { feature: { enabled: true, rollout: 60 }, by: 'on-call' };

/**
 * Walkthrough of the scenario called out in the specification:
 *  - batch 0 passes;
 *  - batch 1 looks healthy early but deteriorates right before the window
 *    closes, so the decision fails;
 *  - one instance's install receipt arrives after the failure (rollback is
 *    parked until it lands);
 *  - another instance is edited externally before the rollback reaches it, so
 *    the conditional restore is skipped and the operator's change survives.
 */
function runScenario() {
  const h = makeHarness({
    instances: { a: ORIGINAL, b: ORIGINAL, c: ORIGINAL, d: ORIGINAL, e: ORIGINAL },
    start: 0,
  });

  const id = h.controller.startRelease({
    releaseId: 'demo-1',
    candidate: CANDIDATE,
    batches: [['a', 'b', 'c'], ['d', 'e']],
    observationMs: 10_000,
    minValidSamples: 2,
    successRatio: 0.9,
  });

  const installIds = () => {
    const map = new Map<string, string>();
    for (const batch of h.controller.explain(id).batches) {
      for (const instance of batch.instances) map.set(instance.instanceId, instance.installId);
    }
    return map;
  };

  // Batch 0: all three healthy, window runs to t=10s.
  for (const [instanceId, installId] of installIds()) {
    h.controller.reportHealth({ instanceId, generation: 1, installId, seq: 1, healthy: true });
  }
  // d's receipt will be stuck on the wire when batch 1 installs its candidate.
  h.adapter('d').beginHold();
  h.clock.advance(10_000);
  h.controller.tick();
  assert.equal(h.controller.explain(id).batches[0].status, 'passed');

  // Batch 1 opens at t=10s. e looks healthy, d's install receipt is late so
  // d is not yet a valid sample.
  const batchOne = installIds();
  h.controller.reportHealth({
    instanceId: 'e',
    generation: 1,
    installId: batchOne.get('e')!,
    seq: 1,
    healthy: true,
  });

  // e deteriorates just before the window closes.
  h.clock.advance(9_900);
  h.controller.reportHealth({
    instanceId: 'e',
    generation: 1,
    installId: batchOne.get('e')!,
    seq: 2,
    healthy: false,
  });

  // c is edited by an operator before the rollback is sent.
  h.adapter('c').applyExternalConfig(OPERATOR_FIX, 'on-call hotfix');

  h.clock.advance(100);
  const decision = h.controller.tick().decisions.at(-1)!;
  assert.equal(decision.advanced, false);
  assert.equal(decision.frozenTotal, 2);
  assert.equal(decision.successes, 0);
  assert.equal(decision.validSamples, 1);
  assert.deepEqual(decision.reasons.sort(), [
    'insufficient-valid-samples',
    'ratio-below-threshold',
  ]);

  // Rollback: a, b and e restored immediately; c skipped (external change);
  // d parked until its install receipt arrives.
  let view = h.controller.explain(id);
  assert.equal(view.status, 'failed');
  assert.deepEqual(
    view.batches.map((batch) => batch.status),
    ['passed', 'failed'],
  );
  assert.deepEqual(view.restoreSummary.restored.sort(), ['a', 'b', 'e']);
  assert.deepEqual(view.restoreSummary.skippedCondition, ['c']);
  assert.deepEqual(view.restoreSummary.awaitingInstallReceipt, ['d']);
  assert.deepEqual(h.adapter('c').snapshot().config, OPERATOR_FIX);

  // d's install receipt arrives late, then the parked restore's own receipt.
  const dAdapter = h.adapter('d');
  const lateInstallReceipts = dAdapter.releaseHeld();
  assert.equal(lateInstallReceipts.length, 1);
  for (const receipt of lateInstallReceipts) dAdapter.deliver(receipt);
  for (const receipt of dAdapter.releaseHeld()) dAdapter.deliver(receipt);

  view = h.controller.explain(id);
  assert.deepEqual(view.restoreSummary.restored.sort(), ['a', 'b', 'd', 'e']);
  assert.deepEqual(view.restoreSummary.awaitingInstallReceipt, []);
  assert.deepEqual(dAdapter.snapshot().config, ORIGINAL);

  return { h, id, view };
}

test('scenario: brief pass, late-window deterioration, late receipt, external edit', () => {
  const { view } = runScenario();

  assert.equal(view.status, 'failed');
  const failedBatch = view.batches[1];
  assert.equal(failedBatch.decision!.advanced, false);
  const d = failedBatch.instances.find((instance) => instance.instanceId === 'd')!;
  const e = failedBatch.instances.find((instance) => instance.instanceId === 'e')!;
  // d's install was confirmed only by the late receipt, long after the window
  // closed, so it never became a sample despite running the candidate.
  assert.equal(d.health.sampleStatus, 'missing-report');
  assert.equal(d.install.status, 'confirmed');
  assert.equal(e.health.sampleStatus, 'unhealthy');
  assert.equal(e.health.latestSeq, 2);

  const c = view.batches[0].instances.find((instance) => instance.instanceId === 'c')!;
  assert.equal(c.restore.status, 'skipped-condition');
  assert.match(c.restore.reason ?? '', /outside this release/);

  // The explanation spells out what happened in each batch and rollback.
  const text = view.summary.join('\n');
  assert.match(text, /batch 0: advanced/);
  assert.match(text, /batch 1: failed/);
  assert.match(text, /rollback: 4 restored/);
  assert.match(text, /c: rollback skipped/);
});

test('scenario: a superseded install arriving late cannot change the failed run', () => {
  const h = makeHarness({ instances: { a: ORIGINAL }, start: 0 });
  const adapter = h.adapter('a');
  adapter.holdCommands();

  const first = h.controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });
  const [firstInstall] = adapter.drainHeldCommands() as InstallCommand[];

  // A second release wins the race and installs its own candidate.
  adapter.holdCommands();
  const second = h.controller.startRelease({
    candidate: { feature: { enabled: true, rollout: 100 } },
    batches: [['a']],
    observationMs: 1_000,
    minValidSamples: 1,
    successRatio: 1,
  });
  const [secondInstall] = adapter.drainHeldCommands() as InstallCommand[];
  adapter.deliverCommand(secondInstall);
  adapter.deliverCommand(firstInstall);

  assert.equal(adapter.snapshot().config.feature.rollout, 100);
  assert.equal(h.controller.explain(first).status, 'superseded');
  assert.equal(h.controller.explain(second).status, 'running');
});
