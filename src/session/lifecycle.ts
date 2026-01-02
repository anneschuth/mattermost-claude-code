/**
 * Session lifecycle management module
 *
 * Handles session start, resume, exit, cleanup, and shutdown.
 */

import type { Session } from './types.js';
import type { PlatformClient, PlatformFile } from '../platform/index.js';
import type { ClaudeCliOptions, ClaudeEvent, ContentBlock } from '../claude/cli.js';
import { ClaudeCli } from '../claude/cli.js';
import type { PersistedSession, SessionStore } from '../persistence/session-store.js';
import { getLogo } from '../logo.js';
import { VERSION } from '../version.js';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { keepAlive } from '../utils/keep-alive.js';

// ---------------------------------------------------------------------------
// Context types for dependency injection
// ---------------------------------------------------------------------------

export interface LifecycleContext {
  workingDir: string;
  skipPermissions: boolean;
  chromeEnabled: boolean;
  debug: boolean;
  maxSessions: number;
  sessions: Map<string, Session>;
  postIndex: Map<string, string>;
  platforms: Map<string, PlatformClient>;
  sessionStore: SessionStore;
  isShuttingDown: boolean;
  getSessionId: (platformId: string, threadId: string) => string;
  findSessionByThreadId: (threadId: string) => Session | undefined;
  handleEvent: (sessionId: string, event: ClaudeEvent) => void;
  handleExit: (sessionId: string, code: number) => Promise<void>;
  registerPost: (postId: string, threadId: string) => void;
  startTyping: (session: Session) => void;
  stopTyping: (session: Session) => void;
  flush: (session: Session) => Promise<void>;
  persistSession: (session: Session) => void;
  unpersistSession: (sessionId: string) => void;
  updateSessionHeader: (session: Session) => Promise<void>;
  shouldPromptForWorktree: (session: Session) => Promise<string | null>;
  postWorktreePrompt: (session: Session, reason: string) => Promise<void>;
  buildMessageContent: (text: string, platform: PlatformClient, files?: PlatformFile[]) => Promise<string | ContentBlock[]>;
  offerContextPrompt: (session: Session, queuedPrompt: string, excludePostId?: string) => Promise<boolean>;
  bumpTasksToBottom: (session: Session) => Promise<void>;
  updateStickyMessage: () => Promise<void>;
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
 * System prompt that instructs Claude to generate session titles and descriptions.
 * This is appended to Claude's system prompt via --append-system-prompt.
 */
export const CHAT_PLATFORM_PROMPT = `
You are running inside a chat platform (like Mattermost or Slack). Users interact with you through chat messages in a thread.

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
  ctx: LifecycleContext
): Promise<void> {
  const threadId = replyToPostId || '';

  // Check if session already exists for this thread
  const existingSessionId = ctx.getSessionId(platformId, threadId);
  const existingSession = ctx.sessions.get(existingSessionId);
  if (existingSession && existingSession.claude.isRunning()) {
    // Send as follow-up instead
    await sendFollowUp(existingSession, options.prompt, options.files, ctx);
    return;
  }

  const platform = ctx.platforms.get(platformId);
  if (!platform) {
    throw new Error(`Platform '${platformId}' not found. Call addPlatform() first.`);
  }

  // Check max sessions limit
  if (ctx.sessions.size >= ctx.maxSessions) {
    await platform.createPost(
      `⚠️ **Too busy** - ${ctx.sessions.size} sessions active. Please try again later.`,
      replyToPostId
    );
    return;
  }

  // Post initial session message
  let post;
  try {
    post = await platform.createPost(
      `${getLogo(VERSION)}\n\n*Starting session...*`,
      replyToPostId
    );
  } catch (err) {
    console.error(`  ❌ Failed to create session post:`, err);
    return;
  }
  const actualThreadId = replyToPostId || post.id;
  const sessionId = ctx.getSessionId(platformId, actualThreadId);

  // Generate a unique session ID for this Claude session
  const claudeSessionId = randomUUID();

  // Create Claude CLI with options
  const platformMcpConfig = platform.getMcpConfig();

  const cliOptions: ClaudeCliOptions = {
    workingDir: ctx.workingDir,
    threadId: actualThreadId,
    skipPermissions: ctx.skipPermissions,
    sessionId: claudeSessionId,
    resume: false,
    chrome: ctx.chromeEnabled,
    platformConfig: platformMcpConfig,
    appendSystemPrompt: CHAT_PLATFORM_PROMPT,
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
    sessionNumber: ctx.sessions.size + 1,
    workingDir: ctx.workingDir,
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
    wasInterrupted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    firstPrompt: options.prompt,  // Set early so sticky message can use it
    messageCount: 0,  // Will be incremented when first message is sent
    statusBarTimer: null,  // Will be started after first result event
  };

  // Register session
  ctx.sessions.set(sessionId, session);
  ctx.registerPost(post.id, actualThreadId);
  const shortId = actualThreadId.substring(0, 8);
  console.log(`  ▶ Session #${ctx.sessions.size} started (${shortId}…) by @${username}`);

  // Notify keep-alive that a session started
  keepAlive.sessionStarted();

  // Update the header with full session info
  await ctx.updateSessionHeader(session);

  // Update sticky channel message with new session
  await ctx.updateStickyMessage();

  // Start typing indicator
  ctx.startTyping(session);

  // Bind event handlers (use sessionId which is the composite key)
  claude.on('event', (e: ClaudeEvent) => ctx.handleEvent(sessionId, e));
  claude.on('exit', (code: number) => ctx.handleExit(sessionId, code));

  try {
    claude.start();
  } catch (err) {
    console.error('  ❌ Failed to start Claude:', err);
    ctx.stopTyping(session);
    await session.platform.createPost(`❌ ${err}`, actualThreadId);
    ctx.sessions.delete(session.sessionId);
    // Update sticky message after session failure
    await ctx.updateStickyMessage();
    return;
  }

  // Check if we should prompt for worktree
  const shouldPrompt = await ctx.shouldPromptForWorktree(session);
  if (shouldPrompt) {
    session.queuedPrompt = options.prompt;
    session.pendingWorktreePrompt = true;
    await ctx.postWorktreePrompt(session, shouldPrompt);
    ctx.persistSession(session);
    return;
  }

  // Build message content
  const content = await ctx.buildMessageContent(options.prompt, session.platform, options.files);
  const messageText = typeof content === 'string' ? content : options.prompt;

  // Check if this is a mid-thread start (replyToPostId means we're replying in an existing thread)
  // Offer context prompt if there are previous messages in the thread
  // Pass replyToPostId to exclude the triggering message from the count
  if (replyToPostId) {
    const contextOffered = await ctx.offerContextPrompt(session, messageText, replyToPostId);
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

  // Persist session for resume after restart
  ctx.persistSession(session);
}

/**
 * Resume a session from persisted state.
 */
export async function resumeSession(
  state: PersistedSession,
  ctx: LifecycleContext
): Promise<void> {
  const shortId = state.threadId.substring(0, 8);

  // Get platform for this session
  const platform = ctx.platforms.get(state.platformId);
  if (!platform) {
    console.log(`  ⚠️ Platform ${state.platformId} not registered, skipping resume for ${shortId}...`);
    return;
  }

  // Verify thread still exists
  const post = await platform.getPost(state.threadId);
  if (!post) {
    console.log(`  ⚠️ Thread ${shortId}... deleted, skipping resume`);
    ctx.sessionStore.remove(`${state.platformId}:${state.threadId}`);
    return;
  }

  // Check max sessions limit
  if (ctx.sessions.size >= ctx.maxSessions) {
    console.log(`  ⚠️ Max sessions reached, skipping resume for ${shortId}...`);
    return;
  }

  // Verify working directory exists
  if (!existsSync(state.workingDir)) {
    console.log(`  ⚠️ Working directory ${state.workingDir} no longer exists, skipping resume for ${shortId}...`);
    ctx.sessionStore.remove(`${state.platformId}:${state.threadId}`);
    try {
      await platform.createPost(
        `⚠️ **Cannot resume session** - working directory no longer exists:\n\`${state.workingDir}\`\n\nPlease start a new session.`,
        state.threadId
      );
    } catch {
      // Ignore if we can't post
    }
    return;
  }

  const platformId = state.platformId;
  const sessionId = ctx.getSessionId(platformId, state.threadId);

  // Create Claude CLI with resume flag
  const skipPerms = ctx.skipPermissions && !state.forceInteractivePermissions;
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
    chrome: ctx.chromeEnabled,
    platformConfig: platformMcpConfig,
    appendSystemPrompt: needsTitlePrompt ? CHAT_PLATFORM_PROMPT : undefined,
  };
  const claude = new ClaudeCli(cliOptions);

  // Rebuild Session object from persisted state
  const session: Session = {
    platformId,
    threadId: state.threadId,
    sessionId,
    platform,
    claudeSessionId: state.claudeSessionId,
    startedBy: state.startedBy,
    startedByDisplayName: state.startedByDisplayName,
    startedAt: new Date(state.startedAt),
    lastActivityAt: new Date(),
    sessionNumber: state.sessionNumber,
    workingDir: state.workingDir,
    claude,
    currentPostId: null,
    pendingContent: '',
    pendingApproval: null,
    pendingQuestionSet: null,
    pendingMessageApproval: null,
    planApproved: state.planApproved,
    sessionAllowedUsers: new Set(state.sessionAllowedUsers),
    forceInteractivePermissions: state.forceInteractivePermissions,
    sessionStartPostId: state.sessionStartPostId,
    tasksPostId: state.tasksPostId,
    lastTasksContent: state.lastTasksContent ?? null,
    tasksCompleted: state.tasksCompleted ?? false,
    tasksMinimized: state.tasksMinimized ?? false,
    activeSubagents: new Map(),
    updateTimer: null,
    typingTimer: null,
    timeoutWarningPosted: false,
    isRestarting: false,
    isResumed: true,
    wasInterrupted: false,
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
    messageCount: state.messageCount ?? 0,
    statusBarTimer: null,  // Will be started after first result event
  };

  // Register session
  ctx.sessions.set(sessionId, session);
  if (state.sessionStartPostId) {
    ctx.registerPost(state.sessionStartPostId, state.threadId);
  }
  // Register task post for reaction routing (task collapse toggle)
  if (state.tasksPostId) {
    ctx.registerPost(state.tasksPostId, state.threadId);
  }

  // Notify keep-alive that a session started
  keepAlive.sessionStarted();

  // Bind event handlers (use sessionId which is the composite key)
  claude.on('event', (e: ClaudeEvent) => ctx.handleEvent(sessionId, e));
  claude.on('exit', (code: number) => ctx.handleExit(sessionId, code));

  try {
    claude.start();
    console.log(`  🔄 Resumed session ${shortId}... (@${state.startedBy})`);

    // Post resume message
    await session.platform.createPost(
      `🔄 **Session resumed** after bot restart (v${VERSION})\n*Reconnected to Claude session. You can continue where you left off.*`,
      state.threadId
    );

    // Update session header
    await ctx.updateSessionHeader(session);

    // Update sticky channel message with resumed session
    await ctx.updateStickyMessage();

    // Update persistence with new activity time
    ctx.persistSession(session);
  } catch (err) {
    console.error(`  ❌ Failed to resume session ${shortId}...:`, err);
    ctx.sessions.delete(sessionId);
    ctx.sessionStore.remove(sessionId);

    // Try to notify user
    try {
      await session.platform.createPost(
        `⚠️ **Could not resume previous session.** Starting fresh.\n*Your previous conversation context is preserved, but Claude needs to re-read it.*`,
        state.threadId
      );
    } catch {
      // Ignore if we can't post
    }

    // Update sticky message after session removal
    await ctx.updateStickyMessage();
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
  ctx: LifecycleContext
): Promise<void> {
  if (!session.claude.isRunning()) return;

  // Bump task list below the user's message
  await ctx.bumpTasksToBottom(session);

  const content = await ctx.buildMessageContent(message, session.platform, files);
  const messageText = typeof content === 'string' ? content : message;

  // Check if we need to offer context prompt (e.g., after !cd)
  if (session.needsContextPromptOnNextMessage) {
    session.needsContextPromptOnNextMessage = false;
    const contextOffered = await ctx.offerContextPrompt(session, messageText);
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

  session.claude.sendMessage(messageToSend);
  session.lastActivityAt = new Date();
  ctx.startTyping(session);
}

/**
 * Resume a paused session and send a message to it.
 */
export async function resumePausedSession(
  threadId: string,
  message: string,
  files: PlatformFile[] | undefined,
  ctx: LifecycleContext
): Promise<void> {
  // Find persisted session by raw threadId
  const persisted = ctx.sessionStore.load();
  const state = findPersistedByThreadId(persisted, threadId);
  if (!state) {
    console.log(`  [resume] No persisted session found for ${threadId.substring(0, 8)}...`);
    return;
  }

  const shortId = threadId.substring(0, 8);
  console.log(`  🔄 Resuming paused session ${shortId}... for new message`);

  // Resume the session
  await resumeSession(state, ctx);

  // Wait a moment for the session to be ready, then send the message
  const session = ctx.findSessionByThreadId(threadId);
  if (session && session.claude.isRunning()) {
    // Increment message counter
    session.messageCount++;

    const content = await ctx.buildMessageContent(message, session.platform, files);

    // Inject metadata reminder periodically
    const messageToSend = typeof content === 'string'
      ? maybeInjectMetadataReminder(content, session)
      : content;

    session.claude.sendMessage(messageToSend);
    session.lastActivityAt = new Date();
    ctx.startTyping(session);
  } else {
    console.log(`  ⚠️ Failed to resume session ${shortId}..., could not send message`);
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
  ctx: LifecycleContext
): Promise<void> {
  const session = ctx.sessions.get(sessionId);
  const shortId = sessionId.substring(0, 8);

  console.log(`  [exit] handleExit called for ${shortId}... code=${code} isShuttingDown=${ctx.isShuttingDown}`);

  if (!session) {
    console.log(`  [exit] Session ${shortId}... not found (already cleaned up)`);
    return;
  }

  // If we're intentionally restarting (e.g., !cd), don't clean up
  if (session.isRestarting) {
    console.log(`  [exit] Session ${shortId}... restarting, skipping cleanup`);
    session.isRestarting = false;
    return;
  }

  // If bot is shutting down, preserve persistence
  if (ctx.isShuttingDown) {
    console.log(`  [exit] Session ${shortId}... bot shutting down, preserving persistence`);
    ctx.stopTyping(session);
    if (session.updateTimer) {
      clearTimeout(session.updateTimer);
      session.updateTimer = null;
    }
    if (session.statusBarTimer) {
      clearInterval(session.statusBarTimer);
      session.statusBarTimer = null;
    }
    ctx.sessions.delete(session.sessionId);
    // Notify keep-alive that a session ended
    keepAlive.sessionEnded();
    return;
  }

  // If session was interrupted, preserve for resume
  if (session.wasInterrupted) {
    console.log(`  [exit] Session ${shortId}... exited after interrupt, preserving for resume`);
    ctx.stopTyping(session);
    if (session.updateTimer) {
      clearTimeout(session.updateTimer);
      session.updateTimer = null;
    }
    if (session.statusBarTimer) {
      clearInterval(session.statusBarTimer);
      session.statusBarTimer = null;
    }
    ctx.persistSession(session);
    ctx.sessions.delete(session.sessionId);
    // Clean up post index
    for (const [postId, tid] of ctx.postIndex.entries()) {
      if (tid === session.threadId) {
        ctx.postIndex.delete(postId);
      }
    }
    // Notify keep-alive that a session ended
    keepAlive.sessionEnded();
    // Notify user
    try {
      await session.platform.createPost(
        `ℹ️ Session paused. Send a new message to continue.`,
        session.threadId
      );
    } catch {
      // Ignore
    }
    console.log(`  ⏸️ Session paused (${shortId}…) — ${ctx.sessions.size} active`);
    // Update sticky channel message after session pause
    await ctx.updateStickyMessage();
    return;
  }

  // For resumed sessions that exit with error, preserve for retry
  if (session.isResumed && code !== 0) {
    console.log(`  [exit] Resumed session ${shortId}... failed with code ${code}, preserving for retry`);
    ctx.stopTyping(session);
    if (session.updateTimer) {
      clearTimeout(session.updateTimer);
      session.updateTimer = null;
    }
    if (session.statusBarTimer) {
      clearInterval(session.statusBarTimer);
      session.statusBarTimer = null;
    }
    ctx.sessions.delete(session.sessionId);
    // Notify keep-alive that a session ended
    keepAlive.sessionEnded();
    try {
      await session.platform.createPost(
        `⚠️ **Session resume failed** (exit code ${code}). The session data is preserved - try restarting the bot.`,
        session.threadId
      );
    } catch {
      // Ignore
    }
    // Update sticky channel message after session failure
    await ctx.updateStickyMessage();
    return;
  }

  // Normal exit cleanup
  console.log(`  [exit] Session ${shortId}... normal exit, cleaning up`);

  ctx.stopTyping(session);
  if (session.updateTimer) {
    clearTimeout(session.updateTimer);
    session.updateTimer = null;
  }
  if (session.statusBarTimer) {
    clearInterval(session.statusBarTimer);
    session.statusBarTimer = null;
  }
  await ctx.flush(session);

  if (code !== 0 && code !== null) {
    await session.platform.createPost(`**[Exited: ${code}]**`, session.threadId);
  }

  // Clean up session from maps
  ctx.sessions.delete(session.sessionId);
  for (const [postId, tid] of ctx.postIndex.entries()) {
    if (tid === session.threadId) {
      ctx.postIndex.delete(postId);
    }
  }

  // Notify keep-alive that a session ended
  keepAlive.sessionEnded();

  // Only unpersist for normal exits
  if (code === 0 || code === null) {
    ctx.unpersistSession(session.sessionId);
  } else {
    console.log(`  [exit] Session ${shortId}... non-zero exit, preserving for potential retry`);
  }

  console.log(`  ■ Session ended (${shortId}…) — ${ctx.sessions.size} active`);

  // Update sticky channel message after session end
  await ctx.updateStickyMessage();
}

/**
 * Kill a specific session.
 */
export async function killSession(
  session: Session,
  unpersist: boolean,
  ctx: LifecycleContext
): Promise<void> {
  const shortId = session.threadId.substring(0, 8);

  // Set restarting flag to prevent handleExit from also unpersisting
  if (!unpersist) {
    session.isRestarting = true;
  }

  ctx.stopTyping(session);
  session.claude.kill();

  // Clean up session from maps
  ctx.sessions.delete(session.sessionId);
  for (const [postId, tid] of ctx.postIndex.entries()) {
    if (tid === session.threadId) {
      ctx.postIndex.delete(postId);
    }
  }

  // Notify keep-alive that a session ended
  keepAlive.sessionEnded();

  // Explicitly unpersist if requested
  if (unpersist) {
    ctx.unpersistSession(session.threadId);
  }

  console.log(`  ✖ Session killed (${shortId}…) — ${ctx.sessions.size} active`);

  // Update sticky channel message after session kill
  await ctx.updateStickyMessage();
}

/**
 * Kill all active sessions.
 * If isShuttingDown is true, persists sessions before killing so they can resume on restart.
 */
export function killAllSessions(ctx: LifecycleContext): void {
  for (const session of ctx.sessions.values()) {
    ctx.stopTyping(session);
    // Persist session state before killing if we're shutting down gracefully
    if (ctx.isShuttingDown) {
      ctx.persistSession(session);
    }
    session.claude.kill();
  }
  ctx.sessions.clear();
  ctx.postIndex.clear();

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
  ctx: LifecycleContext
): Promise<void> {
  const now = Date.now();

  for (const [_sessionId, session] of ctx.sessions) {
    const idleMs = now - session.lastActivityAt.getTime();
    const shortId = session.threadId.substring(0, 8);

    // Check for timeout
    if (idleMs > timeoutMs) {
      console.log(`  ⏰ Session (${shortId}…) timed out after ${Math.round(idleMs / 60000)}min idle`);

      // Post timeout message with resume hint and save the post ID
      try {
        const timeoutPost = await session.platform.createPost(
          `⏰ **Session timed out** after ${Math.round(idleMs / 60000)} minutes of inactivity\n\n` +
          `💡 React with 🔄 to resume, or send a new message to continue.`,
          session.threadId
        );

        // Store the timeout post ID for resume via reaction
        session.timeoutPostId = timeoutPost.id;
        ctx.persistSession(session);
        ctx.registerPost(timeoutPost.id, session.threadId);
      } catch {
        // Ignore if we can't post
      }

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
      session.platform.createPost(
        `⏰ **Session idle** - will timeout in ~${remainingMins} minutes without activity`,
        session.threadId
      ).catch(() => {});
      session.timeoutWarningPosted = true;
      console.log(`  ⏰ Session (${shortId}…) idle warning posted`);
    }
  }
}
