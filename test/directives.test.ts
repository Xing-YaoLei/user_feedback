/**
 * 缓存指令与共享缓存规则：
 * max-age / s-maxage / no-cache / no-store / private / must-revalidate，
 * Authorization 复用条件，请求端 max-age / max-stale / min-fresh。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GatewayCache } from '../src/cache.ts';
import { ControlledOrigin, Gate, ManualClock, type MockResource } from './helpers/origin.ts';

const URI = 'http://origin.test/policy';

function resource(etag: string, cacheControl: string, extra: Partial<MockResource> = {}): MockResource {
  return {
    body: Buffer.from('0123456789'),
    etag,
    lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
    cacheControl,
    ...extra,
  };
}

function harness() {
  const clock = new ManualClock();
  const origin = new ControlledOrigin(clock);
  const cache = new GatewayCache({ maxBytes: 1_000_000, origin: origin.fetch, clock });
  return { clock, origin, cache };
}

describe('新鲜度指令', () => {
  it('s-maxage 优先于 max-age 作用于共享缓存', async () => {
    const { clock, origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'max-age=1000, s-maxage=10'));

    await cache.get({ method: 'GET', uri: URI, headers: {} });
    clock.tick(11_000);
    await cache.get({ method: 'GET', uri: URI, headers: {} });

    assert.equal(origin.callCount(URI), 2); // s-maxage=10 已过期
    assert.equal(origin.calls[1].headers['if-none-match'], '"v1"');
  });

  it('no-cache：每次使用都强制重验证，304 后仍可返回正文', async () => {
    const { origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'no-cache'));

    const r1 = await cache.get({ method: 'GET', uri: URI, headers: {} });
    assert.equal(r1.status, 200);
    const r2 = await cache.get({ method: 'GET', uri: URI, headers: {} });
    assert.equal(r2.status, 200);
    assert.equal(origin.callCount(URI), 2);
    assert.equal(origin.calls[1].headers['if-none-match'], '"v1"');
    // no-cache 仍然存储（只是必须重验证）
    assert.equal(cache.stats().bytes, 10);
  });

  it('no-store：不进入缓存，每次都回源，占用为 0', async () => {
    const { origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'no-store'));

    await cache.get({ method: 'GET', uri: URI, headers: {} });
    await cache.get({ method: 'GET', uri: URI, headers: {} });
    assert.equal(origin.callCount(URI), 2);
    assert.equal(cache.stats().bytes, 0);
    assert.equal(cache.stats().entries, 0);
  });

  it('private：不进入共享缓存', async () => {
    const { origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'private, max-age=1000'));

    await cache.get({ method: 'GET', uri: URI, headers: {} });
    assert.equal(cache.stats().bytes, 0);
    await cache.get({ method: 'GET', uri: URI, headers: {} });
    assert.equal(origin.callCount(URI), 2);
  });

  it('must-revalidate：过期后禁止陈旧，源站失败时抛错而非放行旧内容', async () => {
    const { clock, origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'max-age=10, must-revalidate'));

    await cache.get({ method: 'GET', uri: URI, headers: {} });
    clock.tick(11_000);

    const gate = new Gate();
    origin.gate = gate;
    const pending = cache.get({ method: 'GET', uri: URI, headers: {} });
    await Gate.tick();
    gate.failAll(new Error('origin down'));

    await assert.rejects(pending, /origin down/);
  });

  it('无 must-revalidate 时源站失败可回退陈旧内容并带 Warning', async () => {
    const { clock, origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'max-age=10'));

    await cache.get({ method: 'GET', uri: URI, headers: {} });
    clock.tick(11_000);

    const gate = new Gate();
    origin.gate = gate;
    const pending = cache.get({ method: 'GET', uri: URI, headers: {} });
    await Gate.tick();
    gate.failAll(new Error('origin down'));

    const stale = await pending;
    assert.equal(stale.status, 200);
    assert.match(stale.headers.warning, /110/);
    assert.deepEqual(stale.body, Buffer.from('0123456789'));
  });
});

describe('请求端缓存控制', () => {
  it('请求 no-cache 强制回源重验证', async () => {
    const { origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'max-age=1000'));
    await cache.get({ method: 'GET', uri: URI, headers: {} });

    await cache.get({ method: 'GET', uri: URI, headers: { 'cache-control': 'no-cache' } });
    assert.equal(origin.callCount(URI), 2);
  });

  it('max-stale 允许在容忍窗口内使用陈旧表示', async () => {
    const { clock, origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'max-age=10'));
    await cache.get({ method: 'GET', uri: URI, headers: {} });
    clock.tick(15_000);

    const r = await cache.get({ method: 'GET', uri: URI, headers: { 'cache-control': 'max-stale=10' } });
    assert.equal(r.status, 200);
    assert.equal(origin.callCount(URI), 1);

    clock.tick(10_000); // 陈旧 25 秒，超出窗口
    await cache.get({ method: 'GET', uri: URI, headers: { 'cache-control': 'max-stale=10' } });
    assert.equal(origin.callCount(URI), 2);
  });

  it('min-fresh 提前判定为需要重验证', async () => {
    const { clock, origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'max-age=100'));
    await cache.get({ method: 'GET', uri: URI, headers: {} });
    clock.tick(95_000);

    await cache.get({ method: 'GET', uri: URI, headers: { 'cache-control': 'min-fresh=10' } });
    assert.equal(origin.callCount(URI), 2);
  });
});

describe('Authorization 与共享缓存', () => {
  it('默认不缓存带 Authorization 的响应', async () => {
    const { origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'max-age=1000'));

    await cache.get({ method: 'GET', uri: URI, headers: { authorization: 'Bearer token' } });
    assert.equal(cache.stats().bytes, 0);
    await cache.get({ method: 'GET', uri: URI, headers: { authorization: 'Bearer token' } });
    assert.equal(origin.callCount(URI), 2);
  });

  it('s-maxage / must-revalidate / public 显式授权后可在共享缓存复用', async () => {
    const { origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 's-maxage=100'));

    const r1 = await cache.get({
      method: 'GET',
      uri: URI,
      headers: { authorization: 'Bearer token' },
    });
    assert.equal(r1.status, 200);
    assert.equal(cache.stats().bytes, 10);

    const r2 = await cache.get({
      method: 'GET',
      uri: URI,
      headers: { authorization: 'Bearer token' },
    });
    assert.equal(r2.status, 200);
    assert.equal(origin.callCount(URI), 1);
  });

  it('仅 max-age 不构成授权，仍不缓存', async () => {
    const { origin, cache } = harness();
    origin.setResource(URI, resource('"v1"', 'max-age=100, public'));

    await cache.get({ method: 'GET', uri: URI, headers: { authorization: 'Bearer x' } });
    assert.equal(cache.stats().bytes, 10); // public 授权

    origin.setResource(URI + '2', resource('"v1"', 'max-age=100'));
    await cache.get({ method: 'GET', uri: URI + '2', headers: { authorization: 'Bearer x' } });
    assert.equal(cache.stats().entries, 1);
  });
});
