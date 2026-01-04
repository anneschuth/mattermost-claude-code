/**
 * SessionManager - Orchestrates Claude Code sessions across chat platforms
 *
 * This is the main coordinator that delegates to specialized modules:
 * - lifecycle.ts: Session start, resume, exit
 * - events.ts: Claude event handling
 * - reactions.ts: User reaction handling
 * - commands.ts: User commands (!cd, !invite, etc.)
 * - worktree.ts: Git worktree management
 * - streaming.ts: Message streaming and flushing
 */

import { EventEmitter } from 'events';
import { ClaudeEvent, ContentBlock } from '../claude/cli.js';
import type { PlatformClient, PlatformUser, PlatformPost, PlatformFile } from '../platform/index.js';
import { SessionStore, PersistedSession, PersistedContextPrompt } from '../persistence/session-store.js';
import { WorktreeMode } from '../config.js';
import type { SessionInfo } from '../ui/types.js';
import {
  isCancelEmoji,
  isEscapeEmoji,
  isResumeEmoji,
  isTaskToggleEmoji,
} from '../utils/emoji.js';

// Import extracted modules
import * as streaming from './streaming.js';
import * as events from './events.js';
import * as reactions from './reactions.js';
import * as commands from './commands.js';
import * as lifecycle from './lifecycle.js';
import { CHAT_PLATFORM_PROMPT } from './lifecycle.js';
import * as worktreeModule from './worktree.js';
import * as contextPrompt from './context-prompt.js';
import * as stickyMessage from './sticky-message.js';
import type { Session } from './types.js';
import { postInfo } from './post-helpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('manager');

// Import unified context
import {
  type SessionContext,
  type SessionConfig,
  type SessionState,
  type SessionOperations,
  createSessionContext,
} from './context.js';

// Import constants for internal use
import { MAX_SESSIONS, SESSION_TIMEOUT_MS, SESSION_WARNING_MS, getSessionStatus } from './types.js';

/**
 * SessionManager - Main orchestrator for Claude Code sessions
 *
 * Emits events:
 * - 'session:add' (session: SessionInfo) - New session started
 * - 'session:update' (sessionId: string, updates: Partial<SessionInfo>) - Session state changed
 * - 'session:remove' (sessionId: string) - Session ended
 */
export class SessionManager extends EventEmitter {
  // Platform management
  private platforms: Map<string, PlatformClient> = new Map();
  private workingDir: string;
  private skipPermissions: boolean;
  private chromeEnabled: boolean;
  private worktreeMode: WorktreeMode;
  private debug = process.env.DEBUG === '1' || process.argv.includes('--debug');

  // Session state
  private sessions: Map<string, Session> = new Map();
  private postIndex: Map<string, string> = new Map();

  // Persistence
  private sessionStore: SessionStore = new SessionStore();

  // Cleanup
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Shutdown flag
  private isShuttingDown = false;

  constructor(
    workingDir: string,
    skipPermissions = false,
    chromeEnabled = false,
    worktreeMode: WorktreeMode = 'prompt'
  ) {
    super();
    this.workingDir = workingDir;
    this.skipPermissions = skipPermissions;
    this.chromeEnabled = chromeEnabled;
    this.worktreeMode = worktreeMode;

    // Start periodic cleanup and sticky refresh
    this.cleanupTimer = setInterval(() => {
      lifecycle.cleanupIdleSessions(SESSION_TIMEOUT_MS, SESSION_WARNING_MS, this.getContext())
        .catch(err => log.error(`Error during idle session cleanup: ${err}`));
      // Refresh sticky message to keep relative times current (only if there are active sessions)
      if (this.sessions.size > 0) {
        this.updateStickyMessage()
          .catch(err => log.error(`Error during periodic refresh: ${err}`));
      }
    }, 60000);
  }

  // ---------------------------------------------------------------------------
  // Platform Management
  // ---------------------------------------------------------------------------

  addPlatform(platformId: string, client: PlatformClient): void {
    this.platforms.set(platformId, client);
    client.on('message', (post, user) => this.handleMessage(platformId, post, user));
    client.on('reaction', (reaction, user) => {
      if (user) {
        this.handleReaction(platformId, reaction.postId, reaction.emojiName, user.username, 'added');
      }
    });
    client.on('reaction_removed', (reaction, user) => {
      if (user) {
        this.handleReaction(platformId, reaction.postId, reaction.emojiName, user.username, 'removed');
      }
    });
    // Bump sticky message to bottom when someone posts in the channel
    client.on('channel_post', () => {
      stickyMessage.markNeedsBump(platformId);
      this.updateStickyMessage();
    });
    log.info(`📡 Platform "${platformId}" registered`);
  }

  removePlatform(platformId: string): void {
    this.platforms.delete(platformId);
  }

  // ---------------------------------------------------------------------------
  // Unified Context Builder
  // ---------------------------------------------------------------------------

  /**
   * Build the unified SessionContext that all modules receive.
   * This replaces the previous 4 separate context builders.
   */
  private getContext(): SessionContext {
    const config: SessionConfig = {
      workingDir: this.workingDir,
      skipPermissions: this.skipPermissions,
      chromeEnabled: this.chromeEnabled,
      debug: this.debug,
      maxSessions: MAX_SESSIONS,
    };

    const state: SessionState = {
      sessions: this.sessions,
      postIndex: this.postIndex,
      platforms: this.platforms,
      sessionStore: this.sessionStore,
      isShuttingDown: this.isShuttingDown,
    };

    const ops: SessionOperations = {
      // Session lookup
      getSessionId: (pid, tid) => this.getSessionId(pid, tid),
      findSessionByThreadId: (tid) => this.findSessionByThreadId(tid),

      // Post management
      registerPost: (pid, tid) => this.registerPost(pid, tid),

      // Streaming & content
      flush: (s) => this.flush(s),
      appendContent: (s, t) => this.appendContent(s, t),
      startTyping: (s) => this.startTyping(s),
      stopTyping: (s) => this.stopTyping(s),
      buildMessageContent: (t, p, f) => this.buildMessageContent(t, p, f),
      bumpTasksToBottom: (s) => this.bumpTasksToBottom(s),

      // Persistence
      persistSession: (s) => this.persistSession(s),
      unpersistSession: (sid) => this.unpersistSession(sid),

      // UI updates
      updateSessionHeader: (s) => this.updateSessionHeader(s),
      updateStickyMessage: () => this.updateStickyMessage(),

      // Event handling
      handleEvent: (sid, e) => this.handleEvent(sid, e),
      handleExit: (sid, code) => this.handleExit(sid, code),

      // Session lifecycle
      killSession: (tid) => this.killSession(tid),

      // Worktree
      shouldPromptForWorktree: (s) => this.shouldPromptForWorktree(s),
      postWorktreePrompt: (s, r) => this.postWorktreePrompt(s, r),

      // Context prompt
      offerContextPrompt: (s, q, e) => this.offerContextPrompt(s, q, e),

      // UI event emission
      emitSessionAdd: (s) => this.emitSessionAdd(s),
      emitSessionUpdate: (sid, u) => this.emitSessionUpdate(sid, u),
      emitSessionRemove: (sid) => this.emitSessionRemove(sid),
    };

    return createSessionContext(config, state, ops);
  }

  // ---------------------------------------------------------------------------
  // Session ID and Post Index
  // ---------------------------------------------------------------------------

  private getSessionId(platformId: string, threadId: string): string {
    return `${platformId}:${threadId}`;
  }

  // ---------------------------------------------------------------------------
  // UI Event Emission
  // ---------------------------------------------------------------------------

  /**
   * Convert internal Session to SessionInfo for UI.
   */
  private toSessionInfo(session: Session): SessionInfo {
    return {
      id: session.sessionId,
      threadId: session.threadId,
      startedBy: session.startedBy,
      displayName: session.displayName,
      status: getSessionStatus(session),
      workingDir: session.workingDir,
      sessionNumber: session.sessionNumber,
      worktreeBranch: session.worktreeInfo?.branch,
      // Rich metadata
      title: session.sessionTitle,
      description: session.sessionDescription,
      lastActivity: session.lastActivity,
      // Typing indicator state
      isTyping: session.typingTimer !== null,
    };
  }

  /**
   * Emit session:add event with session info for UI.
   */
  emitSessionAdd(session: Session): void {
    this.emit('session:add', this.toSessionInfo(session));
  }

  /**
   * Emit session:update event with partial updates for UI.
   */
  emitSessionUpdate(sessionId: string, updates: Partial<SessionInfo>): void {
    this.emit('session:update', sessionId, updates);
  }

  /**
   * Emit session:remove event for UI.
   */
  emitSessionRemove(sessionId: string): void {
    this.emit('session:remove', sessionId);
  }

  private registerPost(postId: string, threadId: string): void {
    this.postIndex.set(postId, threadId);
  }

  private getSessionByPost(postId: string): Session | undefined {
    const threadId = this.postIndex.get(postId);
    if (!threadId) return undefined;
    return this.findSessionByThreadId(threadId);
  }

  // ---------------------------------------------------------------------------
  // Message Handling
  // ---------------------------------------------------------------------------

  private async handleMessage(_platformId: string, _post: PlatformPost, _user: PlatformUser | null): Promise<void> {
    // Message handling is done by the platform client routing to startSession/sendFollowUp
    // This is just a placeholder for the event subscription
  }

  // ---------------------------------------------------------------------------
  // Reaction Handling
  // ---------------------------------------------------------------------------

  private async handleReaction(
    platformId: string,
    postId: string,
    emojiName: string,
    username: string,
    action: 'added' | 'removed'
  ): Promise<void> {
    // First, check if this is a resume emoji for a timed-out session (only on add)
    if (action === 'added' && isResumeEmoji(emojiName)) {
      const resumed = await this.tryResumeFromReaction(platformId, postId, username);
      if (resumed) return;
    }

    const session = this.getSessionByPost(postId);
    if (!session) return;

    // Verify this reaction is from the same platform
    if (session.platformId !== platformId) return;

    // Only process reactions from allowed users
    if (!session.sessionAllowedUsers.has(username) && !session.platform.isUserAllowed(username)) {
      return;
    }

    await this.handleSessionReaction(session, postId, emojiName, username, action);
  }

  /**
   * Try to resume a timed-out session via emoji reaction on timeout post or session header.
   * Returns true if a session was resumed, false otherwise.
   */
  private async tryResumeFromReaction(platformId: string, postId: string, username: string): Promise<boolean> {
    // Find a persisted session by the post ID (timeout post or session header)
    const persistedSession = this.sessionStore.findByPostId(platformId, postId);
    if (!persistedSession) return false;

    // Check if this session is already active
    const sessionId = `${platformId}:${persistedSession.threadId}`;
    if (this.sessions.has(sessionId)) {
      if (this.debug) {
        log.debug(`Session already active for ${persistedSession.threadId.substring(0, 8)}...`);
      }
      return false;
    }

    // Check if user is allowed (defensive: handle missing sessionAllowedUsers)
    const allowedUsers = new Set(persistedSession.sessionAllowedUsers || []);
    const platform = this.platforms.get(platformId);
    if (!allowedUsers.has(username) && !platform?.isUserAllowed(username)) {
      if (platform) {
        await platform.createPost(
          `⚠️ @${username} is not authorized to resume this session`,
          persistedSession.threadId
        );
      }
      return false;
    }

    // Check max sessions limit
    if (this.sessions.size >= MAX_SESSIONS) {
      if (platform) {
        await platform.createPost(
          `⚠️ **Too busy** - ${this.sessions.size} sessions active. Please try again later.`,
          persistedSession.threadId
        );
      }
      return false;
    }

    const shortId = persistedSession.threadId.substring(0, 8);
    log.info(`🔄 Resuming session ${shortId}... via emoji reaction by @${username}`);

    // Resume the session
    await lifecycle.resumeSession(persistedSession, this.getContext());
    return true;
  }

  private async handleSessionReaction(
    session: Session,
    postId: string,
    emojiName: string,
    username: string,
    action: 'added' | 'removed'
  ): Promise<void> {
    // Most reactions only trigger on 'added', not 'removed'
    // Task toggle is an exception - it's state-based

    // Handle ❌ on worktree prompt (only on add)
    if (action === 'added' && session.worktreePromptPostId === postId && emojiName === 'x') {
      await worktreeModule.handleWorktreeSkip(
        session,
        username,
        (s) => this.persistSession(s),
        (s, q) => this.offerContextPrompt(s, q)
      );
      return;
    }

    // Handle existing worktree join prompt reactions (only on add)
    if (action === 'added' && session.pendingExistingWorktreePrompt?.postId === postId) {
      const handled = await reactions.handleExistingWorktreeReaction(
        session,
        postId,
        emojiName,
        username,
        this.getContext(),
        (tid, branchOrPath, user) => this.switchToWorktree(tid, branchOrPath, user)
      );
      if (handled) return;
    }

    // Handle context prompt reactions (only on add)
    if (action === 'added' && session.pendingContextPrompt?.postId === postId) {
      await this.handleContextPromptReaction(session, emojiName, username);
      return;
    }

    // Handle cancel/escape reactions on session start post (only on add)
    if (action === 'added' && session.sessionStartPostId === postId) {
      if (isCancelEmoji(emojiName)) {
        await commands.cancelSession(session, username, this.getContext());
        return;
      }
      if (isEscapeEmoji(emojiName)) {
        await commands.interruptSession(session, username);
        return;
      }
    }

    // Handle question reactions (only on add)
    if (action === 'added' && session.pendingQuestionSet?.currentPostId === postId) {
      await reactions.handleQuestionReaction(session, postId, emojiName, username, this.getContext());
      return;
    }

    // Handle plan approval reactions (only on add)
    if (action === 'added' && session.pendingApproval?.postId === postId) {
      await reactions.handleApprovalReaction(session, emojiName, username, this.getContext());
      return;
    }

    // Handle message approval reactions (only on add)
    if (action === 'added' && session.pendingMessageApproval?.postId === postId) {
      await reactions.handleMessageApprovalReaction(session, emojiName, username, this.getContext());
      return;
    }

    // Handle task list toggle reactions (minimize/expand) - state-based on both add and remove
    if (session.tasksPostId === postId && isTaskToggleEmoji(emojiName)) {
      await reactions.handleTaskToggleReaction(session, action, this.getContext());
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Context Prompt Handling
  // ---------------------------------------------------------------------------

  private getContextPromptHandler(): contextPrompt.ContextPromptHandler {
    return {
      registerPost: (pid, tid) => this.registerPost(pid, tid),
      startTyping: (s) => this.startTyping(s),
      persistSession: (s) => this.persistSession(s),
      injectMetadataReminder: (msg, session) => lifecycle.maybeInjectMetadataReminder(msg, session),
    };
  }

  private async handleContextPromptReaction(session: Session, emojiName: string, username: string): Promise<void> {
    await contextPrompt.handleContextPromptReaction(session, emojiName, username, this.getContextPromptHandler());
  }

  /**
   * Offer context prompt after a session restart (e.g., !cd, worktree creation).
   * If there's thread history, posts the context prompt and queues the message.
   * If no history, sends the message immediately.
   * Returns true if context prompt was posted, false if message was sent directly.
   */
  async offerContextPrompt(session: Session, queuedPrompt: string, excludePostId?: string): Promise<boolean> {
    return contextPrompt.offerContextPrompt(session, queuedPrompt, this.getContextPromptHandler(), excludePostId);
  }

  /**
   * Check if session has a pending context prompt.
   */
  hasPendingContextPrompt(threadId: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    return session?.pendingContextPrompt !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Event Handling (delegates to events module)
  // ---------------------------------------------------------------------------

  private handleEvent(sessionId: string, event: ClaudeEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    events.handleEvent(session, event, this.getContext());
  }

  // ---------------------------------------------------------------------------
  // Exit Handling (delegates to lifecycle module)
  // ---------------------------------------------------------------------------

  private async handleExit(sessionId: string, code: number): Promise<void> {
    await lifecycle.handleExit(sessionId, code, this.getContext());
  }

  // ---------------------------------------------------------------------------
  // Streaming utilities (delegates to streaming module)
  // ---------------------------------------------------------------------------

  private appendContent(session: Session, text: string): void {
    if (!text) return;
    session.pendingContent += text + '\n';
    streaming.scheduleUpdate(session, (s) => this.flush(s));
  }

  private async flush(session: Session): Promise<void> {
    await streaming.flush(session, (pid, tid) => this.registerPost(pid, tid));
  }

  private startTyping(session: Session): void {
    const wasTyping = session.typingTimer !== null;
    streaming.startTyping(session);
    // Emit UI update if typing state changed
    if (!wasTyping && session.typingTimer !== null) {
      this.emitSessionUpdate(session.sessionId, { isTyping: true });
    }
  }

  private stopTyping(session: Session): void {
    const wasTyping = session.typingTimer !== null;
    streaming.stopTyping(session);
    // Emit UI update if typing state changed
    if (wasTyping && session.typingTimer === null) {
      this.emitSessionUpdate(session.sessionId, { isTyping: false });
    }
  }

  private async buildMessageContent(
    text: string,
    platform: PlatformClient,
    files?: PlatformFile[]
  ): Promise<string | ContentBlock[]> {
    return streaming.buildMessageContent(text, platform, files, this.debug);
  }

  private async bumpTasksToBottom(session: Session): Promise<void> {
    return streaming.bumpTasksToBottom(session, (pid, tid) => this.registerPost(pid, tid));
  }

  // ---------------------------------------------------------------------------
  // Worktree utilities
  // ---------------------------------------------------------------------------

  private async shouldPromptForWorktree(session: Session): Promise<string | null> {
    return worktreeModule.shouldPromptForWorktree(
      session,
      this.worktreeMode,
      (repoRoot, excludeId) => this.hasOtherSessionInRepo(repoRoot, excludeId)
    );
  }

  private hasOtherSessionInRepo(repoRoot: string, excludeThreadId: string): boolean {
    for (const session of this.sessions.values()) {
      // Skip the session we're checking from (compare raw threadIds)
      if (session.threadId === excludeThreadId) continue;
      if (session.workingDir === repoRoot) return true;
      if (session.worktreeInfo?.repoRoot === repoRoot) return true;
    }
    return false;
  }

  private async postWorktreePrompt(session: Session, reason: string): Promise<void> {
    await worktreeModule.postWorktreePrompt(session, reason, (pid, tid) => this.registerPost(pid, tid));
    this.stopTyping(session);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private persistSession(session: Session): void {
    // Convert pendingContextPrompt to persisted form (without timeoutId)
    let persistedContextPrompt: PersistedContextPrompt | undefined;
    if (session.pendingContextPrompt) {
      persistedContextPrompt = {
        postId: session.pendingContextPrompt.postId,
        queuedPrompt: session.pendingContextPrompt.queuedPrompt,
        threadMessageCount: session.pendingContextPrompt.threadMessageCount,
        createdAt: session.pendingContextPrompt.createdAt,
        availableOptions: session.pendingContextPrompt.availableOptions,
      };
    }

    const state: PersistedSession = {
      platformId: session.platformId,
      threadId: session.threadId,
      claudeSessionId: session.claudeSessionId,
      startedBy: session.startedBy,
      startedByDisplayName: session.startedByDisplayName,
      startedAt: session.startedAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      sessionNumber: session.sessionNumber,
      workingDir: session.workingDir,
      planApproved: session.planApproved,
      sessionAllowedUsers: [...session.sessionAllowedUsers],
      forceInteractivePermissions: session.forceInteractivePermissions,
      sessionStartPostId: session.sessionStartPostId,
      tasksPostId: session.tasksPostId,
      lastTasksContent: session.lastTasksContent,
      tasksCompleted: session.tasksCompleted,
      tasksMinimized: session.tasksMinimized,
      worktreeInfo: session.worktreeInfo,
      pendingWorktreePrompt: session.pendingWorktreePrompt,
      worktreePromptDisabled: session.worktreePromptDisabled,
      queuedPrompt: session.queuedPrompt,
      firstPrompt: session.firstPrompt,
      pendingContextPrompt: persistedContextPrompt,
      needsContextPromptOnNextMessage: session.needsContextPromptOnNextMessage,
      lifecyclePostId: session.lifecyclePostId,
      sessionTitle: session.sessionTitle,
      sessionDescription: session.sessionDescription,
      pullRequestUrl: session.pullRequestUrl,
      messageCount: session.messageCount,
      resumeFailCount: session.resumeFailCount,
    };
    this.sessionStore.save(session.sessionId, state);
  }

  private unpersistSession(sessionId: string): void {
    // Soft-delete instead of hard delete - keeps session in history for display
    this.sessionStore.softDelete(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Session Header
  // ---------------------------------------------------------------------------

  private async updateSessionHeader(session: Session): Promise<void> {
    await commands.updateSessionHeader(session, this.getContext());
  }

  // ---------------------------------------------------------------------------
  // Sticky Channel Message
  // ---------------------------------------------------------------------------

  private async updateStickyMessage(): Promise<void> {
    await stickyMessage.updateAllStickyMessages(this.platforms, this.sessions, {
      maxSessions: MAX_SESSIONS,
      chromeEnabled: this.chromeEnabled,
      skipPermissions: this.skipPermissions,
      worktreeMode: this.worktreeMode,
      workingDir: this.workingDir,
      debug: this.debug,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // Initialize sticky message module with session store for persistence
    stickyMessage.initialize(this.sessionStore);

    // Clean up old sticky messages from the bot (from failed/crashed runs)
    for (const platform of this.platforms.values()) {
      try {
        const botUser = await platform.getBotUser();
        await stickyMessage.cleanupOldStickyMessages(platform, botUser.id);
      } catch (err) {
        log.warn(`Failed to cleanup old sticky messages for ${platform.platformId}: ${err}`);
      }
    }

    // Clean up stale sessions that timed out while bot was down
    // Use 2x timeout to be generous (bot might have been down for a while)
    const staleIds = this.sessionStore.cleanStale(SESSION_TIMEOUT_MS * 2);
    if (staleIds.length > 0) {
      log.info(`🧹 Soft-deleted ${staleIds.length} stale session(s) (kept for history)`);
    }

    // Permanently remove old history entries (older than 3 days by default)
    const removedCount = this.sessionStore.cleanHistory();
    if (removedCount > 0) {
      log.info(`🗑️ Permanently removed ${removedCount} old session(s) from history`);
    }

    const persisted = this.sessionStore.load();
    log.info(`📂 Loaded ${persisted.size} session(s) from persistence`);

    if (persisted.size > 0) {
      log.info(`🔄 Attempting to resume ${persisted.size} persisted session(s)...`);
      for (const state of persisted.values()) {
        await lifecycle.resumeSession(state, this.getContext());
      }
    }

    // Refresh sticky message to reflect current state (even if no sessions)
    await this.updateStickyMessage();
  }

  async startSession(
    options: { prompt: string; files?: PlatformFile[] },
    username: string,
    replyToPostId?: string,
    platformId: string = 'default',
    displayName?: string
  ): Promise<void> {
    await lifecycle.startSession(options, username, displayName, replyToPostId, platformId, this.getContext());
  }

  // Helper to find session by threadId (sessions are keyed by composite platformId:threadId)
  private findSessionByThreadId(threadId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) {
        return session;
      }
    }
    return undefined;
  }

  // Helper to find persisted session by threadId (persisted sessions are keyed by composite sessionId)
  private findPersistedByThreadId(threadId: string): PersistedSession | undefined {
    const persisted = this.sessionStore.load();
    for (const session of persisted.values()) {
      if (session.threadId === threadId) {
        return session;
      }
    }
    return undefined;
  }

  async sendFollowUp(threadId: string, message: string, files?: PlatformFile[]): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session || !session.claude.isRunning()) return;
    await lifecycle.sendFollowUp(session, message, files, this.getContext());
  }

  isSessionActive(): boolean {
    return this.sessions.size > 0;
  }

  isInSessionThread(threadRoot: string): boolean {
    const session = this.findSessionByThreadId(threadRoot);
    return session !== undefined && session.claude.isRunning();
  }

  hasPausedSession(threadId: string): boolean {
    if (this.findSessionByThreadId(threadId)) return false;
    return this.findPersistedByThreadId(threadId) !== undefined;
  }

  async resumePausedSession(threadId: string, message: string, files?: PlatformFile[]): Promise<void> {
    await lifecycle.resumePausedSession(threadId, message, files, this.getContext());
  }

  getPersistedSession(threadId: string): PersistedSession | undefined {
    return this.findPersistedByThreadId(threadId);
  }

  async killSession(threadId: string, unpersist = true): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await lifecycle.killSession(session, unpersist, this.getContext());
  }

  async killAllSessions(): Promise<void> {
    await lifecycle.killAllSessions(this.getContext());
  }

  // Commands
  async cancelSession(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.cancelSession(session, username, this.getContext());
  }

  async interruptSession(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.interruptSession(session, username);
  }

  async changeDirectory(threadId: string, newDir: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.changeDirectory(session, newDir, username, this.getContext());
  }

  async inviteUser(threadId: string, invitedUser: string, invitedBy: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.inviteUser(session, invitedUser, invitedBy, this.getContext());
  }

  async kickUser(threadId: string, kickedUser: string, kickedBy: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.kickUser(session, kickedUser, kickedBy, this.getContext());
  }

  async enableInteractivePermissions(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.enableInteractivePermissions(session, username, this.getContext());
  }

  isSessionInteractive(threadId: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return !this.skipPermissions;
    if (!this.skipPermissions) return true;
    return session.forceInteractivePermissions;
  }

  async requestMessageApproval(threadId: string, username: string, message: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.requestMessageApproval(session, username, message, this.getContext());
  }

  // Worktree commands
  async handleWorktreeBranchResponse(threadId: string, branchName: string, username: string, responsePostId: string): Promise<boolean> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return false;
    return worktreeModule.handleWorktreeBranchResponse(
      session,
      branchName,
      username,
      responsePostId,
      (tid, branch, user) => this.createAndSwitchToWorktree(tid, branch, user)
    );
  }

  async handleWorktreeSkip(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.handleWorktreeSkip(
      session,
      username,
      (s) => this.persistSession(s),
      (s, q) => this.offerContextPrompt(s, q)
    );
  }

  async createAndSwitchToWorktree(threadId: string, branch: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.createAndSwitchToWorktree(session, branch, username, {
      skipPermissions: this.skipPermissions,
      chromeEnabled: this.chromeEnabled,
      handleEvent: (tid, e) => this.handleEvent(tid, e),
      handleExit: (tid, code) => this.handleExit(tid, code),
      updateSessionHeader: (s) => this.updateSessionHeader(s),
      flush: (s) => this.flush(s),
      persistSession: (s) => this.persistSession(s),
      startTyping: (s) => this.startTyping(s),
      stopTyping: (s) => this.stopTyping(s),
      offerContextPrompt: (s, q, e) => this.offerContextPrompt(s, q, e),
      appendSystemPrompt: CHAT_PLATFORM_PROMPT,
      registerPost: (postId, tid) => this.registerPost(postId, tid),
      updateStickyMessage: () => this.updateStickyMessage(),
    });
  }

  async switchToWorktree(threadId: string, branchOrPath: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.switchToWorktree(
      session,
      branchOrPath,
      username,
      (tid, dir, user) => this.changeDirectory(tid, dir, user)
    );
  }

  async listWorktreesCommand(threadId: string, _username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.listWorktreesCommand(session);
  }

  async removeWorktreeCommand(threadId: string, branchOrPath: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.removeWorktreeCommand(session, branchOrPath, username);
  }

  async disableWorktreePrompt(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.disableWorktreePrompt(session, username, (s) => this.persistSession(s));
  }

  hasPendingWorktreePrompt(threadId: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    return session?.pendingWorktreePrompt === true;
  }

  // Missing public methods needed by index.ts
  getActiveThreadIds(): string[] {
    // Return raw threadIds (not composite sessionIds) for posting to chat
    return [...this.sessions.values()].map(s => s.threadId);
  }

  /**
   * Post shutdown messages to all active sessions and persist the post IDs.
   * This allows the resume to update the same post instead of creating a new one.
   */
  async postShutdownMessages(): Promise<void> {
    const shutdownMessage = `⏸️ **Bot shutting down** - session will resume on restart`;

    for (const session of this.sessions.values()) {
      try {
        if (session.lifecyclePostId) {
          // Update existing timeout/warning post
          await session.platform.updatePost(session.lifecyclePostId, shutdownMessage);
        } else {
          // Create new shutdown post and store the ID
          const post = await session.platform.createPost(shutdownMessage, session.threadId);
          session.lifecyclePostId = post.id;
        }
        // Persist so resume can find the post ID
        this.persistSession(session);
      } catch {
        // Ignore errors, we're shutting down
      }
    }
  }

  killAllSessionsAndUnpersist(): void {
    for (const session of this.sessions.values()) {
      this.stopTyping(session);
      session.claude.kill();
      this.unpersistSession(session.sessionId);
    }
    this.sessions.clear();
    this.postIndex.clear();
  }

  isUserAllowedInSession(threadId: string, username: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    if (!session) {
      // Check persisted session
      const persisted = this.getPersistedSession(threadId);
      if (persisted) {
        // Defensive: handle missing sessionAllowedUsers (old persisted data)
        return (persisted.sessionAllowedUsers || []).includes(username) ||
               this.platforms.get(persisted.platformId)?.isUserAllowed(username) || false;
      }
      return false;
    }
    return session.sessionAllowedUsers.has(username) || session.platform.isUserAllowed(username);
  }

  async startSessionWithWorktree(
    options: { prompt: string; files?: PlatformFile[] },
    branch: string,
    username: string,
    replyToPostId?: string,
    platformId: string = 'default',
    displayName?: string
  ): Promise<void> {
    // Start normal session first
    await this.startSession(options, username, replyToPostId, platformId, displayName);

    // Then switch to worktree
    const threadId = replyToPostId || '';
    const session = this.sessions.get(this.getSessionId(platformId, threadId));
    if (session) {
      await this.createAndSwitchToWorktree(session.threadId, branch, username);
    }
  }

  setShuttingDown(): void {
    this.isShuttingDown = true;
  }

  // Shutdown
  async shutdown(message?: string): Promise<void> {
    this.isShuttingDown = true;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Post shutdown message to all active sessions
    if (message) {
      for (const session of this.sessions.values()) {
        try {
          await postInfo(session, message);
        } catch {
          // Ignore
        }
      }
    }

    // Persist and kill all sessions for later resume
    for (const session of this.sessions.values()) {
      this.stopTyping(session);
      this.persistSession(session);
      session.claude.kill();
    }
    this.sessions.clear();
    this.postIndex.clear();
  }
}
