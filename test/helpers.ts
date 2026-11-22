import assert from 'node:assert/strict';
import type { Schema, TypePath, WireValue } from '../src/types.ts';
import { CompatibilityError, ParseError, renderPath } from '../src/errors.ts';
import type { SchemaRegistry } from '../src/registry.ts';
import { decodeWire, encodeWire } from '../src/wire.ts';
import { validateSchema } from '../src/validate.ts';
import { CompatChecker, buildCounterexample } from '../src/compat.ts';
import { buildPlan } from '../src/plan.ts';

export function ref(name: string): Type {
  return { kind: 'ref', name };
}

export function sameRoute(actual: TypePath, expected: TypePath): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((step, i) => {
    const want = expected[i];
    if (step.kind !== want.kind) return false;
    switch (step.kind) {
      case 'field':
        return step.id === (want as { id: number }).id;
      case 'array-item':
        return step.index === (want as { index: number }).index;
      case 'union-branch':
        return step.tag === (want as { tag: string }).tag;
      default:
        return true;
    }
  });
}

/**
 * The standard counterexample harness used across tests: static analysis
 * must reject the pair, and its finite counterexample must reproduce the
 * same reason and route when (a) fed directly to the parsing entry and
 * (b) JSON round-tripped through the encoder first.
 */
export function assertCounterexampleReproduces(
  registry: SchemaRegistry,
  writerVersion: string,
  readerVersion: string,
): CompatibilityError {
  let analysisError: CompatibilityError | undefined;
  try {
    registry.analyze(writerVersion, readerVersion);
    assert.fail('expected analyze() to throw CompatibilityError');
  } catch (err) {
    assert.ok(err instanceof CompatibilityError);
    analysisError = err;
  }

  const counterexample = analysisError.counterexample as WireValue;
  for (const message of [counterexample, decodeWire(encodeWire(counterexample))]) {
    try {
      registry.parseAcross(writerVersion, readerVersion, message);
      assert.fail(
        `counterexample for ${analysisError.reason} was parsed successfully`,
      );
    } catch (err) {
      assert.ok(err instanceof ParseError, 'expected a ParseError');
      assert.equal(err.reason, analysisError.reason);
      assert.ok(
        sameRoute(err.path, analysisError.path),
        `runtime path ${JSON.stringify(err.path)} != static path ${JSON.stringify(analysisError.path)}`,
      );
    }
  }
  return analysisError;
}

export function mustFailRegistration(
  registry: SchemaRegistry,
  schema: Schema,
  direction: 'backward' | 'forward' | 'bidirectional',
): CompatibilityError {
  const before = registry.listVersions();
  let caught: CompatibilityError | undefined;
  try {
    registry.register(schema, direction);
    assert.fail('expected registration to fail');
  } catch (err) {
    assert.ok(err instanceof CompatibilityError);
    caught = err;
  }
  // Failed registration preserves the original version set.
  assert.deepEqual(registry.listVersions(), before);
  return caught;
}

/**
 * Analyze an arbitrary ordered pair of schemas without requiring them to
 * coexist in a registry (needed for pairs that are incompatible in both
 * directions and therefore cannot be registered together under any policy).
 * Returns the CompatibilityError whose counterexample is proven to reproduce.
 */
export function analyzeStandalonePair(
  writerSchema: Schema,
  readerSchema: Schema,
): CompatibilityError {
  const writer = validateSchema(writerSchema);
  const reader = validateSchema(readerSchema);
  const outcome = new CompatChecker(writer, reader).checkRoot();
  assert.equal(outcome.ok, false, 'expected the standalone pair to be incompatible');
  if (outcome.ok) throw new Error('unreachable');
  const failure = outcome.failure;
  const counterexample = buildCounterexample(
    writer,
    writer.schema.root,
    failure.path,
    failure.counterexample,
  );
  const error = new CompatibilityError(
    `standalone pair: ${failure.reason} at ${renderPath(failure.path)}`,
    failure.reason,
    failure.path,
    writer.schema.version,
    reader.schema.version,
    counterexample,
  );

  // Execute the best-effort plan and prove the counterexample reproduces.
  const plan = buildPlan(writer, reader);
  for (const message of [
    counterexample,
    decodeWire(encodeWire(counterexample)),
  ]) {
    try {
      plan.convert(message);
      assert.fail('counterexample was converted successfully');
    } catch (err) {
      assert.ok(err instanceof ParseError);
      assert.equal(err.reason, error.reason);
      assert.ok(sameRoute(err.path, error.path));
    }
  }
  return error;
}
