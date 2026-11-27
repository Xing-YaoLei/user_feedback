import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { InMemoryInstanceAdapter } from '../src/adapter.ts';
import type { AdapterCommand, CommandReceipt, InstallCommand, RestoreCommand } from '../src/types.ts';

function setup(initialConfig: unknown = { v: 0 }) {
  const clock = new ManualClock(0);
  const adapter = new InMemoryInstanceAdapter({
    instanceId: 'i1',
    generation: 1,
    initialConfig,
    clock,
  });
  const receipts: CommandReceipt[] = [];
  adapter.setReceiptSink((receipt) => receipts.push(receipt));
  return { clock, adapter, receipts };
}

function install(intent: number, extra: Partial<InstallCommand> = {}): InstallCommand {
  return {
    kind: 'install',
    intent,
    instanceId: 'i1',
    releaseId: 'r',
    installId: `ins-${intent}`,
    generation: 1,
    config: { v: intent },
    ...extra,
  };
}

function restore(intent: number, expectedReleaseId = 'r'): RestoreCommand {
  return {
    kind: 'restore',
    intent,
    instanceId: 'i1',
    releaseId: expectedReleaseId,
    restoreId: `rst-${intent}`,
    expectedReleaseId,
    targetConfig: { v: 0 },
  };
}

test('an install receipt reports the config it actually replaced', () => {
  const { adapter, receipts } = setup({ v: 'original' });
  adapter.enqueue(install(1));
  assert.equal(receipts.length, 1);
  const receipt = receipts[0];
  assert.equal(receipt.kind, 'install');
  assert.ok(receipt.ok);
  assert.deepEqual(receipt.replacedConfig, { v: 'original' });
  assert.equal(receipt.installId, 'ins-1');
  assert.deepEqual(adapter.snapshot().config, { v: 1 });
});

test('a command with an intent that is not newer is rejected and changes nothing', () => {
  const { adapter, receipts } = setup({ v: 'original' });
  adapter.enqueue(install(5));
  adapter.enqueue(install(5, { config: { v: 'same-intent' } }));
  adapter.enqueue(install(4, { config: { v: 'older' } }));

  assert.deepEqual(adapter.snapshot().config, { v: 5 });
  const rejected = receipts.slice(1);
  assert.equal(rejected.length, 2);
  for (const receipt of rejected) {
    assert.equal(receipt.ok, false);
    assert.equal(receipt.reason, 'stale-intent');
  }
});

test('a stale command cannot win even when the newer command was itself rejected', () => {
  const { adapter, receipts } = setup({ v: 'original' });
  // Newer intent, but it targets a different release's condition. It is
  // rejected after the fence has advanced.
  adapter.enqueue(restore(10, 'some-other-release'));
  assert.equal(receipts.at(-1)?.ok, false);
  assert.equal(receipts.at(-1)?.reason, 'condition-mismatch');
  assert.equal(adapter.snapshot().lastIntent, 10);

  // Now an older install shows up late.
  adapter.enqueue(install(9, { config: { v: 'zombie' } }));
  assert.deepEqual(adapter.snapshot().config, { v: 'original' });
  assert.equal(receipts.at(-1)?.reason, 'stale-intent');
});

test('restore only applies while the release still owns the install', () => {
  const { adapter, receipts } = setup({ v: 'original' });
  adapter.enqueue(install(1));
  adapter.applyExternalConfig({ v: 'operator' }, 'hotfix');
  const before = receipts.length;

  adapter.enqueue(restore(2));
  const receipt = receipts[before];
  assert.equal(receipt.kind, 'restore');
  assert.equal(receipt.ok, false);
  assert.equal(receipt.reason, 'condition-mismatch');
  assert.deepEqual(adapter.snapshot().config, { v: 'operator' }, 'external change preserved');
});

test('restore applies to the release-owned install and reports the previous owner', () => {
  const { adapter, receipts } = setup({ v: 'original' });
  adapter.enqueue(install(1));
  const before = receipts.length;
  adapter.enqueue(restore(2));

  const receipt = receipts[before];
  assert.equal(receipt.kind, 'restore');
  assert.ok(receipt.ok);
  assert.deepEqual(receipt.previousOwner, { kind: 'release', releaseId: 'r', installId: 'ins-1' });
  assert.deepEqual(adapter.snapshot().config, { v: 0 });
  assert.equal(adapter.snapshot().owner.kind, 'restored');
});

test('an install aimed at a different process generation is refused with details', () => {
  const { adapter, receipts } = setup();
  adapter.restart({ bumpGeneration: true });
  adapter.enqueue(install(1, { generation: 1 }));
  const receipt = receipts.at(-1)!;
  assert.equal(receipt.ok, false);
  assert.equal(receipt.reason, 'wrong-generation');
  assert.equal(receipt.kind === 'install' && receipt.actualGeneration, 2);
  assert.deepEqual(adapter.snapshot().config, { v: 0 });
});

test('commands held in transit can be replayed out of order and the fence still wins', () => {
  const { adapter, receipts } = setup({ v: 'original' });
  adapter.holdCommands();
  const a = install(1, { config: { v: 'first' } });
  const rest = restore(2);
  adapter.drainHeldCommands();
  adapter.deliverCommand(rest);
  adapter.deliverCommand(a);
  // restore ran first on a non-release-owned install -> condition mismatch;
  // the older install is then refused as stale.
  assert.deepEqual(adapter.snapshot().config, { v: 'original' });
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].reason, 'condition-mismatch');
  assert.equal(receipts[1].reason, 'stale-intent');
});

test('a crashed adapter drops commands and reports zero receipts', () => {
  const { adapter, receipts } = setup();
  adapter.crash();
  const accepted = adapter.enqueue(install(1));
  assert.equal(accepted, false);
  assert.equal(adapter.droppedCommands, 1);
  assert.equal(receipts.length, 0);
  assert.deepEqual(adapter.snapshot().config, { v: 0 });
});

test('manual delivery keeps receipts queued until flushed', () => {
  const { adapter, receipts } = setup();
  adapter.setDeliveryMode('manual');
  adapter.enqueue(install(1, { config: { v: 'manual' } }));
  assert.equal(receipts.length, 0);
  assert.equal(adapter.pendingReceiptCount, 1);
  adapter.flush();
  assert.equal(receipts.length, 1);
  assert.deepEqual(adapter.snapshot().config, { v: 'manual' });
});

test('commands aimed at another instance are rejected without touching state', () => {
  const { adapter, receipts } = setup();
  adapter.enqueue({ ...install(1), instanceId: 'other' } as AdapterCommand);
  assert.equal(receipts.at(-1)?.ok, false);
  assert.equal(receipts.at(-1)?.reason, 'wrong-instance');
  assert.deepEqual(adapter.snapshot().config, { v: 0 });
  assert.equal(adapter.snapshot().lastIntent, 0);
});
