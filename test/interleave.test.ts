/**
 * 端到端交错：在同一个可控源站上依次复现
 * 1) 片段重叠补齐；2) ETag 切换重新确定表示；
 * 3) Vary 变化产生独立变体；4) purge 时旧回源尚未结束。
 * 判断依据只使用三类可观察量：返回字节、回源范围/次数、缓存占用。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GatewayCache } from '../src/cache.ts';
import { ControlledOrigin, Gate, ManualClock } from './helpers/origin.ts';

function pattern(size: number, base: number): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, i) => base + (i % 26)));
}

describe('端到端交错场景', () => {
  it('重叠片段 → ETag 切换 → Vary 变化 → purge 与迟到回源，全程语义一致', async () => {
    const clock = new ManualClock();
    const origin = new ControlledOrigin(clock);
    const cache = new GatewayCache({ maxBytes: 1_000_000, origin: origin.fetch, clock });
    const uri = 'http://origin.test/resource';

    const v1 = {
      body: pattern(100, 65),
      etag: '"v1"',
      lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
      cacheControl: 'max-age=1000',
    };
    const v2 = {
      body: pattern(100, 97),
      etag: '"v2"',
      lastModified: 'Thu, 22 Oct 2025 07:28:00 GMT',
      cacheControl: 'max-age=1000',
    };
    const v2Gzip = {
      body: pattern(80, 40),
      etag: '"v2-gzip"',
      lastModified: 'Thu, 22 Oct 2025 07:28:00 GMT',
      cacheControl: 'max-age=1000',
      vary: 'Accept-Encoding',
    };
    origin.setResource(uri, v1, v2, v2Gzip);

    // ---- 阶段 1：重叠片段，缓存只保留区间并集字节 ----
    const a = await cache.get({ method: 'GET', uri, headers: { range: 'bytes=0-19' } });
    assert.equal(a.status, 206);
    assert.deepEqual(a.body, v1.body.subarray(0, 20));
    const b = await cache.get({ method: 'GET', uri, headers: { range: 'bytes=10-29' } });
    // 10-19 已覆盖：回源只取缺口 20-29
    assert.equal(origin.rangesOf(uri).at(-1), 'bytes=20-29');
    assert.deepEqual(b.body, v1.body.subarray(10, 30));
    assert.equal(cache.stats().bytes, 30); // 重叠 10 字节不重复计数
    const covered = await cache.get({ method: 'GET', uri, headers: { range: 'bytes=5-25' } });
    assert.equal(origin.callCount(uri), 2); // 完全命中，无回源
    assert.deepEqual(covered.body, v1.body.subarray(5, 26));

    // ---- 阶段 2：源站切换 ETag，强制重验证后得到新表示，旧片段保留但不混用 ----
    origin.switchVersion(uri, 1);
    const switched = await cache.get({
      method: 'GET',
      uri,
      headers: { range: 'bytes=0-9', 'cache-control': 'no-cache' },
    });
    assert.equal(switched.headers.etag, '"v2"');
    assert.deepEqual(switched.body, v2.body.subarray(0, 10));
    // 重验证请求携带旧强校验器
    assert.equal(origin.calls.at(-1)?.headers['if-none-match'], '"v1"');
    const statsAfterSwitch = cache.stats();
    assert.equal(statsAfterSwitch.uris[0].representations.length, 2);
    assert.equal(statsAfterSwitch.bytes, 30 + 100); // v1 片段 + v2 完整表示

    // ---- 阶段 3：源站改为按 Accept-Encoding 区分（Vary 变化），新变体独立存储 ----
    origin.switchVersion(uri, 2);
    const gz = await cache.get({
      method: 'GET',
      uri,
      headers: { 'accept-encoding': 'gzip', 'cache-control': 'no-cache' },
    });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.deepEqual(gz.body, v2Gzip.body);
    const gzHit = await cache.get({ method: 'GET', uri, headers: { 'accept-encoding': 'gzip' } });
    assert.deepEqual(gzHit.body, v2Gzip.body);
    const callsBefore = origin.callCount(uri);

    // 无 Accept-Encoding 的请求匹配到旧的 v2 表示（其 Vary 集合为空，
    // 不区分该头部），因此直接命中，不回源
    const plain = await cache.get({ method: 'GET', uri, headers: {} });
    assert.equal(plain.headers.etag, '"v2"');
    assert.equal(origin.callCount(uri), callsBefore);
    // gzip 变体独立命中，两个不同 Vary 集合的表示并存
    await cache.get({ method: 'GET', uri, headers: { 'accept-encoding': 'gzip' } });
    assert.equal(origin.callCount(uri), callsBefore);
    assert.ok(cache.stats().uris[0].representations.length >= 3);

    // ---- 阶段 4：purge 后旧回源仍在途；其迟到结果不得填回，已有调用照常完成 ----
    // 使用独立 URI 保证是确定的 miss（同一可控源站）
    const purgeUri = 'http://origin.test/purge-late';
    origin.setResource(purgeUri, {
      body: pattern(40, 70),
      etag: '"p1"',
      lastModified: 'Fri, 23 Oct 2025 07:28:00 GMT',
      cacheControl: 'max-age=1000',
    });
    origin.gate = new Gate();
    const callsAtPurge = origin.callCount(purgeUri);
    const pending = cache.get({ method: 'GET', uri: purgeUri, headers: {} });
    await Gate.tick();
    assert.equal(origin.gate.pending, 1);

    cache.purge(purgeUri);
    assert.equal(cache.stats().entries, 1); // 主 URI 仍在，purgeUri 条目已清空
    assert.equal(cache.stats().uris.some((u) => u.uri === purgeUri), false);

    await origin.flushPending();
    const late = await pending;
    assert.equal(late.status, 200); // 已发起的调用拿到完整响应
    assert.equal(cache.stats().uris.some((u) => u.uri === purgeUri), false); // 迟到结果未填回

    origin.gate = null;
    await cache.get({ method: 'GET', uri: purgeUri, headers: {} });
    // purge 前后各一次回源，迟到结果没有被复用
    assert.equal(origin.callCount(purgeUri), callsAtPurge + 2);
  });
});
