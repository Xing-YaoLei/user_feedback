/**
 * Local demo: two concurrent calls hit adjacent shards whose owners advertise
 * different generations, then one call is bounced through a temporary hint.
 *
 * Run with `npm run demo`.
 */

import {
  Router,
  RoutingClient,
  type TransportAdapter,
  type TransportRequest,
  type TransportResponse,
} from './index.ts';

const calls: string[] = [];
const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });

/** A tiny in-process adapter; no network or external services involved. */
const transport: TransportAdapter = {
  async send(request: TransportRequest): Promise<TransportResponse> {
    const label = `${request.address}@${String(request.generation)}`;
    calls.push(`${label} <- key ${request.key}`);

    switch (request.address) {
      case 'seed:0':
        // Two disjoint ranges advertise different generations.
        return request.key < 1_000_000
          ? {
              kind: 'redirect',
              hint: {
                kind: 'permanent',
                start: 0,
                end: 1_000_000,
                address: 'shard-low:1',
                generation: 3,
              },
            }
          : {
              kind: 'redirect',
              hint: {
                kind: 'permanent',
                start: 1_000_000,
                end: 2_000_000,
                address: 'shard-high:1',
                generation: 7,
              },
            };
      case 'shard-low:1':
        return { kind: 'redirect', hint: { kind: 'temporary', address: 'shard-low:2' } };
      case 'shard-low:2':
        return { kind: 'ok', value: `low(${String(request.payload)})` };
      case 'shard-high:1':
        return { kind: 'ok', value: `high(${String(request.payload)})` };
      default:
        throw new Error(`unexpected address ${request.address}`);
    }
  },
};

const client = new RoutingClient({ router, transport, maxAttempts: 6, deadlineMs: 1000 });

const [low, high] = await Promise.all([
  client.call(10, 'alpha'),
  client.call(1_500_000, 'beta'),
]);

console.log('low  ->', JSON.stringify(low, null, 2));
console.log('high ->', JSON.stringify(high, null, 2));

console.log('\ntransport order:');
for (const line of calls) console.log(' ', line);

console.log('\nrouter after calls:');
for (const segment of router.snapshot()) {
  console.log(
    `  [${segment.start}, ${segment.end}) -> ${segment.address}@${segment.generation}`,
  );
}
