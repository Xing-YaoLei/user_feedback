import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  cleanupTmpRoot,
  keyHashOf,
  listIntentIdsOnDisk,
  listKeyHashesOnDisk,
  listTicketIdsOnDisk,
  makeTempDir,
} from '../testlib/harness.ts';
import { TicketStore } from '../src/store.ts';
import { IdempotencyGateway } from '../src/manager.ts';
import { BusinessError, StoreCorruptError, StoreLockedError } from '../src/errors.ts';
import type { ExecutionAdapter } from '../src/types.ts';

after(() => cleanupTmpRoot());

const TENANT = 'store-tenant';
const METHOD = 'store.method';
const KEY = 'store-key';
const IDENTITY = { tenant: TENANT, method: METHOD, idempotencyKey: KEY };

test('atomic writes leave no partial file when a temp write is interrupted', async () => {
  const dir = makeTempDir('store-atomic');
  const store = new TicketStore({ directory: dir });
  try {
    const keyHash = keyHashOf(TENANT, METHOD, KEY);
    const entry = {
      schemaVersion: 1 as const,
      keyHash,
      tenant: TENANT,
      method: METHOD,
      idempotencyKey: KEY,
      requestDigest: 'abc',
      requestSize: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ticketIds: [] as string[],
      headTicketId: null,
    };
    store.writeEntry(entry);
    // Simulate an interrupted write: a stray temp file must not be read as state.
    writeFileSync(join(dir, 'tmp', 'interrupted.tmp'), '{"half":');
    assert.doesNotThrow(() => store.readEntry(keyHash));
    assert.equal(store.readEntry(keyHash)?.requestDigest, 'abc');
    assert.deepEqual(store.sweepTmp(), ['interrupted.tmp']);
    assert.equal(existsSync(join(dir, 'tmp', 'interrupted.tmp')), false);
  } finally {
    store.close();
  }
});

test('a corrupt JSON file surfaces as STORE_CORRUPT rather than a silent reset', () => {
  const dir = makeTempDir('store-corrupt');
  const store = new TicketStore({ directory: dir });
  try {
    const keyHash = keyHashOf(TENANT, METHOD, KEY);
    mkdirSync(join(dir, 'keys', keyHash), { recursive: true });
    writeFileSync(join(dir, 'keys', keyHash, 'entry.json'), '{"schemaVersion": 1,');
    assert.throws(
      () => store.readEntry(keyHash),
      (err: { code?: string }) => {
        assert.equal(err.code, 'STORE_CORRUPT');
        assert.ok(err instanceof StoreCorruptError);
        return true;
      },
    );
  } finally {
    store.close();
  }
});

test('the owner lock admits exactly one manager and is reacquirable after a graceful close', () => {
  const dir = makeTempDir('store-lock');
  const first = new TicketStore({ directory: dir });
  assert.throws(
    () => new TicketStore({ directory: dir }),
    (err: { code?: string }) => {
      assert.equal(err.code, 'STORE_LOCKED');
      assert.ok(err instanceof StoreLockedError);
      return true;
    },
  );
  first.close();
  const second = new TicketStore({ directory: dir });
  second.close();
});

test('a stale owner file from a dead pid is taken over', () => {
  const dir = makeTempDir('store-stale-lock');
  mkdirSync(dir, { recursive: true });
  // pid 1 is not this process; use an implausibly high pid instead so the
  // probe fails with ESRCH deterministically on macOS/Linux.
  writeFileSync(
    join(dir, 'OWNER.json'),
    JSON.stringify({
      pid: 2 ** 30,
      hostname: 'definitely-not-a-real-host',
      startedAt: new Date(0).toISOString(),
      nonce: 'dead',
    }),
  );
  // A foreign hostname means "honour the lock" by design (shared dirs).
  assert.throws(() => new TicketStore({ directory: dir }), (err: { code?: string }) => err.code === 'STORE_LOCKED');

  // Same hostname + dead pid is recoverable.
  writeFileSync(
    join(dir, 'OWNER.json'),
    JSON.stringify({
      pid: 2 ** 30,
      hostname: hostname(),
      startedAt: new Date(0).toISOString(),
      nonce: 'dead',
    }),
  );
  const store = new TicketStore({ directory: dir });
  store.close();
});

test('a missing ledger is rebuilt from ticket files', async () => {
  const dir = makeTempDir('store-ledger-rebuild');
  const adapter: ExecutionAdapter = {
    async execute() {
      return { ok: true };
    },
  };
  const gateway = new IdempotencyGateway({ stateDirectory: dir, adapter });
  try {
    const result = await gateway.invoke({ ...IDENTITY, body: '{"a":1}' });
    const keyHash = keyHashOf(TENANT, METHOD, KEY);
    // Simulate the crash window between the ticket write and the ledger write.
    const entryPath = join(dir, 'keys', keyHash, 'entry.json');
    assert.ok(existsSync(entryPath));
    const saved = readFileSync(entryPath, 'utf8');
    unlinkSync(entryPath);

    const replay = await gateway.invoke({ ...IDENTITY, body: '{"a":1}' });
    assert.equal(replay.ticketId, result.ticketId, 'rebuilt ledger preserves the ticket');
    assert.ok(existsSync(entryPath));
    assert.equal(JSON.parse(readFileSync(entryPath, 'utf8')).ticketIds.length, 1);
    assert.ok(saved.length > 0);
  } finally {
    gateway.close();
  }
});

test('the execution-intent fact exists before the adapter runs and is cleared after', async () => {
  const dir = makeTempDir('store-intent');
  const keyHash = keyHashOf(TENANT, METHOD, KEY);
  let intentsDuringExecute: string[] = [];
  let ticketsDuringExecute: string[] = [];
  const adapter: ExecutionAdapter = {
    async execute() {
      intentsDuringExecute = listIntentIdsOnDisk(dir, keyHash);
      ticketsDuringExecute = listTicketIdsOnDisk(dir, keyHash);
      return { done: true };
    },
  };
  const gateway = new IdempotencyGateway({ stateDirectory: dir, adapter });
  try {
    const result = await gateway.invoke({ ...IDENTITY, body: '{"b":2}' });
    assert.equal(intentsDuringExecute.length, 1, 'intent is durable before the adapter is called');
    assert.equal(intentsDuringExecute[0], result.ticketId);
    assert.deepEqual(ticketsDuringExecute, [result.ticketId], 'ticket is durable before the adapter is called');
    assert.deepEqual(listIntentIdsOnDisk(dir, keyHash), [], 'intent is cleared once the result is stored');
  } finally {
    gateway.close();
  }
});

test('a business error is terminal and survives a restart', async () => {
  const dir = makeTempDir('store-business-restart');
  const adapter: ExecutionAdapter = {
    async execute() {
      throw new BusinessError('E_REJECT', 'nope', { field: 'amount' });
    },
  };
  const first = new IdempotencyGateway({ stateDirectory: dir, adapter });
  const result = await first.invoke({ ...IDENTITY, body: '{"c":3}' });
  assert.equal(result.outcome.type, 'business_error');
  first.close();

  let executedAgain = 0;
  const second = new IdempotencyGateway({
    stateDirectory: dir,
    adapter: {
      async execute() {
        executedAgain += 1;
        return 'should-not-run';
      },
    },
  });
  try {
    const replay = await second.invoke({ ...IDENTITY, body: '{"c":3}' });
    assert.deepEqual(replay.outcome, result.outcome);
    assert.equal(executedAgain, 0, 'stored business error is returned without executing');
  } finally {
    second.close();
  }
});

test('only one gateway per state directory is allowed in-process', () => {
  const dir = makeTempDir('store-one-gateway');
  const adapter: ExecutionAdapter = { async execute() { return 1; } };
  const first = new IdempotencyGateway({ stateDirectory: dir, adapter });
  try {
    assert.throws(
      () => new IdempotencyGateway({ stateDirectory: dir, adapter }),
      (err: { code?: string }) => err.code === 'STORE_LOCKED',
    );
  } finally {
    first.close();
  }
});

test('keys are isolated on disk by tenant, method and idempotency key', () => {
  const dir = makeTempDir('store-key-layout');
  const store = new TicketStore({ directory: dir });
  try {
    const combos = [
      ['a', 'm', 'k'],
      ['a', 'm2', 'k'],
      ['a2', 'm', 'k'],
      ['a', 'm', 'k2'],
    ];
    const hashes = combos.map(([t, m, k]) => keyHashOf(t!, m!, k!));
    assert.equal(new Set(hashes).size, combos.length, 'no key collisions');

    // Ambiguous concatenations must not collide either.
    assert.notEqual(keyHashOf('ab', 'c', 'd'), keyHashOf('a', 'bc', 'd'));
    assert.notEqual(keyHashOf('a', 'bc', 'd'), keyHashOf('a', 'b', 'cd'));
    assert.equal(listKeyHashesOnDisk(dir).length, 0);
  } finally {
    store.close();
  }
});
