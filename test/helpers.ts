import { ManualClock } from '../src/clock.ts';
import { InMemoryInstanceAdapter } from '../src/adapter.ts';
import { ConfigReleaseController } from '../src/controller.ts';
import type { ConfigValue } from '../src/types.ts';

export type Harness = {
  clock: ManualClock;
  controller: ConfigReleaseController;
  adapters: Map<string, InMemoryInstanceAdapter>;
  adapter(instanceId: string): InMemoryInstanceAdapter;
  /** Every adapter starts healthy and reports after each install. */
  autoReport(options?: {
    seq?: (instanceId: string) => number;
    healthy?: (instanceId: string) => boolean;
  }): void;
  stopAutoReport(): void;
  runTo(endTime: number, stepMs?: number): void;
};

export type HarnessOptions = {
  instances: Record<string, ConfigValue>;
  start?: number;
};

/**
 * Builds a controller plus one in-memory adapter per named instance. Returns
 * helpers for the common choreography: auto-reporting identities, advancing
 * the clock and ticking.
 */
export function makeHarness(options: HarnessOptions): Harness {
  const clock = new ManualClock(options.start ?? 0);
  const controller = new ConfigReleaseController({ clock });
  const adapters = new Map<string, InMemoryInstanceAdapter>();
  let autoReportEnabled = false;
  let autoHealthy: (instanceId: string) => boolean = () => true;
  let autoSeq = new Map<string, number>();

  for (const [instanceId, initialConfig] of Object.entries(options.instances)) {
    const adapter = new InMemoryInstanceAdapter({
      instanceId,
      generation: 1,
      initialConfig,
      clock,
    });
    adapters.set(instanceId, adapter);
    controller.registerAdapter(adapter);
    adapter.setReceiptSink((receipt) => {
      controller.receiveReceipt(receipt);
      if (!autoReportEnabled) return;
      if (receipt.kind !== 'install' || !receipt.ok) return;
      const seq = (autoSeq.get(receipt.instanceId) ?? 0) + 1;
      autoSeq.set(receipt.instanceId, seq);
      const healthy = autoHealthy(receipt.instanceId);
      controller.reportHealth({
        instanceId: receipt.instanceId,
        generation: receipt.generation,
        installId: receipt.installId,
        seq,
        healthy,
      });
    });
  }

  return {
    clock,
    controller,
    adapters,
    adapter(instanceId) {
      const adapter = adapters.get(instanceId);
      if (!adapter) throw new Error(`no adapter for "${instanceId}"`);
      return adapter;
    },
    autoReport(opts = {}) {
      autoReportEnabled = true;
      autoHealthy = opts.healthy ?? (() => true);
      autoSeq = new Map();
    },
    stopAutoReport() {
      autoReportEnabled = false;
    },
    runTo(endTime, stepMs = 100) {
      while (clock.now() < endTime) {
        const step = Math.min(stepMs, endTime - clock.now());
        clock.advance(step);
        controller.tick();
      }
      if (clock.now() === endTime) controller.tick();
    },
  };
}

export const CANDIDATE: ConfigValue = { feature: { enabled: true, rollout: 25 } };
export const ORIGINAL: ConfigValue = { feature: { enabled: false, rollout: 0 } };
