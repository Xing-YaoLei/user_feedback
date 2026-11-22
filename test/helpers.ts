/**
 * Shared helpers for the test suites.
 */

import assert from 'node:assert/strict';
import type { BatchResult, EvaluationError, LiteralValue, MissingResult, ResultValue } from '../src/index.ts';
import { formatQuantity, quantityFromValue } from '../src/index.ts';

/** Extracts a successful value, failing the test otherwise. */
export function valueOf(result: BatchResult, path: string): ResultValue {
  const outcome = result.outcomes[path];
  assert.ok(outcome, `no outcome for "${path}"`);
  assert.ok(outcome.ok, `expected "${path}" to evaluate, got ${JSON.stringify(outcome)}`);
  return outcome.result;
}

export function errorOf(result: BatchResult, path: string): EvaluationError {
  const outcome = result.outcomes[path];
  assert.ok(outcome, `no outcome for "${path}"`);
  assert.ok(!outcome.ok && 'error' in outcome, `expected "${path}" to error`);
  return outcome.error;
}

export function missingOf(result: BatchResult, path: string): MissingResult {
  const outcome = result.outcomes[path];
  assert.ok(outcome, `no outcome for "${path}"`);
  assert.ok(!outcome.ok && 'missing' in outcome, `expected "${path}" to be missing`);
  return outcome.missing;
}

/** Renders a literal in a compact, human-readable form for assertions. */
export function render(value: LiteralValue): string {
  switch (value.kind) {
    case 'number':
      return formatQuantity(quantityFromValue(value));
    case 'null':
      return 'null';
    case 'string':
      return value.value;
    case 'boolean':
      return String(value.value);
  }
}

/** Count/dimension-agnostic numeric rendering without the unit suffix. */
export function amountOf(result: BatchResult, path: string): string {
  const value = valueOf(result, path).value;
  assert.equal(value.kind, 'number', `expected "${path}" to be numeric`);
  return render(value);
}
