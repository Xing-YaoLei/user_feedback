import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { Coordinator } from '../src/coordinator.ts';
import { SimulatedClient } from '../src/client.ts';
import { QuotaNode } from '../src/node.ts';
import { SimulatedNetwork, mulberry32 } from '../src/network.ts';
import { checkBudget } from '../src/sim.ts';

const WINDOW = 800;
const SKEW = 10;
const G = 60;
const T = { A: 30, B: 25, C: 20 };

interface Tracked<X> {
  done: boolean;
  value?: X;
}

async function run(seed: number): Promise<void> {
  const random = mulberry32(seed);
  const clk = new ManualClock(0);
  const coord = new Coordinator({
    clock: clk,
    windowMs: WINDOW,
    skewMs: SKEW,
    globalLimitPerWindow: G,
    tenantLimitsPerWindow: T,
    leaseTtlMs: 250,
  });
  const net = new SimulatedNetwork({
    coordinator: coord,
    trueClock: clk,
    policy: {
      latencyMs: () => 1 + Math.floor(random() * 25),
      copies: () => (random() < 0.3 ? 2 : 1),
      drop: () => random() < 0.12,
    },
  });
  const names = ['a', 'b', 'c', 'd', 'e'];
  const nodes = names.map((id, i) => {
    const node = new QuotaNode({
      nodeId: id,
      clock: net.clockFor(id, Math.floor(random() * 21) - 10),
      skewMs: SKEW,
      borrowAmount: 15,
      tenantId: ['A', 'B', 'C', 'A', 'B'][i]!,
    });
    const client = new SimulatedClient(net, node);
    net.registerNode(client);
    return { node, client };
  });
  const drain = () => new Promise<void>((r) => setImmediate(r));
  const track = <X>(p: Promise<X>): Tracked<X> => {
    const s: Tracked<X> = { done: false };
    p.then(
      (v) => {
        s.done = true;
        s.value = v;
      },
      () => {
        s.done = true;
      },
    );
    return s;
  };
  const settle = async <X>(s: Tracked<X>, budget: number): Promise<X | undefined> => {
    const d = net.now + budget;
    await drain();
    while (!s.done && net.now < d) {
      net.advanceBy(1);
      await drain();
    }
    return s.value;
  };
  let rid = 0;
  for (let r = 0; r < 120; r += 1) {
    for (const { node } of nodes) {
      if (random() < 0.1) {
        if (net.isOffline(node.nodeId)) net.heal(node.nodeId);
        else net.partition(node.nodeId);
      }
    }
    const t = nodes[Math.floor(random() * nodes.length)]!;
    const roll = random();
    if (roll < 0.32) {
      rid += 1;
      const id = `${t.node.nodeId}-${rid}`;
      const amt = [5, 10, 15][Math.floor(random() * 3)]!;
      const s = track(t.node.borrow(t.client, id, amt));
      await settle(s, 50);
      if (!s.done) {
        const s2 = track(t.node.borrow(t.client, id, amt));
        await settle(s2, 70);
      }
    } else if (roll < 0.7) {
      t.node.tryAdmit(1 + Math.floor(random() * 4));
    } else if (roll < 0.9) {
      const intent = t.node.prepareReturn(`ret-${t.node.nodeId}-${r}`);
      if (intent) {
        const s = track(t.node.submitReturn(t.client, intent));
        await settle(s, 60);
        if (!s.done) {
          const s2 = track(t.node.submitReturn(t.client, intent));
          await settle(s2, 80);
        }
      }
    } else {
      t.node.reboot();
      const s = track(t.node.replayReturns(t.client));
      await settle(s, 60);
    }
    if (random() < 0.4) net.advanceBy(5 + Math.floor(random() * 50));
    await drain();
  }
  for (let i = 0; i < 40; i += 1) {
    net.advanceBy(15);
    await drain();
  }
  const admissions = nodes.flatMap(({ node }) =>
    node.allAdmissions().map((x) => ({ ...x, nodeId: node.nodeId })),
  );
  const bw = new Map<number, { total: number; tenants: Record<string, number> }>();
  for (const a of admissions) {
    const b = bw.get(a.windowIndex) ?? { total: 0, tenants: {} };
    bw.set(a.windowIndex, b);
    b.total += a.cost;
    b.tenants[a.tenantId] = (b.tenants[a.tenantId] ?? 0) + a.cost;
  }
  assert.deepEqual(
    checkBudget(
      {
        admissions,
        windows: [...bw.entries()].map(([windowIndex, b]) => ({
          windowIndex,
          total: b.total,
          tenants: b.tenants,
          entries: 0,
        })),
      },
      { globalLimitPerWindow: G, tenantLimitsPerWindow: T },
    ),
    [],
    `seed ${seed}`,
  );
  for (const lid of coord.leaseIds()) {
    const s = coord.leaseSummary(lid)!;
    assert.ok(s.reportedConsumed + s.creditedReturns <= s.amount, `seed ${seed} lease ${lid}`);
    assert.ok(s.outstanding >= 0, `seed ${seed} lease ${lid} outstanding`);
  }
  for (const w of coord.knownWindows()) {
    const snap = coord.windowSnapshot(w);
    assert.ok(snap.globalReserved <= G, `seed ${seed} w${w} reserved ${snap.globalReserved}`);
    assert.ok(snap.globalConsumed <= snap.globalReserved, `seed ${seed} w${w} consumed`);
    assert.ok(snap.globalAvailable >= 0, `seed ${seed} w${w} available`);
    for (const [ten, res] of Object.entries(snap.tenantReserved)) {
      assert.ok(res <= T[ten as keyof typeof T], `seed ${seed} w${w} t${ten} ${res}`);
    }
  }
}

test('extended fuzz across many seeds', async () => {
  for (const seed of [101, 202, 303, 404, 505, 606, 707, 808, 909, 1010]) {
    await run(seed);
  }
});
