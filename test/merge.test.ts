import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABSENT,
  mergeConfigs,
  type ConfigNode,
  type Directive,
  type MergeResult,
} from '../src/index.ts';

const arr = (...els: [string, ConfigNode][]): ConfigNode => ({
  $array: els.map(([id, value]) => ({ id, value })),
});
const ref = (id: string): ConfigNode => ({ $ref: id });
const ids = (node: ConfigNode): string[] => (node as { $array: { id: string }[] }).$array.map((e) => e.id);

test('互不覆盖的修改自动合并；同值修改合并；不同值冲突且可追溯三侧原值', () => {
  const base = { server: { host: 'a', port: 80 }, flags: { x: true } };
  const left = { server: { host: 'a', port: 8080 }, flags: { x: true } };
  const right = { server: { host: 'b', port: 80 }, flags: { x: true, y: 'new' } };

  const r = mergeConfigs(base, left, right);
  assert.equal(r.publishable, true);
  assert.deepEqual(r.snapshot, {
    server: { host: 'b', port: 8080 },
    flags: { x: true, y: 'new' },
  });

  // 同一位置改成相同值 -> 合并
  const r2 = mergeConfigs(base, left, { server: { host: 'a', port: 8080 }, flags: { x: true } });
  assert.equal(r2.publishable, true);
  assert.deepEqual((r2.snapshot as { server: { port: number } }).server.port, 8080);

  // 同一位置改成不同值 -> 冲突，携带基线与两侧原值
  const r3 = mergeConfigs(base, left, { server: { host: 'a', port: 9090 }, flags: { x: true } });
  assert.equal(r3.publishable, false);
  assert.equal(r3.candidate, undefined);
  assert.equal(r3.valueConflicts.length, 1);
  const c = r3.valueConflicts[0];
  assert.equal(c.path, '/server/port');
  assert.equal(c.reason, 'both-modified');
  assert.equal(c.base, 80);
  assert.equal(c.left, 8080);
  assert.equal(c.right, 9090);
});

test('删除 vs 对侧内容或位置修改 -> 冲突；删除 vs 未改动 -> 删除生效', () => {
  const base = { sec: { a: 1, list: arr(['e1', 1], ['e2', 2]) } };

  // 对侧修改了被删节点后代的内容
  let r = mergeConfigs(base, {}, { sec: { a: 2, list: arr(['e1', 1], ['e2', 2]) } });
  assert.equal(r.valueConflicts.length, 1);
  assert.equal(r.valueConflicts[0].path, '/sec');
  assert.equal(r.valueConflicts[0].reason, 'delete-modified');
  assert.equal(r.valueConflicts[0].left, ABSENT);

  // 对侧仅重排了被删节点后代的数组（位置修改）
  r = mergeConfigs(base, {}, { sec: { a: 1, list: arr(['e2', 2], ['e1', 1]) } });
  assert.equal(r.valueConflicts.length, 1);
  assert.equal(r.valueConflicts[0].reason, 'delete-modified');

  // 对侧未改动 -> 删除生效
  r = mergeConfigs(base, {}, structuredClone(base));
  assert.equal(r.publishable, true);
  assert.deepEqual(r.snapshot, {});

  // 两侧都删除
  r = mergeConfigs(base, {}, {});
  assert.equal(r.publishable, true);
  assert.deepEqual(r.snapshot, {});
});

test('数组按元素 ID 合并内容与增删，单侧重排被采纳', () => {
  const base = { list: arr(['a', { v: 1 }], ['b', { v: 2 }], ['c', { v: 3 }]) };
  const left = { list: arr(['a', { v: 10 }], ['c', { v: 3 }]) }; // 改 a、删 b
  const right = { list: arr(['c', { v: 3 }], ['b', { v: 2 }], ['a', { v: 1 }], ['d', { v: 4 }]) }; // 重排 + 新增 d

  const r = mergeConfigs(base, left, right);
  assert.equal(r.publishable, true);
  const list = (r.snapshot as { list: { $array: { id: string; value: { v: number } }[] } }).list;
  assert.deepEqual(ids(list as ConfigNode), ['c', 'a', 'd']);
  assert.equal(list.$array[1].value.v, 10);
});

test('演示1：两侧各自合法的重排合并后成环，取舍后按元素 ID 确定顺序', () => {
  const mk = (order: string[]): ConfigNode => ({
    list: arr(...order.map((id) => [id, { id }] as [string, ConfigNode])),
  });
  const base = mk(['a', 'b', 'c']);
  const left = mk(['b', 'a', 'c']); // 合法：交换 a/b
  const right = mk(['a', 'c', 'b']); // 合法：交换 b/c

  const r = mergeConfigs(base, left, right);
  assert.equal(r.publishable, false);
  assert.equal(r.valueConflicts.length, 0);
  assert.equal(r.orderConflicts.length, 1);
  const oc = r.orderConflicts[0];
  assert.equal(oc.arrayPath, '/list');
  assert.equal(oc.cycles.length, 1);
  // 具体环：a < c（基线，双方未动）、c < b（右侧改动）、b < a（左侧改动）
  assert.deepEqual(oc.cycles[0].elements, ['a', 'c', 'b', 'a']);
  const origins = oc.cycles[0].relations.map((rel) => `${rel.before}<${rel.after}:${rel.origin}`);
  assert.deepEqual(origins, ['a<c:base', 'c<b:right', 'b<a:left']);

  // 取舍：元素对 {a,b} 采用右侧顺序（与基线一致）
  const directives: Directive[] = [
    { type: 'order', arrayPath: ['list'], a: 'a', b: 'b', choice: 'right' },
  ];
  const r2 = mergeConfigs(base, left, right, { directives });
  assert.equal(r2.publishable, true);
  assert.deepEqual(ids((r2.snapshot as { list: ConfigNode }).list), ['a', 'c', 'b']);

  // 交换左右两侧：环相同（关系来源左右互换），候选等价
  const r3 = mergeConfigs(base, right, left);
  assert.deepEqual(r3.orderConflicts[0].cycles[0].elements, oc.cycles[0].elements);
  const swapped = r3.orderConflicts[0].cycles[0].relations.map(
    (rel) => `${rel.before}<${rel.after}:${rel.origin}`,
  );
  assert.deepEqual(swapped, ['a<c:base', 'c<b:left', 'b<a:right']);
});

test('多种合法顺序时按元素 ID 给出确定结果，且与左右交换无关', () => {
  const base = { list: arr() };
  const left = { list: arr(['m', 1]) };
  const right = { list: arr(['a', 2], ['z', 3]) };
  const r1 = mergeConfigs(base, left, right);
  const r2 = mergeConfigs(base, right, left);
  assert.equal(r1.publishable, true);
  assert.deepEqual(ids((r1.snapshot as { list: ConfigNode }).list), ['a', 'm', 'z']);
  assert.deepEqual(r2.snapshot, r1.snapshot);
});

test('演示2：删除与跨节点引用并发 -> 悬空引用被定位并保持待解决', () => {
  const base = { items: arr(['x', { name: 'x' }], ['y', { name: 'y' }]) };
  const left = { items: arr(['y', { name: 'y' }]) }; // 删除 x
  const right = { items: arr(['x', { name: 'x' }], ['y', { name: 'y', link: ref('x') }]) }; // y 新增指向 x 的引用

  const r = mergeConfigs(base, left, right);
  assert.equal(r.valueConflicts.length, 0);
  assert.equal(r.orderConflicts.length, 0);
  assert.equal(r.publishable, false); // 引用约束不成立，不可发布
  assert.ok(r.candidate);
  assert.deepEqual(r.referenceIssues, [
    { type: 'dangling-reference', refPath: '/items/[y]/link', targetId: 'x' },
  ]);

  // 取舍一：该引用采用左侧（即不引入），候选可发布
  const r2 = mergeConfigs(base, left, right, {
    directives: [{ type: 'value', path: ['items', { id: 'y' }, 'link'], choice: 'left' }],
  });
  assert.equal(r2.publishable, true);
  assert.deepEqual(ids((r2.snapshot as { items: ConfigNode }).items), ['y']);

  // 取舍二：被删元素 x 采用右侧（即保留），引用有效，候选可发布
  const r3 = mergeConfigs(base, left, right, {
    directives: [{ type: 'value', path: ['items', { id: 'x' }], choice: 'right' }],
  });
  assert.equal(r3.publishable, true);
  assert.deepEqual(ids((r3.snapshot as { items: ConfigNode }).items), ['x', 'y']);
});

test('演示3：一次取舍消除旧冲突却引入新引用环，继续取舍后可发布', () => {
  const base = { items: arr(['a', { v: 0 }], ['b', {}]) };
  const left = { items: arr(['a', { v: 1, link: ref('b') }], ['b', {}]) };
  const right = { items: arr(['a', { v: 2 }], ['b', { link: ref('a') }]) };

  // 第一次预览：值冲突（三侧原值均可追溯），无候选
  const r1 = mergeConfigs(base, left, right);
  assert.equal(r1.valueConflicts.length, 1);
  assert.equal(r1.valueConflicts[0].path, '/items/[a]/v');
  assert.equal(r1.valueConflicts[0].base, 0);
  assert.equal(r1.valueConflicts[0].left, 1);
  assert.equal(r1.valueConflicts[0].right, 2);
  assert.equal(r1.candidate, undefined);

  // 取舍 v 采用左侧：旧冲突消除，但引出 a <-> b 引用环，保持待解决
  const d1: Directive[] = [{ type: 'value', path: ['items', { id: 'a' }, 'v'], choice: 'left' }];
  const r2 = mergeConfigs(base, left, right, { directives: d1 });
  assert.equal(r2.valueConflicts.length, 0);
  assert.equal(r2.publishable, false);
  assert.equal(r2.referenceIssues.length, 1);
  const cyc = r2.referenceIssues[0];
  assert.equal(cyc.type, 'reference-cycle');
  assert.deepEqual((cyc as { elements: string[] }).elements, ['a', 'b', 'a']);
  assert.deepEqual(
    (cyc as { edges: { from: string; to: string; refPath: string }[] }).edges,
    [
      { from: 'a', to: 'b', refPath: '/items/[a]/link' },
      { from: 'b', to: 'a', refPath: '/items/[b]/link' },
    ],
  );

  // 再去掉 b.link（采用左侧，即不引入该引用），全部约束成立
  const r3 = mergeConfigs(base, left, right, {
    directives: [...d1, { type: 'value', path: ['items', { id: 'b' }, 'link'], choice: 'left' }],
  });
  assert.equal(r3.publishable, true);
  const items = (r3.snapshot as { items: { $array: { id: string; value: unknown }[] } }).items;
  assert.deepEqual(items.$array[0].value, { v: 1, link: { $ref: 'b' } });
  assert.deepEqual(items.$array[1].value, {});
});

test('双方新增：相同合并、对象按字段合并、标量不同则冲突且可用指令取舍', () => {
  const base = {};
  const left = { a: { x: 1 }, b: 1, c: { p: 1, q: 2 } };
  const right = { a: { x: 1 }, b: 2, c: { q: 2, r: 3 } };

  const r = mergeConfigs(base, left, right);
  assert.equal(r.valueConflicts.length, 1);
  assert.equal(r.valueConflicts[0].path, '/b');
  assert.equal(r.valueConflicts[0].reason, 'added-differently');

  const r2 = mergeConfigs(base, left, right, {
    directives: [{ type: 'value', path: ['b'], choice: 'left' }],
  });
  assert.equal(r2.publishable, true);
  assert.deepEqual(r2.snapshot, { a: { x: 1 }, b: 1, c: { p: 1, q: 2, r: 3 } });
});

test('左右交换与对象键遍历次序改变得到等价结果', () => {
  const base = { m: { p: 1, q: 2 }, n: { r: 3 }, list: arr(['a', 1], ['b', 2]) };
  const left = { m: { p: 10, q: 2 }, n: { r: 3 }, list: arr(['b', 2], ['a', 1]) };
  const right = { m: { p: 1, q: 20 }, n: { r: 3, s: 4 }, list: arr(['a', 1], ['b', 2], ['c', 3]) };

  const r1 = mergeConfigs(base, left, right);
  assert.equal(r1.publishable, true);
  assert.deepEqual(ids((r1.snapshot as { list: ConfigNode }).list), ['b', 'a', 'c']);

  // 左右交换 -> 候选相同
  const r2 = mergeConfigs(base, right, left);
  assert.deepEqual(r2.snapshot, r1.snapshot);

  // 对象键遍历次序不同 -> 完整结果相同
  const rightReordered = {
    n: { s: 4, r: 3 },
    list: arr(['a', 1], ['b', 2], ['c', 3]),
    m: { q: 20, p: 1 },
  };
  const r3 = mergeConfigs(base, left, rightReordered);
  assert.deepEqual(r3, r1);
});

test('畸形输入给出明确错误而不是崩溃', () => {
  assert.throws(
    () => mergeConfigs({ list: arr(['a', 1], ['a', 2]) }, {}, {}),
    /duplicate element id 'a'/,
  );
  assert.throws(
    () => mergeConfigs({ list: [1, 2] } as unknown as ConfigNode, {}, {}),
    /Invalid config node at \/list/,
  );
  assert.throws(
    () => mergeConfigs({ r: { $ref: 1 } } as unknown as ConfigNode, {}, {}),
    /Invalid \$ref at \/r/,
  );
  assert.throws(
    () => mergeConfigs({ a: { $bad: 1 } } as unknown as ConfigNode, {}, {}),
    /reserved key/,
  );
});

const swapOrigin = (o: string): string => (o === 'left' ? 'right' : o === 'right' ? 'left' : o);

/** 将一次合并结果中的左右来源互换，用于验证交换两侧后冲突集合等价。 */
const swapSides = (r: MergeResult): unknown => ({
  valueConflicts: r.valueConflicts.map((c) => ({ ...c, left: c.right, right: c.left })),
  orderConflicts: r.orderConflicts.map((oc) => ({
    ...oc,
    cycles: oc.cycles.map((cy) => ({
      ...cy,
      relations: cy.relations.map((rel) => ({
        ...rel,
        origin: swapOrigin(rel.origin),
        ...(rel.choice !== undefined ? { choice: swapOrigin(rel.choice) } : {}),
      })),
    })),
    conflictingPairs: oc.conflictingPairs.map((p) => ({ ...p, left: p.right, right: p.left })),
  })),
  referenceIssues: r.referenceIssues,
});

const stripResult = (r: MergeResult): unknown => ({
  valueConflicts: r.valueConflicts,
  orderConflicts: r.orderConflicts,
  referenceIssues: r.referenceIssues,
});

test('交错编辑压力测试：确定性随机场景下交换两侧结果等价', () => {
  let seed = 123456789;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let iter = 0; iter < 40; iter++) {
    const keyCount = 6;
    const base: Record<string, ConfigNode> = {};
    for (let k = 0; k < keyCount; k++) base[`k${k}`] = { v: k, s: `base-${k}` };
    base.list = arr(...[0, 1, 2, 3, 4].map((i) => [`e${i}`, { v: i }] as [string, ConfigNode]));

    // 一侧的交错编辑：随机删除/修改对象键，随机删除/重排/新增数组元素
    const edit = (side: string): Record<string, ConfigNode> => {
      const out: Record<string, ConfigNode> = {};
      for (let k = 0; k < keyCount; k++) {
        const roll = rand();
        if (roll < 0.2) continue; // 删除
        if (roll < 0.5) out[`k${k}`] = { v: k, s: `${side}-${k}` }; // 修改
        else out[`k${k}`] = { v: k, s: `base-${k}` }; // 保持
      }
      const els = [0, 1, 2, 3, 4]
        .filter(() => rand() > 0.25)
        .map((i) => [`e${i}`, { v: i }] as [string, ConfigNode]);
      for (let i = els.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [els[i], els[j]] = [els[j], els[i]];
      }
      if (rand() < 0.5) {
        els.splice(Math.floor(rand() * (els.length + 1)), 0, [`n-${side}`, { v: 99 }]);
      }
      out.list = arr(...els);
      return out;
    };

    const left = edit('L');
    const right = edit('R');
    const r1 = mergeConfigs(base, left, right);
    const r2 = mergeConfigs(base, right, left);
    assert.deepEqual(r2.candidate ?? null, r1.candidate ?? null, `candidate mismatch at iter ${iter}`);
    assert.deepEqual(swapSides(r2), stripResult(r1), `conflict mismatch at iter ${iter}`);
  }
});
