import { InvalidArgumentError } from './errors.ts';
import type { InstanceInput, InstanceView, Revision } from './types.ts';

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE_CAP = 10000;

export function assertRevision(value: unknown, label: string): Revision {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidArgumentError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidArgumentError(`${label} must be a non-empty string`);
  }
  return value;
}

export function assertPositiveInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidArgumentError(`${label} must be a positive integer`);
  }
  return value;
}

export function assertNonNegativeInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidArgumentError(`${label} must be a non-negative integer`);
  }
  return value;
}

export function normalizePrefix(prefix: unknown): string {
  if (prefix === undefined || prefix === null) {
    return '';
  }
  if (typeof prefix !== 'string') {
    throw new InvalidArgumentError('prefix must be a string');
  }
  return prefix;
}

export function normalizePageSize(value: unknown, fallback: number, max: number): number {
  const requested = value === undefined ? fallback : assertPositiveInt(value, 'pageSize', fallback);
  if (requested > max) {
    throw new InvalidArgumentError(`pageSize ${requested} exceeds the directory maximum of ${max}`);
  }
  return requested;
}

/** Code-unit order, explicitly, so ordering never depends on locale. */
export function compareNames(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function sortInstances(items: Iterable<InstanceView>): InstanceView[] {
  return Array.from(items).sort((a, b) => compareNames(a.name, b.name));
}

export function freezeMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (metadata === undefined) {
    return Object.freeze({});
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new InvalidArgumentError('metadata must be a plain object of string values');
  }
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') {
      throw new InvalidArgumentError(`metadata value for "${key}" must be a string`);
    }
    copy[key] = value;
  }
  return Object.freeze(copy);
}

export interface NormalizedInput {
  name: string;
  address: string | null;
  weight: number;
  metadata: Readonly<Record<string, string>>;
}

export function normalizeInput(input: InstanceInput): NormalizedInput {
  if (typeof input !== 'object' || input === null) {
    throw new InvalidArgumentError('each registration must be an object');
  }
  const name = assertNonEmptyString(input.name, 'instance name');
  let address: string | null = null;
  if (input.address !== undefined && input.address !== null) {
    if (typeof input.address !== 'string') {
      throw new InvalidArgumentError(`address for "${name}" must be a string or null`);
    }
    address = input.address;
  }
  let weight = 1;
  if (input.weight !== undefined) {
    if (typeof input.weight !== 'number' || !Number.isFinite(input.weight) || input.weight < 0) {
      throw new InvalidArgumentError(`weight for "${name}" must be a finite non-negative number`);
    }
    weight = input.weight;
  }
  return { name, address, weight, metadata: freezeMetadata(input.metadata) };
}

export function cloneInstance(instance: InstanceView): InstanceView {
  return {
    name: instance.name,
    address: instance.address,
    weight: instance.weight,
    metadata: Object.freeze({ ...instance.metadata }),
    sessionId: instance.sessionId,
    sessionGeneration: instance.sessionGeneration,
    generation: instance.generation,
    leaseId: instance.leaseId,
    registeredRevision: instance.registeredRevision,
  };
}
