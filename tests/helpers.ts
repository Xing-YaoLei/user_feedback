import { InMemoryLogAdapter } from '../src/adapters/in-memory.ts';
import { LongPollReader } from '../src/reader.ts';
import type { ReadResult } from '../src/types.ts';

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function makeReader(names: readonly string[] = ['a', 'b']): {
  adapter: InMemoryLogAdapter;
  reader: LongPollReader;
} {
  const adapter = new InMemoryLogAdapter(names);
  return { adapter, reader: new LongPollReader(adapter) };
}

export function valuesOf(result: ReadResult, partition: string): unknown[] {
  const part = result.partitions.find((entry) => entry.partition === partition);
  if (part === undefined) throw new Error(`no partition ${partition} in result`);
  return part.records.map((record) => record.value);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
