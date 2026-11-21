import { Federation } from '../src/federation.ts';
import { RING_DOMAINS, RING_EDGES } from './helpers.ts';

const fed = new Federation({ seed: 41 });
for (const id of RING_DOMAINS) fed.addDomain(id);
for (const e of RING_EDGES) fed.connect(e.a, e.b, e.cost);
fed.domain('A').addOwnedDestination('d');
fed.runUntilIdle();
const before = fed.trace.all().length;
fed.bringDown('D', 'E');
fed.runUntilIdle();
fed.bringUp('D', 'E');
fed.runUntilIdle();
console.log('E after up:', fed.domain('E').getSelected('d')?.fullPath);
for (const e of fed.trace.all().slice(before)) {
  if (e.domain === 'E' || e.domain === 'D') {
    console.log(e.time, e.domain, e.type, e.peer ?? '', e.destination ?? '', e.reason ?? '');
  }
}
