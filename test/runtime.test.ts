import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InterceptorRuntime } from '../src/index.ts';
import type {
  Interceptor,
  InterceptorContext,
  RequestOutcome,
} from '../src/index.ts';
import { delay, plainDelay } from './helpers.ts';

/**
 * 主场景（对应需求描述）：
 *
 * 根请求 A（root-a）：
 * - 递归发起经过同一套拦截器的子请求（重入自身）；
 * - 启动后续链路 next() 但遗漏 await，提前返回；
 * - 运行中途被取消，取消后停止接收新子请求；
 * - 已在途的后续链路在取消后迟到失败；
 * - 裸 setTimeout 在清理结束后才触发：迟到 next / 迟到 spawn / 迟到失败诊断。
 *
 * 根请求 B（root-b）：并发执行，持续输出响应流后正常结束，
 * 并在流终结后再次 end 验证单次终结与诊断。
 */

interface LogEvent {
  t: string;
  scope: string;
}

describe('拦截器运行模块：并发根请求主场景', () => {
  let events: LogEvent[];
  let log: (t: string, scope: string) => void;
  let captured: Record<string, InterceptorContext>;
  let childCtx: Record<string, InterceptorContext>;
  let runtime: InterceptorRuntime;
  let chain: Interceptor[];
  let outcomeA: RequestOutcome;
  let outcomeB: RequestOutcome;
  let childOutcomes: RequestOutcome[];
  let cancelController: AbortController;

  beforeEach(async () => {
    events = [];
    log = (t, scope) => events.push({ t, scope });
    captured = {};
    childCtx = {};
    childOutcomes = [];
    cancelController = new AbortController();

    chain = [
      // 第 0 层：通用入口，登记最先注册的清理动作。
      async (ctx, next) => {
        ctx.rootTag = `tag@${(ctx as any).kind ?? 'child'}`;
        ctx.deferCleanup(async () => {
          await delay(5);
          log('cleanup:L0', ctx.scopeId);
        });
        await next();
      },
      // 第 1 层：按根请求 kind 分化行为。
      async (ctx, next) => {
        if ((ctx as any).kind === 'A') {
          if (ctx.depth > 0) {
            // 子请求：重入自身，但深度守卫阻止无限递归。
            if ((ctx as any).which === 0) {
              ctx.deferCleanup(async () => {
                await delay(2);
                log('cleanup:child-L1', ctx.scopeId);
              });
            }
            await next();
            return;
          }

          // —— 根请求 A 的重入：并发发起两个兄弟子请求 ——
          // 注意：spawn 返回的 Promise 必须同步挂处理器，避免子请求清理失败时
          // 在 await 之前出现 unhandledRejection。
          const child1 = ctx
            .spawn({
              id: 'root-a>child0',
              init: (c) => {
                (c as any).which = 0;
                (c as any).ownMark = 'child0-view';
                c.sharedFromParent = (ctx as any).inherited;
                childCtx.child0 = c;
              },
            })
            .then(
              (o) => o,
              (e) => (e as { outcome: RequestOutcome }).outcome,
            );
          const child2 = ctx
            .spawn({
              id: 'root-a>child1',
              init: (c) => {
                (c as any).which = 1;
                (c as any).siblingMark = 'only-in-child1';
                childCtx.child1 = c;
              },
            })
            .then(
              (o) => o,
              (e) => (e as { outcome: RequestOutcome }).outcome,
            );
          childOutcomes.push(await child1);
          childOutcomes.push(await child2);

          // 响应开始输出（之后的业务失败必须以流错误结束）。
          ctx.response.write('chunk-a-0');

          // —— 遗漏 await：启动后续链路但不等待，插件提前返回 ——
          void next();

          // —— 游离定时器：作用域关闭之后才触发，全部走带原请求 ID 的诊断入口 ——
          setTimeout(() => {
            // 迟到的 next 调用
            void next().catch((err) => {
              ctx.reportDiagnostic('late-failure', '游离回调中的迟到 next 已失败', err);
            });
            // 迟到的子请求
            void ctx.spawn({ id: 'root-a>late-child' }).catch((err) => {
              ctx.reportDiagnostic('late-failure', '游离回调中的迟到子请求被拒绝', err);
            });
            // 迟到的业务失败（发生在作用域关闭之后）
            ctx.reportDiagnostic(
              'late-failure',
              '游离定时器在请求关闭后迟到失败',
              new Error('late boom'),
            );
          }, 150);
          return;
        }

        if ((ctx as any).kind === 'B') {
          captured.b = ctx;
          ctx.deferCleanup(() => log('cleanup:B-L1', ctx.scopeId));
          await next();
          return;
        }
        await next();
      },
      // 第 2 层：登记清理；A 链路有一个清理动作抛错（清理错误）。
      async (ctx, next) => {
        ctx.deferCleanup(async () => {
          await delay(2);
          if ((ctx as any).kind === 'A') {
            throw new Error(`cleanup failure @${ctx.scopeId}`);
          }
          log('cleanup:L2', ctx.scopeId);
        });
        await next();
      },
      // 第 3 层：业务工作层。
      async (ctx, _next, signal) => {
        const kind = (ctx as any).kind;
        if (kind === 'A' && ctx.depth === 0) {
          // 不响应取消的在途执行：取消后继续，直到迟到失败。
          await plainDelay(60);
          log('business-error', ctx.scopeId);
          throw new Error('A 的在途业务在取消后迟到失败');
        }
        if (kind === 'B') {
          ctx.response.write('chunk-b-0');
          await delay(30);
          ctx.response.write('chunk-b-1');
          await delay(30);
          ctx.response.end();
          log('stream-ended', ctx.scopeId);
          return;
        }
        // 子请求：快速完成的小工作（signal 已随取消传播，可观察到 aborted）。
        await delay(5);
      },
    ];

    runtime = new InterceptorRuntime(chain);

    const dispatchA = runtime
      .dispatch({
        id: 'root-a',
        signal: cancelController.signal,
        init: (ctx) => {
          (ctx as any).kind = 'A';
          (ctx as any).inherited = 'parent-value';
          captured.a = ctx;
        },
      })
      .catch((error) => {
        const outcome = (error as { outcome?: RequestOutcome }).outcome;
        assert.ok(outcome, '失败时应附带 outcome');
        return outcome!;
      });

    const dispatchB = runtime
      .dispatch({
        id: 'root-b',
        init: (ctx) => {
          (ctx as any).kind = 'B';
          (ctx as any).inherited = 'b-own-value';
        },
      })
      .catch((error) => (error as { outcome: RequestOutcome }).outcome);

    // t=30ms：取消 A（此时其 next 链路正在途、尚未失败）。
    setTimeout(() => cancelController.abort(new Error('外部取消')), 30);

    [outcomeA, outcomeB] = await Promise.all([dispatchA, dispatchB]);
    // 等游离定时器（t=150ms）触发完毕。
    await plainDelay(200);
  });

  test('两个根请求都完成了各自的清理（先子后父、逆注册顺序）', () => {
    assert.equal(captured.a.closed, true);
    assert.equal(captured.b.closed, true);
    // 根 A 自身注册了 L0、L2 两个清理（L1 的 child-L1 注册在子作用域）；L2 抛错但仍计入已执行。
    assert.equal(outcomeA.cleanupCount, 2, '根 A 的清理动作都应执行（含抛错的 L2）');
    assert.equal(outcomeB.cleanupCount, 3, '根 B 的 3 个清理动作都应执行');

    // 子作用域先于根作用域关闭。
    const childCloseIndex = events.findIndex(
      (e) => e.scope === 'root-a>child0' && e.t === 'cleanup:child-L1',
    );
    const rootL0Index = events.findIndex((e) => e.scope === 'root-a' && e.t === 'cleanup:L0');
    assert.ok(childCloseIndex >= 0 && rootL0Index > childCloseIndex, '先清理子作用域');

    // 根 A：L2 清理抛错（无成功事件），L0 注册最早、最后执行。
    assert.equal(
      events.findIndex((e) => e.scope === 'root-a' && e.t === 'cleanup:L2'),
      -1,
      'L2 清理抛错，不会记录成功事件',
    );
    const aL0 = events.findIndex((e) => e.scope === 'root-a' && e.t === 'cleanup:L0');
    assert.ok(aL0 >= 0);

    // 根 B 注册顺序 L0(seq0) → B-L1(seq1) → L2(seq2)，逆注册执行顺序为 L2 → B-L1 → L0。
    const bEvents = events.filter((e) => e.scope === 'root-b');
    const bL1 = bEvents.findIndex((e) => e.t === 'cleanup:B-L1');
    const bL2 = bEvents.findIndex((e) => e.t === 'cleanup:L2');
    const bL0 = bEvents.findIndex((e) => e.t === 'cleanup:L0');
    assert.ok(bL2 < bL1 && bL1 < bL0, '逆注册顺序：L2 → L1 → L0');
    // B 的流先终结，清理后进行。
    const bEnd = bEvents.findIndex((e) => e.t === 'stream-ended');
    assert.ok(bEnd >= 0 && bEnd < bL2, '仍在输出的响应流属于清理边界，先等流结束再清理');
  });

  test('上下文：子请求继承父级且拥有独立修改视图，兄弟与并发根之间隔离', () => {
    const c0 = childCtx.child0 as any;
    const c1 = childCtx.child1 as any;
    const a = captured.a as any;

    // 读穿透：子视图通过原型链读到父级字段。
    assert.equal(c0.inherited, 'parent-value');
    assert.equal(c1.inherited, 'parent-value');
    assert.equal(c0.kind, 'A', '子请求继承父上下文的 kind');
    // 写隔离：子视图上的自有字段不回写到父级。
    assert.equal(a.ownMark, undefined, '子视图写入对父级不可见');
    assert.equal(a.siblingMark, undefined);
    // 兄弟之间互不可见各自的写入。
    assert.equal(c0.siblingMark, undefined, '兄弟请求的修改视图相互隔离');
    assert.equal(c1.ownMark, undefined);
    assert.equal(c0.sharedFromParent, 'parent-value');
    // 原型链方向正确：子视图的原型是父视图。
    assert.equal(Object.getPrototypeOf(c0), a);
    assert.equal(Object.getPrototypeOf(c1), a);
    // 子请求保有自己的 scopeId，但 requestId 仍是原请求 ID。
    assert.equal(c0.scopeId, 'root-a>child0');
    assert.equal(c0.requestId, 'root-a');
    assert.equal(c1.depth, 1);

    // 并发根请求之间隔离：同名字段互不污染，原型链互不相干。
    const b = captured.b as any;
    assert.equal(b.inherited, 'b-own-value');
    assert.equal(a.inherited, 'parent-value');
    assert.notEqual(a.rootTag, b.rootTag);
    assert.equal(Object.getPrototypeOf(b), null, '根视图没有父原型');
    assert.equal(Object.getPrototypeOf(a), null);
  });

  test('遗漏 await 的后续链路仍被跟踪，取消后迟到失败被记为业务主错误', () => {
    assert.equal(outcomeA.status, 'aborted');
    assert.ok(outcomeA.mainError, '必须保留主错误');
    assert.equal(outcomeA.mainError.kind, 'business');
    assert.match(outcomeA.mainError.message, /迟到失败/);
    assert.equal(outcomeA.responseStarted, true);
    assert.equal(outcomeA.responseEnded, 'destroyed', '取消时仍在输出的流应被销毁');
    assert.equal(outcomeA.responseTerminationCount, 1);

    // 同一异常沿多层 next 传播只记录一次。
    const businessErrors = outcomeA.errors.filter((e) => e.kind === 'business');
    assert.equal(businessErrors.length, 1, '同一业务异常只能记录一次');
  });

  test('业务错误优先于清理错误，同类错误按作用域序号与注册序号稳定排序', () => {
    assert.ok(outcomeA.errors.length >= 2, '至少有 1 个业务错误和 1 个清理错误');
    assert.equal(outcomeA.errors[0].kind, 'business', '业务错误始终排在清理错误之前');
    const cleanupErrors = outcomeA.errors.filter((e) => e.kind === 'cleanup');
    assert.ok(cleanupErrors.length >= 1);
    for (const entry of cleanupErrors) {
      assert.match(entry.message, /cleanup failure/);
    }
    // 主错误 + 附加错误都被保留，且附加错误与排序结果一致。
    assert.equal(outcomeA.mainError!.message, outcomeA.errors[0].message);
    assert.deepEqual(
      outcomeA.additionalErrors.map((e) => e.message),
      outcomeA.errors.slice(1).map((e) => e.message),
    );
  });

  test('响应已开始输出后的失败以流错误语义终结，且终结只发生一次', () => {
    // B 正常结束后重复 end / write：迟到终结只记诊断，terminationCount 仍为 1。
    assert.equal(outcomeB.status, 'completed');
    assert.equal(outcomeB.responseStarted, true);
    assert.equal(outcomeB.responseEnded, 'end');
    assert.equal(outcomeB.responseTerminationCount, 1);

    assert.equal(captured.b.response.end(), false, '重复终结返回 false');
    assert.equal(captured.b.response.write('late'), false, '终结后写入被拒绝');
    assert.equal(captured.b.response.terminationCount, 1);

    const bDiags = runtime.getDiagnosticsFor('root-b');
    const lateEnds = bDiags.filter((d) => d.kind === 'late-stream-end');
    assert.ok(lateEnds.length >= 2, '重复 end 与终结后 write 都应产生诊断');
    for (const d of lateEnds) assert.equal(d.requestId, 'root-b');
  });

  test('迟到调用通过带原请求 ID 的诊断入口报告', () => {
    const aDiags = runtime.getDiagnosticsFor('root-a');
    const kinds = aDiags.map((d) => d.kind);
    assert.ok(kinds.includes('late-failure'), '应包含迟到失败');
    assert.ok(kinds.includes('late-next'), '应包含迟到 next 调用');
    assert.ok(kinds.includes('stream-destroyed-on-cleanup'));
    // 每一条诊断都带原请求 ID。
    for (const d of aDiags) {
      assert.equal(d.requestId, 'root-a');
      assert.equal(typeof d.at, 'number');
      assert.ok(d.message.length > 0);
    }
    // B 的诊断里绝不出现 A 的作用域（本次运行 B 正常完成，可能没有诊断）。
    for (const d of runtime.getDiagnosticsFor('root-b')) {
      assert.equal(d.requestId, 'root-b');
    }
    // 全局诊断入口同样可查询；本场景的迟到事件全部归属 root-a。
    const all = runtime.getDiagnostics();
    assert.ok(all.length >= aDiags.length);
    const requestIds = new Set(all.map((d) => d.requestId));
    assert.ok(requestIds.has('root-a'));
    assert.ok(![...requestIds].some((id) => id !== 'root-a' && id !== 'root-b'));
  });

  test('取消向下传播并停止接收新的子请求', async () => {
    assert.equal(captured.a.signal.aborted, true);
    // 取消后发起子请求：立即 AbortError，且不创建新作用域。
    await assert.rejects(
      () => captured.a.spawn({ id: 'root-a>after-cancel' }),
      (err: unknown) => err instanceof Error && err.name === 'AbortError',
    );
    // 关闭后的迟到 spawn 走诊断（游离定时器触发的那条）。
    const lateSpawnDiag = runtime
      .getDiagnosticsFor('root-a')
      .filter((d) => d.kind === 'late-failure')
      .find((d) => String(d.message).includes('子请求'));
    assert.ok(lateSpawnDiag, '迟到子请求应有诊断记录');
  });

  test('子请求结果：重入正常、兄弟隔离、清理错误被保留', () => {
    for (const child of childOutcomes) {
      assert.equal(child.requestId, 'root-a', '子请求保留原请求 ID');
      assert.equal(child.responseTerminationCount, child.responseStarted ? 1 : 0);
      assert.ok(child.cleanupCount >= 1, '子作用域完成了自己的清理');
    }
    // 两个子作用域的创建序号不同且有序。
    assert.ok(childOutcomes[0].scopeSeq < childOutcomes[1].scopeSeq);
    // 子作用域的清理错误（L2 抛错）被保留。
    const childWithCleanupError = childOutcomes.find((c) =>
      c.errors.some((e) => e.kind === 'cleanup' && /cleanup failure/.test(e.message)),
    );
    assert.ok(childWithCleanupError, '子作用域清理错误应被保留');
  });
});
