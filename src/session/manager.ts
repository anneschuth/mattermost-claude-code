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

import { ClaudeEvent, ContentBlock } from '../claude/cli.js';
import type { PlatformClient, PlatformUser, PlatformPost, PlatformFile } from '../platform/index.js';
import { SessionStore, PersistedSession } from '../persistence/session-store.js';
import { WorktreeMode } from '../config.js';
import {
  isCancelEmoji,
  isEscapeEmoji,
} from '../utils/emoji.js';

// Import extracted modules
import * as streaming from './streaming.js';
import * as events from './events.js';
import * as reactions from './reactions.js';
import * as commands from './commands.js';
import * as lifecycle from './lifecycle.js';
import * as worktreeModule from './worktree.js';
import type { Session } from './types.js';

// Import constants for internal use
import { MAX_SESSIONS, SESSION_TIMEOUT_MS, SESSION_WARNING_MS } from './types.js';

/**
 * SessionManager - Main orchestrator for Claude Code sessions
 */
export class SessionManager {
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
    this.workingDir = workingDir;
    this.skipPermissions = skipPermissions;
    this.chromeEnabled = chromeEnabled;
    this.worktreeMode = worktreeMode;

    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => {
      lifecycle.cleanupIdleSessions(SESSION_TIMEOUT_MS, SESSION_WARNING_MS, this.getLifecycleContext());
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
        this.handleReaction(platformId, reaction.postId, reaction.emojiName, user.username);
      }
    });
    console.log(`  📡 Platform "${platformId}" registered`);
  }

  removePlatform(platformId: string): void {
    this.platforms.delete(platformId);
  }

  // ---------------------------------------------------------------------------
  // Context Builders (for module delegation)
  // ---------------------------------------------------------------------------

  private getLifecycleContext(): lifecycle.LifecycleContext {
    return {
      workingDir: this.workingDir,
      skipPermissions: this.skipPermissions,
      chromeEnabled: this.chromeEnabled,
      debug: this.debug,
      maxSessions: MAX_SESSIONS,
      sessions: this.sessions,
      postIndex: this.postIndex,
      platforms: this.platforms,
      sessionStore: this.sessionStore,
      isShuttingDown: this.isShuttingDown,
      getSessionId: (pid, tid) => this.getSessionId(pid, tid),
      findSessionByThreadId: (tid) => this.findSessionByThreadId(tid),
      handleEvent: (sid, e) => this.handleEvent(sid, e),
      handleExit: (sid, code) => this.handleExit(sid, code),
      registerPost: (pid, tid) => this.registerPost(pid, tid),
      startTyping: (s) => this.startTyping(s),
      stopTyping: (s) => this.stopTyping(s),
      flush: (s) => this.flush(s),
      persistSession: (s) => this.persistSession(s),
      unpersistSession: (sid) => this.unpersistSession(sid),
      updateSessionHeader: (s) => this.updateSessionHeader(s),
      shouldPromptForWorktree: (s) => this.shouldPromptForWorktree(s),
      postWorktreePrompt: (s, r) => this.postWorktreePrompt(s, r),
      buildMessageContent: (t, p, f) => this.buildMessageContent(t, p, f),
    };
  }

  private getEventContext(): events.EventContext {
    return {
      debug: this.debug,
      registerPost: (pid, tid) => this.registerPost(pid, tid),
      flush: (s) => this.flush(s),
      startTyping: (s) => this.startTyping(s),
      stopTyping: (s) => this.stopTyping(s),
      appendContent: (s, t) => this.appendContent(s, t),
    };
  }

  private getReactionContext(): reactions.ReactionContext {
    return {
      debug: this.debug,
      startTyping: (s) => this.startTyping(s),
      stopTyping: (s) => this.stopTyping(s),
      updateSessionHeader: (s) => this.updateSessionHeader(s),
    };
  }

  private getCommandContext(): commands.CommandContext {
    return {
      skipPermissions: this.skipPermissions,
      chromeEnabled: this.chromeEnabled,
      maxSessions: MAX_SESSIONS,
      handleEvent: (tid, e) => this.handleEvent(tid, e),
      handleExit: (tid, code) => this.handleExit(tid, code),
      flush: (s) => this.flush(s),
      startTyping: (s) => this.startTyping(s),
      stopTyping: (s) => this.stopTyping(s),
      persistSession: (s) => this.persistSession(s),
      killSession: (tid) => this.killSession(tid),
      registerPost: (pid, tid) => this.registerPost(pid, tid),
    };
  }

  // ---------------------------------------------------------------------------
  // Session ID and Post Index
  // ---------------------------------------------------------------------------

  private getSessionId(platformId: string, threadId: string): string {
    return `${platformId}:${threadId}`;
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

  private async handleReaction(platformId: string, postId: string, emojiName: string, username: string): Promise<void> {
    const session = this.getSessionByPost(postId);
    if (!session) return;

    // Verify this reaction is from the same platform
    if (session.platformId !== platformId) return;

    // Only process reactions from allowed users
    if (!session.sessionAllowedUsers.has(username) && !session.platform.isUserAllowed(username)) {
      return;
    }

    await this.handleSessionReaction(session, postId, emojiName, username);
  }

  private async handleSessionReaction(session: Session, postId: string, emojiName: string, username: string): Promise<void> {
    // Handle ❌ on worktree prompt
    if (session.worktreePromptPostId === postId && emojiName === 'x') {
      await worktreeModule.handleWorktreeSkip(
        session,
        username,
        (s) => this.persistSession(s),
        (s) => this.startTyping(s)
      );
      return;
    }

    // Handle cancel/escape reactions on session start post
    if (session.sessionStartPostId === postId) {
      if (isCancelEmoji(emojiName)) {
        await commands.cancelSession(session, username, this.getCommandContext());
        return;
      }
      if (isEscapeEmoji(emojiName)) {
        await commands.interruptSession(session, username);
        return;
      }
    }

    // Handle question reactions
    if (session.pendingQuestionSet?.currentPostId === postId) {
      await reactions.handleQuestionReaction(session, postId, emojiName, username, this.getReactionContext());
      return;
    }

    // Handle plan approval reactions
    if (session.pendingApproval?.postId === postId) {
      await reactions.handleApprovalReaction(session, emojiName, username, this.getReactionContext());
      return;
    }

    // Handle message approval reactions
    if (session.pendingMessageApproval?.postId === postId) {
      await reactions.handleMessageApprovalReaction(session, emojiName, username, this.getReactionContext());
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Event Handling (delegates to events module)
  // ---------------------------------------------------------------------------

  private handleEvent(sessionId: string, event: ClaudeEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    events.handleEvent(session, event, this.getEventContext());
  }

  // ---------------------------------------------------------------------------
  // Exit Handling (delegates to lifecycle module)
  // ---------------------------------------------------------------------------

  private async handleExit(sessionId: string, code: number): Promise<void> {
    await lifecycle.handleExit(sessionId, code, this.getLifecycleContext());
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
    streaming.startTyping(session);
  }

  private stopTyping(session: Session): void {
    streaming.stopTyping(session);
  }

  private async buildMessageContent(
    text: string,
    platform: PlatformClient,
    files?: PlatformFile[]
  ): Promise<string | ContentBlock[]> {
    return streaming.buildMessageContent(text, platform, files, this.debug);
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
    const state: PersistedSession = {
      platformId: session.platformId,
      threadId: session.threadId,
      claudeSessionId: session.claudeSessionId,
      startedBy: session.startedBy,
      startedAt: session.startedAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      sessionNumber: session.sessionNumber,
      workingDir: session.workingDir,
      planApproved: session.planApproved,
      sessionAllowedUsers: [...session.sessionAllowedUsers],
      forceInteractivePermissions: session.forceInteractivePermissions,
      sessionStartPostId: session.sessionStartPostId,
      tasksPostId: session.tasksPostId,
      worktreeInfo: session.worktreeInfo,
      pendingWorktreePrompt: session.pendingWorktreePrompt,
      worktreePromptDisabled: session.worktreePromptDisabled,
      queuedPrompt: session.queuedPrompt,
    };
    this.sessionStore.save(session.sessionId, state);
  }

  private unpersistSession(sessionId: string): void {
    this.sessionStore.remove(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Session Header
  // ---------------------------------------------------------------------------

  private async updateSessionHeader(session: Session): Promise<void> {
    await commands.updateSessionHeader(session, this.getCommandContext());
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    const persisted = this.sessionStore.load();
    if (persisted.size === 0) return;

    console.log(`  🔄 Found ${persisted.size} persisted session(s), attempting resume...`);
    for (const state of persisted.values()) {
      await lifecycle.resumeSession(state, this.getLifecycleContext());
    }
  }

  async startSession(
    options: { prompt: string; files?: PlatformFile[] },
    username: string,
    replyToPostId?: string,
    platformId: string = 'default'
  ): Promise<void> {
    await lifecycle.startSession(options, username, replyToPostId, platformId, this.getLifecycleContext());
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
    await lifecycle.sendFollowUp(session, message, files, this.getLifecycleContext());
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
    await lifecycle.resumePausedSession(threadId, message, files, this.getLifecycleContext());
  }

  getPersistedSession(threadId: string): PersistedSession | undefined {
    return this.findPersistedByThreadId(threadId);
  }

  killSession(threadId: string, unpersist = true): void {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    lifecycle.killSession(session, unpersist, this.getLifecycleContext());
  }

  killAllSessions(): void {
    lifecycle.killAllSessions(this.getLifecycleContext());
  }

  // Commands
  async cancelSession(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.cancelSession(session, username, this.getCommandContext());
  }

  async interruptSession(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.interruptSession(session, username);
  }

  async changeDirectory(threadId: string, newDir: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.changeDirectory(session, newDir, username, this.getCommandContext());
  }

  async inviteUser(threadId: string, invitedUser: string, invitedBy: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.inviteUser(session, invitedUser, invitedBy, this.getCommandContext());
  }

  async kickUser(threadId: string, kickedUser: string, kickedBy: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.kickUser(session, kickedUser, kickedBy, this.getCommandContext());
  }

  async enableInteractivePermissions(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.enableInteractivePermissions(session, username, this.getCommandContext());
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
    await commands.requestMessageApproval(session, username, message, this.getCommandContext());
  }

  // Worktree commands
  async handleWorktreeBranchResponse(threadId: string, branchName: string, username: string): Promise<boolean> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return false;
    return worktreeModule.handleWorktreeBranchResponse(
      session,
      branchName,
      username,
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
      (s) => this.startTyping(s)
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
        return persisted.sessionAllowedUsers.includes(username) ||
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
    platformId: string = 'default'
  ): Promise<void> {
    // Start normal session first
    await this.startSession(options, username, replyToPostId, platformId);

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
          await session.platform.createPost(message, session.threadId);
        } catch {
          // Ignore
        }
      }
    }

    // Kill all sessions but preserve persistence
    for (const session of this.sessions.values()) {
      this.stopTyping(session);
      session.claude.kill();
    }
    this.sessions.clear();
    this.postIndex.clear();
  }
}
