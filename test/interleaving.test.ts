import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaRegistry } from '../src/registry.ts';
import type { Schema, WireValue } from '../src/types.ts';
import { CompatibilityError } from '../src/errors.ts';
import {
  analyzeStandalonePair,
  mustFailRegistration,
} from './helpers.ts';

/**
 * Three coexisting payload versions of an envelope record (amount stays i64,
 * which keeps v1/v2 readable in both directions):
 *   v1: #1 kind (string),             #2 amount i64
 *   v2: #1 kindCode (string, renamed),#2 amount i64, #3 note string default ""
 *   v3: same ids, but #3 note becomes required (backward incompatible)
 */
function envelopeV1(): Schema {
  return {
    version: 'env-v1',
    types: {},
    root: {
      kind: 'record',
      fields: [
        { id: 1, name: 'kind', type: { kind: 'string' }, hasDefault: false },
        { id: 2, name: 'amount', type: { kind: 'i64' }, hasDefault: false },
      ],
    },
  };
}

function envelopeV2(): Schema {
  return {
    version: 'env-v2',
    types: {},
    root: {
      kind: 'record',
      fields: [
        { id: 1, name: 'kindCode', type: { kind: 'string' }, hasDefault: false },
        { id: 2, name: 'amount', type: { kind: 'i64' }, hasDefault: false },
        {
          id: 3,
          name: 'note',
          type: { kind: 'string' },
          hasDefault: true,
          default: '',
        },
      ],
    },
  };
}

function envelopeV3RequiredNote(): Schema {
  return {
    version: 'env-v3',
    types: {},
    root: {
      kind: 'record',
      fields: [
        { id: 1, name: 'kindCode', type: { kind: 'string' }, hasDefault: false },
        { id: 2, name: 'amount', type: { kind: 'i64' }, hasDefault: false },
        { id: 3, name: 'note', type: { kind: 'string' }, hasDefault: false },
      ],
    },
  };
}

/** A reader that narrows amount to i32 and makes note defaulted. */
function narrowReader(): Schema {
  return {
    version: 'narrow',
    types: {},
    root: {
      kind: 'record',
      fields: [
        { id: 1, name: 'kindCode', type: { kind: 'string' }, hasDefault: false },
        { id: 2, name: 'amount', type: { kind: 'i32' }, hasDefault: false },
        {
          id: 3,
          name: 'note',
          type: { kind: 'string' },
          hasDefault: true,
          default: '',
        },
      ],
    },
  };
}

describe('interleaved producers and consumers', () => {
  it('v1 and v2 coexist; every ordered pair resolves through reusable plans', () => {
    const registry = new SchemaRegistry();
    registry.register(envelopeV1(), 'bidirectional');
    registry.register(envelopeV2(), 'bidirectional');

    assert.deepEqual(registry.listVersions(), ['env-v1', 'env-v2']);

    // Old producer, new consumer: note defaulted.
    const oldMessage: WireValue = { '1': 'cash', '2': 9007199254740993n };
    assert.deepEqual(registry.parseAcross('env-v1', 'env-v2', oldMessage), {
      '1': 'cash',
      '2': 9007199254740993n,
      '3': '',
    });

    // New producer, old consumer: note ignored.
    const newMessage: WireValue = { '1': 'card', '2': 42n, '3': 'hi' };
    assert.deepEqual(registry.parseAcross('env-v2', 'env-v1', newMessage), {
      '1': 'card',
      '2': 42n,
    });

    // Plans are cached and reusable across calls.
    const planA = registry.getPlan('env-v1', 'env-v2');
    const planB = registry.getPlan('env-v1', 'env-v2');
    assert.equal(planA, planB);
    assert.equal(planA.compatible, true);
  });

  it('v3 makes note required: backward registration fails atomically against all prior versions', () => {
    const registry = new SchemaRegistry();
    registry.register(envelopeV1(), 'bidirectional');
    registry.register(envelopeV2(), 'bidirectional');

    const err = mustFailRegistration(
      registry,
      envelopeV3RequiredNote(),
      'backward',
    );
    assert.equal(err.reason, 'missing-required-field');
    assert.deepEqual(registry.listVersions(), ['env-v1', 'env-v2']);

    // Both old writers yield finite counterexamples that reproduce through
    // the parsing entry with the same reason and route.
    for (const oldSchema of [envelopeV1(), envelopeV2()]) {
      const pairError = analyzeStandalonePair(oldSchema, envelopeV3RequiredNote());
      assert.equal(pairError.reason, 'missing-required-field');
      assert.deepEqual(pairError.path[pairError.path.length - 1], {
        kind: 'field',
        id: 3,
        name: 'note',
      });
    }
  });

  it('forward policy alone allows the v3 registration (new writer, old readers)', () => {
    const registry = new SchemaRegistry();
    registry.register(envelopeV1(), 'bidirectional');
    registry.register(envelopeV2(), 'bidirectional');

    // Forward asks: can old readers parse the new writer's messages?
    // v3's fields 1-3 are all readable by v2 (same ids), so it holds.
    assert.doesNotThrow(() =>
      registry.register(envelopeV3RequiredNote(), 'forward'),
    );
    assert.deepEqual(registry.listVersions(), ['env-v1', 'env-v2', 'env-v3']);
  });

  it('an i64 -> i32 narrowing fails backward registration but the reverse holds', () => {
    const registry = new SchemaRegistry();
    registry.register(envelopeV2(), 'bidirectional');

    // Backward asks old i64 writer -> new i32 reader: lossy, rejected.
    mustFailRegistration(registry, narrowReader(), 'backward');
    assert.deepEqual(registry.listVersions(), ['env-v2']);

    // Forward asks new i32 writer -> old i64 reader: lossless promotion,
    // so the narrow schema may coexist for that one direction.
    assert.doesNotThrow(() => registry.register(narrowReader(), 'forward'));
    assert.deepEqual(registry.listVersions(), ['env-v2', 'narrow']);
    assert.equal(
      registry.parseAcross('narrow', 'env-v2', { '1': 'k', '2': 12, '3': 'n' })['2'],
      12n,
    );

    // The lossy ordered pair still fails explicit analysis and reproduces.
    const err = analyzeStandalonePair(envelopeV2(), narrowReader());
    assert.equal(err.reason, 'leaf-mismatch');
    assert.equal(err.writerVersion, 'env-v2');
    assert.equal(err.readerVersion, 'narrow');
  });

  it('re-registering an existing version fails without changing the set', () => {
    const registry = new SchemaRegistry();
    registry.register(envelopeV1(), 'bidirectional');
    assert.throws(
      () => registry.register(envelopeV1(), 'bidirectional'),
      (err: unknown) => err instanceof CompatibilityError,
    );
    assert.deepEqual(registry.listVersions(), ['env-v1']);
  });
});
