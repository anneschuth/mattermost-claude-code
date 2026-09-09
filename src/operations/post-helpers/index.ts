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
 *
 * Usage:
 * - Preferred: `post(session, 'success', 'Operation complete')`
 * - Legacy (deprecated): `postSuccess(session, 'Operation complete')`
 */

import type { Session } from '../../session/types.js';
import { transitionTo } from '../../session/types.js';
import type { PlatformPost, PlatformFormatter } from '../../platform/index.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';
import { withErrorHandling } from '../../utils/error-handler/index.js';
import { BUG_REPORT_EMOJI } from '../../utils/emoji.js';
import { updateWorktreeActivity } from '../../git/worktree.js';
import { formatShortId } from '../../utils/format.js';

const log = createLogger('helpers');
const sessionLog = createSessionLog(log);

// =============================================================================
// Post Type Configuration
// =============================================================================

/**
 * Mapping of post types to their emoji prefixes.
 * Empty string means no prefix.
 */
export const POST_TYPES = {
  info: '',           // No emoji
  success: '✅',
  warning: '⚠️',
  error: '❌',
  secure: '🔐',
  command: '⚙️',
  cancelled: '🛑',
  resume: '🔄',
  timeout: '⏱️',
  interrupt: '⏸️',
  worktree: '🌿',
  context: '🧵',
  user: '👤',
} as const;

export type PostType = keyof typeof POST_TYPES;

/**
 * Post a message with an optional type prefix emoji.
 * This is the preferred way to post messages - use this instead of the
 * individual post functions like postSuccess, postWarning, etc.
 *
 * @param session - The session to post to
 * @param type - The type of message (determines emoji prefix)
 * @param message - The message content (without emoji)
 * @returns The created post
 *
 * @example
 * await post(session, 'success', 'Operation complete');  // ✅ Operation complete
 * await post(session, 'warning', 'Be careful');          // ⚠️ Be careful
 * await post(session, 'info', 'Just FYI');               // Just FYI (no emoji)
 */
export async function post(
  session: Session,
  type: PostType,
  message: string
): Promise<PlatformPost> {
  const emoji = POST_TYPES[type];
  const content = emoji ? `${emoji} ${message}` : message;
  return createPostAndTrack(session, content);
}

// =============================================================================
// Internal Helper
// =============================================================================

/**
 * Create a post and automatically track it as the last message for jump-to-bottom links.
 * This is the core helper used by all post functions to ensure consistent tracking.
 */
async function createPostAndTrack(session: Session, message: string): Promise<PlatformPost> {
  const post = await session.platform.createPost(message, session.threadId);
  // Track this post for jump-to-bottom links in the sticky message
  updateLastMessage(session, post);
  return post;
}

// =============================================================================
// Error Post Helper (with bug reaction behavior)
// =============================================================================

/**
 * Whether error posts offer the 🐛 quick-report reaction. Module-level for the
 * same reason `configureAuditLog` is: `postError` has 25 call sites and no
 * `ctx`, and this is a process-wide setting resolved once at startup.
 */
let bugReportsEnabled = true;

/** Set from the top-level `bugReports` config at startup. */
export function configureBugReports(enabled: boolean): void {
  bugReportsEnabled = enabled;
}

/** Read by the other error-post path in MessageManager. */
export function bugReportsAreEnabled(): boolean {
  return bugReportsEnabled;
}

/**
 * Post an error message (with X prefix).
 * Adds a bug reaction for quick error reporting.
 *
 * Note: This function has special behavior not available in `post()`:
 * - Adds a bug report reaction emoji for quick error reporting
 * - Stores error context on the session for potential bug reports
 *
 * @param session - The session to post to
 * @param message - The message content (without emoji)
 * @param addBugReaction - Whether to add bug reaction for quick reporting (default: true)
 * @returns The created post
 */
export async function postError(
  session: Session,
  message: string,
  addBugReaction = true
): Promise<PlatformPost> {
  const result = await post(session, 'error', message);

  // Add bug reaction for quick error reporting.
  // Not offered when the operator has disabled bug reporting: the reaction is
  // an invitation to a path that will refuse, and in the deployments this
  // switch exists for, the button should not be on the wall at all.
  if (addBugReaction && bugReportsEnabled) {
    try {
      await session.platform.addReaction(result.id, BUG_REPORT_EMOJI);
      // Store error context for potential bug report
      session.lastError = {
        postId: result.id,
        message,
        timestamp: new Date(),
      };
    } catch {
      // Ignore if reaction fails - not critical
    }
  }

  return result;
}

// =============================================================================
// Post with Reactions
// =============================================================================

/**
 * Post a message and add reaction options.
 * Used for approval/denial prompts, questions, etc.
 *
 * Note: This is an internal helper. Prefer postInteractive for new code.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param reactions - Array of emoji names to add as reactions
 * @returns The created post
 */
async function postWithReactions(
  session: Session,
  message: string,
  reactions: string[]
): Promise<PlatformPost> {
  const post = await createPostAndTrack(session, message);
  sessionLog(session).debug(`Posted with ${reactions.length} reactions: ${formatShortId(post.id)}`);
  for (const emoji of reactions) {
    try {
      await session.platform.addReaction(post.id, emoji);
    } catch (err) {
      sessionLog(session).warn(`Failed to add reaction :${emoji}:: ${err}`);
    }
  }
  return post;
}


/**
 * Create an interactive post using platform's native interactive post functionality.
 * This is preferred over postWithReactions when available.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param reactions - Array of emoji names to add as reactions
 * @returns The created post
 */
export async function postInteractive(
  session: Session,
  message: string,
  reactions: string[]
): Promise<PlatformPost> {
  const post = await session.platform.createInteractivePost(message, reactions, session.threadId);
  updateLastMessage(session, post);
  return post;
}

/**
 * Create an interactive post and register for reaction routing.
 *
 * @param session - The session to post to
 * @param message - The message content
 * @param reactions - Array of emoji names to add as reactions
 * @param registerPost - Function to register the post for reaction routing
 * @returns The created post
 */
export async function postInteractiveAndRegister(
  session: Session,
  message: string,
  reactions: string[],
  registerPost: (postId: string, threadId: string) => void
): Promise<PlatformPost> {
  const post = await postInteractive(session, message, reactions);
  registerPost(post.id, session.threadId);
  return post;
}

// =============================================================================
// Update Post Functions
// =============================================================================

/**
 * Update an existing post with new content.
 * Wraps platform.updatePost with consistent error handling.
 *
 * @param session - The session containing the post
 * @param postId - ID of the post to update
 * @param message - New message content
 */
export async function updatePost(
  session: Session,
  postId: string,
  message: string
): Promise<void> {
  await withErrorHandling(
    () => session.platform.updatePost(postId, message),
    { action: 'Update post', session }
  );
}

/**
 * Update a post with a success message (with checkmark prefix).
 *
 * @param session - The session containing the post
 * @param postId - ID of the post to update
 * @param message - Message content (without emoji)
 */
export async function updatePostSuccess(
  session: Session,
  postId: string,
  message: string
): Promise<void> {
  await updatePost(session, postId, `✅ ${message}`);
}

/**
 * Update a post with an error message (with X prefix).
 *
 * @param session - The session containing the post
 * @param postId - ID of the post to update
 * @param message - Message content (without emoji)
 */
export async function updatePostError(
  session: Session,
  postId: string,
  message: string
): Promise<void> {
  await updatePost(session, postId, `❌ ${message}`);
}

/**
 * Update a post with a cancelled message (with no-entry prefix).
 *
 * @param session - The session containing the post
 * @param postId - ID of the post to update
 * @param message - Message content (without emoji)
 */
export async function updatePostCancelled(
  session: Session,
  postId: string,
  message: string
): Promise<void> {
  await updatePost(session, postId, `🚫 ${message}`);
}

// =============================================================================
// Reaction Functions
// =============================================================================

/**
 * Remove a reaction from a post.
 * Wraps platform.removeReaction with consistent error handling.
 *
 * @param session - The session containing the post
 * @param postId - ID of the post to remove the reaction from
 * @param emoji - The emoji name to remove (e.g., 'x', '+1')
 */
export async function removeReaction(
  session: Session,
  postId: string,
  emoji: string
): Promise<void> {
  await withErrorHandling(
    () => session.platform.removeReaction(postId, emoji),
    { action: `Remove ${emoji} reaction`, session }
  );
}

/**
 * Reset session activity state and clear duo-post tracking.
 * Call this when activity occurs to prevent updating stale posts in long threads.
 * Also updates worktree metadata to prevent the cleanup scheduler from
 * pruning actively-used worktrees.
 *
 * @param session - The session to reset activity for
 */
export function resetSessionActivity(session: Session): void {
  session.lastActivityAt = new Date();
  session.timeoutWarningPosted = false;
  session.lifecyclePostId = undefined;
  // Reset lifecycle state to active (clearing paused/interrupted states) —
  // but never clobber an in-progress restart or cancel. This runs on every
  // Claude event, and the dying process of a `!cd`/`!permissions`/worktree
  // respawn can emit one last event during kill(); flipping 'restarting'
  // back to 'active' here made handleExit treat the old process's exit as a
  // real session end and tear down the freshly restarted session (flaky
  // "!cd should restart Claude CLI" integration test).
  const state = session.lifecycle.state;
  if (state !== 'restarting' && state !== 'cancelling') {
    transitionTo(session, 'active');
  }

  // Update worktree metadata to prevent aggressive cleanup of active worktrees.
  // This is fire-and-forget - we don't want to block session activity on disk I/O.
  if (session.worktreeInfo?.worktreePath) {
    void updateWorktreeActivity(session.worktreeInfo.worktreePath, session.sessionId);
  }
}

/**
 * Update the session's last message tracking.
 * This enables "jump to bottom" functionality in thread links.
 *
 * @param session - The session to update
 * @param post - The post that was just created
 */
export function updateLastMessage(session: Session, post: PlatformPost): void {
  session.lastMessageId = post.id;
  // For Slack, we need the timestamp as well (format: "1234567890.123456")
  // The post ID in Slack is the timestamp, so we can use it directly
  if (session.platform.platformType === 'slack') {
    session.lastMessageTs = post.id;
  }
}

// =============================================================================
// Bold/Formatted Message Helpers
// =============================================================================

/**
 * Format a message with bold label using platform-specific formatting.
 * @param formatter - The platform formatter to use
 * @param label - The label to make bold
 * @param rest - Optional rest of the message (not bolded)
 * @example formatBold(formatter, 'Session cancelled', 'by @user') => '**Session cancelled** by @user' (Mattermost)
 * @example formatBold(formatter, 'Session cancelled', 'by @user') => '*Session cancelled* by @user' (Slack)
 */
export function formatBold(formatter: PlatformFormatter, label: string, rest?: string): string {
  return rest ? `${formatter.formatBold(label)} ${rest}` : formatter.formatBold(label);
}

/**
 * Post a message with a bold label.
 *
 * Note: This is an internal helper. Prefer using post() with formatBold() for new code.
 *
 * @param session - The session to post to
 * @param emoji - Emoji prefix (or empty string)
 * @param label - Bold label text
 * @param rest - Optional rest of the message
 * @returns The created post
 */
async function postBold(
  session: Session,
  emoji: string,
  label: string,
  rest?: string
): Promise<PlatformPost> {
  const formatter = session.platform.getFormatter();
  const message = emoji
    ? `${emoji} ${formatBold(formatter, label, rest)}`
    : formatBold(formatter, label, rest);
  return createPostAndTrack(session, message);
}

// Export internal helpers for testing (but not re-exported from operations/index.ts)
export { postWithReactions as _postWithReactions, postBold as _postBold };
