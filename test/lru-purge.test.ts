/**
 * LRU 容量核算与 purge 交错：
 * - 容量按实际保留的正文区间字节核算，区间重叠不重复计数；
 * - 超限按 LRU 回收；
 * - purge 后在途回源仍可完成已有调用，但迟到结果不能填回；
 * - 迟到 304 只能更新它确实验证过的表示。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GatewayCache } from '../src/cache.ts';
import { ControlledOrigin, Gate, ManualClock } from './helpers/origin.ts';

function resource(uri: string, etag: string, size: number, cc = 'max-age=1000') {
  return {
    body: Buffer.from(Array.from({ length: size }, (_, i) => 65 + (i % 26))),
    etag,
    lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
    cacheControl: cc,
  };
}

describe('LRU 容量', () => {
  it('超过容量时回收最久未使用的 URI 表示', async () => {
    const clock = new ManualClock();
    const origin = new ControlledOrigin(clock);
    const cache = new GatewayCache({ maxBytes: 25, origin: origin.fetch, clock });
    origin.setResource('http://o/a', resource('http://o/a', '"a"', 10));
    origin.setResource('http://o/b', resource('http://o/b', '"b"', 10));
    origin.setResource('http://o/c', resource('http://o/c', '"c"', 10));

    await cache.get({ method: 'GET', uri: 'http://o/a', headers: {} });
    await cache.get({ method: 'GET', uri: 'http://o/b', headers: {} });
    assert.equal(cache.stats().bytes, 20);

    // 访问 a，使 b 成为 LRU 末尾
    await cache.get({ method: 'GET', uri: 'http://o/a', headers: {} });

    await cache.get({ method: 'GET', uri: 'http://o/c', headers: {} });
    assert.equal(cache.stats().bytes, 20);
    const uris = cache.stats().uris.map((u) => u.uri);
    assert.deepEqual(uris.sort(), ['http://o/a', 'http://o/c']);

    // b 已被回收，再次访问需要回源
    const before = origin.callCount('http://o/b');
    await cache.get({ method: 'GET', uri: 'http://o/b', headers: {} });
    assert.equal(origin.callCount('http://o/b'), before + 1);
  });

  it('片段表示同样按区间字节参与 LRU，重叠不重复计数', async () => {
    const clock = new ManualClock();
    const origin = new ControlledOrigin(clock);
    const cache = new GatewayCache({ maxBytes: 15, origin: origin.fetch, clock });
    origin.setResource('http://o/r', resource('http://o/r', '"r"', 100));

    await cache.get({ method: 'GET', uri: 'http://o/r', headers: { range: 'bytes=0-9' } });
    assert.equal(cache.stats().bytes, 10);
    // 重叠请求不增加占用
    await cache.get({ method: 'GET', uri: 'http://o/r', headers: { range: 'bytes=5-9' } });
    assert.equal(cache.stats().bytes, 10);
    // 相邻扩展到 15
    await cache.get({ method: 'GET', uri: 'http://o/r', headers: { range: 'bytes=10-14' } });
    assert.equal(cache.stats().bytes, 15);

    origin.setResource('http://o/z', resource('http://o/z', '"z"', 10));
    await cache.get({ method: 'GET', uri: 'http://o/z', headers: {} });
    // 容量 15：需要回收片段表示才能放入 10 字节新条目
    assert.equal(cache.stats().bytes, 10);
    assert.deepEqual(cache.stats().uris.map((u) => u.uri), ['http://o/z']);
  });
});

describe('purge 与在途回源交错', () => {
  it('purge 后在途回源仍完成已有调用，但迟到 200 不能重新填回缓存', async () => {
    const clock = new ManualClock();
    const origin = new ControlledOrigin(clock);
    const cache = new GatewayCache({ maxBytes: 1_000_000, origin: origin.fetch, clock });
    const uri = 'http://o/purge';
    origin.setResource(uri, resource(uri, '"v1"', 20));
    origin.gate = new Gate();

    const p1 = cache.get({ method: 'GET', uri, headers: {} });
    await Gate.tick();
    assert.equal(origin.gate.pending, 1);

    assert.equal(cache.purge(uri), true);
    assert.equal(cache.stats().entries, 0);

    await origin.flushPending();
    const r1 = await p1;
    assert.equal(r1.status, 200); // 已有调用照常拿到响应
    assert.equal(r1.body.length, 20);

    // 迟到结果没有填回
    assert.equal(cache.stats().entries, 0);
    origin.gate = null;
    const again = await cache.get({ method: 'GET', uri, headers: {} });
    assert.equal(again.status, 200);
    assert.equal(origin.callCount(uri), 2); // 必须重新回源
  });

  it('purge 后在途的范围补齐完成时，迟到 206 片段也不能填回', async () => {
    const clock = new ManualClock();
    const origin = new ControlledOrigin(clock);
    const cache = new GatewayCache({ maxBytes: 1_000_000, origin: origin.fetch, clock });
    const uri = 'http://o/purge-range';
    origin.setResource(uri, resource(uri, '"v1"', 100));

    await cache.get({ method: 'GET', uri, headers: { range: 'bytes=0-9' } });
    assert.equal(cache.stats().bytes, 10);

    origin.gate = new Gate();
    const p1 = cache.get({ method: 'GET', uri, headers: { range: 'bytes=10-19' } });
    await Gate.tick();
    assert.equal(origin.gate.pending, 1);

    cache.purge(uri);
    assert.equal(cache.stats().entries, 0);

    await origin.flushPending();
    const r1 = await p1;
    assert.equal(r1.status, 206); // 调用仍拿到自己的范围
    assert.equal(r1.body.length, 10);
    assert.equal(cache.stats().entries, 0); // 片段未填回
  });

  it('迟到的 304 只能更新它确实验证过的表示；表示已消失时不复活任何条目', async () => {
    const clock = new ManualClock();
    const origin = new ControlledOrigin(clock);
    const cache = new GatewayCache({ maxBytes: 1_000_000, origin: origin.fetch, clock });
    const uri = 'http://o/reval';
    origin.setResource(uri, resource(uri, '"v1"', 20, 'max-age=10'));

    await cache.get({ method: 'GET', uri, headers: {} });
    clock.tick(11_000); // 过期

    origin.gate = new Gate();
    const p1 = cache.get({ method: 'GET', uri, headers: {} }); // 触发条件重验证
    await Gate.tick();
    assert.equal(origin.gate.pending, 1);
    assert.equal(origin.calls.at(-1)?.headers['if-none-match'], '"v1"');

    cache.purge(uri);
    assert.equal(cache.stats().entries, 0);

    await origin.flushPending();
    const r1 = await p1;
    assert.equal(r1.status, 304); // 源站 304 透传给等待者
    assert.equal(r1.body.length, 0);
    assert.equal(cache.stats().entries, 0); // 304 没有复活已清除的表示
  });

  it('迟到 304 不能更新期间已被新 ETag 表示取代的旧表示元数据', async () => {
    const clock = new ManualClock();
    const origin = new ControlledOrigin(clock);
    const cache = new GatewayCache({ maxBytes: 1_000_000, origin: origin.fetch, clock });
    const uri = 'http://o/switch';
    origin.setResource(
      uri,
      resource(uri, '"v1"', 20, 'max-age=10'),
      resource(uri, '"v2"', 20, 'max-age=10'),
    );

    await cache.get({ method: 'GET', uri, headers: {} });
    clock.tick(11_000);

    // 第一次重验证挂起（针对 v1）
    origin.gate = new Gate();
    const p1 = cache.get({ method: 'GET', uri, headers: {} });
    await Gate.tick();
    assert.equal(origin.gate.pending, 1);

    // 挂起期间源站切版本并清除缓存；放行 Gate 后旧调用以当前版本完成，
    // 但写回检查会拒绝把迟到结果填回已清除的条目
    origin.switchVersion(uri, 1);
    cache.purge(uri);
    origin.gate.release();
    await origin.flushPending();
    await p1; // 旧重验证调用仍能拿到响应（当前版本下为 200），但不会写回缓存

    // 重新拉取得到 v2
    const r2 = await cache.get({ method: 'GET', uri, headers: {} });
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.etag, '"v2"');

    const stats = cache.stats();
    const reps = stats.uris[0].representations;
    assert.equal(reps.length, 1);
    assert.equal(reps[0].etag, '"v2"');
  });
});
