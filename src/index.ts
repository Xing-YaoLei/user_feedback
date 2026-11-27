/**
 * Public entry point for the batched configuration release controller.
 */
export { ConfigReleaseController } from './controller.ts';
export type { ControllerOptions, TickResult } from './controller.ts';
export { InMemoryInstanceAdapter } from './adapter.ts';
export type { AdapterOptions, DeliveryMode } from './adapter.ts';
export { ManualClock, cloneConfig } from './clock.ts';
export type * from './types.ts';
