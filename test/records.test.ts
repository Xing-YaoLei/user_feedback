import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaRegistry } from '../src/registry.ts';
import { CompatibilityError, ParseError } from '../src/errors.ts';
import type { Schema } from '../src/types.ts';
import { decodeWire, encodeWire } from '../src/wire.ts';
import { analyzeStandalonePair } from './helpers.ts';
function v1(): Schema {
  return {
    version: 'user-v1',
    types: {},
    root: {
      kind: 'record',
      fields: [
        { id: 1, name: 'name', type: { kind: 'string' }, hasDefault: false },
        { id: 2, name: 'age', type: { kind: 'i32' }, hasDefault: false },
      ],
    },
  };
}

/** Renames `age` -> `years` (same id 2), adds optional `email` with default. */
function v2(): Schema {
  return {
    version: 'user-v2',
    types: {},
    root: {
      kind: 'record',
      fields: [
        { id: 1, name: 'name', type: { kind: 'string' }, hasDefault: false },
        { id: 2, name: 'years', type: { kind: 'i32' }, hasDefault: false },
        {
          id: 3,
          name: 'email',
          type: { kind: 'string' },
          hasDefault: true,
          default: 'nobody@example.com',
        },
      ],
    },
  }
};

describe('record evolution', () => {
  it('registers v1 then v2 backward and bidirectionally', () => {
    const registry = new SchemaRegistry();
    registry.register(v1(), 'bidirectional');
    const result = registry.register(v2(), 'bidirectional');
    assert.equal(result.checkedPlans.length, 2);
    assert.deepEqual(registry.listVersions(), ['user-v1', 'user-v2']);
  });

  it('old writer -> new reader: default filled, unknown fields ignored, id beats name', () => {
    const registry = new SchemaRegistry();
    registry.register(v1(), 'bidirectional');
    registry.register(v2(), 'bidirectional');

    const oldMessage = { '1': 'Ada', '2': 36, '99': 'ignored' };
    const read = registry.parseAcross('user-v1', 'user-v2', oldMessage);
    assert.deepEqual(read, {
      '1': 'Ada',
      '2': 36,
      '3': 'nobody@example.com',
    });
  });

  it('new writer -> old reader: new optional field is ignored by the old reader', () => {
    const registry = new SchemaRegistry();
    registry.register(v1(), 'bidirectional');
    registry.register(v2(), 'bidirectional');

    const newMessage = { '1': 'Lin', '2': 41, '3': 'lin@example.com' };
    const read = registry.parseAcross('user-v2', 'user-v1', newMessage);
    assert.deepEqual(read, { '1': 'Lin', '2': 41 });
  });

  it('JSON round trip preserves the wire form including the envelope shape', () => {
    const registry = new SchemaRegistry();
    registry.register(v1(), 'bidirectional');
    registry.register(v2(), 'bidirectional');
    const oldMessage = { '1': 'Ada', '2': 36 };
    const text = encodeWire(oldMessage);
    assert.deepEqual(
      registry.parseAcross('user-v1', 'user-v2', decodeWire(text)),
      { '1': 'Ada', '2': 36, '3': 'nobody@example.com' },
    );
  });

  it('a reader-required field the writer never supplies breaks backward compatibility', () => {
    const registry = new SchemaRegistry();
    registry.register(v1(), 'bidirectional');

    const broken: Schema = {
      version: 'user-broken',
      types: {},
      root: {
        kind: 'record',
        fields: [
          { id: 1, name: 'name', type: { kind: 'string' }, hasDefault: false },
          { id: 2, name: 'age', type: { kind: 'i32' }, hasDefault: false },
          { id: 4, name: 'ssn', type: { kind: 'string' }, hasDefault: false },
        ],
      },
    };

    const error = (() => {
      try {
        registry.register(broken, 'backward');
        assert.fail('registration should have failed');
      } catch (err) {
        assert.ok(err instanceof CompatibilityError);
        return err;
      }
    })();
    assert.equal(error.reason, 'missing-required-field');
    assert.equal(error.writerVersion, 'user-v1');
    assert.equal(error.readerVersion, 'user-broken');

    // The failed registration leaves the original version set intact.
    assert.deepEqual(registry.listVersions(), ['user-v1']);
    assert.equal(registry.has('user-broken'), false);

    // The same ordered pair analyzed directly keeps its finite counterexample.
    const pairError = analyzeStandalonePair(v1(), broken);
    assert.equal(pairError.reason, 'missing-required-field');
  });

  it('missing required fields in an actual message fail at the parsing entry', () => {
    const registry = new SchemaRegistry();
    registry.register(v1(), 'bidirectional');
    assert.throws(
      () => registry.parse('user-v1', { '1': 'no age' }),
      (err: unknown) =>
        err instanceof ParseError && err.reason === 'missing-required-field',
    );
  });

  it('making a previously optional (defaulted) field required is backward incompatible', () => {
    const optional: Schema = {
      version: 'opt',
      types: {},
      root: {
        kind: 'record',
        fields: [
          { id: 1, name: 'id', type: { kind: 'string' }, hasDefault: false },
          {
            id: 2,
            name: 'nick',
            type: { kind: 'string' },
            hasDefault: true,
            default: 'anon',
          },
        ],
      },
    };
    const required: Schema = {
      version: 'req',
      types: {},
      root: {
        kind: 'record',
        fields: [
          { id: 1, name: 'id', type: { kind: 'string' }, hasDefault: false },
          { id: 2, name: 'nick', type: { kind: 'string' }, hasDefault: false },
        ],
      },
    };

    const error = analyzeStandalonePair(optional, required);
    assert.equal(error.reason, 'missing-required-field');
    assert.deepEqual(error.path[1], { kind: 'field', id: 2, name: 'nick' });
    // The finite counterexample is the minimal writer message that omits #2.
    assert.deepEqual(error.counterexample, { '1': '' });

    // Same message through a registry holding both versions (forward policy
    // permits coexistence) reproduces the failure at the parsing entry.
    const registry = new SchemaRegistry();
    registry.register(optional, 'bidirectional');
    registry.register(required, 'forward');
    assert.throws(
      () => registry.parseAcross('opt', 'req', { '1': 'x' }),
      (err: unknown) =>
        err instanceof ParseError && err.reason === 'missing-required-field',
    );
  });
});
