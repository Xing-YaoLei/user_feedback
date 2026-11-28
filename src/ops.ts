/**
 * Operator CLI for reconciliation, inspection and payload reclamation.
 *
 * Talks to a live manager over the same NDJSON RPC socket, so the single
 * writer is preserved (no second process touches the state directory).
 *
 * Usage:
 *   node src/ops.ts --endpoint <endpoint.json> list
 *   node src/ops.ts --endpoint <endpoint.json> show --ticket <id>
 *   node src/ops.ts --endpoint <endpoint.json> key --tenant t --method m --key k
 *   node src/ops.ts --endpoint <endpoint.json> reconcile --ticket <id> --proof <json|@file>
 *   node src/ops.ts --endpoint <endpoint.json> reclaim --ticket <id> [--reason admin|ttl]
 *   node src/ops.ts --endpoint <endpoint.json> reclaim-expired
 */
import { readFileSync } from 'node:fs';
import { GatewayClient } from './client.ts';
import { asGatewayError, InvalidInputError } from './errors.ts';
import type { ReconciliationProof } from './types.ts';

interface Parsed {
  flags: Map<string, string>;
  positional: string[];
}

function parse(argv: string[]): Parsed {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      flags.set(arg.slice(2), 'true');
      continue;
    }
    flags.set(arg.slice(2), value);
    i += 1;
  }
  return { flags, positional };
}

function required(parsed: Parsed, name: string): string {
  const value = parsed.flags.get(name);
  if (!value) throw new InvalidInputError(`--${name} is required`);
  return value;
}

function readProof(spec: string): ReconciliationProof {
  const text = spec.startsWith('@') ? readFileSync(spec.slice(1), 'utf8') : spec;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new InvalidInputError(`--proof must be JSON (or @file): ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new InvalidInputError('--proof must be a JSON object');
  return parsed as ReconciliationProof;
}

export async function runOpsCli(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  const endpointFile = parsed.flags.get('endpoint');
  if (!endpointFile) throw new InvalidInputError('--endpoint <endpoint.json> is required');
  const command = parsed.positional[0];
  if (!command) throw new InvalidInputError('a command is required (list|show|key|reconcile|reclaim|reclaim-expired)');

  const client = GatewayClient.fromFile(endpointFile, {
    timeoutMs: Number(parsed.flags.get('timeout-ms') ?? 30_000),
  });
  try {
    switch (command) {
      case 'list': {
        const tickets = await client.tickets();
        printJson(tickets);
        return 0;
      }
      case 'show': {
        const tickets = await client.tickets();
        const id = required(parsed, 'ticket');
        const ticket = tickets.find((t) => t.ticketId === id);
        if (!ticket) {
          // Errors always go to stderr as JSON, so stdout is machine-readable
          // success output only.
          printJson({ error: { code: 'TICKET_NOT_FOUND', message: `ticket ${id} does not exist`, details: { ticketId: id } } }, 'stderr');
          return 2;
        }
        printJson(ticket);
        return 0;
      }
      case 'key': {
        const view = await client.inspect({
          tenant: required(parsed, 'tenant'),
          method: required(parsed, 'method'),
          idempotencyKey: required(parsed, 'key'),
        });
        printJson(view);
        return 0;
      }
      case 'reconcile': {
        const view = await client.reconcile({
          ticketId: required(parsed, 'ticket'),
          proof: readProof(required(parsed, 'proof')),
        });
        printJson(view);
        return 0;
      }
      case 'reclaim': {
        const result = await client.reclaim(
          required(parsed, 'ticket'),
          parsed.flags.get('reason') === 'ttl' ? 'ttl' : 'admin',
        );
        printJson(result);
        return 0;
      }
      case 'reclaim-expired': {
        printJson(await client.reclaimExpired());
        return 0;
      }
      default:
        throw new InvalidInputError(`unknown command '${command}'`);
    }
  } finally {
    client.close();
  }
}

function printJson(value: unknown, stream: 'stdout' | 'stderr' = 'stdout'): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (stream === 'stderr') process.stderr.write(text);
  else process.stdout.write(text);
}

const isDirectRun =
  process.argv[1] !== undefined && process.argv[1].endsWith('ops.ts');

if (isDirectRun) {
  runOpsCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const gatewayError = asGatewayError(err);
      process.stderr.write(`${JSON.stringify(gatewayError.toJSON(), null, 2)}\n`);
      process.exit(1);
    },
  );
}
