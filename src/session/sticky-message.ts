/**
 * Sticky Channel Message module
 *
 * Maintains a "sticky" message at the bottom of the channel that displays
 * an overview of active sessions with links to their threads.
 * The message is updated whenever sessions start or end.
 */

import type { Session } from './types.js';
import type { PlatformClient } from '../platform/index.js';
import type { SessionStore, PersistedSession } from '../persistence/session-store.js';
import type { WorktreeMode } from '../config.js';
import { formatBatteryStatus } from '../utils/battery.js';
import { formatUptime } from '../utils/uptime.js';
import { formatRelativeTimeShort } from '../utils/format.js';
import { VERSION } from '../version.js';
import { createLogger } from '../utils/logger.js';
import { formatPullRequestLink } from '../utils/pr-detector.js';
import { getClaudeCliVersion } from '../claude/version-check.js';

const log = createLogger('sticky');

// Bot start time for uptime tracking
const botStartedAt = new Date();

// =============================================================================
// Pending Prompts
// =============================================================================

/**
 * Represents a pending prompt awaiting user response.
 * Used for displaying pending states in the thread list.
 */
export interface PendingPrompt {
  /** Type of prompt */
  type: 'plan' | 'question' | 'message_approval' | 'worktree' | 'existing_worktree' | 'context';
  /** Short label for display (e.g., "Plan approval", "Question 2/5") */
  label: string;
  /** Emoji indicator */
  emoji: string;
}

/**
 * Extract all pending prompts from a session.
 * Returns an array of pending prompts that are awaiting user response.
 *
 * This is a reusable function that can be used anywhere pending state
 * needs to be displayed (sticky message, session header, etc.)
 */
export function getPendingPrompts(session: Session): PendingPrompt[] {
  const prompts: PendingPrompt[] = [];

  // Plan approval
  if (session.pendingApproval?.type === 'plan') {
    prompts.push({
      type: 'plan',
      label: 'Plan approval',
      emoji: '📋',
    });
  }

  // Question set (multi-step questions)
  if (session.pendingQuestionSet) {
    const current = session.pendingQuestionSet.currentIndex + 1;
    const total = session.pendingQuestionSet.questions.length;
    prompts.push({
      type: 'question',
      label: `Question ${current}/${total}`,
      emoji: '❓',
    });
  }

  // Message approval (unauthorized user message)
  if (session.pendingMessageApproval) {
    prompts.push({
      type: 'message_approval',
      label: 'Message approval',
      emoji: '💬',
    });
  }

  // Worktree prompt (waiting for branch name)
  if (session.pendingWorktreePrompt) {
    prompts.push({
      type: 'worktree',
      label: 'Branch name',
      emoji: '🌿',
    });
  }

  // Existing worktree prompt (join existing?)
  if (session.pendingExistingWorktreePrompt) {
    prompts.push({
      type: 'existing_worktree',
      label: 'Join worktree',
      emoji: '🌿',
    });
  }

  // Context prompt (include previous messages?)
  if (session.pendingContextPrompt) {
    prompts.push({
      type: 'context',
      label: 'Context selection',
      emoji: '📝',
    });
  }

  return prompts;
}

/**
 * Format pending prompts for display in a single line.
 * Returns a formatted string or null if no pending prompts.
 *
 * Example output: "⏳ 📋 Plan approval"
 * Example output: "⏳ ❓ Question 2/5 · 💬 Message approval"
 */
export function formatPendingPrompts(session: Session): string | null {
  const prompts = getPendingPrompts(session);
  if (prompts.length === 0) return null;

  const formatted = prompts.map(p => `${p.emoji} ${p.label}`).join(' · ');
  return `⏳ ${formatted}`;
}

/**
 * Configuration for sticky message status bar
 */
export interface StickyMessageConfig {
  maxSessions: number;
  chromeEnabled: boolean;
  skipPermissions: boolean;
  worktreeMode: WorktreeMode;
  workingDir: string;
  debug: boolean;
}

// Store sticky post IDs per platform (in-memory cache)
const stickyPostIds: Map<string, string> = new Map();

// Track if there's been a channel post since last sticky update (per platform)
// If false, we can just update in place instead of delete+recreate
const needsBump: Map<string, boolean> = new Map();

// Mutex to prevent concurrent updates per platform (prevents race conditions)
const updateLocks: Map<string, Promise<void>> = new Map();

// Reference to session store for persistence
let sessionStore: SessionStore | null = null;

/**
 * Initialize the sticky message module with the session store for persistence.
 */
export function initialize(store: SessionStore): void {
  sessionStore = store;

  // Restore sticky post IDs from persistence
  const persistedIds = store.getStickyPostIds();
  for (const [platformId, postId] of persistedIds) {
    stickyPostIds.set(platformId, postId);
  }

  if (persistedIds.size > 0) {
    log.info(`📌 Restored ${persistedIds.size} sticky post ID(s) from persistence`);
  }
}



/**
 * Extract task progress from session's lastTasksContent.
 * Returns string like "3/7" or null if no tasks.
 */
function getTaskProgress(session: Session): string | null {
  if (!session.lastTasksContent) return null;

  // Parse progress from format: "📋 **Tasks** (3/7 · 43%)"
  const match = session.lastTasksContent.match(/\((\d+)\/(\d+)/);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return null;
}

/**
 * Extract the active (in-progress) task name from session's lastTasksContent.
 * Returns the task activeForm or null if no task is in progress.
 *
 * Task format in lastTasksContent:
 * 🔄 **Task name** (12s)
 */
function getActiveTask(session: Session): string | null {
  if (!session.lastTasksContent) return null;

  // Parse in-progress task from format: "🔄 **Task name** (12s)" or "🔄 **Task name**"
  // The activeForm is wrapped in ** and may have elapsed time in parentheses
  const match = session.lastTasksContent.match(/🔄 \*\*([^*]+)\*\*/);
  if (match) {
    return match[1].trim();
  }
  return null;
}

/**
 * Get the display topic for a session.
 * Prefers the dynamic sessionTitle (generated by Claude), falls back to firstPrompt.
 */
function getSessionTopic(session: Session): string {
  // Use Claude-generated title if available
  if (session.sessionTitle) {
    return session.sessionTitle;
  }

  // Fall back to first prompt
  return formatTopicFromPrompt(session.firstPrompt);
}

/**
 * Get the display topic for a persisted session (history).
 */
function getHistorySessionTopic(session: PersistedSession): string {
  if (session.sessionTitle) {
    return session.sessionTitle;
  }
  return formatTopicFromPrompt(session.firstPrompt);
}

/**
 * Format a history session entry for display.
 * @param session - The inactive session from history (completed or timed out)
 * @returns Formatted line for the sticky message
 */
function formatHistoryEntry(session: PersistedSession): string[] {
  const topic = getHistorySessionTopic(session);
  const threadLink = `[${topic}](/_redirect/pl/${session.threadId})`;
  const displayName = session.startedByDisplayName || session.startedBy;
  // Determine if this is a timed-out (resumable) session or a completed session
  const isTimedOut = !session.cleanedAt && session.timeoutPostId;
  // Show when the user last worked on it, not when it was cleaned up
  const lastActivity = new Date(session.lastActivityAt);
  const time = formatRelativeTimeShort(lastActivity);

  // Build PR link if available
  const prStr = session.pullRequestUrl ? ` · ${formatPullRequestLink(session.pullRequestUrl)}` : '';

  // Use different indicators: ⏸️ for timed out (resumable), ✓ for completed
  const indicator = isTimedOut ? '⏸️' : '✓';
  const resumeHint = isTimedOut ? ' · _react 🔄 to resume_' : '';

  const lines: string[] = [];
  lines.push(`  ${indicator} ${threadLink} · **${displayName}**${prStr} · ${time}${resumeHint}`);

  // Add description on next line if available
  if (session.sessionDescription) {
    lines.push(`     _${session.sessionDescription}_`);
  }

  return lines;
}

/**
 * Build the status bar for the sticky message.
 * Shows system-level info: version, sessions, settings, battery, uptime, hostname
 */
async function buildStatusBar(
  sessionCount: number,
  config: StickyMessageConfig
): Promise<string> {
  const items: string[] = [];

  // Version (claude-threads + Claude CLI)
  const claudeVersion = getClaudeCliVersion();
  const versionStr = claudeVersion ? `v${VERSION} · CLI ${claudeVersion}` : `v${VERSION}`;
  items.push(`\`${versionStr}\``);

  // Session count
  items.push(`\`${sessionCount}/${config.maxSessions} sessions\``);

  // Permission mode
  const permMode = config.skipPermissions ? '⚡ Auto' : '🔐 Interactive';
  items.push(`\`${permMode}\``);

  // Worktree mode (only show if not default 'prompt')
  if (config.worktreeMode === 'require') {
    items.push('`🌿 Worktree: require`');
  } else if (config.worktreeMode === 'off') {
    items.push('`🌿 Worktree: off`');
  }

  // Chrome status
  if (config.chromeEnabled) {
    items.push('`🌐 Chrome`');
  }

  // Debug mode
  if (config.debug) {
    items.push('`🐛 Debug`');
  }

  // Battery status (if available)
  const battery = await formatBatteryStatus();
  if (battery) {
    items.push(`\`${battery}\``);
  }

  // Bot uptime
  const uptime = formatUptime(botStartedAt);
  items.push(`\`⏱️ ${uptime}\``);

  // Working directory (shortened)
  const shortDir = config.workingDir.replace(process.env.HOME || '', '~');
  items.push(`\`📂 ${shortDir}\``);

  return items.join(' · ');
}

/**
 * Truncate and clean a prompt for display as a thread topic
 */
function formatTopicFromPrompt(prompt: string | undefined): string {
  if (!prompt) return '_No topic_';

  // Remove @mentions at the start
  let cleaned = prompt.replace(/^@[\w-]+\s*/g, '').trim();

  // Skip bot commands (e.g., !worktree switch, !cd) - these aren't meaningful topics
  if (cleaned.startsWith('!')) {
    return '_No topic_';
  }

  // Remove newlines and collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ');

  // Truncate to ~50 chars with ellipsis
  if (cleaned.length > 50) {
    cleaned = cleaned.substring(0, 47) + '…';
  }

  return cleaned || '_No topic_';
}


/**
 * Build the sticky message content showing all active sessions
 */
export async function buildStickyMessage(
  sessions: Map<string, Session>,
  platformId: string,
  config: StickyMessageConfig
): Promise<string> {
  // Filter sessions for this platform
  const platformSessions = [...sessions.values()].filter(
    s => s.platformId === platformId
  );

  // Build status bar (shown even when no sessions)
  const statusBar = await buildStatusBar(platformSessions.length, config);

  // Get recent history (completed + timed-out sessions)
  // Pass active session IDs to exclude them from history
  const activeSessionIds = new Set(sessions.keys());
  const historySessions = sessionStore ? sessionStore.getHistory(platformId, activeSessionIds).slice(0, 5) : [];

  if (platformSessions.length === 0) {
    const lines = [
      '---',
      statusBar,
      '',
      '**Active Claude Threads**',
      '',
      '_No active sessions_',
    ];

    // Add history section if there are recent completed sessions
    if (historySessions.length > 0) {
      lines.push('');
      lines.push(`**Recent** (${historySessions.length})`);
      lines.push('');
      for (const historySession of historySessions) {
        lines.push(...formatHistoryEntry(historySession));
      }
    }

    lines.push('');
    lines.push('_Mention me to start a session_ · `npm i -g claude-threads`');

    return lines.join('\n');
  }

  // Sort by start time (newest first)
  platformSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  const count = platformSessions.length;
  const lines: string[] = [
    '---',
    statusBar,
    '',
    `**Active Claude Threads** (${count})`,
    '',
  ];

  for (const session of platformSessions) {
    const topic = getSessionTopic(session);
    const threadLink = `[${topic}](/_redirect/pl/${session.threadId})`;
    const displayName = session.startedByDisplayName || session.startedBy;
    const time = formatRelativeTimeShort(session.startedAt);

    // Build task progress if available (e.g., "3/7")
    const taskProgress = getTaskProgress(session);
    const progressStr = taskProgress ? ` · ${taskProgress}` : '';

    // Build PR link if available (compact format on same line)
    const prStr = session.pullRequestUrl ? ` · ${formatPullRequestLink(session.pullRequestUrl)}` : '';

    lines.push(`▸ ${threadLink} · **${displayName}**${progressStr}${prStr} · ${time}`);

    // Add description on next line if available
    if (session.sessionDescription) {
      lines.push(`   _${session.sessionDescription}_`);
    }

    // Add pending prompts if any (awaiting user input)
    const pendingPromptsStr = formatPendingPrompts(session);
    if (pendingPromptsStr) {
      lines.push(`   ${pendingPromptsStr}`);
    }

    // Add active task below description if available (only if no pending prompts)
    const activeTask = getActiveTask(session);
    if (activeTask && !pendingPromptsStr) {
      lines.push(`   🔄 _${activeTask}_`);
    }
  }

  // Add history section if there are recent completed sessions
  if (historySessions.length > 0) {
    lines.push('');
    lines.push(`**Recent** (${historySessions.length})`);
    lines.push('');
    for (const historySession of historySessions) {
      lines.push(...formatHistoryEntry(historySession));
    }
  }

  lines.push('');
  lines.push('_Mention me to start a session_ · `npm i -g claude-threads`');

  return lines.join('\n');
}

/**
 * Update the sticky channel message for a platform.
 * If someone posted in the channel since last update, deletes and recreates at bottom.
 * Otherwise, just updates in place to avoid noise.
 *
 * Uses a mutex to prevent concurrent updates which can cause duplicate sticky posts.
 */
export async function updateStickyMessage(
  platform: PlatformClient,
  sessions: Map<string, Session>,
  config: StickyMessageConfig
): Promise<void> {
  const platformId = platform.platformId;

  // Wait for any pending update to complete (mutex)
  const pendingUpdate = updateLocks.get(platformId);
  if (pendingUpdate) {
    await pendingUpdate;
  }

  // Create a new lock for this update
  let releaseLock: (() => void) | undefined;
  const lock = new Promise<void>(resolve => { releaseLock = resolve; });
  updateLocks.set(platformId, lock);

  try {
    await updateStickyMessageImpl(platform, sessions, config);
  } finally {
    if (releaseLock) releaseLock();
    updateLocks.delete(platformId);
  }
}

/**
 * Internal implementation of sticky message update.
 */
async function updateStickyMessageImpl(
  platform: PlatformClient,
  sessions: Map<string, Session>,
  config: StickyMessageConfig
): Promise<void> {
  const platformSessions = [...sessions.values()].filter(s => s.platformId === platform.platformId);
  log.debug(`updateStickyMessage for ${platform.platformId}, ${platformSessions.length} sessions`);
  for (const s of platformSessions) {
    log.debug(`  - ${s.sessionId}: title="${s.sessionTitle}" firstPrompt="${s.firstPrompt?.substring(0, 30)}..."`);
  }

  const content = await buildStickyMessage(sessions, platform.platformId, config);
  const existingPostId = stickyPostIds.get(platform.platformId);
  const shouldBump = needsBump.get(platform.platformId) ?? false;

  log.debug(`existingPostId: ${existingPostId || '(none)'}, needsBump: ${shouldBump}`);
  log.debug(`content preview: ${content.substring(0, 100).replace(/\n/g, '\\n')}...`);

  try {
    // If we have an existing post and no bump is needed, just update in place
    if (existingPostId && !shouldBump) {
      log.debug(`Updating existing post in place...`);
      try {
        await platform.updatePost(existingPostId, content);
        // Re-pin to ensure it stays pinned (defensive - pin status can be lost)
        try {
          await platform.pinPost(existingPostId);
          log.debug(`Re-pinned post`);
        } catch (pinErr) {
          log.debug(`Re-pin failed (might already be pinned): ${pinErr}`);
        }
        log.debug(`Updated successfully`);
        return;
      } catch (err) {
        // Post might have been deleted, fall through to create new one
        log.debug(`Update failed, will create new: ${err}`);
      }
    }

    // Reset bump flag
    needsBump.set(platform.platformId, false);

    // Delete existing sticky post if it exists
    if (existingPostId) {
      log.debug(`Unpinning and deleting existing post ${existingPostId.substring(0, 8)}...`);
      try {
        // Unpin first, then delete
        await platform.unpinPost(existingPostId);
        log.debug(`Unpinned successfully`);
      } catch (err) {
        // Post might already be unpinned or deleted, that's fine
        log.debug(`Unpin failed (probably already unpinned): ${err}`);
      }
      try {
        await platform.deletePost(existingPostId);
        log.debug(`Deleted successfully`);
      } catch (err) {
        // Post might already be deleted, that's fine
        log.debug(`Delete failed (probably already deleted): ${err}`);
      }
      stickyPostIds.delete(platform.platformId);
    }

    // Create new sticky post at the bottom (no threadId = channel post)
    log.debug(`Creating new post...`);
    const post = await platform.createPost(content);
    stickyPostIds.set(platform.platformId, post.id);

    // Pin the post to keep it visible
    try {
      await platform.pinPost(post.id);
      log.debug(`Pinned post successfully`);
    } catch (err) {
      log.debug(`Failed to pin post: ${err}`);
    }

    // Persist the new sticky post ID
    if (sessionStore) {
      sessionStore.saveStickyPostId(platform.platformId, post.id);
    }

    log.info(`📌 Created sticky message for ${platform.platformId}: ${post.id.substring(0, 8)}...`);
  } catch (err) {
    log.error(`⚠️ Failed to update sticky message for ${platform.platformId}`, err instanceof Error ? err : undefined);
  }
}

/**
 * Update sticky messages for all platforms.
 * Called whenever sessions change.
 */
export async function updateAllStickyMessages(
  platforms: Map<string, PlatformClient>,
  sessions: Map<string, Session>,
  config: StickyMessageConfig
): Promise<void> {
  const updates = [...platforms.values()].map(platform =>
    updateStickyMessage(platform, sessions, config)
  );
  await Promise.all(updates);
}

/**
 * Get the sticky post ID for a platform (for persistence).
 */
export function getStickyPostId(platformId: string): string | undefined {
  return stickyPostIds.get(platformId);
}

/**
 * Set the sticky post ID for a platform (for restoration after restart).
 */
export function setStickyPostId(platformId: string, postId: string): void {
  stickyPostIds.set(platformId, postId);
}

/**
 * Get all sticky post IDs (for persistence).
 */
export function getAllStickyPostIds(): Map<string, string> {
  return new Map(stickyPostIds);
}

/**
 * Restore sticky post IDs from persistence.
 */
export function restoreStickyPostIds(postIds: Map<string, string>): void {
  for (const [platformId, postId] of postIds) {
    stickyPostIds.set(platformId, postId);
  }
}

/**
 * Mark that a platform needs to bump its sticky message to the bottom.
 * Called when someone posts in the channel (not in a thread).
 */
export function markNeedsBump(platformId: string): void {
  needsBump.set(platformId, true);
}

/**
 * Clean up old pinned sticky messages from the bot.
 * Unpins and deletes any pinned posts from the bot except the current sticky.
 * Should be called at startup.
 */
export async function cleanupOldStickyMessages(
  platform: PlatformClient,
  botUserId: string
): Promise<void> {
  const currentStickyId = stickyPostIds.get(platform.platformId);

  try {
    // Get all pinned posts in the channel
    const pinnedPostIds = await platform.getPinnedPosts();
    log.debug(`Found ${pinnedPostIds.length} pinned posts, current sticky: ${currentStickyId?.substring(0, 8) || '(none)'}`);

    for (const postId of pinnedPostIds) {
      // Skip the current sticky
      if (postId === currentStickyId) continue;

      // Get post details to check if it's from the bot
      try {
        const post = await platform.getPost(postId);
        if (!post) continue;

        // Check if this post is from our bot (match user ID)
        // The post's userId should match botUserId if it's ours
        if (post.userId === botUserId) {
          log.debug(`Cleaning up old sticky: ${postId.substring(0, 8)}...`);
          try {
            await platform.unpinPost(postId);
            await platform.deletePost(postId);
            log.info(`🧹 Cleaned up old sticky message: ${postId.substring(0, 8)}...`);
          } catch (err) {
            log.debug(`Failed to cleanup ${postId}: ${err}`);
          }
        }
      } catch (err) {
        // Post might be deleted or inaccessible, skip it
        log.debug(`Could not check post ${postId}: ${err}`);
      }
    }
  } catch (err) {
    log.error(`⚠️ Failed to cleanup old sticky messages`, err instanceof Error ? err : undefined);
  }
}
