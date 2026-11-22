/**
 * 三个必演场景的端到端演示：node examples/demo.ts
 * 每次预览的冲突/问题都可追溯到基线与两侧原值（冲突对象携带 base/left/right，
 * 顺序关系携带 origin，引用问题携带稳定 ID 路径）。
 */
import { mergeConfigs, type ConfigNode, type Directive } from '../src/index.ts';

const arr = (...els: [string, ConfigNode][]): ConfigNode => ({
  $array: els.map(([id, value]) => ({ id, value })),
});
const ref = (id: string): ConfigNode => ({ $ref: id });
const replacer = (_k: string, v: unknown): unknown => (typeof v === 'symbol' ? '<absent>' : v);
const show = (title: string, v: unknown): void => {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(v, replacer, 2));
};

// ---- 演示 1：两侧各自合法的重排，合并后顺序关系成环 ----
{
  const mk = (order: string[]): ConfigNode => ({
    list: arr(...order.map((id) => [id, { id }] as [string, ConfigNode])),
  });
  const base = mk(['a', 'b', 'c']);
  const left = mk(['b', 'a', 'c']);
  const right = mk(['a', 'c', 'b']);
  show('演示1 第一次预览：重排成环', mergeConfigs(base, left, right).orderConflicts);
  const directives: Directive[] = [
    { type: 'order', arrayPath: ['list'], a: 'a', b: 'b', choice: 'right' },
  ];
  show('演示1 取舍后：可发布', mergeConfigs(base, left, right, { directives }));
}

// ---- 演示 2：删除与跨节点引用并发 -> 悬空引用待解决 ----
{
  const base = { items: arr(['x', { name: 'x' }], ['y', { name: 'y' }]) };
  const left = { items: arr(['y', { name: 'y' }]) };
  const right = { items: arr(['x', { name: 'x' }], ['y', { name: 'y', link: ref('x') }]) };
  show('演示2 第一次预览：悬空引用', mergeConfigs(base, left, right));
  const directives: Directive[] = [
    { type: 'value', path: ['items', { id: 'x' }], choice: 'right' }, // 保留 x
  ];
  show('演示2 取舍后：可发布', mergeConfigs(base, left, right, { directives }));
}

// ---- 演示 3：一次取舍消除旧冲突，却引入新的引用环 ----
{
  const base = { items: arr(['a', { v: 0 }], ['b', {}]) };
  const left = { items: arr(['a', { v: 1, link: ref('b') }], ['b', {}]) };
  const right = { items: arr(['a', { v: 2 }], ['b', { link: ref('a') }]) };
  show('演示3 第一次预览：值冲突', mergeConfigs(base, left, right).valueConflicts);
  const d1: Directive[] = [{ type: 'value', path: ['items', { id: 'a' }, 'v'], choice: 'left' }];
  show('演示3 取舍 v 后：出现引用环', mergeConfigs(base, left, right, { directives: d1 }).referenceIssues);
  const d2: Directive[] = [
    ...d1,
    { type: 'value', path: ['items', { id: 'b' }, 'link'], choice: 'left' },
  ];
  show('演示3 再去掉 b.link：可发布', mergeConfigs(base, left, right, { directives: d2 }));
}
