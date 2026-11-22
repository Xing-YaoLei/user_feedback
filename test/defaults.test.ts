import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaRegistry } from '../src/registry.ts';
import type { Schema } from '../src/types.ts';
import { SchemaValidationError } from '../src/errors.ts';
import { encodeWire, decodeWire } from '../src/wire.ts';

/**
 * Order record with nested defaults:
 *  #1 id       : string (required)
 *  #2 items    : array of { sku: string #1, qty: i32 #2 default 1 }
 *  #3 meta     : record { region: string #1 default "cn", flags: [bool] #2 default [] }
 *  #4 priority : i32 default 0
 */
function orderV1(): Schema {
  return {
    version: 'order-v1',
    types: {
      Item: {
        kind: 'record',
        fields: [
          { id: 1, name: 'sku', type: { kind: 'string' }, hasDefault: false },
          { id: 2, name: 'qty', type: { kind: 'i32' }, hasDefault: true, default: 1 },
        ],
      },
      Meta: {
        kind: 'record',
        fields: [
          {
            id: 1,
            name: 'region',
            type: { kind: 'string' },
            hasDefault: true,
            default: 'cn',
          },
          {
            id: 2,
            name: 'flags',
            type: { kind: 'array', items: { kind: 'bool' } },
            hasDefault: true,
            default: [],
          },
        ],
      },
    },
    root: {
      kind: 'record',
      fields: [
        { id: 1, name: 'id', type: { kind: 'string' }, hasDefault: false },
        {
          id: 2,
          name: 'items',
          type: { kind: 'array', items: { kind: 'ref', name: 'Item' } },
          hasDefault: true,
          default: [],
        },
        { id: 3, name: 'meta', type: { kind: 'ref', name: 'Meta' }, hasDefault: true, default: { '1': 'cn', '2': [] } },
        { id: 4, name: 'priority', type: { kind: 'i32' }, hasDefault: true, default: 0 },
      ],
    },
  };
}

describe('nested defaults', () => {
  it('fills defaults at every nesting level when fields are absent', () => {
    const registry = new SchemaRegistry();
    registry.register(orderV1(), 'bidirectional');

    const minimal = { '1': 'ord-1' };
    const parsed = registry.parse('order-v1', minimal) as Record<string, unknown>;
    assert.deepEqual(parsed, {
      '1': 'ord-1',
      '2': [],
      '3': { '1': 'cn', '2': [] },
      '4': 0,
    });
  });

  it('explicit nested values win over defaults and survive JSON round trip', () => {
    const registry = new SchemaRegistry();
    registry.register(orderV1(), 'bidirectional');

    const message = {
      '1': 'ord-2',
      '2': [{ '1': 'sku-9' }], // qty defaulted inside the element
      '3': { '2': [true, false] }, // region defaulted inside meta
    };
    const parsed = registry.parse(
      'order-v1',
      decodeWire(encodeWire(message)),
    ) as Record<string, unknown>;
    assert.deepEqual(parsed, {
      '1': 'ord-2',
      '2': [{ '1': 'sku-9', '2': 1 }],
      '3': { '1': 'cn', '2': [true, false] },
      '4': 0,
    });
  });
});

describe('registration validation', () => {
  const registry = new SchemaRegistry();

  it('rejects dangling references', () => {
    const schema: Schema = {
      version: 'dangling',
      types: {},
      root: { kind: 'ref', name: 'Missing' },
    };
    assert.throws(
      () => registry.register(schema, 'bidirectional'),
      (err: unknown) =>
        err instanceof SchemaValidationError && /does not resolve/.test(err.message),
    );
  });

  it('rejects duplicate field ids and non-positive ids', () => {
    const dup: Schema = {
      version: 'dup-id',
      types: {},
      root: {
        kind: 'record',
        fields: [
          { id: 1, name: 'a', type: { kind: 'bool' }, hasDefault: false },
          { id: 1, name: 'b', type: { kind: 'bool' }, hasDefault: false },
        ],
      },
    };
    assert.throws(() => registry.register(dup, 'bidirectional'), SchemaValidationError);

    const zero: Schema = {
      version: 'zero-id',
      types: {},
      root: {
        kind: 'record',
        fields: [{ id: 0, name: 'a', type: { kind: 'bool' }, hasDefault: false }],
      },
    };
    assert.throws(() => registry.register(zero, 'bidirectional'), SchemaValidationError);
  });

  it('rejects duplicate union tags', () => {
    const schema: Schema = {
      version: 'dup-tag',
      types: {},
      root: {
        kind: 'union',
        branches: [
          { tag: 'x', type: { kind: 'bool' } },
          { tag: 'x', type: { kind: 'string' } },
        ],
      },
    };
    assert.throws(() => registry.register(schema, 'bidirectional'), SchemaValidationError);
  });

  it('rejects defaults outside their declared type domain', () => {
    const cases: Schema[] = [
      {
        version: 'bad-default-i32',
        types: {},
        root: {
          kind: 'record',
          fields: [
            { id: 1, name: 'n', type: { kind: 'i32' }, hasDefault: true, default: 1.5 },
          ],
        },
      },
      {
        version: 'bad-default-i64',
        types: {},
        root: {
          kind: 'record',
          fields: [
            { id: 1, name: 'n', type: { kind: 'i64' }, hasDefault: true, default: 7 },
          ],
        },
      },
      {
        version: 'bad-default-f64',
        types: {},
        root: {
          kind: 'record',
          fields: [
            { id: 1, name: 'n', type: { kind: 'f64' }, hasDefault: true, default: Number.NaN },
          ],
        },
      },
      {
        version: 'bad-default-record',
        types: {},
        root: {
          kind: 'record',
          fields: [
            {
              id: 1,
              name: 'inner',
              type: {
                kind: 'record',
                fields: [
                  { id: 1, name: 'flag', type: { kind: 'bool' }, hasDefault: false },
                ],
              },
              hasDefault: true,
              default: {},
            },
          ],
        },
      },
    ];
    for (const schema of cases) {
      assert.throws(
        () => registry.register(schema, 'bidirectional'),
        SchemaValidationError,
        `expected ${schema.version} to be rejected`,
      );
    }
  });

  it('accepts a finite ref-typed default value', () => {
    const schema: Schema = {
      version: 'ref-default',
      types: {
        Box: {
          kind: 'record',
          fields: [
            { id: 1, name: 'tag', type: { kind: 'string' }, hasDefault: false },
          ],
        },
      },
      root: {
        kind: 'record',
        fields: [
          {
            id: 1,
            name: 'b',
            type: { kind: 'ref', name: 'Box' },
            hasDefault: true,
            default: { '1': 'x' },
          },
        ],
      },
    };
    assert.doesNotThrow(() => registry.register(schema, 'bidirectional'));
  });

  it('rejects a default value that traverses a recursive reference', () => {
    const schema: Schema = {
      version: 'rec-default',
      types: {
        Loop: {
          kind: 'record',
          fields: [
            {
              id: 1,
              name: 'self',
              type: { kind: 'ref', name: 'Loop' },
              hasDefault: true,
              default: { '1': { '1': null } },
            },
          ],
        },
      },
      root: { kind: 'ref', name: 'Loop' },
    };
    assert.throws(
      () => registry.register(schema, 'bidirectional'),
      SchemaValidationError,
    );
  });
});
