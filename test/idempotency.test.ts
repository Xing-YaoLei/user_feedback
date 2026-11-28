import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  cleanupTmpRoot,
  countEffects,
  keyHashOf,
  listIntentIdsOnDisk,
  listTicketIdsOnDisk,
  makeTempDir,
  readTicketFile,
  startServer,
  type ServerProc,
} from '../testlib/harness.ts';

const TENANT = 'acme';
const METHOD = 'orders.create';
const KEY = 'idem-basic-1';
const BODY = JSON.stringify({ orderId: 'o-1', amount: 42 });

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanupTmpRoot();
});

async function boot(label: string): Promise<{ proc: ServerProc; client: Awaited<ReturnType<ServerProc['newClient']>> }> {
  const dir = makeTempDir(label);
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
  });
  cleanups.push(() => proc.stop());
  return { proc, client: await proc.newClient() };
}

test('same key + same bytes executes exactly once and returns the same result', async () => {
  const { proc, client } = await boot('basic-once');

  const first = await client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY });
  const second = await client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY });

  assert.equal(first.outcome.type, 'success');
  assert.equal(second.ticketId, first.ticketId);
  assert.deepEqual(second.outcome, first.outcome);
  assert.equal(countEffects(proc.effectFile), 1, 'adapter must run exactly once');

  const view = await client.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: KEY });
  assert.ok(!('absent' in view));
  assert.equal(view.derivedStatus, 'completed');
  assert.equal(view.tickets.length, 1);
  assert.equal(view.tickets[0]!.status, 'succeeded');

  const keyHash = keyHashOf(TENANT, METHOD, KEY);
  // The execution-intent fact is removed once a terminal result is stored.
  assert.deepEqual(listIntentIdsOnDisk(proc.stateDir, keyHash), []);
});

test('two concurrent callers on one key share one execution', async () => {
  const dir = makeTempDir('basic-concurrent');
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
    adapterConfig: { holdAfterEffectMs: 250 },
  });
  cleanups.push(() => proc.stop());
  const client = await proc.newClient();

  const [a, b] = await Promise.all([
    client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-concurrent', body: BODY }),
    client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-concurrent', body: BODY }),
  ]);

  assert.equal(a.ticketId, b.ticketId, 'concurrent callers must share one ticket');
  assert.deepEqual(a.outcome, b.outcome);
  assert.equal(countEffects(proc.effectFile), 1);

  const view = await client.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-concurrent' });
  assert.ok(!('absent' in view));
  assert.equal(view.tickets.length, 1);
});

test('same key with different raw bytes returns a conflict and never executes', async () => {
  const { proc, client } = await boot('basic-conflict');

  const first = await client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-conflict', body: BODY });
  assert.equal(first.outcome.type, 'success');

  await assert.rejects(
    () =>
      client.invoke({
        tenant: TENANT,
        method: METHOD,
        idempotencyKey: 'idem-conflict',
        // Semantically similar JSON, different bytes (whitespace/key order).
        body: JSON.stringify({ amount: 42, orderId: 'o-1' }, null, 2),
      }),
    (err: { code?: string }) => {
      assert.equal(err.code, 'KEY_CONFLICT');
      return true;
    },
  );
  assert.equal(countEffects(proc.effectFile), 1, 'a conflict must not execute');
});

test('different tenants or methods are isolated', async () => {
  const { proc, client } = await boot('basic-isolation');

  const a = await client.invoke({ tenant: 'tenant-a', method: METHOD, idempotencyKey: KEY, body: BODY });
  const b = await client.invoke({ tenant: 'tenant-b', method: METHOD, idempotencyKey: KEY, body: BODY });
  const c = await client.invoke({ tenant: 'tenant-a', method: 'orders.cancel', idempotencyKey: KEY, body: BODY });

  assert.notEqual(a.ticketId, b.ticketId);
  assert.notEqual(a.ticketId, c.ticketId);
  assert.equal(countEffects(proc.effectFile), 3);

  const keyHashA = keyHashOf('tenant-a', METHOD, KEY);
  const keyHashB = keyHashOf('tenant-b', METHOD, KEY);
  assert.notEqual(keyHashA, keyHashB);
  assert.equal(listTicketIdsOnDisk(proc.stateDir, keyHashA).length, 1);
  assert.equal(listTicketIdsOnDisk(proc.stateDir, keyHashB).length, 1);
});

test('a deterministic business rejection is stored as a terminal result', async () => {
  const dir = makeTempDir('basic-business-error');
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
    adapterConfig: { rejectKeys: ['idem-rejected'], rejectCode: 'POLICY_DENIED' },
  });
  cleanups.push(() => proc.stop());
  const client = await proc.newClient();

  const first = await client.invoke({
    tenant: TENANT,
    method: METHOD,
    idempotencyKey: 'idem-rejected',
    body: BODY,
  });
  assert.equal(first.outcome.type, 'business_error');
  assert.equal(
    first.outcome.type === 'business_error' ? first.outcome.error.code : null,
    'POLICY_DENIED',
  );

  // Replay must return the stored rejection, not call the adapter again.
  const second = await client.invoke({
    tenant: TENANT,
    method: METHOD,
    idempotencyKey: 'idem-rejected',
    body: BODY,
  });
  assert.deepEqual(second.outcome, first.outcome);
  assert.equal(second.ticketId, first.ticketId);
  assert.equal(countEffects(proc.effectFile), 0);

  const keyHash = keyHashOf(TENANT, METHOD, 'idem-rejected');
  const ticketFile = readTicketFile(proc.stateDir, first.ticketId, keyHash);
  assert.equal(ticketFile.status, 'business_error');
});
