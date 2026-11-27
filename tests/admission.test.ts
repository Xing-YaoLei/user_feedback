import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdmissionController,
  CancelledError,
  DeadlineExceededError,
} from '../src/index.ts';
import type { AdmissionConfig, RoundReport } from '../src/index.ts';

/** 可控单调时钟。 */
class FakeClock {
  private now = 0n;
  nowNs(): bigint {
    return this.now;
  }
  advance(ns: number | bigint): void {
    this.now += BigInt(ns);
  }
}

interface CallHandle<Req, Res> {
  req: Req;
  signal: AbortSignal;
  resolve: (value: Res) => void;
  reject: (err: unknown) => void;
}

/** 可控适配器：每次 execute 挂起，测试手动 resolve/reject。 */
function controllable<Req, Res>() {
  const calls: Array<CallHandle<Req, Res>> = [];
  const adapter = {
    calls,
    execute(req: Req, signal: AbortSignal): Promise<Res> {
      return new Promise<Res>((resolve, reject) => {
        calls.push({ req, signal, resolve, reject });
      });
    },
  };
  return adapter;
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(overrides: Partial<AdmissionConfig> = {}) {
  const clock = new FakeClock();
  const adapter = controllable<string, string>();
  const reports: RoundReport[] = [];
  const config: AdmissionConfig = {
    initialLimit: 2,
    minLimit: 1,
    maxLimit: 10,
    samplesPerRound: 2,
    baselineRounds: 3,
    tolerance: { num: 0, den: 1 },
    ...overrides,
  };
  const controller = new AdmissionController<string, string>(
    config,
    adapter,
    clock,
    (r) => reports.push(r),
  );
  return { clock, adapter, reports, controller };
}

test('p90 处于基线容忍内时上限加一，报告含样本/基线/上限/占用', async () => {
  const { clock, adapter, reports, controller } = setup();
  const p1 = controller.submit('a');
  const p2 = controller.submit('b');
  await flush();
  assert.equal(adapter.calls.length, 2);
  assert.equal(controller.snapshot().occupancy, 2);

  clock.advance(100);
  adapter.calls[0].resolve('ra');
  adapter.calls[1].resolve('rb');
  await flush();

  assert.equal(await p1, 'ra');
  assert.equal(await p2, 'rb');
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.deepEqual(r.samplesNs, [100n, 100n]);
  assert.equal(r.p90Ns, 100n);
  assert.equal(r.baselineNs, 100n);
  assert.equal(r.startLimit, 2);
  assert.equal(r.limit, 3);
  assert.equal(r.occupancy, 0);
  assert.equal(controller.snapshot().limit, 3);
});

test('延迟以整数纳秒计且最小记一', async () => {
  const { adapter, reports, controller } = setup();
  // 不推进时钟，起止差为 0，应记为 1ns。
  const p1 = controller.submit('a');
  const p2 = controller.submit('b');
  await flush();
  adapter.calls[0].resolve('x');
  adapter.calls[1].resolve('y');
  await flush();
  await p1;
  await p2;
  assert.deepEqual(reports[0].samplesNs, [1n, 1n]);
  assert.equal(reports[0].p90Ns, 1n);
  assert.equal(reports[0].baselineNs, 1n);
});

test('p90 取排序后向上取整的百分位', async () => {
  const { clock, adapter, reports, controller } = setup({
    initialLimit: 5,
    samplesPerRound: 5,
  });
  const ps = ['a', 'b', 'c', 'd', 'e'].map((r) => controller.submit(r));
  await flush();
  // 延迟分别为 10/20/30/40/50（按完成顺序）；每次完成后先让微任务结算再推进时钟。
  for (const i of [1, 3, 4, 2, 0]) {
    clock.advance(10);
    adapter.calls[i].resolve('ok');
    await flush();
  }
  await flush();
  await Promise.all(ps);
  // 排序后 [10,20,30,40,50]，ceil(0.9*5)=5 → 第 5 个。
  assert.equal(reports[0].p90Ns, 50n);
  assert.equal(reports[0].limit, 6); // 50 <= 50*(1+0) → +1
});

test('p90 超容忍时按起始上限*基线/p90 向下取整并夹在下限', async () => {
  const { clock, adapter, reports, controller } = setup({
    initialLimit: 4,
    minLimit: 2,
  });
  // 第 1 轮：建立基线 100，上限 4→5。
  const p1 = controller.submit('a');
  const p2 = controller.submit('b');
  await flush();
  clock.advance(100);
  adapter.calls[0].resolve('x');
  adapter.calls[1].resolve('x');
  await flush();
  await p1;
  await p2;
  assert.equal(reports[0].limit, 5);

  // 第 2 轮：p90=300 > 100 → floor(5*100/300)=1 → 夹到下限 2。
  const p3 = controller.submit('c');
  const p4 = controller.submit('d');
  await flush();
  clock.advance(100);
  adapter.calls[2].resolve('x');
  await flush();
  clock.advance(200);
  adapter.calls[3].resolve('x');
  await flush();
  await p3;
  await p4;
  assert.equal(reports[1].p90Ns, 300n);
  assert.equal(reports[1].baselineNs, 100n);
  assert.equal(reports[1].startLimit, 5);
  assert.equal(reports[1].limit, 2);
  assert.equal(controller.snapshot().limit, 2);
});

test('上限增加不超过 maxLimit', async () => {
  const { clock, adapter, reports, controller } = setup({
    initialLimit: 2,
    maxLimit: 2,
  });
  const p1 = controller.submit('a');
  const p2 = controller.submit('b');
  await flush();
  clock.advance(100);
  adapter.calls[0].resolve('x');
  adapter.calls[1].resolve('x');
  await flush();
  await p1;
  await p2;
  assert.equal(reports[0].limit, 2);
  assert.equal(controller.snapshot().limit, 2);
});

test('封轮后旧轮迟到结果只减少占用，不改变已封轮决议，也不进入新轮样本', async () => {
  const { clock, adapter, reports, controller } = setup({ initialLimit: 4 });
  const pa = controller.submit('a');
  const pb = controller.submit('b');
  const pc = controller.submit('c');
  const pd = controller.submit('d');
  await flush();
  assert.equal(adapter.calls.length, 4);
  assert.equal(controller.snapshot().openRoundId, 1);

  clock.advance(100);
  adapter.calls[0].resolve('x'); // a
  adapter.calls[1].resolve('x'); // b → 封第 1 轮
  await flush();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].limit, 5);
  assert.equal(reports[0].occupancy, 2); // c、d 仍在途
  assert.equal(controller.snapshot().occupancy, 2);

  // c 迟到完成（旧轮已封）：只减少占用。
  clock.advance(5000);
  adapter.calls[2].resolve('late');
  await flush();
  assert.equal(await pc, 'late');
  assert.equal(controller.snapshot().occupancy, 1);
  assert.equal(reports.length, 1); // 决议未被重新改变
  assert.equal(controller.snapshot().limit, 5);

  // e、f 绑定第 2 轮；样本不含 c 的 5100ns。
  const pe = controller.submit('e');
  const pf = controller.submit('f');
  await flush();
  assert.equal(controller.snapshot().openRoundId, 2);
  clock.advance(100);
  adapter.calls[4].resolve('x');
  adapter.calls[5].resolve('x');
  await flush();
  await pe;
  await pf;
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1].samplesNs, [100n, 100n]);
  assert.equal(reports[1].limit, 6);
  assert.equal(reports[1].occupancy, 1); // d 仍在途

  // d 失败：不占样本，只释放占用。
  const pdAssert = assert.rejects(pd, /boom/);
  adapter.calls[3].reject(new Error('boom'));
  await pdAssert;
  await pa;
  await pb;
  assert.equal(controller.snapshot().occupancy, 0);
  assert.equal(reports.length, 2);
});

test('缩容不取消在途调用，占用降到新上限以下才继续派发', async () => {
  const { clock, adapter, reports, controller } = setup({
    initialLimit: 3,
    minLimit: 1,
  });
  // 第 1 轮：基线 100，上限 3→4。
  const pa = controller.submit('a');
  const pb = controller.submit('b');
  await flush();
  clock.advance(100);
  adapter.calls[0].resolve('x');
  adapter.calls[1].resolve('x');
  await flush();
  await pa;
  await pb;
  assert.equal(reports[0].limit, 4);

  // 第 2 轮：c、d、e、f 进入执行（上限 4）。
  const pc = controller.submit('c');
  const pd = controller.submit('d');
  const pe = controller.submit('e');
  const pf = controller.submit('f');
  await flush();
  assert.equal(adapter.calls.length, 6);
  clock.advance(100);
  adapter.calls[2].resolve('x'); // c: 100ns
  await flush();
  clock.advance(800);
  adapter.calls[3].resolve('x'); // d: 900ns → p90=900 → floor(4*100/900)=0 → 夹到 1
  await flush();
  await pc;
  await pd;
  assert.equal(reports[1].limit, 1);
  assert.equal(controller.snapshot().limit, 1);
  // 在途的 e、f 未被取消。
  assert.equal(adapter.calls[4].signal.aborted, false);
  assert.equal(adapter.calls[5].signal.aborted, false);
  assert.equal(controller.snapshot().occupancy, 2);

  // g 排队：占用 2 >= 上限 1，不派发。
  const pg = controller.submit('g');
  await flush();
  assert.equal(adapter.calls.length, 6);

  // e 完成：占用 1，仍不小于 1，不派发。
  adapter.calls[4].resolve('x');
  await flush();
  await pe;
  assert.equal(controller.snapshot().occupancy, 1);
  assert.equal(adapter.calls.length, 6);

  // f 完成：占用 0 < 1，g 被派发，绑定第 3 轮。
  adapter.calls[5].resolve('x');
  await flush();
  await pf;
  assert.equal(controller.snapshot().occupancy, 1);
  assert.equal(adapter.calls.length, 7);
  assert.equal(adapter.calls[6].req, 'g');
  assert.equal(controller.snapshot().openRoundId, 3);
  // e、f 是第 2 轮的迟到完成，未产生新决议。
  assert.equal(reports.length, 2);

  clock.advance(50);
  adapter.calls[6].resolve('x');
  await flush();
  assert.equal(await pg, 'x');
});

test('等待按到达顺序派发，等待中可取消', async () => {
  const { clock, adapter, controller } = setup({ initialLimit: 1 });
  const pa = controller.submit('a');
  await flush();
  const ac = new AbortController();
  const pb = controller.submit('b', { signal: ac.signal });
  const pc = controller.submit('c');
  const pd = controller.submit('d');
  const pbAssert = assert.rejects(pb, CancelledError);
  await flush();
  assert.equal(controller.snapshot().waiting, 3);

  ac.abort();
  await pbAssert;
  assert.equal(controller.snapshot().waiting, 2);

  clock.advance(10);
  adapter.calls[0].resolve('x'); // a 完成 → c 先派发（FIFO，b 已取消）
  await flush();
  await pa;
  assert.equal(adapter.calls[1].req, 'c');

  clock.advance(10);
  adapter.calls[1].resolve('x'); // c 完成 → d 派发
  await flush();
  await pc;
  assert.equal(adapter.calls[2].req, 'd');

  clock.advance(10);
  adapter.calls[2].resolve('x');
  await flush();
  await pd;
});

test('等待有独立期限：逾期等待者在派发时被拒绝', async () => {
  const { clock, adapter, controller } = setup({ initialLimit: 1 });
  const pa = controller.submit('a');
  await flush();
  const pb = controller.submit('b', { deadlineNs: 50 });
  const pbAssert = assert.rejects(pb, DeadlineExceededError);
  await flush();

  clock.advance(100); // 超过 b 的期限
  adapter.calls[0].resolve('x');
  await flush();
  await pa;
  await pbAssert;
  assert.equal(adapter.calls.length, 1); // b 未被派发
  assert.equal(controller.snapshot().waiting, 0);
});

test('reapExpiredWaiters 主动回收逾期等待者', async () => {
  const { clock, adapter, controller } = setup({ initialLimit: 1 });
  const pa = controller.submit('a');
  await flush();
  const pb = controller.submit('b', { timeoutNs: 50 });
  const pc = controller.submit('c', { deadlineNs: 200 });
  const pbAssert = assert.rejects(pb, DeadlineExceededError);
  const pcAssert = assert.rejects(pc, DeadlineExceededError);
  await flush();

  clock.advance(100);
  assert.equal(controller.reapExpiredWaiters(), 1);
  await pbAssert;

  clock.advance(150);
  assert.equal(controller.reapExpiredWaiters(), 1);
  await pcAssert;

  adapter.calls[0].resolve('x');
  await flush();
  await pa;
  assert.equal(adapter.calls.length, 1);
});

test('执行中取消：调用方立即被拒绝，名额等适配器实际退出才归还', async () => {
  const { clock, adapter, reports, controller } = setup({
    initialLimit: 1,
    samplesPerRound: 1,
  });
  const ac = new AbortController();
  const pa = controller.submit('a', { signal: ac.signal });
  await flush();
  assert.equal(controller.snapshot().occupancy, 1);

  const paAssert = assert.rejects(pa, CancelledError);
  ac.abort();
  await paAssert;
  // 适配器尚未退出，名额仍被占用。
  assert.equal(controller.snapshot().occupancy, 1);

  // b 因占用未释放而无法派发。
  const pb = controller.submit('b');
  await flush();
  assert.equal(adapter.calls.length, 1);

  // 适配器实际退出 → 归还名额 → b 派发；a 的迟到成功不计样本。
  adapter.calls[0].resolve('late-success');
  await flush();
  assert.equal(controller.snapshot().occupancy, 1); // b 占用
  assert.equal(adapter.calls.length, 2);
  assert.equal(reports.length, 0);

  clock.advance(42);
  adapter.calls[1].resolve('rb');
  await flush();
  assert.equal(await pb, 'rb');
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].samplesNs, [42n]); // 只有 b 的样本
});

test('失败不作延迟样本，错误透传给调用方', async () => {
  const { clock, adapter, reports, controller } = setup();
  const pa = controller.submit('a');
  const pb = controller.submit('b');
  await flush();
  const paAssert = assert.rejects(pa, /boom/);
  adapter.calls[0].reject(new Error('boom'));
  await paAssert;
  await flush();
  assert.equal(controller.snapshot().occupancy, 1);

  // a 失败释放名额，c 补位；样本只来自 b、c。
  const pc = controller.submit('c');
  await flush();
  assert.equal(adapter.calls.length, 3);
  clock.advance(50);
  adapter.calls[1].resolve('x'); // b: 50
  await flush();
  clock.advance(50);
  adapter.calls[2].resolve('x'); // c: 100
  await flush();
  await pb;
  await pc;
  assert.deepEqual(reports[0].samplesNs, [50n, 100n]);
});

test('适配器同步崩溃：名额立即释放，调用方收到错误，后续请求照常', async () => {
  const clock = new FakeClock();
  const adapter = {
    execute(req: string): Promise<string> {
      if (req === 'boom') throw new Error('adapter crash');
      return Promise.resolve(`ok-${req}`);
    },
  };
  const controller = new AdmissionController<string, string>(
    {
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 4,
      samplesPerRound: 1,
      baselineRounds: 2,
      tolerance: { num: 0, den: 1 },
    },
    adapter,
    clock,
  );
  await assert.rejects(controller.submit('boom'), /adapter crash/);
  assert.equal(controller.snapshot().occupancy, 0);
  assert.equal(await controller.submit('fine'), 'ok-fine');
});

test('基线取含本轮在内最近 K 轮 p90 的最小值，旧轮被逐出窗口', async () => {
  const { clock, adapter, reports, controller } = setup({
    initialLimit: 1,
    maxLimit: 100,
    samplesPerRound: 1,
    baselineRounds: 2,
    tolerance: { num: 100, den: 1 }, // 容忍极大，始终 +1
  });
  // 第 1 轮 p90=100 → 基线 100。
  const p1 = controller.submit('a');
  await flush();
  clock.advance(100);
  adapter.calls[0].resolve('x');
  await flush();
  await p1;
  assert.equal(reports[0].baselineNs, 100n);

  // 第 2 轮 p90=200 → 基线 min(100,200)=100。
  const p2 = controller.submit('b');
  await flush();
  clock.advance(200);
  adapter.calls[1].resolve('x');
  await flush();
  await p2;
  assert.equal(reports[1].p90Ns, 200n);
  assert.equal(reports[1].baselineNs, 100n);

  // 第 3 轮 p90=150 → 窗口 [200,150]，基线 150（100 已逐出）。
  const p3 = controller.submit('c');
  await flush();
  clock.advance(150);
  adapter.calls[2].resolve('x');
  await flush();
  await p3;
  assert.equal(reports[2].p90Ns, 150n);
  assert.equal(reports[2].baselineNs, 150n);
});

test('容忍比例为非负有理数：边界取等判定精确', async () => {
  // 容忍 1/2：p90=150、基线=100 → 150*2 <= 100*3 成立 → +1。
  {
    const { clock, adapter, reports, controller } = setup({
      initialLimit: 5,
      tolerance: { num: 1, den: 2 },
    });
    const p1 = controller.submit('a');
    const p2 = controller.submit('b');
    await flush();
    clock.advance(100);
    adapter.calls[0].resolve('x');
    adapter.calls[1].resolve('x');
    await flush();
    await p1;
    await p2;
    assert.equal(reports[0].limit, 6);

    const p3 = controller.submit('c');
    const p4 = controller.submit('d');
    await flush();
    clock.advance(150);
    adapter.calls[2].resolve('x');
    adapter.calls[3].resolve('x');
    await flush();
    await p3;
    await p4;
    assert.equal(reports[1].p90Ns, 150n);
    assert.equal(reports[1].limit, 7); // 边界取等 → 增加
  }
  // p90=151 → 151*2=302 > 300 → 缩减 floor(6*100/151)=3。
  {
    const { clock, adapter, reports, controller } = setup({
      initialLimit: 5,
      tolerance: { num: 1, den: 2 },
    });
    const p1 = controller.submit('a');
    const p2 = controller.submit('b');
    await flush();
    clock.advance(100);
    adapter.calls[0].resolve('x');
    adapter.calls[1].resolve('x');
    await flush();
    await p1;
    await p2;
    assert.equal(reports[0].limit, 6);

    const p3 = controller.submit('c');
    const p4 = controller.submit('d');
    await flush();
    clock.advance(151);
    adapter.calls[2].resolve('x');
    adapter.calls[3].resolve('x');
    await flush();
    await p3;
    await p4;
    assert.equal(reports[1].p90Ns, 151n);
    assert.equal(reports[1].limit, 3); // floor(6*100/151)=3
  }
});

test('配置校验：非法参数抛出 TypeError', async () => {
  const adapter = controllable<string, string>();
  const clock = new FakeClock();
  const base: AdmissionConfig = {
    initialLimit: 2,
    minLimit: 1,
    maxLimit: 4,
    samplesPerRound: 2,
    baselineRounds: 2,
    tolerance: { num: 0, den: 1 },
  };
  const make = (c: AdmissionConfig) => () =>
    new AdmissionController<string, string>(c, adapter, clock);
  assert.throws(make({ ...base, tolerance: { num: 1, den: 0 } }), TypeError);
  assert.throws(make({ ...base, tolerance: { num: -1, den: 2 } }), TypeError);
  assert.throws(make({ ...base, tolerance: { num: 0.5, den: 1 } }), TypeError);
  assert.throws(make({ ...base, minLimit: 5, maxLimit: 4 }), TypeError);
  assert.throws(make({ ...base, initialLimit: 5 }), TypeError);
  assert.throws(make({ ...base, samplesPerRound: 0 }), TypeError);
  assert.throws(make({ ...base, baselineRounds: 0 }), TypeError);
});

test('提交前已取消或已逾期：立即拒绝，不占队列', async () => {
  const { clock, controller } = setup();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(controller.submit('x', { signal: ac.signal }), CancelledError);
  clock.advance(100);
  await assert.rejects(
    controller.submit('y', { deadlineNs: 50 }),
    DeadlineExceededError,
  );
  assert.equal(controller.snapshot().waiting, 0);
});
