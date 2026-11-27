/**
 * Human-readable walkthrough of the reproducible quota-transfer scenario.
 *
 *   node demo/transfer.ts
 *
 * Prints the fixed schedule, the coordinator's auditable records, the real
 * admission ledger, and the per-window budget check.  The same scenario is
 * asserted by test/network.test.ts, so this output can be compared directly
 * with what the tests verify.
 */

import { runTransferScenario, GLOBAL_LIMIT, TENANT_LIMITS } from '../src/scenario.ts';

const result = await runTransferScenario();

const line = (): void => console.log('─'.repeat(78));

console.log('\nQUOTA TRANSFER SCENARIO (fixed schedule, deterministic delivery)');
console.log(`window=${1000}ms  skew=10ms  global=${GLOBAL_LIMIT}  tenants=${JSON.stringify(TENANT_LIMITS)}`);
line();
console.log('SCHEDULE');
for (const step of result.steps) {
  console.log(`  t=${String(step.at).padStart(5)}  ${step.action.padEnd(42)} ${step.detail}`);
}

line();
console.log('COORDINATOR DECISIONS');
for (const record of result.coordinatorRecords) {
  switch (record.kind) {
    case 'borrow_granted':
      console.log(
        `  t=${String(record.at).padStart(5)}  GRANT    ${record.requestId} -> ${record.leaseId}` +
          `  amount=${record.amount}  window=${record.windowIndex}  reserved(global)=${record.globalReservedAfter}`,
      );
      break;
    case 'borrow_rejected':
      console.log(
        `  t=${String(record.at).padStart(5)}  REJECT   ${record.requestId}  reason=${record.reason}` +
          `  available(global)=${record.availableGlobal} available(tenant)=${record.availableTenant}`,
      );
      break;
    case 'return_accepted':
      console.log(
        `  t=${String(record.at).padStart(5)}  RETURN   ${record.returnId} on ${record.leaseId}` +
          `  credited=${record.credited}  window=${record.windowIndex}` +
          `  outstanding=${record.leaseOutstandingAfter}`,
      );
      break;
    case 'return_rejected':
      console.log(
        `  t=${String(record.at).padStart(5)}  RETURN✗  ${record.returnId} on ${record.leaseId}` +
          `  reason=${record.reason}  credited=${record.credited}`,
      );
      break;
    case 'consume':
      console.log(
        `  t=${String(record.at).padStart(5)}  CONSUME  ${record.nodeId}/g${record.generation}#${record.seq}` +
          `  cost=${record.cost}  tenant=${record.tenantId}  window=${record.windowIndex}` +
          `  (admitted at node reading ${record.consumedAt})`,
      );
      break;
  }
}

line();
console.log('REAL ADMISSIONS (local ledgers)');
for (const admission of result.admissions) {
  console.log(
    `  ${admission.nodeId}/g${admission.generation} #${admission.seq}` +
      `  lease=${admission.leaseId}  tenant=${admission.tenantId}` +
      `  cost=${admission.cost}  window=${admission.windowIndex}`,
  );
}

line();
console.log('PER-WINDOW BUDGET CHECK (from real admissions)');
for (const window of result.budget.windows) {
  const globalOk = window.total <= GLOBAL_LIMIT ? 'ok' : 'OVER';
  console.log(`  window ${window.windowIndex}: total=${window.total}/${GLOBAL_LIMIT}  [${globalOk}]`);
  for (const [tenant, consumed] of Object.entries(window.tenants)) {
    const limit = TENANT_LIMITS[tenant as keyof typeof TENANT_LIMITS];
    console.log(`    tenant ${tenant}: ${consumed}/${limit}  [${consumed <= limit ? 'ok' : 'OVER'}]`);
  }
}
console.log(
  result.budgetViolations.length === 0
    ? '  => no budget violations'
    : `  => VIOLATIONS: ${result.budgetViolations.join('; ')}`,
);

line();
console.log('KEY FACTS');
console.log(`  alpha return credited once:       ${result.facts.alphaReturnCredits.join(', ')}`);
console.log(`  duplicate return id replayed:     ${result.facts.duplicateConfirmIds.join(', ') || 'none'}`);
console.log(`  same units under a new id:        ${result.facts.repeatedUnitsReason}`);
console.log(`  alpha gen-1 lease:                ${JSON.stringify(result.facts.alphaG1Lease)}`);
console.log(`  alpha stop boundary:              ${JSON.stringify(result.facts.alphaReturnBoundary)}`);
console.log(`  duplicate grant kept local quota: ${result.facts.alphaGen2RemainingAfterDuplicate}`);
console.log(`  tenant A after return:            ${result.facts.availableAAfterReturn}`);
console.log(`  tenant A after redistribution:    ${result.facts.availableAAfterRedistribution}`);
console.log(`  stale old-window return:          ${JSON.stringify(result.facts.staleReturnReasons)}`);
console.log(`  retired-generation borrow:        ${JSON.stringify(result.facts.lateBorrowReasons)}`);
console.log(`  dead lease residue (window 0 B):  ${result.facts.deltaG1Lease.outstanding} of ${result.facts.deltaG1Lease.amount} unconfirmed`);
console.log(`  window 0 tenant B committed:      ${result.facts.window0BReserved}`);
console.log(`  window 0 tenant B consumed:       ${result.facts.window0BReportedConsumed}`);
console.log(`  window 1 B committed:             ${result.facts.window1BReserved}`);
console.log(`  generations accounted:            ${result.facts.reportedGenerations.join(', ')}`);
line();

if (result.budgetViolations.length > 0) process.exitCode = 1;
