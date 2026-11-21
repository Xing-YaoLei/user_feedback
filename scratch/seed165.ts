import { MigrationPlanner } from '../src/index.ts';

const brokers = [
  { id: 'b0_0', capacity: 1, faultDomain: 'd0' },
  { id: 'b1_0', capacity: 2, faultDomain: 'd1' },
  { id: 'b1_1', capacity: 3, faultDomain: 'd1' },
  { id: 'b2_0', capacity: 3, faultDomain: 'd2' },
  { id: 'b2_1', capacity: 2, faultDomain: 'd2' },
];
const planner = new MigrationPlanner({
  brokers,
  partitionIds: ['p0', 'p1'],
  target: { p0: ['b2_0'], p1: ['b0_0', 'b1_0', 'b2_1'] },
  initial: { p0: ['b0_0'], p1: [] },
});
for (let i = 0; i < 25 && !planner.isConverged(); i++) {
  const a = planner.nextActions();
  console.log(i, JSON.stringify(a));
  if (a.length === 0) {
    console.log('blocked', JSON.stringify(planner.blockedReport()));
    break;
  }
  for (const x of a) planner.applyAction(x);
}
console.log('converged', planner.isConverged());

