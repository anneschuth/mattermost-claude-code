/**
 * Post Helper Utilities
 *
 * Centralizes common patterns for posting messages to chat platforms.
 * This eliminates duplication of `session.platform.createPost()` calls
 * and provides consistent formatting with emoji prefixes.
 *
 * Benefits:
 * - DRY: Single implementation for all post operations
 * - Consistency: Standard emoji prefixes for message types
 * - Extensibility: Easy to add logging, metrics, rate limiting
 * - Testability: Can mock a single interface
 */

import type { Session } from './types.js';
import type { PlatformPost } from '../platform/index.js';

// =============================================================================
// Core Post Functions
// =============================================================================

/**
 * Post an informational message to the session thread.
 * @param session - The session to post to
 * @param message - The message content
 * @returns The created post
 */
export async function postInfo(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(message, session.threadId);
}

/**
 * Post a success message (with ✅ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postSuccess(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`✅ ${message}`, session.threadId);
}

/**
 * Post a warning message (with ⚠️ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postWarning(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`⚠️ ${message}`, session.threadId);
}

/**
 * Post an error message (with ❌ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postError(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`❌ ${message}`, session.threadId);
}

/**
 * Post a security/permission message (with 🔐 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postSecure(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`🔐 ${message}`, session.threadId);
}

/**
 * Post a command/action message (with ⚙️ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postCommand(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`⚙️ ${message}`, session.threadId);
}

/**
 * Post a session cancelled message (with 🛑 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postCancelled(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`🛑 ${message}`, session.threadId);
}

/**
 * Post a resume/refresh message (with 🔄 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postResume(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`🔄 ${message}`, session.threadId);
}

/**
 * Post a timeout message (with ⏱️ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postTimeout(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`⏱️ ${message}`, session.threadId);
}

/**
 * Post an interrupt/pause message (with ⏸️ prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postInterrupt(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`⏸️ ${message}`, session.threadId);
}

/**
 * Post a worktree/git message (with 🌿 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postWorktree(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`🌿 ${message}`, session.threadId);
}

/**
 * Post a context/thread message (with 🧵 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postContext(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`🧵 ${message}`, session.threadId);
}

/**
 * Post an invite/user message (with 👤 prefix).
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @returns The created post
 */
export async function postUser(session: Session, message: string): Promise<PlatformPost> {
  return session.platform.createPost(`👤 ${message}`, session.threadId);
}

// =============================================================================
// Post with Reactions
// =============================================================================

/**
 * Post a message and add reaction options.
 * Used for approval/denial prompts, questions, etc.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param reactions - Array of emoji names to add as reactions
 * @returns The created post
 */
export async function postWithReactions(
  session: Session,
  message: string,
  reactions: string[]
): Promise<PlatformPost> {
  const post = await session.platform.createPost(message, session.threadId);
  for (const emoji of reactions) {
    await session.platform.addReaction(post.id, emoji);
  }
  return post;
}

/**
 * Post an approval prompt with thumbs up/down reactions.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @returns The created post
 */
export async function postApprovalPrompt(
  session: Session,
  message: string
): Promise<PlatformPost> {
  return postWithReactions(session, message, ['+1', '-1']);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the post ID from a post result.
 * Convenience function for when you only need the ID.
 *
 * @param post - The platform post
 * @returns The post ID
 */
export function getPostId(post: PlatformPost): string {
  return post.id;
}

/**
 * Post and register the post ID for reaction routing.
 * Combines posting with registration in one call.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param registerPost - Function to register the post for reaction routing
 * @returns The created post
 */
export async function postAndRegister(
  session: Session,
  message: string,
  registerPost: (postId: string, threadId: string) => void
): Promise<PlatformPost> {
  const post = await session.platform.createPost(message, session.threadId);
  registerPost(post.id, session.threadId);
  return post;
}

/**
 * Post with reactions and register for reaction routing.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param reactions - Array of emoji names to add as reactions
 * @param registerPost - Function to register the post for reaction routing
 * @returns The created post
 */
export async function postWithReactionsAndRegister(
  session: Session,
  message: string,
  reactions: string[],
  registerPost: (postId: string, threadId: string) => void
): Promise<PlatformPost> {
  const post = await postWithReactions(session, message, reactions);
  registerPost(post.id, session.threadId);
  return post;
}

/**
 * Reset session activity state and clear duo-post tracking.
 * Call this when activity occurs to prevent updating stale posts in long threads.
 *
 * @param session - The session to reset activity for
 */
export function resetSessionActivity(session: Session): void {
  session.lastActivityAt = new Date();
  session.timeoutWarningPosted = false;
  session.lifecyclePostId = undefined;
}

// =============================================================================
// Bold/Formatted Message Helpers
// =============================================================================

/**
 * Format a message with bold label.
 * @example formatBold('Session cancelled', 'by @user') => '**Session cancelled** by @user'
 */
export function formatBold(label: string, rest?: string): string {
  return rest ? `**${label}** ${rest}` : `**${label}**`;
}

/**
 * Post a message with a bold label.
 * @param session - The session to post to
 * @param emoji - Emoji prefix (or empty string)
 * @param label - Bold label text
 * @param rest - Optional rest of the message
 * @returns The created post
 */
export async function postBold(
  session: Session,
  emoji: string,
  label: string,
  rest?: string
): Promise<PlatformPost> {
  const message = emoji
    ? `${emoji} ${formatBold(label, rest)}`
    : formatBold(label, rest);
  return session.platform.createPost(message, session.threadId);
}
