import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadSchema, validate } from '../src/index.ts';
import type { RawSchema, ValidationResult } from '../src/index.ts';

/** 编译辅助：测试中所有 Schema 都应加载成功，失败时直接断言并打印原因。 */
function compile(raw: RawSchema) {
  const loaded = loadSchema(raw);
  assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.errors, null, 2));
  return loaded.schema;
}

test('布尔 Schema：true 全放行，false 全拒绝且带实例/Schema 路径', () => {
  assert.equal(validate(compile(true), { anything: 1 }).valid, true);

  const result = validate(compile(false), { x: 1 });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].keyword, 'false-schema');
  assert.equal(result.errors[0].instancePath, '');
  assert.equal(result.errors[0].schemaPath, '#');
});

test('基础 type：标量、数组、对象、integer 与 number 的区分', () => {
  const schema = compile({ type: ['string', 'integer'] });
  assert.equal(validate(schema, 'hello').valid, true);
  assert.equal(validate(schema, 42).valid, true);
  assert.equal(validate(schema, 42.5).valid, false);
  assert.equal(validate(schema, null).valid, false);

  const err = validate(compile({ type: 'array' }), { a: 1 });
  assert.equal(err.valid, false);
  assert.equal(err.errors[0].keyword, 'type');
  assert.equal(err.errors[0].schemaPath, '#/type');
});

test('properties 与 required：required 不登记字段已被求值', () => {
  const schema = compile({
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a', 'missing'],
    unevaluatedProperties: false,
  });

  // 仅出现 a：required 报缺字段；a 本身被 properties 求值，不触发 unevaluatedProperties。
  const r1 = validate(schema, { a: 'x' });
  assert.equal(r1.valid, false);
  assert.deepEqual(
    r1.errors.map((e) => e.keyword),
    ['required'],
  );

  // 未声明字段 b 只能由 unevaluatedProperties 拒绝（required 不会替它放行）。
  const r2 = validate(schema, { a: 'x', b: 2 });
  assert.ok(r2.errors.some((e) => e.keyword === 'unevaluatedProperties'));
  assert.ok(r2.errors.some((e) => e.instancePath === '/b'));
});

test('题目主场景：anyOf 两个成功分支分别声明 a 与 b，外层 unevaluatedProperties:false 同时放行', () => {
  const schema = compile({
    type: 'object',
    anyOf: [
      { properties: { a: { type: 'string' } }, required: ['a'] },
      { properties: { b: { type: 'number' } }, required: ['b'] },
    ],
    unevaluatedProperties: false,
  });

  const ok = validate(schema, { a: 'hello', b: 42 });
  // 两个分支各自成功，整体有效；失败分支才会留下具体错误，此处两分支均通过。
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.errors, []);

  // 单字段也合法（另一个分支成功即可）。成功的整体结果不携带错误。
  assert.equal(validate(schema, { a: 'x' }).valid, true);
  assert.equal(validate(schema, { b: 1 }).valid, true);

  // 两分支都失败（a 类型错误且无 b）：anyOf 报错，且失败分支不能为 c 放行。
  const bad = validate(schema, { a: 1, c: true });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.keyword === 'anyOf'));
  assert.ok(bad.errors.some((e) => e.keyword === 'unevaluatedProperties' && e.instancePath === '/c'));
});

test('anyOf：失败分支的求值记录不能替未知字段放行', () => {
  const schema = compile({
    type: 'object',
    anyOf: [
      // 分支 0：对 ghost 要求 integer；实例里 ghost 是字符串 -> 该分支必然失败，
      // 但它在作用域内“声明”了 ghost。
      { properties: { ghost: { type: 'integer' } } },
      // 分支 1：唯一成功分支，只声明 ok。
      { properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    ],
    unevaluatedProperties: false,
  });

  const result = validate(schema, { ok: true, ghost: 'x' });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.keyword === 'unevaluatedProperties' && e.instancePath === '/ghost',
    ),
    'ghost 仅在失败分支中出现，必须仍被视为未求值字段',
  );
  // 整体仍有成功分支时，失败分支的细节不外泄（它只是未被选中的备选）。
  assert.ok(!result.errors.some((e) => e.keyword === 'type'));

  // 对照：当所有分支都失败时，失败分支的具体错误才会暴露给调用方。
  const allFail = validate(schema, { ghost: 'x' });
  assert.equal(allFail.valid, false);
  assert.ok(allFail.errors.some((e) => e.keyword === 'anyOf'));
  assert.ok(allFail.errors.some((e) => e.keyword === 'type' && e.instancePath === '/ghost'));
});

test('anyOf：多个成功分支的记录做并集合并，重复字段不产生副作用', () => {
  const schema = compile({
    type: 'object',
    anyOf: [
      { properties: { a: { type: 'string' }, shared: { type: 'integer' } } },
      { properties: { b: { type: 'number' }, shared: { type: 'integer' } } },
      { properties: { c: { type: 'boolean' } } },
    ],
    unevaluatedProperties: false,
  });
  assert.equal(validate(schema, { a: 's', b: 1, c: true, shared: 3 }).valid, true);
  const bad = validate(schema, { a: 's', unknown: null });
  assert.ok(bad.errors.some((e) => e.instancePath === '/unknown'));
});

test('oneOf：恰好一个成功分支，零个或多个都失败', () => {
  const schema = compile({
    oneOf: [
      { properties: { a: { type: 'string' } }, required: ['a'] },
      { properties: { b: { type: 'number' } }, required: ['b'] },
    ],
    unevaluatedProperties: false,
  });

  assert.equal(validate(schema, { a: 'x' }).valid, true);
  assert.equal(validate(schema, { b: 1 }).valid, true);

  const none = validate(schema, { c: 1 });
  assert.ok(none.errors.some((e) => e.keyword === 'oneOf'));
  // c 未被任何成功分支求值。
  assert.ok(none.errors.some((e) => e.instancePath === '/c'));

  const two = validate(schema, { a: 'x', b: 1 });
  assert.ok(two.errors.some((e) => e.keyword === 'oneOf'));
  // 两个分支都成功时 oneOf 整体失败，成功分支的字段不得作为放行依据。
  assert.ok(two.errors.some((e) => e.instancePath === '/a'));
  assert.ok(two.errors.some((e) => e.instancePath === '/b'));
});

test('allOf：每个分支都必须通过，字段记录跨分支累积', () => {
  const schema = compile({
    allOf: [
      { properties: { a: { type: 'string' } }, required: ['a'] },
      { properties: { b: { type: 'number' } }, required: ['b'] },
    ],
    unevaluatedProperties: false,
  });
  assert.equal(validate(schema, { a: 'x', b: 2 }).valid, true);

  const fail = validate(schema, { a: 'x' });
  assert.ok(fail.errors.some((e) => e.keyword === 'required'));

  const extra = validate(schema, { a: 'x', b: 2, z: 0 });
  assert.ok(extra.errors.some((e) => e.keyword === 'unevaluatedProperties'));
});

test('items：数组元素逐个递归校验并给出带索引的实例路径', () => {
  const schema = compile({
    type: 'array',
    items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  });
  assert.equal(validate(schema, [{ id: 1 }, { id: 2 }]).valid, true);

  const bad = validate(schema, [{ id: 1 }, {}]);
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].instancePath, '/1');
  assert.equal(bad.errors[0].schemaPath, '#/items/required');
});

test('本地 $defs/$ref：经对象属性与数组元素递进的递归结构', () => {
  const tree: RawSchema = {
    $defs: {
      node: {
        type: 'object',
        properties: {
          value: { type: 'integer' },
          children: { type: 'array', items: { $ref: '#/$defs/node' } },
        },
        required: ['value'],
      },
    },
    $ref: '#/$defs/node',
  };
  const schema = compile(tree);

  assert.equal(
    validate(schema, {
      value: 1,
      children: [{ value: 2 }, { value: 3, children: [{ value: 4 }] }],
    }).valid,
    true,
  );

  const bad = validate(schema, {
    value: 1,
    children: [{ children: [{ value: 9 }] }],
  });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].instancePath, '/children/0');
  assert.equal(bad.errors[0].keyword, 'required');
});

test('同层 properties 已求值的字段在分支 unevaluatedProperties 处不再重复拦截', () => {
  const schema = compile({
    type: 'object',
    properties: {
      a: { type: 'string' },
      payload: {
        anyOf: [{ type: 'string' }, { type: 'integer' }],
        unevaluatedProperties: false,
      },
    },
    unevaluatedProperties: false,
  });
  assert.equal(validate(schema, { a: 'x', payload: 7 }).valid, true);
  assert.equal(validate(schema, { a: 'x', payload: { nested: 1 } }).valid, false);
});

test('同一 $ref 用于不同实例位置时各自独立给出正确结果', () => {
  const schema = compile({
    type: 'object',
    properties: {
      left: { $ref: '#/$defs/box' },
      right: { $ref: '#/$defs/box' },
    },
    $defs: {
      box: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
    },
  });

  const bad = validate(schema, { left: { n: 1 }, right: {} });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].instancePath, '/right');
});

test('$ref 与同级关键字共同求值，注解合并到同一作用域', () => {
  const schema = compile({
    $ref: '#/$defs/base',
    properties: { extra: { type: 'string' } },
    unevaluatedProperties: false,
    $defs: {
      base: { properties: { id: { type: 'integer' } } },
    },
  });
  assert.equal(validate(schema, { id: 1, extra: 'e' }).valid, true);
  const bad = validate(schema, { id: 1, nope: true });
  assert.ok(bad.errors.some((e) => e.instancePath === '/nope'));
});

test('加载期拒绝：根节点纯原地 $ref 自循环', () => {
  const loaded = loadSchema({ $ref: '#' });
  assert.equal(loaded.ok, false);
  assert.match(loaded.ok ? '' : loaded.errors[0].message, /引用循环/);
});

test('加载期拒绝：anyOf 内不消耗实例层级的引用自循环', () => {
  const loaded = loadSchema({
    $defs: { loop: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/loop' }] } },
    $ref: '#/$defs/loop',
  });
  assert.equal(loaded.ok, false);
});

test('加载期拒绝：allOf 与 $ref 构成的多节点原地环', () => {
  const loaded = loadSchema({
    $defs: {
      a: { allOf: [{ $ref: '#/$defs/b' }] },
      b: { allOf: [{ $ref: '#/$defs/a' }] },
    },
    $ref: '#/$defs/a',
  });
  assert.equal(loaded.ok, false);
});

test('加载期拒绝：悬空引用与非本地引用', () => {
  assert.equal(loadSchema({ $ref: '#/$defs/nope' }).ok, false);
  assert.equal(loadSchema({ $ref: 'https://example.com/schema.json' }).ok, false);
  assert.equal(loadSchema({ type: 'not-a-type' }).ok, false);
  assert.equal(loadSchema({ required: ['a', 'a'] }).ok, false);
});

test('经 properties 下降的自引用不是原地循环，加载通过且可正常求值', () => {
  const loaded = loadSchema({
    $defs: {
      node: {
        type: 'object',
        properties: { next: { $ref: '#/$defs/node' } },
      },
    },
    $ref: '#/$defs/node',
  });
  assert.equal(loaded.ok, true);
});

test('不可达的 $defs 即使含原地环也不影响整份 Schema 加载', () => {
  const loaded = loadSchema({
    type: 'object',
    properties: { id: { type: 'integer' } },
    $defs: {
      // 从未被任何 $ref 引用的孤立自循环定义。
      orphan: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/orphan' }] },
    },
  });
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(validate(loaded.schema, { id: 3 }).valid, true);
    assert.equal(validate(loaded.schema, { id: 'no' }).valid, false);
  }
});

test('经下降边可达的原地环仍在加载期拒绝', () => {
  const loaded = loadSchema({
    $defs: {
      loop: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/loop' }] },
    },
    type: 'object',
    properties: { entry: { $ref: '#/$defs/loop' } },
  });
  assert.equal(loaded.ok, false);
});

test('深度耗尽返回资源错误，与内容不合法分开', () => {
  const schema = compile({
    $defs: { node: { properties: { next: { $ref: '#/$defs/node' } } } },
    $ref: '#/$defs/node',
  });

  // 构造超过 maxDepth 的嵌套实例。
  let instance: unknown = {};
  for (let i = 0; i < 10; i += 1) {
    instance = { next: instance };
  }

  const result = validate(schema, instance, { maxDepth: 5 }) as Extract<
    ValidationResult,
    { kind: 'resource' }
  >;
  assert.equal(result.valid, false);
  assert.equal(result.kind, 'resource');
  assert.equal(result.code, 'max-depth');
  assert.equal(result.errors.length, 0);
  assert.equal(result.limit, 5);
});

test('求值预算耗尽返回资源错误（交叉递归结构 + 宽实例）', () => {
  const schema = compile({
    type: 'array',
    items: {
      anyOf: [
        { properties: { a: { type: 'string' } } },
        { properties: { b: { type: 'number' } } },
        { allOf: [{ properties: { c: { type: 'boolean' } } }] },
      ],
    },
  });

  const instance = Array.from({ length: 500 }, (_, i) => ({ a: String(i), b: i, c: true }));
  const result = validate(schema, instance, { evaluationBudget: 100 }) as Extract<
    ValidationResult,
    { kind: 'resource' }
  >;
  assert.equal(result.kind, 'resource');
  assert.equal(result.code, 'evaluation-budget');
  assert.equal(result.errors.length, 0);
});

test('交错场景：嵌套对象中 anyOf/oneOf/allOf 与 $ref 混合时字段收集正确', () => {
  const schema = compile({
    $defs: {
      tag: {
        // 两个分支按类型互斥：数字仅命中分支 0，非空字符串仅命中分支 1。
        oneOf: [{ properties: { kind: { type: 'integer' } } }, { properties: { kind: { type: 'string' } } }],
      },
    },
    type: 'object',
    allOf: [{ properties: { id: { type: 'integer' } }, required: ['id'] }],
    anyOf: [
      { properties: { name: { type: 'string' } } },
      { properties: { code: { type: 'string' } } },
    ],
    properties: {
      meta: {
        type: 'object',
        $ref: '#/$defs/tag',
        unevaluatedProperties: false,
      },
    },
    unevaluatedProperties: false,
  });

  // kind 为布尔：既不是 integer 也不是 string，两个分支都失败 -> oneOf 报错。
  const noneMatch = validate(schema, {
    id: 7,
    name: 'n',
    meta: { kind: true },
  });
  assert.equal(noneMatch.valid, false);
  assert.ok(noneMatch.errors.some((e) => e.instancePath === '/meta' && e.keyword === 'oneOf'));

  // kind:123 仅命中 integer 分支；kind:'y' 仅命中 string 分支，均恰好一个成功。
  // 整体成功时失败分支的错误不外泄，因此 errors 必须为空。
  assert.deepEqual(
    validate(schema, { id: 7, code: 'c', meta: { kind: 123 } }),
    { valid: true, errors: [] },
  );
  const ok = validate(schema, { id: 7, name: 'n', meta: { kind: 'y' } });
  assert.deepEqual(ok, { valid: true, errors: [] });

  // 成功分支求值过的 kind 放行；meta 内未求值的 junk 仍被内层 unevaluatedProperties 拦截。
  const innerStray = validate(schema, { id: 7, name: 'n', meta: { kind: 'y', junk: 0 } });
  assert.ok(innerStray.errors.some((e) => e.instancePath === '/meta/junk'));

  // 外层未知字段仍被拦截。
  const stray = validate(schema, { id: 7, name: 'n', meta: { kind: 'y' }, stray: 0 });
  assert.ok(stray.errors.some((e) => e.instancePath === '/stray'));
});

test('调用方适配器风格：模拟请求体解析后校验的完整流程', () => {
  const schema = compile({
    type: 'object',
    properties: {
      user: {
        type: 'object',
        properties: { age: { type: 'integer' } },
        required: ['age'],
        unevaluatedProperties: false,
      },
    },
    required: ['user'],
  });

  // 模拟一个 HTTP 处理函数内的适配层。
  const handleRequest = (rawBody: string): ValidationResult => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return {
        valid: false,
        errors: [
          {
            instancePath: '',
            schemaPath: '#',
            keyword: 'parse',
            message: '请求体不是合法 JSON',
          },
        ],
      } as ValidationResult;
    }
    return validate(schema, parsed);
  };

  assert.equal(handleRequest('{"user":{"age":30}}').valid, true);
  const badJson = handleRequest('{not-json');
  assert.equal(badJson.valid, false);
  assert.equal(badJson.errors[0].keyword, 'parse');

  const badShape = handleRequest('{"user":{"age":30,"role":"admin"}}');
  assert.equal(badShape.valid, false);
  assert.equal(badShape.errors[0].instancePath, '/user/role');
});
