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
  type GatewayClient,
  type ServerProc,
} from '../testlib/harness.ts';

const TENANT = 'acme';
const METHOD = 'refunds.create';
const BODY = JSON.stringify({ refundId: 'rf-1', amountCents: 900 });

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanupTmpRoot();
});

interface CrashDir {
  dir: string;
  effectFile: string;
  stateDir: string;
}

/**
 * Drives the crash window for the given keys: start a manager whose adapter
 * holds after writing the effect, invoke every key, wait for all effects,
 * then SIGKILL. Returns the directory ready to be restarted.
 */
async function crashWithEffects(label: string, keys: string[], body = BODY): Promise<CrashDir> {
  const dir = makeTempDir(label);
  const stateDir = join(dir, 'state');
  const effectFile = join(dir, 'effects.jsonl');
  const proc = await startServer({
    stateDir,
    workDir: join(dir, 'work'),
    effectFile,
    adapterConfig: { holdAfterEffectMs: 30_000 },
  });
  const client = await proc.newClient();
  for (const key of keys) {
    const pending = client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: key, body });
    pending.catch(() => {});
  }
  await waitForEffect(effectFile, keys.length);
  await proc.killHard();
  return { dir, effectFile, stateDir };
}

/** Restarts against a crashed directory; caller owns cleanup. */
async function restart(crash: CrashDir, label = 'restart'): Promise<{ proc: ServerProc; client: GatewayClient }> {
  const proc = await startServer({
    stateDir: crash.stateDir,
    workDir: join(crash.dir, `work-${label}`),
    effectFile: crash.effectFile,
    adapterConfig: { holdAfterEffectMs: 0 },
  });
  cleanups.push(() => proc.stop());
  return { proc, client: await proc.newClient() };
}

interface Ctx {
  proc: ServerProc;
  client: GatewayClient;
}

async function boot(label: string, adapterConfig: Record<string, unknown> = {}): Promise<Ctx> {
  const dir = makeTempDir(label);
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
    adapterConfig,
  });
  cleanups.push(() => proc.stop());
  return { proc, client: await proc.newClient() };
}

test('completed proof after a crash yields the proven result and blocks execution', async () => {
  const crash = await crashWithEffects('reconcile-completed', ['idem-recon']);
  const { proc, client } = await restart(crash);

  const view = await client.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-recon' });
  assert.ok(!('absent' in view));
  const ticketId = view.tickets[0]!.ticketId;
  assert.equal(view.tickets[0]!.status, 'indeterminate');

  const result = await client.reconcile({
    ticketId,
    proof: {
      kind: 'completed',
      proofId: 'executor-proof-77',
      outcome: { type: 'business_error', error: { code: 'ALREADY_REFUNDED', message: 'refund exists' } },
      note: 'executor ledger lookup',
    },
  });
  assert.equal(result.status, 'business_error');
  assert.equal(result.reconciliation?.kind, 'completed');
  assert.equal(result.reconciliation?.note, 'executor ledger lookup');

  // Replay returns the stored business error without executing.
  const replay = await client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-recon', body: BODY });
  assert.equal(replay.ticketId, ticketId);
  assert.equal(replay.outcome.type, 'business_error');
  assert.equal(countEffects(proc.effectFile), 1);

  // Re-sending the exact same proof is idempotent (repairs a crash mid-reconcile).
  const again = await client.reconcile({
    ticketId,
    proof: {
      kind: 'completed',
      proofId: 'executor-proof-77',
      outcome: { type: 'business_error', error: { code: 'ALREADY_REFUNDED', message: 'refund exists' } },
      note: 'executor ledger lookup',
    },
  });
  assert.equal(again.status, 'business_error');
  assert.equal(again.reconciliation?.recordedAt, result.reconciliation?.recordedAt);
  assert.equal(countEffects(proc.effectFile), 1);
});

test('a terminal ticket rejects any second proof, and a proof id cannot be reused with different content', async () => {
  // Two indeterminate tickets in ONE store: needed to prove the proof id is
  // globally single-use, not merely per-ticket.
  const crash = await crashWithEffects('reconcile-two-proofs', ['idem-proof-a', 'idem-proof-b']);
  const { proc, client } = await restart(crash);
  assert.equal(countEffects(proc.effectFile), 2);

  const viewA = await client.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-proof-a' });
  const viewB = await client.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-proof-b' });
  assert.ok(!('absent' in viewA) && !('absent' in viewB));
  const ticketA = viewA.tickets[0]!.ticketId;
  const ticketB = viewB.tickets[0]!.ticketId;
  assert.notEqual(ticketA, ticketB);

  await client.reconcile({
    ticketId: ticketA,
    proof: { kind: 'completed', proofId: 'proof-shared', outcome: { type: 'success', value: { ok: true } } },
  });

  // Same ticket, different proof: the ticket is already terminal.
  await assert.rejects(
    () =>
      client.reconcile({
        ticketId: ticketA,
        proof: { kind: 'completed', proofId: 'proof-other', outcome: { type: 'success', value: { ok: true } } },
      }),
    (err: { code?: string }) => err.code === 'TICKET_NOT_INDETERMINATE',
  );

  // A different, still-indeterminate ticket: reusing the proof id with a
  // different attestation body must be refused. A refused replay is not an
  // attestation, so it must not pin the ticket either.
  await assert.rejects(
    () =>
      client.reconcile({
        ticketId: ticketB,
        proof: { kind: 'completed', proofId: 'proof-shared', outcome: { type: 'success', value: { ok: false } } },
      }),
    (err: { code?: string }) => err.code === 'PROOF_REPLAYED',
  );

  const stillB = await client.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-proof-b' });
  assert.ok(!('absent' in stillB));
  assert.equal(stillB.tickets[0]!.status, 'indeterminate');

  // Ticket B can still be reconciled with a genuinely fresh proof.
  const reconciledB = await client.reconcile({
    ticketId: ticketB,
    proof: { kind: 'not_executed', proofId: 'proof-fresh-b' },
  });
  assert.equal(reconciledB.status, 'not_executed');
  assert.equal(countEffects(proc.effectFile), 2, 'reconciliation never executes');
});

test('reconcile rejects a proof when the identity does not match the ticket', async () => {
  const crash = await crashWithEffects('reconcile-binding', ['idem-binding']);
  const { proc, client } = await restart(crash);

  const view = await client.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-binding' });
  assert.ok(!('absent' in view));
  const ticketId = view.tickets[0]!.ticketId;

  for (const mismatch of [
    { tenant: 'evil-tenant', method: METHOD, idempotencyKey: 'idem-binding' },
    { tenant: TENANT, method: 'some.other.method', idempotencyKey: 'idem-binding' },
    { tenant: TENANT, method: METHOD, idempotencyKey: 'idem-binding-other' },
  ]) {
    await assert.rejects(
      () =>
        client.reconcile({
          ticketId,
          ...mismatch,
          proof: { kind: 'not_executed', proofId: `proof-binding-${Math.random()}` },
        }),
      (err: { code?: string }) => err.code === 'PROOF_MISMATCH',
    );
  }

  // Unknown ticket id is a clean not-found, not a crash.
  await assert.rejects(
    () => client.reconcile({ ticketId: 'tkt_does_not_exist', proof: { kind: 'not_executed', proofId: 'proof-x' } }),
    (err: { code?: string }) => err.code === 'TICKET_NOT_FOUND',
  );
  assert.equal(countEffects(proc.effectFile), 1);
});

test('reclaim only applies to terminal tickets and keeps the key forever', async () => {
  const { proc, client } = await boot('reclaim-terminal-only');

  const ok = await client.invoke({
    tenant: TENANT,
    method: METHOD,
    idempotencyKey: 'idem-reclaim-ok',
    body: BODY,
  });
  const first = await client.reclaim(ok.ticketId, 'admin');
  assert.equal(first.reclaimed, true);
  assert.equal(first.ticket.reclaimReason, 'admin');
  assert.ok(first.ticket.reclaimedOutcomeDigest);

  // Reclaiming an already-reclaimed payload is reported, not an error.
  const again = await client.reclaim(ok.ticketId, 'admin');
  assert.equal(again.reclaimed, false);
  assert.equal(again.alreadyReclaimed, true);

  await assert.rejects(
    () => client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'idem-reclaim-ok', body: BODY }),
    (err: { code?: string }) => err.code === 'RESULT_EXPIRED',
  );

  // Different bytes on the reclaimed key still conflict, not "expired".
  await assert.rejects(
    () =>
      client.invoke({
        tenant: TENANT,
        method: METHOD,
        idempotencyKey: 'idem-reclaim-ok',
        body: JSON.stringify({ refundId: 'rf-1', amountCents: 901 }),
      }),
    (err: { code?: string }) => err.code === 'KEY_CONFLICT',
  );

  assert.equal(countEffects(proc.effectFile), 1);
});

test('a ticket that may be executing is not reclaimable', async () => {
  const dir = makeTempDir('reclaim-pending');
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
    adapterConfig: { holdAfterEffectMs: 30_000 },
  });
  const client = await proc.newClient();
  const inFlight = client.invoke({
    tenant: TENANT,
    method: METHOD,
    idempotencyKey: 'idem-pending-reclaim',
    body: BODY,
  });
  inFlight.catch(() => {});
  await waitForEffect(proc.effectFile, 1);

  const keyHash = keyHashOf(TENANT, METHOD, 'idem-pending-reclaim');
  const ticketId = listTicketIdsOnDisk(proc.stateDir, keyHash)[0]!;

  await assert.rejects(
    () => client.reclaim(ticketId, 'admin'),
    (err: { code?: string }) => err.code === 'TICKET_NOT_TERMINAL',
  );
  await proc.killHard();
  assert.equal(readTicketFile(proc.stateDir, ticketId, keyHash).status, 'pending');
  assert.equal(countEffects(proc.effectFile), 1);
});

test('reclaimExpired drops only payloads whose TTL has elapsed', async () => {
  const dir = makeTempDir('reclaim-ttl');
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
    outcomeTtlMs: 300,
  });
  cleanups.push(() => proc.stop());
  const client = await proc.newClient();

  const r1 = await client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'ttl-1', body: BODY });
  const r2 = await client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'ttl-2', body: BODY });

  const early = await client.reclaimExpired();
  assert.equal(early.reclaimed.length, 0, 'nothing expires before its TTL');

  await new Promise((r) => setTimeout(r, 500));

  const sweep = await client.reclaimExpired();
  assert.deepEqual(
    sweep.reclaimed.map((r) => r.ticketId).sort(),
    [r1.ticketId, r2.ticketId].sort(),
  );
  for (const r of sweep.reclaimed) {
    assert.equal(r.reclaimed, true);
    assert.equal(r.ticket.reclaimReason, 'ttl');
  }

  for (const r of [r1, r2]) {
    await assert.rejects(
      () => client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: r.idempotencyKey, body: BODY }),
      (err: { code?: string }) => err.code === 'RESULT_EXPIRED',
    );
  }
  assert.equal(countEffects(proc.effectFile), 2, 'TTL reclamation never re-executes');

  // Outlive another TTL window: still expired, still no execution.
  await new Promise((r) => setTimeout(r, 400));
  const late = await client.reclaimExpired();
  assert.equal(late.reclaimed.length, 0, 'already-reclaimed payloads are not reclaimed twice');
});
