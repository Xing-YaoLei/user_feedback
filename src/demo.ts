/**
 * Runnable demo: a small cross-service negotiation plus its diagnostics.
 *
 *   npm run demo
 */

import { negotiate, NegotiationSession } from './index.ts';

function line(title: string): void {
  console.log(`\n=== ${title} ===`);
}

line('Successful negotiation');
{
  const outcome = negotiate(
    [
      {
        partyId: 'media-core',
        offerVersion: '2026.1',
        protocolVersions: ['rtp/2', 'rtp/3'],
        supportedFeatures: ['audio', 'video', 'hdr'],
        requiredFeatures: ['audio'],
      },
      {
        partyId: 'edge-relay',
        offerVersion: 'edge-7',
        protocolVersions: ['rtp/3'],
        supportedFeatures: ['audio', 'video', 'hdr'],
        constraints: [
          {
            id: 'bandwidth-cap',
            description: 'HDR is only allowed together with the low-latency profile',
            expr: {
              op: 'or',
              args: [
                { op: 'not', arg: { op: 'feature', feature: 'hdr' } },
                { op: 'feature', feature: 'low-latency' },
              ],
            },
          },
        ],
      },
      {
        partyId: 'client-sdk',
        offerVersion: 'sdk-3.2',
        protocolVersions: ['rtp/2', 'rtp/3'],
        supportedFeatures: ['audio', 'video', 'hdr', 'low-latency'],
      },
    ],
    { audio: 1, video: 4, hdr: 6, 'low-latency': 5 },
  );
  if (outcome.status === 'success') {
    console.log('protocol   :', outcome.protocolVersion);
    console.log('features   :', outcome.features.join(', '));
    console.log('total gain :', outcome.totalBenefit);
    console.log('explored   :', outcome.search.explored, 'nodes');
    console.log('bindings   :', outcome.offerVersions);
    for (const party of outcome.parties) {
      console.log(
        `  ${party.partyId.padEnd(12)} v${party.offerVersion}  checks:`,
        JSON.stringify(party.checks.constraints.length),
      );
    }
  }
}

line('Unsatisfiable negotiation with a minimal core');
{
  const outcome = negotiate(
    [
      { partyId: 'alpha', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: ['x', 'y'], requiredFeatures: ['x'] },
      { partyId: 'beta', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: ['x', 'y'], requiredFeatures: ['y'] },
      {
        partyId: 'gamma',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['x', 'y'],
        constraints: [{ id: 'one-at-a-time', expr: { op: 'atMost', features: ['x', 'y'], count: 1 } }],
      },
    ],
    { x: 3, y: 3 },
  );
  if (outcome.status === 'unsatisfiable') {
    console.log('core:');
    for (const entry of outcome.core) console.log(`  - [${entry.kind}] ${entry.id}: ${entry.description}`);
    console.log('removal witnesses:');
    for (const removal of outcome.removalWitnesses) {
      console.log(
        `  - without ${removal.removedConstraintId}:`,
        removal.witness.protocolVersion,
        JSON.stringify(removal.witness.features),
      );
    }
  }
}

line('Offer update and resumable search');
{
  const session = new NegotiationSession({
    offers: [
      { partyId: 'left', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: ['a', 'b'] },
      { partyId: 'right', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: ['a'] },
    ],
    benefits: { a: 2, b: 9 },
  });
  const before = session.solve();
  if (before.status === 'success') console.log('before update:', before.features, before.totalBenefit);

  session.updateOffer({
    partyId: 'right',
    offerVersion: '2',
    protocolVersions: ['v1'],
    supportedFeatures: ['a', 'b'],
  });
  const after = session.solve();
  if (after.status === 'success') {
    console.log('after update :', after.features, after.totalBenefit, 'versions', after.offerVersions);
  }

  const big = Array.from({ length: 16 }, (_, i) => `cap${String(i).padStart(2, '0')}`);
  let partial = negotiate(
    [
      { partyId: 'left', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: big },
      { partyId: 'right', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: big },
    ],
    Object.fromEntries(big.map((feature) => [feature, 1])),
    { maxSteps: 4 },
  );
  let rounds = 1;
  while (partial.status === 'undetermined') {
    partial = negotiate(
      [
        { partyId: 'left', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: big },
        { partyId: 'right', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: big },
      ],
      Object.fromEntries(big.map((feature) => [feature, 1])),
      { maxSteps: 4, resume: partial.progress },
    );
    rounds += 1;
  }
  if (partial.status === 'success') {
    console.log(`resumed ${rounds} times; explored ${partial.search.explored} nodes total`);
    console.log('selected', partial.features.length, 'of', big.length, 'features');
  }
}
