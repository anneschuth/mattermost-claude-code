/**
 * `toolDetails: thread`: the tool stream is posted as replies under the
 * turn's post, streamed by a ContentExecutor of its own — same edit-in-place
 * and splitting as the reply, none of its bookkeeping (no task-list bumps,
 * no "latest message" updates; see docs/quiet-tools-spec.md).
 *
 * The root post may not exist when the first tool starts (the summary header
 * creates it on the next flush), so lines queue until a context is available.
 */

import { ContentExecutor } from '../executors/content.js';
import type { ExecutorContext } from '../executors/types.js';
import { createAppendContentOp, createFlushOp } from '../types.js';
import type { ToolDetailsSink } from './types.js';

export interface ThreadSinkDeps {
  /** A context whose createPost posts under this turn's root, or null while there is no root yet. */
  contextFor: () => ExecutorContext | null;
  /** A fresh executor per turn (each turn has its own root). */
  makeExecutor: () => ContentExecutor;
}

export function createThreadSink(deps: ThreadSinkDeps): ToolDetailsSink {
  let queued: string[] = [];
  let executor: ContentExecutor | null = null;
  let detailsCtx: ExecutorContext | null = null;

  async function drain(): Promise<void> {
    if (queued.length === 0) return;
    detailsCtx ??= deps.contextFor();
    if (!detailsCtx) return;
    executor ??= deps.makeExecutor();
    const lines = queued;
    queued = [];
    for (const line of lines) {
      await executor.executeAppend(createAppendContentOp(detailsCtx.sessionId, line, true), detailsCtx);
    }
    executor.scheduleFlush(detailsCtx);
  }

  return {
    async append(op) {
      queued.push(op.display);
      await drain();
    },
    async turnEnded(ctx) {
      await drain();
      if (executor && detailsCtx) {
        await executor.executeFlush(createFlushOp(detailsCtx.sessionId, 'result'), detailsCtx);
        executor.closeCurrentPost(detailsCtx);
      }
      if (queued.length > 0) {
        // Only possible when the turn produced no post at all to hang a
        // thread on; say so rather than pretend the stream was delivered.
        ctx.logger.warn(`tool details: ${queued.length} line(s) dropped, the turn has no post to thread under`);
        queued = [];
      }
      executor = null;
      detailsCtx = null;
    },
    link: () => null,
    reset() {
      queued = [];
      executor?.reset();
      executor = null;
      detailsCtx = null;
    },
  };
}
