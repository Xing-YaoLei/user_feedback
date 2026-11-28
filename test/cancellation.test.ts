import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  cleanupTmpRoot,
  countEffects,
  keyHashOf,
  listTicketIdsOnDisk,
  makeTempDir,
  sleep,
  startServer,
  waitForEffect,
  type GatewayClient,
  type InvokeResult,
} from '../testlib/harness.ts';

const TENANT = 'acme';
const METHOD = 'shipments.create';
const BODY = JSON.stringify({ shipmentId: 'sh-1' });
const KEY = 'idem-cancel';

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanupTmpRoot();
});

type Settled = { ok: true; value: InvokeResult } | { ok: false; error: { code?: string; message: string } };

/**
 * Attaches handlers immediately so a rejection cannot become an unhandled
 * rejection while the test awaits something else.
 */
async function startGuarded(
  client: GatewayClient,
  idempotencyKey: string,
): Promise<{ requestId: string; settled: Promise<Settled> }> {
  const { requestId, result } = await client.startInvoke({
    tenant: TENANT,
    method: METHOD,
    idempotencyKey,
    body: BODY,
  });
  const settled = result.then(
    (value): Settled => ({ ok: true, value }),
    (error): Settled => ({ ok: false, error: error as { code?: string; message: string } }),
  );
  return { requestId, settled };
}

test('cancelling one waiter does not cancel the shared execution or delete the ledger', async () => {
  const dir = makeTempDir('cancel-waiter');
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
    adapterConfig: { holdAfterEffectMs: 600 },
  });
  cleanups.push(() => proc.stop());
  const c1 = await proc.newClient();
  const c2 = await proc.newClient();

  // First caller starts the work; second joins it.
  const waiter1 = await startGuarded(c1, KEY);
  await waitForEffect(proc.effectFile, 1);
  const waiter2 = await startGuarded(c2, KEY);

  // Cancel ONLY the first waiter.
  const cancel = await c1.cancelWaiter(waiter1.requestId);
  assert.equal(cancel.cancelled, true);

  const firstOutcome = await waiter1.settled;
  assert.equal(firstOutcome.ok, false);
  if (!firstOutcome.ok) assert.equal(firstOutcome.error.code, 'WAITER_CANCELLED');

  // The second waiter still receives the shared result.
  const secondOutcome = await waiter2.settled;
  assert.equal(secondOutcome.ok, true);
  assert.equal(secondOutcome.ok && secondOutcome.value.outcome.type, 'success');
  assert.equal(countEffects(proc.effectFile), 1);

  // Cancellation must not delete the ledger: a later call is a cache hit.
  const survivorTicket = secondOutcome.ok ? secondOutcome.value.ticketId : '';
  const later = await c2.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY });
  assert.equal(later.ticketId, survivorTicket);
  assert.equal(countEffects(proc.effectFile), 1);

  const keyHash = keyHashOf(TENANT, METHOD, KEY);
  assert.equal(listTicketIdsOnDisk(proc.stateDir, keyHash).length, 1);
});

test('cancelling every waiter still lets the shared execution finish durably', async () => {
  const dir = makeTempDir('cancel-all');
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
    adapterConfig: { holdAfterEffectMs: 500 },
  });
  cleanups.push(() => proc.stop());
  const c1 = await proc.newClient();
  const c2 = await proc.newClient();

  const w1 = await startGuarded(c1, 'idem-cancel-all');
  await waitForEffect(proc.effectFile, 1);
  const w2 = await startGuarded(c2, 'idem-cancel-all');

  await c1.cancelWaiter(w1.requestId);
  await c2.cancelWaiter(w2.requestId);

  const o1 = await w1.settled;
  const o2 = await w2.settled;
  assert.equal(o1.ok, false);
  assert.equal(o2.ok, false);

  // Give the adapter time to finish and the manager time to persist.
  await sleep(1200);

  const c3 = await proc.newClient();
  const view = await c3.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-cancel-all' });
  assert.ok(!('absent' in view));
  assert.equal(view.derivedStatus, 'completed', 'result was persisted despite all waiters cancelling');
  assert.equal(view.tickets[0]!.status, 'succeeded');

  const hit = await c3.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-cancel-all', body: BODY });
  assert.equal(hit.outcome.type, 'success');
  assert.equal(countEffects(proc.effectFile), 1);
});

test('cancelling an unknown request is a no-op and writes nothing', async () => {
  const dir = makeTempDir('cancel-before');
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
  });
  cleanups.push(() => proc.stop());
  const client = await proc.newClient();

  const cancelled = await client.cancelWaiter('r_unknown');
  assert.equal(cancelled.cancelled, false);
  assert.equal(countEffects(proc.effectFile), 0);
  const view = await client.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'never-used' });
  assert.ok('absent' in view);
});
