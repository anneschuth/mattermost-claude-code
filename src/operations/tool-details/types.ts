/**
 * Where the full tool stream goes when the reply only shows a summary line
 * (or nothing). See docs/quiet-tools-spec.md § Details sinks.
 */

import type { ToolActivityOp } from '../types.js';
import type { ExecutorContext } from '../executors/types.js';

export type ToolActivityEvent = Extract<ToolActivityOp, { kind: 'start' | 'end' }>;

export interface ToolDetailsSink {
  /** One rendered tool line (the same text `full` mode would have shown inline). */
  append(op: ToolActivityEvent, ctx: ExecutorContext): Promise<void>;
  /** The turn's reply is final; flush and close whatever this turn's details are. */
  turnEnded(ctx: ExecutorContext): Promise<void>;
  /** A link the summary line can carry, once known; `null` when there is none. */
  link(): string | null;
  /** Session restart mid-turn: forget this turn's queue and context. */
  reset(): void;
}

/** `toolDetails: none` — the stream is dropped. */
export const noneSink: ToolDetailsSink = {
  append: async () => undefined,
  turnEnded: async () => undefined,
  link: () => null,
  reset: () => undefined,
};
