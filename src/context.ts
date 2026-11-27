/**
 * Current scope, carried through Node's AsyncLocalStorage.
 *
 * Because the enclosing scope lives in async context, two concurrent root
 * calls are independent: they each open their own scope, and a child scope
 * opened inside one root can never see the other root's cancellation.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Scope } from './scope.ts';

const storage = new AsyncLocalStorage<Scope>();

export function currentScope(): Scope | undefined {
  return storage.getStore();
}

export function runInScope<T>(scope: Scope, fn: () => T): T {
  return storage.run(scope, fn);
}
