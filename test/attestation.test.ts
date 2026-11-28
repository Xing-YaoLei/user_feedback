import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDir, cleanupTmpRoot } from '../testlib/harness.ts';
import { IdempotencyGateway } from '../src/manager.ts';
import type { ExecutionAdapter, ReconciliationProof } from '../src/types.ts';

const TENANT = 'pin';
const METHOD = 'pin.method';
const BODY = '{"p":1}';

function makeGateway(dir: string, adapter: ExecutionAdapter): IdempotencyGateway {
  return new IdempotencyGateway({ stateDirectory: join(dir, 'state'), adapter });
}

async function seedIndeterminate(dir: string): Promise<{ gateway: IdempotencyGateway; ticketId: string }> {
  const gateway = makeGateway(dir, {
    async execute() {
      throw new Error('unknown');
    },
  });
  await gateway.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'k', body: BODY }).catch(() => {});
  const view = gateway.inspectKey({ tenant: TENANT, method: METHOD, idempotencyKey: 'k' });
  assert.ok(view);
  return { gateway, ticketId: view.tickets[0]!.ticketId };
}

test('attestations are irreversible per ticket: a second, different proof is a mismatch', async () => {
  const dir = makeTempDir('pin-irreversible');
  const { gateway, ticketId } = await seedIndeterminate(dir);
  try {
    const completed: ReconciliationProof = {
      kind: 'completed',
      proofId: 'p-ran',
      outcome: { type: 'success', value: 'ran' },
    };
    assert.equal(gateway.reconcile({ ticketId, proof: completed }).status, 'succeeded');

    // Same ticket, different attestation -> the ticket is terminal.
    assert.throws(
      () =>
        gateway.reconcile({
          ticketId,
          proof: { kind: 'completed', proofId: 'p-ran-2', outcome: { type: 'success', value: 'ran' } },
        }),
      (err: { code?: string }) => err.code === 'TICKET_NOT_INDETERMINATE',
    );
  } finally {
    gateway.close();
  }
});

test('the exact same attestation replays idempotently; the same id with a different body is refused', async () => {
  const dir = makeTempDir('pin-replay');
  const { gateway, ticketId } = await seedIndeterminate(dir);
  try {
    const proof: ReconciliationProof = { kind: 'not_executed', proofId: 'p-ne', note: 'checked' };
    const first = gateway.reconcile({ ticketId, proof });
    assert.equal(first.status, 'not_executed');

    const again = gateway.reconcile({ ticketId, proof });
    assert.equal(again.reconciliation?.recordedAt, first.reconciliation?.recordedAt);

    assert.throws(
      () => gateway.reconcile({ ticketId, proof: { kind: 'not_executed', proofId: 'p-ne', note: 'different' } }),
      (err: { code?: string }) => err.code === 'PROOF_MISMATCH',
    );
  } finally {
    gateway.close();
  }
});

test('a rejected proof does not pin a ticket or consume the proof id', async () => {
  const dir = makeTempDir('pin-rejected-no-side-effect');
  const { gateway, ticketId } = await seedIndeterminate(dir);
  try {
    // Wrong identity: rejected before any pin.
    assert.throws(
      () =>
        gateway.reconcile({
          ticketId,
          tenant: 'someone-else',
          proof: { kind: 'not_executed', proofId: 'p-1' },
        }),
      (err: { code?: string }) => err.code === 'PROOF_MISMATCH',
    );
    // The proof id is still usable with the right binding.
    const ok = gateway.reconcile({ ticketId, proof: { kind: 'not_executed', proofId: 'p-1' } });
    assert.equal(ok.status, 'not_executed');
  } finally {
    gateway.close();
  }
});

test('a proof id used on one ticket cannot be applied to another ticket', async () => {
  const dir = makeTempDir('pin-cross-ticket');
  const seed = makeGateway(dir, {
    async execute() {
      throw new Error('unknown');
    },
  });
  await seed.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'a', body: BODY }).catch(() => {});
  await seed.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'b', body: BODY }).catch(() => {});
  const viewA = seed.inspectKey({ tenant: TENANT, method: METHOD, idempotencyKey: 'a' });
  const viewB = seed.inspectKey({ tenant: TENANT, method: METHOD, idempotencyKey: 'b' });
  assert.ok(viewA && viewB);
  const ticketA = viewA.tickets[0]!.ticketId;
  const ticketB = viewB.tickets[0]!.ticketId;

  try {
    seed.reconcile({ ticketId: ticketA, proof: { kind: 'not_executed', proofId: 'shared' } });
    assert.throws(
      () => seed.reconcile({ ticketId: ticketB, proof: { kind: 'not_executed', proofId: 'shared' } }),
      (err: { code?: string }) => err.code === 'PROOF_REPLAYED',
    );
    // Ticket B is still indeterminate and usable with a fresh proof.
    const viewB2 = seed.inspectKey({ tenant: TENANT, method: METHOD, idempotencyKey: 'b' });
    assert.ok(viewB2);
    assert.equal(viewB2.tickets[0]!.status, 'indeterminate');
    assert.equal(seed.reconcile({ ticketId: ticketB, proof: { kind: 'not_executed', proofId: 'fresh' } }).status, 'not_executed');
  } finally {
    seed.close();
    cleanupTmpRoot();
  }
});
