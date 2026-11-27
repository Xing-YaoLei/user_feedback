/**
 * JSON adapter and CLI tests.
 *
 * JSON cannot carry bigint, so the adapters render quantities as decimal
 * strings on the way out, and accept strings or safe numbers on the way in.
 * These tests pin that contract and exercise the CLI end to end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromJson, toJson } from '../src/json.ts';
import { plan } from '../src/planner.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'src', 'cli.ts');
// Test scratch space lives inside the project (under test/.tmp) so that all
// temporary data stays within the workspace rather than the system temp dir.
const scratchRoot = join(here, '.tmp');

function makeScratch(prefix: string): string {
  mkdirSync(scratchRoot, { recursive: true });
  return mkdtempSync(join(scratchRoot, prefix));
}

test('toJson renders every quantity as a decimal string', () => {
  const result = plan({
    sources: [{ id: 's', demand: 10n ** 20n }],
    clusters: [{ id: 'c', capacity: 10n ** 19n }],
    edges: [{ source: 's', cluster: 'c', cost: 10n ** 10n }],
  });
  const json = toJson(result);
  assert.equal(json.summary.served, '10000000000000000000');
  assert.equal(json.summary.unserved, '90000000000000000000');
  assert.equal(json.summary.totalCost, '100000000000000000000000000000');
  assert.equal(json.assignments[0]!.requests, '10000000000000000000');
  assert.equal(json.cut!.cutCapacity, '10000000000000000000');
  // Must survive JSON.stringify with no bigint leakage.
  const roundTripped = JSON.parse(JSON.stringify(json));
  assert.equal(roundTripped.summary.served, '10000000000000000000');
});

test('fromJson accepts both numbers and decimal strings', () => {
  const result = fromJson({
    sources: [{ id: 's', demand: '5' }],
    clusters: [{ id: 'c', capacity: 5 }],
    edges: [{ source: 's', cluster: 'c', cost: '2' }],
  });
  assert.equal(result.summary.served, '5');
  assert.equal(result.summary.totalCost, '10');
});

test('the CLI reads JSON from a file and prints JSON to stdout', () => {
  const dir = makeScratch('mesh-plan-');
  try {
    const inputPath = join(dir, 'input.json');
    writeFileSync(
      inputPath,
      JSON.stringify({
        sources: [
          { id: 'us', demand: '1200' },
          { id: 'eu', demand: '800' },
        ],
        clusters: [
          { id: 'us-c', capacity: '1000' },
          { id: 'eu-c', capacity: '900' },
        ],
        edges: [
          { source: 'us', cluster: 'us-c', cost: '0' },
          { source: 'us', cluster: 'eu-c', cost: '5' },
          { source: 'eu', cluster: 'eu-c', cost: '0' },
        ],
      }),
    );
    const stdout = execFileSync(process.execPath, [cliPath, inputPath], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.summary.served, '1900');
    assert.equal(parsed.summary.unserved, '100');
    assert.equal(parsed.summary.totalCost, '500');
    assert.equal(parsed.cut.cutCapacity, '1900');
    assert.equal(parsed.cut.tight, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits non-zero on malformed JSON', () => {
  const dir = makeScratch('mesh-plan-bad-');
  try {
    const inputPath = join(dir, 'input.json');
    writeFileSync(inputPath, '{ not json ');
    assert.throws(
      () =>
        execFileSync(process.execPath, [cliPath, inputPath], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const status = (error as { status?: number }).status;
        assert.equal(status, 1);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits non-zero when the input is semantically invalid', () => {
  const dir = makeScratch('mesh-plan-invalid-');
  try {
    const inputPath = join(dir, 'input.json');
    writeFileSync(
      inputPath,
      JSON.stringify({
        sources: [{ id: 'a', demand: '1' }],
        clusters: [{ id: 'c', capacity: '1' }],
        edges: [{ source: 'a', cluster: 'ghost', cost: '0' }],
      }),
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [cliPath, inputPath], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { status?: number }).status, 1);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
