import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupTmpRoot,
  countEffects,
  makeTempDir,
  OPS_ENTRY,
  REPO_ROOT,
  startServer,
  waitForEffect,
} from '../testlib/harness.ts';

const TENANT = 'ops-tenant';
const METHOD = 'ops.method';
const BODY = JSON.stringify({ op: 1 });

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanupTmpRoot();
});

function ops(
  endpointFile: string,
  args: string[],
): { code: number | null; json: unknown; error: unknown; stderr: string } {
  const run = spawnSync(process.execPath, [OPS_ENTRY, '--endpoint', endpointFile, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const parse = (text: string): unknown => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  };
  return { code: run.status, json: parse(run.stdout), error: parse(run.stderr), stderr: run.stderr };
}

test('operator CLI drives reconciliation end to end over the RPC socket', async () => {
  const dir = makeTempDir('ops-cli');
  const crashing = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
    adapterConfig: { holdAfterEffectMs: 30_000 },
  });
  const client = await crashing.newClient();
  const pending = client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'ops-key', body: BODY });
  pending.catch(() => {});
  await waitForEffect(crashing.effectFile, 1);
  await crashing.killHard();

  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work-2'),
    effectFile: join(dir, 'effects.jsonl'),
  });
  cleanups.push(() => proc.stop());

  // list
  const list = ops(proc.endpointFile, ['list']);
  assert.equal(list.code, 0);
  const tickets = list.json as Array<{ ticketId: string; status: string }>;
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0]!.status, 'indeterminate');
  const ticketId = tickets[0]!.ticketId;

  // show
  const show = ops(proc.endpointFile, ['show', '--ticket', ticketId]);
  assert.equal(show.code, 0);
  assert.equal((show.json as { status: string }).status, 'indeterminate');

  // show missing -> non-zero exit, machine-readable error on stderr
  const missing = ops(proc.endpointFile, ['show', '--ticket', 'tkt_nope']);
  assert.notEqual(missing.code, 0);
  assert.equal((missing.error as { error: { code: string } }).error.code, 'TICKET_NOT_FOUND');

  // key
  const key = ops(proc.endpointFile, ['key', '--tenant', TENANT, '--method', METHOD, '--key', 'ops-key']);
  assert.equal(key.code, 0);
  assert.equal((key.json as { derivedStatus: string }).derivedStatus, 'indeterminate');

  // reconcile (proof from @file to exercise that path too)
  const proofFile = join(dir, 'proof.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    proofFile,
    JSON.stringify({ kind: 'completed', proofId: 'cli-proof-1', outcome: { type: 'success', value: { via: 'cli' } } }),
  );
  const reconcile = ops(proc.endpointFile, ['reconcile', '--ticket', ticketId, '--proof', `@${proofFile}`]);
  assert.equal(reconcile.code, 0);
  assert.equal((reconcile.json as { status: string }).status, 'succeeded');

  // A second, different proof is refused with a non-zero exit.
  const again = ops(proc.endpointFile, [
    'reconcile',
    '--ticket',
    ticketId,
    '--proof',
    JSON.stringify({ kind: 'not_executed', proofId: 'cli-proof-2' }),
  ]);
  assert.notEqual(again.code, 0);
  assert.equal((again.error as { code: string }).code, 'TICKET_NOT_INDETERMINATE');

  // The result is now readable via RPC, and no extra effect happened.
  const replay = await proc.newClient().then((c) =>
    c.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'ops-key', body: BODY }),
  );
  assert.deepEqual(replay.outcome, { type: 'success', value: { via: 'cli' } });
  assert.equal(countEffects(proc.effectFile), 1);

  // reclaim + reclaim-expired both work through the CLI.
  const reclaim = ops(proc.endpointFile, ['reclaim', '--ticket', ticketId, '--reason', 'admin']);
  assert.equal(reclaim.code, 0);
  assert.equal((reclaim.json as { reclaimed: boolean }).reclaimed, true);

  const sweep = ops(proc.endpointFile, ['reclaim-expired']);
  assert.equal(sweep.code, 0);
  assert.equal((sweep.json as { reclaimed: unknown[] }).reclaimed.length, 0);
});
