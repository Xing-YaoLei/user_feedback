import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  cleanupTmpRoot,
  countEffects,
  keyHashOf,
  listTicketIdsOnDisk,
  makeTempDir,
  readJsonl,
  readTicketFile,
  startServer,
  waitForEffect,
} from '../testlib/harness.ts';

const TENANT = 'acme';
const METHOD = 'payments.charge';
const KEY = 'idem-crash-1';
const BODY = JSON.stringify({ chargeId: 'ch-1', amountCents: 1250 });
const PROVEN_RESULT = { type: 'success', value: { chargeStored: true, chargeId: 'ch-1', amountCents: 1250 } };

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanupTmpRoot();
});

interface Scenario {
  dir: string;
  stateDir: string;
  workDir: string;
  effectFile: string;
}

function scenario(label: string): Scenario {
  const dir = makeTempDir(label);
  return {
    dir,
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
  };
}

async function boot(s: Scenario, adapterConfig: Record<string, unknown> = {}) {
  const proc = await startServer({
    stateDir: s.stateDir,
    workDir: s.workDir,
    effectFile: s.effectFile,
    adapterConfig,
  });
  return proc;
}

/**
 * THE core crash scenario.
 *
 * Two concurrent invokes race for one key. The adapter has already written
 * its (non-idempotent) local effect when we SIGKILL the manager, so on
 * restart we must see exactly one indeterminate ticket and exactly one real
 * effect. Reconciliation then makes both retries read the same result, and
 * reclaiming that result must still not allow a second effect.
 */
test('crash between effect and saved result leaves one indeterminate ticket and one effect', async () => {
  const s = scenario('crash-window');
  const keyHash = keyHashOf(TENANT, METHOD, KEY);

  // --- phase 1: run the effect, then die inside the crash window ----------
  const first = await boot(s, { holdAfterEffectMs: 30_000 });
  cleanups.push(() => first.stop());
  const clientA = await first.newClient();
  const clientB = await first.newClient();

  // Two genuinely concurrent requests for the same key, on separate sockets.
  const invokeA = clientA.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY });
  const invokeB = clientB.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY });
  // Avoid unhandled rejections when the manager is killed below.
  invokeA.catch(() => {});
  invokeB.catch(() => {});

  // Wait until the adapter's durable effect exists. At this instant the
  // manager has not persisted any terminal result yet (it is holding).
  await waitForEffect(s.effectFile, 1);
  assert.equal(countEffects(s.effectFile), 1, 'exactly one effect while in the crash window');

  // The ticket and intent must already be durable before execution.
  assert.equal(listTicketIdsOnDisk(s.stateDir, keyHash).length, 1, 'exactly one ticket before the crash');

  const killedAt = first.child.pid;
  await first.killHard();
  assert.ok(killedAt);

  // A hard kill means no handler ran; the state directory is what survives.
  const ticketIdsAfterCrash = listTicketIdsOnDisk(s.stateDir, keyHash);
  assert.equal(ticketIdsAfterCrash.length, 1);
  const crashedTicket = readTicketFile(s.stateDir, ticketIdsAfterCrash[0]!, keyHash);
  assert.equal(crashedTicket.status, 'pending', 'ticket is still pending right after the crash');
  assert.equal(crashedTicket.outcome, null);

  // --- phase 2: restart, expect indeterminate + no automatic re-execution -
  const second = await boot(s);
  cleanups.push(() => second.stop());
  const clientC = await second.newClient();

  const status = (await clientC.status()) as {
    startupReport: { indeterminateTicketIds: string[] };
  };
  assert.deepEqual(
    status.startupReport.indeterminateTicketIds,
    [ticketIdsAfterCrash[0]],
    'startup recovery reports the pending ticket as indeterminate',
  );

  const view = await clientC.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: KEY });
  assert.ok(!('absent' in view));
  assert.equal(view.tickets.length, 1, 'recovery must not create a new ticket');
  assert.equal(view.tickets[0]!.status, 'indeterminate');
  assert.equal(view.derivedStatus, 'indeterminate');
  assert.match(String(view.tickets[0]!.indeterminateReason), /may have run|intent/i);
  assert.equal(countEffects(s.effectFile), 1, 'recovery must not execute again');

  // A retry against an indeterminate ticket is refused, and executes nothing.
  await assert.rejects(
    () => clientC.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY }),
    (err: { code?: string }) => {
      assert.equal(err.code, 'INDETERMINATE');
      return true;
    },
  );
  assert.equal(countEffects(s.effectFile), 1, 'indeterminate retry must not execute');

  // --- phase 3: reconcile with a completed proof -------------------------
  const indeterminateId = view.tickets[0]!.ticketId;
  const reconciled = await clientC.reconcile({
    ticketId: indeterminateId,
    proof: { kind: 'completed', proofId: 'proof-completed-1', outcome: PROVEN_RESULT },
  });
  assert.equal(reconciled.status, 'succeeded');
  assert.equal(reconciled.reconciliation?.proofId, 'proof-completed-1');
  assert.equal(countEffects(s.effectFile), 1);

  // --- phase 4: both retries read the same result, no second effect ------
  const [retryA, retryB] = await Promise.all([
    clientC.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY }),
    clientC.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY }),
  ]);
  assert.equal(retryA.ticketId, indeterminateId, 'retries reuse the reconciled ticket');
  assert.equal(retryB.ticketId, indeterminateId);
  assert.deepEqual(retryA.outcome, PROVEN_RESULT);
  assert.deepEqual(retryB.outcome, PROVEN_RESULT);
  assert.equal(countEffects(s.effectFile), 1, 'reconciled retries must not execute');

  // --- phase 5: reclaim the payload, still no second effect -------------
  const reclaim = await clientC.reclaim(indeterminateId, 'admin');
  assert.equal(reclaim.reclaimed, true);
  assert.equal(reclaim.ticket.hasOutcome, false);

  await assert.rejects(
    () => clientC.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY }),
    (err: { code?: string }) => {
      assert.equal(err.code, 'RESULT_EXPIRED');
      return true;
    },
  );
  assert.equal(countEffects(s.effectFile), 1, 'an expired result must never unlock a second effect');

  // The key and the execution fact stay on disk after reclamation.
  const finalView = await clientC.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: KEY });
  assert.ok(!('absent' in finalView));
  assert.equal(finalView.derivedStatus, 'expired');
  assert.equal(finalView.tickets.length, 1);
  assert.ok(finalView.tickets[0]!.reclaimedOutcomeDigest, 'digest of the dropped payload is retained');
  assert.equal(finalView.tickets[0]!.reclaimReason, 'admin');

  // And after another restart, still expired, still one effect.
  await second.killHard();
  const third = await boot(s);
  cleanups.push(() => third.stop());
  const clientD = await third.newClient();
  await assert.rejects(
    () => clientD.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: KEY, body: BODY }),
    (err: { code?: string }) => {
      assert.equal(err.code, 'RESULT_EXPIRED');
      return true;
    },
  );
  assert.equal(countEffects(s.effectFile), 1, 'restart after reclamation must not execute');

  // Effect log: exactly one record, for exactly this identity.
  const effects = readJsonl(s.effectFile);
  assert.equal(effects.length, 1);
  assert.equal(effects[0]!.idempotencyKey, KEY);
  assert.equal(effects[0]!.ticketId, indeterminateId);
});

test('not_executed proof is the only attestation that permits a fresh ticket and retry', async () => {
  const s = scenario('not-executed');
  const keyHash = keyHashOf(TENANT, METHOD, 'idem-no-effect');
  const body = JSON.stringify({ chargeId: 'ch-2' });

  // The adapter fails *before* writing any effect, so the outcome is unknown
  // to the manager even though nothing happened in reality.
  const first = await boot(s, { failMode: 'before_effect' });
  cleanups.push(() => first.stop());
  const clientA = await first.newClient();

  await assert.rejects(
    () => clientA.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-no-effect', body }),
    (err: { code?: string }) => {
      assert.equal(err.code, 'INDETERMINATE');
      return true;
    },
  );
  assert.equal(countEffects(s.effectFile), 0, 'failed-before-effect adapter wrote nothing');

  // Restart so the ticket is definitely recovered as indeterminate.
  await first.killHard();
  const second = await boot(s);
  cleanups.push(() => second.stop());
  const clientB = await second.newClient();

  const before = await clientB.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-no-effect' });
  assert.ok(!('absent' in before));
  assert.equal(before.tickets[0]!.status, 'indeterminate');
  const firstTicketId = before.tickets[0]!.ticketId;

  const reconciled = await clientB.reconcile({
    ticketId: firstTicketId,
    proof: { kind: 'not_executed', proofId: 'proof-not-executed-1', note: 'executor confirms no effect' },
  });
  assert.equal(reconciled.status, 'not_executed');

  // Now a retry is allowed and creates a second ticket; it executes once.
  const retry = await clientB.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-no-effect', body });
  assert.notEqual(retry.ticketId, firstTicketId, 'not_executed proof permits a fresh ticket');
  assert.equal(retry.outcome.type, 'success');
  assert.equal(countEffects(s.effectFile), 1, 'retry after not_executed proof executes exactly once');

  // A further retry returns the same success, no third execution.
  const again = await clientB.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-no-effect', body });
  assert.equal(again.ticketId, retry.ticketId);
  assert.equal(countEffects(s.effectFile), 1);

  const after2 = await clientB.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-no-effect' });
  assert.ok(!('absent' in after2));
  assert.equal(after2.tickets.length, 2, 'ledger keeps both the denied ticket and the new one');
  assert.equal(after2.tickets[0]!.status, 'not_executed');
  assert.equal(after2.tickets[1]!.status, 'succeeded');
  assert.equal(listTicketIdsOnDisk(s.stateDir, keyHash).length, 2);
});

test('pending ticket from a crash is never refreshed into a new execution by another pending path', async () => {
  const s = scenario('pending-no-live-exec');
  const keyHash = keyHashOf(TENANT, METHOD, 'idem-pending');

  const first = await boot(s, { holdAfterEffectMs: 30_000 });
  cleanups.push(() => first.stop());
  const client = await first.newClient();
  const pending = client.invoke({
    tenant: TENANT,
    method: METHOD,
    idempotencyKey: 'idem-pending',
    body: BODY,
  });
  pending.catch(() => {});
  await waitForEffect(s.effectFile, 1);

  // Hard kill while the adapter is still holding. Do NOT restart: instead
  // inspect the on-disk state directly, then restart.
  await first.killHard();
  const ids = listTicketIdsOnDisk(s.stateDir, keyHash);
  assert.equal(ids.length, 1);
  assert.equal(readTicketFile(s.stateDir, ids[0]!, keyHash).status, 'pending');

  const second = await boot(s, { holdAfterEffectMs: 0 });
  cleanups.push(() => second.stop());
  const client2 = await second.newClient();

  // Five concurrent retries: all must be refused, none may execute.
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      client2.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-pending', body: BODY }),
    ),
  );
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'rejected');
    if (attempt.status === 'rejected') {
      assert.equal((attempt.reason as { code?: string }).code, 'INDETERMINATE');
    }
  }
  assert.equal(countEffects(s.effectFile), 1, 'no retry may execute');

  const view = await client2.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-pending' });
  assert.ok(!('absent' in view));
  assert.equal(view.tickets.length, 1);
  assert.equal(view.tickets[0]!.status, 'indeterminate');
});
