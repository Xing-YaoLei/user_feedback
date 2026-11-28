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
  startServer,
  type GatewayClient,
} from '../testlib/harness.ts';

const TENANT = 'matrix';
const METHOD = 'matrix.method';
const KEY = 'matrix-key';
const BODY = JSON.stringify({ n: 1 });

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanupTmpRoot();
});

/**
 * The manager performs exactly four durable writes for one fresh-key invoke:
 *   1. ticket   2. ledger   3. execution intent   4. terminal result
 * `faultAfterWrites = n` hard-exits the process before write #(n+1), i.e. at
 * an exact crash boundary. The adapter runs between writes 3 and 4.
 *
 * After every crash point, restarting must never execute the effect twice and
 * must report the key as indeterminate (never silently retry).
 */
const CASES = [
  { fault: 0, tickets: 0, intents: 0, effects: 0, note: 'before the ticket was written' },
  { fault: 1, tickets: 1, intents: 0, effects: 0, note: 'after ticket, before ledger' },
  { fault: 2, tickets: 1, intents: 0, effects: 0, note: 'after ledger, before intent' },
  { fault: 3, tickets: 1, intents: 1, effects: 1, note: 'after intent and effect, before result' },
] as const;

for (const scenario of CASES) {
  test(`crash #${scenario.fault} (${scenario.note}) recovers without a second execution`, async () => {
    const dir = makeTempDir(`matrix-${scenario.fault}`);
    const stateDir = join(dir, 'state');
    const effectFile = join(dir, 'effects.jsonl');
    const keyHash = keyHashOf(TENANT, METHOD, KEY);

    const crashing = await startServer({
      stateDir,
      workDir: join(dir, 'work'),
      effectFile,
      faultAfterWrites: scenario.fault,
    });
    const client = await crashing.newClient();
    const outcome = await client
      .invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY })
      .then(
        (r) => ({ ok: true as const, r }),
        (e) => ({ ok: false as const, e: e as { code?: string } }),
      );

    // The injected crash must have ended the process.
    const exitCode = await crashing.waitExit();
    assert.equal(exitCode, 87, `expected the fault-injection exit code, got ${exitCode}\n${crashing.logs()}`);
    assert.equal(outcome.ok, false, 'the caller must not receive a success across a crash');

    // On-disk facts at the crash point.
    assert.equal(listTicketIdsOnDisk(stateDir, keyHash).length, scenario.tickets, 'ticket files');
    assert.equal(listIntentIdsOnDisk(stateDir, keyHash).length, scenario.intents, 'intent files');
    assert.equal(countEffects(effectFile), scenario.effects, 'adapter effects');

    // --- restart: recovery must be conservative --------------------------
    const recovered = await startServer({
      stateDir,
      workDir: join(dir, 'work-2'),
      effectFile,
    });
    cleanups.push(() => recovered.stop());
    const client2: GatewayClient = await recovered.newClient();

    if (scenario.tickets === 0) {
      // Nothing was persisted: this is a genuinely fresh key.
      const view = await client2.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: KEY });
      assert.ok('absent' in view, 'an unpersisted key is absent');
      const fresh = await client2.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY });
      assert.equal(fresh.outcome.type, 'success');
      assert.equal(countEffects(effectFile), 1, 'the fresh invoke executes exactly once');
      return;
    }

    const view = await client2.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: KEY });
    assert.ok(!('absent' in view));
    assert.equal(view.tickets.length, 1, 'recovery never invents tickets');
    assert.equal(view.tickets[0]!.status, 'indeterminate', 'a ticket without a terminal state is indeterminate');
    assert.equal(countEffects(effectFile), scenario.effects, 'recovery never executes');

    // Retrying is refused; this holds for every crash point, including the
    // two where nothing actually ran (safety over liveness).
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(
        () => client2.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY }),
        (err: { code?: string }) => err.code === 'INDETERMINATE',
      );
    }
    assert.equal(countEffects(effectFile), scenario.effects, 'indeterminate retries never execute');

    // The recovery note reflects whether the intent fact existed: evidence
    // the reconciler can use to choose a proof kind.
    const reason = String(view.tickets[0]!.indeterminateReason);
    if (scenario.intents > 0) {
      assert.match(reason, /intent/i);
    } else {
      assert.match(reason, /before execution intent/i);
    }

    // A not_executed proof lets the key proceed; a new ticket executes once.
    const reconciled = await client2.reconcile({
      ticketId: view.tickets[0]!.ticketId,
      proof: { kind: 'not_executed', proofId: `proof-matrix-${scenario.fault}` },
    });
    assert.equal(reconciled.status, 'not_executed');

    const retried = await client2.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY });
    assert.equal(retried.outcome.type, 'success');
    assert.equal(countEffects(effectFile), scenario.effects + 1, 'exactly one new effect after the proof');

    // And it never repeats.
    const twice = await client2.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY });
    assert.equal(twice.ticketId, retried.ticketId);
    assert.equal(countEffects(effectFile), scenario.effects + 1);
  });
}

test('crash during reconcile (proof written, ticket not yet) is repaired by resending the proof', async () => {
  const dir = makeTempDir('matrix-reconcile-crash');
  const stateDir = join(dir, 'state');
  const effectFile = join(dir, 'effects.jsonl');

  // Seed one indeterminate ticket with a real effect: crash before the result.
  const seeding = await startServer({
    stateDir,
    workDir: join(dir, 'work'),
    effectFile,
    faultAfterWrites: 3,
  });
  const c0 = await seeding.newClient();
  await c0
    .invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'recon-crash', body: BODY })
    .catch(() => {});
  assert.equal(await seeding.waitExit(), 87);
  assert.equal(countEffects(effectFile), 1);

  // Recover once so the ticket is a settled 'indeterminate' (not 'pending').
  const recovered = await startServer({ stateDir, workDir: join(dir, 'work-2'), effectFile });
  const c1 = await recovered.newClient();
  const view = await c1.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'recon-crash' });
  assert.ok(!('absent' in view));
  const ticketId = view.tickets[0]!.ticketId;
  assert.equal(view.tickets[0]!.status, 'indeterminate');
  await recovered.stop();

  // Reconcile in a process that dies after the proof record is durably
  // written but before the ticket update. faultAfterWrites=1: recovery makes
  // no ticket write now, so write #1 is the proof and write #2 would be the
  // ticket.
  const crashingReconcile = await startServer({
    stateDir,
    workDir: join(dir, 'work-3'),
    effectFile,
    faultAfterWrites: 1,
  });
  const c2 = await crashingReconcile.newClient();
  await c2
    .reconcile({
      ticketId,
      proof: { kind: 'completed', proofId: 'proof-recon-crash', outcome: { type: 'success', value: { n: 1 } } },
    })
    .catch(() => {});
  assert.equal(await crashingReconcile.waitExit(), 87);

  // Restart: the ticket is still indeterminate, but the proof is on disk.
  const after = await startServer({ stateDir, workDir: join(dir, 'work-4'), effectFile });
  cleanups.push(() => after.stop());
  const c3 = await after.newClient();
  const midView = await c3.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'recon-crash' });
  assert.ok(!('absent' in midView));
  assert.equal(midView.tickets[0]!.status, 'indeterminate', 'a half-applied proof never fabricates a result');
  assert.equal(midView.tickets[0]!.hasOutcome, false);

  // Resending the exact same proof completes the application.
  const applied = await c3.reconcile({
    ticketId,
    proof: { kind: 'completed', proofId: 'proof-recon-crash', outcome: { type: 'success', value: { n: 1 } } },
  });
  assert.equal(applied.status, 'succeeded');

  const read = await c3.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'recon-crash', body: BODY });
  assert.equal(read.ticketId, ticketId);
  assert.deepEqual(read.outcome, { type: 'success', value: { n: 1 } });
  assert.equal(countEffects(effectFile), 1, 'reconciliation and its repair never execute');
});

test('a half-applied attestation cannot be replaced by a contradictory proof', async () => {
  const dir = makeTempDir('matrix-contradictory-proof');
  const stateDir = join(dir, 'state');
  const effectFile = join(dir, 'effects.jsonl');

  // Seed an indeterminate ticket with a real effect.
  const seeding = await startServer({
    stateDir,
    workDir: join(dir, 'work'),
    effectFile,
    faultAfterWrites: 3,
  });
  const c0 = await seeding.newClient();
  await c0
    .invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'contradictory', body: BODY })
    .catch(() => {});
  assert.equal(await seeding.waitExit(), 87);

  const recovered = await startServer({ stateDir, workDir: join(dir, 'work-2'), effectFile });
  const c1 = await recovered.newClient();
  const view = await c1.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'contradictory' });
  assert.ok(!('absent' in view));
  const ticketId = view.tickets[0]!.ticketId;
  await recovered.stop();

  // Attest 'completed', then die before the ticket update lands.
  const completed = { kind: 'completed' as const, proofId: 'proof-says-ran', outcome: { type: 'success' as const, value: 'ran' } };
  const crashing = await startServer({
    stateDir,
    workDir: join(dir, 'work-3'),
    effectFile,
    faultAfterWrites: 2, // writes: attestation, proof; crash before the ticket write
  });
  const c2 = await crashing.newClient();
  await c2.reconcile({ ticketId, proof: completed }).catch(() => {});
  assert.equal(await crashing.waitExit(), 87);

  // After restart the ticket is still indeterminate...
  const after = await startServer({ stateDir, workDir: join(dir, 'work-4'), effectFile });
  cleanups.push(() => after.stop());
  const c3 = await after.newClient();
  const mid = await c3.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'contradictory' });
  assert.ok(!('absent' in mid));
  assert.equal(mid.tickets[0]!.status, 'indeterminate');
  assert.equal(mid.tickets[0]!.hasOutcome, false);

  // ...but it may NOT be unlocked by a contradicting 'not_executed' proof.
  await assert.rejects(
    () => c3.reconcile({ ticketId, proof: { kind: 'not_executed', proofId: 'proof-says-not-ran' } }),
    (err: { code?: string }) => err.code === 'PROOF_MISMATCH',
  );
  // And no retry is possible: the key stays blocked.
  await assert.rejects(
    () => c3.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'contradictory', body: BODY }),
    (err: { code?: string }) => err.code === 'INDETERMINATE',
  );
  assert.equal(countEffects(effectFile), 1, 'a contradictory proof never unlocks a second effect');

  // Re-sending the original attestation finishes the job.
  const applied = await c3.reconcile({ ticketId, proof: completed });
  assert.equal(applied.status, 'succeeded');
  const read = await c3.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'contradictory', body: BODY });
  assert.deepEqual(read.outcome, { type: 'success', value: 'ran' });
  assert.equal(countEffects(effectFile), 1);
});
