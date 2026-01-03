/**
 * User commands module
 *
 * Handles user commands like !cd, !invite, !kick, !permissions, !escape, !stop.
 */

import type { Session } from './types.js';
import type { SessionContext } from './context.js';
import type { ClaudeCliOptions, ClaudeEvent } from '../claude/cli.js';
import { ClaudeCli } from '../claude/cli.js';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';
import { getUpdateInfo } from '../update-notifier.js';
import { getReleaseNotes, getWhatsNewSummary } from '../changelog.js';
import { getLogo } from '../logo.js';
import { VERSION } from '../version.js';
import {
  APPROVAL_EMOJIS,
  DENIAL_EMOJIS,
  ALLOW_ALL_EMOJIS,
} from '../utils/emoji.js';
import { formatBatteryStatus } from '../utils/battery.js';
import { formatUptime } from '../utils/uptime.js';
import { keepAlive } from '../utils/keep-alive.js';
import { logAndNotify, withErrorHandling } from './error-handler.js';
import { postCancelled, postInfo, postWarning, postError, postSuccess, postSecure, postInterrupt, postCommand, postUser } from './post-helpers.js';
import { createLogger } from '../utils/logger.js';
import { formatPullRequestLink } from '../utils/pr-detector.js';
import { getCurrentBranch, isGitRepository } from '../git/worktree.js';

const log = createLogger('commands');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Restart Claude CLI with new options.
 * Handles the common pattern of kill -> flush -> create new CLI -> rebind -> start.
 * Returns true on success, false if start failed.
 */
async function restartClaudeSession(
  session: Session,
  cliOptions: ClaudeCliOptions,
  ctx: SessionContext,
  actionName: string
): Promise<boolean> {
  // Stop the current Claude CLI
  ctx.ops.stopTyping(session);
  session.isRestarting = true;
  session.claude.kill();

  // Flush any pending content
  await ctx.ops.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  // Create new Claude CLI
  session.claude = new ClaudeCli(cliOptions);

  // Rebind event handlers (use sessionId which is the composite key)
  session.claude.on('event', (e: ClaudeEvent) => ctx.ops.handleEvent(session.sessionId, e));
  session.claude.on('exit', (code: number) => ctx.ops.handleExit(session.sessionId, code));

  // Start the new Claude CLI
  try {
    session.claude.start();
    return true;
  } catch (err) {
    session.isRestarting = false;
    await logAndNotify(err, { action: actionName, session });
    return false;
  }
}

/**
 * Check if user is session owner or globally allowed.
 * Posts warning message if not authorized.
 * Returns true if authorized, false otherwise.
 */
async function requireSessionOwner(
  session: Session,
  username: string,
  action: string
): Promise<boolean> {
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await postWarning(session, `Only @${session.startedBy} or allowed users can ${action}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a visual progress bar for context usage
 * @param percent - Percentage of context used (0-100)
 * @returns A visual bar like "▓▓▓▓░░░░░░" with color indication
 */
function formatContextBar(percent: number): string {
  const totalBlocks = 10;
  // Clamp filledBlocks to [0, totalBlocks] to handle >100% usage
  const filledBlocks = Math.min(totalBlocks, Math.max(0, Math.round((percent / 100) * totalBlocks)));
  const emptyBlocks = totalBlocks - filledBlocks;

  // Use different indicators based on usage level
  let indicator: string;
  if (percent < 50) {
    indicator = '🟢';  // Green - plenty of context
  } else if (percent < 75) {
    indicator = '🟡';  // Yellow - moderate usage
  } else if (percent < 90) {
    indicator = '🟠';  // Orange - getting full
  } else {
    indicator = '🔴';  // Red - almost full
  }

  const filled = '▓'.repeat(filledBlocks);
  const empty = '░'.repeat(emptyBlocks);

  return `${indicator}${filled}${empty}`;
}

// ---------------------------------------------------------------------------
// Session control commands
// ---------------------------------------------------------------------------

/**
 * Cancel a session completely (like !stop or ❌ reaction).
 */
export async function cancelSession(
  session: Session,
  username: string,
  ctx: SessionContext
): Promise<void> {
  const shortId = session.threadId.substring(0, 8);
  log.info(`🛑 Session (${shortId}…) cancelled by @${username}`);

  await postCancelled(session, `**Session cancelled** by @${username}`);

  await ctx.ops.killSession(session.threadId);
}

/**
 * Interrupt current processing but keep session alive (like !escape or ⏸️).
 */
export async function interruptSession(
  session: Session,
  username: string
): Promise<void> {
  if (!session.claude.isRunning()) {
    await postInfo(session, `Session is idle, nothing to interrupt`);
    return;
  }

  const shortId = session.threadId.substring(0, 8);

  // Set flag BEFORE interrupt - if Claude exits due to SIGINT, we won't unpersist
  session.wasInterrupted = true;
  const interrupted = session.claude.interrupt();

  if (interrupted) {
    log.info(`⏸️ Session (${shortId}…) interrupted by @${username}`);
    await postInterrupt(session, `**Interrupted** by @${username}`);
  }
}

// ---------------------------------------------------------------------------
// Directory management
// ---------------------------------------------------------------------------

/**
 * Change working directory for a session (restarts Claude CLI).
 */
export async function changeDirectory(
  session: Session,
  newDir: string,
  username: string,
  ctx: SessionContext
): Promise<void> {
  // Only session owner or globally allowed users can change directory
  if (!await requireSessionOwner(session, username, 'change the working directory')) {
    return;
  }

  // Expand ~ to home directory
  const expandedDir = newDir.startsWith('~')
    ? newDir.replace('~', process.env.HOME || '')
    : newDir;

  // Resolve to absolute path
  const absoluteDir = resolve(expandedDir);

  // Check if directory exists
  if (!existsSync(absoluteDir)) {
    await postError(session, `Directory does not exist: \`${newDir}\``);
    return;
  }

  if (!statSync(absoluteDir).isDirectory()) {
    await postError(session, `Not a directory: \`${newDir}\``);
    return;
  }

  const shortId = session.threadId.substring(0, 8);
  const shortDir = absoluteDir.replace(process.env.HOME || '', '~');
  log.info(`📂 Session (${shortId}…) changing directory to ${shortDir}`);

  // Update session working directory
  session.workingDir = absoluteDir;

  // Generate new session ID for fresh start in new directory
  const newSessionId = randomUUID();
  session.claudeSessionId = newSessionId;

  const cliOptions: ClaudeCliOptions = {
    workingDir: absoluteDir,
    threadId: session.threadId,
    skipPermissions: ctx.config.skipPermissions || !session.forceInteractivePermissions,
    sessionId: newSessionId,
    resume: false, // Fresh start - can't resume across directories
    chrome: ctx.config.chromeEnabled,
    platformConfig: session.platform.getMcpConfig(),
  };

  // Restart Claude with new options
  const success = await restartClaudeSession(session, cliOptions, ctx, 'Restart Claude for directory change');
  if (!success) return;

  // Update session header with new directory
  await updateSessionHeader(session, ctx);

  // Post confirmation
  await postCommand(session, `**Working directory changed** to \`${shortDir}\`\n*Claude Code restarted in new directory*`);

  // Update activity
  session.lastActivityAt = new Date();
  session.timeoutWarningPosted = false;

  // Mark session to offer context prompt on next message
  // This allows the user to include thread history after directory change
  session.needsContextPromptOnNextMessage = true;

  // Persist the updated session state
  ctx.ops.persistSession(session);
}

// ---------------------------------------------------------------------------
// User collaboration commands
// ---------------------------------------------------------------------------

/**
 * Invite a user to participate in a session.
 */
export async function inviteUser(
  session: Session,
  invitedUser: string,
  invitedBy: string,
  ctx: SessionContext
): Promise<void> {
  // Only session owner or globally allowed users can invite
  if (!await requireSessionOwner(session, invitedBy, 'invite others')) {
    return;
  }

  // Validate that the user exists on the platform
  const user = await session.platform.getUserByUsername(invitedUser);
  if (!user) {
    await postWarning(session, `User @${invitedUser} does not exist on this platform`);
    return;
  }

  session.sessionAllowedUsers.add(invitedUser);
  await postSuccess(session, `@${invitedUser} can now participate in this session (invited by @${invitedBy})`);
  log.info(`👋 @${invitedUser} invited to session by @${invitedBy}`);
  await updateSessionHeader(session, ctx);
  ctx.ops.persistSession(session);
}

/**
 * Kick a user from a session.
 */
export async function kickUser(
  session: Session,
  kickedUser: string,
  kickedBy: string,
  ctx: SessionContext
): Promise<void> {
  // Only session owner or globally allowed users can kick
  if (!await requireSessionOwner(session, kickedBy, 'kick others')) {
    return;
  }

  // Validate that the user exists on the platform
  const user = await session.platform.getUserByUsername(kickedUser);
  if (!user) {
    await postWarning(session, `User @${kickedUser} does not exist on this platform`);
    return;
  }

  // Can't kick session owner
  if (kickedUser === session.startedBy) {
    await postWarning(session, `Cannot kick session owner @${session.startedBy}`);
    return;
  }

  // Can't kick globally allowed users
  if (session.platform.isUserAllowed(kickedUser)) {
    await postWarning(session, `@${kickedUser} is globally allowed and cannot be kicked from individual sessions`);
    return;
  }

  if (session.sessionAllowedUsers.delete(kickedUser)) {
    await postUser(session, `@${kickedUser} removed from this session by @${kickedBy}`);
    log.info(`🚫 @${kickedUser} kicked from session by @${kickedBy}`);
    await updateSessionHeader(session, ctx);
    ctx.ops.persistSession(session);
  } else {
    await postWarning(session, `@${kickedUser} was not in this session`);
  }
}

// ---------------------------------------------------------------------------
// Permission management
// ---------------------------------------------------------------------------

/**
 * Enable interactive permissions for a session.
 */
export async function enableInteractivePermissions(
  session: Session,
  username: string,
  ctx: SessionContext
): Promise<void> {
  // Only session owner or globally allowed users can change permissions
  if (!await requireSessionOwner(session, username, 'change permissions')) {
    return;
  }

  // Can only downgrade, not upgrade
  if (!ctx.config.skipPermissions) {
    await postInfo(session, `Permissions are already interactive for this session`);
    return;
  }

  // Already enabled for this session
  if (session.forceInteractivePermissions) {
    await postInfo(session, `Interactive permissions already enabled for this session`);
    return;
  }

  // Set the flag
  session.forceInteractivePermissions = true;

  const shortId = session.threadId.substring(0, 8);
  log.info(`🔐 Session (${shortId}…) enabling interactive permissions`);

  // Create new CLI options with interactive permissions
  const cliOptions: ClaudeCliOptions = {
    workingDir: session.workingDir,
    threadId: session.threadId,
    skipPermissions: false, // Force interactive permissions
    sessionId: session.claudeSessionId,
    resume: true, // Resume to keep conversation context
    chrome: ctx.config.chromeEnabled,
    platformConfig: session.platform.getMcpConfig(),
  };

  // Restart Claude with new options
  const success = await restartClaudeSession(session, cliOptions, ctx, 'Enable interactive permissions');
  if (!success) return;

  // Update session header with new permission status
  await updateSessionHeader(session, ctx);

  // Post confirmation
  await postSecure(session, `**Interactive permissions enabled** for this session by @${username}\n*Claude Code restarted with permission prompts*`);
  log.info(`🔐 Interactive permissions enabled for session by @${username}`);

  // Update activity and persist
  session.lastActivityAt = new Date();
  session.timeoutWarningPosted = false;
  ctx.ops.persistSession(session);
}

// ---------------------------------------------------------------------------
// Message approval
// ---------------------------------------------------------------------------

/**
 * Request approval for a message from an unauthorized user.
 */
export async function requestMessageApproval(
  session: Session,
  username: string,
  message: string,
  ctx: SessionContext
): Promise<void> {
  // If there's already a pending message approval, ignore
  if (session.pendingMessageApproval) {
    return;
  }

  // Truncate long messages for display
  const displayMessage = message.length > 200 ? message.substring(0, 200) + '...' : message;

  const approvalMessage =
    `🔒 **Message from @${username}** needs approval:\n\n` +
    `> ${displayMessage}\n\n` +
    `React: 👍 Allow once | ✅ Invite to session | 👎 Deny`;

  const post = await session.platform.createInteractivePost(
    approvalMessage,
    [APPROVAL_EMOJIS[0], ALLOW_ALL_EMOJIS[0], DENIAL_EMOJIS[0]],
    session.threadId
  );

  session.pendingMessageApproval = {
    postId: post.id,
    originalMessage: message,
    fromUser: username,
  };

  // Register post for reaction routing
  ctx.ops.registerPost(post.id, session.threadId);
}

// ---------------------------------------------------------------------------
// Session header
// ---------------------------------------------------------------------------

/**
 * Update the session header post with current participants and status.
 */
export async function updateSessionHeader(
  session: Session,
  ctx: SessionContext
): Promise<void> {
  if (!session.sessionStartPostId) return;

  // Use session's working directory
  const shortDir = session.workingDir.replace(process.env.HOME || '', '~');
  // Check session-level permission override
  const isInteractive = !ctx.config.skipPermissions || session.forceInteractivePermissions;
  const permMode = isInteractive ? '🔐 Interactive' : '⚡ Auto';

  // Build participants list (excluding owner)
  const otherParticipants = [...session.sessionAllowedUsers]
    .filter((u) => u !== session.startedBy)
    .map((u) => `@${u}`)
    .join(', ');

  // Build status bar items
  const statusItems: string[] = [];

  // Model and context usage (if available)
  if (session.usageStats) {
    const stats = session.usageStats;
    statusItems.push(`\`🤖 ${stats.modelDisplayName}\``);
    // Calculate context usage percentage (using primary model's context tokens)
    const contextPercent = Math.round((stats.contextTokens / stats.contextWindowSize) * 100);
    const contextBar = formatContextBar(contextPercent);
    statusItems.push(`\`${contextBar} ${contextPercent}%\``);
    // Show cost
    statusItems.push(`\`💰 $${stats.totalCostUSD.toFixed(2)}\``);
  }

  statusItems.push(`\`${session.sessionNumber}/${ctx.config.maxSessions}\``);
  statusItems.push(`\`${permMode}\``);
  if (ctx.config.chromeEnabled) {
    statusItems.push('`🌐 Chrome`');
  }
  if (keepAlive.isActive()) {
    statusItems.push('`💓 Keep-alive`');
  }
  const battery = await formatBatteryStatus();
  if (battery) {
    statusItems.push(`\`${battery}\``);
  }
  const uptime = formatUptime(session.startedAt);
  statusItems.push(`\`⏱️ ${uptime}\``);

  const statusBar = statusItems.join(' · ');

  const rows: string[] = [];

  // Add title and description if available
  if (session.sessionTitle) {
    rows.push(`| 📝 **Topic** | ${session.sessionTitle} |`);
  }
  if (session.sessionDescription) {
    rows.push(`| 📄 **Summary** | _${session.sessionDescription}_ |`);
  }

  rows.push(`| 📂 **Directory** | \`${shortDir}\` |`);
  rows.push(`| 👤 **Started by** | @${session.startedBy} |`);

  // Show worktree info if active, otherwise show git branch if in a git repo
  if (session.worktreeInfo) {
    const shortRepoRoot = session.worktreeInfo.repoRoot.replace(process.env.HOME || '', '~');
    rows.push(
      `| 🌿 **Worktree** | \`${session.worktreeInfo.branch}\` (from \`${shortRepoRoot}\`) |`
    );
  } else {
    // Check if we're in a git repository and get the current branch
    const isRepo = await isGitRepository(session.workingDir);
    if (isRepo) {
      const branch = await getCurrentBranch(session.workingDir);
      if (branch) {
        rows.push(`| 🌿 **Branch** | \`${branch}\` |`);
      }
    }
  }

  // Show pull request link if available
  if (session.pullRequestUrl) {
    rows.push(`| 🔗 **Pull Request** | ${formatPullRequestLink(session.pullRequestUrl)} |`);
  }

  if (otherParticipants) {
    rows.push(`| 👥 **Participants** | ${otherParticipants} |`);
  }

  rows.push(`| 🆔 **Session ID** | \`${session.claudeSessionId.substring(0, 8)}\` |`);

  // Check for available updates
  const updateInfo = getUpdateInfo();
  const updateNotice = updateInfo
    ? `\n> ⚠️ **Update available:** v${updateInfo.current} → v${updateInfo.latest} - Run \`npm install -g claude-threads\`\n`
    : '';

  // Get "What's new" from release notes
  const releaseNotes = getReleaseNotes(VERSION);
  const whatsNew = releaseNotes ? getWhatsNewSummary(releaseNotes) : '';
  const whatsNewLine = whatsNew ? `\n> ✨ **What's new:** ${whatsNew}\n` : '';

  const msg = [
    getLogo(VERSION),
    updateNotice,
    whatsNewLine,
    statusBar,
    '',
    `| | |`,
    `|:--|:--|`,
    ...rows,
  ].join('\n');

  const postId = session.sessionStartPostId;
  await withErrorHandling(
    () => session.platform.updatePost(postId, msg),
    { action: 'Update session header', session }
  );
}
