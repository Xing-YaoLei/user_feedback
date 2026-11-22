import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaRegistry } from '../src/registry.ts';
import type { Schema } from '../src/types.ts';
import { ParseError } from '../src/errors.ts';
import {
  analyzeStandalonePair,
  assertCounterexampleReproduces,
  mustFailRegistration,
} from './helpers.ts';

function eventV1(): Schema {
  return {
    version: 'event-v1',
    types: {},
    root: {
      kind: 'union',
      branches: [
        { tag: 'created', type: { kind: 'string' } },
        { tag: 'count', type: { kind: 'i32' } },
      ],
    },
  };
}

/** Adds a branch (old readers cannot see it) - forward incompatible. */
function eventV2ExtraBranch(): Schema {
  return {
    version: 'event-v2',
    types: {},
    root: {
      kind: 'union',
      branches: [
        { tag: 'created', type: { kind: 'string' } },
        { tag: 'count', type: { kind: 'i32' } },
        { tag: 'archived', type: { kind: 'bool' } },
      ],
    },
  };
}

/** Removes the `count` branch - backward incompatible for old writers. */
function eventV2RemovedBranch(): Schema {
  return {
    version: 'event-v2-removed',
    types: {},
    root: {
      kind: 'union',
      branches: [{ tag: 'created', type: { kind: 'string' } }],
    },
  };
}

/** Same tags but the `count` payload narrows i32 -> bool. */
function eventV2BadPayload(): Schema {
  return {
    version: 'event-v2-bad-payload',
    types: {},
    root: {
      kind: 'union',
      branches: [
        { tag: 'created', type: { kind: 'string' } },
        { tag: 'count', type: { kind: 'bool' } },
      ],
    },
  };
}

describe('tagged union evolution', () => {
  it('backward: adding a reader branch keeps old writers readable', () => {
    const registry = new SchemaRegistry();
    registry.register(eventV1(), 'bidirectional');
    registry.register(eventV2ExtraBranch(), 'backward');

    const message = { tag: 'created', value: 'order-1' };
    assert.deepEqual(
      registry.parseAcross('event-v1', 'event-v2', message),
      message,
    );
  });

  it('forward fails when a new branch cannot be read by old consumers', () => {
    const registry = new SchemaRegistry();
    registry.register(eventV1(), 'bidirectional');
    const err = mustFailRegistration(registry, eventV2ExtraBranch(), 'forward');
    assert.equal(err.reason, 'unknown-union-tag');
    assert.equal(err.writerVersion, 'event-v2');
    assert.equal(err.readerVersion, 'event-v1');
    assert.deepEqual(err.counterexample, { tag: 'archived', value: false });
  });

  it('backward fails when an old writer branch has no reader branch', () => {
    const registry = new SchemaRegistry();
    registry.register(eventV1(), 'backward');
    mustFailRegistration(registry, eventV2RemovedBranch(), 'backward');

    const err = analyzeStandalonePair(eventV1(), eventV2RemovedBranch());
    assert.equal(err.reason, 'unknown-union-tag');
    assert.equal(err.writerVersion, 'event-v1');
    assert.equal(err.readerVersion, 'event-v2-removed');
    assert.deepEqual(err.counterexample, { tag: 'count', value: 0 });
  });

  it('payload type change inside a matched branch is caught on the branch path', () => {
    const registry = new SchemaRegistry();
    registry.register(eventV1(), 'bidirectional');
    mustFailRegistration(registry, eventV2BadPayload(), 'backward');

    const err = analyzeStandalonePair(eventV1(), eventV2BadPayload());
    assert.equal(err.reason, 'leaf-mismatch');
    assert.deepEqual(err.path[1], { kind: 'union-branch', tag: 'count' });
  });

  it('selects branches by exact tag and converts matched payloads', () => {
    const registry = new SchemaRegistry();
    registry.register(eventV1(), 'bidirectional');
    registry.register(eventV2ExtraBranch(), 'backward');

    assert.deepEqual(
      registry.parseAcross('event-v1', 'event-v2', { tag: 'count', value: 7 }),
      { tag: 'count', value: 7 },
    );

    // An unknown tag in an actual message fails at runtime.
    assert.throws(
      () =>
        registry.parseAcross('event-v2', 'event-v1', {
          tag: 'archived',
          value: true,
        }),
      (e: unknown) => e instanceof ParseError && e.reason === 'unknown-union-tag',
    );
  });
});
