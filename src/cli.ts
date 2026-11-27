/**
 * End-to-end demo of the discovery-view synthesis module.
 *
 * Runs entirely on synthetic data with a caller-supplied clock. No network,
 * no filesystem, no environment variables.
 *
 *   npm start
 */

import { DiscoverySynthesizer } from "./index.ts";
import type { Receipt } from "./types.ts";

const TTL = 30_000;

function value(payload: unknown) {
  return { kind: "value" as const, value: payload };
}

const TOMBSTONE = { kind: "tombstone" as const };

function snapshot(
  sourceId: string,
  generation: number,
  sequence: number,
  records: Record<string, Record<string, unknown>>,
): Receipt {
  const nested = new Map<string, Map<string, never>>();
  for (const [service, byInstance] of Object.entries(records)) {
    nested.set(service, new Map(Object.entries(byInstance)) as Map<string, never>);
  }
  return {
    receivedAt: 0,
    update: {
      kind: "snapshot",
      sourceId,
      generation,
      sequence,
      ttlMs: TTL,
      records: nested as never,
    },
  };
}

function delta(
  sourceId: string,
  generation: number,
  sequence: number,
  serviceId: string,
  instanceId: string,
  record: unknown,
): Receipt {
  return {
    receivedAt: 0,
    update: {
      kind: "delta",
      sourceId,
      generation,
      sequence,
      ttlMs: TTL,
      serviceId,
      instanceId,
      record: record as never,
    },
  };
}

const synth = new DiscoverySynthesizer({
  sources: [
    { sourceId: "primary", priority: 0 },
    { sourceId: "fallback", priority: 10 },
  ],
});

const primarySnapshot = snapshot("primary", 1, 0, {
  checkout: {
    "i-1": value({ host: "10.0.0.1", zone: "a" }),
    "i-2": value({ host: "10.0.0.2", zone: "b" }),
  },
});
const fallbackSnapshot = snapshot("fallback", 1, 0, {
  checkout: {
    "i-1": value({ host: "10.0.0.9", zone: "z" }),
    "i-2": value({ host: "10.0.0.8", zone: "z" }),
  },
});

function applyAt(receipt: Receipt, receivedAt: number): Receipt {
  return { ...receipt, receivedAt };
}

function show(label: string, now: number): void {
  const view = synth.query(now);
  console.log(`\n=== ${label} (t=${now}) ===`);
  for (const entry of view.instances) {
    if (entry.state === "available") {
      const value = entry.value as { host?: string };
      console.log(
        `  ${entry.serviceId}/${entry.instanceId}: available host=${value.host} ` +
          `from ${entry.source.sourceId} (gen ${entry.source.generation} seq ${entry.source.sequence})`,
      );
    } else if (entry.state === "deleted") {
      console.log(
        `  ${entry.serviceId}/${entry.instanceId}: deleted by ${entry.source.sourceId} ` +
          `(gen ${entry.source.generation} seq ${entry.source.sequence})`,
      );
    } else {
      console.log(`  ${entry.serviceId}/${entry.instanceId}: absent`);
    }
    for (const shadow of entry.shadowed) {
      console.log(`      shadowed: ${shadow.sourceId} (${shadow.reason})`);
    }
  }
  for (const source of view.sources) {
    console.log(
      `  source ${source.sourceId}: usable=${source.usable} ` +
        `gen=${source.generation} seq=${source.sequence} ` +
        `issue=${source.issue?.reason ?? "none"}`,
    );
  }
}

// 1. Both sources publish. The primary wins.
synth.apply([
  applyAt(primarySnapshot, 1_000),
  applyAt(fallbackSnapshot, 1_000),
]);
show("both sources healthy, primary wins", 2_000);

// 2. The primary explicitly deletes i-2. The stale fallback must not resurrect it.
synth.apply([applyAt(delta("primary", 1, 1, "checkout", "i-2", TOMBSTONE), 3_000)]);
show("primary deleted i-2", 4_000);

// 3. The primary skips a sequence: its whole view is dropped.
synth.apply([applyAt(delta("primary", 1, 3, "checkout", "i-1", value({ host: "10.0.0.11" })), 5_000)]);
show("primary out of sync (gap), fallback answers", 6_000);

// 4. A fresh full snapshot rebuilds the primary view.
synth.apply([
  applyAt(
    snapshot("primary", 1, 10, {
      checkout: { "i-1": value({ host: "10.0.0.21", zone: "a" }) },
    }),
    7_000,
  ),
]);
show("primary recovered via snapshot", 8_000);

// 5. Everything lapses when the declared validity windows close.
show("both windows lapsed", 40_000);
