import type { MemberState, MemberUpdate, MergeDecision, NodeIdentity } from './types.ts';
import { TERMINAL_STATES } from './types.ts';

/**
 * Priority of states when incarnation and seq are equal.
 * Within one incarnation:
 *   - leave dominates dead, and both terminate the identity;
 *   - suspected dominates alive (same seq), so a suspicion is not erased
 *     by a stale alive gossip;
 * which matches: same-seq suspicion-over-alive, leave-over-dead.
 */
function stateRank(state: MemberState): number {
  switch (state) {
    case 'alive':
      return 0;
    case 'suspected':
      return 1;
    case 'dead':
      return 2;
    case 'left':
      return 3;
  }
}

export function sameIdentity(a: NodeIdentity, b: NodeIdentity): boolean {
  return a.id === b.id && a.incarnation === b.incarnation && a.seq === b.seq;
}

/**
 * Compare two records of the SAME member id.
 * Returns >0 when `a` is strictly newer/stronger, 0 when equivalent,
 * <0 when `b` is stronger.
 *
 * Ordering rules:
 *  1. A strictly greater incarnation overrides everything (restart).
 *  2. Within the same incarnation, terminal states (dead/left) close the
 *     identity and cannot be overridden inside that incarnation; leave wins
 *     over dead if both terminal records are seen.
 *  3. Otherwise compare alive-declaration seq (refutation via higher seq).
 *  4. Same seq: suspected > alive; dead > suspected; left > dead.
 */
export function compareEntries(a: MemberUpdate, b: MemberUpdate): number {
  if (a.id !== b.id) {
    throw new Error(`compareEntries called with different ids: ${a.id} vs ${b.id}`);
  }
  if (a.incarnation !== b.incarnation) {
    return a.incarnation > b.incarnation ? 1 : -1;
  }
  const aTerminal = TERMINAL_STATES.has(a.state);
  const bTerminal = TERMINAL_STATES.has(b.state);
  if (aTerminal && bTerminal) {
    return stateRank(a.state) - stateRank(b.state);
  }
  if (aTerminal || bTerminal) {
    // The terminal record always wins within the same incarnation.
    return aTerminal ? 1 : -1;
  }
  if (a.seq !== b.seq) {
    return a.seq > b.seq ? 1 : -1;
  }
  return stateRank(a.state) - stateRank(b.state);
}

/** True when `incoming` would change the local view for its member. */
export function isNewer(incoming: MemberUpdate, local: MemberUpdate | undefined): boolean {
  if (!local) return true;
  return compareEntries(incoming, local) > 0;
}

function classifyAccept(incoming: MemberUpdate, previous: MemberUpdate | undefined): MergeDecision['reason'] {
  if (!previous) return 'new-entry';
  if (incoming.incarnation > previous.incarnation) return 'incarnation-override';
  if (incoming.incarnation < previous.incarnation) return 'rejected-incarnation';
  if (incoming.seq > previous.seq) return 'replaced-older';
  if (incoming.seq < previous.seq) return 'rejected-stale';
  // Same incarnation, same seq.
  if (incoming.state === 'suspected' && previous.state === 'alive') {
    return 'suspect-over-alive-same-seq';
  }
  return 'replaced-older';
}

/**
 * Merge one incoming update into a local view map.
 *
 * The map is mutated in place. The returned decision explains the outcome so
 * callers can audit every suspicion / refutation / death decision.
 *
 * Key guarantee: re-receiving the SAME suspicion is a duplicate no-op and
 * never refreshes `suspectDeadline`, so repeated gossip cannot extend the
 * suspicion window.
 */
export function mergeUpdate(
  view: Map<string, MemberUpdate>,
  incoming: MemberUpdate,
): MergeDecision {
  const previous = view.get(incoming.id);
  if (!previous) {
    view.set(incoming.id, { ...incoming });
    return { accepted: true, reason: 'new-entry' };
  }

  const cmp = compareEntries(incoming, previous);
  if (cmp < 0) {
    // Old incarnation, old seq, or weaker same-incarnation state: discard.
    // Late acks / stale gossip can never resurrect a closed or newer identity.
    return {
      accepted: false,
      reason:
        incoming.incarnation < previous.incarnation ? 'rejected-incarnation' : 'rejected-stale',
      previous,
    };
  }
  if (cmp === 0) {
    if (
      incoming.state === 'suspected' &&
      previous.state === 'suspected' &&
      incoming.seq === previous.seq &&
      incoming.incarnation === previous.incarnation
    ) {
      // Duplicate suspicion: keep the ORIGINAL deadline. No extension.
      return { accepted: false, reason: 'duplicate-noop', previous };
    }
    // Equivalent strength otherwise (e.g. identical records): nothing to do.
    return { accepted: false, reason: 'duplicate-noop', previous };
  }

  const reason = classifyAccept(incoming, previous);
  // A terminal record can only be replaced inside the same incarnation by a
  // stronger terminal record (left > dead). A strictly greater incarnation
  // always overrides (restart with a new identity). compareEntries already
  // enforces this ordering; everything else reaching here with a terminal
  // predecessor is rejected.
  if (TERMINAL_STATES.has(previous.state) && incoming.incarnation === previous.incarnation) {
    if (!TERMINAL_STATES.has(incoming.state)) {
      return { accepted: false, reason: 'rejected-terminal', previous };
    }
  }

  view.set(incoming.id, { ...incoming });
  return { accepted: true, reason, previous };
}

/** Is the given identity exactly the member's current known identity? */
export function identityMatches(update: MemberUpdate | undefined, id: NodeIdentity): boolean {
  return !!update && sameIdentity(update, id);
}
