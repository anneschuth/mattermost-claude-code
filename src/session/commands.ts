/**
 * User commands module
 *
 * Handles user commands like !cd, !invite, !kick, !permissions, !escape, !stop.
 */

import type { Session } from './types.js';
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

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Format a visual progress bar for context usage
 * @param percent - Percentage of context used (0-100)
 * @returns A visual bar like "▓▓▓▓░░░░░░" with color indication
 */
function formatContextBar(percent: number): string {
  const totalBlocks = 10;
  const filledBlocks = Math.round((percent / 100) * totalBlocks);
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
// Context types for dependency injection
// ---------------------------------------------------------------------------

export interface CommandContext {
  skipPermissions: boolean;
  chromeEnabled: boolean;
  maxSessions: number;
  handleEvent: (sessionId: string, event: ClaudeEvent) => void;
  handleExit: (sessionId: string, code: number) => Promise<void>;
  flush: (session: Session) => Promise<void>;
  startTyping: (session: Session) => void;
  stopTyping: (session: Session) => void;
  persistSession: (session: Session) => void;
  killSession: (threadId: string) => Promise<void>;
  registerPost: (postId: string, threadId: string) => void;
  offerContextPrompt: (session: Session, queuedPrompt: string, excludePostId?: string) => Promise<boolean>;
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
  ctx: CommandContext
): Promise<void> {
  const shortId = session.threadId.substring(0, 8);
  console.log(`  🛑 Session (${shortId}…) cancelled by @${username}`);

  await session.platform.createPost(
    `🛑 **Session cancelled** by @${username}`,
    session.threadId
  );

  await ctx.killSession(session.threadId);
}

/**
 * Interrupt current processing but keep session alive (like !escape or ⏸️).
 */
export async function interruptSession(
  session: Session,
  username: string
): Promise<void> {
  if (!session.claude.isRunning()) {
    await session.platform.createPost(
      `ℹ️ Session is idle, nothing to interrupt`,
      session.threadId
    );
    return;
  }

  const shortId = session.threadId.substring(0, 8);

  // Set flag BEFORE interrupt - if Claude exits due to SIGINT, we won't unpersist
  session.wasInterrupted = true;
  const interrupted = session.claude.interrupt();

  if (interrupted) {
    console.log(`  ⏸️ Session (${shortId}…) interrupted by @${username}`);
    await session.platform.createPost(
      `⏸️ **Interrupted** by @${username}`,
      session.threadId
    );
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
  ctx: CommandContext
): Promise<void> {
  // Only session owner or globally allowed users can change directory
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await session.platform.createPost(
      `⚠️ Only @${session.startedBy} or allowed users can change the working directory`,
      session.threadId
    );
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
    await session.platform.createPost(
      `❌ Directory does not exist: \`${newDir}\``,
      session.threadId
    );
    return;
  }

  if (!statSync(absoluteDir).isDirectory()) {
    await session.platform.createPost(
      `❌ Not a directory: \`${newDir}\``,
      session.threadId
    );
    return;
  }

  const shortId = session.threadId.substring(0, 8);
  const shortDir = absoluteDir.replace(process.env.HOME || '', '~');
  console.log(`  📂 Session (${shortId}…) changing directory to ${shortDir}`);

  // Stop the current Claude CLI
  ctx.stopTyping(session);
  session.isRestarting = true; // Suppress exit message during restart
  session.claude.kill();

  // Flush any pending content
  await ctx.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  // Update session working directory
  session.workingDir = absoluteDir;

  // Generate new session ID for fresh start in new directory
  const newSessionId = randomUUID();
  session.claudeSessionId = newSessionId;

  const cliOptions: ClaudeCliOptions = {
    workingDir: absoluteDir,
    threadId: session.threadId,
    skipPermissions: ctx.skipPermissions || !session.forceInteractivePermissions,
    sessionId: newSessionId,
    resume: false, // Fresh start - can't resume across directories
    chrome: ctx.chromeEnabled,
    platformConfig: session.platform.getMcpConfig(),
  };
  session.claude = new ClaudeCli(cliOptions);

  // Rebind event handlers (use sessionId which is the composite key)
  session.claude.on('event', (e: ClaudeEvent) => ctx.handleEvent(session.sessionId, e));
  session.claude.on('exit', (code: number) => ctx.handleExit(session.sessionId, code));

  // Start the new Claude CLI
  try {
    session.claude.start();
  } catch (err) {
    session.isRestarting = false;
    console.error('  ❌ Failed to restart Claude:', err);
    await session.platform.createPost(`❌ Failed to restart Claude: ${err}`, session.threadId);
    return;
  }

  // Update session header with new directory
  await updateSessionHeader(session, ctx);

  // Post confirmation
  await session.platform.createPost(
    `📂 **Working directory changed** to \`${shortDir}\`\n*Claude Code restarted in new directory*`,
    session.threadId
  );

  // Update activity
  session.lastActivityAt = new Date();
  session.timeoutWarningPosted = false;

  // Mark session to offer context prompt on next message
  // This allows the user to include thread history after directory change
  session.needsContextPromptOnNextMessage = true;

  // Persist the updated session state
  ctx.persistSession(session);
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
  ctx: CommandContext
): Promise<void> {
  // Only session owner or globally allowed users can invite
  if (session.startedBy !== invitedBy && !session.platform.isUserAllowed(invitedBy)) {
    await session.platform.createPost(
      `⚠️ Only @${session.startedBy} or allowed users can invite others`,
      session.threadId
    );
    return;
  }

  session.sessionAllowedUsers.add(invitedUser);
  await session.platform.createPost(
    `✅ @${invitedUser} can now participate in this session (invited by @${invitedBy})`,
    session.threadId
  );
  console.log(`  👋 @${invitedUser} invited to session by @${invitedBy}`);
  await updateSessionHeader(session, ctx);
  ctx.persistSession(session);
}

/**
 * Kick a user from a session.
 */
export async function kickUser(
  session: Session,
  kickedUser: string,
  kickedBy: string,
  ctx: CommandContext
): Promise<void> {
  // Only session owner or globally allowed users can kick
  if (session.startedBy !== kickedBy && !session.platform.isUserAllowed(kickedBy)) {
    await session.platform.createPost(
      `⚠️ Only @${session.startedBy} or allowed users can kick others`,
      session.threadId
    );
    return;
  }

  // Can't kick session owner
  if (kickedUser === session.startedBy) {
    await session.platform.createPost(
      `⚠️ Cannot kick session owner @${session.startedBy}`,
      session.threadId
    );
    return;
  }

  // Can't kick globally allowed users
  if (session.platform.isUserAllowed(kickedUser)) {
    await session.platform.createPost(
      `⚠️ @${kickedUser} is globally allowed and cannot be kicked from individual sessions`,
      session.threadId
    );
    return;
  }

  if (session.sessionAllowedUsers.delete(kickedUser)) {
    await session.platform.createPost(
      `🚫 @${kickedUser} removed from this session by @${kickedBy}`,
      session.threadId
    );
    console.log(`  🚫 @${kickedUser} kicked from session by @${kickedBy}`);
    await updateSessionHeader(session, ctx);
    ctx.persistSession(session);
  } else {
    await session.platform.createPost(
      `⚠️ @${kickedUser} was not in this session`,
      session.threadId
    );
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
  ctx: CommandContext
): Promise<void> {
  // Only session owner or globally allowed users can change permissions
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await session.platform.createPost(
      `⚠️ Only @${session.startedBy} or allowed users can change permissions`,
      session.threadId
    );
    return;
  }

  // Can only downgrade, not upgrade
  if (!ctx.skipPermissions) {
    await session.platform.createPost(
      `ℹ️ Permissions are already interactive for this session`,
      session.threadId
    );
    return;
  }

  // Already enabled for this session
  if (session.forceInteractivePermissions) {
    await session.platform.createPost(
      `ℹ️ Interactive permissions already enabled for this session`,
      session.threadId
    );
    return;
  }

  // Set the flag
  session.forceInteractivePermissions = true;

  const shortId = session.threadId.substring(0, 8);
  console.log(`  🔐 Session (${shortId}…) enabling interactive permissions`);

  // Stop the current Claude CLI and restart with new permission setting
  ctx.stopTyping(session);
  session.isRestarting = true;
  session.claude.kill();

  // Flush any pending content
  await ctx.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  // Create new CLI options with interactive permissions
  const cliOptions: ClaudeCliOptions = {
    workingDir: session.workingDir,
    threadId: session.threadId,
    skipPermissions: false, // Force interactive permissions
    sessionId: session.claudeSessionId,
    resume: true, // Resume to keep conversation context
    chrome: ctx.chromeEnabled,
    platformConfig: session.platform.getMcpConfig(),
  };
  session.claude = new ClaudeCli(cliOptions);

  // Rebind event handlers (use sessionId which is the composite key)
  session.claude.on('event', (e: ClaudeEvent) => ctx.handleEvent(session.sessionId, e));
  session.claude.on('exit', (code: number) => ctx.handleExit(session.sessionId, code));

  // Start the new Claude CLI
  try {
    session.claude.start();
  } catch (err) {
    session.isRestarting = false;
    console.error('  ❌ Failed to restart Claude:', err);
    await session.platform.createPost(
      `❌ Failed to enable interactive permissions: ${err}`,
      session.threadId
    );
    return;
  }

  // Update session header with new permission status
  await updateSessionHeader(session, ctx);

  // Post confirmation
  await session.platform.createPost(
    `🔐 **Interactive permissions enabled** for this session by @${username}\n*Claude Code restarted with permission prompts*`,
    session.threadId
  );
  console.log(`  🔐 Interactive permissions enabled for session by @${username}`);

  // Update activity and persist
  session.lastActivityAt = new Date();
  session.timeoutWarningPosted = false;
  ctx.persistSession(session);
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
  ctx: CommandContext
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
  ctx.registerPost(post.id, session.threadId);
}

// ---------------------------------------------------------------------------
// Session header
// ---------------------------------------------------------------------------

/**
 * Update the session header post with current participants and status.
 */
export async function updateSessionHeader(
  session: Session,
  ctx: CommandContext
): Promise<void> {
  if (!session.sessionStartPostId) return;

  // Use session's working directory
  const shortDir = session.workingDir.replace(process.env.HOME || '', '~');
  // Check session-level permission override
  const isInteractive = !ctx.skipPermissions || session.forceInteractivePermissions;
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
    // Calculate context usage percentage
    const contextPercent = Math.round((stats.totalTokensUsed / stats.contextWindowSize) * 100);
    const contextBar = formatContextBar(contextPercent);
    statusItems.push(`\`${contextBar} ${contextPercent}%\``);
    // Show cost
    statusItems.push(`\`💰 $${stats.totalCostUSD.toFixed(2)}\``);
  }

  statusItems.push(`\`${session.sessionNumber}/${ctx.maxSessions}\``);
  statusItems.push(`\`${permMode}\``);
  if (ctx.chromeEnabled) {
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

  // Show worktree info if active
  if (session.worktreeInfo) {
    const shortRepoRoot = session.worktreeInfo.repoRoot.replace(process.env.HOME || '', '~');
    rows.push(
      `| 🌿 **Worktree** | \`${session.worktreeInfo.branch}\` (from \`${shortRepoRoot}\`) |`
    );
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

  try {
    await session.platform.updatePost(session.sessionStartPostId, msg);
  } catch (err) {
    console.error('  ⚠️ Failed to update session header:', err);
  }
}
