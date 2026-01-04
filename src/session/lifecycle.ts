/**
 * Session lifecycle management module
 *
 * Handles session start, resume, exit, cleanup, and shutdown.
 */

import type { Session } from './types.js';
import { getSessionStatus } from './types.js';
import type { PlatformClient, PlatformFile } from '../platform/index.js';
import type { ClaudeCliOptions, ClaudeEvent } from '../claude/cli.js';
import { ClaudeCli } from '../claude/cli.js';
import type { PersistedSession } from '../persistence/session-store.js';
import { getLogo } from '../logo.js';
import { VERSION } from '../version.js';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { keepAlive } from '../utils/keep-alive.js';
import { logAndNotify, withErrorHandling } from './error-handler.js';
import { createLogger } from '../utils/logger.js';
import { postError, postInfo, postResume, postWarning, postTimeout } from './post-helpers.js';
import type { SessionContext } from './context.js';

const log = createLogger('lifecycle');

/**
 * Get a session-scoped logger for session events.
 * Uses session ID if available, otherwise falls back to global logger.
 */
function sessionLog(session: Session | null | undefined) {
  if (session?.sessionId) {
    return log.forSession(session.sessionId);
  }
  return log;
}

// ---------------------------------------------------------------------------
// Internal helpers for DRY code
// ---------------------------------------------------------------------------

/**
 * Get sessions map with correct mutable type.
 * Reduces type casting noise throughout the module.
 */
function mutableSessions(ctx: SessionContext): Map<string, Session> {
  return ctx.state.sessions as Map<string, Session>;
}

/**
 * Get postIndex map with correct mutable type.
 * Reduces type casting noise throughout the module.
 */
function mutablePostIndex(ctx: SessionContext): Map<string, string> {
  return ctx.state.postIndex as Map<string, string>;
}

/**
 * Clean up session timers (updateTimer and statusBarTimer).
 * Call this before removing a session from the map.
 */
function cleanupSessionTimers(session: Session): void {
  if (session.updateTimer) {
    clearTimeout(session.updateTimer);
    session.updateTimer = null;
  }
  if (session.statusBarTimer) {
    clearInterval(session.statusBarTimer);
    session.statusBarTimer = null;
  }
}

/**
 * Remove all postIndex entries for a given threadId.
 * Call this when cleaning up a session.
 */
function cleanupPostIndex(ctx: SessionContext, threadId: string): void {
  const postIndex = mutablePostIndex(ctx);
  for (const [postId, tid] of postIndex.entries()) {
    if (tid === threadId) {
      postIndex.delete(postId);
    }
  }
}

/**
 * Helper to find a persisted session by raw threadId.
 * Persisted sessions are keyed by composite sessionId, so we need to iterate.
 */
function findPersistedByThreadId(
  persisted: Map<string, PersistedSession>,
  threadId: string
): PersistedSession | undefined {
  for (const session of persisted.values()) {
    if (session.threadId === threadId) {
      return session;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// System prompt for chat platform context
// ---------------------------------------------------------------------------

/**
 * System prompt that gives Claude context about running in a chat platform.
 * This is appended to Claude's system prompt via --append-system-prompt.
 */
export const CHAT_PLATFORM_PROMPT = `
You are running inside a chat platform (like Mattermost or Slack). Users interact with you through chat messages in a thread.

**Claude Threads Version:** ${VERSION}

## How This Works
- You are Claude Code running as a bot via "Claude Threads"
- Your responses appear as messages in a chat thread
- Keep responses concise - very long responses are split across multiple messages
- Multiple users may participate in a session (the owner can invite others)

## Permissions & Interactions
- Permission requests (file writes, commands, etc.) appear as messages with emoji options
- Users approve with 👍 or deny with 👎 by reacting to the message
- Plan approvals and questions also use emoji reactions (👍/👎 for plans, number emoji for choices)

## User Commands
Users can control sessions with these commands:
- \`!stop\` or ❌ reaction: End the current operation
- \`!escape\` or ⏸️ reaction: Interrupt without ending the session
- \`!invite @user\`: Allow another user to send messages in this session
- \`!kick @user\`: Remove a user from the session
- \`!cd /path\`: Change working directory (restarts the session)
- \`!permissions interactive|skip\`: Toggle permission prompts

SESSION METADATA: At the START of your first response, include metadata about this session:

[SESSION_TITLE: <short title>]
[SESSION_DESCRIPTION: <brief description>]

Title requirements:
- 3-7 words maximum
- Descriptive of the main task/topic
- Written in imperative form (e.g., "Fix login bug", "Add dark mode")
- Do NOT include quotes

Description requirements:
- 1-2 sentences explaining what you're helping with
- Summarize the current work or goal
- Keep it under 100 characters

You can update both later if the session focus changes significantly.

Example: If the user asks "help me debug why the tests are failing", respond with:
[SESSION_TITLE: Debug failing tests]
[SESSION_DESCRIPTION: Investigating test failures and fixing broken assertions in the test suite.]

Then continue with your normal response.
`.trim();

/**
 * Reminder to update session metadata, injected periodically into user messages.
 */
const SESSION_METADATA_REMINDER = `
<system-reminder>
If the session topic has shifted or evolved significantly, update the session metadata:
[SESSION_TITLE: <current focus>]
[SESSION_DESCRIPTION: <what you're working on now>]
</system-reminder>
`.trim();

/**
 * How often to inject the metadata reminder (every N messages).
 */
const METADATA_REMINDER_INTERVAL = 5;

/**
 * Check if a metadata reminder should be injected for this message.
 * Returns the message with reminder appended if needed, otherwise returns original.
 */
export function maybeInjectMetadataReminder(
  message: string,
  session: { messageCount: number }
): string {
  // Only inject after the first message, at regular intervals
  if (session.messageCount > 1 && session.messageCount % METADATA_REMINDER_INTERVAL === 0) {
    return message + '\n\n' + SESSION_METADATA_REMINDER;
  }
  return message;
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/**
 * Create a new session for a thread.
 */
export async function startSession(
  options: { prompt: string; files?: PlatformFile[] },
  username: string,
  displayName: string | undefined,
  replyToPostId: string | undefined,
  platformId: string,
  ctx: SessionContext
): Promise<void> {
  const threadId = replyToPostId || '';

  // Check if session already exists for this thread
  const existingSessionId = ctx.ops.getSessionId(platformId, threadId);
  const existingSession = mutableSessions(ctx).get(existingSessionId);
  if (existingSession && existingSession.claude.isRunning()) {
    // Send as follow-up instead
    await sendFollowUp(existingSession, options.prompt, options.files, ctx);
    return;
  }

  const platforms = ctx.state.platforms as Map<string, PlatformClient>;
  const platform = platforms.get(platformId);
  if (!platform) {
    throw new Error(`Platform '${platformId}' not found. Call addPlatform() first.`);
  }

  // Check max sessions limit
  if (ctx.state.sessions.size >= ctx.config.maxSessions) {
    await platform.createPost(
      `⚠️ **Too busy** - ${ctx.state.sessions.size} sessions active. Please try again later.`,
      replyToPostId
    );
    return;
  }

  // Post initial session message
  const post = await withErrorHandling(
    () => platform.createPost(
      `${getLogo(VERSION)}\n\n*Starting session...*`,
      replyToPostId
    ),
    { action: 'Create session post' }
  );
  if (!post) return;
  const actualThreadId = replyToPostId || post.id;
  const sessionId = ctx.ops.getSessionId(platformId, actualThreadId);

  // Generate a unique session ID for this Claude session
  const claudeSessionId = randomUUID();

  // Create Claude CLI with options
  const platformMcpConfig = platform.getMcpConfig();

  const cliOptions: ClaudeCliOptions = {
    workingDir: ctx.config.workingDir,
    threadId: actualThreadId,
    skipPermissions: ctx.config.skipPermissions,
    sessionId: claudeSessionId,
    resume: false,
    chrome: ctx.config.chromeEnabled,
    platformConfig: platformMcpConfig,
    appendSystemPrompt: CHAT_PLATFORM_PROMPT,
    logSessionId: sessionId,  // Route logs to session panel
  };
  const claude = new ClaudeCli(cliOptions);

  // Create the session object
  const session: Session = {
    platformId,
    threadId: actualThreadId,
    sessionId,
    platform,
    claudeSessionId,
    startedBy: username,
    startedByDisplayName: displayName,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: ctx.state.sessions.size + 1,
    workingDir: ctx.config.workingDir,
    claude,
    currentPostId: null,
    pendingContent: '',
    pendingApproval: null,
    pendingQuestionSet: null,
    pendingMessageApproval: null,
    planApproved: false,
    sessionAllowedUsers: new Set([username]),
    forceInteractivePermissions: false,
    sessionStartPostId: post.id,
    tasksPostId: null,
    lastTasksContent: null,
    tasksCompleted: false,
    tasksMinimized: false,
    activeSubagents: new Map(),
    updateTimer: null,
    typingTimer: null,
    timeoutWarningPosted: false,
    isRestarting: false,
    isResumed: false,
    resumeFailCount: 0,
    wasInterrupted: false,
    hasClaudeResponded: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    firstPrompt: options.prompt,  // Set early so sticky message can use it
    messageCount: 0,  // Will be incremented when first message is sent
    isProcessing: true,  // Starts as true since we're sending initial prompt
    statusBarTimer: null,  // Will be started after first result event
  };

  // Register session
  mutableSessions(ctx).set(sessionId, session);
  ctx.ops.registerPost(post.id, actualThreadId);
  ctx.ops.emitSessionAdd(session);
  sessionLog(session).info(`▶ Session started by @${username}`);

  // Notify keep-alive that a session started
  keepAlive.sessionStarted();

  // Update the header with full session info
  await ctx.ops.updateSessionHeader(session);

  // Update sticky channel message with new session
  await ctx.ops.updateStickyMessage();

  // Start typing indicator
  ctx.ops.startTyping(session);

  // Bind event handlers (use sessionId which is the composite key)
  claude.on('event', (e: ClaudeEvent) => ctx.ops.handleEvent(sessionId, e));
  claude.on('exit', (code: number) => ctx.ops.handleExit(sessionId, code));

  try {
    claude.start();
  } catch (err) {
    await logAndNotify(err, { action: 'Start Claude', session });
    ctx.ops.stopTyping(session);
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    await ctx.ops.updateStickyMessage();
    return;
  }

  // Check if we should prompt for worktree
  const shouldPrompt = await ctx.ops.shouldPromptForWorktree(session);
  if (shouldPrompt) {
    session.queuedPrompt = options.prompt;
    session.pendingWorktreePrompt = true;
    await ctx.ops.postWorktreePrompt(session, shouldPrompt);
    ctx.ops.persistSession(session);
    await ctx.ops.updateStickyMessage();
    return;
  }

  // Build message content
  const content = await ctx.ops.buildMessageContent(options.prompt, session.platform, options.files);
  const messageText = typeof content === 'string' ? content : options.prompt;

  // Check if this is a mid-thread start (replyToPostId means we're replying in an existing thread)
  // Offer context prompt if there are previous messages in the thread
  // Pass replyToPostId to exclude the triggering message from the count
  if (replyToPostId) {
    const contextOffered = await ctx.ops.offerContextPrompt(session, messageText, replyToPostId);
    if (contextOffered) {
      // Context prompt was posted, message is queued
      // Don't persist yet - offerContextPrompt handles that
      return;
    }
  }

  // Increment message counter for first message
  session.messageCount++;

  // Send the message to Claude (no context prompt, or no previous messages)
  claude.sendMessage(content);

  // NOTE: We don't persist here. We wait for Claude to actually respond before persisting.
  // This prevents persisting sessions where Claude dies before saving its conversation,
  // which would result in "No conversation found" errors on resume.
  // Persistence happens in events.ts when we receive the first response from Claude.
}

/**
 * Resume a session from persisted state.
 */
export async function resumeSession(
  state: PersistedSession,
  ctx: SessionContext
): Promise<void> {
  // Validate required fields - skip gracefully if critical data is missing
  if (!state.threadId || !state.platformId || !state.claudeSessionId || !state.workingDir) {
    const missing = [
      !state.threadId && 'threadId',
      !state.platformId && 'platformId',
      !state.claudeSessionId && 'claudeSessionId',
      !state.workingDir && 'workingDir',
    ].filter(Boolean).join(', ');
    log.warn(`Skipping session with missing required fields: ${missing}`);
    return;
  }

  const shortId = state.threadId.substring(0, 8);

  // Get platform for this session
  const platforms = ctx.state.platforms as Map<string, PlatformClient>;
  const platform = platforms.get(state.platformId);
  if (!platform) {
    log.warn(`Platform ${state.platformId} not registered, skipping resume for ${shortId}...`);
    return;
  }

  // Verify thread still exists
  const post = await platform.getPost(state.threadId);
  if (!post) {
    log.warn(`Thread ${shortId}... deleted, skipping resume`);
    ctx.state.sessionStore.remove(`${state.platformId}:${state.threadId}`);
    return;
  }

  // Check max sessions limit
  if (ctx.state.sessions.size >= ctx.config.maxSessions) {
    log.warn(`Max sessions reached, skipping resume for ${shortId}...`);
    return;
  }

  // Verify working directory exists
  if (!existsSync(state.workingDir)) {
    log.warn(`Working directory ${state.workingDir} no longer exists, skipping resume for ${shortId}...`);
    ctx.state.sessionStore.remove(`${state.platformId}:${state.threadId}`);
    await withErrorHandling(
      () => platform.createPost(
        `⚠️ **Cannot resume session** - working directory no longer exists:\n\`${state.workingDir}\`\n\nPlease start a new session.`,
        state.threadId
      ),
      { action: 'Post resume failure notification' }
    );
    return;
  }

  const platformId = state.platformId;
  const sessionId = ctx.ops.getSessionId(platformId, state.threadId);

  // Create Claude CLI with resume flag
  const skipPerms = ctx.config.skipPermissions && !state.forceInteractivePermissions;
  const platformMcpConfig = platform.getMcpConfig();

  // Include system prompt if session doesn't have a title yet
  // This ensures Claude will generate a title on its next response
  const needsTitlePrompt = !state.sessionTitle;

  const cliOptions: ClaudeCliOptions = {
    workingDir: state.workingDir,
    threadId: state.threadId,
    skipPermissions: skipPerms,
    sessionId: state.claudeSessionId,
    resume: true,
    chrome: ctx.config.chromeEnabled,
    platformConfig: platformMcpConfig,
    appendSystemPrompt: needsTitlePrompt ? CHAT_PLATFORM_PROMPT : undefined,
    logSessionId: sessionId,  // Route logs to session panel
  };
  const claude = new ClaudeCli(cliOptions);

  // Rebuild Session object from persisted state
  // Use defensive defaults for all fields to handle old/incomplete persisted data
  const session: Session = {
    platformId,
    threadId: state.threadId,
    sessionId,
    platform,
    claudeSessionId: state.claudeSessionId,
    startedBy: state.startedBy || 'unknown',
    startedByDisplayName: state.startedByDisplayName,
    startedAt: state.startedAt ? new Date(state.startedAt) : new Date(),
    lastActivityAt: new Date(),
    sessionNumber: state.sessionNumber ?? 1,
    workingDir: state.workingDir,
    claude,
    currentPostId: null,
    pendingContent: '',
    pendingApproval: null,
    pendingQuestionSet: null,
    pendingMessageApproval: null,
    planApproved: state.planApproved ?? false,
    sessionAllowedUsers: new Set(state.sessionAllowedUsers || [state.startedBy].filter(Boolean)),
    forceInteractivePermissions: state.forceInteractivePermissions ?? false,
    sessionStartPostId: state.sessionStartPostId ?? null,
    tasksPostId: state.tasksPostId ?? null,
    lastTasksContent: state.lastTasksContent ?? null,
    tasksCompleted: state.tasksCompleted ?? false,
    tasksMinimized: state.tasksMinimized ?? false,
    activeSubagents: new Map(),
    updateTimer: null,
    typingTimer: null,
    timeoutWarningPosted: false,
    isRestarting: false,
    isResumed: true,
    resumeFailCount: state.resumeFailCount ?? 0,
    wasInterrupted: false,
    hasClaudeResponded: true,  // Resumed sessions have already had responses
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    worktreeInfo: state.worktreeInfo,
    pendingWorktreePrompt: state.pendingWorktreePrompt,
    worktreePromptDisabled: state.worktreePromptDisabled,
    queuedPrompt: state.queuedPrompt,
    firstPrompt: state.firstPrompt,
    needsContextPromptOnNextMessage: state.needsContextPromptOnNextMessage,
    sessionTitle: state.sessionTitle,
    sessionDescription: state.sessionDescription,
    pullRequestUrl: state.pullRequestUrl,
    messageCount: state.messageCount ?? 0,
    isProcessing: false,  // Resumed sessions are idle until user sends a message
    lifecyclePostId: state.lifecyclePostId,  // Pass through for resume message handling
    statusBarTimer: null,  // Will be started after first result event
  };

  // Register session
  mutableSessions(ctx).set(sessionId, session);
  if (state.sessionStartPostId) {
    ctx.ops.registerPost(state.sessionStartPostId, state.threadId);
  }
  // Register task post for reaction routing (task collapse toggle)
  if (state.tasksPostId) {
    ctx.ops.registerPost(state.tasksPostId, state.threadId);
  }
  ctx.ops.emitSessionAdd(session);

  // Notify keep-alive that a session started
  keepAlive.sessionStarted();

  // Bind event handlers (use sessionId which is the composite key)
  claude.on('event', (e: ClaudeEvent) => ctx.ops.handleEvent(sessionId, e));
  claude.on('exit', (code: number) => ctx.ops.handleExit(sessionId, code));

  try {
    claude.start();
    sessionLog(session).info(`🔄 Session resumed (@${state.startedBy})`);

    // Post or update resume message
    // If we have a lifecyclePostId, this was a timeout/shutdown - update that post
    // Otherwise create a new post (normal for old persisted sessions without lifecyclePostId)
    if (session.lifecyclePostId) {
      await withErrorHandling(
        () => session.platform.updatePost(session.lifecyclePostId!, `🔄 **Session resumed** by @${session.startedBy}\n*Reconnected to Claude session. You can continue where you left off.*`),
        { action: 'Update timeout/shutdown post for resume', session }
      );
      // Clear the lifecyclePostId since we're no longer in timeout/shutdown state
      session.lifecyclePostId = undefined;
    } else {
      // Fallback: create new post if no lifecyclePostId (e.g., old persisted sessions)
      await postResume(session, `**Session resumed** after bot restart (v${VERSION})\n*Reconnected to Claude session. You can continue where you left off.*`);
    }

    // Update session header
    await ctx.ops.updateSessionHeader(session);

    // Update sticky channel message with resumed session
    await ctx.ops.updateStickyMessage();

    // Update persistence with new activity time
    ctx.ops.persistSession(session);
  } catch (err) {
    log.error(`Failed to resume session ${shortId}`, err instanceof Error ? err : undefined);
    ctx.ops.emitSessionRemove(sessionId);
    mutableSessions(ctx).delete(sessionId);
    ctx.state.sessionStore.remove(sessionId);

    // Try to notify user
    await withErrorHandling(
      () => session.platform.createPost(
        `⚠️ **Could not resume previous session.** Starting fresh.\n*Your previous conversation context is preserved, but Claude needs to re-read it.*`,
        state.threadId
      ),
      { action: 'Post resume failure notification', session }
    );

    // Update sticky message after session removal
    await ctx.ops.updateStickyMessage();
  }
}

// ---------------------------------------------------------------------------
// Session messaging
// ---------------------------------------------------------------------------

/**
 * Send a follow-up message to an existing session.
 */
export async function sendFollowUp(
  session: Session,
  message: string,
  files: PlatformFile[] | undefined,
  ctx: SessionContext
): Promise<void> {
  if (!session.claude.isRunning()) return;

  // Bump task list below the user's message
  await ctx.ops.bumpTasksToBottom(session);

  const content = await ctx.ops.buildMessageContent(message, session.platform, files);
  const messageText = typeof content === 'string' ? content : message;

  // Check if we need to offer context prompt (e.g., after !cd)
  if (session.needsContextPromptOnNextMessage) {
    session.needsContextPromptOnNextMessage = false;
    const contextOffered = await ctx.ops.offerContextPrompt(session, messageText);
    if (contextOffered) {
      // Context prompt was posted, message is queued - don't send directly
      session.lastActivityAt = new Date();
      return;
    }
    // No thread history or context prompt declined, fall through to send directly
  }

  // Increment message counter
  session.messageCount++;

  // Inject metadata reminder periodically
  const messageToSend = typeof content === 'string'
    ? maybeInjectMetadataReminder(content, session)
    : content;

  // Mark as processing and update UI
  session.isProcessing = true;
  ctx.ops.emitSessionUpdate(session.sessionId, { status: getSessionStatus(session) });

  session.claude.sendMessage(messageToSend);
  session.lastActivityAt = new Date();
  ctx.ops.startTyping(session);
}

/**
 * Resume a paused session and send a message to it.
 */
export async function resumePausedSession(
  threadId: string,
  message: string,
  files: PlatformFile[] | undefined,
  ctx: SessionContext
): Promise<void> {
  // Find persisted session by raw threadId
  const persisted = ctx.state.sessionStore.load();
  const state = findPersistedByThreadId(persisted, threadId);
  if (!state) {
    log.debug(`No persisted session found for ${threadId.substring(0, 8)}...`);
    return;
  }

  const shortId = threadId.substring(0, 8);
  log.info(`🔄 Resuming paused session ${shortId}... for new message`);

  // Resume the session
  await resumeSession(state, ctx);

  // Wait a moment for the session to be ready, then send the message
  const session = ctx.ops.findSessionByThreadId(threadId);
  if (session && session.claude.isRunning()) {
    // Increment message counter
    session.messageCount++;

    const content = await ctx.ops.buildMessageContent(message, session.platform, files);

    // Inject metadata reminder periodically
    const messageToSend = typeof content === 'string'
      ? maybeInjectMetadataReminder(content, session)
      : content;

    session.claude.sendMessage(messageToSend);
    session.lastActivityAt = new Date();
    ctx.ops.startTyping(session);
  } else {
    log.warn(`Failed to resume session ${shortId}..., could not send message`);
  }
}

// ---------------------------------------------------------------------------
// Session termination
// ---------------------------------------------------------------------------

/**
 * Handle Claude CLI exit event.
 */
export async function handleExit(
  sessionId: string,
  code: number,
  ctx: SessionContext
): Promise<void> {
  const session = mutableSessions(ctx).get(sessionId);
  const shortId = sessionId.substring(0, 8);

  sessionLog(session).debug(`handleExit called code=${code} isShuttingDown=${ctx.state.isShuttingDown}`);

  if (!session) {
    log.debug(`Session ${shortId}... not found (already cleaned up)`);
    return;
  }

  // If we're intentionally restarting (e.g., !cd), don't clean up
  if (session.isRestarting) {
    sessionLog(session).debug(`Restarting, skipping cleanup`);
    session.isRestarting = false;
    return;
  }

  // If bot is shutting down, preserve persistence
  if (ctx.state.isShuttingDown) {
    sessionLog(session).debug(`Bot shutting down, preserving persistence`);
    ctx.ops.stopTyping(session);
    cleanupSessionTimers(session);
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    // Notify keep-alive that a session ended
    keepAlive.sessionEnded();
    return;
  }

  // If session was interrupted, preserve for resume (only if Claude has responded)
  if (session.wasInterrupted) {
    sessionLog(session).debug(`Exited after interrupt, preserving for resume`);
    ctx.ops.stopTyping(session);
    cleanupSessionTimers(session);
    // Only persist if Claude actually responded (otherwise there's nothing to resume)
    if (session.hasClaudeResponded) {
      ctx.ops.persistSession(session);
    }
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    cleanupPostIndex(ctx, session.threadId);
    // Notify keep-alive that a session ended
    keepAlive.sessionEnded();
    // Notify user
    const message = session.hasClaudeResponded
      ? `ℹ️ Session paused. Send a new message to continue.`
      : `ℹ️ Session ended before Claude could respond. Send a new message to start fresh.`;
    await withErrorHandling(
      () => postInfo(session, message),
      { action: 'Post session pause notification', session }
    );
    sessionLog(session).info(`⏸ Session paused`);
    // Update sticky channel message after session pause
    await ctx.ops.updateStickyMessage();
    return;
  }

  // If session exits before Claude responded, notify user (no point trying to resume)
  if (!session.hasClaudeResponded && !session.isResumed) {
    sessionLog(session).debug(`Exited before Claude responded, not persisting`);
    ctx.ops.stopTyping(session);
    cleanupSessionTimers(session);
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    cleanupPostIndex(ctx, session.threadId);
    keepAlive.sessionEnded();
    // Notify user
    await withErrorHandling(
      () => postWarning(session, `**Session ended** before Claude could respond (exit code ${code}). Please start a new session.`),
      { action: 'Post early exit notification', session }
    );
    sessionLog(session).info(`⚠ Session ended early (exit code ${code})`);
    await ctx.ops.updateStickyMessage();
    return;
  }

  // For resumed sessions that exit with error, track failures and give up after too many
  if (session.isResumed && code !== 0) {
    const MAX_RESUME_FAILURES = 3;
    session.resumeFailCount = (session.resumeFailCount || 0) + 1;

    // Check if this is a permanent failure that shouldn't be retried
    const isPermanent = session.claude.isPermanentFailure();
    const permanentReason = session.claude.getPermanentFailureReason();

    sessionLog(session).debug(`Resumed session failed with code ${code}, attempt ${session.resumeFailCount}/${MAX_RESUME_FAILURES}, permanent=${isPermanent}`);
    ctx.ops.stopTyping(session);
    cleanupSessionTimers(session);
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    // Notify keep-alive that a session ended
    keepAlive.sessionEnded();

    // Immediately give up on permanent failures
    if (isPermanent) {
      sessionLog(session).warn(`Detected permanent failure, removing from persistence: ${permanentReason}`);
      ctx.ops.unpersistSession(session.sessionId);
      await withErrorHandling(
        () => postError(session, `**Session cannot be resumed** — ${permanentReason}\n\nPlease start a new session.`),
        { action: 'Post session permanent failure', session }
      );
      await ctx.ops.updateStickyMessage();
      return;
    }

    if (session.resumeFailCount >= MAX_RESUME_FAILURES) {
      // Too many failures - give up and delete from persistence
      sessionLog(session).warn(`Exceeded ${MAX_RESUME_FAILURES} resume failures, removing from persistence`);
      ctx.ops.unpersistSession(session.sessionId);
      await withErrorHandling(
        () => postError(session, `**Session permanently failed** after ${MAX_RESUME_FAILURES} resume attempts (exit code ${code}). Session data has been removed. Please start a new session.`),
        { action: 'Post session permanent failure', session }
      );
    } else {
      // Still have retries left - persist with updated fail count
      ctx.ops.persistSession(session);
      await withErrorHandling(
        () => postWarning(session, `**Session resume failed** (exit code ${code}, attempt ${session.resumeFailCount}/${MAX_RESUME_FAILURES}). Will retry on next bot restart.`),
        { action: 'Post session resume failure', session }
      );
    }

    // Update sticky channel message after session failure
    await ctx.ops.updateStickyMessage();
    return;
  }

  // Normal exit cleanup
  sessionLog(session).debug(`Normal exit, cleaning up`);

  ctx.ops.stopTyping(session);
  cleanupSessionTimers(session);
  await ctx.ops.flush(session);

  if (code !== 0 && code !== null) {
    await postInfo(session, `**[Exited: ${code}]**`);
  }

  // Clean up session from maps
  ctx.ops.emitSessionRemove(session.sessionId);
  mutableSessions(ctx).delete(session.sessionId);
  cleanupPostIndex(ctx, session.threadId);

  // Notify keep-alive that a session ended
  keepAlive.sessionEnded();

  // Only unpersist for normal exits
  if (code === 0 || code === null) {
    ctx.ops.unpersistSession(session.sessionId);
  } else {
    sessionLog(session).debug(`Non-zero exit, preserving for potential retry`);
  }

  sessionLog(session).info(`■ Session ended`);

  // Update sticky channel message after session end
  await ctx.ops.updateStickyMessage();
}

/**
 * Kill a specific session.
 */
export async function killSession(
  session: Session,
  unpersist: boolean,
  ctx: SessionContext
): Promise<void> {
  // Set restarting flag to prevent handleExit from also unpersisting
  if (!unpersist) {
    session.isRestarting = true;
  }

  ctx.ops.stopTyping(session);
  session.claude.kill();

  // Clean up session from maps
  ctx.ops.emitSessionRemove(session.sessionId);
  mutableSessions(ctx).delete(session.sessionId);
  cleanupPostIndex(ctx, session.threadId);

  // Notify keep-alive that a session ended
  keepAlive.sessionEnded();

  // Explicitly unpersist if requested
  if (unpersist) {
    ctx.ops.unpersistSession(session.sessionId);
  }

  sessionLog(session).info(`✖ Session killed`);

  // Update sticky channel message after session kill
  await ctx.ops.updateStickyMessage();
}

/**
 * Kill all active sessions.
 * If isShuttingDown is true, persists sessions before killing so they can resume on restart.
 * Returns a Promise that resolves when all processes have exited.
 */
export async function killAllSessions(ctx: SessionContext): Promise<void> {
  const killPromises: Promise<void>[] = [];

  for (const session of ctx.state.sessions.values()) {
    ctx.ops.stopTyping(session);
    // Persist session state before killing if we're shutting down gracefully
    if (ctx.state.isShuttingDown) {
      ctx.ops.persistSession(session);
    }
    killPromises.push(session.claude.kill());
  }

  // Wait for all processes to exit
  await Promise.all(killPromises);

  mutableSessions(ctx).clear();
  mutablePostIndex(ctx).clear();

  // Force stop keep-alive
  keepAlive.forceStop();
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up idle sessions that have timed out.
 */
export async function cleanupIdleSessions(
  timeoutMs: number,
  warningMs: number,
  ctx: SessionContext
): Promise<void> {
  const now = Date.now();

  for (const [_sessionId, session] of ctx.state.sessions) {
    const idleMs = now - session.lastActivityAt.getTime();

    // Check for timeout
    if (idleMs > timeoutMs) {
      sessionLog(session).info(`⏰ Session timed out after ${Math.round(idleMs / 60000)}min idle`);

      const timeoutMessage = `**Session timed out** after ${Math.round(idleMs / 60000)} minutes of inactivity\n\n💡 React with 🔄 to resume, or send a new message to continue.`;

      // Update existing warning post or create a new one
      if (session.lifecyclePostId) {
        // Update the existing warning post to show timeout
        await withErrorHandling(
          () => session.platform.updatePost(session.lifecyclePostId!, `⏱️ ${timeoutMessage}`),
          { action: 'Update timeout post', session }
        );
      } else {
        // Create new timeout post (no warning was posted)
        const timeoutPost = await withErrorHandling(
          () => postTimeout(session, timeoutMessage),
          { action: 'Post session timeout', session }
        );
        if (timeoutPost) {
          session.lifecyclePostId = timeoutPost.id;
          ctx.ops.registerPost(timeoutPost.id, session.threadId);
        }
      }
      ctx.ops.persistSession(session);

      // Kill without unpersisting to allow resume
      await killSession(session, false, ctx);
      continue;
    }

    // Check for warning threshold (warn when X minutes before timeout)
    // warningMs = how long before timeout to warn (e.g., 5 min = 300000)
    // So warn when: idleMs > (timeoutMs - warningMs)
    const warningThresholdMs = timeoutMs - warningMs;
    if (idleMs > warningThresholdMs && !session.timeoutWarningPosted) {
      const remainingMins = Math.max(0, Math.round((timeoutMs - idleMs) / 60000));
      const warningMessage = `**Session idle** - will timeout in ~${remainingMins} minutes without activity`;

      // Create the warning post and store its ID for later updates
      const warningPost = await withErrorHandling(
        () => postTimeout(session, warningMessage),
        { action: 'Post timeout warning', session }
      );
      if (warningPost) {
        session.lifecyclePostId = warningPost.id;
        ctx.ops.registerPost(warningPost.id, session.threadId);
      }
      session.timeoutWarningPosted = true;
      sessionLog(session).debug(`⏰ Idle warning posted`);
    }
  }
}
