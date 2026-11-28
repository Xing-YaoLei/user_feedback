import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cleanupTmpRoot, countEffects, makeTempDir, startServer } from '../testlib/harness.ts';

test('unix socket transport works end to end', async () => {
  const dir = makeTempDir('unix-transport');
  const proc = await startServer({
    stateDir: join(dir, 'state'),
    workDir: join(dir, 'work'),
    effectFile: join(dir, 'effects.jsonl'),
    transport: 'unix',
  });
  try {
    assert.equal(proc.endpoint.transport, 'unix');
    const client = await proc.newClient();
    const result = await client.invoke({
      tenant: 'unix-tenant',
      method: 'unix.method',
      idempotencyKey: 'unix-key',
      body: '{"u":1}',
    });
    assert.equal(result.outcome.type, 'success');
    assert.equal(countEffects(proc.effectFile), 1);
  } finally {
    await proc.stop();
    cleanupTmpRoot();
  }
});
