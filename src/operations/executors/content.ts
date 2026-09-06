/**
 * Content Executor - Handles AppendContentOp and FlushOp
 *
 * Responsible for:
 * - Accumulating content in pendingContent
 * - Flushing content to posts at appropriate times
 * - Splitting long messages across multiple posts
 * - Managing currentPostId and currentPostContent
 */

import { truncateMessageSafely } from '../../platform/utils.js';
import { formatShortId } from '../../utils/format.js';
import { MIN_BREAK_THRESHOLD, splitContentForHeight } from '../content-breaker.js';
import type { AppendContentOp, FlushOp } from '../types.js';
import type { ExecutorContext, ContentState } from './types.js';
import { BaseExecutor, type ExecutorOptions } from './base.js';

// ---------------------------------------------------------------------------
// Content Executor Options
// ---------------------------------------------------------------------------

/**
 * Extended options for ContentExecutor.
 */
export interface ContentExecutorOptions extends ExecutorOptions {
  /** Callback to bump task list and get old post ID for reuse */
  onBumpTaskList?: (content: string, ctx: ExecutorContext) => Promise<string | null>;
  /** Callback to bump task list to bottom (without repurposing) */
  onBumpTaskListToBottom?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Content Executor
// ---------------------------------------------------------------------------

/**
 * Executor for content operations.
 */
export class ContentExecutor extends BaseExecutor<ContentState> {
  private onBumpTaskList?: (content: string, ctx: ExecutorContext) => Promise<string | null>;
  private onBumpTaskListToBottom?: () => Promise<void>;

  constructor(options: ContentExecutorOptions) {
    super(options, ContentExecutor.createInitialState());
    this.onBumpTaskList = options.onBumpTaskList;
    this.onBumpTaskListToBottom = options.onBumpTaskListToBottom;
  }

  private static createInitialState(): ContentState {
    return {
      currentPostId: null,
      currentPostContent: '',
      pendingContent: '',
      updateTimer: null,
      header: null,
      headerDirty: false,
      headerPostId: null,
      headerBody: '',
      turnOpen: false,
    };
  }

  /**
   * Set the one-line header that rides on the first post of the current
   * turn (the tool-activity summary; docs/quiet-tools-spec.md). `null`
   * removes it. The first header of a turn adopts the current post, or the
   * next post created; the header is rendered on the next flush, which
   * happens even with nothing else pending.
   */
  setHeader(line: string | null): void {
    if (!this.state.turnOpen) {
      this.state.turnOpen = true;
      this.state.headerPostId = this.state.currentPostId;
      this.state.headerBody = this.state.currentPostContent;
    }
    this.state.header = line;
    this.state.headerDirty = true;
  }

  /** The post the current turn's header lives on, once it exists. */
  getHeaderPostId(): string | null {
    return this.state.headerPostId;
  }

  /** What a post's text is, given its body: the header is prepended on the header post only. */
  private renderFor(postId: string | null, body: string): string {
    if (this.state.header && postId !== null && postId === this.state.headerPostId) {
      return body ? `${this.state.header}\n\n${body}` : this.state.header;
    }
    return body;
  }

  /** Length the header adds to a post's text, for the platform limit checks. */
  private headerReserve(postId: string | null): number {
    const header = this.state.header;
    if (!header) return 0;
    const applies = postId === this.state.headerPostId || (postId === null && this.state.headerPostId === null && this.state.turnOpen);
    return applies ? header.length + 2 : 0;
  }

  /** Render the header post again after a header change with nothing pending. */
  private async renderHeaderOnly(ctx: ExecutorContext): Promise<void> {
    this.state.headerDirty = false;
    if (this.state.headerPostId) {
      const postId = this.state.headerPostId;
      await this.tryUpdatePost(
        ctx,
        postId,
        this.state.headerBody,
        'header',
        { reason: 'header_update', headerLength: this.state.header?.length ?? 0 },
        { reason: 'header_update_failed' },
        () => { /* body unchanged */ },
        () => { /* keep the post; a failed header edit is not a lost reply */ },
      );
      return;
    }
    if (this.state.header && this.state.turnOpen) {
      await this.createNewPost(ctx, '', '');
    }
  }

  protected getInitialState(): ContentState {
    return ContentExecutor.createInitialState();
  }

  /**
   * Reset state (for session restart).
   * Override to clear timer before resetting state.
   */
  override reset(): void {
    if (this.state.updateTimer) {
      clearTimeout(this.state.updateTimer);
    }
    this.state = this.getInitialState();
  }

  /**
   * Wrap `ctx.platform.updatePost` with the three-way outcome this file uses
   * repeatedly: (success: log + caller-supplied state update) vs (failure: log
   * + caller-supplied state reset). Shared fields — component name, postId,
   * threadLogger tag — are set here so call sites only specify what differs.
   *
   * Each call site's success and failure state mutation stays explicit via the
   * `onSuccess` / `onFailure` callbacks. Do NOT bake a single "correct" state
   * reset into this helper: the 5 original sites drifted (some clear
   * currentPostContent, some don't), and hiding those differences would be a
   * regression hazard.
   */
  private async tryUpdatePost(
    ctx: ExecutorContext,
    postId: string,
    content: string,
    logTag: string,
    successDetails: Record<string, unknown>,
    failureDetails: Record<string, unknown> | ((err: unknown) => Record<string, unknown>),
    onSuccess: () => void,
    onFailure: () => void,
  ): Promise<void> {
    try {
      await ctx.platform.updatePost(postId, this.renderFor(postId, content));
      if (postId === this.state.headerPostId) {
        this.state.headerBody = content;
        this.state.headerDirty = false;
      }
      onSuccess();
      ctx.threadLogger?.logExecutor('content', 'update', postId, successDetails, logTag);
    } catch (err) {
      ctx.logger.debug(`Update failed (${logTag}): ${err}`);
      const resolvedFailureDetails = typeof failureDetails === 'function'
        ? failureDetails(err)
        : failureDetails;
      ctx.threadLogger?.logExecutor('content', 'error', postId, resolvedFailureDetails, logTag);
      onFailure();
    }
  }

  /**
   * Close the current post, signaling that subsequent content should go to a new post.
   * Called when user sends a message or after compaction.
   */
  closeCurrentPost(ctx?: ExecutorContext): void {
    const oldPostId = this.state.currentPostId;
    const contentLength = this.state.currentPostContent.length;
    this.state.currentPostId = null;
    this.state.currentPostContent = '';
    if (ctx?.threadLogger && oldPostId) {
      ctx.threadLogger.logExecutor('content', 'close', oldPostId, {
        contentLength,
        reason: 'closeCurrentPost'
      }, 'closeCurrentPost');
    }
  }

  /**
   * Execute an append content operation.
   */
  async executeAppend(op: AppendContentOp, _ctx: ExecutorContext): Promise<void> {
    // Tool output needs spacing before and after to separate from text
    if (op.isToolOutput && this.state.pendingContent.length > 0) {
      if (!this.state.pendingContent.endsWith('\n\n')) {
        if (this.state.pendingContent.endsWith('\n')) {
          this.state.pendingContent += '\n';
        } else {
          this.state.pendingContent += '\n\n';
        }
      }
    }
    this.state.pendingContent += op.content;

    // Add spacing after tool output so next content is separated
    if (op.isToolOutput) {
      this.state.pendingContent += '\n\n';
    }
  }

  /**
   * Execute a flush operation.
   */
  async executeFlush(op: FlushOp, ctx: ExecutorContext): Promise<void> {
    await this.flush(ctx, op.reason);
  }

  /**
   * Schedule a delayed flush.
   */
  scheduleFlush(ctx: ExecutorContext, delayMs: number = 500): void {
    if (this.state.updateTimer) return;

    this.state.updateTimer = setTimeout(() => {
      this.state.updateTimer = null;
      this.flush(ctx, 'soft_threshold');
    }, delayMs);
  }

  /**
   * Flush pending content to the platform.
   */
  async flush(ctx: ExecutorContext, reason: FlushOp['reason']): Promise<void> {
    if (!this.state.pendingContent.trim()) {
      if (this.state.headerDirty) await this.renderHeaderOnly(ctx);
      if (reason === 'result') this.state.turnOpen = false;
      return; // Nothing else to flush
    }
    await this.flushPending(ctx);
    // The turn is over: the next header starts a new one. The header itself
    // stays on its post.
    if (reason === 'result') this.state.turnOpen = false;
  }

  private async flushPending(ctx: ExecutorContext): Promise<void> {

    // Capture content at start of flush
    const pendingAtFlushStart = this.state.pendingContent;

    // Format for target platform
    let content = ctx.formatter.formatMarkdown(pendingAtFlushStart).trim();

    // Get platform limits
    const { maxLength: MAX_POST_LENGTH, hardThreshold: HARD_CONTINUATION_THRESHOLD } =
      ctx.platform.getMessageLimits();

    // Calculate combined content (what the post should contain after update)
    // This is needed for handleSplit to preserve existing post content
    let combinedContent: string;
    if (this.state.currentPostId && this.state.currentPostContent) {
      const needsSeparator = !this.state.currentPostContent.endsWith('\n') && !content.startsWith('\n');
      combinedContent = needsSeparator
        ? this.state.currentPostContent + '\n\n' + content
        : this.state.currentPostContent + content;
    } else {
      combinedContent = content;
    }

    // Check if we should break early (based on COMBINED content height)
    const shouldBreakEarly = this.state.currentPostId &&
      combinedContent.length > MIN_BREAK_THRESHOLD &&
      ctx.contentBreaker.shouldFlushEarly(combinedContent);

    // Handle message splitting - use combinedContent so existing post content is preserved
    const reserve = this.headerReserve(this.state.currentPostId);
    if (this.state.currentPostId && (combinedContent.length + reserve > HARD_CONTINUATION_THRESHOLD || shouldBreakEarly)) {
      await this.handleSplit(ctx, combinedContent, pendingAtFlushStart, HARD_CONTINUATION_THRESHOLD);
      return;
    }

    // Normal case: content fits in current post
    if (content.length + reserve > MAX_POST_LENGTH) {
      ctx.logger.warn(`Content too long (${content.length}), truncating`);
      content = truncateMessageSafely(
        content,
        MAX_POST_LENGTH - reserve,
        ctx.formatter.formatItalic('... (truncated)')
      );
    }

    if (this.state.currentPostId) {
      // Update existing post
      const postId = this.state.currentPostId;

      // Calculate combined content first to check if it would exceed limit
      let combinedContent: string;
      if (this.state.currentPostContent) {
        const needsSeparator = !this.state.currentPostContent.endsWith('\n') && !content.startsWith('\n');
        combinedContent = needsSeparator
          ? this.state.currentPostContent + '\n\n' + content
          : this.state.currentPostContent + content;
      } else {
        combinedContent = content;
      }

      // If combined content would exceed MAX_POST_LENGTH, start a new post
      // This prevents content loss when updatePost fails with msg_too_long
      if (combinedContent.length + reserve > MAX_POST_LENGTH) {
        ctx.logger.debug(`Combined content (${combinedContent.length}) would exceed max (${MAX_POST_LENGTH}), creating continuation post`);
        ctx.threadLogger?.logExecutor('content', 'create_start', 'none', {
          contentLength: content.length,
          currentPostContentLength: this.state.currentPostContent.length,
          combinedLength: combinedContent.length,
          reason: 'combined_exceeds_max',
        }, 'flush');

        // Close current post and create a new one for the new content
        this.state.currentPostId = null;
        // Don't clear currentPostContent - keep it for reference in logs
        // The new post will only contain the new content, not combined
        await this.createNewPost(ctx, content, pendingAtFlushStart);
        return;
      }

      await this.tryUpdatePost(
        ctx,
        postId,
        combinedContent,
        'flush',
        { newContentLength: content.length, combinedLength: combinedContent.length },
        // Preserve the pre-refactor thread-log shape: the flush path includes
        // the exception text so operators can diagnose updatePost failures
        // without cross-referencing the debug log.
        (err) => ({ failedOp: 'updatePost', error: String(err) }),
        () => {
          this.state.currentPostContent = combinedContent;
          this.clearFlushedContent(pendingAtFlushStart);
        },
        () => {
          this.state.currentPostId = null;
          this.state.currentPostContent = '';
        },
      );
    } else {
      // Create new post(s) - split if content is too tall
      const chunks = splitContentForHeight(content, ctx.contentBreaker);
      ctx.threadLogger?.logExecutor('content', 'create_start', 'none', {
        contentLength: content.length,
        chunkCount: chunks.length,
        reason: 'no_currentPostId',
      }, 'flush');

      for (let i = 0; i < chunks.length; i++) {
        await this.createNewPost(ctx, chunks[i], pendingAtFlushStart);
        // Reset for next chunk so it creates a new post
        // But keep state for the last chunk so getCurrentPostContent() works
        if (i < chunks.length - 1) {
          this.state.currentPostId = null;
          this.state.currentPostContent = '';
        }
      }
    }
  }

  /**
   * Handle splitting content across multiple posts.
   */
  private async handleSplit(
    ctx: ExecutorContext,
    content: string,
    pendingAtFlushStart: string,
    hardThreshold: number
  ): Promise<void> {
    // Determine break point
    let breakPoint: number;
    let codeBlockOpenPosition: number | undefined;

    if (content.length > hardThreshold) {
      // Hard break
      const startSearchPos = Math.floor(hardThreshold * 0.7);
      const breakInfo = ctx.contentBreaker.findLogicalBreakpoint(
        content,
        startSearchPos,
        Math.floor(hardThreshold * 0.3)
      );

      if (breakInfo) {
        breakPoint = breakInfo.position;
      } else {
        // Check if inside code block
        const codeBlockState = ctx.contentBreaker.getCodeBlockState(content, startSearchPos);
        if (codeBlockState.isInside) {
          codeBlockOpenPosition = codeBlockState.openPosition;
          breakPoint = hardThreshold;
        } else {
          breakPoint = content.lastIndexOf('\n', hardThreshold);
          if (breakPoint < hardThreshold * 0.7) {
            breakPoint = hardThreshold;
          }
        }
      }
    } else {
      // Soft break (height-based) - find a breakpoint where first part fits under height threshold
      // We need to find the LAST good breakpoint where firstPart is still under threshold
      const goodBreakpointTypes = new Set(['paragraph', 'code_block_end', 'heading', 'tool_marker']);
      let bestBreakPoint: number | null = null;

      // Iterate through breakpoints to find the best one (largest first part that fits)
      let searchStart = 0;
      while (searchStart < content.length) {
        const breakInfo = ctx.contentBreaker.findLogicalBreakpoint(content, searchStart, content.length - searchStart);
        if (!breakInfo || breakInfo.position <= searchStart || breakInfo.position >= content.length) {
          break;
        }

        // Only consider good breakpoint types
        if (!goodBreakpointTypes.has(breakInfo.type)) {
          searchStart = breakInfo.position + 1;
          continue;
        }

        const firstPart = content.substring(0, breakInfo.position).trim();
        // Use height-only check to maximize content per chunk
        if (!ctx.contentBreaker.exceedsHeightThreshold(firstPart)) {
          // This breakpoint gives us a first part that fits - remember it
          bestBreakPoint = breakInfo.position;
        }

        searchStart = breakInfo.position + 1;
      }

      if (bestBreakPoint !== null && bestBreakPoint > 0) {
        breakPoint = bestBreakPoint;
      } else {
        // No good breakpoint - just update current post with ALL content.
        // We must update the post AND update state to prevent duplication on next flush.
        // Failure branch nulls postId but deliberately leaves currentPostContent intact
        // (unlike other sites) so the existing content is preserved for the continuation.
        if (this.state.currentPostId) {
          const postId = this.state.currentPostId;
          await this.tryUpdatePost(
            ctx,
            postId,
            content,
            'handleSplit',
            { reason: 'soft_break_no_breakpoint', contentLength: content.length },
            { reason: 'soft_break_no_breakpoint_failed' },
            () => {
              // CRITICAL: Update state to match what's in the post
              this.state.currentPostContent = content;
              this.clearFlushedContent(pendingAtFlushStart);
            },
            () => {
              this.state.currentPostId = null;
            },
          );
        }
        return;
      }
    }

    // Split at code block start if needed
    if (codeBlockOpenPosition !== undefined) {
      if (codeBlockOpenPosition === 0) {
        // Code block at start - just update and wait.
        if (this.state.currentPostId) {
          const postId = this.state.currentPostId;
          await this.tryUpdatePost(
            ctx,
            postId,
            content,
            'handleSplit',
            { reason: 'code_block_at_start', contentLength: content.length },
            { reason: 'code_block_at_start_failed' },
            () => {
              // CRITICAL: Update state to match what's in the post to prevent duplication
              this.state.currentPostContent = content;
              this.clearFlushedContent(pendingAtFlushStart);
            },
            () => {
              this.state.currentPostId = null;
              this.state.currentPostContent = '';
            },
          );
        }
        return;
      }

      const breakBeforeCodeBlock = content.lastIndexOf('\n', codeBlockOpenPosition);
      if (breakBeforeCodeBlock > 0) {
        breakPoint = breakBeforeCodeBlock;
      } else {
        if (this.state.currentPostId) {
          const postId = this.state.currentPostId;
          await this.tryUpdatePost(
            ctx,
            postId,
            content,
            'handleSplit',
            { reason: 'no_break_before_code_block', contentLength: content.length },
            { reason: 'no_break_before_code_block_failed' },
            () => {
              // CRITICAL: Update state to match what's in the post to prevent duplication
              this.state.currentPostContent = content;
              this.clearFlushedContent(pendingAtFlushStart);
            },
            () => {
              this.state.currentPostId = null;
              this.state.currentPostContent = '';
            },
          );
        }
        return;
      }
    }

    // Split content
    const firstPart = content.substring(0, breakPoint).trim();
    const remainder = content.substring(breakPoint).trim();

    // Update current post with first part
    // Note: We use firstPart directly, NOT combined with currentPostContent.
    // This is because `content` already represents all pending content, and firstPart
    // is the portion that should be in this post. Combining would cause duplication
    // since pendingContent accumulates and isn't always cleared properly.
    if (this.state.currentPostId) {
      const postId = this.state.currentPostId;
      // Split first part: no state mutation on either branch — the caller
      // unconditionally nulls currentPostId and clears currentPostContent
      // below to start fresh for the remainder.
      await this.tryUpdatePost(
        ctx,
        postId,
        firstPart,
        'handleSplit',
        { reason: 'split_first_part', firstPartLength: firstPart.length, remainderLength: remainder.length },
        { reason: 'split_first_part_failed' },
        () => { /* no-op: caller resets state below */ },
        () => { /* no-op: caller resets state below */ },
      );
    }

    // Start new post for remainder
    // NOTE: Do NOT set pendingContent = remainder here!
    // That would overwrite any new content that arrived during the async updatePost.
    // Instead, createNewPost will call clearFlushedContent(pendingAtFlushStart) which
    // properly clears only the flushed content while preserving any new content.
    this.state.currentPostId = null;
    this.state.currentPostContent = '';

    // Create continuation post if there's content
    if (remainder) {
      await this.createNewPost(ctx, remainder, pendingAtFlushStart);
    }
  }

  /**
   * Create a new post.
   */
  private async createNewPost(
    ctx: ExecutorContext,
    content: string,
    pendingAtFlushStart: string
  ): Promise<void> {
    // The first post of a turn with a header carries it (docs/quiet-tools-spec.md).
    const header = this.state.header;
    const becomesHeaderPost = this.state.turnOpen && this.state.headerPostId === null && header !== null;
    const rendered = becomesHeaderPost && header !== null ? (content ? `${header}\n\n${content}` : header) : content;
    const adoptAsHeaderPost = (postId: string) => {
      if (becomesHeaderPost) {
        this.state.headerPostId = postId;
        this.state.headerBody = content;
        this.state.headerDirty = false;
      }
    };

    // Try to bump task list first - this reuses the old task list post for content
    if (this.onBumpTaskList) {
      const bumpedPostId = await this.onBumpTaskList(rendered, ctx);
      if (bumpedPostId) {
        adoptAsHeaderPost(bumpedPostId);
        this.state.currentPostId = bumpedPostId;
        this.state.currentPostContent = content;
        this.clearFlushedContent(pendingAtFlushStart);
        ctx.threadLogger?.logExecutor('content', 'create', bumpedPostId, {
          method: 'bump_repurpose',
          contentLength: content.length,
        }, 'createNewPost');

        // ALWAYS bump task list to bottom after using repurposed post
        // This ensures task list is recreated at the bottom
        if (this.onBumpTaskListToBottom) {
          await this.onBumpTaskListToBottom();
        }
        return;
      }
    }

    // Create new post
    try {
      const post = await ctx.createPost(rendered, { type: 'content' });
      adoptAsHeaderPost(post.id);
      this.state.currentPostId = post.id;
      this.state.currentPostContent = content;
      this.clearFlushedContent(pendingAtFlushStart);
      ctx.logger.debug(`Created post ${formatShortId(post.id)}`);
      ctx.threadLogger?.logExecutor('content', 'create', post.id, {
        method: 'new_post',
        contentLength: content.length,
      }, 'createNewPost');

      // Bump task list to bottom after creating content post
      // This ensures task list always stays at the bottom of the thread
      if (this.onBumpTaskListToBottom) {
        await this.onBumpTaskListToBottom();
      }
    } catch (err) {
      ctx.logger.error(`Failed to create post: ${err}`);
    }
  }

  /**
   * Clear flushed content from pending, preserving new content added during async ops.
   */
  private clearFlushedContent(flushedContent: string): void {
    if (this.state.pendingContent.startsWith(flushedContent)) {
      this.state.pendingContent = this.state.pendingContent.slice(flushedContent.length);
    } else {
      this.state.pendingContent = '';
    }
  }
}
