/**
 * Test helpers: a scripted, fully local transport adapter with no external
 * services. Each address is backed by a handler that decides whether to
 * execute the request, redirect with a hint, fail, or hang.
 */

import type {
  OwnerHint,
  TransportAdapter,
  TransportRequest,
  TransportResponse,
} from '../src/index.ts';

export interface SeenAttempt {
  address: string;
  key: number;
  payload: unknown;
  attempt: number;
  generation: number | null;
}

export type Handler = (
  request: TransportRequest,
  signal: AbortSignal,
  attempt: SeenAttempt,
) => Promise<TransportResponse> | TransportResponse;

export interface ScriptedTransport extends TransportAdapter {
  /** Every attempt in arrival order, across all concurrent calls. */
  readonly log: SeenAttempt[];
  setHandler(address: string, handler: Handler): void;
  /** Addresses contacted for a given key, in order. */
  addressesForKey(key: number): string[];
}

export function createScriptedTransport(
  handlers: Record<string, Handler> = {},
): ScriptedTransport {
  const registry = new Map<string, Handler>(Object.entries(handlers));
  const log: SeenAttempt[] = [];

  return {
    log,
    setHandler(address, handler) {
      registry.set(address, handler);
    },
    addressesForKey(key) {
      return log.filter((entry) => entry.key === key).map((entry) => entry.address);
    },
    async send(request, signal) {
      const seen: SeenAttempt = {
        address: request.address,
        key: request.key,
        payload: request.payload,
        attempt: request.attempt,
        generation: request.generation,
      };
      log.push(seen);

      const handler = registry.get(request.address);
      if (handler === undefined) {
        throw new Error(`no handler for address ${request.address}`);
      }
      return await handler(request, signal, seen);
    },
  };
}

/** Handler that executes immediately with a chosen value. */
export function ok<TValue>(value: TValue): Handler {
  return () => ({ kind: 'ok', value });
}

/** Handler that always redirects with the given hint. */
export function redirect(hint: OwnerHint): Handler {
  return () => ({ kind: 'redirect', hint });
}

/** Handler that fails the transport for this attempt. */
export function fail(message: string): Handler {
  return () => {
    throw new Error(message);
  };
}

/** Handler that waits until aborted, then rejects. */
export const hang: Handler = (_request, signal) =>
  new Promise<TransportResponse>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });

/**
 * Deferred helper for tests that need to interleave two in-flight calls:
 * the handler parks until the test releases it.
 */
export function gate<T = void>(): {
  promise: Promise<T>;
  open(value?: T): void;
} {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open: (value?: T) => open(value as T) };
}
