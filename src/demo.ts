/**
 * Annotated demonstration of the layered configuration evaluator.
 *
 * Run with `npm run demo`.
 */

import {
  createConfigEvaluator,
  deletePath,
  expr,
  formatQuantity,
  quantityFromValue,
} from './index.ts';
import type { LiteralValue } from './index.ts';

function render(value: LiteralValue): string {
  switch (value.kind) {
    case 'number':
      return formatQuantity(quantityFromValue(value));
    case 'null':
      return 'null';
    case 'string':
      return JSON.stringify(value.value);
    case 'boolean':
      return String(value.value);
  }
}

const evaluator = createConfigEvaluator({
  layers: [
    {
      id: 'tenant-acme',
      values: {
        'service.timeout': '250ms',
        'service.retries': 3,
        'service.disk': '2GiB',
        // An inline expression: it overrides the environment value while
        // reading what it overrides through `$base`.
        'service.poolSize': expr({ $add: [{ $base: true }, { $const: 2 }] }),
      },
    },
    {
      id: 'platform',
      values: {
        'features.retry': true,
        // A deletion hides every lower definition of the path.
        'legacy.banner': deletePath(),
      },
    },
    {
      id: 'env-prod',
      values: {
        'service.timeout': '500ms',
        'service.retries': 1,
        'service.disk': '512MiB',
        'service.poolSize': 8,
        'legacy.banner': 'legacy deploy banner',
      },
    },
  ],
  expressions: {
    'service.effectiveTimeout': {
      $if: [
        { $eq: [{ $ctx: 'region' }, { $const: 'eu' }] },
        { $add: [{ $ref: 'service.timeout' }, { $qty: '100ms' }] },
        { $ref: 'service.timeout' },
      ],
    },
    'service.retryBudget': {
      $add: [{ $ref: 'service.retries' }, { $const: 2 }],
    },
    'service.diskCushion': {
      $lt: [{ $ref: 'service.disk' }, { $qty: '1GiB' }],
    },
    'service.tenantLabel': {
      $if: [
        { $ref: 'features.retry' },
        { $const: { kind: 'string', value: 'retry-enabled' } },
        { $const: { kind: 'string', value: 'no-retry' } },
      ],
    },
  },
  context: { region: 'eu', tier: 'gold' },
});

const paths = [
  'service.timeout',
  'service.effectiveTimeout',
  'service.retries',
  'service.retryBudget',
  'service.poolSize',
  'service.disk',
  'service.diskCushion',
  'service.tenantLabel',
  'legacy.banner',
];

function report(label: string): void {
  const batch = evaluator.beginBatch();
  const result = batch.evaluate(paths);
  console.log(`\n=== ${label} (revision ${result.revision}) ===`);
  for (const path of paths) {
    const outcome = result.outcomes[path]!;
    if (outcome.ok) {
      const { definition } = outcome.result;
      const chain = definition.refs.map((hop) => `${hop.via}:${hop.path}@${hop.layer ?? '-'}`);
      console.log(
        `${path.padEnd(26)} = ${render(outcome.result.value).padEnd(14)} [layer ${definition.layer}]` +
          (chain.length > 0 ? `\n${' '.repeat(29)}via ${chain.join(' -> ')}` : ''),
      );
    } else if ('missing' in outcome) {
      console.log(`${path.padEnd(26)} ~ missing (${outcome.missing.reason})`);
    } else {
      console.log(`${path.padEnd(26)} ! ${outcome.error.code}: ${outcome.error.message}`);
    }
  }
}

report('initial (tenant acme, region eu)');

evaluator.setContext({ region: 'us', tier: 'gold' });
report('after switching region to us');

evaluator.update({ type: 'set', layer: 'platform', path: 'legacy.banner', value: 'restored' });
evaluator.update({ type: 'set', layer: 'tenant-acme', path: 'service.timeout', value: '2s' });
report('after restoring the banner and raising the tenant timeout');

const stats = evaluator.getStats();
console.log('\n=== cache statistics ===');
console.log('batches                :', stats.batches);
console.log('root evaluations       :', stats.evaluations);
console.log('root cache hits/misses :', stats.cacheHits, '/', stats.cacheMisses);
console.log('recomputations by path :', JSON.stringify(stats.recomputationsByPath));
console.log('expression evaluations :', JSON.stringify(stats.expressionEvaluationsByPath));
