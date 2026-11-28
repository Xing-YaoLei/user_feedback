import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  cleanupTmpRoot,
  countEffects,
  makeTempDir,
  startServer,
  type GatewayClient,
} from '../testlib/harness.ts';
import { GatewayClient as DirectClient } from '../src/client.ts';

after(() => cleanupTmpRoot());

const TENANT = 'validate';
const METHOD = 'validate.method';
const BODY = '{"v":1}';

async function boot(label: string, adapterConfig: Record<string, unknown> = {}) {
  const dir = makeTempDir(label);
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
    adapterConfig,
  });
  return { proc, client: await proc.newClient() };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

test('invalid identities and bodies are rejected before any state is written', async () => {
  const { proc, client } = await boot('validate-input');
  try {
    assert.equal(await codeOf(client.invoke({ tenant: '', method: METHOD, idempotencyKey: 'k', body: BODY })), 'INVALID_INPUT');
    assert.equal(await codeOf(client.invoke({ tenant: TENANT, method: '', idempotencyKey: 'k', body: BODY })), 'INVALID_INPUT');
    assert.equal(await codeOf(client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: '', body: BODY })), 'INVALID_INPUT');
    assert.equal(countEffects(proc.effectFile), 0);

    const absent = await client.inspect({ tenant: TENANT, method: METHOD, idempotencyKey: 'k' });
    assert.ok('absent' in absent);
  } finally {
    await proc.stop();
  }
});

test('malformed JSON on the wire is answered, not fatal', async () => {
  const { proc, client } = await boot('validate-malformed');
  try {
    const { connect } = await import('node:net');
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(proc.endpoint.port!, '127.0.0.1');
      socket.setEncoding('utf8');
      let out = '';
      socket.on('connect', () => socket.write('{not json\n'));
      socket.on('data', (d: string) => {
        out += d;
        socket.end();
      });
      socket.on('close', () => resolve(out));
      socket.on('error', reject);
    });
    const parsed = JSON.parse(raw.trim()) as { ok: boolean; error: { code: string } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'INVALID_INPUT');

    // The manager is still healthy afterwards.
    const ping = await client.ping();
    assert.equal(ping.pong, true);
  } finally {
    await proc.stop();
  }
});

test('unknown ops are rejected with a machine-readable code', async () => {
  const { proc } = await boot('validate-unknown-op');
  try {
    const client = new DirectClient({ endpoint: proc.endpoint });
    try {
      const err = await client
        // @ts-expect-error deliberately bypass the typed client
        .request('notARealOp', {})
        .then(() => null)
        .catch((e: { code?: string; message?: string }) => e);
      assert.equal(err?.code, 'INVALID_INPUT');
      assert.match(String(err?.message), /unknown op/);
    } finally {
      client.close();
    }
  } finally {
    await proc.stop();
  }
});

test('invoke rejects a body that is not bytes or a string', async () => {
  const { proc, client } = await boot('validate-body-type');
  try {
    const { connect } = await import('node:net');
    const reply = await new Promise<{ ok: boolean; error: { code: string } }>((resolve, reject) => {
      const socket = connect(proc.endpoint.port!, '127.0.0.1');
      socket.setEncoding('utf8');
      let out = '';
      socket.on('connect', () =>
        socket.write(
          `${JSON.stringify({ id: 'x1', op: 'invoke', tenant: TENANT, method: METHOD, idempotencyKey: 'k' })}\n`,
        ),
      );
      socket.on('data', (d: string) => {
        out += d;
        socket.end();
      });
      socket.on('close', () => {
        try {
          resolve(JSON.parse(out.trim()) as { ok: boolean; error: { code: string } });
        } catch (e) {
          reject(e as Error);
        }
      });
      socket.on('error', reject);
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'INVALID_INPUT');
    assert.equal(countEffects(proc.effectFile), 0);
  } finally {
    await proc.stop();
  }
});

test('reconcile validates proof shapes', async () => {
  const { proc, client } = await boot('validate-proof');
  try {
    const badProofs: Array<Record<string, unknown>> = [
      {},
      { kind: 'nonsense', proofId: 'p1' },
      { kind: 'completed', proofId: 'p1' },
      { kind: 'completed', proofId: '', outcome: { type: 'success', value: 1 } },
      { kind: 'completed', proofId: 'p1', outcome: { type: 'weird' } },
      { kind: 'completed', proofId: 'p1', outcome: { type: 'business_error', error: { code: '', message: 'x' } } },
    ];
    for (const proof of badProofs) {
      const code = await codeOf(
        client.reconcile({ ticketId: 'tkt_anything', proof: proof as never }),
      );
      assert.ok(code === 'INVALID_INPUT' || code === 'TICKET_NOT_FOUND', `proof ${JSON.stringify(proof)} -> ${code}`);
    }
  } finally {
    await proc.stop();
  }
});

test('two runtimes in one process cannot both own the state directory', async () => {
  const { proc, client } = await boot('validate-single-owner');
  try {
    // Starting a second manager on the same state dir must fail loudly.
    await assert.rejects(
      startServer({
        stateDir: proc.stateDir,
        workDir: join(makeTempDir('validate-single-owner-2'), 'work'),
        effectFile: proc.effectFile,
      }),
      (err: Error) => {
        assert.match(err.message, /STORE_LOCKED|already owned|exited early/);
        return true;
      },
    );
    // The original manager is unaffected.
    const result = await client.invoke({
      tenant: TENANT,
      method: METHOD,
      idempotencyKey: 'owner-key',
      body: BODY,
    });
    assert.equal(result.outcome.type, 'success');
  } finally {
    await proc.stop();
  }
});

test('the same client can pipeline two invokes on one connection', async () => {
  const { proc } = await boot('validate-pipeline', { holdAfterEffectMs: 200 });
  try {
    const client: GatewayClient = await proc.newClient();
    const [a, b] = await Promise.all([
      client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'pipe-1', body: BODY }),
      client.invoke({ tenant: TENANT, method: METHOD, idempotencyKey: 'pipe-1', body: BODY }),
    ]);
    assert.equal(a.ticketId, b.ticketId);
    assert.equal(countEffects(proc.effectFile), 1);
  } finally {
    await proc.stop();
  }
});
