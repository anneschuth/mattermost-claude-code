import { ClaudeCli, ClaudeEvent, ClaudeCliOptions, ContentBlock } from './cli.js';
import { MattermostClient } from '../mattermost/client.js';
import { MattermostFile } from '../mattermost/types.js';
import {
  isApprovalEmoji,
  isDenialEmoji,
  isAllowAllEmoji,
  isCancelEmoji,
  isEscapeEmoji,
  getNumberEmojiIndex,
  NUMBER_EMOJIS,
  APPROVAL_EMOJIS,
  DENIAL_EMOJIS,
  ALLOW_ALL_EMOJIS,
} from '../mattermost/emoji.js';
import { formatToolUse as sharedFormatToolUse } from '../utils/tool-formatter.js';
import { getUpdateInfo } from '../update-notifier.js';
import { getReleaseNotes, getWhatsNewSummary } from '../changelog.js';
import { SessionStore, PersistedSession, WorktreeInfo } from '../persistence/session-store.js';
import { getMattermostLogo } from '../logo.js';
import { WorktreeMode } from '../config.js';
import {
  isGitRepository,
  getRepositoryRoot,
  hasUncommittedChanges,
  listWorktrees,
  createWorktree,
  removeWorktree as removeGitWorktree,
  getWorktreeDir,
  findWorktreeByBranch,
  isValidBranchName,
} from '../git/worktree.js';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf-8'));

// =============================================================================
// Interfaces
// =============================================================================

interface QuestionOption {
  label: string;
  description: string;
}

interface PendingQuestionSet {
  toolUseId: string;
  currentIndex: number;
  currentPostId: string | null;
  questions: Array<{
    header: string;
    question: string;
    options: QuestionOption[];
    answer: string | null;
  }>;
}

interface PendingApproval {
  postId: string;
  type: 'plan' | 'action';
  toolUseId: string;
}

/**
 * Pending message from unauthorized user awaiting approval
 */
interface PendingMessageApproval {
  postId: string;
  originalMessage: string;
  fromUser: string;
}

/**
 * Represents a single Claude Code session tied to a Mattermost thread.
 * Each session has its own Claude CLI process and state.
 */
interface Session {
  // Identity
  threadId: string;
  claudeSessionId: string;  // UUID for --session-id / --resume
  startedBy: string;
  startedAt: Date;
  lastActivityAt: Date;
  sessionNumber: number;  // Session # when created

  // Working directory (can be changed per-session)
  workingDir: string;

  // Claude process
  claude: ClaudeCli;

  // Post state for streaming updates
  currentPostId: string | null;
  pendingContent: string;

  // Interactive state
  pendingApproval: PendingApproval | null;
  pendingQuestionSet: PendingQuestionSet | null;
  pendingMessageApproval: PendingMessageApproval | null;
  planApproved: boolean;

  // Collaboration - per-session allowlist
  sessionAllowedUsers: Set<string>;

  // Permission override - can only downgrade (skip → interactive), not upgrade
  forceInteractivePermissions: boolean;

  // Display state
  sessionStartPostId: string | null;  // The header post we update with participants
  tasksPostId: string | null;
  activeSubagents: Map<string, string>;  // toolUseId -> postId

  // Timers (per-session)
  updateTimer: ReturnType<typeof setTimeout> | null;
  typingTimer: ReturnType<typeof setInterval> | null;

  // Timeout warning state
  timeoutWarningPosted: boolean;

  // Flag to suppress exit message during intentional restart (e.g., !cd)
  isRestarting: boolean;

  // Flag to track if this session was resumed after bot restart
  isResumed: boolean;

  // Flag to track if session was interrupted (SIGINT sent) - don't unpersist on exit
  wasInterrupted: boolean;

  // Task timing - when the current in_progress task started
  inProgressTaskStart: number | null;

  // Tool timing - track when tools started for elapsed time display
  activeToolStarts: Map<string, number>;  // toolUseId -> start timestamp

  // Worktree support
  worktreeInfo?: WorktreeInfo;              // Active worktree info
  pendingWorktreePrompt?: boolean;          // Waiting for branch name response
  worktreePromptDisabled?: boolean;         // User opted out with !worktree off
  queuedPrompt?: string;                    // User's original message when waiting for worktree response
  worktreePromptPostId?: string;            // Post ID of the worktree prompt (for ❌ reaction)
}


// =============================================================================
// Configuration
// =============================================================================

const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '5', 10);
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || '1800000', 10); // 30 min
const SESSION_WARNING_MS = 5 * 60 * 1000; // Warn 5 minutes before timeout

// =============================================================================
// SessionManager - Manages multiple concurrent Claude Code sessions
// =============================================================================

export class SessionManager {
  // Shared state
  private mattermost: MattermostClient;
  private workingDir: string;
  private skipPermissions: boolean;
  private chromeEnabled: boolean;
  private worktreeMode: WorktreeMode;
  private debug = process.env.DEBUG === '1' || process.argv.includes('--debug');

  // Multi-session storage
  private sessions: Map<string, Session> = new Map();  // threadId -> Session
  private postIndex: Map<string, string> = new Map();  // postId -> threadId (for reaction routing)

  // Persistence
  private sessionStore: SessionStore = new SessionStore();

  // Cleanup timer
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Shutdown flag to suppress exit messages during graceful shutdown
  private isShuttingDown = false;

  constructor(mattermost: MattermostClient, workingDir: string, skipPermissions = false, chromeEnabled = false, worktreeMode: WorktreeMode = 'prompt') {
    this.mattermost = mattermost;
    this.workingDir = workingDir;
    this.skipPermissions = skipPermissions;
    this.chromeEnabled = chromeEnabled;
    this.worktreeMode = worktreeMode;

    // Listen for reactions to answer questions
    this.mattermost.on('reaction', async (reaction, user) => {
      try {
        await this.handleReaction(reaction.post_id, reaction.emoji_name, user?.username || 'unknown');
      } catch (err) {
        console.error('  ❌ Error handling reaction:', err);
      }
    });

    // Start periodic cleanup of idle sessions
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 60000);
  }

  // ---------------------------------------------------------------------------
  // Session Initialization (Resume)
  // ---------------------------------------------------------------------------

  /**
   * Initialize session manager by resuming any persisted sessions.
   * Should be called before starting to listen for new messages.
   */
  async initialize(): Promise<void> {
    // Load persisted sessions FIRST (before cleaning stale ones)
    // This way we can resume sessions that were active when the bot stopped,
    // even if the bot was down for longer than SESSION_TIMEOUT_MS
    const persisted = this.sessionStore.load();

    if (this.debug) {
      console.log(`  [persist] Found ${persisted.size} persisted session(s)`);
      for (const [threadId, state] of persisted) {
        const age = Date.now() - new Date(state.lastActivityAt).getTime();
        const ageMins = Math.round(age / 60000);
        console.log(`  [persist] - ${threadId.substring(0, 8)}... by @${state.startedBy}, age: ${ageMins}m`);
      }
    }

    // Note: We intentionally do NOT clean stale sessions on startup anymore.
    // Sessions are cleaned during normal operation by cleanupIdleSessions().
    // This allows sessions to survive bot restarts even if the bot was down
    // for longer than SESSION_TIMEOUT_MS.
    if (persisted.size === 0) {
      if (this.debug) console.log('  [resume] No sessions to resume');
      return;
    }

    console.log(`  📂 Found ${persisted.size} session(s) to resume...`);

    // Resume each session
    for (const [_threadId, state] of persisted) {
      await this.resumeSession(state);
    }

    console.log(`  ✅ Resumed ${this.sessions.size} session(s)`);
  }

  /**
   * Resume a single session from persisted state
   */
  private async resumeSession(state: PersistedSession): Promise<void> {
    const shortId = state.threadId.substring(0, 8);

    // Verify thread still exists
    const post = await this.mattermost.getPost(state.threadId);
    if (!post) {
      console.log(`  ⚠️ Thread ${shortId}... deleted, skipping resume`);
      this.sessionStore.remove(state.threadId);
      return;
    }

    // Check max sessions limit
    if (this.sessions.size >= MAX_SESSIONS) {
      console.log(`  ⚠️ Max sessions reached, skipping resume for ${shortId}...`);
      return;
    }

    // Create Claude CLI with resume flag
    const skipPerms = this.skipPermissions && !state.forceInteractivePermissions;
    const cliOptions: ClaudeCliOptions = {
      workingDir: state.workingDir,
      threadId: state.threadId,
      skipPermissions: skipPerms,
      sessionId: state.claudeSessionId,
      resume: true,
      chrome: this.chromeEnabled,
    };
    const claude = new ClaudeCli(cliOptions);

    // Rebuild Session object from persisted state
    const session: Session = {
      threadId: state.threadId,
      claudeSessionId: state.claudeSessionId,
      startedBy: state.startedBy,
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
      activeSubagents: new Map(),
      updateTimer: null,
      typingTimer: null,
      timeoutWarningPosted: false,
      isRestarting: false,
      isResumed: true,
      wasInterrupted: false,
      inProgressTaskStart: null,
      activeToolStarts: new Map(),
      // Worktree state from persistence
      worktreeInfo: state.worktreeInfo,
      pendingWorktreePrompt: state.pendingWorktreePrompt,
      worktreePromptDisabled: state.worktreePromptDisabled,
      queuedPrompt: state.queuedPrompt,
    };

    // Register session
    this.sessions.set(state.threadId, session);
    if (state.sessionStartPostId) {
      this.registerPost(state.sessionStartPostId, state.threadId);
    }

    // Bind event handlers
    claude.on('event', (e: ClaudeEvent) => this.handleEvent(state.threadId, e));
    claude.on('exit', (code: number) => this.handleExit(state.threadId, code));

    try {
      claude.start();
      console.log(`  🔄 Resumed session ${shortId}... (@${state.startedBy})`);

      // Post resume message
      await this.mattermost.createPost(
        `🔄 **Session resumed** after bot restart (v${pkg.version})\n*Reconnected to Claude session. You can continue where you left off.*`,
        state.threadId
      );

      // Update session header
      await this.updateSessionHeader(session);

      // Update persistence with new activity time
      this.persistSession(session);
    } catch (err) {
      console.error(`  ❌ Failed to resume session ${shortId}...:`, err);
      this.sessions.delete(state.threadId);
      this.sessionStore.remove(state.threadId);

      // Try to notify user
      try {
        await this.mattermost.createPost(
          `⚠️ **Could not resume previous session.** Starting fresh.\n*Your previous conversation context is preserved, but Claude needs to re-read it.*`,
          state.threadId
        );
      } catch {
        // Ignore if we can't post
      }
    }
  }

  /**
   * Persist a session to disk
   */
  private persistSession(session: Session): void {
    const shortId = session.threadId.substring(0, 8);
    console.log(`  [persist] Saving session ${shortId}...`);
    const state: PersistedSession = {
      threadId: session.threadId,
      claudeSessionId: session.claudeSessionId,
      startedBy: session.startedBy,
      startedAt: session.startedAt.toISOString(),
      sessionNumber: session.sessionNumber,
      workingDir: session.workingDir,
      sessionAllowedUsers: [...session.sessionAllowedUsers],
      forceInteractivePermissions: session.forceInteractivePermissions,
      sessionStartPostId: session.sessionStartPostId,
      tasksPostId: session.tasksPostId,
      lastActivityAt: session.lastActivityAt.toISOString(),
      planApproved: session.planApproved,
      // Worktree state
      worktreeInfo: session.worktreeInfo,
      pendingWorktreePrompt: session.pendingWorktreePrompt,
      worktreePromptDisabled: session.worktreePromptDisabled,
      queuedPrompt: session.queuedPrompt,
    };
    this.sessionStore.save(session.threadId, state);
    console.log(`  [persist] Saved session ${shortId}... (claudeId: ${session.claudeSessionId.substring(0, 8)}...)`);
  }

  /**
   * Remove a session from persistence
   */
  private unpersistSession(threadId: string): void {
    const shortId = threadId.substring(0, 8);
    console.log(`  [persist] REMOVING session ${shortId}... (this should NOT happen during shutdown!)`);
    this.sessionStore.remove(threadId);
  }

  // ---------------------------------------------------------------------------
  // Session Lookup Methods
  // ---------------------------------------------------------------------------

  /** Get a session by thread ID */
  getSession(threadId: string): Session | undefined {
    return this.sessions.get(threadId);
  }

  /** Check if a session exists for this thread */
  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  /** Get the number of active sessions */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /** Get all active session thread IDs */
  getActiveThreadIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Mark that we're shutting down (prevents cleanup of persisted sessions) */
  setShuttingDown(): void {
    console.log('  [shutdown] Setting isShuttingDown = true');
    this.isShuttingDown = true;
  }

  /** Register a post for reaction routing */
  private registerPost(postId: string, threadId: string): void {
    this.postIndex.set(postId, threadId);
  }

  /** Find session by post ID (for reaction routing) */
  private getSessionByPost(postId: string): Session | undefined {
    const threadId = this.postIndex.get(postId);
    return threadId ? this.sessions.get(threadId) : undefined;
  }

  /**
   * Check if a user is allowed in a specific session.
   * Checks global allowlist first, then session-specific allowlist.
   */
  isUserAllowedInSession(threadId: string, username: string): boolean {
    // Check global allowlist first
    if (this.mattermost.isUserAllowed(username)) return true;

    // Check session-specific allowlist
    const session = this.sessions.get(threadId);
    if (session?.sessionAllowedUsers.has(username)) return true;

    return false;
  }

  // ---------------------------------------------------------------------------
  // Session Lifecycle
  // ---------------------------------------------------------------------------

  async startSession(
    options: { prompt: string; files?: MattermostFile[] },
    username: string,
    replyToPostId?: string
  ): Promise<void> {
    const threadId = replyToPostId || '';

    // Check if session already exists for this thread
    const existingSession = this.sessions.get(threadId);
    if (existingSession && existingSession.claude.isRunning()) {
      // Send as follow-up instead
      await this.sendFollowUp(threadId, options.prompt, options.files);
      return;
    }

    // Check max sessions limit
    if (this.sessions.size >= MAX_SESSIONS) {
      await this.mattermost.createPost(
        `⚠️ **Too busy** - ${this.sessions.size} sessions active. Please try again later.`,
        replyToPostId
      );
      return;
    }

    // Post initial session message (will be updated by updateSessionHeader)
    let post;
    try {
      post = await this.mattermost.createPost(
        `${getMattermostLogo(pkg.version)}\n\n*Starting session...*`,
        replyToPostId
      );
    } catch (err) {
      console.error(`  ❌ Failed to create session post:`, err);
      // If we can't post to the thread, we can't start a session
      return;
    }
    const actualThreadId = replyToPostId || post.id;

    // Generate a unique session ID for this Claude session
    const claudeSessionId = randomUUID();

    // Create Claude CLI with options
    const cliOptions: ClaudeCliOptions = {
      workingDir: this.workingDir,
      threadId: actualThreadId,
      skipPermissions: this.skipPermissions,
      sessionId: claudeSessionId,
      resume: false,
      chrome: this.chromeEnabled,
    };
    const claude = new ClaudeCli(cliOptions);

    // Create the session object
    const session: Session = {
      threadId: actualThreadId,
      claudeSessionId,
      startedBy: username,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      sessionNumber: this.sessions.size + 1,
      workingDir: this.workingDir,
      claude,
      currentPostId: null,
      pendingContent: '',
      pendingApproval: null,
      pendingQuestionSet: null,
      pendingMessageApproval: null,
      planApproved: false,
      sessionAllowedUsers: new Set([username]), // Owner is always allowed
      forceInteractivePermissions: false,  // Can be enabled via /permissions interactive
      sessionStartPostId: post.id,  // Track for updating participants
      tasksPostId: null,
      activeSubagents: new Map(),
      updateTimer: null,
      typingTimer: null,
      timeoutWarningPosted: false,
      isRestarting: false,
      isResumed: false,
      wasInterrupted: false,
      inProgressTaskStart: null,
      activeToolStarts: new Map(),
    };

    // Register session
    this.sessions.set(actualThreadId, session);
    this.registerPost(post.id, actualThreadId); // For cancel reactions on session start post
    const shortId = actualThreadId.substring(0, 8);
    console.log(`  ▶ Session #${this.sessions.size} started (${shortId}…) by @${username}`);

    // Update the header with full session info
    await this.updateSessionHeader(session);

    // Start typing indicator immediately so user sees activity
    this.startTyping(session);

    // Bind event handlers with closure over threadId
    claude.on('event', (e: ClaudeEvent) => this.handleEvent(actualThreadId, e));
    claude.on('exit', (code: number) => this.handleExit(actualThreadId, code));

    try {
      claude.start();
    } catch (err) {
      console.error('  ❌ Failed to start Claude:', err);
      this.stopTyping(session);
      await this.mattermost.createPost(`❌ ${err}`, actualThreadId);
      this.sessions.delete(actualThreadId);
      return;
    }

    // Check if we should prompt for worktree
    const shouldPrompt = await this.shouldPromptForWorktree(session);
    if (shouldPrompt) {
      // Queue the original message and prompt for branch name
      session.queuedPrompt = options.prompt;
      session.pendingWorktreePrompt = true;
      await this.postWorktreePrompt(session, shouldPrompt);
      // Persist session with pending state
      this.persistSession(session);
      return; // Don't send message to Claude yet
    }

    // Send the message to Claude (with images if present)
    const content = await this.buildMessageContent(options.prompt, options.files);
    claude.sendMessage(content);

    // Persist session for resume after restart
    this.persistSession(session);
  }

  /**
   * Start a session with an initial worktree specified.
   * Used when user specifies "on branch X" or "!worktree X" in their initial message.
   */
  async startSessionWithWorktree(
    options: { prompt: string; files?: MattermostFile[] },
    branch: string,
    username: string,
    replyToPostId?: string
  ): Promise<void> {
    // Start the session normally first
    await this.startSession(options, username, replyToPostId);

    // Get the thread ID
    const threadId = replyToPostId || '';
    const session = this.sessions.get(threadId);
    if (!session) return;

    // If session has a pending worktree prompt (from startSession), skip it
    if (session.pendingWorktreePrompt) {
      session.pendingWorktreePrompt = false;
      if (session.worktreePromptPostId) {
        try {
          await this.mattermost.updatePost(session.worktreePromptPostId,
            `✅ Using branch \`${branch}\` (specified in message)`);
        } catch (err) {
          console.error('  ⚠️ Failed to update worktree prompt:', err);
        }
        session.worktreePromptPostId = undefined;
      }
    }

    // Create the worktree
    await this.createAndSwitchToWorktree(threadId, branch, username);
  }

  /**
   * Check if we should prompt for a worktree before starting work.
   * Returns the reason string if we should prompt, or null if not.
   */
  private async shouldPromptForWorktree(session: Session): Promise<string | null> {
    // Skip if worktree mode is off
    if (this.worktreeMode === 'off') return null;

    // Skip if user disabled prompts for this session
    if (session.worktreePromptDisabled) return null;

    // Skip if already in a worktree
    if (session.worktreeInfo) return null;

    // Check if we're in a git repository
    const isRepo = await isGitRepository(session.workingDir);
    if (!isRepo) return null;

    // For 'require' mode, always prompt
    if (this.worktreeMode === 'require') {
      return 'require';
    }

    // For 'prompt' mode, check conditions
    // Condition 1: uncommitted changes
    const hasChanges = await hasUncommittedChanges(session.workingDir);
    if (hasChanges) return 'uncommitted';

    // Condition 2: another session using the same repo
    const repoRoot = await getRepositoryRoot(session.workingDir);
    const hasConcurrent = this.hasOtherSessionInRepo(repoRoot, session.threadId);
    if (hasConcurrent) return 'concurrent';

    return null;
  }

  /**
   * Check if another session is using the same repository
   */
  private hasOtherSessionInRepo(repoRoot: string, excludeThreadId: string): boolean {
    for (const [threadId, session] of this.sessions) {
      if (threadId === excludeThreadId) continue;
      // Check if session's working directory is in the same repo
      // (either the repo root or a worktree of the same repo)
      if (session.workingDir === repoRoot) return true;
      if (session.worktreeInfo?.repoRoot === repoRoot) return true;
    }
    return false;
  }

  /**
   * Post the worktree prompt message
   */
  private async postWorktreePrompt(session: Session, reason: string): Promise<void> {
    let message: string;
    switch (reason) {
      case 'uncommitted':
        message = `🌿 **This repo has uncommitted changes.**\n` +
          `Reply with a branch name to work in an isolated worktree, or react with ❌ to continue in the main repo.`;
        break;
      case 'concurrent':
        message = `⚠️ **Another session is already using this repo.**\n` +
          `Reply with a branch name to work in an isolated worktree, or react with ❌ to continue anyway.`;
        break;
      case 'require':
        message = `🌿 **This deployment requires working in a worktree.**\n` +
          `Please reply with a branch name to continue.`;
        break;
      default:
        message = `🌿 **Would you like to work in an isolated worktree?**\n` +
          `Reply with a branch name, or react with ❌ to continue in the main repo.`;
    }

    // Create post with ❌ reaction option (except for 'require' mode)
    // Use 'x' emoji name, not Unicode ❌ character
    const reactionOptions = reason === 'require' ? [] : ['x'];
    const post = await this.mattermost.createInteractivePost(
      message,
      reactionOptions,
      session.threadId
    );

    // Track the post for reaction handling
    session.worktreePromptPostId = post.id;
    this.registerPost(post.id, session.threadId);

    // Stop typing while waiting for response
    this.stopTyping(session);
  }

  private handleEvent(threadId: string, event: ClaudeEvent): void {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Update last activity and reset timeout warning
    session.lastActivityAt = new Date();
    session.timeoutWarningPosted = false;

    // Check for special tool uses that need custom handling
    if (event.type === 'assistant') {
      const msg = event.message as { content?: Array<{ type: string; name?: string; id?: string; input?: Record<string, unknown> }> };
      let hasSpecialTool = false;
      for (const block of msg?.content || []) {
        if (block.type === 'tool_use') {
          if (block.name === 'ExitPlanMode') {
            this.handleExitPlanMode(session, block.id as string);
            hasSpecialTool = true;
          } else if (block.name === 'TodoWrite') {
            this.handleTodoWrite(session, block.input as Record<string, unknown>);
          } else if (block.name === 'Task') {
            this.handleTaskStart(session, block.id as string, block.input as Record<string, unknown>);
          } else if (block.name === 'AskUserQuestion') {
            this.handleAskUserQuestion(session, block.id as string, block.input as Record<string, unknown>);
            hasSpecialTool = true;
          }
        }
      }
      if (hasSpecialTool) return;
    }

    // Check for tool_result to update subagent status
    if (event.type === 'user') {
      const msg = event.message as { content?: Array<{ type: string; tool_use_id?: string; content?: string }> };
      for (const block of msg?.content || []) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const postId = session.activeSubagents.get(block.tool_use_id);
          if (postId) {
            this.handleTaskComplete(session, block.tool_use_id, postId);
          }
        }
      }
    }

    const formatted = this.formatEvent(session, event);
    if (this.debug) {
      console.log(`[DEBUG] handleEvent(${threadId}): ${event.type} -> ${formatted ? formatted.substring(0, 100) : '(null)'}`);
    }
    if (formatted) this.appendContent(session, formatted);
  }

  private async handleTaskComplete(session: Session, toolUseId: string, postId: string): Promise<void> {
    try {
      await this.mattermost.updatePost(postId,
        session.activeSubagents.has(toolUseId)
          ? `🤖 **Subagent** ✅ *completed*`
          : `🤖 **Subagent** ✅`
      );
      session.activeSubagents.delete(toolUseId);
    } catch (err) {
      console.error('  ⚠️ Failed to update subagent completion:', err);
    }
  }

  private async handleExitPlanMode(session: Session, toolUseId: string): Promise<void> {
    // If already approved in this session, send empty tool result to acknowledge
    // (Claude needs a response to continue)
    if (session.planApproved) {
      if (this.debug) console.log('  ↪ Plan already approved, sending acknowledgment');
      if (session.claude.isRunning()) {
        session.claude.sendToolResult(toolUseId, 'Plan already approved. Proceeding.');
      }
      return;
    }

    // If we already have a pending approval, don't post another one
    if (session.pendingApproval && session.pendingApproval.type === 'plan') {
      if (this.debug) console.log('  ↪ Plan approval already pending, waiting');
      return;
    }

    // Flush any pending content first
    await this.flush(session);
    session.currentPostId = null;
    session.pendingContent = '';

    // Post approval message with reactions
    const message = `✅ **Plan ready for approval**\n\n` +
      `👍 Approve and start building\n` +
      `👎 Request changes\n\n` +
      `*React to respond*`;

    const post = await this.mattermost.createInteractivePost(
      message,
      [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]],
      session.threadId
    );

    // Register post for reaction routing
    this.registerPost(post.id, session.threadId);

    // Track this for reaction handling - include toolUseId for proper response
    session.pendingApproval = { postId: post.id, type: 'plan', toolUseId };

    // Stop typing while waiting
    this.stopTyping(session);
  }

  private async handleTodoWrite(session: Session, input: Record<string, unknown>): Promise<void> {
    const todos = input.todos as Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm: string;
    }>;

    if (!todos || todos.length === 0) {
      // Clear tasks display if empty
      if (session.tasksPostId) {
        try {
          await this.mattermost.updatePost(session.tasksPostId, '📋 ~~Tasks~~ *(completed)*');
        } catch (err) {
          console.error('  ⚠️ Failed to update tasks:', err);
        }
      }
      return;
    }

    // Count progress
    const completed = todos.filter(t => t.status === 'completed').length;
    const total = todos.length;
    const pct = Math.round((completed / total) * 100);

    // Check if there's an in_progress task and track timing
    const hasInProgress = todos.some(t => t.status === 'in_progress');
    if (hasInProgress && !session.inProgressTaskStart) {
      session.inProgressTaskStart = Date.now();
    } else if (!hasInProgress) {
      session.inProgressTaskStart = null;
    }

    // Format tasks nicely with progress header
    let message = `📋 **Tasks** (${completed}/${total} · ${pct}%)\n\n`;
    for (const todo of todos) {
      let icon: string;
      let text: string;
      switch (todo.status) {
        case 'completed':
          icon = '✅';
          text = `~~${todo.content}~~`;
          break;
        case 'in_progress': {
          icon = '🔄';
          // Add elapsed time if we have a start time
          let elapsed = '';
          if (session.inProgressTaskStart) {
            const secs = Math.round((Date.now() - session.inProgressTaskStart) / 1000);
            if (secs >= 5) {  // Only show if >= 5 seconds
              elapsed = ` (${secs}s)`;
            }
          }
          text = `**${todo.activeForm}**${elapsed}`;
          break;
        }
        default: // pending
          icon = '○';
          text = todo.content;
      }
      message += `${icon} ${text}\n`;
    }

    // Update or create tasks post
    try {
      if (session.tasksPostId) {
        await this.mattermost.updatePost(session.tasksPostId, message);
      } else {
        const post = await this.mattermost.createPost(message, session.threadId);
        session.tasksPostId = post.id;
      }
    } catch (err) {
      console.error('  ⚠️ Failed to update tasks:', err);
    }
  }

  private async handleTaskStart(session: Session, toolUseId: string, input: Record<string, unknown>): Promise<void> {
    const description = input.description as string || 'Working...';
    const subagentType = input.subagent_type as string || 'general';

    // Post subagent status
    const message = `🤖 **Subagent** *(${subagentType})*\n` +
      `> ${description}\n` +
      `⏳ Running...`;

    try {
      const post = await this.mattermost.createPost(message, session.threadId);
      session.activeSubagents.set(toolUseId, post.id);
    } catch (err) {
      console.error('  ⚠️ Failed to post subagent status:', err);
    }
  }

  private async handleAskUserQuestion(session: Session, toolUseId: string, input: Record<string, unknown>): Promise<void> {
    // If we already have pending questions, don't start another set
    if (session.pendingQuestionSet) {
      if (this.debug) console.log('  ↪ Questions already pending, waiting');
      return;
    }

    // Flush any pending content first
    await this.flush(session);
    session.currentPostId = null;
    session.pendingContent = '';

    const questions = input.questions as Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>;

    if (!questions || questions.length === 0) return;

    // Create a new question set - we'll ask one at a time
    session.pendingQuestionSet = {
      toolUseId,
      currentIndex: 0,
      currentPostId: null,
      questions: questions.map(q => ({
        header: q.header,
        question: q.question,
        options: q.options,
        answer: null,
      })),
    };

    // Post the first question
    await this.postCurrentQuestion(session);

    // Stop typing while waiting for answer
    this.stopTyping(session);
  }

  private async postCurrentQuestion(session: Session): Promise<void> {
    if (!session.pendingQuestionSet) return;

    const { currentIndex, questions } = session.pendingQuestionSet;
    if (currentIndex >= questions.length) return;

    const q = questions[currentIndex];
    const total = questions.length;

    // Format the question message
    let message = `❓ **Question** *(${currentIndex + 1}/${total})*\n`;
    message += `**${q.header}:** ${q.question}\n\n`;
    for (let i = 0; i < q.options.length && i < 4; i++) {
      const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i];
      message += `${emoji} **${q.options[i].label}**`;
      if (q.options[i].description) {
        message += ` - ${q.options[i].description}`;
      }
      message += '\n';
    }

    // Post the question with reaction options
    const reactionOptions = NUMBER_EMOJIS.slice(0, q.options.length);
    const post = await this.mattermost.createInteractivePost(
      message,
      reactionOptions,
      session.threadId
    );
    session.pendingQuestionSet.currentPostId = post.id;

    // Register post for reaction routing
    this.registerPost(post.id, session.threadId);
  }

  // ---------------------------------------------------------------------------
  // Reaction Handling
  // ---------------------------------------------------------------------------

  private async handleReaction(postId: string, emojiName: string, username: string): Promise<void> {
    // Check if user is allowed
    if (!this.mattermost.isUserAllowed(username)) return;

    // Find the session this post belongs to
    const session = this.getSessionByPost(postId);
    if (!session) return;

    // Handle ❌ on worktree prompt (skip worktree, continue in main repo)
    // Must be checked BEFORE cancel reaction handler since ❌ is also a cancel emoji
    if (session.worktreePromptPostId === postId && emojiName === 'x') {
      await this.handleWorktreeSkip(session.threadId, username);
      return;
    }

    // Handle cancel reactions (❌ or 🛑) on any post in the session
    if (isCancelEmoji(emojiName)) {
      await this.cancelSession(session.threadId, username);
      return;
    }

    // Handle interrupt reactions (⏸️) on any post in the session
    if (isEscapeEmoji(emojiName)) {
      await this.interruptSession(session.threadId, username);
      return;
    }

    // Handle approval reactions
    if (session.pendingApproval && session.pendingApproval.postId === postId) {
      await this.handleApprovalReaction(session, emojiName, username);
      return;
    }

    // Handle question reactions
    if (session.pendingQuestionSet && session.pendingQuestionSet.currentPostId === postId) {
      await this.handleQuestionReaction(session, postId, emojiName, username);
      return;
    }

    // Handle message approval reactions
    if (session.pendingMessageApproval && session.pendingMessageApproval.postId === postId) {
      await this.handleMessageApprovalReaction(session, emojiName, username);
      return;
    }
  }

  private async handleQuestionReaction(session: Session, postId: string, emojiName: string, username: string): Promise<void> {
    if (!session.pendingQuestionSet) return;

    const { currentIndex, questions } = session.pendingQuestionSet;
    const question = questions[currentIndex];
    if (!question) return;

    const optionIndex = getNumberEmojiIndex(emojiName);
    if (optionIndex < 0 || optionIndex >= question.options.length) return;

    const selectedOption = question.options[optionIndex];
    question.answer = selectedOption.label;
    if (this.debug) console.log(`  💬 @${username} answered "${question.header}": ${selectedOption.label}`);

    // Update the post to show answer
    try {
      await this.mattermost.updatePost(postId, `✅ **${question.header}**: ${selectedOption.label}`);
    } catch (err) {
      console.error('  ⚠️ Failed to update answered question:', err);
    }

    // Move to next question or finish
    session.pendingQuestionSet.currentIndex++;

    if (session.pendingQuestionSet.currentIndex < questions.length) {
      // Post next question
      await this.postCurrentQuestion(session);
    } else {
      // All questions answered - send tool result
      let answersText = 'Here are my answers:\n';
      for (const q of questions) {
        answersText += `- **${q.header}**: ${q.answer}\n`;
      }

      if (this.debug) console.log('  ✅ All questions answered');

      // Get the toolUseId before clearing
      const toolUseId = session.pendingQuestionSet.toolUseId;

      // Clear pending questions
      session.pendingQuestionSet = null;

      // Send tool result to Claude (AskUserQuestion expects a tool_result, not a user message)
      if (session.claude.isRunning()) {
        session.claude.sendToolResult(toolUseId, answersText);
        this.startTyping(session);
      }
    }
  }

  private async handleApprovalReaction(session: Session, emojiName: string, username: string): Promise<void> {
    if (!session.pendingApproval) return;

    const isApprove = isApprovalEmoji(emojiName);
    const isReject = isDenialEmoji(emojiName);

    if (!isApprove && !isReject) return;

    const { postId, toolUseId } = session.pendingApproval;
    const shortId = session.threadId.substring(0, 8);
    console.log(`  ${isApprove ? '✅' : '❌'} Plan ${isApprove ? 'approved' : 'rejected'} (${shortId}…) by @${username}`);

    // Update the post to show the decision
    try {
      const statusMessage = isApprove
        ? `✅ **Plan approved** by @${username} - starting implementation...`
        : `❌ **Changes requested** by @${username}`;
      await this.mattermost.updatePost(postId, statusMessage);
    } catch (err) {
      console.error('  ⚠️ Failed to update approval post:', err);
    }

    // Clear pending approval and mark as approved
    session.pendingApproval = null;
    if (isApprove) {
      session.planApproved = true;
    }

    // Send tool result to Claude (ExitPlanMode expects a tool_result, not a user message)
    if (session.claude.isRunning()) {
      const response = isApprove
        ? 'Approved. Please proceed with the implementation.'
        : 'Please revise the plan. I would like some changes.';
      session.claude.sendToolResult(toolUseId, response);
      this.startTyping(session);
    }
  }

  private async handleMessageApprovalReaction(session: Session, emoji: string, approver: string): Promise<void> {
    const pending = session.pendingMessageApproval;
    if (!pending) return;

    // Only session owner or globally allowed users can approve
    if (session.startedBy !== approver && !this.mattermost.isUserAllowed(approver)) {
      return;
    }

    const isAllow = isApprovalEmoji(emoji);
    const isInvite = isAllowAllEmoji(emoji);
    const isDeny = isDenialEmoji(emoji);

    if (!isAllow && !isInvite && !isDeny) return;

    if (isAllow) {
      // Allow this single message
      await this.mattermost.updatePost(pending.postId,
        `✅ Message from @${pending.fromUser} approved by @${approver}`);
      session.claude.sendMessage(pending.originalMessage);
      session.lastActivityAt = new Date();
      this.startTyping(session);
      console.log(`  ✅ Message from @${pending.fromUser} approved by @${approver}`);
    } else if (isInvite) {
      // Invite user to session
      session.sessionAllowedUsers.add(pending.fromUser);
      await this.mattermost.updatePost(pending.postId,
        `✅ @${pending.fromUser} invited to session by @${approver}`);
      await this.updateSessionHeader(session);
      session.claude.sendMessage(pending.originalMessage);
      session.lastActivityAt = new Date();
      this.startTyping(session);
      console.log(`  👋 @${pending.fromUser} invited to session by @${approver}`);
    } else if (isDeny) {
      // Deny
      await this.mattermost.updatePost(pending.postId,
        `❌ Message from @${pending.fromUser} denied by @${approver}`);
      console.log(`  ❌ Message from @${pending.fromUser} denied by @${approver}`);
    }

    session.pendingMessageApproval = null;
  }

  private formatEvent(session: Session, e: ClaudeEvent): string | null {
    switch (e.type) {
      case 'assistant': {
        const msg = e.message as { content?: Array<{ type: string; text?: string; thinking?: string; name?: string; input?: Record<string, unknown> }> };
        const parts: string[] = [];
        for (const block of msg?.content || []) {
          if (block.type === 'text' && block.text) {
            // Filter out <thinking> tags that may appear in text content
            const text = block.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
            if (text) parts.push(text);
          } else if (block.type === 'tool_use' && block.name) {
            const formatted = sharedFormatToolUse(block.name, block.input || {}, { detailed: true });
            if (formatted) parts.push(formatted);
          } else if (block.type === 'thinking' && block.thinking) {
            // Extended thinking - show abbreviated version
            const thinking = block.thinking as string;
            const preview = thinking.length > 100 ? thinking.substring(0, 100) + '...' : thinking;
            parts.push(`💭 *Thinking: ${preview}*`);
          } else if (block.type === 'server_tool_use' && block.name) {
            // Server-managed tools like web search
            parts.push(`🌐 **${block.name}** ${block.input ? JSON.stringify(block.input).substring(0, 50) : ''}`);
          }
        }
        return parts.length > 0 ? parts.join('\n') : null;
      }
      case 'tool_use': {
        const tool = e.tool_use as { id?: string; name: string; input?: Record<string, unknown> };
        // Track tool start time for elapsed display
        if (tool.id) {
          session.activeToolStarts.set(tool.id, Date.now());
        }
        return sharedFormatToolUse(tool.name, tool.input || {}, { detailed: true }) || null;
      }
      case 'tool_result': {
        const result = e.tool_result as { tool_use_id?: string; is_error?: boolean };
        // Calculate elapsed time
        let elapsed = '';
        if (result.tool_use_id) {
          const startTime = session.activeToolStarts.get(result.tool_use_id);
          if (startTime) {
            const secs = Math.round((Date.now() - startTime) / 1000);
            if (secs >= 3) {  // Only show if >= 3 seconds
              elapsed = ` (${secs}s)`;
            }
            session.activeToolStarts.delete(result.tool_use_id);
          }
        }
        if (result.is_error) return `  ↳ ❌ Error${elapsed}`;
        if (elapsed) return `  ↳ ✓${elapsed}`;
        return null;
      }
      case 'result': {
        // Response complete - stop typing and start new post for next message
        this.stopTyping(session);
        this.flush(session);
        session.currentPostId = null;
        session.pendingContent = '';
        return null;
      }
      case 'system':
        if (e.subtype === 'error') return `❌ ${e.error}`;
        return null;
      case 'user': {
        // Handle local command output (e.g., /context, /cost responses)
        const msg = e.message as { content?: string };
        if (typeof msg?.content === 'string') {
          // Extract content from <local-command-stdout> tags
          const match = msg.content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
          if (match) {
            return match[1].trim();
          }
        }
        return null;
      }
      default:
        return null;
    }
  }

  private appendContent(session: Session, text: string): void {
    if (!text) return;
    session.pendingContent += text + '\n';
    this.scheduleUpdate(session);
  }

  private scheduleUpdate(session: Session): void {
    if (session.updateTimer) return;
    session.updateTimer = setTimeout(() => {
      session.updateTimer = null;
      this.flush(session);
    }, 500);
  }

  /**
   * Build message content for Claude, including images if present.
   * Returns either a string or an array of content blocks.
   */
  private async buildMessageContent(
    text: string,
    files?: MattermostFile[]
  ): Promise<string | ContentBlock[]> {
    // Filter to only image files
    const imageFiles = files?.filter(f =>
      f.mime_type.startsWith('image/') &&
      ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(f.mime_type)
    ) || [];

    // If no images, return plain text
    if (imageFiles.length === 0) {
      return text;
    }

    // Build content blocks with images
    const blocks: ContentBlock[] = [];

    // Download and add each image
    for (const file of imageFiles) {
      try {
        const buffer = await this.mattermost.downloadFile(file.id);
        const base64 = buffer.toString('base64');

        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: file.mime_type,
            data: base64,
          },
        });

        if (this.debug) {
          console.log(`  📷 Attached image: ${file.name} (${file.mime_type}, ${Math.round(buffer.length / 1024)}KB)`);
        }
      } catch (err) {
        console.error(`  ⚠️ Failed to download image ${file.name}:`, err);
      }
    }

    // Add the text message
    if (text) {
      blocks.push({
        type: 'text',
        text,
      });
    }

    return blocks;
  }

  private startTyping(session: Session): void {
    if (session.typingTimer) return;
    // Send typing immediately, then every 3 seconds
    this.mattermost.sendTyping(session.threadId);
    session.typingTimer = setInterval(() => {
      this.mattermost.sendTyping(session.threadId);
    }, 3000);
  }

  private stopTyping(session: Session): void {
    if (session.typingTimer) {
      clearInterval(session.typingTimer);
      session.typingTimer = null;
    }
  }

  private async flush(session: Session): Promise<void> {
    if (!session.pendingContent.trim()) return;

    let content = session.pendingContent.replace(/\n{3,}/g, '\n\n').trim();

    // Mattermost has a 16,383 character limit for posts
    const MAX_POST_LENGTH = 16000;  // Leave some margin
    const CONTINUATION_THRESHOLD = 14000;  // Start new message before we hit the limit

    // Check if we need to start a new message due to length
    if (session.currentPostId && content.length > CONTINUATION_THRESHOLD) {
      // Finalize the current post with what we have up to the threshold
      // Find a good break point (end of line) near the threshold
      let breakPoint = content.lastIndexOf('\n', CONTINUATION_THRESHOLD);
      if (breakPoint < CONTINUATION_THRESHOLD * 0.7) {
        // If we can't find a good line break, just break at the threshold
        breakPoint = CONTINUATION_THRESHOLD;
      }

      const firstPart = content.substring(0, breakPoint).trim() + '\n\n*... (continued below)*';
      const remainder = content.substring(breakPoint).trim();

      // Update the current post with the first part
      await this.mattermost.updatePost(session.currentPostId, firstPart);

      // Start a new post for the continuation
      session.currentPostId = null;
      session.pendingContent = remainder;

      // Create the continuation post if there's content
      if (remainder) {
        const post = await this.mattermost.createPost('*(continued)*\n\n' + remainder, session.threadId);
        session.currentPostId = post.id;
        this.registerPost(post.id, session.threadId);
      }
      return;
    }

    // Normal case: content fits in current post
    if (content.length > MAX_POST_LENGTH) {
      // Safety truncation if we somehow got content that's still too long
      content = content.substring(0, MAX_POST_LENGTH - 50) + '\n\n*... (truncated)*';
    }

    if (session.currentPostId) {
      await this.mattermost.updatePost(session.currentPostId, content);
    } else {
      const post = await this.mattermost.createPost(content, session.threadId);
      session.currentPostId = post.id;
      // Register post for reaction routing
      this.registerPost(post.id, session.threadId);
    }
  }

  private async handleExit(threadId: string, code: number): Promise<void> {
    const session = this.sessions.get(threadId);
    const shortId = threadId.substring(0, 8);

    // Always log exit events to trace the flow
    console.log(`  [exit] handleExit called for ${shortId}... code=${code} isShuttingDown=${this.isShuttingDown}`);

    if (!session) {
      console.log(`  [exit] Session ${shortId}... not found (already cleaned up)`);
      return;
    }

    // If we're intentionally restarting (e.g., !cd), don't clean up or post exit message
    if (session.isRestarting) {
      console.log(`  [exit] Session ${shortId}... restarting, skipping cleanup`);
      session.isRestarting = false;  // Reset flag here, after the exit event fires
      return;
    }

    // If bot is shutting down, suppress exit messages (shutdown message already sent)
    // IMPORTANT: Check this flag FIRST before any cleanup. The session should remain
    // persisted so it can be resumed after restart.
    if (this.isShuttingDown) {
      console.log(`  [exit] Session ${shortId}... bot shutting down, preserving persistence`);
      // Still clean up from in-memory maps since we're shutting down anyway
      this.stopTyping(session);
      if (session.updateTimer) {
        clearTimeout(session.updateTimer);
        session.updateTimer = null;
      }
      this.sessions.delete(threadId);
      return;
    }

    // If session was interrupted (SIGINT sent), preserve for resume
    // Claude CLI exits on SIGINT, but we want to allow resuming the session
    if (session.wasInterrupted) {
      console.log(`  [exit] Session ${shortId}... exited after interrupt, preserving for resume`);
      this.stopTyping(session);
      if (session.updateTimer) {
        clearTimeout(session.updateTimer);
        session.updateTimer = null;
      }
      // Update persistence with current state before cleanup
      this.persistSession(session);
      this.sessions.delete(threadId);
      // Clean up post index
      for (const [postId, tid] of this.postIndex.entries()) {
        if (tid === threadId) {
          this.postIndex.delete(postId);
        }
      }
      // Notify user they can send a new message to resume
      try {
        await this.mattermost.createPost(
          `ℹ️ Session paused. Send a new message to continue.`,
          session.threadId
        );
      } catch {
        // Ignore if we can't post
      }
      console.log(`  ⏸️ Session paused (${shortId}…) — ${this.sessions.size} active`);
      return;
    }

    // For resumed sessions that exit quickly (e.g., Claude --resume fails),
    // don't unpersist immediately - give it a chance to be retried
    if (session.isResumed && code !== 0) {
      console.log(`  [exit] Resumed session ${shortId}... failed with code ${code}, preserving for retry`);
      this.stopTyping(session);
      if (session.updateTimer) {
        clearTimeout(session.updateTimer);
        session.updateTimer = null;
      }
      this.sessions.delete(threadId);
      // Post error message but keep persistence
      try {
        await this.mattermost.createPost(
          `⚠️ **Session resume failed** (exit code ${code}). The session data is preserved - try restarting the bot.`,
          session.threadId
        );
      } catch {
        // Ignore if we can't post
      }
      return;
    }

    console.log(`  [exit] Session ${shortId}... normal exit, cleaning up`);

    this.stopTyping(session);
    if (session.updateTimer) {
      clearTimeout(session.updateTimer);
      session.updateTimer = null;
    }
    await this.flush(session);

    if (code !== 0 && code !== null) {
      await this.mattermost.createPost(`**[Exited: ${code}]**`, session.threadId);
    }

    // Clean up session from maps
    this.sessions.delete(threadId);
    // Clean up post index entries for this session
    for (const [postId, tid] of this.postIndex.entries()) {
      if (tid === threadId) {
        this.postIndex.delete(postId);
      }
    }

    // Only unpersist for normal exits (code 0 or null means graceful completion)
    // Non-zero exits might be recoverable, so we keep the session persisted
    if (code === 0 || code === null) {
      this.unpersistSession(threadId);
    } else {
      console.log(`  [exit] Session ${shortId}... non-zero exit, preserving for potential retry`);
    }

    console.log(`  ■ Session ended (${shortId}…) — ${this.sessions.size} active`);
  }

  // ---------------------------------------------------------------------------
  // Public Session API
  // ---------------------------------------------------------------------------

  /** Check if any sessions are active */
  isSessionActive(): boolean {
    return this.sessions.size > 0;
  }

  /** Check if a session exists for this thread */
  isInSessionThread(threadRoot: string): boolean {
    const session = this.sessions.get(threadRoot);
    return session !== undefined && session.claude.isRunning();
  }

  /** Send a follow-up message to an existing session */
  async sendFollowUp(threadId: string, message: string, files?: MattermostFile[]): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session || !session.claude.isRunning()) return;
    const content = await this.buildMessageContent(message, files);
    session.claude.sendMessage(content);
    session.lastActivityAt = new Date();
    this.startTyping(session);
  }

  /**
   * Check if there's a paused (persisted but not active) session for this thread.
   * This is used to detect when we should resume a session instead of ignoring the message.
   */
  hasPausedSession(threadId: string): boolean {
    // If there's an active session, it's not paused
    if (this.sessions.has(threadId)) return false;
    // Check persistence
    const persisted = this.sessionStore.load();
    return persisted.has(threadId);
  }

  /**
   * Resume a paused session and send a message to it.
   * Called when a user sends a message to a thread with a paused session.
   */
  async resumePausedSession(threadId: string, message: string, files?: MattermostFile[]): Promise<void> {
    const persisted = this.sessionStore.load();
    const state = persisted.get(threadId);
    if (!state) {
      console.log(`  [resume] No persisted session found for ${threadId.substring(0, 8)}...`);
      return;
    }

    const shortId = threadId.substring(0, 8);
    console.log(`  🔄 Resuming paused session ${shortId}... for new message`);

    // Resume the session (similar to initialize() but for a single session)
    await this.resumeSession(state);

    // Wait a moment for the session to be ready, then send the message
    const session = this.sessions.get(threadId);
    if (session && session.claude.isRunning()) {
      const content = await this.buildMessageContent(message, files);
      session.claude.sendMessage(content);
      session.lastActivityAt = new Date();
      this.startTyping(session);
    } else {
      console.log(`  ⚠️ Failed to resume session ${shortId}..., could not send message`);
    }
  }

  /**
   * Get persisted session info for access control checks
   */
  getPersistedSession(threadId: string): PersistedSession | undefined {
    const persisted = this.sessionStore.load();
    return persisted.get(threadId);
  }

  /** Kill a specific session */
  killSession(threadId: string, unpersist = true): void {
    const session = this.sessions.get(threadId);
    if (!session) return;

    const shortId = threadId.substring(0, 8);

    // Set restarting flag to prevent handleExit from also unpersisting
    // (we'll do it explicitly here if requested)
    if (!unpersist) {
      session.isRestarting = true;  // Reuse this flag to skip cleanup in handleExit
    }

    this.stopTyping(session);
    session.claude.kill();

    // Clean up session from maps
    this.sessions.delete(threadId);
    for (const [postId, tid] of this.postIndex.entries()) {
      if (tid === threadId) {
        this.postIndex.delete(postId);
      }
    }

    // Explicitly unpersist if requested (e.g., for timeout, cancel, etc.)
    if (unpersist) {
      this.unpersistSession(threadId);
    }

    console.log(`  ✖ Session killed (${shortId}…) — ${this.sessions.size} active`);
  }

  /** Cancel a session with user feedback */
  async cancelSession(threadId: string, username: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    const shortId = threadId.substring(0, 8);
    console.log(`  🛑 Session (${shortId}…) cancelled by @${username}`);

    await this.mattermost.createPost(
      `🛑 **Session cancelled** by @${username}`,
      threadId
    );

    this.killSession(threadId);
  }

  /** Interrupt current processing but keep session alive (like Escape in CLI) */
  async interruptSession(threadId: string, username: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    if (!session.claude.isRunning()) {
      await this.mattermost.createPost(
        `ℹ️ Session is idle, nothing to interrupt`,
        threadId
      );
      return;
    }

    const shortId = threadId.substring(0, 8);

    // Set flag BEFORE interrupt - if Claude exits due to SIGINT, we won't unpersist
    session.wasInterrupted = true;
    const interrupted = session.claude.interrupt();

    if (interrupted) {
      console.log(`  ⏸️ Session (${shortId}…) interrupted by @${username}`);
      await this.mattermost.createPost(
        `⏸️ **Interrupted** by @${username}`,
        threadId
      );
    }
  }

  /** Change working directory for a session (restarts Claude CLI) */
  async changeDirectory(threadId: string, newDir: string, username: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Only session owner or globally allowed users can change directory
    if (session.startedBy !== username && !this.mattermost.isUserAllowed(username)) {
      await this.mattermost.createPost(
        `⚠️ Only @${session.startedBy} or allowed users can change the working directory`,
        threadId
      );
      return;
    }

    // Expand ~ to home directory
    const expandedDir = newDir.startsWith('~')
      ? newDir.replace('~', process.env.HOME || '')
      : newDir;

    // Resolve to absolute path
    const { resolve } = await import('path');
    const absoluteDir = resolve(expandedDir);

    // Check if directory exists
    const { existsSync, statSync } = await import('fs');
    if (!existsSync(absoluteDir)) {
      await this.mattermost.createPost(
        `❌ Directory does not exist: \`${newDir}\``,
        threadId
      );
      return;
    }

    if (!statSync(absoluteDir).isDirectory()) {
      await this.mattermost.createPost(
        `❌ Not a directory: \`${newDir}\``,
        threadId
      );
      return;
    }

    const shortId = threadId.substring(0, 8);
    const shortDir = absoluteDir.replace(process.env.HOME || '', '~');
    console.log(`  📂 Session (${shortId}…) changing directory to ${shortDir}`);

    // Stop the current Claude CLI
    this.stopTyping(session);
    session.isRestarting = true;  // Suppress exit message during restart
    session.claude.kill();

    // Flush any pending content
    await this.flush(session);
    session.currentPostId = null;
    session.pendingContent = '';

    // Update session working directory
    session.workingDir = absoluteDir;

    // Generate new session ID for fresh start in new directory
    // (Claude CLI sessions are tied to working directory, can't resume across directories)
    const newSessionId = randomUUID();
    session.claudeSessionId = newSessionId;

    const cliOptions: ClaudeCliOptions = {
      workingDir: absoluteDir,
      threadId: threadId,
      skipPermissions: this.skipPermissions || !session.forceInteractivePermissions,
      sessionId: newSessionId,
      resume: false,  // Fresh start - can't resume across directories
      chrome: this.chromeEnabled,
    };
    session.claude = new ClaudeCli(cliOptions);

    // Rebind event handlers
    session.claude.on('event', (e: ClaudeEvent) => this.handleEvent(threadId, e));
    session.claude.on('exit', (code: number) => this.handleExit(threadId, code));

    // Start the new Claude CLI
    try {
      session.claude.start();
      // Note: isRestarting is reset in handleExit when the old process exit event fires
    } catch (err) {
      session.isRestarting = false;  // Reset flag on failure since exit won't fire
      console.error('  ❌ Failed to restart Claude:', err);
      await this.mattermost.createPost(`❌ Failed to restart Claude: ${err}`, threadId);
      return;
    }

    // Update session header with new directory
    await this.updateSessionHeader(session);

    // Post confirmation
    await this.mattermost.createPost(
      `📂 **Working directory changed** to \`${shortDir}\`\n*Claude Code restarted in new directory*`,
      threadId
    );

    // Update activity
    session.lastActivityAt = new Date();
    session.timeoutWarningPosted = false;

    // Persist the updated session state
    this.persistSession(session);
  }

  /** Invite a user to participate in a specific session */
  async inviteUser(threadId: string, invitedUser: string, invitedBy: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Only session owner or globally allowed users can invite
    if (session.startedBy !== invitedBy && !this.mattermost.isUserAllowed(invitedBy)) {
      await this.mattermost.createPost(
        `⚠️ Only @${session.startedBy} or allowed users can invite others`,
        threadId
      );
      return;
    }

    session.sessionAllowedUsers.add(invitedUser);
    await this.mattermost.createPost(
      `✅ @${invitedUser} can now participate in this session (invited by @${invitedBy})`,
      threadId
    );
    console.log(`  👋 @${invitedUser} invited to session by @${invitedBy}`);
    await this.updateSessionHeader(session);
    this.persistSession(session);  // Persist collaboration change
  }

  /** Kick a user from a specific session */
  async kickUser(threadId: string, kickedUser: string, kickedBy: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Only session owner or globally allowed users can kick
    if (session.startedBy !== kickedBy && !this.mattermost.isUserAllowed(kickedBy)) {
      await this.mattermost.createPost(
        `⚠️ Only @${session.startedBy} or allowed users can kick others`,
        threadId
      );
      return;
    }

    // Can't kick session owner
    if (kickedUser === session.startedBy) {
      await this.mattermost.createPost(
        `⚠️ Cannot kick session owner @${session.startedBy}`,
        threadId
      );
      return;
    }

    // Can't kick globally allowed users (they'll still have access)
    if (this.mattermost.isUserAllowed(kickedUser)) {
      await this.mattermost.createPost(
        `⚠️ @${kickedUser} is globally allowed and cannot be kicked from individual sessions`,
        threadId
      );
      return;
    }

    if (session.sessionAllowedUsers.delete(kickedUser)) {
      await this.mattermost.createPost(
        `🚫 @${kickedUser} removed from this session by @${kickedBy}`,
        threadId
      );
      console.log(`  🚫 @${kickedUser} kicked from session by @${kickedBy}`);
      await this.updateSessionHeader(session);
      this.persistSession(session);  // Persist collaboration change
    } else {
      await this.mattermost.createPost(
        `⚠️ @${kickedUser} was not in this session`,
        threadId
      );
    }
  }

  /**
   * Enable interactive permissions for a session.
   * Can only downgrade (skip → interactive), not upgrade.
   */
  async enableInteractivePermissions(threadId: string, username: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Only session owner or globally allowed users can change permissions
    if (session.startedBy !== username && !this.mattermost.isUserAllowed(username)) {
      await this.mattermost.createPost(
        `⚠️ Only @${session.startedBy} or allowed users can change permissions`,
        threadId
      );
      return;
    }

    // Can only downgrade, not upgrade
    if (!this.skipPermissions) {
      await this.mattermost.createPost(
        `ℹ️ Permissions are already interactive for this session`,
        threadId
      );
      return;
    }

    // Already enabled for this session
    if (session.forceInteractivePermissions) {
      await this.mattermost.createPost(
        `ℹ️ Interactive permissions already enabled for this session`,
        threadId
      );
      return;
    }

    // Set the flag
    session.forceInteractivePermissions = true;

    const shortId = threadId.substring(0, 8);
    console.log(`  🔐 Session (${shortId}…) enabling interactive permissions`);

    // Stop the current Claude CLI and restart with new permission setting
    this.stopTyping(session);
    session.isRestarting = true;  // Suppress exit message during restart
    session.claude.kill();

    // Flush any pending content
    await this.flush(session);
    session.currentPostId = null;
    session.pendingContent = '';

    // Create new CLI options with interactive permissions (skipPermissions: false)
    const cliOptions: ClaudeCliOptions = {
      workingDir: session.workingDir,
      threadId: threadId,
      skipPermissions: false,  // Force interactive permissions
      sessionId: session.claudeSessionId,
      resume: true,  // Resume to keep conversation context
      chrome: this.chromeEnabled,
    };
    session.claude = new ClaudeCli(cliOptions);

    // Rebind event handlers
    session.claude.on('event', (e: ClaudeEvent) => this.handleEvent(threadId, e));
    session.claude.on('exit', (code: number) => this.handleExit(threadId, code));

    // Start the new Claude CLI
    try {
      session.claude.start();
      // Note: isRestarting is reset in handleExit when the old process exit event fires
    } catch (err) {
      session.isRestarting = false;  // Reset flag on failure since exit won't fire
      console.error('  ❌ Failed to restart Claude:', err);
      await this.mattermost.createPost(`❌ Failed to enable interactive permissions: ${err}`, threadId);
      return;
    }

    // Update session header with new permission status
    await this.updateSessionHeader(session);

    // Post confirmation
    await this.mattermost.createPost(
      `🔐 **Interactive permissions enabled** for this session by @${username}\n*Claude Code restarted with permission prompts*`,
      threadId
    );
    console.log(`  🔐 Interactive permissions enabled for session by @${username}`);

    // Update activity and persist
    session.lastActivityAt = new Date();
    session.timeoutWarningPosted = false;
    this.persistSession(session);
  }

  /** Check if a session should use interactive permissions */
  isSessionInteractive(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session) return !this.skipPermissions;

    // If global is interactive, always interactive
    if (!this.skipPermissions) return true;

    // If session has forced interactive, use that
    return session.forceInteractivePermissions;
  }

  /** Update the session header post with current participants */
  private async updateSessionHeader(session: Session): Promise<void> {
    if (!session.sessionStartPostId) return;

    // Use session's working directory (can be changed via !cd)
    const shortDir = session.workingDir.replace(process.env.HOME || '', '~');
    // Check session-level permission override
    const isInteractive = !this.skipPermissions || session.forceInteractivePermissions;
    const permMode = isInteractive ? '🔐 Interactive' : '⚡ Auto';

    // Build participants list (excluding owner who is shown in "Started by")
    const otherParticipants = [...session.sessionAllowedUsers]
      .filter(u => u !== session.startedBy)
      .map(u => `@${u}`)
      .join(', ');

    const rows = [
      `| 📂 **Directory** | \`${shortDir}\` |`,
      `| 👤 **Started by** | @${session.startedBy} |`,
    ];

    // Show worktree info if active
    if (session.worktreeInfo) {
      const shortRepoRoot = session.worktreeInfo.repoRoot.replace(process.env.HOME || '', '~');
      rows.push(`| 🌿 **Worktree** | \`${session.worktreeInfo.branch}\` (from \`${shortRepoRoot}\`) |`);
    }

    if (otherParticipants) {
      rows.push(`| 👥 **Participants** | ${otherParticipants} |`);
    }

    rows.push(`| 🔢 **Session** | #${session.sessionNumber} of ${MAX_SESSIONS} max |`);
    rows.push(`| ${permMode.split(' ')[0]} **Permissions** | ${permMode.split(' ')[1]} |`);
    if (this.chromeEnabled) {
      rows.push(`| 🌐 **Chrome** | Enabled |`);
    }

    // Check for available updates
    const updateInfo = getUpdateInfo();
    const updateNotice = updateInfo
      ? `\n> ⚠️ **Update available:** v${updateInfo.current} → v${updateInfo.latest} - Run \`npm install -g claude-threads\`\n`
      : '';

    // Get "What's new" from release notes
    const releaseNotes = getReleaseNotes(pkg.version);
    const whatsNew = releaseNotes ? getWhatsNewSummary(releaseNotes) : '';
    const whatsNewLine = whatsNew ? `\n> ✨ **What's new:** ${whatsNew}\n` : '';

    const msg = [
      getMattermostLogo(pkg.version),
      updateNotice,
      whatsNewLine,
      `| | |`,
      `|:--|:--|`,
      ...rows,
    ].join('\n');

    try {
      await this.mattermost.updatePost(session.sessionStartPostId, msg);
    } catch (err) {
      console.error('  ⚠️ Failed to update session header:', err);
    }
  }

  /** Request approval for a message from an unauthorized user */
  async requestMessageApproval(threadId: string, username: string, message: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // If there's already a pending message approval, ignore
    if (session.pendingMessageApproval) {
      return;
    }

    const preview = message.length > 100 ? message.substring(0, 100) + '…' : message;

    const post = await this.mattermost.createInteractivePost(
      `🔒 **@${username}** wants to send a message:\n> ${preview}\n\n` +
      `React 👍 to allow this message, ✅ to invite them to the session, 👎 to deny`,
      [APPROVAL_EMOJIS[0], ALLOW_ALL_EMOJIS[0], DENIAL_EMOJIS[0]],
      threadId
    );

    session.pendingMessageApproval = {
      postId: post.id,
      originalMessage: message,
      fromUser: username,
    };

    this.registerPost(post.id, threadId);
  }

  // ---------------------------------------------------------------------------
  // Worktree Management
  // ---------------------------------------------------------------------------

  /**
   * Handle a worktree branch response from user.
   * Called when user replies with a branch name to the worktree prompt.
   */
  async handleWorktreeBranchResponse(threadId: string, branchName: string, username: string): Promise<boolean> {
    const session = this.sessions.get(threadId);
    if (!session || !session.pendingWorktreePrompt) return false;

    // Only session owner can respond
    if (session.startedBy !== username && !this.mattermost.isUserAllowed(username)) {
      return false;
    }

    // Validate branch name
    if (!isValidBranchName(branchName)) {
      await this.mattermost.createPost(
        `❌ Invalid branch name: \`${branchName}\`. Please provide a valid git branch name.`,
        threadId
      );
      return true; // We handled it, but need another response
    }

    // Create and switch to worktree
    await this.createAndSwitchToWorktree(threadId, branchName, username);
    return true;
  }

  /**
   * Handle ❌ reaction on worktree prompt - skip worktree and continue in main repo.
   */
  async handleWorktreeSkip(threadId: string, username: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session || !session.pendingWorktreePrompt) return;

    // Only session owner can skip
    if (session.startedBy !== username && !this.mattermost.isUserAllowed(username)) {
      return;
    }

    // Update the prompt post
    if (session.worktreePromptPostId) {
      try {
        await this.mattermost.updatePost(session.worktreePromptPostId,
          `✅ Continuing in main repo (skipped by @${username})`);
      } catch (err) {
        console.error('  ⚠️ Failed to update worktree prompt:', err);
      }
    }

    // Clear pending state
    session.pendingWorktreePrompt = false;
    session.worktreePromptPostId = undefined;
    const queuedPrompt = session.queuedPrompt;
    session.queuedPrompt = undefined;

    // Persist updated state
    this.persistSession(session);

    // Now send the queued message to Claude
    if (queuedPrompt && session.claude.isRunning()) {
      session.claude.sendMessage(queuedPrompt);
      this.startTyping(session);
    }
  }

  /**
   * Create a new worktree and switch the session to it.
   */
  async createAndSwitchToWorktree(threadId: string, branch: string, username: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Only session owner or admins can manage worktrees
    if (session.startedBy !== username && !this.mattermost.isUserAllowed(username)) {
      await this.mattermost.createPost(
        `⚠️ Only @${session.startedBy} or allowed users can manage worktrees`,
        threadId
      );
      return;
    }

    // Check if we're in a git repo
    const isRepo = await isGitRepository(session.workingDir);
    if (!isRepo) {
      await this.mattermost.createPost(
        `❌ Current directory is not a git repository`,
        threadId
      );
      return;
    }

    // Get repo root
    const repoRoot = await getRepositoryRoot(session.workingDir);

    // Check if worktree already exists for this branch
    const existing = await findWorktreeByBranch(repoRoot, branch);
    if (existing && !existing.isMain) {
      await this.mattermost.createPost(
        `⚠️ Worktree for branch \`${branch}\` already exists at \`${existing.path}\`. Use \`!worktree switch ${branch}\` to switch to it.`,
        threadId
      );
      return;
    }

    const shortId = threadId.substring(0, 8);
    console.log(`  🌿 Session (${shortId}…) creating worktree for branch ${branch}`);

    // Generate worktree path
    const worktreePath = getWorktreeDir(repoRoot, branch);

    try {
      // Create the worktree
      await createWorktree(repoRoot, branch, worktreePath);

      // Update the prompt post if it exists
      if (session.worktreePromptPostId) {
        try {
          await this.mattermost.updatePost(session.worktreePromptPostId,
            `✅ Created worktree for \`${branch}\``);
        } catch (err) {
          console.error('  ⚠️ Failed to update worktree prompt:', err);
        }
      }

      // Clear pending state
      const wasPending = session.pendingWorktreePrompt;
      session.pendingWorktreePrompt = false;
      session.worktreePromptPostId = undefined;
      const queuedPrompt = session.queuedPrompt;
      session.queuedPrompt = undefined;

      // Store worktree info
      session.worktreeInfo = {
        repoRoot,
        worktreePath,
        branch,
      };

      // Update working directory
      session.workingDir = worktreePath;

      // If Claude is already running, restart it in the new directory
      if (session.claude.isRunning()) {
        this.stopTyping(session);
        session.isRestarting = true;
        session.claude.kill();

        // Flush any pending content
        await this.flush(session);
        session.currentPostId = null;
        session.pendingContent = '';

        // Generate new session ID for fresh start in new directory
        // (Claude CLI sessions are tied to working directory, can't resume across directories)
        const newSessionId = randomUUID();
        session.claudeSessionId = newSessionId;

        // Create new CLI with new working directory
        const cliOptions: ClaudeCliOptions = {
          workingDir: worktreePath,
          threadId: threadId,
          skipPermissions: this.skipPermissions || !session.forceInteractivePermissions,
          sessionId: newSessionId,
          resume: false,  // Fresh start - can't resume across directories
          chrome: this.chromeEnabled,
        };
        session.claude = new ClaudeCli(cliOptions);

        // Rebind event handlers
        session.claude.on('event', (e: ClaudeEvent) => this.handleEvent(threadId, e));
        session.claude.on('exit', (code: number) => this.handleExit(threadId, code));

        // Start the new CLI
        session.claude.start();
      }

      // Update session header
      await this.updateSessionHeader(session);

      // Post confirmation
      const shortWorktreePath = worktreePath.replace(process.env.HOME || '', '~');
      await this.mattermost.createPost(
        `✅ **Created worktree** for branch \`${branch}\`\n📁 Working directory: \`${shortWorktreePath}\`\n*Claude Code restarted in the new worktree*`,
        threadId
      );

      // Update activity and persist
      session.lastActivityAt = new Date();
      session.timeoutWarningPosted = false;
      this.persistSession(session);

      // If there was a queued prompt (from initial session start), send it now
      if (wasPending && queuedPrompt && session.claude.isRunning()) {
        session.claude.sendMessage(queuedPrompt);
        this.startTyping(session);
      }

      console.log(`  🌿 Session (${shortId}…) switched to worktree ${branch} at ${shortWorktreePath}`);
    } catch (err) {
      console.error(`  ❌ Failed to create worktree:`, err);
      await this.mattermost.createPost(
        `❌ Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
        threadId
      );
    }
  }

  /**
   * Switch to an existing worktree.
   */
  async switchToWorktree(threadId: string, branchOrPath: string, username: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Only session owner or admins can manage worktrees
    if (session.startedBy !== username && !this.mattermost.isUserAllowed(username)) {
      await this.mattermost.createPost(
        `⚠️ Only @${session.startedBy} or allowed users can manage worktrees`,
        threadId
      );
      return;
    }

    // Get current repo root
    const repoRoot = session.worktreeInfo?.repoRoot || await getRepositoryRoot(session.workingDir);

    // Find the worktree
    const worktrees = await listWorktrees(repoRoot);
    const target = worktrees.find(wt =>
      wt.branch === branchOrPath ||
      wt.path === branchOrPath ||
      wt.path.endsWith(branchOrPath)
    );

    if (!target) {
      await this.mattermost.createPost(
        `❌ Worktree not found: \`${branchOrPath}\`. Use \`!worktree list\` to see available worktrees.`,
        threadId
      );
      return;
    }

    // Use changeDirectory logic to switch
    await this.changeDirectory(threadId, target.path, username);

    // Update worktree info
    session.worktreeInfo = {
      repoRoot,
      worktreePath: target.path,
      branch: target.branch,
    };

    // Update session header
    await this.updateSessionHeader(session);
    this.persistSession(session);
  }

  /**
   * List all worktrees for the current repository.
   */
  async listWorktreesCommand(threadId: string, _username: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Check if we're in a git repo
    const isRepo = await isGitRepository(session.workingDir);
    if (!isRepo) {
      await this.mattermost.createPost(
        `❌ Current directory is not a git repository`,
        threadId
      );
      return;
    }

    // Get repo root (either from worktree info or current dir)
    const repoRoot = session.worktreeInfo?.repoRoot || await getRepositoryRoot(session.workingDir);
    const worktrees = await listWorktrees(repoRoot);

    if (worktrees.length === 0) {
      await this.mattermost.createPost(
        `📋 No worktrees found for this repository`,
        threadId
      );
      return;
    }

    const shortRepoRoot = repoRoot.replace(process.env.HOME || '', '~');
    let message = `📋 **Worktrees for** \`${shortRepoRoot}\`:\n\n`;

    for (const wt of worktrees) {
      const shortPath = wt.path.replace(process.env.HOME || '', '~');
      const isCurrent = session.workingDir === wt.path;
      const marker = isCurrent ? ' ← current' : '';
      const label = wt.isMain ? '(main repository)' : '';
      message += `• \`${wt.branch}\` → \`${shortPath}\` ${label}${marker}\n`;
    }

    await this.mattermost.createPost(message, threadId);
  }

  /**
   * Remove a worktree.
   */
  async removeWorktreeCommand(threadId: string, branchOrPath: string, username: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Only session owner or admins can manage worktrees
    if (session.startedBy !== username && !this.mattermost.isUserAllowed(username)) {
      await this.mattermost.createPost(
        `⚠️ Only @${session.startedBy} or allowed users can manage worktrees`,
        threadId
      );
      return;
    }

    // Get current repo root
    const repoRoot = session.worktreeInfo?.repoRoot || await getRepositoryRoot(session.workingDir);

    // Find the worktree
    const worktrees = await listWorktrees(repoRoot);
    const target = worktrees.find(wt =>
      wt.branch === branchOrPath ||
      wt.path === branchOrPath ||
      wt.path.endsWith(branchOrPath)
    );

    if (!target) {
      await this.mattermost.createPost(
        `❌ Worktree not found: \`${branchOrPath}\`. Use \`!worktree list\` to see available worktrees.`,
        threadId
      );
      return;
    }

    // Can't remove the main repository
    if (target.isMain) {
      await this.mattermost.createPost(
        `❌ Cannot remove the main repository. Use \`!worktree remove\` only for worktrees.`,
        threadId
      );
      return;
    }

    // Can't remove the current working directory
    if (session.workingDir === target.path) {
      await this.mattermost.createPost(
        `❌ Cannot remove the current working directory. Switch to another worktree first.`,
        threadId
      );
      return;
    }

    try {
      await removeGitWorktree(repoRoot, target.path);

      const shortPath = target.path.replace(process.env.HOME || '', '~');
      await this.mattermost.createPost(
        `✅ Removed worktree \`${target.branch}\` at \`${shortPath}\``,
        threadId
      );

      console.log(`  🗑️ Removed worktree ${target.branch} at ${shortPath}`);
    } catch (err) {
      console.error(`  ❌ Failed to remove worktree:`, err);
      await this.mattermost.createPost(
        `❌ Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`,
        threadId
      );
    }
  }

  /**
   * Disable worktree prompts for a session.
   */
  async disableWorktreePrompt(threadId: string, username: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;

    // Only session owner or admins can manage worktrees
    if (session.startedBy !== username && !this.mattermost.isUserAllowed(username)) {
      await this.mattermost.createPost(
        `⚠️ Only @${session.startedBy} or allowed users can manage worktrees`,
        threadId
      );
      return;
    }

    session.worktreePromptDisabled = true;
    this.persistSession(session);

    await this.mattermost.createPost(
      `✅ Worktree prompts disabled for this session`,
      threadId
    );
  }

  /**
   * Check if a session has a pending worktree prompt.
   */
  hasPendingWorktreePrompt(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    return session?.pendingWorktreePrompt === true;
  }

  /**
   * Get the worktree prompt post ID for a session.
   */
  getWorktreePromptPostId(threadId: string): string | undefined {
    const session = this.sessions.get(threadId);
    return session?.worktreePromptPostId;
  }

  /** Kill all active sessions (for graceful shutdown) */
  killAllSessions(): void {
    console.log(`  [shutdown] killAllSessions called, isShuttingDown already=${this.isShuttingDown}`);
    // Set shutdown flag to suppress exit messages (should already be true from setShuttingDown)
    this.isShuttingDown = true;

    const count = this.sessions.size;
    console.log(`  [shutdown] About to kill ${count} session(s) (preserving persistence for resume)`);

    // Kill each session WITHOUT unpersisting - we want them to resume after restart
    for (const [threadId] of this.sessions.entries()) {
      this.killSession(threadId, false);  // false = don't unpersist
    }

    // Maps should already be cleared by killSession, but clear again to be safe
    this.sessions.clear();
    this.postIndex.clear();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (count > 0) {
      console.log(`  ✖ Killed ${count} session${count === 1 ? '' : 's'} (sessions preserved for resume)`);
    }
  }

  /** Kill all sessions AND unpersist them (for emergency shutdown - no resume) */
  killAllSessionsAndUnpersist(): void {
    this.isShuttingDown = true;
    const count = this.sessions.size;

    // Kill each session WITH unpersisting - emergency shutdown, no resume
    for (const [threadId] of this.sessions.entries()) {
      this.killSession(threadId, true);  // true = unpersist
    }

    this.sessions.clear();
    this.postIndex.clear();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (count > 0) {
      console.log(`  🔴 Emergency killed ${count} session${count === 1 ? '' : 's'} (sessions NOT preserved)`);
    }
  }

  /** Cleanup idle sessions that have exceeded timeout */
  private cleanupIdleSessions(): void {
    const now = Date.now();
    const warningThreshold = SESSION_TIMEOUT_MS - SESSION_WARNING_MS;

    for (const [threadId, session] of this.sessions.entries()) {
      const idleTime = now - session.lastActivityAt.getTime();

      // Check if we should time out
      if (idleTime > SESSION_TIMEOUT_MS) {
        const mins = Math.round(idleTime / 60000);
        const shortId = threadId.substring(0, 8);
        console.log(`  ⏰ Session (${shortId}…) timed out after ${mins}m idle`);
        this.mattermost.createPost(
          `⏰ **Session timed out** — no activity for ${mins} minutes`,
          session.threadId
        ).catch(() => {});
        this.killSession(threadId);
      }
      // Check if we should show warning (only once)
      else if (idleTime > warningThreshold && !session.timeoutWarningPosted) {
        const remainingMins = Math.round((SESSION_TIMEOUT_MS - idleTime) / 60000);
        const shortId = threadId.substring(0, 8);
        console.log(`  ⚠️ Session (${shortId}…) warning: ${remainingMins}m until timeout`);
        this.mattermost.createPost(
          `⚠️ **Session idle** — will time out in ~${remainingMins} minutes. Send a message to keep it alive.`,
          session.threadId
        ).catch(() => {});
        session.timeoutWarningPosted = true;
      }
    }
  }
}
