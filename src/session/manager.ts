/**
 * SessionManager - Orchestrates Claude Code sessions across chat platforms
 *
 * This is the main coordinator that delegates to specialized modules:
 * - lifecycle.ts: Session start, resume, exit
 * - streaming.ts: Message streaming and flushing
 * - operations/events: Claude event handling
 * - operations/commands: User commands (!cd, !invite, etc.)
 * - operations/worktree: Git worktree management
 *
 * User reactions are handled via MessageManager.handleReaction() which routes
 * to the appropriate executor (QuestionApprovalExecutor, TaskListExecutor, etc.)
 */

import { EventEmitter } from 'events';
import { ClaudeEvent } from '../claude/cli.js';
import type { ClaudeCli } from '../claude/cli.js';
import type { PlatformClient, PlatformUser, PlatformPost, PlatformFile } from '../platform/index.js';
import { SessionStore, PersistedSession, PersistedContextPrompt } from '../persistence/session-store.js';
import type { PersistedTrackedTask } from '../operations/task-tracker.js';
import { GitHubEmailsStore } from '../persistence/github-emails-store.js';
import { WorktreeMode, type LimitsConfig, type ResolvedLimits, type ClaudeAccount, type PermissionMode, type OverheadVisibility, type PlatformOverhead, type ResolvedMemoryConfig, DEFAULT_OVERHEAD_VISIBILITY, DEFAULT_TURN_MARKER, DEFAULT_MEMORY_CONFIG, resolveLimits, effectivePermissionMode } from '../config/index.js';
import { MemoryStore } from '../memory/store.js';
import { RoutinesStore, type Routine, type RoutineRunStatus } from '../persistence/routines-store.js';
import { WatchesStore } from '../persistence/watches-store.js';
import { WatchEvaluator } from '../watches/evaluator.js';
import { fireWatch } from '../watches/runner.js';
import { RoutineScheduler } from '../routines/scheduler.js';
import { fireRoutine } from '../routines/runner.js';
import { AccountPool } from '../claude/account-pool.js';
import { probeAccountUsage } from '../claude/usage-probe.js';
import type { SessionInfo } from '../ui/types.js';
import { CleanupScheduler } from '../cleanup/index.js';
import { SessionMonitor } from '../operations/monitor/index.js';

// Import extracted modules
import * as streaming from '../operations/streaming/index.js';
import type { Transcriber } from '../transcription/index.js';
import * as events from '../operations/events/index.js';
import * as commands from '../operations/commands/index.js';
import * as lifecycle from './lifecycle.js';
import { CHAT_PLATFORM_PROMPT } from './lifecycle.js';
import * as worktreeModule from '../operations/worktree/index.js';
import * as contextPrompt from '../operations/context-prompt/index.js';
import * as stickyMessage from '../operations/sticky-message/index.js';
import * as plugin from '../operations/plugin/index.js';
import type { Session, InitialSessionOptions } from './types.js';
import { maybeInjectMetadataReminder } from './metadata-suggestions.js';
import { compositeSessionId, SessionRegistry } from './registry.js';
import * as reactionRouter from './reaction-router.js';
import { post } from '../operations/post-helpers/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('manager');

// Import unified context
import {
  type SessionContext,
  type SessionConfig,
  type SessionState,
  type SessionOperations,
  createSessionContext,
} from '../operations/session-context/index.js';

// Import constants for internal use
import { getSessionStatus } from './types.js';

/**
 * Per-account cap on a single `/usage` probe (kills a hung child). Below the
 * probe module's own default so one stuck account can't run long.
 */
const USAGE_PROBE_TIMEOUT_MS = 10_000;
/**
 * Hard cap on how long a new-session start blocks waiting for the probe cycle.
 * If a probe is still running at this point the session proceeds anyway; that
 * account keeps its prior/unknown score and the cycle updates it for next time.
 */
const USAGE_REFRESH_DEADLINE_MS = 5_000;
/**
 * Reuse the last probe cycle's results if it finished within this window,
 * instead of re-probing. Coalesces a burst of near-simultaneous session starts
 * onto a single set of `/usage` spawns rather than one set per start.
 */
const USAGE_CACHE_TTL_MS = 15_000;

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
  /** Effective permission mode. Mutated via `setPermissionMode`. */
  private permissionMode: PermissionMode;
  private chromeEnabled: boolean;
  private worktreeMode: WorktreeMode;
  /** Config default for the per-session "respond only when @mentioned" toggle (#402). */
  private respondOnlyWhenMentioned: boolean;
  /** Config default for per-message `[@username]:` attribution on new sessions. */
  private userAttribution: boolean;
  private threadLogsEnabled: boolean;
  private threadLogsRetentionDays: number;
  // Resolved limits configuration
  private readonly limits: ResolvedLimits;
  // Debug is a getter so it reads current process.env.DEBUG (can be toggled at runtime)
  private get debug(): boolean {
    return process.env.DEBUG === '1' || process.argv.includes('--debug');
  }

  // Session registry - tracks active sessions and post mappings
  public readonly registry!: SessionRegistry;

  // Worktree reference counting
  // Key: worktreePath, Value: Set of sessionIds using that worktree
  private worktreeUsers: Map<string, Set<string>> = new Map();

  // Persistence (accessed via registry.getSessionStore())
  private sessionStore!: SessionStore;
  // Per-user GitHub noreply emails (registered via !github-email)
  private githubEmailsStore!: GitHubEmailsStore;
  // Persistent memory (channel layer + repo-layer auto-memory directories)
  private memoryStore!: MemoryStore;
  // Scheduled routines (Claude Tag-style recurring work)
  private routinesStore!: RoutinesStore;
  private routineScheduler: RoutineScheduler | null = null;
  // Event triggers (Claude Tag-style proactiveness)
  private watchesStore!: WatchesStore;
  private watchEvaluator: WatchEvaluator | null = null;

  // Background tasks
  private sessionMonitor: SessionMonitor | null = null;       // Idle timeout + sticky refresh (1 min)
  private backgroundCleanup: CleanupScheduler | null = null;  // Logs + worktrees cleanup (1 hour)

  // Shutdown flag
  private isShuttingDown = false;

  // Sticky message customization
  private customDescription?: string;
  private customFooter?: string;

  // Per-platform overhead visibility (sessionHeader / stickyMessage modes)
  private platformOverhead: Map<string, PlatformOverhead> = new Map();

  // Per-platform resolved memory settings (default: fully enabled)
  private platformMemory: Map<string, ResolvedMemoryConfig> = new Map();

  // Per-platform routines toggle (default: enabled)
  private platformRoutines: Map<string, boolean> = new Map();

  // Per-platform watches toggle (default: enabled)
  private platformWatches: Map<string, boolean> = new Map();

  // Auto-update manager (set via setAutoUpdateManager)
  private autoUpdateManager: commands.AutoUpdateManagerInterface | null = null;

  // Claude account pool (single-account mode when empty)
  private readonly accountPool: AccountPool;
  // On-demand /usage probe coalescing: the in-flight cycle (shared by concurrent
  // session starts) and the epoch ms it last completed (for the TTL skip).
  private usageRefreshInFlight: Promise<void> | null = null;
  private usageRefreshedAt = 0;

  constructor(
    workingDir: string,
    /**
     * Permission mode. Accepts either the new `PermissionMode` string OR the
     * legacy `skipPermissions: boolean` for backward compatibility:
     * - `true`  → 'bypass'
     * - `false` → 'default'
     * - omitted → 'default'
     */
    permissionModeOrSkipFlag: PermissionMode | boolean = 'default',
    chromeEnabled = false,
    worktreeMode: WorktreeMode = 'prompt',
    sessionsPath?: string,
    threadLogsEnabled = true,
    threadLogsRetentionDays = 30,
    limits?: LimitsConfig,
    claudeAccounts?: ClaudeAccount[],
    respondOnlyWhenMentioned = false,
    userAttribution = true
  ) {
    super();
    this.workingDir = workingDir;
    this.permissionMode =
      typeof permissionModeOrSkipFlag === 'boolean'
        ? (permissionModeOrSkipFlag ? 'bypass' : 'default')
        : permissionModeOrSkipFlag;
    this.chromeEnabled = chromeEnabled;
    this.worktreeMode = worktreeMode;
    this.respondOnlyWhenMentioned = respondOnlyWhenMentioned;
    this.userAttribution = userAttribution;
    this.threadLogsEnabled = threadLogsEnabled;
    this.threadLogsRetentionDays = threadLogsRetentionDays;
    this.limits = resolveLimits(limits);
    this.sessionStore = new SessionStore(sessionsPath);
    this.githubEmailsStore = new GitHubEmailsStore();
    this.memoryStore = new MemoryStore();
    this.routinesStore = new RoutinesStore();
    this.watchesStore = new WatchesStore();
    this.registry = new SessionRegistry(this.sessionStore);
    this.accountPool = new AccountPool(claudeAccounts);

    // Create background tasks (started in initialize())
    this.sessionMonitor = new SessionMonitor({
      sessionTimeoutMs: this.limits.sessionTimeoutMinutes * 60 * 1000,
      sessionWarningMs: this.limits.sessionWarningMinutes * 60 * 1000,
      getContext: () => this.getContext(),
      getSessionCount: () => this.registry.size,
      updateStickyMessage: () => this.updateStickyMessage(),
    });

    this.backgroundCleanup = new CleanupScheduler({
      sessionStore: this.sessionStore,
      threadLogsEnabled: this.threadLogsEnabled,
      logRetentionDays: this.threadLogsRetentionDays,
      intervalMs: this.limits.cleanupIntervalMinutes * 60 * 1000,
      maxWorktreeAgeMs: this.limits.maxWorktreeAgeHours * 60 * 60 * 1000,
      cleanupWorktrees: this.limits.cleanupWorktrees,
    });

    this.routineScheduler = new RoutineScheduler({
      store: this.routinesStore,
      listPlatformIds: () => Array.from(this.platforms.keys()),
      isRoutinesEnabled: (pid) => this.platformRoutines.get(pid) ?? true,
      fireRoutine: (pid, routine) => fireRoutine(routine, pid, this.getContext()),
      notifyDisabled: async (pid, routine, reason) => {
        const platform = this.platforms.get(pid);
        if (!platform) return;
        const formatter = platform.getFormatter();
        await platform.createPost(
          `🕘 ${formatter.formatBold(`Routine "${routine.name}" disabled`)} — ${reason}. ` +
          `Re-enable with ${formatter.formatCode('!routines resume <n>')} once resolved.`,
        ).catch(() => {});
      },
    });

    this.watchEvaluator = new WatchEvaluator({
      store: this.watchesStore,
      isWatchesEnabled: (pid) => this.platformWatches.get(pid) ?? true,
      fireWatch: (pid, watch, post, author, matched) =>
        fireWatch(watch, pid, post, author, this.getContext(), matched),
      notifyDisabled: async (pid, watch, reason) => {
        const platform = this.platforms.get(pid);
        if (!platform) return;
        const formatter = platform.getFormatter();
        await platform.createPost(
          `\u{1F441}\uFE0F ${formatter.formatBold(`Watch "${watch.name}" disabled`)} — ${reason}. ` +
          `Re-enable with ${formatter.formatCode('!watches resume <n>')} once resolved.`,
        ).catch(() => {});
      },
      cooldownMs: this.limits.watchCooldownMinutes * 60 * 1000,
      dailyCap: this.limits.watchDailyCap,
    });
  }

  // ---------------------------------------------------------------------------
  // Platform Management
  // ---------------------------------------------------------------------------

  addPlatform(
    platformId: string,
    client: PlatformClient,
    // A keyed options object, not positional params: the tail used to be
    // two adjacent optional booleans, and a transposed call site would have
    // silently enabled the wrong feature per platform.
    options?: {
      overhead?: Partial<PlatformOverhead>;
      memory?: ResolvedMemoryConfig;
      routinesEnabled?: boolean;
      watchesEnabled?: boolean;
      transcriptionEnabled?: boolean;
    },
  ): void {
    this.platforms.set(platformId, client);
    this.platformOverhead.set(platformId, {
      sessionHeader: options?.overhead?.sessionHeader ?? DEFAULT_OVERHEAD_VISIBILITY,
      stickyMessage: options?.overhead?.stickyMessage ?? DEFAULT_OVERHEAD_VISIBILITY,
      turnMarker: options?.overhead?.turnMarker ?? DEFAULT_TURN_MARKER,
    });
    this.platformMemory.set(platformId, options?.memory ?? DEFAULT_MEMORY_CONFIG);
    this.platformRoutines.set(platformId, options?.routinesEnabled ?? true);
    this.platformWatches.set(platformId, options?.watchesEnabled ?? true);
    this.platformTranscription.set(platformId, options?.transcriptionEnabled ?? true);
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
    // Bump sticky message to bottom when someone posts in the channel.
    // Hidden-sticky platforms skip the bump so we don't pay the cost for
    // nothing (the hidden-mode short-circuit in updateStickyMessageImpl would
    // bail anyway, but markNeedsBump leaves stale state otherwise).
    client.on('channel_post', () => {
      if (this.platformOverhead.get(platformId)?.stickyMessage === 'hidden') {
        return;
      }
      stickyMessage.markNeedsBump(platformId);
      this.updateStickyMessage();
    });
    log.info(`📡 Platform "${platformId}" registered`);
  }

  removePlatform(platformId: string): void {
    this.platforms.delete(platformId);
    this.platformOverhead.delete(platformId);
    this.platformMemory.delete(platformId);
    this.platformRoutines.delete(platformId);
    this.platformWatches.delete(platformId);
    stickyMessage.clearHiddenCleanupTracking(platformId);
  }

  /**
   * Set the auto-update manager for update commands.
   */
  setAutoUpdateManager(manager: typeof this.autoUpdateManager): void {
    this.autoUpdateManager = manager;
  }

  // ---------------------------------------------------------------------------
  // Worktree Reference Counting
  // ---------------------------------------------------------------------------

  /**
   * Register a session as using a worktree.
   * Called when a session creates or joins a worktree.
   */
  private registerWorktreeUser(worktreePath: string, sessionId: string): void {
    if (!this.worktreeUsers.has(worktreePath)) {
      this.worktreeUsers.set(worktreePath, new Set());
    }
    const users = this.worktreeUsers.get(worktreePath);
    if (users) {
      users.add(sessionId);
    }
    log.debug(`Registered session ${sessionId.substring(0, 20)} as worktree user for ${worktreePath}`);
  }

  /**
   * Unregister a session from using a worktree.
   * Called when a session ends or switches worktrees.
   */
  private unregisterWorktreeUser(worktreePath: string, sessionId: string): void {
    const users = this.worktreeUsers.get(worktreePath);
    if (users) {
      users.delete(sessionId);
      if (users.size === 0) {
        this.worktreeUsers.delete(worktreePath);
      }
    }
  }

  /**
   * Check if other sessions are using a worktree (besides the given session).
   * Used by cleanupWorktree to determine if safe to delete.
   */
  hasOtherSessionsUsingWorktree(worktreePath: string, excludeSessionId: string): boolean {
    const users = this.worktreeUsers.get(worktreePath);
    if (!users) return false;
    // Check if any session other than excludeSessionId is using this worktree
    return Array.from(users).some(id => id !== excludeSessionId);
  }

  // ---------------------------------------------------------------------------
  // Unified Context Builder
  // ---------------------------------------------------------------------------

  /**
   * Build the unified SessionContext that all modules receive.
   * This replaces the previous 4 separate context builders.
   *
   * Made public to allow direct access from message-handler.ts,
   * enabling elimination of thin wrapper methods.
   */
  /**
   * Run `fn` against the active session for a thread; silently a no-op when
   * none exists — the shared prologue of ~40 thread-addressed delegate
   * methods below.
   */
  private async withSession(threadId: string, fn: (session: Session) => Promise<unknown> | unknown): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await fn(session);
  }

  getContext(): SessionContext {
    const config: SessionConfig = {
      workingDir: this.workingDir,
      permissionMode: this.permissionMode,
      chromeEnabled: this.chromeEnabled,
      respondOnlyWhenMentioned: this.respondOnlyWhenMentioned,
      userAttribution: this.userAttribution,
      debug: this.debug,
      maxSessions: this.limits.maxSessions,
      maxRoutines: this.limits.maxRoutines,
      maxWatches: this.limits.maxWatches,
      threadLogsEnabled: this.threadLogsEnabled,
      threadLogsRetentionDays: this.threadLogsRetentionDays,
      permissionTimeoutMs: this.limits.permissionTimeoutSeconds * 1000,
      flushDelayMs: this.limits.flushDelayMs,
    };

    const state: SessionState = {
      sessions: this.registry.getSessions(),
      postIndex: this.registry.getPostIndex(),
      platforms: this.platforms,
      sessionStore: this.sessionStore,
      githubEmailsStore: this.githubEmailsStore,
      memoryStore: this.memoryStore,
      routinesStore: this.routinesStore,
      watchesStore: this.watchesStore,
      isShuttingDown: this.isShuttingDown,
    };

    const ops: SessionOperations = {
      // Session lookup
      getSessionId: (pid, tid) => this.getSessionId(pid, tid),
      findSessionByThreadId: (tid) => this.findSessionByThreadId(tid),

      // Post management
      registerPost: (pid, tid) => this.registerPost(pid, tid),

      // Streaming & content (inlined - no wrapper methods needed)
      flush: async (s) => {
        // Delegate to MessageManager (source of truth for content flushing)
        if (s.messageManager) {
          await s.messageManager.flush();
        }
      },
      startTyping: (s) => this.startTyping(s),
      stopTyping: (s) => this.stopTyping(s),
      buildMessageContent: (t, p, uploadDir, f) =>
        streaming.buildMessageContent(t, p, uploadDir, f, this.debug, this.transcriberFor(p.platformId)),

      // Persistence
      persistSession: (s) => this.persistSession(s),
      unpersistSession: (sid) => this.unpersistSession(sid),
      recordSessionStarted: () => this.sessionStore.recordSessionStarted(),

      // UI updates
      updateSessionHeader: (s) => this.updateSessionHeader(s),
      updateStickyMessage: () => this.updateStickyMessage(),

      // Event handling
      handleEvent: (sid, e) => this.handleEvent(sid, e),
      handleExit: (sid, code, source) => this.handleExit(sid, code, source),

      // Session lifecycle
      killSession: (tid) => this.killSession(tid),

      // Worktree
      shouldPromptForWorktree: (s) => this.shouldPromptForWorktree(s),
      postWorktreePrompt: (s, r) => this.postWorktreePrompt(s, r),
      registerWorktreeUser: (path, sid) => this.registerWorktreeUser(path, sid),
      unregisterWorktreeUser: (path, sid) => this.unregisterWorktreeUser(path, sid),
      hasOtherSessionsUsingWorktree: (path, sid) => this.hasOtherSessionsUsingWorktree(path, sid),
      switchToWorktree: (tid, path, user) => this.switchToWorktree(tid, path, user),

      // Update operations
      forceUpdate: () => this.autoUpdateManager?.forceUpdate() ?? Promise.resolve(),
      deferUpdate: (min) => this.autoUpdateManager?.deferUpdate(min),

      // Bug report operations
      handleBugReportApproval: (s, approved, user) => commands.handleBugReportApproval(s, approved, user),

      // Context prompt (inlined - no wrapper method needed)
      offerContextPrompt: (s, q, f, e, sender, autoInclude) => contextPrompt.offerContextPrompt(s, q, f, this.getContextPromptHandler(), e, sender, autoInclude),

      // UI event emission
      emitSessionAdd: (s) => this.emitSessionAdd(s),
      emitSessionUpdate: (sid, u) => this.emitSessionUpdate(sid, u),
      emitSessionRemove: (sid) => this.emitSessionRemove(sid),

      // Claude account pool (null when single-account mode)
      acquireClaudeAccount: (preferredId, threadId, opts) =>
        this.accountPool.acquire(preferredId, threadId, opts),
      refreshClaudeAccountUsage: () => this.refreshAccountUsage(),
      getClaudeAccount: (id) => this.accountPool.get(id),
      releaseClaudeAccount: (id) => this.accountPool.release(id),
      markClaudeAccountCooling: (id, untilMs) => this.accountPool.markCooling(id, untilMs),
      getClaudeAccountPoolStatus: () => this.accountPool.status(),

      getPlatformOverhead: (pid) => this.platformOverhead.get(pid) ?? {
        sessionHeader: DEFAULT_OVERHEAD_VISIBILITY,
        stickyMessage: DEFAULT_OVERHEAD_VISIBILITY,
        turnMarker: DEFAULT_TURN_MARKER,
      },

      getPlatformMemoryConfig: (pid) => this.platformMemory.get(pid) ?? DEFAULT_MEMORY_CONFIG,

      isRoutinesEnabled: (pid) => this.platformRoutines.get(pid) ?? true,

      fireRoutineNow: (pid, routine) => this.fireRoutineNowImpl(pid, routine),

      isWatchesEnabled: (pid) => this.platformWatches.get(pid) ?? true,
    };

    return createSessionContext(config, state, ops);
  }

  // ---------------------------------------------------------------------------
  // Session ID and Post Index
  // ---------------------------------------------------------------------------

  private getSessionId(platformId: string, threadId: string): string {
    return compositeSessionId(platformId, threadId);
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
      displayName: session.startedByDisplayName,
      status: getSessionStatus(session),
      workingDir: session.workingDir,
      sessionNumber: session.sessionNumber,
      worktreeBranch: session.worktreeInfo?.branch,
      // Platform information
      platformType: session.platform.platformType as 'mattermost' | 'slack',
      platformDisplayName: session.platform.displayName,
      // Rich metadata
      title: session.sessionTitle,
      description: session.sessionDescription,
      lastActivity: session.lastActivityAt,
      // Typing indicator state
      isTyping: session.timers.typingTimer !== null,
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
    this.registry.registerPost(postId, threadId);
  }

  private getSessionByPost(postId: string): Session | undefined {
    return this.registry.findByPost(postId);
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
  //
  // Delegated to `reaction-router.ts`. The router handles:
  // - emoji normalization (`thumbsup` vs `+1`)
  // - resume-from-reaction for timed-out sessions
  // - allowlist check + audit log
  // - session-level reactions (cancel, escape, worktree, bug report)
  // - MessageManager delegation for executor-owned reactions
  // ---------------------------------------------------------------------------

  private async handleReaction(
    platformId: string,
    postId: string,
    emojiName: string,
    username: string,
    action: 'added' | 'removed',
  ): Promise<void> {
    await reactionRouter.handleReaction(
      this.getReactionRouterDeps(),
      platformId,
      postId,
      emojiName,
      username,
      action,
    );
  }

  private getReactionRouterDeps(): reactionRouter.ReactionRouterDeps {
    return {
      registry: this.registry,
      sessionStore: this.sessionStore,
      platforms: this.platforms,
      limits: this.limits,
      getContext: () => this.getContext(),
      getContextPromptHandler: () => this.getContextPromptHandler(),
      persistSession: (s) => this.persistSession(s),
      createAndSwitchToWorktree: (tid, branch, user) =>
        this.createAndSwitchToWorktree(tid, branch, user),
    };
  }

  // ---------------------------------------------------------------------------
  // Context Prompt Handling
  // ---------------------------------------------------------------------------

  private getContextPromptHandler(): contextPrompt.ContextPromptHandler {
    return {
      registerPost: (pid, tid) => this.registerPost(pid, tid),
      startTyping: (s) => this.startTyping(s),
      persistSession: (s) => this.persistSession(s),
      injectMetadataReminder: (msg, session) => maybeInjectMetadataReminder(msg, session),
      buildMessageContent: (text, session, files) => {
        const uploadDir = streaming.getSessionUploadDir(session.platformId, session.threadId);
        return streaming.buildMessageContent(text, session.platform, uploadDir, files, this.debug, this.transcriberFor(session.platform.platformId));
      },
    };
  }

  // Note: offerContextPrompt() has been inlined directly in getContext().ops

  /**
   * Check if session has a pending context prompt.
   */
  hasPendingContextPrompt(threadId: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    return session?.messageManager?.hasPendingContextPrompt() ?? false;
  }

  // ---------------------------------------------------------------------------
  // Event Handling (delegates to MessageManager)
  // ---------------------------------------------------------------------------

  private handleEvent(sessionId: string, event: ClaudeEvent): void {
    const session = this.registry.get(sessionId);
    if (!session || !session.messageManager) return;

    // Pre-processing: session-specific side effects
    events.handleEventPreProcessing(session, event, this.getContext());

    // Main event handling via MessageManager
    const mainHandling = session.messageManager.handleEvent(event);

    // Post-processing: session-specific side effects. Receives the main
    // handling promise so turn-end persistence can wait for the operation
    // chain (incl. task-list finalize) to settle before snapshotting.
    events.handleEventPostProcessing(session, event, this.getContext(), mainHandling);
  }

  // ---------------------------------------------------------------------------
  // Exit Handling (delegates to lifecycle module)
  // ---------------------------------------------------------------------------

  private async handleExit(sessionId: string, code: number, source?: ClaudeCli): Promise<void> {
    await lifecycle.handleExit(sessionId, code, this.getContext(), source);
  }

  // ---------------------------------------------------------------------------
  // Streaming utilities
  // ---------------------------------------------------------------------------
  // Note: flush(), buildMessageContent(), and bumpTasksToBottom() have been
  // inlined directly in getContext().ops to eliminate thin wrapper methods.
  // Only startTyping() and stopTyping() remain as they have meaningful UI logic.

  private startTyping(session: Session): void {
    const wasTyping = session.timers.typingTimer !== null;
    streaming.startTyping(session);
    // Emit UI update if typing state changed
    if (!wasTyping && session.timers.typingTimer !== null) {
      this.emitSessionUpdate(session.sessionId, { isTyping: true });
    }
  }

  private stopTyping(session: Session): void {
    const wasTyping = session.timers.typingTimer !== null;
    streaming.stopTyping(session);
    // Emit UI update if typing state changed
    if (wasTyping && session.timers.typingTimer === null) {
      this.emitSessionUpdate(session.sessionId, { isTyping: false });
    }
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
    for (const session of this.registry.getAll()) {
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

  /**
   * Bound a free-text field before it enters sessions.json. The whole file is
   * rewritten (JSON.stringify) on every mutation, so an unbounded user prompt
   * would inflate every subsequent atomic rewrite. The cap is deliberately
   * generous — far above any real prompt — so it only trims pathological
   * multi-megabyte input and never a genuine message. A short marker records
   * that truncation happened.
   */
  private static readonly MAX_PERSISTED_TEXT = 100_000;
  private static capPersistedText(value: string | undefined | null): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (value.length <= SessionManager.MAX_PERSISTED_TEXT) return value;
    return value.slice(0, SessionManager.MAX_PERSISTED_TEXT) + '…[truncated]';
  }

  private persistSession(session: Session): void {
    try {
      this.persistSessionUnsafe(session);
    } catch (err) {
      // Persistence runs on hot paths (every turn end, synchronously inside
      // the CLI 'event' listener chain) — an fs error (ENOSPC, EACCES) must
      // be logged, never thrown: a throw would propagate into callers that
      // treat listener errors as stream noise.
      log.error(`Failed to persist session ${session.sessionId}: ${err}`);
    }
  }

  private persistSessionUnsafe(session: Session): void {
    // Aggregate every executor's persistable state in one call. Byte-parity
    // with the pre-PR-3 writer is guarded by the snapshot tests in
    // `manager.test.ts` — adding a field here without updating the snapshot
    // expected-keys set will fail CI.
    let taskListSnapshot:
      | { postId: string | null; content: string | null; isMinimized: boolean; isCompleted: boolean }
      | undefined;
    let contextPromptSnapshot: PersistedContextPrompt | undefined;
    let taskTrackerSnapshot: PersistedTrackedTask[] | undefined;

    if (session.messageManager) {
      const serialized = session.messageManager.serialize();
      taskListSnapshot = serialized.taskList;
      taskTrackerSnapshot = serialized.taskTracker;
      if (serialized.contextPrompt) {
        contextPromptSnapshot = serialized.contextPrompt;
      }
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
      respondOnlyWhenMentioned: session.respondOnlyWhenMentioned,
      userAttribution: session.userAttribution,
      sessionStartPostId: session.sessionStartPostId,
      // Task state from MessageManager serialize() (single source of truth).
      tasksPostId: taskListSnapshot?.postId ?? null,
      lastTasksContent: SessionManager.capPersistedText(taskListSnapshot?.content) ?? null,
      tasksCompleted: taskListSnapshot?.isCompleted ?? false,
      tasksMinimized: taskListSnapshot?.isMinimized ?? false,
      taskTrackerState: taskTrackerSnapshot,
      worktreeInfo: session.worktreeInfo,
      isWorktreeOwner: session.isWorktreeOwner,
      pendingWorktreePrompt: session.pendingWorktreePrompt,
      worktreePromptDisabled: session.worktreePromptDisabled,
      queuedPrompt: SessionManager.capPersistedText(session.queuedPrompt),
      queuedByUsername: session.queuedByUsername,
      queuedFiles: session.queuedFiles,
      firstPrompt: SessionManager.capPersistedText(session.firstPrompt),
      pendingContextPrompt: contextPromptSnapshot,
      needsContextPromptOnNextMessage: session.needsContextPromptOnNextMessage,
      lifecyclePostId: session.lifecyclePostId,
      isPaused: session.lifecycle.state === 'paused' || session.lifecycle.state === 'interrupted',
      sessionTitle: session.sessionTitle,
      sessionDescription: session.sessionDescription,
      sessionTags: session.sessionTags,
      pullRequestUrl: session.pullRequestUrl,
      messageCount: session.messageCount,
      resumeFailCount: session.lifecycle.resumeFailCount,
      claudeAccountId: session.claudeAccountId,
      sessionHeaderMode: session.sessionHeaderMode,
      unattended: session.unattended,
    };
    this.sessionStore.save(session.sessionId, state);
  }

  private unpersistSession(sessionId: string): void {
    // Soft-delete instead of hard delete - keeps session in history for display.
    // `'stopped'`: this is the sink for a session that ENDED — !stop, a kill, a
    // normal exit. killSession has already distilled it as finished, so the
    // next message in that thread must start fresh rather than revive it.
    this.sessionStore.softDelete(sessionId, 'stopped');
  }

  // ---------------------------------------------------------------------------
  // Session Header
  // ---------------------------------------------------------------------------

  private async updateSessionHeader(session: Session): Promise<void> {
    await commands.updateSessionHeader(session, this.getContext());
    // Also emit UI update for fields that may have changed (worktree, directory, etc.)
    this.emitSessionUpdate(session.sessionId, {
      workingDir: session.workingDir,
      worktreeBranch: session.worktreeInfo?.branch,
      title: session.sessionTitle,
      description: session.sessionDescription,
    });
  }

  // ---------------------------------------------------------------------------
  // Sticky Channel Message
  // ---------------------------------------------------------------------------

  private async updateStickyMessage(): Promise<void> {
    const overheadByPlatform = new Map<string, OverheadVisibility>();
    for (const [platformId, overhead] of this.platformOverhead) {
      overheadByPlatform.set(platformId, overhead.stickyMessage);
    }
    await stickyMessage.updateAllStickyMessages(
      this.platforms,
      this.registry.getSessions(),
      {
        maxSessions: this.limits.maxSessions,
        chromeEnabled: this.chromeEnabled,
        permissionMode: this.permissionMode,
        worktreeMode: this.worktreeMode,
        workingDir: this.workingDir,
        debug: this.debug,
        description: this.customDescription,
        footer: this.customFooter,
        accountPoolStatus: this.accountPool.isEmpty ? undefined : this.accountPool.status(),
      },
      overheadByPlatform,
    );
  }

  /**
   * Public method to trigger sticky message update.
   * Called when runtime settings change via keyboard toggles.
   */
  async updateAllStickyMessages(): Promise<void> {
    await this.updateStickyMessage();
  }

  // ---------------------------------------------------------------------------
  // Runtime settings (called from keyboard toggles or config)
  // ---------------------------------------------------------------------------

  /** Set custom description and footer for the sticky channel message. */
  /** Speech-to-text for inbound audio attachments; unset = audio is a plain file. */
  private transcriber?: Transcriber;
  private platformTranscription: Map<string, boolean> = new Map();

  /**
   * The transcriber for one platform, or undefined where the channel opted
   * out with `transcription: false`.
   *
   * The provider is a property of the deployment and the consent is a
   * property of the channel, so the gate lives here rather than inside the
   * transcriber: a channel whose audio must not leave the box says so once,
   * and every path that could send a file to the vendor goes through this.
   */
  private transcriberFor(platformId: string): Transcriber | undefined {
    return this.platformTranscription.get(platformId) === false ? undefined : this.transcriber;
  }

  setTranscriber(transcriber: Transcriber | undefined): void {
    this.transcriber = transcriber;
  }

  setStickyMessageCustomization(description?: string, footer?: string): void {
    this.customDescription = description;
    this.customFooter = footer;
  }

  /**
   * Set the effective permission mode.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /**
   * @deprecated Use `setPermissionMode` instead. Kept so the headless/UI
   * toggle entry points don't need to change in lockstep. Maps
   * `true → 'bypass'`, `false → 'default'`; the `'auto'` mode must be set
   * via `setPermissionMode`.
   */
  setSkipPermissions(value: boolean): void {
    this.permissionMode = value ? 'bypass' : 'default';
  }

  /** Read the effective permission mode (for UI + event payloads). */
  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setChromeEnabled(value: boolean): void {
    this.chromeEnabled = value;
  }

  // ---------------------------------------------------------------------------
  // Platform Toggle Support
  // ---------------------------------------------------------------------------

  /**
   * Pause all active sessions for a platform.
   * Called when a platform is disabled via keyboard toggle.
   * Sessions are persisted and can be resumed when platform is re-enabled.
   */
  async pauseSessionsForPlatform(platformId: string): Promise<void> {
    // Mark platform as paused in sticky message module
    stickyMessage.setPlatformPaused(platformId, true);

    const sessionsToKill: Session[] = [];

    for (const session of this.registry.getAll()) {
      if (session.platformId === platformId) {
        sessionsToKill.push(session);
      }
    }

    if (sessionsToKill.length === 0) {
      log.info(`No active sessions to pause for platform ${platformId}`);
      // Still update sticky message to show paused state
      await this.updateStickyMessage();
      return;
    }

    log.info(`⏸️ Pausing ${sessionsToKill.length} session(s) for platform ${platformId}`);

    for (const session of sessionsToKill) {
      try {
        const fmt = session.platform.getFormatter();
        const pauseMessage = `⏸️ ${fmt.formatBold('Platform disabled')} - session paused. Re-enable platform to resume.`;

        // Update or create lifecycle post
        if (session.lifecyclePostId) {
          await session.platform.updatePost(session.lifecyclePostId, pauseMessage);
        } else {
          const post = await session.platform.createPost(pauseMessage, session.threadId);
          session.lifecyclePostId = post.id;
        }

        // Stop typing indicator
        this.stopTyping(session);

        // Persist session state for later resume
        this.persistSession(session);

        // Kill the Claude CLI process
        session.claude.kill();

        // Remove from active sessions (but keep persisted)
        this.registry.unregister(session.sessionId);

        // Emit UI update
        this.emitSessionRemove(session.sessionId);

        log.info(`⏸️ Paused session ${session.threadId.substring(0, 8)}`);
      } catch (err) {
        log.warn(`Failed to pause session ${session.threadId}: ${err}`);
      }
    }

    // Clear post index entries for paused sessions
    for (const session of sessionsToKill) {
      this.registry.clearPostsForThread(session.threadId);
    }

    // Update sticky message to show paused state
    await this.updateStickyMessage();
  }

  /**
   * Resume all paused sessions for a platform.
   * Called when a platform is re-enabled via keyboard toggle.
   */
  async resumePausedSessionsForPlatform(platformId: string): Promise<void> {
    // Mark platform as active (not paused) in sticky message module
    stickyMessage.setPlatformPaused(platformId, false);
    const persisted = this.sessionStore.load();
    const sessionsToResume: PersistedSession[] = [];

    for (const state of persisted.values()) {
      // Only resume sessions for this platform
      if (state.platformId !== platformId) continue;

      // Skip sessions that are already active
      const sessionId = `${state.platformId}:${state.threadId}`;
      if (this.registry.hasById(sessionId)) continue;

      sessionsToResume.push(state);
    }

    if (sessionsToResume.length === 0) {
      log.info(`No paused sessions to resume for platform ${platformId}`);
      // Still update sticky message to clear paused state
      await this.updateStickyMessage();
      return;
    }

    log.info(`▶️ Resuming ${sessionsToResume.length} paused session(s) for platform ${platformId}`);

    for (const state of sessionsToResume) {
      try {
        await lifecycle.resumeSession(state, this.getContext());
        log.info(`▶️ Resumed session ${state.threadId.substring(0, 8)}`);
      } catch (err) {
        log.warn(`Failed to resume session ${state.threadId}: ${err}`);
      }
    }

    // Update sticky message to clear paused state (sessions trigger their own updates)
    await this.updateStickyMessage();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Probe every pooled account's `/usage` and feed the results into the pool, so
   * the next `acquire({ balanceByUsage: true })` routes on fresh subscription
   * headroom. Called on-demand right before a new session starts — there is no
   * background polling; an idle bot probes nothing.
   *
   * Coalescing keeps this off the critical path:
   * - A cycle that finished within `USAGE_CACHE_TTL_MS` is reused (skip re-probe).
   * - Concurrent session starts share one in-flight cycle rather than each
   *   spawning `claude` for every account (which would be K×N processes).
   * - The caller waits at most `USAGE_REFRESH_DEADLINE_MS`; a slower probe still
   *   updates the pool in the background for the next start.
   *
   * On a failed/timed-out/unparseable probe the account's usage is set to
   * "unknown" (sorts last in selection). This is deliberate under on-demand
   * probing: a genuinely broken account (e.g. logged-out OAuth, which surfaces
   * as an auth error, not a rate-limit, so cooldown never triggers) must be
   * routed around — and a one-off transient failure only costs that single
   * session's pick, since the next start re-probes from scratch.
   *
   * No-op unless the pool has at least two accounts (nothing to balance with fewer).
   */
  private async refreshAccountUsage(): Promise<void> {
    const accounts = this.accountPool.all;
    if (accounts.length < 2) return;
    // Fresh enough — the last cycle's numbers still stand.
    if (Date.now() - this.usageRefreshedAt < USAGE_CACHE_TTL_MS) return;
    // Start a cycle only if one isn't already running; concurrent callers join it.
    if (!this.usageRefreshInFlight) {
      this.usageRefreshInFlight = this.probeAllAccounts(accounts).finally(() => {
        this.usageRefreshedAt = Date.now();
        this.usageRefreshInFlight = null;
      });
    }
    // Bound the hot-path wait; the in-flight cycle keeps updating the pool after.
    await Promise.race([
      this.usageRefreshInFlight,
      new Promise<void>((resolve) => setTimeout(resolve, USAGE_REFRESH_DEADLINE_MS)),
    ]);
  }

  /** Probe every account in parallel, writing each result (or "unknown") to the pool. */
  private async probeAllAccounts(accounts: readonly ClaudeAccount[]): Promise<void> {
    await Promise.all(
      accounts.map(async (acc) => {
        try {
          this.accountPool.setUsage(
            acc.id,
            await probeAccountUsage(acc, { timeoutMs: USAGE_PROBE_TIMEOUT_MS })
          );
        } catch {
          this.accountPool.setUsage(acc.id, null);
        }
      })
    );
  }

  async initialize(): Promise<void> {
    // Initialize sticky message module with session store for persistence
    stickyMessage.initialize(this.sessionStore);

    // Start background tasks
    this.sessionMonitor?.start();
    this.backgroundCleanup?.start();
    this.routineScheduler?.start();

    // Clean up stale sessions that timed out while bot was down
    // Use 2x timeout to be generous (bot might have been down for a while)
    const sessionTimeoutMs = this.limits.sessionTimeoutMinutes * 60 * 1000;
    const staleIds = this.sessionStore.cleanStale(sessionTimeoutMs * 2);
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

    // Gather session header and task list post IDs by platform (to exclude from sticky cleanup)
    // These are pinned posts that belong to active sessions and should NOT be deleted
    const excludePostIdsByPlatform = new Map<string, Set<string>>();
    for (const session of persisted.values()) {
      const platformId = session.platformId;
      let excludeSet = excludePostIdsByPlatform.get(platformId);
      if (!excludeSet) {
        excludeSet = new Set();
        excludePostIdsByPlatform.set(platformId, excludeSet);
      }
      // Exclude session header posts
      if (session.sessionStartPostId) {
        excludeSet.add(session.sessionStartPostId);
      }
      // Exclude task list posts
      if (session.tasksPostId) {
        excludeSet.add(session.tasksPostId);
      }
    }

    // Clean up old sticky messages from the bot (from failed/crashed runs)
    // Run in background - no need to block startup. forceRun=true bypasses throttle.
    // Pass session header and task list post IDs to exclude them from cleanup.
    for (const platform of this.platforms.values()) {
      const excludePostIds = excludePostIdsByPlatform.get(platform.platformId);
      platform.getBotUser().then(botUser => {
        stickyMessage.cleanupOldStickyMessages(platform, botUser.id, true, excludePostIds).catch(err => {
          log.warn(`Failed to cleanup old sticky messages for ${platform.platformId}: ${err}`);
        });
      }).catch(err => {
        log.warn(`Failed to get bot user for cleanup on ${platform.platformId}: ${err}`);
      });
    }

    if (persisted.size > 0) {
      // Split sessions into active (to resume) and paused (to skip)
      // Sessions with isPaused=true were already paused (timeout/interrupt) before bot restart
      const activeToResume: PersistedSession[] = [];
      const pausedToSkip: PersistedSession[] = [];

      for (const state of persisted.values()) {
        if (state.isPaused) {
          // Session was paused (timeout or interrupt) - don't auto-resume
          pausedToSkip.push(state);
        } else {
          // Session was active when bot shut down - resume it
          activeToResume.push(state);
        }
      }

      if (pausedToSkip.length > 0) {
        log.info(`⏸️ ${pausedToSkip.length} session(s) remain paused (waiting for user message)`);
      }

      if (activeToResume.length > 0) {
        log.info(`🔄 Attempting to resume ${activeToResume.length} active session(s)...`);
        for (const state of activeToResume) {
          await lifecycle.resumeSession(state, this.getContext());
        }
      }
    }

    // Refresh sticky message to reflect current state (even if no sessions)
    await this.updateStickyMessage();
  }

  async startSession(
    options: { prompt: string; files?: PlatformFile[]; skipWorktreePrompt?: boolean; autoIncludeContext?: boolean },
    username: string,
    replyToPostId?: string,
    platformId: string = 'default',
    displayName?: string,
    triggeringPostId?: string,  // The actual message that triggered the session (for context exclusion)
    initialOptions?: InitialSessionOptions
  ): Promise<void> {
    await lifecycle.startSession(options, username, displayName, replyToPostId, platformId, this.getContext(), triggeringPostId, initialOptions);
  }

  // Helper to find session by threadId (sessions are keyed by composite platformId:threadId)
  private findSessionByThreadId(threadId: string): Session | undefined {
    for (const session of this.registry.getAll()) {
      if (session.threadId === threadId) {
        return session;
      }
    }
    return undefined;
  }


  async sendFollowUp(threadId: string, message: string, files?: PlatformFile[], username?: string, displayName?: string, options?: { system?: boolean }): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    // No isRunning() pre-check here: lifecycle.sendFollowUp owns that gate,
    // including the bounded wait for a Claude process that is still starting
    // (registry insertion happens before claude.start() completes).
    await lifecycle.sendFollowUp(session, message, files, this.getContext(), username, displayName, options);
  }

  isSessionActive(): boolean {
    return this.registry.size > 0;
  }

  /**
   * Check if a thread has an active session.
   * Delegates to registry.findByThreadId() internally.
   */
  isInSessionThread(threadRoot: string): boolean {
    const session = this.registry.findByThreadId(threadRoot);
    return session !== undefined && session.claude.isRunning();
  }

  /**
   * Check if a thread has a paused (persisted but not active) session.
   * Delegates to registry.getPersistedByThreadId() internally.
   */
  hasPausedSession(threadId: string, platformId?: string): boolean {
    // If there's an active session, it's not paused (scoped to platform when
    // known, consistent with the persisted lookup below).
    if (this.registry.findByThreadId(threadId, platformId)) return false;
    // Check for persisted session
    return this.registry.getPersistedByThreadId(threadId, platformId) !== undefined;
  }

  async resumePausedSession(threadId: string, message: string, files: PlatformFile[] | undefined, username: string, platformId: string): Promise<void> {
    await lifecycle.resumePausedSession(threadId, message, files, this.getContext(), username, platformId);
  }

  getPersistedSession(threadId: string, platformId?: string): PersistedSession | undefined {
    return this.registry.getPersistedByThreadId(threadId, platformId);
  }

  /**
   * Cancel a paused (persisted but not active) session by soft-deleting it.
   * Used when !stop is issued in a thread with a paused session.
   */
  cancelPausedSession(threadId: string, platformId?: string): void {
    const persisted = this.registry.getPersistedByThreadId(threadId, platformId);
    if (persisted) {
      const sessionId = `${persisted.platformId}:${persisted.threadId}`;
      // `!stop` on a paused thread means the same thing as `!stop` on a live
      // one: the conversation is over. Without the reason, the next message
      // would revive the very session the user was just told was cancelled.
      this.sessionStore.softDelete(sessionId, 'stopped');
    }
  }

  async killSession(threadId: string, unpersist = true): Promise<void> {
    return this.withSession(threadId, (session) => lifecycle.killSession(session, unpersist, this.getContext()));
  }

  async killAllSessions(): Promise<void> {
    await lifecycle.killAllSessions(this.getContext());
  }

  // Commands
  async cancelSession(threadId: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.cancelSession(session, username, this.getContext()));
  }

  async interruptSession(threadId: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.interruptSession(session, username));
  }

  async approvePendingPlan(threadId: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.approvePendingPlan(session, username, this.getContext()));
  }

  async changeDirectory(threadId: string, newDir: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.changeDirectory(session, newDir, username, this.getContext()));
  }

  async inviteUser(threadId: string, invitedUser: string, invitedBy: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.inviteUser(session, invitedUser, invitedBy, this.getContext()));
  }

  async kickUser(threadId: string, kickedUser: string, kickedBy: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.kickUser(session, kickedUser, kickedBy, this.getContext()));
  }

  async setGitHubEmail(
    threadId: string,
    username: string,
    arg: string | undefined,
  ): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.setGitHubEmail(session, username, arg, this.getContext());
  }

  /** `!remember <text>` — add a note to the channel's shared memory. */
  async rememberEntry(threadId: string, text: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.rememberEntry(session, text, username, this.getContext()));
  }

  /** `!memory` — show the channel's shared memory. */
  async showMemory(threadId: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.showMemory(session, username, this.getContext()));
  }

  /** `!memory forget <n|text>|all` — remove channel memory entries. */
  async forgetMemory(threadId: string, selector: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.forgetMemory(session, selector, username, this.getContext()));
  }

  /** `!routine <natural language>` — propose a routine for confirmation. */
  async createRoutine(threadId: string, request: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.createRoutine(session, request, username, this.getContext()));
  }

  /** `!routines [subcommand]` — list/pause/resume/delete/run routines. */
  async manageRoutines(threadId: string, args: string | undefined, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.manageRoutines(session, args, username, this.getContext()));
  }

  /** `!watch <natural language>` — propose an event trigger for confirmation. */
  async createWatch(threadId: string, request: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.createWatch(session, request, username, this.getContext()));
  }

  /** `!watches [subcommand]` — list/pause/resume/delete watches. */
  async manageWatches(threadId: string, args: string | undefined, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.manageWatches(session, args, username, this.getContext()));
  }

  /**
   * Evaluate a channel message against this platform's event triggers.
   * Called fire-and-forget from the message handler for messages the bot
   * would otherwise ignore; must never throw (the evaluator guards itself,
   * this wrapper is belt-and-braces).
   */
  /**
   * The words in a post's voice notes, for the watch evaluator.
   *
   * Returns '' unless this platform has BOTH watches and transcription
   * enabled and the post actually carries audio — so a channel that opted out
   * of transcription never sends a file to the vendor on this path either,
   * and a channel with no watches pays nothing.
   */
  async transcribeForWatch(platformId: string, post: PlatformPost): Promise<string> {
    if (this.platformWatches.get(platformId) === false) return '';

    // ⚠️ Not just "is the feature on" — is there anything to fire. The flag
    // defaults to enabled, so without this every ignored voice note in every
    // channel would be uploaded to a paid vendor to be matched against an
    // empty list of watches. A channel that has never created a watch, or
    // whose watches are all paused, must cost nothing.
    if (!this.watchesStore.list(platformId).some((w) => w.enabled)) return '';
    const transcriber = this.transcriberFor(platformId);
    const files = post.metadata?.files;
    if (!transcriber || !files?.length) return '';

    const platform = this.platforms.get(platformId);
    if (!platform) return '';

    try {
      return await streaming.transcribeForEvaluation(
        transcriber,
        platform,
        streaming.getSessionUploadDir(platformId, post.rootId || post.id),
        files,
      );
    } catch (err) {
      // A watch that does not fire is the failure mode here, not a broken
      // message: the post is being ignored either way. Logged, never thrown —
      // this runs on the path where the bot has already decided to say
      // nothing.
      log.warn(`Watch transcription failed for ${platformId}: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  evaluateWatches(platformId: string, post: { id: string; rootId?: string; userId?: string }, author: string, message: string): void {
    const evaluator = this.watchEvaluator;
    if (!evaluator) return;
    // The bot user id feeds the evaluator's belt-and-braces self-post guard.
    // The evaluator calls the getter lazily (only when the platform actually
    // has enabled watches), and the id is cached here because Mattermost's
    // getBotUser() is an uncached API call — without the cache every
    // prefilter candidate would cost an HTTP round-trip.
    void evaluator
      .evaluate(platformId, post, author, message, () => this.resolveBotUserId(platformId))
      .catch(() => {});
  }

  /** Per-platform bot user ids for the watch self-post guard (see evaluateWatches). */
  private readonly watchBotUserIds = new Map<string, string>();

  private async resolveBotUserId(platformId: string): Promise<string | undefined> {
    const cached = this.watchBotUserIds.get(platformId);
    if (cached) return cached;
    const botUser = await this.platforms.get(platformId)?.getBotUser().catch(() => null);
    // Cache only successful lookups: a transient API failure must not pin
    // "unknown" (guard disabled) for the rest of the process lifetime.
    if (botUser?.id) this.watchBotUserIds.set(platformId, botUser.id);
    return botUser?.id;
  }

  /**
   * Fire one routine outside its schedule (`!routines run <n>`). Shares the
   * scheduler's bookkeeping but never consumes the period's scheduled fire.
   */
  private async fireRoutineNowImpl(platformId: string, routine: Routine): Promise<RoutineRunStatus | 'unauthorized'> {
    if (!this.routineScheduler) return 'skipped';
    return this.routineScheduler.fire(platformId, routine, new Date(), false);
  }

  /**
   * Toggle "respond only when @mentioned" (quiet mode) for a session (#402).
   * `arg` accepts `on`/`off`; anything else toggles the current value.
   */
  async setRespondOnlyWhenMentioned(
    threadId: string,
    username: string,
    arg: string | undefined,
  ): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.setRespondOnlyWhenMentioned(session, username, arg, this.getContext());
  }

  /**
   * Change the permission mode of an active session. Respawns Claude with the
   * new mode. Session owner or a globally-allowed user only.
   */
  async setSessionPermissionMode(
    threadId: string,
    username: string,
    mode: PermissionMode,
  ): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await commands.setSessionPermissionMode(session, username, mode, this.getContext());
  }

  /**
   * @deprecated Use `setSessionPermissionMode(threadId, username, 'default')`.
   * Kept so the `commands/executor.ts` legacy call path keeps working.
   */
  async enableInteractivePermissions(threadId: string, username: string): Promise<void> {
    await this.setSessionPermissionMode(threadId, username, 'default');
  }

  async reportBug(threadId: string, description: string | undefined, username: string, files?: PlatformFile[]): Promise<void> {
    return this.withSession(threadId, (session) => commands.reportBug(session, description, username, this.getContext(), undefined, files));
  }

  async showUpdateStatus(threadId: string, _username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.showUpdateStatus(session, this.autoUpdateManager, this.getContext()));
  }

  /**
   * Show update status without an active session.
   * Used when !update is the first message (no session exists yet).
   */
  async showUpdateStatusWithoutSession(
    platformId: string,
    threadId: string
  ): Promise<void> {
    const platform = this.platforms.get(platformId);
    if (!platform) return;

    const formatter = platform.getFormatter();

    if (!this.autoUpdateManager) {
      await platform.createPost(`ℹ️ Auto-update is not available`, threadId);
      return;
    }

    if (!this.autoUpdateManager.isEnabled()) {
      await platform.createPost(`ℹ️ Auto-update is disabled in configuration`, threadId);
      return;
    }

    // Check for new updates
    const updateInfo = await this.autoUpdateManager.checkNow();

    if (!updateInfo || !updateInfo.available) {
      await platform.createPost(`✅ ${formatter.formatBold('Up to date')} - no updates available`, threadId);
      return;
    }

    const scheduledAt = this.autoUpdateManager.getScheduledRestartAt();
    const config = this.autoUpdateManager.getConfig();

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
      `Start a session to use ${formatter.formatCode('!update now')} or ${formatter.formatCode('!update defer')}`;

    await platform.createPost(message, threadId);
  }

  async forceUpdateNow(threadId: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.forceUpdateNow(session, username, this.autoUpdateManager));
  }

  async deferUpdate(threadId: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.deferUpdate(session, username, this.autoUpdateManager));
  }

  // Plugin commands
  async pluginList(threadId: string): Promise<void> {
    return this.withSession(threadId, (session) => plugin.handlePluginList(session));
  }

  async pluginInstall(threadId: string, pluginName: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => plugin.handlePluginInstall(session, pluginName, username, this.getContext()));
  }

  async pluginUninstall(threadId: string, pluginName: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => plugin.handlePluginUninstall(session, pluginName, username, this.getContext()));
  }

  /**
   * Whether a session's tool-uses will trigger permission prompts. True for
   * `default` and `auto` modes (both consult the MCP server for at least
   * some tool-uses), false for `bypass`. Respects per-session overrides.
   */
  isSessionInteractive(threadId: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return this.permissionMode !== 'bypass';
    const effective = effectivePermissionMode({
      override: session.permissionModeOverride,
      sessionHasInteractiveOverride: session.forceInteractivePermissions,
      botWideMode: this.permissionMode,
    });
    return effective !== 'bypass';
  }

  async requestMessageApproval(threadId: string, username: string, message: string): Promise<void> {
    return this.withSession(threadId, (session) => commands.requestMessageApproval(session, username, message, this.getContext()));
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
      (s, q, _f, e, sender) => contextPrompt.offerContextPrompt(s, q, undefined, this.getContextPromptHandler(), e, sender)
    );
  }

  async createAndSwitchToWorktree(threadId: string, branch: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.createAndSwitchToWorktree(session, branch, username, {
      permissionMode: this.permissionMode,
      chromeEnabled: this.chromeEnabled,
      worktreeMode: this.worktreeMode,
      permissionTimeoutMs: this.limits.permissionTimeoutSeconds * 1000,
      handleEvent: (tid, e) => this.handleEvent(tid, e),
      handleExit: (tid, code, source) => this.handleExit(tid, code, source),
      updateSessionHeader: (s) => this.updateSessionHeader(s),
      flush: async (s) => {
        if (s.messageManager) {
          await s.messageManager.flush();
        }
      },
      persistSession: (s) => this.persistSession(s),
      startTyping: (s) => this.startTyping(s),
      stopTyping: (s) => this.stopTyping(s),
      offerContextPrompt: (s, q, f, e, sender, autoInclude) => contextPrompt.offerContextPrompt(s, q, f, this.getContextPromptHandler(), e, sender, autoInclude),
      buildMessageContent: (text, s, files) => {
        const uploadDir = streaming.getSessionUploadDir(s.platformId, s.threadId);
        return streaming.buildMessageContent(text, s.platform, uploadDir, files, this.debug, this.transcriberFor(s.platform.platformId));
      },
      generateWorkSummary: (s) => commands.generateWorkSummary(s),
      getThreadMessagesForContext: (s, limit, excludePostId) => contextPrompt.getThreadMessagesForContext(s, limit, excludePostId),
      formatContextForClaude: (messages, summary) => contextPrompt.formatContextForClaude(messages, summary),
      appendSystemPrompt: CHAT_PLATFORM_PROMPT,
      githubEmailsStore: this.githubEmailsStore,
      memoryStore: this.memoryStore,
      getPlatformMemoryConfig: (pid) => this.platformMemory.get(pid) ?? DEFAULT_MEMORY_CONFIG,
      isRoutinesEnabled: (pid) => this.platformRoutines.get(pid) ?? true,
      isWatchesEnabled: (pid) => this.platformWatches.get(pid) ?? true,
      registerPost: (postId, tid) => this.registerPost(postId, tid),
      updateStickyMessage: () => this.updateStickyMessage(),
      registerWorktreeUser: (path, sid) => this.registerWorktreeUser(path, sid),
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
    return this.withSession(threadId, (session) => worktreeModule.listWorktreesCommand(session));
  }

  /**
   * List worktrees without an active session.
   * Used when !worktree list is used in a first message (no session exists yet).
   */
  async listWorktreesWithoutSession(platformId: string, threadId: string): Promise<void> {
    const platform = this.platforms.get(platformId);
    if (!platform) return;

    const formatter = platform.getFormatter();

    // Use the default working directory since there's no session
    const message = await worktreeModule.buildWorktreeListMessageFromDir(
      this.workingDir,
      formatter,
      this.workingDir
    );

    if (message === null) {
      await platform.createPost(`❌ Current directory is not a git repository`, threadId);
      return;
    }

    await platform.createPost(message, threadId);
  }

  /**
   * Switch to a worktree without an active session.
   * Used when !worktree switch is used in a first message without additional prompt.
   */
  async switchToWorktreeWithoutSession(
    platformId: string,
    threadId: string,
    branchOrPath: string
  ): Promise<void> {
    const platform = this.platforms.get(platformId);
    if (!platform) return;

    const formatter = platform.getFormatter();

    // Find the worktree
    const { listWorktrees, getRepositoryRoot, isGitRepository } = await import('../git/worktree.js');

    const isRepo = await isGitRepository(this.workingDir);
    if (!isRepo) {
      await platform.createPost(`❌ Current directory is not a git repository`, threadId);
      return;
    }

    const repoRoot = await getRepositoryRoot(this.workingDir);
    const worktrees = await listWorktrees(repoRoot);

    // Find matching worktree
    const target = worktrees.find(
      (wt: { branch: string; path: string }) => wt.branch === branchOrPath || wt.path === branchOrPath || wt.path.endsWith(`/${branchOrPath}`)
    );

    if (!target) {
      await platform.createPost(
        `❌ No worktree found for ${formatter.formatCode(branchOrPath)}`,
        threadId
      );
      return;
    }

    await platform.createPost(
      `✅ Switched to worktree ${formatter.formatCode(target.branch)} at ${formatter.formatCode(target.path)}\n\nMention me to start a session in this worktree.`,
      threadId
    );
  }

  async removeWorktreeCommand(threadId: string, branchOrPath: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => worktreeModule.removeWorktreeCommand(session, branchOrPath, username));
  }

  async disableWorktreePrompt(threadId: string, username: string): Promise<void> {
    return this.withSession(threadId, (session) => worktreeModule.disableWorktreePrompt(session, username, (s) => this.persistSession(s)));
  }

  async cleanupWorktreeCommand(threadId: string, username: string): Promise<void> {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;
    await worktreeModule.cleanupWorktreeCommand(
      session,
      username,
      (path, sid) => this.hasOtherSessionsUsingWorktree(path, sid),
      (tid, path, user) => this.changeDirectory(tid, path, user)
    );
  }

  hasPendingWorktreePrompt(threadId: string): boolean {
    const session = this.findSessionByThreadId(threadId);
    return session?.pendingWorktreePrompt === true;
  }

  // Missing public methods needed by index.ts
  getActiveThreadIds(): string[] {
    // Return raw threadIds (not composite sessionIds) for posting to chat
    return [...this.registry.getAll()].map(s => s.threadId);
  }

  /**
   * Get the session start post ID for a thread.
   *
   * This is the post where:
   * - The bot's initial response was posted (containing the session header)
   * - Reactions are tracked for session control (cancel, interrupt, etc.)
   *
   * Checks both active sessions and persisted sessions.
   *
   * @param threadId - The thread ID to look up
   * @returns The post ID where the session started, or undefined if not found
   */
  getSessionStartPostId(threadId: string, platformId?: string): string | undefined {
    // First check active sessions
    const session = this.findSessionByThreadId(threadId);
    if (session?.sessionStartPostId) {
      return session.sessionStartPostId;
    }
    // Then check persisted sessions (for resume scenarios). Scope by platform
    // when the caller knows it, so a thread id that collides across platforms
    // cannot return another platform's session (platformId is the store's hard
    // privacy boundary). Only a read of a post id, so the param is optional for
    // the handful of test-only callers.
    const persisted = this.registry.getPersistedByThreadId(threadId, platformId);
    return persisted?.sessionStartPostId ?? undefined;
  }

  /**
   * Post shutdown messages to all active sessions and persist the post IDs.
   * This allows the resume to update the same post instead of creating a new one.
   */
  async postShutdownMessages(): Promise<void> {
    for (const session of this.registry.getAll()) {
      try {
        const fmt = session.platform.getFormatter();
        const shutdownMessage = `⏸️ ${fmt.formatBold('Bot shutting down')} - session will resume on restart`;

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

  isUserAllowedInSession(threadId: string, username: string, platformId: string): boolean {
    // Scope the active-session lookup to the message's platform too (not just
    // the persisted branch below): a thread id colliding across platforms must
    // not authorize a user against another platform's active session, and this
    // must resolve the SAME session the message router did (message-handler
    // also scopes its findByThreadId by platformId).
    const session = this.registry.find(platformId, threadId);
    if (!session) {
      // Check persisted session, scoped to the message's platform so a
      // cross-platform thread-id collision cannot authorize a user against
      // another platform's persisted allowlist.
      const persisted = this.getPersistedSession(threadId, platformId);
      if (persisted) {
        return persisted.sessionAllowedUsers.includes(username) ||
               this.platforms.get(persisted.platformId)?.isUserAllowed(username) || false;
      }
      return false;
    }
    return session.sessionAllowedUsers.has(username) || session.platform.isUserAllowed(username);
  }

  // ---------------------------------------------------------------------------
  // Side Conversation Tracking
  // ---------------------------------------------------------------------------

  /**
   * Add a side conversation to a session.
   * Side conversations are messages from approved users that are directed at other users (not the bot).
   * They are included as context with the next message sent to Claude.
   */
  addSideConversation(threadId: string, conv: import('./types.js').SideConversation): void {
    const session = this.findSessionByThreadId(threadId);
    if (!session) return;

    // Initialize array if needed
    if (!session.pendingSideConversations) {
      session.pendingSideConversations = [];
    }

    // Add the conversation
    session.pendingSideConversations.push(conv);

    // Apply limits
    this.applySideConversationLimits(session);
  }

  /**
   * Apply limits to side conversations to prevent unbounded growth.
   */
  private applySideConversationLimits(session: Session): void {
    const MAX_COUNT = 5;
    const MAX_TOTAL_CHARS = 2000;
    const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

    const now = Date.now();
    let convs = session.pendingSideConversations || [];

    // Filter by age
    convs = convs.filter(c => now - c.timestamp.getTime() < MAX_AGE_MS);

    // Keep only most recent N
    if (convs.length > MAX_COUNT) {
      convs = convs.slice(-MAX_COUNT);
    }

    // Enforce character limit (keep most recent that fit)
    let totalChars = 0;
    const limited: import('./types.js').SideConversation[] = [];
    for (const c of [...convs].reverse()) {
      if (totalChars + c.message.length <= MAX_TOTAL_CHARS) {
        limited.unshift(c);
        totalChars += c.message.length;
      }
    }

    session.pendingSideConversations = limited;
  }

  async startSessionWithWorktree(
    options: { prompt: string; files?: PlatformFile[] },
    branch: string,
    username: string,
    replyToPostId?: string,
    platformId: string = 'default',
    displayName?: string,
    triggeringPostId?: string,  // The actual message that triggered the session (for context exclusion)
    initialOptions?: InitialSessionOptions
  ): Promise<void> {
    // Start normal session first, but skip worktree prompt since branch is already specified
    await this.startSession({ ...options, skipWorktreePrompt: true }, username, replyToPostId, platformId, displayName, triggeringPostId, initialOptions);

    // Then switch to or create worktree
    const threadId = replyToPostId || '';
    const session = this.registry.find(platformId, threadId);
    if (session) {
      if (initialOptions?.switchToExisting) {
        // Switch to existing worktree (from !worktree switch)
        await this.switchToWorktree(session.threadId, branch, username);
      } else {
        // Create new worktree (from !worktree branch-name)
        await this.createAndSwitchToWorktree(session.threadId, branch, username);
      }
    }
  }

  setShuttingDown(): void {
    this.isShuttingDown = true;
    // Update sticky message module to show shutdown state
    stickyMessage.setShuttingDown(true);
  }

  // ---------------------------------------------------------------------------
  // Auto-update support methods
  // ---------------------------------------------------------------------------

  /**
   * Get session activity info for auto-update scheduling.
   * Returns the number of active sessions, last activity time, and busy state.
   */
  getActivityInfo(): { activeSessionCount: number; lastActivityAt: Date | null; anySessionBusy: boolean } {
    const sessions = [...this.registry.getAll()];

    if (sessions.length === 0) {
      return {
        activeSessionCount: 0,
        lastActivityAt: null,
        anySessionBusy: false,
      };
    }

    // Find the most recent activity across all sessions
    let lastActivity: Date | null = null;
    let anyBusy = false;

    for (const session of sessions) {
      if (!lastActivity || session.lastActivityAt > lastActivity) {
        lastActivity = session.lastActivityAt;
      }
      // A session is "busy" if it's typing (Claude is processing)
      if (session.timers.typingTimer !== null) {
        anyBusy = true;
      }
    }

    return {
      activeSessionCount: sessions.length,
      lastActivityAt: lastActivity,
      anySessionBusy: anyBusy,
    };
  }

  /**
   * Broadcast a message to all active sessions.
   * Used for update notifications.
   * @param messageBuilder - Function that takes a formatter and returns the formatted message
   */
  async broadcastToAll(messageBuilder: (formatter: import('../platform/formatter.js').PlatformFormatter) => string): Promise<void> {
    for (const session of this.registry.getAll()) {
      try {
        const formatter = session.platform.getFormatter();
        const message = messageBuilder(formatter);
        await post(session, 'info', message);
      } catch (err) {
        log.warn(`Failed to broadcast to session ${session.threadId}: ${err}`);
      }
    }
  }

  /**
   * Post update approval request to specific threads (for 'ask' mode).
   * Returns the post IDs for reaction tracking.
   */
  async postUpdateAskMessage(threadIds: string[], version: string): Promise<void> {
    for (const threadId of threadIds) {
      const session = this.findSessionByThreadId(threadId);
      if (!session) continue;

      try {
        const fmt = session.platform.getFormatter();
        const message =
          `🔄 ${fmt.formatBold('Update available:')} v${version}\n\n` +
          `React: 👍 to update now | 👎 to defer for 1 hour\n` +
          fmt.formatItalic('Update will proceed automatically after timeout if no response');

        const post = await session.platform.createInteractivePost(
          message,
          ['👍', '👎'],
          session.threadId
        );

        // Store pending update prompt for reaction handling
        session.messageManager?.setPendingUpdatePrompt({ postId: post.id });
        this.registerPost(post.id, session.threadId);
      } catch (err) {
        log.warn(`Failed to post ask message to ${threadId}: ${err}`);
      }
    }
  }

  // Shutdown
  async shutdown(message?: string): Promise<void> {
    this.isShuttingDown = true;

    // Stop background tasks
    this.sessionMonitor?.stop();
    this.backgroundCleanup?.stop();
    this.routineScheduler?.stop();

    // Post shutdown message to all active sessions
    if (message) {
      for (const session of this.registry.getAll()) {
        try {
          await post(session, 'info', message);
        } catch {
          // Ignore
        }
      }
    }

    // Persist and kill all sessions for later resume
    for (const session of this.registry.getAll()) {
      this.stopTyping(session);
      this.persistSession(session);
      session.claude.kill();
    }
    this.registry.clear();
  }
}
