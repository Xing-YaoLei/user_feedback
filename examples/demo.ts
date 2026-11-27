/**
 * 演示：合成一个"延迟随并发上升"的服务，观察准入控制器逐轮调整并发上限。
 * 运行：npm run demo
 */
import { AdmissionController, systemClock } from '../src/index.ts';
import type { RoundReport } from '../src/index.ts';

let active = 0;
const adapter = {
  async execute(req: number, signal: AbortSignal): Promise<string> {
    active++;
    try {
      // 合成延迟：基础 20ms + 每个并发 15ms 拥塞 + 确定性抖动。
      const delayMs = 20 + active * 15 + ((req * 37) % 11);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (req % 19 === 0) throw new Error(`simulated failure for req ${req}`);
      return `ok-${req}`;
    } finally {
      active--;
    }
  },
};

const fmt = (ns: bigint) => `${(Number(ns) / 1e6).toFixed(1)}ms`;

const controller = new AdmissionController<number, string>(
  {
    initialLimit: 2,
    minLimit: 1,
    maxLimit: 8,
    samplesPerRound: 6,
    baselineRounds: 3,
    tolerance: { num: 1, den: 4 }, // 容忍 25%
  },
  adapter,
  systemClock,
  (r: RoundReport) => {
    console.log(
      `round ${r.roundId}: samples=[${r.samplesNs.map(fmt).join(', ')}] ` +
        `p90=${fmt(r.p90Ns)} baseline=${fmt(r.baselineNs)} ` +
        `limit ${r.startLimit} -> ${r.limit} occupancy=${r.occupancy} waiting=${r.waiting}`,
    );
  },
);

const tasks: Promise<void>[] = [];
for (let i = 0; i < 60; i++) {
  tasks.push(
    controller
      .submit(i, { timeoutNs: 30_000_000_000 })
      .then(() => {})
      .catch((err: unknown) => {
        console.log(`req ${i} failed: ${(err as Error).message}`);
      }),
  );
  await new Promise((r) => setTimeout(r, 5));
}
await Promise.all(tasks);
console.log('final snapshot:', controller.snapshot());
