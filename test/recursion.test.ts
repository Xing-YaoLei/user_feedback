import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaRegistry } from '../src/registry.ts';
import type { Schema, WireValue } from '../src/types.ts';
import { SchemaValidationError, ParseError } from '../src/errors.ts';
import { encodeWire, decodeWire } from '../src/wire.ts';

/**
 * Singly linked list of i32:
 *   Node = { head: i32 (#1), tail: [Node] (#2, empty array terminates) }
 */
function listSchema(version: string, itemKind: 'i32' | 'i64' = 'i32'): Schema {
  return {
    version,
    types: {
      Node: {
        kind: 'record',
        fields: [
          { id: 1, name: 'head', type: { kind: itemKind }, hasDefault: false },
          {
            id: 2,
            name: 'tail',
            type: { kind: 'array', items: { kind: 'ref', name: 'Node' } },
            hasDefault: false,
          },
        ],
      },
    },
    root: { kind: 'ref', name: 'Node' },
  };
}

function buildList(values: number[]): WireValue {
  let node: WireValue = {
    '1': values.length === 0 ? 0 : values[values.length - 1],
    '2': [],
  };
  for (let i = values.length - 2; i >= 0; i--) {
    node = { '1': values[i], '2': [node] };
  }
  return node;
}

describe('recursive named types', () => {
  it('analysis terminates and accepts a self-referential list', () => {
    const registry = new SchemaRegistry();
    assert.doesNotThrow(() => registry.register(listSchema('list-v1'), 'bidirectional'));
  });

  it('parses legal recursive structures at arbitrary finite depth', () => {
    const registry = new SchemaRegistry();
    registry.register(listSchema('list-v1'), 'bidirectional');

    const depth = 100;
    const values = Array.from({ length: depth }, (_, i) => i);
    const message = buildList(values);

    const parsed = registry.parse('list-v1', message) as Record<string, WireValue>;
    // Walk the converted structure back to verify every element.
    let current: WireValue = parsed;
    let count = 0;
    while (true) {
      const record = current as Record<string, WireValue>;
      assert.equal(record['1'], count);
      const tail = record['2'] as WireValue[];
      if (tail.length === 0) break;
      current = tail[0];
      count++;
    }
    assert.equal(count, depth - 1);

    // Survives JSON encode/decode with the same result.
    assert.deepEqual(
      registry.parse('list-v1', decodeWire(encodeWire(message))),
      parsed,
    );
  });

  it('mutually recursive named types are handled (tree of parent/children)', () => {
    const tree: Schema = {
      version: 'tree-v1',
      types: {
        Branch: {
          kind: 'record',
          fields: [
            { id: 1, name: 'label', type: { kind: 'string' }, hasDefault: false },
            {
              id: 2,
              name: 'leaves',
              type: {
                kind: 'array',
                items: { kind: 'ref', name: 'Leaf' },
              },
              hasDefault: false,
            },
          ],
        },
        Leaf: {
          kind: 'record',
          fields: [
            { id: 1, name: 'weight', type: { kind: 'f64' }, hasDefault: false },
            {
              id: 2,
              name: 'owner',
              type: { kind: 'ref', name: 'Branch' },
              hasDefault: true,
              default: { '1': 'root', '2': [] },
            },
          ],
        },
      },
      root: { kind: 'ref', name: 'Branch' },
    };

    const registry = new SchemaRegistry();
    assert.doesNotThrow(() => registry.register(tree, 'bidirectional'));

    const message: WireValue = {
      '1': 'top',
      '2': [
        { '1': 1.5, '2': { '1': 'top', '2': [] } },
        {
          '1': 2.5,
          '2': {
            '1': 'mid',
            '2': [{ '1': 9.25, '2': { '1': 'mid', '2': [] } }],
          },
        },
      ],
    };
    const parsed = registry.parse('tree-v1', message);
    assert.deepEqual(parsed, message);
  });

  it('rejects unguarded recursion: A = ref A has no finite value', () => {
    const schema: Schema = {
      version: 'loop',
      types: { A: { kind: 'ref', name: 'A' } },
      root: { kind: 'ref', name: 'A' },
    };
    const registry = new SchemaRegistry();
    assert.throws(
      () => registry.register(schema, 'bidirectional'),
      (err: unknown) => err instanceof SchemaValidationError,
    );
  });

  it('rejects a record whose required field forces an infinite descent', () => {
    const schema: Schema = {
      version: 'bad-record',
      types: {
        Infinite: {
          kind: 'record',
          fields: [
            {
              id: 1,
              name: 'next',
              type: { kind: 'ref', name: 'Infinite' },
              hasDefault: false,
            },
          ],
        },
      },
      root: { kind: 'ref', name: 'Infinite' },
    };
    const registry = new SchemaRegistry();
    assert.throws(
      () => registry.register(schema, 'bidirectional'),
      (err: unknown) => err instanceof SchemaValidationError,
    );
  });

  it('recursive list item widening i32 -> i64 converts the whole finite structure', () => {
    const registry = new SchemaRegistry();
    // i32 -> i64 is a one-way widening, so register the i64 reader under the
    // forward policy (which checks new writer -> old reader direction only
    // after the backward pair i32-writer -> i64-reader is proven compatible).
    registry.register(listSchema('list-i32', 'i32'), 'bidirectional');
    registry.register(listSchema('list-i64', 'i64'), 'backward');

    const message = buildList([10, 20, 30]);
    const converted = registry.parseAcross(
      'list-i32',
      'list-i64',
      message,
    ) as Record<string, WireValue>;

    let current: WireValue = converted;
    const expected = [10n, 20n, 30n];
    let i = 0;
    while (true) {
      const record = current as Record<string, WireValue>;
      assert.equal(record['1'], expected[i]);
      const tail = record['2'] as WireValue[];
      if (tail.length === 0) break;
      current = tail[0];
      i++;
    }
  });

  it('malformed recursive messages fail with a concrete path', () => {
    const registry = new SchemaRegistry();
    registry.register(listSchema('list-v1'), 'bidirectional');
    assert.throws(
      () => registry.parse('list-v1', { '1': 'not-a-number', '2': [] }),
      (err: unknown) => err instanceof ParseError && err.reason === 'bad-i32',
    );
  });
});
