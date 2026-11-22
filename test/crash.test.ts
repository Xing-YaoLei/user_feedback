import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaRegistry } from '../src/registry.ts';
import type { Schema, WireValue } from '../src/types.ts';
import {
  CompatibilityError,
  ParseError,
  SchemaValidationError,
} from '../src/errors.ts';
import { decodeWire, encodeWire } from '../src/wire.ts';

function accountV1(): Schema {
  return {
    version: 'acct-v1',
    types: {},
    root: {
      kind: 'record',
      fields: [
        { id: 1, name: 'owner', type: { kind: 'string' }, hasDefault: false },
        { id: 2, name: 'balance', type: { kind: 'i64' }, hasDefault: false },
      ],
    },
  };
}

function accountV2(): Schema {
  return {
    version: 'acct-v2',
    types: {},
    root: {
      kind: 'record',
      fields: [
        { id: 1, name: 'owner', type: { kind: 'string' }, hasDefault: false },
        { id: 2, name: 'balance', type: { kind: 'i64' }, hasDefault: false },
        {
          id: 3,
          name: 'currency',
          type: { kind: 'string' },
          hasDefault: true,
          default: 'USD',
        },
      ],
    },
  };
}

/** Caller-side adapter: produces/consumes canonical wire messages over JSON. */
class JsonMessageAdapter {
  private readonly registry: SchemaRegistry;

  constructor(registry: SchemaRegistry) {
    this.registry = registry;
  }

  produce(version: string, message: WireValue): string {
    // Validate outgoing messages against their own schema first.
    this.registry.parse(version, message);
    return encodeWire(message);
  }

  consume(writerVersion: string, readerVersion: string, text: string): WireValue {
    return this.registry.parseAcross(
      writerVersion,
      readerVersion,
      decodeWire(text),
    );
  }
}

describe('crash and recovery scenarios', () => {
  let dir: string;

  before(() => {
    // All temporary data stays inside this workspace run.
    const here = dirname(fileURLToPath(import.meta.url));
    dir = join(here, '..', '.tmp-test-data');
    mkdirSync(dir, { recursive: true });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registry survives a sequence of failed registrations and keeps serving', () => {
    const registry = new SchemaRegistry();
    registry.register(accountV1(), 'bidirectional');

    const malformed: Schema = {
      version: 'bad',
      types: { Ghost: { kind: 'ref', name: 'Nowhere' } },
      root: { kind: 'ref', name: 'Ghost' },
    };
    const incompatible: Schema = {
      version: 'acct-bad',
      types: {},
      root: {
        kind: 'record',
        fields: [
          { id: 1, name: 'owner', type: { kind: 'bool' }, hasDefault: false },
        ],
      },
    };

    for (const [schema, policy] of [
      [malformed, 'bidirectional'],
      [incompatible, 'bidirectional'],
    ] as const) {
      assert.throws(
        () => registry.register(schema, policy),
        (err: unknown) =>
          err instanceof SchemaValidationError || err instanceof CompatibilityError,
      );
    }

    // Simulated crash: a consumer dies while handling a bad message. On
    // restart the in-memory registry is rebuilt from scratch by replaying the
    // successful registrations only.
    const restarted = new SchemaRegistry();
    restarted.register(accountV1(), 'bidirectional');
    restarted.register(accountV2(), 'bidirectional');

    assert.deepEqual(restarted.listVersions(), ['acct-v1', 'acct-v2']);
    const adapter = new JsonMessageAdapter(restarted);

    const oldPayload: WireValue = { '1': 'mia', '2': 1234567890123456789n };
    const text = adapter.produce('acct-v1', oldPayload);
    const spool = join(dir, 'spool.jsonl');
    writeFileSync(spool, `${text}\n`, 'utf8');

    const line = readFileSync(spool, 'utf8').trim();
    const consumed = adapter.consume('acct-v1', 'acct-v2', line);
    assert.deepEqual(consumed, {
      '1': 'mia',
      '2': 1234567890123456789n,
      '3': 'USD',
    });
  });

  it('a poison message fails one consumer but never corrupts registered versions', () => {
    const registry = new SchemaRegistry();
    registry.register(accountV1(), 'bidirectional');
    registry.register(accountV2(), 'bidirectional');

    const poison = decodeWire(encodeWire({ '1': 'x', '2': 'not-a-bigint' }));
    assert.throws(
      () => registry.parseAcross('acct-v1', 'acct-v2', poison),
      (err: unknown) => err instanceof ParseError && err.reason === 'bad-i64',
    );

    // Healthy messages still convert immediately afterwards.
    assert.deepEqual(
      registry.parseAcross(
        'acct-v1',
        'acct-v2',
        { '1': 'y', '2': 5n },
      ),
      { '1': 'y', '2': 5n, '3': 'USD' },
    );
    assert.deepEqual(registry.listVersions(), ['acct-v1', 'acct-v2']);
  });
});
