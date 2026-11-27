/**
 * Runnable demonstration of the release controller.
 *
 *   npm run demo
 *
 * It exercises the situation described in the specification:
 *   - batch 0 passes;
 *   - batch 1 is healthy at first but deteriorates at the end of its window;
 *   - one install receipt arrives very late (after the failure);
 *   - one instance is edited by an operator before the rollback reaches it.
 *
 * Everything is deterministic: the clock is manual, and install/health
 * traffic is delivered explicitly.
 */
import { ManualClock } from './clock.ts';
import { InMemoryInstanceAdapter } from './adapter.ts';
import { ConfigReleaseController } from './controller.ts';
import type { ConfigValue, HealthReport } from './types.ts';

const ORIGINAL: ConfigValue = { checkout: { timeoutMs: 2_000, retries: 2 } };
const CANDIDATE: ConfigValue = { checkout: { timeoutMs: 800, retries: 4 } };
const OPERATOR_FIX: ConfigValue = { checkout: { timeoutMs: 2_500, retries: 2 }, by: 'on-call' };

const clock = new ManualClock(0);
const controller = new ConfigReleaseController({ clock });
const instances = ['edge-1', 'edge-2', 'edge-3', 'edge-4', 'edge-5'];
const adapters = new Map<string, InMemoryInstanceAdapter>();

for (const instanceId of instances) {
  const adapter = new InMemoryInstanceAdapter({
    instanceId,
    generation: 1,
    initialConfig: ORIGINAL,
    clock,
  });
  adapters.set(instanceId, adapter);
  controller.registerAdapter(adapter);
}

function report(instanceId: string, seq: number, healthy: boolean): void {
  const install = controller
    .explain()
    .batches.flatMap((batch) => batch.instances)
    .find((candidate) => candidate.instanceId === instanceId)!;
  const health: HealthReport = {
    instanceId,
    generation: install.generation,
    installId: install.installId,
    seq,
    healthy,
  };
  controller.reportHealth(health);
}

function line(text = ''): void {
  console.log(`t=${String(clock.now()).padStart(6)}ms  ${text}`);
}

function printDecision(batchIndex: number): void {
  const decision = controller.explain().batches[batchIndex].decision;
  if (!decision) return;
  line(`BATCH ${batchIndex} → ${decision.advanced ? 'ADVANCE' : 'STOP'}  ${decision.message}`);
}

// ------------------------------------------------------------------ run
line('starting release "checkout-2026-11" over 2 batches');
const releaseId = controller.startRelease({
  releaseId: 'checkout-2026-11',
  candidate: CANDIDATE,
  batches: [
    ['edge-1', 'edge-2', 'edge-3'],
    ['edge-4', 'edge-5'],
  ],
  observationMs: 10_000,
  minValidSamples: 2,
  successRatio: 0.9,
});

line('batch 0 installed, all three report healthy');
for (const instanceId of ['edge-1', 'edge-2', 'edge-3']) report(instanceId, 1, true);

// edge-4's install receipt will be lost on the wire while its config applies.
adapters.get('edge-4')!.beginHold();

clock.advance(10_000);
controller.tick();
printDecision(0);

line('batch 1 installed at t=10s; edge-5 healthy at first');
report('edge-5', 1, true);

clock.advance(9_900);
line('edge-5 deteriorates at the end of the window');
report('edge-5', 2, false);
line('an operator hotfixes edge-3 before the rollback is sent');
adapters.get('edge-3')!.applyExternalConfig(OPERATOR_FIX, 'on-call');

clock.advance(100);
controller.tick();
printDecision(1);

let view = controller.explain(releaseId);
line();
line('--- after the failed window ---');
for (const text of view.summary) console.log(`        ${text}`);

line();
line('edge-4 install receipt arrives very late');
const edge4 = adapters.get('edge-4')!;
for (const receipt of edge4.releaseHeld()) edge4.deliver(receipt);

view = controller.explain(releaseId);
line();
line('--- final state ---');
for (const text of view.summary) console.log(`        ${text}`);
line();
for (const instanceId of instances) {
  const snapshot = adapters.get(instanceId)!.snapshot();
  const restored = JSON.stringify(snapshot.config) === JSON.stringify(ORIGINAL) ? 'original' : 'OTHER';
  line(`${instanceId}: ${restored} config, owner=${snapshot.owner.kind}`);
}

line();
line('--- per-instance view ---');
for (const batch of view.batches) {
  line(`batch ${batch.index} (${batch.status})`);
  for (const instance of batch.instances) {
    line(
      `  ${instance.instanceId}: install=${instance.install.status}` +
        ` health=${instance.health.sampleStatus}` +
        ` latestSeq=${instance.health.latestSeq ?? '-'}` +
        ` restore=${instance.restore.status}` +
        (instance.restore.reason ? ` (${instance.restore.reason})` : ''),
    );
  }
}

if (view.status !== 'failed') {
  throw new Error(`demo expected the release to fail, got "${view.status}"`);
}
if (view.restoreSummary.skippedCondition.length !== 1) {
  throw new Error('demo expected exactly one rollback skipped by an external change');
}
line();
line('demo complete: release stopped, rollback accounted for, operator change preserved');
