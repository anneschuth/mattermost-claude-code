/**
 * Message streaming and flushing utilities
 *
 * Handles buffering, formatting, and posting Claude responses to the platform.
 */

import type { PlatformClient, PlatformFile } from '../platform/index.js';
import type { Session } from './types.js';
import type { ContentBlock } from '../claude/cli.js';

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
        console.warn(`  ⚠️ Platform does not support file downloads, skipping ${file.name}`);
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
        console.log(`  📷 Attached image: ${file.name} (${file.mimeType}, ${Math.round(buffer.length / 1024)}KB)`);
      }
    } catch (err) {
      console.error(`  ⚠️ Failed to download image ${file.name}:`, err);
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
 * Flush pending content to the platform.
 *
 * Handles:
 * - Message length limits (splits into multiple posts if needed)
 * - Creating vs updating posts
 * - Post registration for reaction routing
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

  // Most chat platforms have post length limits (~16K for Mattermost/Slack)
  const MAX_POST_LENGTH = 16000;  // Leave some margin
  const CONTINUATION_THRESHOLD = 14000;  // Start new message before we hit the limit

  // Check if we need to start a new message due to length
  if (session.currentPostId && content.length > CONTINUATION_THRESHOLD) {
    // Finalize the current post with what we have up to the threshold
    // Find a good break point (end of line) near the threshold
    let breakPoint = content.lastIndexOf('\n', CONTINUATION_THRESHOLD);
    if (breakPoint < CONTINUATION_THRESHOLD * 0.7) {
      // If we can't find a good line break, just break at the threshold
      breakPoint = CONTINUATION_THRESHOLD;
    }

    const firstPart = content.substring(0, breakPoint).trim() + '\n\n*... (continued below)*';
    const remainder = content.substring(breakPoint).trim();

    // Update the current post with the first part
    await session.platform.updatePost(session.currentPostId, firstPart);

    // Start a new post for the continuation
    session.currentPostId = null;
    session.pendingContent = remainder;

    // Create the continuation post if there's content
    if (remainder) {
      const post = await session.platform.createPost('*(continued)*\n\n' + remainder, session.threadId);
      session.currentPostId = post.id;
      registerPost(post.id, session.threadId);
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
    const post = await session.platform.createPost(content, session.threadId);
    session.currentPostId = post.id;
    // Register post for reaction routing
    registerPost(post.id, session.threadId);
  }
}
