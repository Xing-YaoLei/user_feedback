import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CountingBloomSummary } from '../src/index.ts';
import type { BloomConfig } from '../src/index.ts';

const OLD_CFG: BloomConfig = { size: 32, hashes: 3, seed: 1 };
const NEW_CFG: BloomConfig = { size: 128, hashes: 5, seed: 99 };

/** 把重建一步步推进到完成（drain 结束、尚未发布）。 */
function runToDrained(summary: CountingBloomSummary): void {
  for (let guard = 0; guard < 10_000; guard++) {
    const progress = summary.stepRebuild();
    if (progress.phase === 'drain' && progress.remaining === 0 && progress.pendingChanges === 0) {
      return;
    }
    if (progress.phase === 'aborted') {
      throw new Error(`重建意外中止: ${progress.abortReason ?? ''}`);
    }
  }
  throw new Error('重建推进超过保护步数仍未完成');
}

describe('计数 Bloom 兴趣摘要：分步重建', () => {
  test('分步推进：进度统计准确，完成后候选与直接重建参考向量逐项一致', () => {
    const summary = new CountingBloomSummary(OLD_CFG);
    for (let i = 0; i < 10; i++) {
      summary.register(`s${i % 3}`, `topic/${i}`);
    }

    const progress = summary.startRebuild(NEW_CFG, { batchSize: 3 });
    assert.equal(progress.phase, 'sweep');
    assert.equal(progress.total, 10);
    assert.equal(progress.remaining, 10);
    assert.equal(progress.accepted, 0);
    assert.equal(summary.generationId, 0, '重建期间代次保持不变');

    const p1 = summary.stepRebuild();
    assert.equal(p1.remaining, 7);
    assert.equal(p1.accepted, 3);
    const p2 = summary.stepRebuild();
    assert.equal(p2.remaining, 4);
    assert.equal(p2.accepted, 6);

    runToDrained(summary);
    assert.equal(summary.verifyCandidate(), true, '候选向量必须与参考向量逐项相同');

    const info = summary.publishRebuild();
    assert.equal(info.generation, 1);
    assert.deepEqual(info.config, NEW_CFG);
    assert.equal(summary.generationId, 1);
    assert.equal(summary.verifyCurrent(), true, '发布后当前代次仍与参考向量一致');
    assert.equal(summary.getRebuildProgress(), null);

    for (let i = 0; i < 10; i++) {
      assert.equal(summary.hasSubscription(`topic/${i}`), true, '发布后有效订阅全部可判');
    }
  });

  test('重建期间继续接收登记与撤销，查询始终使用原代次，发布后切换到包含变更的新摘要', () => {
    const summary = new CountingBloomSummary(OLD_CFG);
    for (let i = 0; i < 8; i++) {
      summary.register('s1', `keep/${i}`);
    }
    summary.register('s1', 'will/remove');
    summary.register('s1', 'will/drop-subscriber');

    summary.startRebuild(NEW_CFG, { batchSize: 2 });
    summary.stepRebuild();

    // 重建进行中：新登记、撤销、最后订阅者撤销全部继续生效
    summary.register('s2', 'added/during/rebuild');
    summary.unregister('s1', 'will/remove');
    summary.unregister('s1', 'will/drop-subscriber');
    assert.equal(summary.subscriberCount('added/during/rebuild'), 1);
    assert.equal(summary.generationId, 0, '发布前代次不变');

    // 查询继续走原代次（旧配置），且结果反映已接受的变更
    assert.equal(summary.hasSubscription('added/during/rebuild'), true);
    assert.equal(summary.hasSubscription('will/remove'), false);
    assert.equal(summary.hasSubscription('will/drop-subscriber'), false);
    assert.equal(summary.verifyCurrent(), true, '旧代次向量持续与有效集合一致');

    const progress = summary.getRebuildProgress();
    assert.ok(progress !== null && progress.pendingChanges >= 3);

    runToDrained(summary);
    assert.equal(summary.verifyCandidate(), true, '候选已对账重建期间全部变更');

    summary.publishRebuild();
    assert.equal(summary.generationId, 1);
    assert.deepEqual(summary.config, NEW_CFG);
    assert.equal(summary.hasSubscription('added/during/rebuild'), true);
    assert.equal(summary.hasSubscription('will/remove'), false);
    assert.equal(summary.hasSubscription('will/drop-subscriber'), false);
    for (let i = 0; i < 8; i++) {
      assert.equal(summary.hasSubscription(`keep/${i}`), true);
    }
    assert.equal(summary.verifyCurrent(), true);
  });

  test('一次查询不混用两代向量：重建中候选与当前代次分别可查，hasSubscription 固定走当前代次', () => {
    const summary = new CountingBloomSummary(OLD_CFG);
    summary.register('s1', 'alpha');
    summary.register('s1', 'beta');

    summary.startRebuild(NEW_CFG, { batchSize: 1 });
    summary.stepRebuild(); // 候选只接受了部分主题

    // 候选视角：尚未 sweep 到的主题在候选向量上判无订阅
    const candidateAlpha = summary.queryCandidate('alpha');
    const candidateBeta = summary.queryCandidate('beta');
    assert.equal(candidateAlpha || candidateBeta, true);
    assert.notEqual(candidateAlpha, candidateBeta, '候选只包含部分主题，两代内容不同');

    // 正式查询始终只读取当前（旧）代次，两个主题都必须可判
    assert.equal(summary.hasSubscription('alpha'), true);
    assert.equal(summary.hasSubscription('beta'), true);

    runToDrained(summary);
    summary.publishRebuild();

    // 发布后全部查询走新代次
    assert.equal(summary.hasSubscription('alpha'), true);
    assert.equal(summary.hasSubscription('beta'), true);
    assert.throws(() => summary.queryCandidate('alpha'), /没有进行中的重建/);
  });

  test('重建可暂停、继续，暂停期间登记/撤销照常，step 被拒绝', () => {
    const summary = new CountingBloomSummary(OLD_CFG);
    for (let i = 0; i < 6; i++) {
      summary.register('s1', `t/${i}`);
    }
    summary.startRebuild(NEW_CFG, { batchSize: 2 });
    summary.stepRebuild();

    const paused = summary.pauseRebuild();
    assert.equal(paused.phase, 'paused');
    assert.throws(() => summary.stepRebuild(), /已暂停/);

    // 暂停期间变更不丢
    summary.register('s9', 't/while-paused');
    summary.unregister('s1', 't/0');

    const resumed = summary.resumeRebuild();
    assert.equal(resumed.phase, 'sweep');

    runToDrained(summary);
    assert.equal(summary.verifyCandidate(), true);
    summary.publishRebuild();

    assert.equal(summary.hasSubscription('t/while-paused'), true);
    assert.equal(summary.hasSubscription('t/0'), false);
    for (let i = 1; i < 6; i++) {
      assert.equal(summary.hasSubscription(`t/${i}`), true);
    }
    assert.equal(summary.verifyCurrent(), true);
  });

  test('放弃重建：候选被丢弃，当前代次与已接受登记继续有效，可重新发起重建', () => {
    const summary = new CountingBloomSummary(OLD_CFG);
    summary.register('s1', 'survivor');
    summary.startRebuild(NEW_CFG, { batchSize: 1 });
    summary.stepRebuild();
    summary.register('s2', 'accepted/anyway');

    const aborted = summary.abortRebuild();
    assert.equal(aborted.phase, 'aborted');
    assert.equal(summary.generationId, 0);
    assert.deepEqual(summary.config, OLD_CFG);
    assert.equal(summary.hasSubscription('survivor'), true);
    assert.equal(summary.hasSubscription('accepted/anyway'), true, '已接受登记在旧代次上继续有效');
    assert.equal(summary.verifyCurrent(), true);
    assert.throws(() => summary.snapshotCandidateVector(), /没有进行中的重建/);

    // 可以重新发起并完成一次新的重建
    summary.startRebuild(NEW_CFG, { batchSize: 4 });
    runToDrained(summary);
    summary.publishRebuild();
    assert.equal(summary.generationId, 1);
    assert.equal(summary.hasSubscription('accepted/anyway'), true);
  });

  test('候选占用超过重建预算时明确中止候选，已经接受的登记继续有效', () => {
    const summary = new CountingBloomSummary(OLD_CFG);
    for (let i = 0; i < 10; i++) {
      summary.register('s1', `budget/topic/${i}`);
    }

    summary.startRebuild(NEW_CFG, { batchSize: 2, topicBudget: 3 });
    let progress = summary.stepRebuild(); // 接受 2 个
    assert.equal(progress.accepted, 2);
    progress = summary.stepRebuild(); // 再接受 1 个，达到预算
    assert.equal(progress.accepted, 3);
    progress = summary.stepRebuild(); // 第 4 个主题将超预算 -> 中止
    assert.equal(progress.phase, 'aborted');
    assert.match(progress.abortReason ?? '', /topicBudget=3/);

    // 旧代次完好，全部登记仍有效
    assert.equal(summary.generationId, 0);
    for (let i = 0; i < 10; i++) {
      assert.equal(summary.hasSubscription(`budget/topic/${i}`), true);
    }
    assert.equal(summary.verifyCurrent(), true);
    assert.throws(() => summary.publishRebuild(), /候选已中止/);

    // 放弃中止的候选后可用更大预算重建成功
    summary.abortRebuild();
    summary.startRebuild(NEW_CFG, { batchSize: 5, topicBudget: 100 });
    runToDrained(summary);
    summary.publishRebuild();
    assert.equal(summary.generationId, 1);
    for (let i = 0; i < 10; i++) {
      assert.equal(summary.hasSubscription(`budget/topic/${i}`), true);
    }
  });

  test('重建期间新增主题使候选在 drain 阶段超预算：同样明确中止且不影响旧代次', () => {
    const summary = new CountingBloomSummary(OLD_CFG);
    summary.register('s1', 'only/topic');

    summary.startRebuild(NEW_CFG, { batchSize: 1, topicBudget: 1 });
    // 在 sweep 与 drain 之间塞入第二个有效主题
    summary.register('s1', 'late/topic');
    const progress = summary.stepRebuild();
    assert.equal(progress.phase, 'aborted');
    assert.match(progress.abortReason ?? '', /topicBudget=1/);
    assert.equal(summary.hasSubscription('only/topic'), true);
    assert.equal(summary.hasSubscription('late/topic'), true);
    assert.equal(summary.verifyCurrent(), true);
  });

  test('完成切换后释放旧向量：旧代次配置与槽位不再可访问，新代次计数对照参考向量', () => {
    const summary = new CountingBloomSummary(OLD_CFG);
    for (let i = 0; i < 5; i++) {
      summary.register('s1', `gc/${i}`);
    }
    const oldVectorSnapshot = Array.from(summary.snapshotVector());
    assert.equal(oldVectorSnapshot.length, OLD_CFG.size);

    summary.startRebuild(NEW_CFG, { batchSize: 2 });
    runToDrained(summary);
    const info = summary.publishRebuild();

    assert.equal(info.config.size, NEW_CFG.size);
    const nextVector = summary.snapshotVector();
    assert.equal(nextVector.length, NEW_CFG.size, '查询面向新容量向量');
    assert.equal(summary.verifyCurrent(), true);

    // 旧代次已不可恢复：候选/重建接口全部失效，代次编号已前进
    assert.equal(summary.getRebuildProgress(), null);
    assert.equal(summary.generationId, 1);
  });

  test('无有效主题时重建：发布得到与直接重建一致的零向量', () => {
    const summary = new CountingBloomSummary(OLD_CFG);
    summary.register('s1', 'temp');
    summary.unregister('s1', 'temp');
    assert.equal(summary.hasActiveTopics, false);

    summary.startRebuild(NEW_CFG);
    runToDrained(summary);
    summary.publishRebuild();

    const vector = summary.snapshotVector();
    assert.equal(vector.length, NEW_CFG.size);
    for (const v of vector) {
      assert.equal(v, 0);
    }
    assert.deepEqual(Array.from(vector), Array.from(summary.buildReferenceVector()));
  });

  test('非法配置与非法重建状态被明确拒绝', () => {
    assert.throws(() => new CountingBloomSummary({ size: 0, hashes: 2, seed: 1 }), /正整数/);
    assert.throws(() => new CountingBloomSummary({ size: 8, hashes: -1, seed: 1 }), /正整数/);

    const summary = new CountingBloomSummary(OLD_CFG);
    summary.register('s1', 'x');
    summary.startRebuild(NEW_CFG);
    assert.throws(() => summary.startRebuild(NEW_CFG), /已有进行中的重建/);
    assert.throws(() => summary.resumeRebuild(), /不处于暂停/);
  });

  test('连续多代次重建：每次发布后新代次都与参考向量逐项一致，代次编号递增', () => {
    const summary = new CountingBloomSummary(OLD_CFG);
    const configs: BloomConfig[] = [
      { size: 64, hashes: 4, seed: 11 },
      { size: 256, hashes: 6, seed: 22 },
      { size: 16, hashes: 2, seed: 33 },
    ];

    for (let round = 0; round < configs.length; round++) {
      // 每代之间也持续发生登记/撤销
      summary.register(`s${round}`, `round/${round}/topic`);
      if (round > 0) {
        summary.unregister(`s${round - 1}`, `round/${round - 1}/topic`);
      }

      summary.startRebuild(configs[round], { batchSize: 3 });
      runToDrained(summary);
      const info = summary.publishRebuild();

      assert.equal(info.generation, round + 1);
      assert.deepEqual(summary.config, configs[round]);
      assert.equal(summary.verifyCurrent(), true, `第 ${round + 1} 代向量与参考向量不一致`);
      assert.equal(summary.snapshotVector().length, configs[round].size);
    }

    assert.equal(summary.generationId, 3);
    assert.equal(summary.hasSubscription('round/2/topic'), true);
    assert.equal(summary.hasSubscription('round/0/topic'), false);
    assert.equal(summary.verifyCurrent(), true);
  });
});
