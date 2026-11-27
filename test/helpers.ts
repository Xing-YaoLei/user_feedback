/**
 * Pure, transport-free adapters that turn plain data into `Receipt`s.
 *
 * Tests and examples use these so the module itself stays free of any clock,
 * I/O or transport concern: the caller always supplies `receivedAt`.
 */

import type {
  DeltaUpdate,
  InstanceRecord,
  Receipt,
  ServiceId,
  SnapshotUpdate,
  SourceUpdate,
} from "../src/types.ts";

/** A record map usable as snapshot input, as plain nested objects. */
export type PlainSnapshotRecords = Readonly<Record<ServiceId, Readonly<Record<string, InstanceRecord>>>>;

export function value(payload: unknown): InstanceRecord {
  return { kind: "value", value: payload };
}

export const TOMBSTONE: InstanceRecord = { kind: "tombstone" };

export function snapshot(
  sourceId: string,
  generation: number,
  sequence: number,
  ttlMs: number,
  records: PlainSnapshotRecords = {},
): SnapshotUpdate {
  const nested = new Map<ServiceId, Map<string, InstanceRecord>>();
  for (const [serviceId, byInstance] of Object.entries(records)) {
    nested.set(serviceId, new Map(Object.entries(byInstance)));
  }
  return { kind: "snapshot", sourceId, generation, sequence, ttlMs, records: nested };
}

export function delta(
  sourceId: string,
  generation: number,
  sequence: number,
  ttlMs: number,
  serviceId: string,
  instanceId: string,
  record: InstanceRecord | undefined,
): DeltaUpdate {
  return { kind: "delta", sourceId, generation, sequence, ttlMs, serviceId, instanceId, record };
}

export function at(receivedAt: number, update: SourceUpdate): Receipt {
  return { receivedAt, update };
}

/** Build a receipt list from update/timestamp pairs. */
export function batch(...receipts: Array<[number, SourceUpdate]>): Receipt[] {
  return receipts.map(([receivedAt, update]) => ({ receivedAt, update }));
}
