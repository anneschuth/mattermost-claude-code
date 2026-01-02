/**
 * Message streaming and flushing utilities
 *
 * Handles buffering, formatting, and posting Claude responses to the platform.
 * Implements logical message breaking to avoid content collapse on chat platforms.
 */

import type { PlatformClient, PlatformFile } from '../platform/index.js';
import type { Session } from './types.js';
import type { ContentBlock } from '../claude/cli.js';
import { TASK_TOGGLE_EMOJIS } from '../utils/emoji.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('streaming');

// ---------------------------------------------------------------------------
// Message breaking thresholds
// ---------------------------------------------------------------------------

/**
 * Soft threshold: when content exceeds this, we look for logical breakpoints.
 * This is lower than the hard limit to avoid content collapse on chat platforms.
 * Many platforms collapse long messages (e.g., at ~300 chars or 5 line breaks).
 */
export const SOFT_BREAK_THRESHOLD = 2000;

/**
 * Minimum content size before we consider breaking.
 * Prevents breaking very short messages unnecessarily.
 */
export const MIN_BREAK_THRESHOLD = 500;

/**
 * Maximum lines before we look for a break point.
 * Some platforms collapse at ~5 lines, so we break well before reaching that.
 */
export const MAX_LINES_BEFORE_BREAK = 15;

// ---------------------------------------------------------------------------
// Logical breakpoint detection
// ---------------------------------------------------------------------------

/**
 * Types of logical breakpoints in content.
 */
export type BreakpointType =
  | 'heading'        // Markdown heading (## or ###)
  | 'code_block_end' // End of a code block
  | 'paragraph'      // Empty line (paragraph break)
  | 'tool_marker'    // Tool result marker (  ↳ ✓ or ❌)
  | 'none';

/**
 * Information about code block state at a position.
 */
export interface CodeBlockInfo {
  /** Whether we're inside an open code block */
  isInside: boolean;
  /** The language of the code block (e.g., 'diff', 'typescript') */
  language?: string;
  /** Position of the opening ``` in the content */
  openPosition?: number;
}

/**
 * Check if a position is inside an open code block.
 * Counts ``` markers from the start to determine if we're inside a block.
 *
 * @param content - The full content string
 * @param position - Position to check
 * @returns Information about code block state at that position
 */
export function getCodeBlockState(content: string, position: number): CodeBlockInfo {
  const textUpToPosition = content.substring(0, position);

  // Find all code block markers (```) - they appear at line start or after newline
  const markers: { index: number; isOpening: boolean; language?: string }[] = [];
  const markerRegex = /^```(\w*)?$/gm;
  let match;

  while ((match = markerRegex.exec(textUpToPosition)) !== null) {
    const isOpening = markers.length === 0 || !markers[markers.length - 1].isOpening;
    markers.push({
      index: match.index,
      isOpening,
      language: isOpening ? match[1] : undefined,
    });
  }

  // If odd number of markers, we're inside a code block
  if (markers.length > 0 && markers.length % 2 === 1) {
    const lastMarker = markers[markers.length - 1];
    return {
      isInside: true,
      language: lastMarker.language,
      openPosition: lastMarker.index,
    };
  }

  return { isInside: false };
}

/**
 * Find the best logical breakpoint in content near or after a position.
 * Returns the position to break at, or -1 if no good breakpoint found.
 *
 * IMPORTANT: This function now checks if we're inside a code block and
 * prioritizes finding the end of that block before breaking.
 *
 * @param content - The full content string
 * @param startPos - Position to start looking from
 * @param maxLookAhead - How far ahead to look for a breakpoint (default 500 chars)
 * @returns Object with break position and type, or null if not found
 */
export function findLogicalBreakpoint(
  content: string,
  startPos: number,
  maxLookAhead: number = 500
): { position: number; type: BreakpointType } | null {
  const searchWindow = content.substring(startPos, startPos + maxLookAhead);

  // First, check if we're inside an open code block at startPos
  const codeBlockState = getCodeBlockState(content, startPos);

  if (codeBlockState.isInside) {
    // We're inside a code block - we MUST find its closing ``` before breaking
    // Look for the closing ``` in the search window
    const codeBlockEndMatch = searchWindow.match(/^```$/m);
    if (codeBlockEndMatch && codeBlockEndMatch.index !== undefined) {
      // Found the end - break AFTER the closing ```
      const pos = startPos + codeBlockEndMatch.index + codeBlockEndMatch[0].length;
      // Also skip any trailing newline
      const nextChar = content[pos];
      const finalPos = nextChar === '\n' ? pos + 1 : pos;
      return { position: finalPos, type: 'code_block_end' };
    }

    // No closing found in window - return null to indicate we can't safely break here
    // The caller (flush) will need to handle this by either:
    // 1. Extending the search window
    // 2. Force-breaking with proper code block closure/reopening
    return null;
  }

  // Not inside a code block - use normal breakpoint logic
  // But validate that each potential breakpoint is not inside a code block

  // Priority 1: Look for tool result markers (natural tool completion boundary)
  // These look like "  ↳ ✓" or "  ↳ ❌ Error"
  const toolMarkerMatch = searchWindow.match(/ {2}↳ [✓❌][^\n]*\n/);
  if (toolMarkerMatch && toolMarkerMatch.index !== undefined) {
    const pos = startPos + toolMarkerMatch.index + toolMarkerMatch[0].length;
    // Verify we're not inside a code block at this position
    if (!getCodeBlockState(content, pos).isInside) {
      return { position: pos, type: 'tool_marker' };
    }
  }

  // Priority 2: Look for markdown headings (section boundaries)
  const headingMatch = searchWindow.match(/\n(#{2,3} )/);
  if (headingMatch && headingMatch.index !== undefined) {
    const pos = startPos + headingMatch.index;
    // Verify we're not inside a code block at this position
    if (!getCodeBlockState(content, pos).isInside) {
      return { position: pos, type: 'heading' };
    }
  }

  // Priority 3: Look for end of code blocks
  const codeBlockEndMatch = searchWindow.match(/^```$/m);
  if (codeBlockEndMatch && codeBlockEndMatch.index !== undefined) {
    const pos = startPos + codeBlockEndMatch.index + codeBlockEndMatch[0].length;
    const nextChar = content[pos];
    const finalPos = nextChar === '\n' ? pos + 1 : pos;
    return { position: finalPos, type: 'code_block_end' };
  }

  // Priority 4: Look for paragraph breaks (double newlines)
  const paragraphMatch = searchWindow.match(/\n\n/);
  if (paragraphMatch && paragraphMatch.index !== undefined) {
    const pos = startPos + paragraphMatch.index + paragraphMatch[0].length;
    // Verify we're not inside a code block at this position
    if (!getCodeBlockState(content, pos).isInside) {
      return { position: pos, type: 'paragraph' };
    }
  }

  // Priority 5: Fallback to any line break (but not inside code blocks)
  const lineBreakMatch = searchWindow.match(/\n/);
  if (lineBreakMatch && lineBreakMatch.index !== undefined) {
    const pos = startPos + lineBreakMatch.index + 1;
    // Verify we're not inside a code block at this position
    if (!getCodeBlockState(content, pos).isInside) {
      return { position: pos, type: 'none' };
    }
  }

  return null;
}

/**
 * Check if content should be flushed early based on logical breakpoints.
 * Returns true if we should flush now to avoid "Show More" collapse.
 *
 * @param content - Current pending content
 * @returns Whether to flush early
 */
export function shouldFlushEarly(content: string): boolean {
  // Count lines
  const lineCount = (content.match(/\n/g) || []).length;

  // Check against thresholds
  if (content.length >= SOFT_BREAK_THRESHOLD) return true;
  if (lineCount >= MAX_LINES_BEFORE_BREAK) return true;

  return false;
}

/**
 * Check if content ends at a logical breakpoint.
 * Used to detect when incoming content creates a natural break.
 *
 * @param content - Content to check
 * @returns The type of breakpoint at the end, or 'none'
 */
export function endsAtBreakpoint(content: string): BreakpointType {
  const trimmed = content.trimEnd();

  // Check for tool result marker at end
  if (/ {2}↳ [✓❌][^\n]*$/.test(trimmed)) {
    return 'tool_marker';
  }

  // Check for end of code block
  if (trimmed.endsWith('```')) {
    return 'code_block_end';
  }

  // Check for paragraph break at end (double newline)
  if (content.endsWith('\n\n')) {
    return 'paragraph';
  }

  return 'none';
}

// ---------------------------------------------------------------------------
// Scheduled updates
// ---------------------------------------------------------------------------

/**
 * Schedule a delayed flush of the session's pending content.
 * If an update is already scheduled, this is a no-op.
 *
 * Used during streaming to batch updates and avoid excessive API calls.
 */
export function scheduleUpdate(session: Session, onFlush: (session: Session) => Promise<void>): void {
  if (session.updateTimer) return;
  session.updateTimer = setTimeout(() => {
    session.updateTimer = null;
    onFlush(session);
  }, 500);
}

/**
 * Build message content for Claude, including images if present.
 * Returns either a string or an array of content blocks.
 *
 * @param text - The text message
 * @param platform - Platform client for downloading images
 * @param files - Optional files attached to the message
 * @param debug - Whether to log debug info
 * @returns Plain string or content blocks array with images
 */
export async function buildMessageContent(
  text: string,
  platform: PlatformClient,
  files?: PlatformFile[],
  debug: boolean = false
): Promise<string | ContentBlock[]> {
  // Filter to only image files
  const imageFiles = files?.filter(f =>
    f.mimeType.startsWith('image/') &&
    ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(f.mimeType)
  ) || [];

  // If no images, return plain text
  if (imageFiles.length === 0) {
    return text;
  }

  // Build content blocks with images
  const blocks: ContentBlock[] = [];

  // Download and add each image
  for (const file of imageFiles) {
    try {
      if (!platform.downloadFile) {
        log.warn(`Platform does not support file downloads, skipping ${file.name}`);
        continue;
      }
      const buffer = await platform.downloadFile(file.id);
      const base64 = buffer.toString('base64');

      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimeType,
          data: base64,
        },
      });

      if (debug) {
        log.debug(`Attached image: ${file.name} (${file.mimeType}, ${Math.round(buffer.length / 1024)}KB)`);
      }
    } catch (err) {
      log.error(`Failed to download image ${file.name}: ${err}`);
    }
  }

  // Add the text message
  if (text) {
    blocks.push({
      type: 'text',
      text,
    });
  }

  return blocks;
}

/**
 * Start sending typing indicators to the platform.
 * Sends immediately, then every 3 seconds until stopped.
 */
export function startTyping(session: Session): void {
  if (session.typingTimer) return;
  // Send typing immediately, then every 3 seconds
  session.platform.sendTyping(session.threadId);
  session.typingTimer = setInterval(() => {
    session.platform.sendTyping(session.threadId);
  }, 3000);
}

/**
 * Stop sending typing indicators.
 */
export function stopTyping(session: Session): void {
  if (session.typingTimer) {
    clearInterval(session.typingTimer);
    session.typingTimer = null;
  }
}

/**
 * Bump the task list to the bottom by reusing its post for new content.
 *
 * When we need to create a new post and a task list exists, we:
 * 1. Update the task list post with the new content (repurposing it)
 * 2. Create a fresh task list post at the bottom
 *
 * This keeps the task list visually at the bottom without deleting messages.
 *
 * @param session - The session
 * @param newContent - Content to put in the repurposed post
 * @param registerPost - Callback to register post for reaction routing
 * @returns The post ID that now contains the content (was the task list post)
 */
async function bumpTasksToBottomWithContent(
  session: Session,
  newContent: string,
  registerPost: (postId: string, threadId: string) => void
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- caller checks tasksPostId exists
  const oldTasksPostId = session.tasksPostId!;
  const oldTasksContent = session.lastTasksContent;

  // Remove the toggle emoji from the old task post before repurposing it
  try {
    await session.platform.removeReaction(oldTasksPostId, TASK_TOGGLE_EMOJIS[0]);
  } catch {
    // Ignore errors - emoji may not exist
  }

  // Repurpose the task list post for the new content
  await session.platform.updatePost(oldTasksPostId, newContent);
  registerPost(oldTasksPostId, session.threadId);

  // Create a new task list post at the bottom (if we have content to show)
  if (oldTasksContent) {
    const newTasksPost = await session.platform.createInteractivePost(
      oldTasksContent,
      [TASK_TOGGLE_EMOJIS[0]], // Add toggle emoji
      session.threadId
    );
    session.tasksPostId = newTasksPost.id;
    // Register the new task post so reaction clicks are routed to this session
    registerPost(newTasksPost.id, session.threadId);
  } else {
    // No task content to re-post, clear the task post ID
    session.tasksPostId = null;
  }

  return oldTasksPostId;
}

/**
 * Bump the task list to the bottom of the thread.
 *
 * Call this when a user sends a follow-up message to keep the task list
 * below user messages. Deletes the old task post and creates a new one.
 *
 * @param session - The session
 * @param registerPost - Callback to register the new post for reaction routing
 */
export async function bumpTasksToBottom(
  session: Session,
  registerPost?: (postId: string, threadId: string) => void
): Promise<void> {
  if (!session.tasksPostId || !session.lastTasksContent) {
    return; // No task list to bump
  }

  // Don't bump completed task lists - they can stay where they are
  if (session.tasksCompleted) {
    return;
  }

  try {
    // Delete the old task post
    await session.platform.deletePost(session.tasksPostId);

    // Create a new task post at the bottom with the toggle emoji
    const newPost = await session.platform.createInteractivePost(
      session.lastTasksContent,
      [TASK_TOGGLE_EMOJIS[0]], // 🔽 arrow_down_small
      session.threadId
    );
    session.tasksPostId = newPost.id;
    // Register the task post so reaction clicks are routed to this session
    if (registerPost) {
      registerPost(newPost.id, session.threadId);
    }
  } catch (err) {
    log.error(`Failed to bump tasks to bottom: ${err}`);
  }
}

/**
 * Flush pending content to the platform.
 *
 * Handles:
 * - Logical message breaking (headings, tool results, code blocks)
 * - Soft threshold breaking to avoid "Show More" collapse
 * - Hard message length limits (splits into multiple posts if needed)
 * - Creating vs updating posts
 * - Post registration for reaction routing
 * - Keeping task list at the bottom (sticky tasks)
 *
 * @param session - The session to flush
 * @param registerPost - Callback to register post for reaction routing
 */
export async function flush(
  session: Session,
  registerPost: (postId: string, threadId: string) => void
): Promise<void> {
  if (!session.pendingContent.trim()) return;

  let content = session.pendingContent.replace(/\n{3,}/g, '\n\n').trim();

  // Most chat platforms have post length limits (~16K)
  const MAX_POST_LENGTH = 16000;  // Hard limit - leave some margin
  const HARD_CONTINUATION_THRESHOLD = 14000;  // Absolute max before we force a break

  // Check if we should break early based on logical breakpoints
  // This helps avoid "Show More" collapse on some platforms
  const shouldBreakEarly = session.currentPostId &&
    content.length > MIN_BREAK_THRESHOLD &&
    shouldFlushEarly(content);

  // Check if we need to start a new message due to length or logical breakpoint
  if (session.currentPostId && (content.length > HARD_CONTINUATION_THRESHOLD || shouldBreakEarly)) {
    // Determine where to break
    let breakPoint: number;

    // Track if we're breaking inside a code block (so we can close/reopen it)
    let codeBlockLanguage: string | undefined;

    if (content.length > HARD_CONTINUATION_THRESHOLD) {
      // Hard break: we're at the limit, must break now
      // Try to find a logical breakpoint near the threshold
      const startSearchPos = Math.floor(HARD_CONTINUATION_THRESHOLD * 0.7);
      const breakInfo = findLogicalBreakpoint(
        content,
        startSearchPos,
        Math.floor(HARD_CONTINUATION_THRESHOLD * 0.3)
      );
      if (breakInfo) {
        breakPoint = breakInfo.position;
      } else {
        // findLogicalBreakpoint returned null - we might be inside a code block
        // Check if we're inside a code block at the desired break position
        const codeBlockState = getCodeBlockState(content, startSearchPos);

        if (codeBlockState.isInside) {
          // We're inside a code block and can't find its end within the lookahead
          // We need to force-break and properly close/reopen the code block
          codeBlockLanguage = codeBlockState.language;

          // Find a line break within the code block to break at
          const searchWindow = content.substring(startSearchPos, HARD_CONTINUATION_THRESHOLD);
          const lineBreakMatch = searchWindow.match(/\n/);
          if (lineBreakMatch && lineBreakMatch.index !== undefined) {
            breakPoint = startSearchPos + lineBreakMatch.index + 1;
          } else {
            breakPoint = HARD_CONTINUATION_THRESHOLD;
          }
        } else {
          // Not inside a code block, just couldn't find a good breakpoint
          // Fallback: find any line break
          breakPoint = content.lastIndexOf('\n', HARD_CONTINUATION_THRESHOLD);
          if (breakPoint < HARD_CONTINUATION_THRESHOLD * 0.7) {
            breakPoint = HARD_CONTINUATION_THRESHOLD;
          }
        }
      }
    } else {
      // Soft break: we've exceeded soft threshold, find a good logical breakpoint
      const breakInfo = findLogicalBreakpoint(content, SOFT_BREAK_THRESHOLD);
      if (breakInfo && breakInfo.position < content.length) {
        breakPoint = breakInfo.position;
      } else {
        // No good breakpoint found, just update the current post and wait
        await session.platform.updatePost(session.currentPostId, content);
        return;
      }
    }

    // Split at the breakpoint
    let firstPart = content.substring(0, breakPoint).trim();
    let remainder = content.substring(breakPoint).trim();

    // If we're breaking inside a code block, close it in the first part and reopen in the remainder
    if (codeBlockLanguage !== undefined) {
      // Close the code block in the first part
      firstPart = firstPart + '\n```';
      // Reopen the code block in the remainder (use same language)
      remainder = '```' + codeBlockLanguage + '\n' + remainder;
    }

    // Only add continuation marker if we have more content
    const firstPartWithMarker = remainder
      ? firstPart + '\n\n*... (continued below)*'
      : firstPart;

    // Update the current post with the first part
    await session.platform.updatePost(session.currentPostId, firstPartWithMarker);

    // Start a new post for the continuation
    session.currentPostId = null;
    session.pendingContent = remainder;

    // Create the continuation post if there's content
    if (remainder) {
      // If we have an active (non-completed) task list, reuse its post and bump it to the bottom
      const hasActiveTasks = session.tasksPostId && session.lastTasksContent && !session.tasksCompleted;
      if (hasActiveTasks) {
        const postId = await bumpTasksToBottomWithContent(session, '*(continued)*\n\n' + remainder, registerPost);
        session.currentPostId = postId;
      } else {
        const post = await session.platform.createPost('*(continued)*\n\n' + remainder, session.threadId);
        session.currentPostId = post.id;
        registerPost(post.id, session.threadId);
      }
    }
    return;
  }

  // Normal case: content fits in current post
  if (content.length > MAX_POST_LENGTH) {
    // Safety truncation if we somehow got content that's still too long
    content = content.substring(0, MAX_POST_LENGTH - 50) + '\n\n*... (truncated)*';
  }

  if (session.currentPostId) {
    await session.platform.updatePost(session.currentPostId, content);
  } else {
    // Need to create a new post
    // If we have an active (non-completed) task list, reuse its post and bump it to the bottom
    const hasActiveTasks = session.tasksPostId && session.lastTasksContent && !session.tasksCompleted;
    if (hasActiveTasks) {
      const postId = await bumpTasksToBottomWithContent(session, content, registerPost);
      session.currentPostId = postId;
    } else {
      const post = await session.platform.createPost(content, session.threadId);
      session.currentPostId = post.id;
      // Register post for reaction routing
      registerPost(post.id, session.threadId);
    }
  }
}
