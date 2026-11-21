/**
 * Presence index for `exists` predicates on one field path.
 *
 * One shared set of atoms per path. A query for an event looks up the paths
 * present in the event, so a path that is absent is never scanned. This is the
 * index that makes `NOT exists` affordable without evaluating anything.
 */

export class PresenceIndex {
  private readonly byPath = new Map<string, Set<number>>();
  private atomCount = 0;

  get size(): number {
    return this.atomCount;
  }

  get pathCount(): number {
    return this.byPath.size;
  }

  add(atomId: number, pathKey: string): void {
    let atoms = this.byPath.get(pathKey);
    if (atoms === undefined) {
      atoms = new Set();
      this.byPath.set(pathKey, atoms);
    }
    if (!atoms.has(atomId)) {
      atoms.add(atomId);
      this.atomCount += 1;
    }
  }

  remove(atomId: number, pathKey: string): void {
    const atoms = this.byPath.get(pathKey);
    if (atoms === undefined || !atoms.delete(atomId)) return;
    this.atomCount -= 1;
    if (atoms.size === 0) this.byPath.delete(pathKey);
  }

  /** Atoms registered for a present path. */
  query(pathKey: string, out: Set<number>): number {
    const atoms = this.byPath.get(pathKey);
    if (atoms === undefined) return 0;
    let visits = 0;
    for (const atomId of atoms) {
      out.add(atomId);
      visits += 1;
    }
    return visits + 1;
  }

  /** Atoms registered for a path that is absent in this event. */
  queryAbsent(pathKey: string, out: Set<number>): number {
    let visits = 0;
    for (const [key, atoms] of this.byPath) {
      if (key === pathKey) continue;
      for (const atomId of atoms) {
        out.add(atomId);
        visits += 1;
      }
    }
    return visits;
  }

  clear(): void {
    this.byPath.clear();
    this.atomCount = 0;
  }

  paths(): string[] {
    return [...this.byPath.keys()];
  }
}
