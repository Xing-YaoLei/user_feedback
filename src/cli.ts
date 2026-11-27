#!/usr/bin/env node
/**
 * Command-line front end.
 *
 *   node src/cli.ts < input.json
 *   node src/cli.ts path/to/input.json
 *
 * Reads a JSON plan document (quantities may be numbers or decimal strings)
 * and prints the result as JSON with all quantities rendered as decimal
 * strings, so huge values survive the round-trip. Exit code is non-zero on
 * malformed input.
 */

import { readFileSync } from 'node:fs';
import { fromJson } from './json.ts';
import type { PlanJson } from './json.ts';

function readInput(argv: readonly string[]): string {
  const path = argv[0];
  if (path === undefined) {
    return readFileSync(0, 'utf8');
  }
  return readFileSync(path, 'utf8');
}

function main(): void {
  const raw = readInput(process.argv.slice(2));
  let document: PlanJson;
  try {
    document = JSON.parse(raw) as PlanJson;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`invalid JSON: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = fromJson(document);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`planning failed: ${message}\n`);
    process.exitCode = 1;
  }
}

main();
