/**
 * 并发：可合法复用时共享回源；等待者独立取消；
 * 最后一个等待者离开后中止仍未完成的回源。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GatewayCache } from '../src/cache.ts';
import { ControlledOrigin, Gate, ManualClock } from './helpers/origin.ts';

const URI = 'http://origin.test/conc';

function body(size: number): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, i) => 65 + (i % 26)));
}

function harness() {
  const clock = new ManualClock();
  const origin = new ControlledOrigin(clock);
  const cache = new GatewayCache({ maxBytes: 1_000_000, origin: origin.fetch, clock });
  origin.setResource(URI, {
    body: body(100),
    etag: '"v1"',
    lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
    cacheControl: 'max-age=1000',
  });
  return { clock, origin, cache };
}

describe('回源共享', () => {
  it('并发的相同 miss 只产生一次回源，所有等待者拿到相同字节', async () => {
    const { origin, cache } = harness();
    origin.gate = new Gate();

    const p1 = cache.get({ method: 'GET', uri: URI, headers: {} });
    const p2 = cache.get({ method: 'GET', uri: URI, headers: {} });
    await Gate.tick();
    assert.equal(origin.gate.pending, 1);

    await origin.flushPending();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body, r2.body);
    assert.equal(origin.callCount(URI), 1);
  });

  it('no-store 响应不缓存：后续请求重新回源，但在途的相同请求仍共享本次连接', async () => {
    const { origin, cache } = harness();
    origin.setResource(URI, {
      body: body(10),
      etag: '"ns"',
      lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
      cacheControl: 'no-store',
    });
    origin.gate = new Gate();

    const p1 = cache.get({ method: 'GET', uri: URI, headers: {} });
    const p2 = cache.get({ method: 'GET', uri: URI, headers: {} });
    await Gate.tick();
    assert.equal(origin.gate.pending, 1);

    await origin.flushPending();
    await Promise.all([p1, p2]);
    assert.equal(origin.callCount(URI), 1);
    assert.equal(cache.stats().bytes, 0);

    origin.gate = null; // 后续请求直通，验证确实重新回源
    await cache.get({ method: 'GET', uri: URI, headers: {} });
    assert.equal(origin.callCount(URI), 2);
  });

  it('不同范围请求不共享回源键', async () => {
    const { origin, cache } = harness();
    origin.gate = new Gate();

    const p1 = cache.get({ method: 'GET', uri: URI, headers: { range: 'bytes=0-9' } });
    const p2 = cache.get({ method: 'GET', uri: URI, headers: { range: 'bytes=20-29' } });
    await Gate.tick();
    assert.equal(origin.gate.pending, 2);

    await origin.flushPending();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 206);
    assert.equal(r2.status, 206);
    assert.equal(origin.callCount(URI), 2);
  });
});

describe('等待者取消', () => {
  it('单个等待者取消不影响其他等待者，回源继续完成', async () => {
    const { origin, cache } = harness();
    origin.gate = new Gate();

    const ac1 = new AbortController();
    const p1 = cache.get({ method: 'GET', uri: URI, headers: {}, signal: ac1.signal });
    const p2 = cache.get({ method: 'GET', uri: URI, headers: {} });
    await Gate.tick();
    assert.equal(origin.gate.pending, 1);

    ac1.abort();
    await assert.rejects(p1, (err: unknown) => err instanceof Error && err.name === 'AbortError');

    await origin.flushPending();
    const r2 = await p2;
    assert.equal(r2.status, 200);
    assert.equal(origin.callCount(URI), 1);
    // 取消者的响应不写回（响应到达时仍有存活等待者，正常写回；此处验证 p2 命中即可）
    origin.gate = null;
    const r3 = await cache.get({ method: 'GET', uri: URI, headers: {} });
    assert.equal(origin.callCount(URI), 1);
    assert.deepEqual(r3.body, body(100));
  });

  it('最后一个等待者离开后，仍未完成的回源被中止', async () => {
    const { origin, cache } = harness();
    origin.gate = new Gate();

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = cache.get({ method: 'GET', uri: URI, headers: {}, signal: ac1.signal });
    const p2 = cache.get({ method: 'GET', uri: URI, headers: {}, signal: ac2.signal });
    await Gate.tick();
    assert.equal(origin.gate.pending, 1);

    ac1.abort();
    await assert.rejects(p1);
    // 仍有等待者，回源未中止
    assert.equal(origin.gate.pending, 1);

    ac2.abort();
    await assert.rejects(p2);
    // 控制器中止后，源站 fetch 以 AbortError 结束
    await new Promise((resolve) => setImmediate(resolve));
    const abortedCall = origin.calls.find((c) => c.aborted);
    assert.ok(abortedCall, '源站应观察到 abort');
    assert.equal(cache.stats().entries, 0);
  });
});
