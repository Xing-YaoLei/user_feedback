import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaRegistry } from '../src/registry.ts';
import type { Schema } from '../src/types.ts';
import { renderPath } from '../src/errors.ts';
import { analyzeStandalonePair } from './helpers.ts';

/**
 * Writer: catalog of products; each product has a tagged availability union.
 *   Catalog = { products: [Product] #1 }
 *   Product = { sku: string #1, detail: Detail #2 }
 *   Detail  = union('instock' -> i64 count, 'backorder' -> string eta)
 *
 * Two reader variants break different positions, each with a deep path.
 */
function writerSchema(): Schema {
  return {
    version: 'cat-w',
    types: {
      Catalog: {
        kind: 'record',
        fields: [
          {
            id: 1,
            name: 'products',
            type: { kind: 'array', items: { kind: 'ref', name: 'Product' } },
            hasDefault: false,
          },
        ],
      },
      Product: {
        kind: 'record',
        fields: [
          { id: 1, name: 'sku', type: { kind: 'string' }, hasDefault: false },
          { id: 2, name: 'detail', type: { kind: 'ref', name: 'Detail' }, hasDefault: false },
        ],
      },
      Detail: {
        kind: 'union',
        branches: [
          { tag: 'instock', type: { kind: 'i64' } },
          { tag: 'backorder', type: { kind: 'string' } },
        ],
      },
    },
    root: { kind: 'ref', name: 'Catalog' },
  };
}

/** Reader narrows instock count i64 -> f64: deep leaf mismatch. */
function readerBadNumeric(): Schema {
  return {
    version: 'cat-r-numeric',
    types: {
      Catalog: {
        kind: 'record',
        fields: [
          {
            id: 1,
            name: 'products',
            type: { kind: 'array', items: { kind: 'ref', name: 'Product' } },
            hasDefault: false,
          },
        ],
      },
      Product: {
        kind: 'record',
        fields: [
          { id: 1, name: 'sku', type: { kind: 'string' }, hasDefault: false },
          { id: 2, name: 'detail', type: { kind: 'ref', name: 'Detail' }, hasDefault: false },
        ],
      },
      Detail: {
        kind: 'union',
        branches: [
          { tag: 'instock', type: { kind: 'f64' } },
          { tag: 'backorder', type: { kind: 'string' } },
        ],
      },
    },
    root: { kind: 'ref', name: 'Catalog' },
  };
}

/** Reader drops the backorder branch: unknown tag reached through the array. */
function readerMissingBranch(): Schema {
  return {
    version: 'cat-r-tag',
    types: {
      Catalog: {
        kind: 'record',
        fields: [
          {
            id: 1,
            name: 'products',
            type: { kind: 'array', items: { kind: 'ref', name: 'Product' } },
            hasDefault: false,
          },
        ],
      },
      Product: {
        kind: 'record',
        fields: [
          { id: 1, name: 'sku', type: { kind: 'string' }, hasDefault: false },
          { id: 2, name: 'detail', type: { kind: 'ref', name: 'Detail' }, hasDefault: false },
        ],
      },
      Detail: {
        kind: 'union',
        branches: [{ tag: 'instock', type: { kind: 'i64' } }],
      },
    },
    root: { kind: 'ref', name: 'Catalog' },
  };
}

describe('deep counterexamples', () => {
  it('reports the full nested path for an i64 -> f64 mismatch and reproduces it', () => {
    const err = analyzeStandalonePair(writerSchema(), readerBadNumeric());
    assert.equal(err.reason, 'leaf-mismatch');
    const rendered = renderPath(err.path);
    assert.match(rendered, /field#1/);
    assert.match(rendered, /\[0\]/);
    assert.match(rendered, /field#2/);
    assert.match(rendered, /tag:instock/);

    // The counterexample is a finite writer message reaching that position.
    const ce = err.counterexample as Record<string, unknown>;
    const products = ce['1'] as Array<Record<string, unknown>>;
    assert.equal(products.length, 1);
    assert.deepEqual(products[0]['2'], { tag: 'instock', value: 0n });
  });

  it('reports an unknown tag through nested records and reproduces it', () => {
    const err = analyzeStandalonePair(writerSchema(), readerMissingBranch());
    assert.equal(err.reason, 'unknown-union-tag');
    assert.deepEqual(
      err.path[err.path.length - 1],
      { kind: 'union-branch', tag: 'backorder' },
    );

    const ce = err.counterexample as Record<string, unknown>;
    const products = ce['1'] as Array<Record<string, unknown>>;
    assert.deepEqual(products[0]['2'], { tag: 'backorder', value: '' });
  });

  it('compatible counterpart plans still convert the same shapes successfully', () => {
    const registry = new SchemaRegistry();
    registry.register(writerSchema(), 'bidirectional');

    const message = {
      '1': [
        { '1': 'a', '2': { tag: 'instock', value: 12n } },
        { '1': 'b', '2': { tag: 'backorder', value: '2026-12-01' } },
      ],
    };
    assert.deepEqual(registry.parse('cat-w', message), message);
  });
});
