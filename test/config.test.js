import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeConfig, normalizeSupplier } from '../src/config.js';
import { nextDailyAt, nextDailyTomorrow, todayKey, isoDateKey } from '../src/util.js';

test('normalizeSupplier trims values and rejects bad input', () => {
  const supplier = normalizeSupplier({
    id: 'src-a',
    name: '  鲜丰  ',
    url: 'http://127.0.0.1:4110/catalog/fresh-mart',
    collectionTime: '06:15',
    requestsPerMinute: '30',
    pageSize: '20',
  });
  assert.equal(supplier.name, '鲜丰');
  assert.equal(supplier.collectionTime, '06:15');
  assert.equal(supplier.requestsPerMinute, 30);
  assert.equal(supplier.pageSize, 20);
  assert.equal(supplier.enabled, true);

  assert.throws(() => normalizeSupplier({ name: '', url: 'http://x' }), /名称/);
  assert.throws(() => normalizeSupplier({ name: 'x', url: 'ftp://x' }), /http/);
  assert.throws(() => normalizeSupplier({ name: 'x', url: 'http://x', collectionTime: '25:00' }), /采集时间/);
  assert.throws(() => normalizeSupplier({ name: 'x', url: 'http://x', id: 'Bad ID' }), /标识/);
});

test('normalizeSupplier clamps rate limits instead of loosing data', () => {
  const supplier = normalizeSupplier({ name: 'x', url: 'http://x', requestsPerMinute: 0, pageSize: 9999 });
  assert.equal(supplier.requestsPerMinute, 1);
  assert.equal(supplier.pageSize, 200);
});

test('normalizeConfig rejects duplicate ids', () => {
  assert.throws(
    () => normalizeConfig({
      suppliers: [
        { id: 'a', name: 'a', url: 'http://a' },
        { id: 'a', name: 'b', url: 'http://b' },
      ],
    }),
    /重复/,
  );
});

test('nextDailyAt moves to tomorrow when the time has passed', () => {
  const from = new Date(2026, 10, 13, 7, 30, 0).getTime();
  assert.equal(nextDailyAt('07:30', from), new Date(2026, 10, 14, 7, 30, 0).getTime());
  assert.equal(nextDailyAt('07:31', from), new Date(2026, 10, 13, 7, 31, 0).getTime());
});

test('nextDailyTomorrow always lands on the next day', () => {
  const early = new Date(2026, 10, 13, 5, 10, 0).getTime();
  assert.equal(nextDailyTomorrow('07:30', early), new Date(2026, 10, 14, 7, 30, 0).getTime());
  const late = new Date(2026, 10, 13, 23, 50, 0).getTime();
  assert.equal(nextDailyTomorrow('07:30', late), new Date(2026, 10, 14, 7, 30, 0).getTime());
});

test('date keys use local time', () => {
  const ms = new Date(2026, 10, 13, 23, 50, 0).getTime();
  assert.equal(todayKey(ms), '2026-11-13');
  assert.equal(isoDateKey(new Date(ms).toISOString()), '2026-11-13');
  assert.equal(isoDateKey('not-a-date'), null);
});
