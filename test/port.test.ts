import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { ConfigReleaseController } from '../src/controller.ts';
import type {
  AdapterCommand,
  AdapterPort,
  AdapterSnapshot,
  CommandReceipt,
  ConfigValue,
} from '../src/types.ts';

/**
 * A deliberately tiny adapter written against the public AdapterPort only.
 * It proves the controller does not depend on InMemoryInstanceAdapter's
 * concrete behaviour: the caller supplies the install/restore semantics and
 * the receipt shapes.
 */
class RecordingAdapter implements AdapterPort {
  readonly instanceId: string;
  readonly generation = 1;
  readonly commands: AdapterCommand[] = [];
  config: ConfigValue;
  owner: AdapterSnapshot['owner'] = { kind: 'initial' };
  lastIntent = 0;
  revision = 0;
  #sink: ((receipt: CommandReceipt) => void) | null = null;
  #clock: ManualClock;
  /** Fail this many install commands before accepting any. */
  rejectInstalls = 0;

  constructor(instanceId: string, initialConfig: ConfigValue, clock: ManualClock) {
    this.instanceId = instanceId;
    this.config = initialConfig;
    this.#clock = clock;
  }

  enqueue(command: AdapterCommand): boolean {
    this.commands.push(command);
    if (command.kind === 'install' && this.rejectInstalls > 0) {
      this.rejectInstalls -= 1;
      this.lastIntent = Math.max(this.lastIntent, command.intent);
      this.#sink?.({
        kind: 'install',
        ok: false,
        intent: command.intent,
        instanceId: this.instanceId,
        releaseId: command.releaseId,
        installId: command.installId,
        generation: command.generation,
        reason: 'condition-mismatch',
        lastIntent: this.lastIntent,
        currentOwner: { ...this.owner },
        rejectedAt: this.#clock.now(),
        actualGeneration: this.generation,
      });
      return true;
    }
    if (command.intent <= this.lastIntent) {
      this.#sink?.({
        kind: command.kind,
        ok: false,
        intent: command.intent,
        instanceId: this.instanceId,
        releaseId: command.releaseId,
        ...(command.kind === 'install'
          ? { installId: command.installId, generation: command.generation }
          : { restoreId: command.restoreId }),
        reason: 'stale-intent',
        lastIntent: this.lastIntent,
        currentOwner: { ...this.owner },
        rejectedAt: this.#clock.now(),
      } as CommandReceipt);
      return true;
    }
    this.lastIntent = command.intent;

    if (command.kind === 'install') {
      const replacedConfig = this.config;
      this.config = command.config;
      this.owner = { kind: 'release', releaseId: command.releaseId, installId: command.installId };
      this.revision += 1;
      this.#sink?.({
        kind: 'install',
        ok: true,
        intent: command.intent,
        instanceId: this.instanceId,
        releaseId: command.releaseId,
        installId: command.installId,
        generation: command.generation,
        replacedConfig,
        appliedAt: this.#clock.now(),
        revision: this.revision,
      });
      return true;
    }

    if (this.owner.kind !== 'release' || this.owner.releaseId !== command.expectedReleaseId) {
      this.#sink?.({
        kind: 'restore',
        ok: false,
        intent: command.intent,
        instanceId: this.instanceId,
        releaseId: command.releaseId,
        restoreId: command.restoreId,
        reason: 'condition-mismatch',
        lastIntent: this.lastIntent,
        currentOwner: { ...this.owner },
        rejectedAt: this.#clock.now(),
      });
      return true;
    }

    const previousOwner = this.owner;
    this.config = command.targetConfig;
    this.owner = { kind: 'restored', releaseId: command.releaseId, restoreId: command.restoreId };
    this.revision += 1;
    this.#sink?.({
      kind: 'restore',
      ok: true,
      intent: command.intent,
      instanceId: this.instanceId,
      releaseId: command.releaseId,
      restoreId: command.restoreId,
      restoredConfig: this.config,
      previousOwner,
      appliedAt: this.#clock.now(),
      revision: this.revision,
    });
    return true;
  }

  setReceiptSink(sink: ((receipt: CommandReceipt) => void) | null): void {
    this.#sink = sink;
  }

  snapshot(): AdapterSnapshot {
    return {
      instanceId: this.instanceId,
      generation: this.generation,
      config: this.config,
      owner: { ...this.owner },
      lastIntent: this.lastIntent,
      revision: this.revision,
    };
  }
}

const ORIGINAL = { mode: 'stable' };
const CANDIDATE = { mode: 'canary' };

test('the controller drives any AdapterPort implementation, not just the in-memory one', () => {
  const clock = new ManualClock(0);
  const controller = new ConfigReleaseController({ clock });
  const a = new RecordingAdapter('a', ORIGINAL, clock);
  const b = new RecordingAdapter('b', ORIGINAL, clock);
  controller.registerAdapter(a).registerAdapter(b);

  const id = controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a'], ['b']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });

  const installId = controller.explain(id).batches[0].instances[0].installId;
  assert.equal(
    controller.reportHealth({ instanceId: 'a', generation: 1, installId, seq: 1, healthy: true })
      .accepted,
    true,
  );
  clock.advance(100);
  controller.tick();

  const secondInstall = controller.explain(id).batches[1].instances[0].installId;
  controller.reportHealth({
    instanceId: 'b',
    generation: 1,
    installId: secondInstall,
    seq: 1,
    healthy: true,
  });
  clock.advance(100);
  controller.tick();

  assert.equal(controller.explain(id).status, 'succeeded');
  assert.deepEqual(a.config, CANDIDATE);
  assert.deepEqual(b.config, CANDIDATE);
  // The controller assigned strictly increasing intents per instance.
  assert.deepEqual(
    a.commands.map((command) => command.intent),
    [1],
  );
  assert.deepEqual(
    b.commands.map((command) => command.intent),
    [1],
  );
});

test('a custom adapter reporting a rejected install is reflected without a rollback', () => {
  const clock = new ManualClock(0);
  const controller = new ConfigReleaseController({ clock });
  const flaky = new RecordingAdapter('a', ORIGINAL, clock);
  flaky.rejectInstalls = 1;
  controller.registerAdapter(flaky);

  const id = controller.startRelease({
    candidate: CANDIDATE,
    batches: [['a']],
    observationMs: 100,
    minValidSamples: 1,
    successRatio: 1,
  });

  clock.advance(100);
  const decision = controller.tick().decisions[0];
  assert.equal(decision.advanced, false);
  assert.equal(decision.installRejected, 1);

  const view = controller.explain(id);
  const instance = view.batches[0].instances[0];
  assert.equal(instance.install.status, 'rejected');
  assert.equal(instance.install.rejectionReason, 'condition-mismatch');
  assert.equal(instance.restore.status, 'not-needed');
  assert.deepEqual(flaky.config, ORIGINAL);
  // Only the install command was sent; no restore for a rejected install.
  assert.equal(flaky.commands.length, 1);
  assert.equal(flaky.commands[0].kind, 'install');
});
