/** 测试辅助工具。 */

/** 可被取消信号打断的延迟；信号 abort 时以 AbortError reject。 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('已取消');
      err.name = 'AbortError';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 不可被取消打断的延迟（模拟游离的定时器回调）。 */
export function plainDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 spawn 的拒绝中取回完整 outcome。 */
export async function outcomeOf(spawnPromise: Promise<unknown>): Promise<any> {
  try {
    return await spawnPromise;
  } catch (error) {
    const outcome = (error as { outcome?: unknown }).outcome;
    if (!outcome) throw error;
    return outcome;
  }
}
