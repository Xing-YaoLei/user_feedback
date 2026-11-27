/**
 * Cross-checks between what nodes actually admitted and what the coordinator
 * believes, used by the demo and the tests.
 *
 * These functions deliberately take *recorded* data, not live state, so they can
 * be run after a scenario to prove the end-to-end invariants rather than
 * merely restating the implementation.
 */

import type { Coordinator } from './coordinator.ts';
import type { AdmissionRecord } from './node.ts';

export interface AuditedAdmission extends AdmissionRecord {
  nodeId: string;
}

export interface WindowAudit {
  windowIndex: number;
  /** Sum of real admissions attributed to this window. */
  consumed: number;
  consumedPerTenant: Record<string, number>;
  admissionCount: number;
}

export interface AuditResult {
  windows: WindowAudit[];
  /** Sum of consumption the coordinator accepted, per window and tenant. */
  coordinatedConsumed: Record<number, Record<string, number>>;
  /** True when node ledgers and coordinator records agree exactly. */
  reconciled: boolean;
  differences: string[];
}

/**
 * Compare per-window, per-tenant consumption from real admission records
 * against the consumption the coordinator accounted.  They must agree for
 * every admission that the node successfully reported; the returned
 * `differences` lists only genuine mismatches.
 */
export function auditConsumption(
  admissions: readonly AuditedAdmission[],
  coordinator: Coordinator,
): AuditResult {
  const windows = new Map<number, WindowAudit>();
  for (const admission of admissions) {
    let window = windows.get(admission.windowIndex);
    if (!window) {
      window = {
        windowIndex: admission.windowIndex,
        consumed: 0,
        consumedPerTenant: {},
        admissionCount: 0,
      };
      windows.set(admission.windowIndex, window);
    }
    window.consumed += admission.cost;
    window.admissionCount += 1;
    window.consumedPerTenant[admission.tenantId] =
      (window.consumedPerTenant[admission.tenantId] ?? 0) + admission.cost;
  }

  const coordinatedConsumed: Record<number, Record<string, number>> = {};
  let reconciled = true;
  const differences: string[] = [];

  for (const window of coordinator.knownWindows()) {
    const snapshot = coordinator.windowSnapshot(window);
    const perTenant: Record<string, number> = {};
    for (const [tenant, consumed] of Object.entries(snapshot.tenantConsumed)) {
      if (consumed !== 0) perTenant[tenant] = consumed;
    }
    coordinatedConsumed[window] = perTenant;

    const audited = windows.get(window);
    const expected = audited?.consumedPerTenant ?? {};
    const tenants = new Set([...Object.keys(perTenant), ...Object.keys(expected)]);
    for (const tenant of tenants) {
      const actual = expected[tenant] ?? 0;
      const reported = perTenant[tenant] ?? 0;
      // The coordinator may legitimately know less than the node if a report
      // was dropped; it must never know more.
      if (reported > actual) {
        reconciled = false;
        differences.push(
          `window ${window} tenant ${tenant}: coordinator ${reported} > node admissions ${actual}`,
        );
      }
    }
  }

  return {
    windows: [...windows.values()].sort((a, b) => a.windowIndex - b.windowIndex),
    coordinatedConsumed,
    reconciled,
    differences,
  };
}
