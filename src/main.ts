#!/usr/bin/env node
import { runServerCli } from './server.ts';

runServerCli(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`gateway failed to start: ${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
