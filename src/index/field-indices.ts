/**
 * Field-scoped indices.
 *
 * Every atom is tagged with its field path and indexed inside a per-path
 * container. Routing only touches containers for paths whose atoms take part
 * in the expression graph, and within a container only the buckets selected by
 * the event's value. Paths absent from the event are not visited through the
 * positive indices at all.
 */

import { EqualityIndex } from "./equality-index.ts";
import { PrefixIndex } from "./prefix-index.ts";
import { PresenceIndex } from "./presence-index.ts";
import { RangeIndex } from "./range-index.ts";
import type { JsonPrimitive } from "../types.ts";

export class FieldIndices {
  readonly presence = new PresenceIndex();
  readonly equality = new EqualityIndex();
  readonly ranges = new RangeIndex();
  readonly prefixes = new PrefixIndex();

  /** Per-atom registration records, so removal is exact. */
  private readonly registrations = new Map<number, Registration>();

  add(atomId: number, atom: AtomForIndex): void {
    const registration: Registration = { atomId, atom };
    this.registrations.set(atomId, registration);
    switch (atom.op) {
      case "exists":
        this.presence.add(atomId, atom.pathKey);
        return;
      case "eq":
        this.equality.add(atomId, atom.value);
        return;
      case "range":
        this.ranges.add({ id: atomId, min: atom.min, max: atom.max });
        return;
      case "prefix":
        this.prefixes.add(atomId, atom.prefix);
        return;
    }
  }

  remove(atomId: number): boolean {
    const registration = this.registrations.get(atomId);
    if (registration === undefined) return false;
    this.registrations.delete(atomId);
    const atom = registration.atom;
    switch (atom.op) {
      case "exists":
        this.presence.remove(atomId, atom.pathKey);
        return true;
      case "eq":
        this.equality.remove(atomId, atom.value);
        return true;
      case "range":
        this.ranges.remove({ id: atomId, min: atom.min, max: atom.max });
        return true;
      case "prefix":
        this.prefixes.remove(atomId, atom.prefix);
        return true;
    }
  }

  get atomCount(): number {
    return this.registrations.size;
  }

  clear(): void {
    this.presence.clear();
    this.equality.clear();
    this.ranges.clear();
    this.prefixes.clear();
    this.registrations.clear();
  }
}

export type IndexedAtom =
  | { op: "exists"; pathKey: string }
  | { op: "eq"; value: JsonPrimitive }
  | { op: "range"; min: number | null; max: number | null }
  | { op: "prefix"; prefix: string };

type AtomForIndex = IndexedAtom;

type Registration = {
  atomId: number;
  atom: AtomForIndex;
};
