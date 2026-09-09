/**
 * User commands module
 *
 * Handles user commands like !cd, !invite, !kick, !permissions, !escape, !stop.
 */

import type { Session } from '../../session/types.js';
import { isDcmThreadId, resolveApprovals } from '../../platform/utils.js';
import { transitionTo, isSessionRestarting } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import type { ClaudeCliOptions, ClaudeEvent, RateLimitHit } from '../../claude/cli.js';
import {
  permissionModeDisplay,
  permissionModeDescription,
  effectivePermissionMode,
} from '../../config/index.js';
import type { PermissionMode } from '../../config/index.js';
import { handleRateLimit } from '../../session/lifecycle.js';
import { ClaudeCli } from '../../claude/cli.js';
import { buildRestartCliOptions } from '../../claude/restart-options.js';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';
import { getUpdateInfo } from '../../update-notifier.js';
import {
  APPROVAL_EMOJIS,
  DENIAL_EMOJIS,
  ALLOW_ALL_EMOJIS,
} from '../../utils/emoji.js';
import {
  collectBugReportContext,
  formatIssueBody,
  generateIssueTitle,
  formatBugPreview,
  checkGitHubCli,
  createGitHubIssue,
  uploadImages,
  type ErrorContext,
} from '../bug-report/index.js';
import type { PlatformFile } from '../../platform/types.js';
import { formatBatteryStatus } from '../../utils/battery.js';
import { formatUptime } from '../../utils/uptime.js';
import { keepAlive } from '../../utils/keep-alive.js';
import { auditLog } from '../../persistence/audit-log.js';
import { logAndNotify } from '../../utils/error-handler/index.js';
import {
  post,
  postError,
  resetSessionActivity,
  postInteractiveAndRegister,
  updatePost,
  updatePostSuccess,
  updatePostError,
  updatePostCancelled,
} from '../post-helpers/index.js';
import { auditCommand, requireSessionOwner } from './guards.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';
import { formatPullRequestLink } from '../../utils/pr-detector.js';
import { getCurrentBranch, isGitRepository } from '../../git/worktree.js';
import { formatVersionString } from '../../utils/format.js';
import { shortenPath } from '../index.js';
import { getLogFilePath } from '../../persistence/thread-logger.js';
import { quickQuery } from '../../claude/quick-query.js';
import { CHAT_PLATFORM_PROMPT } from '../../session/lifecycle.js';
import {
  buildAppendSystemPrompt,
  formatCollaboratorListForChat,
  resolveCollaborators,
} from '../../commands/system-prompt-generator.js';
import { isValidGitHubNoreplyEmail } from '../../persistence/github-emails-store.js';
import { resolveSessionMemory, activeWorktreeRepoRoot } from '../../memory/store.js';

const log = createLogger('commands');
const sessionLog = createSessionLog(log);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the `account` option for a Claude CLI restart.
 *
 * Sessions that already run under a pooled Claude account must keep using the
 * same credentials when Claude is respawned (e.g. !cd, !permissions interactive).
 * Returns undefined for sessions started in single-account mode.
 */
function sessionAccountOption(
  session: Session,
  ctx: SessionContext
): ClaudeCliOptions['account'] {
  if (!session.claudeAccountId) return undefined;
  const account = ctx.ops.getClaudeAccount(session.claudeAccountId);
  if (!account) return undefined;
  return { id: account.id, home: account.home, apiKey: account.apiKey };
}

function commonRestartCliOptions(
  session: Session,
  ctx: SessionContext,
): Partial<ClaudeCliOptions> & Pick<ClaudeCliOptions, 'agentFeatures'> {
  return buildRestartCliOptions(session, {
    chromeEnabled: ctx.config.chromeEnabled,
    permissionTimeoutMs: ctx.config.permissionTimeoutMs,
    account: sessionAccountOption(session, ctx),
    ops: ctx.ops,
  });
}

/**
 * Restart Claude CLI with new options.
 * Handles the common pattern of kill -> flush -> create new CLI -> rebind -> start.
 * Returns true on success, false if start failed.
 */
export async function restartClaudeSession(
  session: Session,
  cliOptions: ClaudeCliOptions,
  ctx: SessionContext,
  actionName: string
): Promise<boolean> {
  // Stop the current Claude CLI. Await the exit: the dying process keeps
  // flushing buffered stream-json for up to ~2s, and a late event landing
  // AFTER the state clear below would repopulate the very stale task/tool
  // state the clear exists to remove.
  ctx.ops.stopTyping(session);
  transitionTo(session, 'restarting');
  await session.claude.kill();

  // Flush any pending content
  await ctx.ops.flush(session);

  // The MCP child ALWAYS dies on a respawn — resume or not — so any pending
  // bridge decision can never be answered usefully; deny it now so a later
  // reaction falls back to the stdin path instead of being swallowed by a
  // stale pending.
  session.messageManager?.denyPendingBridgeRequests(
    'Claude was restarted before a decision was made'
  );

  // A fresh CLI session (no resume) restarts task numbering at #1 — drop
  // the old session's accumulated task/tool state so ids can't collide.
  if (!cliOptions.resume) {
    session.messageManager?.clearClaudeSessionState();
  }

  // Create new Claude CLI
  const newClaude = new ClaudeCli(cliOptions);
  session.claude = newClaude;

  // Rebind event handlers (use sessionId which is the composite key).
  // The rate-limit listener MUST be rebound here too — without it, a !cd or
  // !permissions interactive restart would silently drop rate-limit signals
  // from the new Claude process and the account would never enter cooldown.
  newClaude.on('event', (e: ClaudeEvent) => ctx.ops.handleEvent(session.sessionId, e));
  newClaude.on('exit', (code: number) => ctx.ops.handleExit(session.sessionId, code, newClaude));
  newClaude.on('rate-limit', (hit: RateLimitHit) => handleRateLimit(session, hit, ctx));

  // Start the new Claude CLI
  try {
    newClaude.start();
    // Respawn succeeded. The old process's exit usually resets 'restarting'
    // to 'active' via handleExit's restarting guard, but that exit can also
    // arrive after the swap above (where the stale-source check in
    // handleExit drops it) — transition explicitly so the session never
    // sticks in 'restarting'. Guarded: a `!stop` issued during the respawn
    // window has moved the session to 'cancelling', which must not be
    // clobbered back to 'active'.
    if (isSessionRestarting(session)) {
      transitionTo(session, 'active');
    }
    return true;
  } catch (err) {
    if (isSessionRestarting(session)) {
      transitionTo(session, 'active');
    }
    await logAndNotify(err, { action: actionName, session });
    return false;
  }
}

/**
 * Check if user is session owner or globally allowed.
 * Posts warning message if not authorized.
 * Returns true if authorized, false otherwise.
 */

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
  sessionLog(session).info(`🛑 Cancelled by @${username}`);
  auditCommand(session, 'stop', undefined, username);
  session.threadLogger?.logCommand('stop', undefined, username);

  // Mark as cancelling BEFORE killing to prevent re-persistence in handleExit
  transitionTo(session, 'cancelling');

  const formatter = session.platform.getFormatter();
  await post(session, 'cancelled', `${formatter.formatBold('Session cancelled')} by ${formatter.formatUserMention(username)}`);

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
    await post(session, 'info', `Session is idle, nothing to interrupt`);
    sessionLog(session).debug(`Interrupt requested but session is idle`);
    return;
  }

  // Set interrupted state BEFORE interrupt - if Claude exits due to SIGINT, we won't unpersist
  transitionTo(session, 'interrupted');
  const interrupted = session.claude.interrupt();

  if (interrupted) {
    sessionLog(session).info(`⏸️ Interrupted by @${username}`);
    session.threadLogger?.logCommand('escape', undefined, username);
    const formatter = session.platform.getFormatter();
    await post(session, 'interrupt', `${formatter.formatBold('Interrupted')} by ${formatter.formatUserMention(username)}`);
  }
}

/**
 * Approve a pending plan via text command (alternative to 👍 reaction).
 * This is useful when the emoji reaction doesn't work reliably.
 */
export async function approvePendingPlan(
  session: Session,
  username: string,
  ctx: SessionContext
): Promise<void> {
  // SECURITY: mirror the reaction router's gate — under effective approvals
  // mode `owner`, plan approval is an authoritative permission decision
  // scoped to session participants. The platform allowlist alone must not
  // grant it, or `!approve` becomes a text bypass of the owner-scoped 👍.
  const ownerScoped =
    resolveApprovals(session.platform.approvals, isDcmThreadId(session.threadId)) === 'owner';
  if (ownerScoped && !session.sessionAllowedUsers.has(username)) {
    await post(session, 'warning', `Only session participants can approve plans here`);
    sessionLog(session).warn(`Unauthorized: @${username} tried !approve (approvals: owner)`, {
      event: 'approve.rejected',
      username,
    });
    return;
  }

  // Check if there's a pending plan approval
  const pendingApproval = session.messageManager?.getPendingApproval();
  if (!pendingApproval || pendingApproval.type !== 'plan') {
    await post(session, 'info', `No pending plan to approve`);
    sessionLog(session).debug(`Approve requested but no pending plan`);
    return;
  }

  const { postId } = pendingApproval;
  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: username,
    kind: 'plan_approval',
    approved: true,
    detail: 'via !approve',
  });
  sessionLog(session).info(`✅ Plan approved by @${username} via command`);

  // On modern CLIs ExitPlanMode is BLOCKED on the MCP permission prompt with
  // a decision-bridge request pending — a stdin message would just queue
  // while the bridge waits out its timeout, converting this approval into a
  // long hang. Resolve the bridge SYNCHRONOUSLY, before any await: a 👍
  // reaction landing during an awaited platform call would otherwise consume
  // the pending first and this command would fall through to a stray stdin
  // message.
  const viaBridge = session.messageManager?.resolveBridgePlan(true) ?? false;

  // Update the post to show the decision
  const formatter = session.platform.getFormatter();
  const statusMessage = `${formatter.formatBold('Plan approved')} by ${formatter.formatUserMention(username)} - starting implementation...`;
  await updatePostSuccess(session, postId, statusMessage);

  // Clear pending approval and mark as approved
  session.messageManager?.clearPendingApproval();
  // Also clear any stale questions from plan mode - they're no longer relevant
  session.messageManager?.clearPendingQuestionSet();
  session.planApproved = true;

  if (viaBridge) {
    sessionLog(session).info('Plan approved via decision bridge (!approve)');
    ctx.ops.startTyping(session);
    return;
  }

  // Send user message to Claude - NOT a tool_result
  // Claude Code CLI handles ExitPlanMode internally (generating its own tool_result),
  // so we can't send another tool_result. Instead, send a user message to continue.
  if (session.claude.isRunning()) {
    session.claude.sendMessage('Plan approved! Please proceed with the implementation.');
    ctx.ops.startTyping(session);
  }
}

// ---------------------------------------------------------------------------
// Directory management
// ---------------------------------------------------------------------------

/**
 * Generate a summary of the work done in the current session.
 * Used to preserve context when changing directories or creating worktrees.
 */
export async function generateWorkSummary(session: Session): Promise<string | undefined> {
  // Direct channel mode: the synthetic session id is not a real thread root,
  // so there is no thread history to summarize. Skip instead of letting the
  // platform call 404 into an empty result.
  if (isDcmThreadId(session.threadId)) {
    return undefined;
  }
  // Get recent thread history to summarize
  try {
    const messages = await session.platform.getThreadHistory(
      session.threadId,
      { limit: 20, excludeBotMessages: false }
    );

    if (messages.length === 0) {
      return undefined;
    }

    // Format messages for the summary prompt
    const conversationText = messages
      .map(m => `${m.username}: ${m.message.substring(0, 500)}`)
      .join('\n');

    const summaryPrompt = `Summarize the following conversation in 2-3 sentences. Focus on what work was done, what was accomplished, and any important context that would be useful when continuing in a different directory:

${conversationText}

Summary:`;

    const result = await quickQuery({
      prompt: summaryPrompt,
      model: 'haiku',
      timeout: 10000,
      workingDir: session.workingDir,
    });

    if (result.success && result.response) {
      sessionLog(session).debug(`Generated work summary: ${result.response.substring(0, 100)}...`);
      return result.response;
    }

    return undefined;
  } catch (err) {
    sessionLog(session).debug(`Failed to generate work summary: ${err}`);
    return undefined;
  }
}

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

  const formatter = session.platform.getFormatter();

  // Check if directory exists
  if (!existsSync(absoluteDir)) {
    await postError(session, `Directory does not exist: ${formatter.formatCode(newDir)}`);
    sessionLog(session).warn(`📂 Directory does not exist: ${newDir}`);
    return;
  }

  if (!statSync(absoluteDir).isDirectory()) {
    await postError(session, `Not a directory: ${formatter.formatCode(newDir)}`);
    sessionLog(session).warn(`📂 Not a directory: ${newDir}`);
    return;
  }

  // Use worktree-aware path shortening if in a worktree
  const worktreeContext = session.worktreeInfo
    ? { path: session.worktreeInfo.worktreePath, branch: session.worktreeInfo.branch }
    : undefined;
  const shortDir = shortenPath(absoluteDir, undefined, worktreeContext);
  sessionLog(session).info(`📂 Changing directory to ${shortDir}`);
  auditCommand(session, 'cd', absoluteDir, username);
  session.threadLogger?.logCommand('cd', absoluteDir, username);

  // Generate summary of previous work before switching directories
  // This runs in parallel with directory validation (which is already done)
  const previousDir = session.workingDir;
  const workSummary = await generateWorkSummary(session);
  if (workSummary) {
    session.previousWorkSummary = workSummary;
    sessionLog(session).debug(`Stored work summary for context preservation`);
  }

  // Update session working directory
  session.workingDir = absoluteDir;

  // Generate new session ID for fresh start in new directory
  const newSessionId = randomUUID();
  session.claudeSessionId = newSessionId;

  // Build system prompt with platform context for the new directory.
  // Carry collaborator co-author tags across the respawn so attribution
  // doesn't silently drop on `!cd`.
  const memoryConfig = ctx.ops.getPlatformMemoryConfig(session.platformId);
  const appendSystemPrompt = await buildAppendSystemPrompt(
    session.platform,
    session.platformId,
    absoluteDir,
    session.threadId,
    session.startedBy,
    session.sessionAllowedUsers,
    CHAT_PLATFORM_PROMPT,
    ctx.state.githubEmailsStore,
    memoryConfig.enabled && memoryConfig.channelLayer ? ctx.state.memoryStore : null,
    { userAttribution: session.userAttribution },
  );

  const cliOptions: ClaudeCliOptions = {
    ...commonRestartCliOptions(session, ctx),
    workingDir: absoluteDir,
    // Keep the session in its current effective mode across the respawn.
    permissionMode: effectivePermissionMode({
      override: session.permissionModeOverride,
      sessionHasInteractiveOverride: session.forceInteractivePermissions,
      botWideMode: ctx.config.permissionMode,
    }),
    sessionId: newSessionId,
    resume: false, // Fresh start - can't resume across directories
    appendSystemPrompt,  // Include platform context and commands
    // Rebind the repo memory layer to the new directory's repo.
    memory: await resolveSessionMemory(
      ctx.state.memoryStore, memoryConfig, session.platformId, absoluteDir,
    ),
  };

  // Restart Claude with new options
  const success = await restartClaudeSession(session, cliOptions, ctx, 'Restart Claude for directory change');
  if (!success) return;

  // Update session header with new directory
  await updateSessionHeader(session, ctx);

  // Build confirmation message with context info
  let confirmationMsg = `${formatter.formatBold('Working directory changed')} to ${formatter.formatCode(shortDir)}\n`;
  confirmationMsg += `${formatter.formatItalic(`Claude Code restarted in new directory (from ${shortenPath(previousDir)})`)}`;
  if (workSummary) {
    confirmationMsg += `\n\n${formatter.formatBold('Previous context preserved:')} ${workSummary.substring(0, 150)}${workSummary.length > 150 ? '...' : ''}`;
  }

  // Post confirmation
  await post(session, 'command', confirmationMsg);

  // Reset activity and clear timeout tracking (prevents updating stale posts in long threads)
  resetSessionActivity(session);

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
 * Post a "Collaborators updated" notice in the thread so Claude can read the
 * current co-author list on the next turn.
 *
 * The literal phrase "Collaborators updated" is the convention promised by
 * `buildCollaboratorContext()` — it's how Claude finds the most-recent list.
 * Posts even when the list is now empty (e.g. after the last !kick) so an
 * older notice in the thread doesn't keep applying.
 */
/**
 * Onboarding nudge: when a freshly-invited collaborator has no GitHub noreply
 * email registered yet, point them at the `!github-email` command and the
 * GitHub settings URL. Quiet no-op if they already registered (e.g. they were
 * invited to a previous session and set it then).
 */
async function postOnboardingReminderIfNeeded(
  session: Session,
  invitedUser: string,
  ctx: SessionContext,
): Promise<void> {
  if (ctx.state.githubEmailsStore.get(session.platformId, invitedUser)) return;
  const formatter = session.platform.getFormatter();
  await post(
    session,
    'info',
    `🔑 ${formatter.formatUserMention(invitedUser)}, to be added as a co-author on git commits in this session, share your GitHub noreply email: send ${formatter.formatCode('!github-email <addr>')} in this thread. Find yours at https://github.com/settings/emails (under "Keep my email addresses private" — toggle does not need to be on; the address is shown right below it). Until then, commits won't credit you.`,
  );
}

/**
 * On session resume, list the still-unregistered collaborators in one
 * combined nudge so each user can self-register without re-inviting them.
 * No-ops when every collaborator (or the lone owner) is already accounted for.
 */
export async function postResumeCoAuthorOnboarding(
  session: Session,
  ctx: SessionContext,
): Promise<void> {
  const unregistered: string[] = [];
  for (const username of session.sessionAllowedUsers) {
    if (username === session.startedBy) continue;
    if (!ctx.state.githubEmailsStore.get(session.platformId, username)) {
      unregistered.push(username);
    }
  }
  if (unregistered.length === 0) return;

  const formatter = session.platform.getFormatter();
  const mentions = unregistered.map(u => formatter.formatUserMention(u)).join(', ');
  await post(
    session,
    'info',
    `🔑 ${mentions} — to be added as co-authors on git commits, share your GitHub noreply email with ${formatter.formatCode('!github-email <addr>')}. Find yours at https://github.com/settings/emails.`,
  );
}

async function postCollaboratorUpdatedNotice(
  session: Session,
  ctx: SessionContext,
): Promise<void> {
  const collaborators = await resolveCollaborators(
    session.platform,
    session.platformId,
    session.startedBy,
    session.sessionAllowedUsers,
    ctx.state.githubEmailsStore,
  );
  const body = collaborators.length === 0
    ? `📝 Collaborators updated — no co-authors for new commits.`
    : `📝 Collaborators updated — co-authors for new commits: ${formatCollaboratorListForChat(collaborators)}`;
  await post(session, 'info', body);
}

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
  const formatter = session.platform.getFormatter();
  if (!user) {
    await post(session, 'warning', `User ${formatter.formatUserMention(invitedUser)} does not exist on this platform`);
    sessionLog(session).warn(`👋 User @${invitedUser} not found`);
    return;
  }

  session.sessionAllowedUsers.add(invitedUser);
  await post(session, 'success', `${formatter.formatUserMention(invitedUser)} can now participate in this session (invited by ${formatter.formatUserMention(invitedBy)})`);
  sessionLog(session).info(`👋 @${invitedUser} invited by @${invitedBy}`);
  auditCommand(session, 'invite', invitedUser, invitedBy);
  session.threadLogger?.logCommand('invite', invitedUser, invitedBy);
  await updateSessionHeader(session, ctx);
  // Persist FIRST so a failure in the chat-side notices below doesn't leave
  // the session in memory-only state (the invitee would vanish on bot restart).
  ctx.ops.persistSession(session);
  // Onboard for co-author attribution: nudge the invitee to register their
  // GitHub noreply email if they haven't already, so Claude can tag them.
  await postOnboardingReminderIfNeeded(session, invitedUser, ctx);
  await postCollaboratorUpdatedNotice(session, ctx);
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
  const formatter = session.platform.getFormatter();
  if (!user) {
    await post(session, 'warning', `User ${formatter.formatUserMention(kickedUser)} does not exist on this platform`);
    sessionLog(session).warn(`🚫 User @${kickedUser} not found`);
    return;
  }

  // Can't kick session owner
  if (kickedUser === session.startedBy) {
    await post(session, 'warning', `Cannot kick session owner ${formatter.formatUserMention(session.startedBy)}`);
    sessionLog(session).warn(`🚫 Cannot kick session owner @${session.startedBy}`);
    return;
  }

  // Can't kick globally allowed users
  if (session.platform.isUserAllowed(kickedUser)) {
    await post(session, 'warning', `${formatter.formatUserMention(kickedUser)} is globally allowed and cannot be kicked from individual sessions`);
    sessionLog(session).warn(`🚫 Cannot kick globally allowed user @${kickedUser}`);
    return;
  }

  if (session.sessionAllowedUsers.delete(kickedUser)) {
    await post(session, 'user', `${formatter.formatUserMention(kickedUser)} removed from this session by ${formatter.formatUserMention(kickedBy)}`);
    sessionLog(session).info(`🚫 @${kickedUser} kicked by @${kickedBy}`);
    auditCommand(session, 'kick', kickedUser, kickedBy);
    session.threadLogger?.logCommand('kick', kickedUser, kickedBy);
    await updateSessionHeader(session, ctx);
    // Persist FIRST, mirror of inviteUser: a network failure on the
    // collaborator-update notice must not roll back the kick to disk.
    // Without this, a bot restart would resurrect the kicked user.
    ctx.ops.persistSession(session);
    await postCollaboratorUpdatedNotice(session, ctx);
  } else {
    await post(session, 'warning', `${formatter.formatUserMention(kickedUser)} was not in this session`);
    sessionLog(session).warn(`🚫 @${kickedUser} was not in session`);
  }
}

/**
 * Handle `!mentions [on|off]` — toggle "respond only when @mentioned" for this
 * session (issue #402). When on, the bot ignores thread replies that don't
 * @mention it, so users can hold side conversations without interrupting.
 * Commands still work either way, so `!mentions off` can always turn it back.
 *
 * Bare `!mentions` toggles. An explicit `on`/`off` argument is idempotent.
 */
export async function setRespondOnlyWhenMentioned(
  session: Session,
  username: string,
  arg: string | undefined,
  ctx: SessionContext
): Promise<void> {
  // Same authorization as other per-session settings: owner or globally allowed.
  if (!await requireSessionOwner(session, username, 'change session settings')) {
    return;
  }

  const normalized = arg?.toLowerCase();
  let enabled: boolean;
  if (normalized === 'on') {
    enabled = true;
  } else if (normalized === 'off') {
    enabled = false;
  } else {
    // Bare !mentions (or anything else) toggles the current value.
    enabled = !session.respondOnlyWhenMentioned;
  }

  session.respondOnlyWhenMentioned = enabled;
  ctx.ops.persistSession(session);

  const botName = session.platform.getBotName();
  if (enabled) {
    await post(
      session,
      'success',
      `Quiet mode on — I'll only respond when you @mention me (\`@${botName}\`). Use \`!mentions off\` to turn this off.`
    );
  } else {
    await post(
      session,
      'success',
      `Quiet mode off — I'll respond to every message in this thread again.`
    );
  }
  sessionLog(session).info(`🔕 respondOnlyWhenMentioned=${enabled} by @${username}`);
  session.threadLogger?.logCommand('mentions', enabled ? 'on' : 'off', username);
  await updateSessionHeader(session, ctx);
}

/**
 * Handle `!github-email` — register/show/reset the caller's GitHub noreply email.
 *
 * Always self-scoped: a user can only register their own address. Owners
 * cannot register on behalf of someone else, by design — the noreply mapping
 * tells GitHub which account a commit is co-authored by, and only the user
 * themselves can authoritatively name that.
 *
 * Subcommands:
 * - `!github-email <addr>` — register or replace
 * - `!github-email`        — show currently registered address (or "none")
 * - `!github-email reset`  — clear registration
 */
export async function setGitHubEmail(
  session: Session,
  username: string,
  arg: string | undefined,
  ctx: SessionContext,
): Promise<void> {
  const formatter = session.platform.getFormatter();
  const trimmed = arg?.trim();
  const platformId = session.platformId;

  // Show current registration.
  if (!trimmed) {
    const current = ctx.state.githubEmailsStore.get(platformId, username);
    if (current) {
      await post(
        session,
        'info',
        `🔑 ${formatter.formatUserMention(username)}, your registered GitHub noreply email is ${formatter.formatCode(current)}. Use ${formatter.formatCode('!github-email reset')} to remove it.`,
      );
    } else {
      await post(
        session,
        'info',
        `🔑 ${formatter.formatUserMention(username)}, you have not registered a GitHub noreply email. Find yours at https://github.com/settings/emails (under "Keep my email addresses private" — toggle does not need to be on; the address is shown right below it). Then send ${formatter.formatCode('!github-email <addr>')} in this thread.`,
      );
    }
    return;
  }

  // Reset.
  if (trimmed.toLowerCase() === 'reset' || trimmed.toLowerCase() === 'clear') {
    const removed = ctx.state.githubEmailsStore.delete(platformId, username);
    if (removed) {
      await post(
        session,
        'success',
        `🔑 ${formatter.formatUserMention(username)}, your GitHub noreply email registration was removed. You will no longer be added as a co-author on commits.`,
      );
      sessionLog(session).info(`🔑 @${username} reset GitHub noreply email`);
      // Refresh Claude's view in the thread so the now-removed user is dropped.
      await postCollaboratorUpdatedNotice(session, ctx);
    } else {
      await post(
        session,
        'info',
        `🔑 ${formatter.formatUserMention(username)}, you had no GitHub noreply email registered.`,
      );
    }
    return;
  }

  // Register or replace.
  if (!isValidGitHubNoreplyEmail(trimmed)) {
    await post(
      session,
      'warning',
      `🔑 That doesn't look like a GitHub noreply email. Expected the form ${formatter.formatCode('<id>+<username>@users.noreply.github.com')} (e.g. ${formatter.formatCode('12345+alice@users.noreply.github.com')}). Find yours at https://github.com/settings/emails.`,
    );
    sessionLog(session).warn(`🔑 @${username} provided invalid GitHub noreply email`);
    return;
  }

  ctx.state.githubEmailsStore.set(platformId, username, trimmed);
  await post(
    session,
    'success',
    `🔑 ${formatter.formatUserMention(username)}, registered ${formatter.formatCode(trimmed)} as your GitHub noreply email. You will be added as a co-author on commits made in sessions you participate in.`,
  );
  sessionLog(session).info(`🔑 @${username} registered GitHub noreply email`);
  session.threadLogger?.logCommand('github-email', 'set', username);

  // If this user is in the current session as a collaborator, immediately
  // refresh the thread notice so Claude picks up the trailer next turn.
  if (session.sessionAllowedUsers.has(username) && username !== session.startedBy) {
    await postCollaboratorUpdatedNotice(session, ctx);
  }
}

// ---------------------------------------------------------------------------
// Permission management
// ---------------------------------------------------------------------------

/**
 * Change the effective permission mode for a single session.
 *
 * The bot-wide mode is used as a ceiling for how-strict the default is; this
 * function always accepts any of the three modes (so operators can relax too).
 * Claude is respawned with the new mode via `restartClaudeSession`.
 */
export async function setSessionPermissionMode(
  session: Session,
  username: string,
  mode: PermissionMode,
  ctx: SessionContext,
): Promise<void> {
  if (!await requireSessionOwner(session, username, 'change permissions')) {
    return;
  }

  // Two flags track the mode for this session:
  // - `permissionModeOverride` captures the current in-process mode. It's
  //   used by the session header, `isSessionInteractive`, and any code that
  //   asks "what mode is THIS session in?". Not persisted.
  // - `forceInteractivePermissions` is the sticky legacy flag that only
  //   encodes the `default` opt-in. Persists across bot restart so a user
  //   who opted into `default` doesn't silently lose it on resume.
  session.permissionModeOverride = mode;
  session.forceInteractivePermissions = mode === 'default';

  sessionLog(session).info(`🔐 Setting permission mode to "${mode}"`);
  auditCommand(session, 'permissions', mode, username);
  session.threadLogger?.logCommand('permissions', mode, username);

  // If Claude has never responded (user ran `!permissions` before the first
  // turn), there is nothing to resume — Claude CLI will reject `--resume
  // <uuid>` with "No conversation found with session ID". In that case we
  // start fresh under the same UUID so the chat thread continuity is
  // preserved (it lives in the platform, not Claude).
  const canResume = session.lifecycle.hasClaudeResponded;

  // Rebuild the append-system-prompt for the respawn. commonRestartCliOptions
  // does NOT carry it, and --append-system-prompt is a per-invocation flag that
  // --resume does not re-apply — so omitting it here would strip the platform
  // context, command list, co-author rules, and the [@username]: attribution
  // note from the new process. Mirrors the !cd path (changeDirectory).
  const memoryConfig = ctx.ops.getPlatformMemoryConfig(session.platformId);
  const appendSystemPrompt = await buildAppendSystemPrompt(
    session.platform,
    session.platformId,
    session.workingDir,
    session.threadId,
    session.startedBy,
    session.sessionAllowedUsers,
    CHAT_PLATFORM_PROMPT,
    ctx.state.githubEmailsStore,
    memoryConfig.enabled && memoryConfig.channelLayer ? ctx.state.memoryStore : null,
    { userAttribution: session.userAttribution },
  );

  const cliOptions: ClaudeCliOptions = {
    ...commonRestartCliOptions(session, ctx),
    workingDir: session.workingDir,
    permissionMode: mode,
    sessionId: session.claudeSessionId,
    resume: canResume,
    appendSystemPrompt,
    memory: await resolveSessionMemory(
      ctx.state.memoryStore, memoryConfig, session.platformId, session.workingDir,
      activeWorktreeRepoRoot(session.workingDir, session.worktreeInfo),
    ),
  };

  const success = await restartClaudeSession(
    session, cliOptions, ctx, `Set permission mode to ${mode}`,
  );
  if (!success) return;

  await updateSessionHeader(session, ctx);

  const formatter = session.platform.getFormatter();
  const display = permissionModeDisplay(mode);
  await post(session, 'secure',
    `${display.icon} ${formatter.formatBold(`Permission mode: ${display.label}`)} set for this session by ${formatter.formatUserMention(username)}\n` +
    `${formatter.formatItalic(permissionModeDescription(mode))}\n` +
    `${formatter.formatItalic('Claude Code restarted.')}`,
  );
  sessionLog(session).info(`🔐 Permission mode set to "${mode}" by @${username}`);
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
  if (session.messageManager?.getPendingMessageApproval()) {
    return;
  }

  // Truncate long messages for display
  const displayMessage = message.length > 200 ? message.substring(0, 200) + '...' : message;

  const formatter = session.platform.getFormatter();
  const approvalMessage =
    `🔒 ${formatter.formatBold(`Message from ${formatter.formatUserMention(username)}`)} needs approval:\n\n` +
    `${formatter.formatBlockquote(displayMessage)}\n\n` +
    `React: 👍 Allow once | ✅ Invite to session | 👎 Deny`;

  const approvalPost = await postInteractiveAndRegister(
    session,
    approvalMessage,
    [APPROVAL_EMOJIS[0], ALLOW_ALL_EMOJIS[0], DENIAL_EMOJIS[0]],
    ctx.ops.registerPost
  );

  session.messageManager?.setPendingMessageApproval({
    postId: approvalPost.id,
    originalMessage: message,
    fromUser: username,
    sessionOwner: session.startedBy,
  });
}

// ---------------------------------------------------------------------------
// Session header
// ---------------------------------------------------------------------------

/**
 * Build the one-line status bar shared between `minimal` and `full` modes.
 * Exported for testing and reuse from compact renderers.
 */
export async function buildSessionHeaderStatusBar(
  session: Session,
  ctx: SessionContext
): Promise<string> {
  const formatter = session.platform.getFormatter();
  const effectiveMode = effectivePermissionMode({
    override: session.permissionModeOverride,
    sessionHasInteractiveOverride: session.forceInteractivePermissions,
    botWideMode: ctx.config.permissionMode,
  });
  const permMode = permissionModeDisplay(effectiveMode).chip;

  const items: string[] = [];

  // Version info at the start (matches sticky message)
  items.push(formatter.formatCode(formatVersionString()));

  // Model and context usage (if available)
  if (session.usageStats) {
    const stats = session.usageStats;
    items.push(formatter.formatCode(`🤖 ${stats.modelDisplayName}`));
    const contextPercent = Math.round((stats.contextTokens / stats.contextWindowSize) * 100);
    items.push(formatter.formatCode(`${formatContextBar(contextPercent)} ${contextPercent}%`));
    items.push(formatter.formatCode(`💰 $${stats.totalCostUSD.toFixed(2)}`));
  }

  items.push(formatter.formatCode(permMode));

  // Plan mode status
  if (session.messageManager?.getPendingApproval()?.type === 'plan') {
    items.push(formatter.formatCode('📋 Plan pending'));
  } else if (session.planApproved) {
    items.push(formatter.formatCode('🔨 Implementing'));
  }

  if (ctx.config.chromeEnabled) {
    items.push(formatter.formatCode('🌐 Chrome'));
  }
  if (keepAlive.isActive()) {
    items.push(formatter.formatCode('💓 Keep-alive'));
  }
  const battery = await formatBatteryStatus();
  if (battery) {
    items.push(formatter.formatCode(battery));
  }
  items.push(formatter.formatCode(`⏱️ ${formatUptime(session.startedAt)}`));

  return items.join(' · ');
}

/**
 * Update the session header post with current participants and status.
 *
 * Behavior depends on `session.sessionHeaderMode`:
 * - `'hidden'` — no-op. New `hidden` sessions never created a placeholder
 *   post; resumed sessions that flipped from `'full'`/`'minimal'` to
 *   `'hidden'` may still carry a `sessionStartPostId` from the prior run,
 *   so the mode check must run BEFORE the post-id check or we'd update a
 *   leftover post the user thought they hid.
 * - `'minimal'` — post only the one-line status bar (plus update notice).
 * - `'full'` (default) — post status bar + key-value table.
 */
export async function updateSessionHeader(
  session: Session,
  ctx: SessionContext
): Promise<void> {
  if (session.sessionHeaderMode === 'hidden') return;
  if (!session.sessionStartPostId) return;

  const formatter = session.platform.getFormatter();
  const statusBar = await buildSessionHeaderStatusBar(session, ctx);

  // Update notices ride along regardless of mode — they signal that the user
  // should run `bun install -g claude-threads` and shouldn't be hidden by a
  // cosmetic preference.
  const updateInfo = getUpdateInfo();
  const updateNotice = updateInfo
    ? `> ⚠️ ${formatter.formatBold('Update available:')} v${updateInfo.current} → v${updateInfo.latest} - Run ${formatter.formatCode('bun install -g claude-threads')}\n\n`
    : undefined;

  if (session.sessionHeaderMode === 'minimal') {
    const msg = [updateNotice, statusBar].filter(Boolean).join('\n');
    await updatePost(session, session.sessionStartPostId, msg);
    return;
  }

  // 'full' mode: status bar + key-value table

  // Use session's working directory (with worktree-aware shortening)
  const worktreeContext = session.worktreeInfo
    ? { path: session.worktreeInfo.worktreePath, branch: session.worktreeInfo.branch }
    : undefined;
  const shortDir = shortenPath(session.workingDir, undefined, worktreeContext);

  // Build participants list (excluding owner)
  const otherParticipants = [...session.sessionAllowedUsers]
    .filter((u) => u !== session.startedBy)
    .map((u) => formatter.formatUserMention(u))
    .join(', ');

  // Build key-value items as tuples: [icon, label, value]
  const items: [string, string, string][] = [];

  // Add title and description if available
  if (session.sessionTitle) {
    items.push(['📝', 'Topic', session.sessionTitle]);
  }
  if (session.sessionDescription) {
    items.push(['📄', 'Summary', formatter.formatItalic(session.sessionDescription)]);
  }
  if (session.sessionTags?.length) {
    items.push(['🏷️', 'Tags', session.sessionTags.map(t => formatter.formatCode(t)).join(' ')]);
  }

  items.push(['📂', 'Directory', formatter.formatCode(shortDir)]);
  items.push(['👤', 'Started by', formatter.formatUserMention(session.startedBy)]);

  // Platform indicator (useful when running multi-platform)
  const platformIcon = session.platform.platformType === 'slack' ? '💬' : '📢';
  items.push([platformIcon, 'Platform', session.platform.displayName]);

  // Show worktree info if active, otherwise show git branch if in a git repo
  if (session.worktreeInfo) {
    const shortRepoRoot = session.worktreeInfo.repoRoot.replace(process.env.HOME || '', '~');
    items.push([
      '🌿',
      'Worktree',
      `${formatter.formatCode(session.worktreeInfo.branch)} (from ${formatter.formatCode(shortRepoRoot)})`
    ]);
  } else {
    // Check if we're in a git repository and get the current branch
    const isRepo = await isGitRepository(session.workingDir);
    if (isRepo) {
      const branch = await getCurrentBranch(session.workingDir);
      if (branch) {
        items.push(['🌿', 'Branch', formatter.formatCode(branch)]);
      }
    }
  }

  // Show pull request link if available
  if (session.pullRequestUrl) {
    items.push(['🔗', 'Pull Request', formatPullRequestLink(session.pullRequestUrl, formatter)]);
  }

  if (otherParticipants) {
    items.push(['👥', 'Participants', otherParticipants]);
  }

  // Quiet mode (#402): only surfaced when on, so a returning user can see why
  // the bot is ignoring unaddressed replies. Off is the default and stays
  // unmentioned to keep the header compact.
  if (session.respondOnlyWhenMentioned) {
    items.push(['🔕', 'Replies', `only when ${formatter.formatBold('@mentioned')} (${formatter.formatCode('!mentions off')} to disable)`]);
  }

  // Claude account (only when the bot is running in multi-account mode)
  if (session.claudeAccountId) {
    const account = ctx.ops.getClaudeAccount(session.claudeAccountId);
    const label = account?.displayName ?? session.claudeAccountId;
    items.push(['🔑', 'Claude account', formatter.formatCode(label)]);
  }

  // MCP posture (#560): only when it deviates from the default (connectors
  // off, the machine's own servers on), so a channel can see that its
  // sessions carry the account's connectors, or that they see only the
  // bot's declared set.
  {
    const mcp = session.platform.getMcpConfig();
    const posture: string[] = [];
    if (mcp.claudeAiConnectors === true) posture.push(`claude.ai connectors ${formatter.formatBold('on')}`);
    if (mcp.strictMcpConfig === true) posture.push('strict (declared servers only)');
    if (posture.length > 0) items.push(['🔌', 'MCP', posture.join(', ')]);
  }

  items.push(['🆔', 'Session ID', formatter.formatCode(session.claudeSessionId.substring(0, 8))]);

  // Show log file path (sanitized) - use sessionId for the filename
  const logPath = getLogFilePath(session.platform.platformId, session.claudeSessionId);
  const shortLogPath = logPath.replace(process.env.HOME || '', '~');
  items.push(['📋', 'Log File', formatter.formatCode(shortLogPath)]);

  const msg = [
    updateNotice,
    statusBar,
    '',  // Blank line needed before table for markdown rendering
    formatter.formatKeyValueList(items),
  ].filter(item => item !== null && item !== undefined).join('\n');

  await updatePost(session, session.sessionStartPostId, msg);
}

// ---------------------------------------------------------------------------
// Update commands
// ---------------------------------------------------------------------------

/** Interface for auto-update manager access from commands */
export interface AutoUpdateManagerInterface {
  isEnabled(): boolean;
  hasUpdate(): boolean;
  getUpdateInfo(): { available: boolean; currentVersion: string; latestVersion: string; detectedAt: Date } | undefined;
  getScheduledRestartAt(): Date | null;
  checkNow(): Promise<{ available: boolean; currentVersion: string; latestVersion: string; detectedAt: Date } | null>;
  forceUpdate(): Promise<void>;
  deferUpdate(minutes?: number): void;
  getConfig(): { autoRestartMode: string };
}

/**
 * Check for updates and show status (!update)
 */
export async function showUpdateStatus(
  session: Session,
  updateManager: AutoUpdateManagerInterface | null,
  ctx: SessionContext
): Promise<void> {
  const formatter = session.platform.getFormatter();

  if (!updateManager) {
    await post(session, 'info', `Auto-update is not available`);
    return;
  }

  if (!updateManager.isEnabled()) {
    await post(session, 'info', `Auto-update is disabled in configuration`);
    return;
  }

  // Check for new updates
  const updateInfo = await updateManager.checkNow();

  if (!updateInfo || !updateInfo.available) {
    await post(session, 'success', `${formatter.formatBold('Up to date')} - no updates available`);
    return;
  }

  const scheduledAt = updateManager.getScheduledRestartAt();
  const config = updateManager.getConfig();

  let statusLine: string;
  if (scheduledAt) {
    const secondsRemaining = Math.max(0, Math.round((scheduledAt.getTime() - Date.now()) / 1000));
    statusLine = `Restarting in ${secondsRemaining} seconds`;
  } else {
    statusLine = `Mode: ${config.autoRestartMode}`;
  }

  const message =
    `🔄 ${formatter.formatBold('Update available')}\n\n` +
    `Current: v${updateInfo.currentVersion}\n` +
    `Latest: v${updateInfo.latestVersion}\n` +
    `${statusLine}\n\n` +
    `React: 👍 Update now | 👎 Defer for 1 hour`;

  // Create interactive post with reaction options
  const updatePromptPost = await postInteractiveAndRegister(
    session,
    message,
    [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]],
    ctx.ops.registerPost
  );

  // Store pending update prompt for reaction handling
  session.messageManager?.setPendingUpdatePrompt({ postId: updatePromptPost.id });
}

/**
 * Force an immediate update (!update now)
 */
export async function forceUpdateNow(
  session: Session,
  username: string,
  updateManager: AutoUpdateManagerInterface | null
): Promise<void> {
  // Only session owner or globally allowed users can force update
  if (!await requireSessionOwner(session, username, 'force updates')) {
    return;
  }

  const formatter = session.platform.getFormatter();

  if (!updateManager) {
    await post(session, 'warning', `Auto-update is not available`);
    return;
  }

  // Check for updates first (same as !update does) to ensure we have fresh data
  // This fixes the inconsistency where !update finds updates but !update now doesn't
  const updateInfo = await updateManager.checkNow();

  if (!updateInfo || !updateInfo.available) {
    await post(session, 'info', `No update available to install`);
    return;
  }

  await post(session, 'info',
    `🔄 ${formatter.formatBold('Forcing update')} to v${updateInfo.latestVersion} - restarting shortly...\n` +
    formatter.formatItalic('Sessions will resume automatically')
  );

  // This will trigger the update process
  await updateManager.forceUpdate();
}

/**
 * Defer the pending update (!update defer)
 */
export async function deferUpdate(
  session: Session,
  username: string,
  updateManager: AutoUpdateManagerInterface | null
): Promise<void> {
  // Only session owner or globally allowed users can defer updates
  if (!await requireSessionOwner(session, username, 'defer updates')) {
    return;
  }

  const formatter = session.platform.getFormatter();

  if (!updateManager) {
    await post(session, 'warning', `Auto-update is not available`);
    return;
  }

  if (!updateManager.hasUpdate()) {
    await post(session, 'info', `No pending update to defer`);
    return;
  }

  updateManager.deferUpdate(60); // Defer for 1 hour

  await post(session, 'success',
    `⏸️ ${formatter.formatBold('Update deferred')} for 1 hour\n` +
    formatter.formatItalic('Use !update now to apply earlier')
  );
}

// ---------------------------------------------------------------------------
// Bug reporting
// ---------------------------------------------------------------------------

/**
 * Report a bug and create a GitHub issue.
 * Can be triggered by !bug command or by reacting to an error message.
 */
export async function reportBug(
  session: Session,
  description: string | undefined,
  username: string,
  ctx: SessionContext,
  errorContext?: ErrorContext,
  attachedFiles?: PlatformFile[]
): Promise<void> {
  const formatter = session.platform.getFormatter();

  // The one command that sends session data OFF the operator's
  // infrastructure: screenshots to a public anonymous file host, and a body
  // carrying session context plus recent daemon log lines to a public issue
  // on the maintainer's repository, behind best-effort redaction. Gated here
  // rather than at the command table because this function is also the 🐛
  // error-reaction path and the route Claude takes when it runs `!bug`
  // itself (`claudeCanExecute: true`) — a gate on the command alone would
  // leave both open.
  if (!ctx.config.bugReportsEnabled) {
    await post(session, 'info',
      `${formatter.formatBold('Bug reporting is disabled')} by this server's configuration ` +
      `(${formatter.formatCode('bugReports: false')}).\n` +
      `${formatter.formatItalic('Reports would otherwise be filed publicly, so nothing has been sent. Tell your operator instead.')}`
    );
    return;
  }

  // If no description and no error context, show usage
  if (!description && !errorContext) {
    await post(session, 'info',
      `Usage: ${formatter.formatCode('!bug <description>')}\n` +
      `Example: ${formatter.formatCode('!bug Session crashed when uploading large image')}\n\n` +
      `You can also attach screenshots to the !bug message.\n` +
      `Or react with 🐛 on any error message to report it.`
    );
    return;
  }

  // Check if gh CLI is available first
  const ghStatus = checkGitHubCli();
  if (!ghStatus.installed || !ghStatus.authenticated) {
    await postError(session, ghStatus.error || 'GitHub CLI not configured');
    return;
  }

  // Use error message as description if triggered by reaction
  // At this point either description or errorContext must exist (checked above)
  const bugDescription = description || (errorContext ? `Error: ${errorContext.message.substring(0, 200)}` : 'Unknown error');

  // Collect context
  const context = await collectBugReportContext(session, errorContext);

  // Upload any attached images to Catbox.moe
  let imageUrls: string[] = [];
  let imageErrors: string[] = [];

  const downloadFile = session.platform.downloadFile?.bind(session.platform);
  if (attachedFiles && attachedFiles.length > 0 && downloadFile) {
    // Show upload progress
    await post(session, 'info', `📤 Uploading ${attachedFiles.length} image(s)...`);

    const uploadResults = await uploadImages(
      attachedFiles,
      downloadFile
    );

    imageUrls = uploadResults
      .filter((r): r is typeof r & { url: string } => r.success && typeof r.url === 'string')
      .map(r => r.url);

    imageErrors = uploadResults
      .filter(r => !r.success)
      .map(r => `${r.originalFile.name}: ${r.error}`);
  }

  // Generate issue content (include uploaded images)
  const title = generateIssueTitle(bugDescription);
  const body = formatIssueBody(context, bugDescription, imageUrls);

  // Create preview message
  const preview = formatBugPreview(title, bugDescription, context, imageUrls, imageErrors, formatter);
  const previewMessage = `🐛 ${preview}`;

  // Post preview with approval reactions
  const bugReportPost = await postInteractiveAndRegister(
    session,
    previewMessage,
    [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]],
    ctx.ops.registerPost
  );

  // Store pending bug report
  session.messageManager?.setPendingBugReport({
    postId: bugReportPost.id,
    title,
    body,
    userDescription: bugDescription,
    imageUrls,
    imageErrors,
    errorContext,
  });

  sessionLog(session).info(`🐛 Bug report preview created by @${username}: ${title}`);
}

/**
 * Handle approval/denial of a pending bug report.
 * Called via MessageManager callback when user reacts to the preview.
 */
export async function handleBugReportApproval(
  session: Session,
  isApproved: boolean,
  username: string,
  ctx: SessionContext
): Promise<void> {
  // Read from MessageManager (sole source of truth)
  const pending = session.messageManager?.getPendingBugReport();
  if (!pending) return;

  // The second door to `gh issue create`: this is the only caller, and it
  // does not pass through `reportBug`, so the gate there does not cover it.
  // Approval becomes a denial — the card is cleared and nothing is filed —
  // while an explicit denial still works, so a stale card can be dismissed.
  if (!ctx.config.bugReportsEnabled) {
    isApproved = false;
  }

  const formatter = session.platform.getFormatter();

  if (isApproved) {
    try {
      // Create the GitHub issue (images are already embedded in the body as URLs)
      const issueUrl = await createGitHubIssue(
        pending.title,
        pending.body,
        session.workingDir
      );

      // Update the approval post to show success
      await updatePostSuccess(session, pending.postId,
        `${formatter.formatBold('Bug report submitted')}: ${issueUrl}`
      );

      sessionLog(session).info(`🐛 Bug report created by @${username}: ${issueUrl}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await updatePostError(session, pending.postId,
        `${formatter.formatBold('Failed to create bug report')}: ${errorMessage}`
      );
      sessionLog(session).error(`Failed to create bug report: ${errorMessage}`);
    }
  } else {
    // Cancelled
    await updatePostCancelled(session, pending.postId,
      `${formatter.formatBold('Bug report cancelled')} by ${formatter.formatUserMention(username)}`
    );
    sessionLog(session).info(`🐛 Bug report cancelled by @${username}`);
  }

  // Clear pending bug report
  session.messageManager?.clearPendingBugReport();
}
