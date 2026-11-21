import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InterceptorRuntime } from '../src/index.ts';
import type { Interceptor } from '../src/index.ts';
import { delay } from './helpers.ts';

describe('拦截器运行模块：单元语义', () => {
  test('每个 next 只允许调用一次，重复调用以 DoubleNextError 拒绝', async () => {
    const chain: Interceptor[] = [
      async (_ctx, next) => {
        await next();
        await assert.rejects(() => next(), (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.name, 'DoubleNextError');
          return true;
        });
      },
      async () => {},
    ];
    const runtime = new InterceptorRuntime(chain);
    const outcome = await runtime.dispatch({ id: 'r1' });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.errors.length, 0);
  });

  test('取消后立即停止接收新的子请求，已开始的子请求收到取消信号', async () => {
    const controller = new AbortController();
    let childSignalAborted = false;
    const chain: Interceptor[] = [
      async (ctx, next) => {
        if (ctx.depth === 0) {
          // 先启动一个子请求，随后父级取消。
          const child = ctx.spawn({
            id: 'r2>child',
            init: () => {},
          });
          controller.abort(new Error('cancel r2'));
          // 取消后的新子请求立即拒绝。
          await assert.rejects(
            () => ctx.spawn({ id: 'r2>rejected' }),
            (err: unknown) => err instanceof Error && err.name === 'AbortError',
          );
          await child.catch(() => {});
          await next();
        }
      },
      async (ctx) => {
        childSignalAborted = ctx.signal.aborted;
        // 已经开始的执行退出：等待一个可打断的延迟。
        await delay(20, ctx.signal).catch(() => {});
      },
    ];
    const runtime = new InterceptorRuntime(chain);
    const outcome = await runtime
      .dispatch({ id: 'r2', signal: controller.signal })
      .catch((e) => e.outcome);
    assert.equal(outcome.status, 'cancelled');
    assert.equal(childSignalAborted, true, '取消向下传播到子请求');
    // 没有创建被拒绝的那个作用域。
    assert.ok(!runtime.getDiagnostics().some((d) => d.scopeId === 'r2>rejected'));
  });

  test('响应开始输出后业务失败：以流错误终结并保留清理诊断，清理仍按序执行', async () => {
    const order: string[] = [];
    const chain: Interceptor[] = [
      async (ctx, next) => {
        ctx.deferCleanup(() => order.push('L0-cleanup'));
        await next();
      },
      async (ctx) => {
        ctx.deferCleanup(() => order.push('L1-cleanup'));
        ctx.response.write('started');
        await delay(5);
        throw new Error('after-headers boom');
      },
    ];
    const runtime = new InterceptorRuntime(chain);
    const outcome = await runtime
      .dispatch({ id: 'r3' })
      .catch((e) => e.outcome);

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.responseStarted, true);
    assert.equal(outcome.responseTerminationCount, 1);
    assert.equal(outcome.mainError.kind, 'business');
    assert.match(outcome.mainError.message, /after-headers/);
    // 失败后清理仍然执行，逆注册顺序。
    assert.deepEqual(order, ['L1-cleanup', 'L0-cleanup']);
  });

  test('插件提前返回不 await next，在途执行仍被跟踪并参与清理边界', async () => {
    const order: string[] = [];
    const chain: Interceptor[] = [
      async (ctx, next) => {
        ctx.deferCleanup(() => order.push('cleanup'));
        void next(); // 故意遗漏 await
        order.push('plugin-return');
      },
      async () => {
        await delay(20);
        order.push('downstream-done');
      },
    ];
    const runtime = new InterceptorRuntime(chain);
    const outcome = await runtime.dispatch({ id: 'r4' });
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(order, ['plugin-return', 'downstream-done', 'cleanup']);
  });

  test('同一异常沿多层 next 传播只记录一次', async () => {
    const boom = new Error('same instance');
    const chain: Interceptor[] = [
      async (_ctx, next) => {
        try {
          await next();
        } catch (err) {
          // 重新抛出同一个对象引用。
          throw err;
        }
      },
      async (_ctx, next) => {
        await next();
      },
      async () => {
        throw boom;
      },
    ];
    const runtime = new InterceptorRuntime(chain);
    const outcome = await runtime
      .dispatch({ id: 'r5' })
      .catch((e) => e.outcome);
    assert.equal(outcome.errors.length, 1);
    assert.equal(outcome.errors[0].error, boom);
    assert.equal(outcome.mainError.error, boom);
    assert.equal(outcome.additionalErrors.length, 0);
  });

  test('多个并发根请求的上下文与错误集合完全隔离', async () => {
    const chain: Interceptor[] = [
      async (ctx, next) => {
        ctx.visited = (ctx as any).rootInput;
        await next();
      },
      async (ctx) => {
        if ((ctx as any).rootInput === 'fail') throw new Error('only-r6-fails');
      },
    ];
    const runtime = new InterceptorRuntime(chain);
    const [o6, o7] = await Promise.all([
      runtime
        .dispatch({ id: 'r6', init: (c) => ((c as any).rootInput = 'fail') })
        .catch((e) => e.outcome),
      runtime
        .dispatch({ id: 'r7', init: (c) => ((c as any).rootInput = 'ok') })
        .catch((e) => e.outcome),
    ]);
    assert.equal(o6.status, 'failed');
    assert.equal(o7.status, 'completed');
    assert.equal(o6.errors.length, 1);
    assert.equal(o7.errors.length, 0);
    assert.deepEqual(runtime.getDiagnosticsFor('r6'), []);
    assert.deepEqual(runtime.getDiagnosticsFor('r7'), []);
  });

  test('关闭后迟到登记清理动作被拒绝并产生带原请求 ID 的诊断', async () => {
    let savedCtx: any;
    const chain: Interceptor[] = [
      async (ctx) => {
        savedCtx = ctx;
      },
    ];
    const runtime = new InterceptorRuntime(chain);
    const outcome = await runtime.dispatch({ id: 'r8' });
    assert.equal(outcome.status, 'completed');
    assert.equal(savedCtx.closed, true);
    // 关闭后再登记：返回注销句柄但不会执行，且产生诊断。
    let ran = false;
    const unregister = savedCtx.deferCleanup(() => {
      ran = true;
    });
    assert.equal(typeof unregister, 'function');
    assert.equal(ran, false);
    const diags = runtime.getDiagnosticsFor('r8');
    assert.equal(diags.length, 1);
    assert.equal(diags[0].kind, 'late-cleanup');
    assert.equal(diags[0].requestId, 'r8');
  });

  test('深层嵌套子作用域：先清理深层子作用域，再逐层向上，请求 ID 保持不变', async () => {
    const order: string[] = [];
    const chain: Interceptor[] = [
      async (ctx, next) => {
        ctx.deferCleanup(() => order.push(`cleanup:${ctx.scopeId}`));
        if (ctx.depth === 0) {
          await ctx.spawn({ id: 'r9>c1' });
        } else if (ctx.depth === 1) {
          await ctx.spawn({ id: 'r9>c1>c2' });
        }
        await next();
      },
    ];
    const runtime = new InterceptorRuntime(chain);
    const outcome = await runtime.dispatch({ id: 'r9' });
    assert.equal(outcome.status, 'completed');
    // 最深层先清理，逐层向上。
    assert.deepEqual(order, ['cleanup:r9>c1>c2', 'cleanup:r9>c1', 'cleanup:r9']);
    // 全部作用域共享原请求 ID。
    for (const d of runtime.getDiagnosticsFor('r9')) assert.equal(d.requestId, 'r9');
  });

  test('多个清理错误按清理注册序号稳定排序，且全部作为附加错误保留', async () => {
    const chain: Interceptor[] = [
      async (ctx) => {
        ctx.deferCleanup(() => {
          throw new Error('cleanup-registered-first');
        });
        ctx.deferCleanup(() => {
          throw new Error('cleanup-registered-second');
        });
        ctx.deferCleanup(() => {
          throw new Error('cleanup-registered-third');
        });
      },
    ];
    const runtime = new InterceptorRuntime(chain);
    const outcome = await runtime
      .dispatch({ id: 'r10' })
      .catch((e) => e.outcome);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.errors.length, 3);
    // 逆注册顺序执行，但错误集合按注册序号（seq 升序）稳定排序。
    assert.deepEqual(
      outcome.errors.map((e) => e.message),
      [
        'cleanup-registered-first',
        'cleanup-registered-second',
        'cleanup-registered-third',
      ],
    );
    assert.equal(outcome.mainError.message, 'cleanup-registered-first');
    assert.equal(outcome.additionalErrors.length, 2);
  });
});
