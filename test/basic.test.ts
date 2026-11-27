import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CountingBloomSummary, bloomPositions, identityKey } from '../src/index.ts';
import type { BloomConfig } from '../src/index.ts';

const CONFIG: BloomConfig = { size: 64, hashes: 4, seed: 42 };

/** 枚举主题名，找出两个在指定配置下命中位置集合完全相同（强碰撞）的主题。 */
function findCollidingTopics(config: BloomConfig): [string, string] {
  const seen = new Map<string, string>();
  for (let i = 0; i < 5000; i++) {
    const topic = `topic-${i}`;
    const key = bloomPositions(identityKey('', topic), config.size, config.hashes, config.seed)
      .sort((a, b) => a - b)
      .join(',');
    const other = seen.get(key);
    if (other !== undefined) {
      return [other, topic];
    }
    seen.set(key, topic);
  }
  throw new Error('合成数据中未找到碰撞主题，调大枚举范围');
}

/** 确定性伪随机数（mulberry32），保证交错测试可重复。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('计数 Bloom 兴趣摘要：核心语义', () => {
  test('碰撞主题：撤销其中一个不会使另一个被判成无订阅', () => {
    const summary = new CountingBloomSummary(CONFIG);
    const [topicA, topicB] = findCollidingTopics(CONFIG);

    // 两者命中完全相同的哈希位置（顺序无关，按集合比较）
    const posA = bloomPositions(identityKey('', topicA), CONFIG.size, CONFIG.hashes, CONFIG.seed);
    const posB = bloomPositions(identityKey('', topicB), CONFIG.size, CONFIG.hashes, CONFIG.seed);
    assert.deepEqual([...posA].sort((a, b) => a - b), [...posB].sort((a, b) => a - b));

    summary.register('sub-1', topicA);
    summary.register('sub-2', topicB);

    assert.equal(summary.hasSubscription(topicA), true);
    assert.equal(summary.hasSubscription(topicB), true);

    // 碰撞槽位计数为 2，而非二值位的 1
    const vector = summary.snapshotVector();
    for (const pos of posA) {
      assert.equal(vector[pos], 2, `碰撞槽位 ${pos} 应记录两个不同主题的贡献`);
    }

    // 撤销 A：只减去 A 的一份贡献，B 的订阅仍然可判。
    // 注意：A 与 B 强碰撞，A 的位置仍被 B 占用，因此 A 可能出现假阳性
    // （Bloom 过滤器允许假阳性）；关键不变量是计数正确递减且 B 零假阴性。
    summary.unregister('sub-1', topicA);
    assert.equal(summary.subscriberCount(topicA), 0, 'A 已无任何订阅者');
    assert.equal(summary.hasSubscription(topicB), true, '碰撞主题不能因对方撤销而漏判');

    const after = summary.snapshotVector();
    for (const pos of posB) {
      assert.equal(after[pos], 1, `槽位 ${pos} 应保留 B 的一份贡献，未被清零`);
    }

    summary.unregister('sub-2', topicB);
    assert.equal(summary.hasSubscription(topicB), false);
    const cleared = summary.snapshotVector();
    for (const pos of posB) {
      assert.equal(cleared[pos], 0, '最后一个主题撤销后碰撞槽位归零');
    }
  });

  test('同一登记重复加入/撤销均无额外影响', () => {
    const summary = new CountingBloomSummary(CONFIG);
    const r1 = summary.register('s1', 't/x');
    assert.equal(r1.changed, true);
    const r2 = summary.register('s1', 't/x');
    assert.equal(r2.changed, false, '重复登记不应产生变化');
    assert.equal(r2.subscriberCount, 1);

    const positions = bloomPositions(identityKey('', 't/x'), CONFIG.size, CONFIG.hashes, CONFIG.seed);
    const vector = summary.snapshotVector();
    for (const pos of positions) {
      assert.equal(vector[pos], 1, '重复登记不能重复计数');
    }

    const u1 = summary.unregister('s1', 't/x');
    assert.equal(u1.changed, true);
    const u2 = summary.unregister('s1', 't/x');
    assert.equal(u2.changed, false, '重复撤销不应产生变化');
    assert.equal(u2.topicActive, false);
    assert.equal(summary.hasSubscription('t/x'), false);
  });

  test('多个订阅者共享主题：最后一个撤销才移除主题贡献', () => {
    const summary = new CountingBloomSummary(CONFIG);
    summary.register('s1', 'shared');
    summary.register('s2', 'shared');
    summary.register('s3', 'shared');
    assert.equal(summary.subscriberCount('shared'), 3);

    const positions = bloomPositions(identityKey('', 'shared'), CONFIG.size, CONFIG.hashes, CONFIG.seed);
    let vector = summary.snapshotVector();
    for (const pos of positions) {
      assert.equal(vector[pos], 1, '主题对每个位置只贡献一次，与订阅者数量无关');
    }

    const u1 = summary.unregister('s1', 'shared');
    assert.equal(u1.changed, true);
    assert.equal(u1.topicActive, true);
    assert.equal(summary.hasSubscription('shared'), true, '仍有订阅者，主题必须可判');
    vector = summary.snapshotVector();
    for (const pos of positions) {
      assert.equal(vector[pos], 1, '非最后一个订阅者撤销不影响向量');
    }

    summary.unregister('s2', 'shared');
    const u3 = summary.unregister('s3', 'shared');
    assert.equal(u3.topicActive, false);
    assert.equal(u3.subscriberCount, 0);
    vector = summary.snapshotVector();
    for (const pos of positions) {
      assert.equal(vector[pos], 0, '最后一个订阅者撤销后移除主题贡献');
    }
  });

  test('同一主题重复命中同一哈希位置只贡献一次计数', () => {
    // hashes 远大于 size 时必然出现同身份内部的位置重复
    const cfg: BloomConfig = { size: 4, hashes: 16, seed: 7 };
    const summary = new CountingBloomSummary(cfg);
    summary.register('s1', 'dup-hit');

    const rawPositions = [];
    // bloomPositions 已去重；这里直接验证向量每个被命中槽位恰好为 1
    const positions = bloomPositions(identityKey('', 'dup-hit'), cfg.size, cfg.hashes, cfg.seed);
    assert.ok(positions.length <= cfg.size);
    const vector = summary.snapshotVector();
    for (const pos of positions) {
      assert.equal(vector[pos], 1);
      rawPositions.push(pos);
    }
    assert.equal(new Set(rawPositions).size, rawPositions.length, '返回位置本身已去重');
    // 未命中槽位保持 0
    let touched = 0;
    for (const v of vector) {
      if (v > 0) {
        touched += 1;
      }
    }
    assert.equal(touched, positions.length);
  });

  test('查询只访问对应哈希位置：任一对应槽位为 0 即无订阅，全部 >0 才判有订阅', () => {
    const summary = new CountingBloomSummary(CONFIG);
    // 空摘要上任何主题都应判无订阅（零向量）
    assert.equal(summary.hasSubscription('never/registered'), false);

    summary.register('s1', 'real/topic');
    assert.equal(summary.hasSubscription('real/topic'), true);

    // 手工按相同位置检查，验证查询只依赖这些位置
    const positions = bloomPositions(identityKey('', 'real/topic'), CONFIG.size, CONFIG.hashes, CONFIG.seed);
    const vector = summary.snapshotVector();
    const manual = positions.every((pos) => vector[pos] > 0);
    assert.equal(manual, true);
  });

  test('随机交错登记/撤销：当前代次始终与按有效集合直接重建的参考向量逐项一致', () => {
    const rand = mulberry32(20261128);
    const summary = new CountingBloomSummary(CONFIG);
    const model = new Map<string, Set<string>>();
    const subscribers = ['a', 'b', 'c', 'd', 'e'];
    const topics = Array.from({ length: 12 }, (_, i) => `t/${i}`);

    for (let step = 0; step < 2000; step++) {
      const sub = subscribers[Math.floor(rand() * subscribers.length)];
      const topic = topics[Math.floor(rand() * topics.length)];
      const register = rand() < 0.55;

      if (register) {
        summary.register(sub, topic);
        let set = model.get(topic);
        if (set === undefined) {
          set = new Set();
          model.set(topic, set);
        }
        set.add(sub);
      } else {
        summary.unregister(sub, topic);
        model.get(topic)?.delete(sub);
        if (model.get(topic)?.size === 0) {
          model.delete(topic);
        }
      }

      if (step % 50 === 0) {
        assert.equal(summary.verifyCurrent(), true, `第 ${step} 步向量与参考向量不一致`);
        // 模型层面的订阅判定：有效订阅绝不允许漏判（零假阴性）
        for (const t of topics) {
          if (model.has(t)) {
            assert.equal(summary.hasSubscription(t), true, '有效订阅绝不能漏判');
          }
        }
      }
    }
    assert.equal(summary.verifyCurrent(), true);
  });

  test('崩溃恢复：重放操作日志重建的摘要与原摘要逐项相同', () => {
    const rand = mulberry32(99);
    const log: Array<{ op: 'reg' | 'unreg'; sub: string; topic: string }> = [];
    const original = new CountingBloomSummary(CONFIG);

    for (let i = 0; i < 500; i++) {
      const sub = `s${Math.floor(rand() * 6)}`;
      const topic = `topic/${Math.floor(rand() * 10)}`;
      const op = rand() < 0.6 ? 'reg' : 'unreg';
      log.push({ op, sub, topic });
      if (op === 'reg') {
        original.register(sub, topic);
      } else {
        original.unregister(sub, topic);
      }
    }

    // 模拟进程崩溃后从零重放完整日志
    const recovered = new CountingBloomSummary(CONFIG);
    for (const entry of log) {
      if (entry.op === 'reg') {
        recovered.register(entry.sub, entry.topic);
      } else {
        recovered.unregister(entry.sub, entry.topic);
      }
    }

    assert.deepEqual(Array.from(recovered.snapshotVector()), Array.from(original.snapshotVector()));
    assert.equal(recovered.activeTopicCount, original.activeTopicCount);
    assert.equal(recovered.verifyCurrent(), true);
  });
});
