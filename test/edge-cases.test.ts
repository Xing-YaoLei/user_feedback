import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  cleanupTmpRoot,
  countEffects,
  keyHashOf,
  listTicketIdsOnDisk,
  makeTempDir,
  readTicketFile,
  startServer,
  waitForEffect,
  type ServerProc,
} from '../testlib/harness.ts';
import { IdempotencyGateway } from '../src/manager.ts';
import type { ExecutionAdapter } from '../src/types.ts';
const TENANT = 'edge';
const METHOD = 'edge.method';
const BODY = JSON.stringify({ e: 1 });

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanupTmpRoot();
});

test('a completed result survives a restart and is returned without executing', async () => {
  const dir = makeTempDir('edge-restart-cached');
  let executions = 0;
  const first = new IdempotencyGateway({
    stateDirectory: join(dir, 'state'),
    adapter: {
      async execute() {
        executions += 1;
        return { run: executions };
      },
    },
  });
  const initial = await first.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'k', body: BODY });
  first.close();

  const second = new IdempotencyGateway({
    stateDirectory: join(dir, 'state'),
    adapter: {
      async execute() {
        executions += 1;
        return { run: executions };
      },
    },
  });
  cleanups.push(async () => second.close());
  const replayed = await second.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'k', body: BODY });
  assert.equal(replayed.ticketId, initial.ticketId);
  assert.deepEqual(replayed.outcome, initial.outcome);
  assert.equal(executions, 1, 'restart must not re-execute a completed key');
});

test('not_executed proof on a retained ticket cannot be applied twice with a different proof', async () => {
  const dir = makeTempDir('edge-double-not-executed');
  const adapter: ExecutionAdapter = {
    async execute() {
      throw new Error('unknown failure');
    },
  };
  const gateway = new IdempotencyGateway({ stateDirectory: join(dir, 'state'), adapter });
  cleanups.push(async () => gateway.close());

  await assert.rejects(
    () => gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'k', body: BODY }),
    (err: { code?: string }) => err.code === 'INDETERMINATE',
  );
  const view = gateway.inspectKey({ tenant: TENANT, method: METHOD, idempotencyKey: 'k' });
  assert.ok(view);
  const ticketId = view.tickets[0]!.ticketId;

  const first = gateway.reconcile({ ticketId, proof: { kind: 'not_executed', proofId: 'ne-1' } });
  assert.equal(first.status, 'not_executed');

  // A different proof is rejected because the ticket already reached a state.
  assert.throws(
    () => gateway.reconcile({ ticketId, proof: { kind: 'not_executed', proofId: 'ne-2' } }),
    (err: { code?: string }) => err.code === 'TICKET_NOT_INDETERMINATE',
  );
  // The exact same proof is an idempotent replay.
  const replay = gateway.reconcile({ ticketId, proof: { kind: 'not_executed', proofId: 'ne-1' } });
  assert.equal(replay.status, 'not_executed');

  // Out-of-order proof kinds do not resurrect the ticket either.
  assert.throws(
    () =>
      gateway.reconcile({
        ticketId,
        proof: { kind: 'completed', proofId: 'ne-3', outcome: { type: 'success', value: 1 } },
      }),
    (err: { code?: string }) => err.code === 'TICKET_NOT_INDETERMINATE',
  );
});

test('the retried ticket after a not_executed proof shares the crash rules', async () => {
  const dir = makeTempDir('edge-retry-crash');
  const keyHash = keyHashOf(TENANT, METHOD, 'edge-retry');
  const stateDir = join(dir, 'state');
  const effectFile = join(dir, 'effects.jsonl');

  // Seed: indeterminate ticket with an effect.
  const seed = await startServer({
    stateDir,
    workDir: join(dir, 'w0'),
    effectFile,
    adapterConfig: { holdAfterEffectMs: 30_000 },
  });
  const c0 = await seed.newClient();
  c0.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-retry', body: BODY }).catch(() => {});
  await waitForEffect(effectFile, 1);
  await seed.killHard();

  // Recover, prove not_executed, then let the retry crash inside its own
  // effect window: the retry ticket (sequence 2) must become indeterminate.
  const step1: ServerProc = await startServer({
    stateDir,
    workDir: join(dir, 'w1'),
    effectFile,
    adapterConfig: { holdAfterEffectMs: 30_000 },
  });
  cleanups.push(() => step1.stop());
  const c1 = await step1.newClient();
  const view1 = await c1.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-retry' });
  assert.ok(!('absent' in view1));
  const firstTicket = view1.tickets[0]!.ticketId;
  await c1.reconcile({ ticketId: firstTicket, proof: { kind: 'not_executed', proofId: 'edge-ne' } });

  const retry = c1.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-retry', body: BODY });
  retry.catch(() => {});
  await waitForEffect(effectFile, 2);
  await step1.killHard();

  const step2 = await startServer({ stateDir, workDir: join(dir, 'w2'), effectFile });
  cleanups.push(() => step2.stop());
  const c2 = await step2.newClient();
  const view2 = await c2.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-retry' });
  assert.ok(!('absent' in view2));
  assert.equal(view2.tickets.length, 2, 'both tickets retained');
  assert.equal(view2.tickets[0]!.status, 'not_executed', 'the denied ticket keeps its proof');
  assert.equal(view2.tickets[1]!.status, 'indeterminate', 'the retry ticket is now indeterminate');
  assert.equal(view2.derivedStatus, 'indeterminate');
  assert.equal(countEffects(effectFile), 2);
  assert.equal(listTicketIdsOnDisk(stateDir, keyHash).length, 2);

  // Still no automatic execution on the new head.
  await assert.rejects(
    () => c2.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-retry', body: BODY }),
    (err: { code?: string }) => err.code === 'INDETERMINATE',
  );
  assert.equal(countEffects(effectFile), 2);

  // Completing the retry ticket yields its proven result.
  const done = await c2.reconcile({
    ticketId: view2.tickets[1]!.ticketId,
    proof: { kind: 'completed', proofId: 'edge-completed-2', outcome: { type: 'success', value: { second: true } } },
  });
  assert.equal(done.status, 'succeeded');
  const read = await c2.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-retry', body: BODY });
  assert.deepEqual(read.outcome, { type: 'success', value: { second: true } });
  assert.equal(countEffects(effectFile), 2);
});

test('business-error results are reclaimable exactly like successes', async () => {
  const dir = makeTempDir('edge-reclaim-business');
  const gateway = new IdempotencyGateway({
    stateDirectory: join(dir, 'state'),
    adapter: {
      async execute() {
        const { BusinessError } = await import('../src/errors.ts');
        throw new BusinessError('NOPE', 'rejected deterministically');
      },
    },
  });
  cleanups.push(async () => gateway.close());

  const result = await gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'k', body: BODY });
  assert.equal(result.outcome.type, 'business_error');

  const reclaim = gateway.reclaim(result.ticketId, { reason: 'ttl' });
  assert.equal(reclaim.reclaimed, true);
  assert.equal(reclaim.ticket.outcomeType, null);

  await assert.rejects(
    () => gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'k', body: BODY }),
    (err: { code?: string }) => err.code === 'RESULT_EXPIRED',
  );
  const file = readTicketFile(join(dir, 'state'), result.ticketId, keyHashOf(TENANT, METHOD, 'k'));
  assert.equal(file.status, 'business_error', 'the terminal status is retained after reclamation');
});

test('byte-exact bodies distinguish otherwise-equal JSON, and identical bytes share a ticket', async () => {
  const dir = makeTempDir('edge-bytes');
  let executions = 0;
  const gateway = new IdempotencyGateway({
    stateDirectory: join(dir, 'state'),
    adapter: {
      async execute({ body }) {
        executions += 1;
        return { bytes: Buffer.from(body).toString('base64') };
      },
    },
  });
  cleanups.push(async () => gateway.close());

  const a = new TextEncoder().encode('{"x":1,"y":2}');
  const b = new TextEncoder().encode('{"y":2,"x":1}'); // same JSON semantics
  const c = new TextEncoder().encode('{"x":1,"y":2}'); // identical bytes to a

  const first = await gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'k', body: a });
  const same = await gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'k', body: c });
  assert.equal(same.ticketId, first.ticketId);
  assert.equal(executions, 1);

  await assert.rejects(
    () => gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'k', body: b }),
    (err: { code?: string }) => err.code === 'KEY_CONFLICT',
  );
  assert.equal(executions, 1);
});

test('a huge body is digested and stored by reference, not re-serialized', async () => {
  const dir = makeTempDir('edge-large-body');
  let seenLength = 0;
  const gateway = new IdempotencyGateway({
    stateDirectory: join(dir, 'state'),
    adapter: {
      async execute({ body }) {
        seenLength = body.length;
        return { length: body.length };
      },
    },
  });
  cleanups.push(async () => gateway.close());

  const big = new Uint8Array(256 * 1024).fill(7);
  const result = await gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'big', body: big });
  assert.equal(seenLength, big.length);
  assert.deepEqual(result.outcome, { type: 'success', value: { length: big.length } });

  const again = await gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'big', body: big });
  assert.equal(again.ticketId, result.ticketId);
});

test('an adapter that throws before any effect still yields indeterminate (safe, not optimistic)', async () => {
  const dir = makeTempDir('edge-fail-before');
  const gateway = new IdempotencyGateway({
    stateDirectory: join(dir, 'state'),
    adapter: {
      async execute() {
        throw new Error('connection refused before write');
      },
    },
  });
  cleanups.push(async () => gateway.close());

  await assert.rejects(
    () => gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'k', body: BODY }),
    (err: { code?: string }) => err.code === 'INDETERMINATE',
  );
  const view = gateway.inspectKey({ tenant: TENANT, method: METHOD, idempotencyKey: 'k' });
  assert.ok(view);
  assert.equal(view.tickets[0]!.status, 'indeterminate');
  assert.match(String(view.tickets[0]!.indeterminateReason), /connection refused/);
});

test('if the terminal result cannot be persisted, the effect is never reported as success', async () => {
  const dir = makeTempDir('edge-result-write-failure');
  const { chmodSync } = await import('node:fs');
  const keyHash = keyHashOf(TENANT, METHOD, 'edge-write-fail');
  const stateDir = join(dir, 'state');
  const ticketDir = join(stateDir, 'keys', keyHash, 'tickets');

  let executions = 0;
  const adapter: ExecutionAdapter = {
    async execute() {
      executions += 1;
      // Make the ticket directory unwritable *after* the ticket was written
      // and while the adapter is "running", so the terminal-result write fails
      // exactly inside the crash window.
      chmodSync(ticketDir, 0o500);
      return { effect: executions };
    },
  };
  const gateway = new IdempotencyGateway({ stateDirectory: stateDir, adapter });
  cleanups.push(async () => gateway.close());

  await assert.rejects(
    () => gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-write-fail', body: BODY }),
    (err: { code?: string }) => err.code === 'INDETERMINATE',
  );
  assert.equal(executions, 1, 'the effect did run');

  // The store is unwritable, so the ticket cannot even be marked indeterminate
  // yet; it stays 'pending', which recovery settles on the next start.
  const view = gateway.inspectKey({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-write-fail' });
  assert.ok(view);
  assert.equal(view.tickets[0]!.status, 'pending');
  assert.equal(view.tickets[0]!.hasOutcome, false);

  // Same-process retry is refused; no second effect.
  await assert.rejects(
    () => gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-write-fail', body: BODY }),
    (err: { code?: string }) => err.code === 'INDETERMINATE',
  );
  assert.equal(executions, 1, 'no second effect');

  gateway.close();
  chmodSync(ticketDir, 0o700);

  // Restart: the pending ticket becomes indeterminate, never re-executed.
  const restarted = new IdempotencyGateway({
    stateDirectory: stateDir,
    adapter: {
      async execute() {
        executions += 1;
        return { effect: executions };
      },
    },
  });
  cleanups.push(async () => restarted.close());

  const after = restarted.inspectKey({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-write-fail' });
  assert.ok(after);
  assert.equal(after.tickets[0]!.status, 'indeterminate');

  await assert.rejects(
    () => restarted.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'edge-write-fail', body: BODY }),
    (err: { code?: string }) => err.code === 'INDETERMINATE',
  );
  assert.equal(executions, 1, 'the restart never re-executes');
});
