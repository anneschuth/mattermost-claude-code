/**
 * Unified SessionContext - Single context interface for all session modules
 *
 * This replaces the separate LifecycleContext, EventContext, ReactionContext,
 * and CommandContext interfaces with a single unified context that provides
 * all operations needed by session modules.
 *
 * Benefits:
 * - DRY: No more duplicated callback definitions
 * - Maintainability: Single place to add new operations
 * - Type safety: All modules use the same interface
 */

import type { Session } from '../../session/types.js';
import type { ClaudeCli, ClaudeEvent } from '../../claude/cli.js';
import type { PlatformClient, PlatformFile } from '../../platform/index.js';
import type { SessionStore } from '../../persistence/session-store.js';
import type { GitHubEmailsStore } from '../../persistence/github-emails-store.js';
import type { SessionInfo } from '../../ui/types.js';
import type { BuiltMessageContent } from '../streaming/handler.js';
import type { ClaudeAccount, PermissionMode, PlatformOverhead, ResolvedMemoryConfig } from '../../config/index.js';
import type { AccountPoolStatus, AcquireOptions } from '../../claude/account-pool.js';
import type { MemoryStore } from '../../memory/store.js';
import type { Routine, RoutinesStore, RoutineRunStatus } from '../../persistence/routines-store.js';
import type { WatchesStore } from '../../persistence/watches-store.js';

// =============================================================================
// Configuration (read-only state)
// =============================================================================

/**
 * Session configuration - immutable settings for the session manager
 */
export interface SessionConfig {
  /**
   * Whether `!bug` may file a report. False removes the whole path: the
   * command, Claude's ability to run it, and approving a report that was
   * already pending. See resolveBugReportsEnabled for what it sends.
   */
  bugReportsEnabled: boolean;
  /** Base working directory for sessions */
  workingDir: string;
  /** Effective permission mode. See `PermissionMode` for semantics. */
  permissionMode: PermissionMode;
  /** Whether Chrome browser automation is enabled */
  chromeEnabled: boolean;
  /**
   * Config default for the per-session "respond only when @mentioned" toggle
   * (#402). Seeds `Session.respondOnlyWhenMentioned` on new sessions. Default
   * `false`. Optional so existing `SessionConfig` literals stay valid.
   */
  respondOnlyWhenMentioned?: boolean;
  /**
   * Config default for per-message `[@username]:` attribution. Seeds
   * `Session.userAttribution` on new sessions. Default `true`. Optional so
   * existing `SessionConfig` literals stay valid.
   */
  userAttribution?: boolean;
  /** Debug mode flag */
  debug: boolean;
  /** Maximum concurrent sessions allowed */
  maxSessions: number;
  /** Maximum routines per platform instance (default: 10) */
  maxRoutines?: number;
  /** Maximum watches (event triggers) per platform instance (default 10). */
  maxWatches?: number;
  /** Whether thread logging is enabled (default: true) */
  threadLogsEnabled?: boolean;
  /** Thread log retention in days (default: 30) */
  threadLogsRetentionDays?: number;
  /** Permission approval timeout in ms (default: 120000) */
  permissionTimeoutMs?: number;
  /** Streaming flush cadence in ms (default: 500). Lower = snappier updates. */
  flushDelayMs?: number;
}

// =============================================================================
// State Access (read-only references)
// =============================================================================

/**
 * State access - provides read-only access to session manager state
 */
export interface SessionState {
  /** All active sessions (read-only) */
  readonly sessions: ReadonlyMap<string, Session>;
  /** Post ID to thread ID mapping (read-only) */
  readonly postIndex: ReadonlyMap<string, string>;
  /** All registered platforms (read-only) */
  readonly platforms: ReadonlyMap<string, PlatformClient>;
  /** Session persistence store */
  readonly sessionStore: SessionStore;
  /** GitHub noreply email registrations (for commit co-author attribution) */
  readonly githubEmailsStore: GitHubEmailsStore;
  /** Persistent memory (channel layer + repo-layer directory management) */
  readonly memoryStore: MemoryStore;
  /** Scheduled routines (Claude Tag-style recurring work) */
  readonly routinesStore: RoutinesStore;
  /** Event-trigger store (per-platform watches). */
  readonly watchesStore: WatchesStore;
  /** Whether the manager is shutting down */
  readonly isShuttingDown: boolean;
}

// =============================================================================
// Operations Interface
// =============================================================================

/**
 * Session operations - all mutable operations provided by SessionManager
 *
 * Organized by category for easier navigation:
 * - Session lookup
 * - Post management
 * - Streaming/content
 * - Persistence
 * - UI updates
 * - Event handling
 * - Worktree
 * - Context prompt
 */
export interface SessionOperations {
  // ---------------------------------------------------------------------------
  // Session Lookup
  // ---------------------------------------------------------------------------

  /** Get composite session ID from platform and thread IDs */
  getSessionId(platformId: string, threadId: string): string;

  /** Find session by thread ID (searches across all platforms) */
  findSessionByThreadId(threadId: string): Session | undefined;

  // ---------------------------------------------------------------------------
  // Post Management
  // ---------------------------------------------------------------------------

  /** Register a post ID to thread ID mapping for reaction routing */
  registerPost(postId: string, threadId: string): void;

  // ---------------------------------------------------------------------------
  // Streaming & Content
  // ---------------------------------------------------------------------------

  /** Flush pending content to chat (delegates to MessageManager when available) */
  flush(session: Session): Promise<void>;

  /** Start typing indicator for session */
  startTyping(session: Session): void;

  /** Stop typing indicator for session */
  stopTyping(session: Session): void;

  /**
   * Build message content with optional file attachments. Files are written to
   * `uploadDir`; their absolute paths are prepended to the returned content so
   * Claude can Read or move/copy them.
   */
  buildMessageContent(
    text: string,
    platform: PlatformClient,
    uploadDir: string,
    files?: PlatformFile[]
  ): Promise<BuiltMessageContent>;

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /** Persist session state to disk */
  persistSession(session: Session): void;

  /** Remove session from persistence */
  unpersistSession(sessionId: string): void;

  /** Increment the instance-wide session counter (milestones stamp themselves) */
  recordSessionStarted(): void;

  // ---------------------------------------------------------------------------
  // UI Updates
  // ---------------------------------------------------------------------------

  /** Update the session header post with current state */
  updateSessionHeader(session: Session): Promise<void>;

  /** Update sticky channel message for all platforms */
  updateStickyMessage(): Promise<void>;

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  /** Handle a Claude CLI event */
  handleEvent(sessionId: string, event: ClaudeEvent): void;

  /**
   * Handle Claude CLI process exit.
   *
   * `source` is the ClaudeCli instance that emitted the exit. Pass it so a
   * late exit from a process that was already replaced (`!cd` /
   * `!permissions` / worktree respawn) can be told apart from the current
   * process dying — without it, a stale exit tears down the restarted
   * session.
   */
  handleExit(sessionId: string, code: number, source?: ClaudeCli): Promise<void>;

  // ---------------------------------------------------------------------------
  // Session Lifecycle
  // ---------------------------------------------------------------------------

  /** Kill a session (terminate Claude CLI process) */
  killSession(threadId: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Worktree
  // ---------------------------------------------------------------------------

  /** Check if session should prompt for worktree creation */
  shouldPromptForWorktree(session: Session): Promise<string | null>;

  /** Post worktree prompt to session thread */
  postWorktreePrompt(session: Session, reason: string): Promise<void>;

  /** Register a session as using a worktree */
  registerWorktreeUser(worktreePath: string, sessionId: string): void;

  /** Unregister a session from using a worktree */
  unregisterWorktreeUser(worktreePath: string, sessionId: string): void;

  /** Check if other sessions are using a worktree (besides the given session) */
  hasOtherSessionsUsingWorktree(worktreePath: string, excludeSessionId: string): boolean;

  /** Switch session to an existing worktree directory */
  switchToWorktree(threadId: string, branchOrPath: string, username: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Update Operations
  // ---------------------------------------------------------------------------

  /** Force an immediate update (if auto-update manager is available) */
  forceUpdate(): Promise<void>;

  /** Defer the update for the specified number of minutes */
  deferUpdate(minutes: number): void;

  // ---------------------------------------------------------------------------
  // Bug Report Operations
  // ---------------------------------------------------------------------------

  /** Handle bug report approval/denial */
  handleBugReportApproval(session: Session, approved: boolean, username: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Context Prompt
  // ---------------------------------------------------------------------------

  /**
   * Offer context prompt after session restart.
   * Returns true if prompt was posted, false if message was sent directly.
   */
  offerContextPrompt(
    session: Session,
    queuedPrompt: string,
    queuedFiles?: PlatformFile[],
    excludePostId?: string,
    sender?: string,
    autoInclude?: boolean,
  ): Promise<boolean>;

  // ---------------------------------------------------------------------------
  // UI Event Emission
  // ---------------------------------------------------------------------------

  /** Emit session:add event for UI */
  emitSessionAdd(session: Session): void;

  /** Emit session:update event for UI */
  emitSessionUpdate(sessionId: string, updates: Partial<SessionInfo>): void;

  /** Emit session:remove event for UI */
  emitSessionRemove(sessionId: string): void;

  // ---------------------------------------------------------------------------
  // Claude Account Pool
  // ---------------------------------------------------------------------------

  /**
   * Reserve a Claude account for a new or resumed session.
   *
   * Returns `null` when the bot is in single-account mode (no pool configured)
   * or when every account is currently in rate-limit cooldown. Callers that
   * receive `null` should fall back to spawning Claude with `process.env`.
   *
   * `preferredId` is honored even if the account is currently cooling — this
   * is required for resume, because OAuth history lives under a specific HOME.
   *
   * With `opts.balanceByUsage` (new sessions), the pool routes to whichever
   * account has the most subscription headroom (lowest `/usage` load score),
   * skipping accounts in cooldown. Without it (resume), `threadId` enables the
   * sticky-by-thread compat binding — the pool deterministically picks
   * `accounts[hash(threadId) % n]` so a pre-account-pool session with no
   * recorded `claudeAccountId` re-derives the same account across restarts.
   */
  acquireClaudeAccount(
    preferredId?: string,
    threadId?: string,
    opts?: AcquireOptions
  ): ClaudeAccount | null;

  /**
   * Probe every pooled account's live `/usage` headroom and update the pool, so
   * the following `acquireClaudeAccount({ balanceByUsage: true })` routes on
   * fresh data. Called on-demand at new session start. Resolves quickly (no-op)
   * when the pool has fewer than two accounts.
   */
  refreshClaudeAccountUsage(): Promise<void>;

  /**
   * Look up the Claude account metadata for a session that already holds one.
   * Used by session restart paths (e.g. !cd) that must keep using the same
   * account without re-selecting one from the pool.
   */
  getClaudeAccount(accountId: string): ClaudeAccount | undefined;

  /** Return an account to the pool when a session ends. No-op for unknown ids. */
  releaseClaudeAccount(accountId: string): void;

  /**
   * Mark an account as rate-limited until the given epoch timestamp. Future
   * account selection skips the account until the timestamp passes.
   */
  markClaudeAccountCooling(accountId: string, untilEpochMs: number): void;

  /** Snapshot of pool state for sticky-message / header rendering. */
  getClaudeAccountPoolStatus(): AccountPoolStatus[];

  // ---------------------------------------------------------------------------
  // Per-platform overhead visibility
  // ---------------------------------------------------------------------------

  /**
   * Resolved overhead visibility (session header + sticky) for a platform.
   * Defaults to `'full'` for both when the platform was registered without
   * explicit settings.
   */
  getPlatformOverhead(platformId: string): PlatformOverhead;

  /**
   * Resolved memory settings for a platform. Defaults to fully enabled when
   * the platform was registered without an explicit `memory` option.
   */
  getPlatformMemoryConfig(platformId: string): ResolvedMemoryConfig;

  /**
   * Whether scheduled routines are enabled for a platform (default true).
   */
  isRoutinesEnabled(platformId: string): boolean;

  /**
   * Fire one routine immediately (the `!routines run <n>` path). Runs through
   * the scheduler's bookkeeping but does not consume the current period's
   * scheduled fire.
   */
  fireRoutineNow(platformId: string, routine: Routine): Promise<RoutineRunStatus | 'unauthorized'>;

  /**
   * Whether event triggers (watches) are enabled for a platform instance
   * (per-platform `watches` config option; default true).
   */
  isWatchesEnabled(platformId: string): boolean;
}

// =============================================================================
// Unified Context
// =============================================================================

/**
 * SessionContext - Unified context for all session modules
 *
 * This is the single interface that all session modules receive.
 * It provides:
 * - config: Read-only configuration
 * - state: Read-only access to current state
 * - ops: All mutable operations
 *
 * Usage in modules:
 * ```typescript
 * export async function handleEvent(session: Session, event: ClaudeEvent, ctx: SessionContext): Promise<void> {
 *   // Content is now handled via MessageManager events
 *   await ctx.ops.flush(session);
 * }
 * ```
 */
export interface SessionContext {
  /** Read-only configuration */
  readonly config: SessionConfig;

  /** Read-only state access */
  readonly state: SessionState;

  /** Mutable operations */
  readonly ops: SessionOperations;
}

// =============================================================================
// Context Builder Helper
// =============================================================================

/**
 * Create a SessionContext from SessionManager instance.
 *
 * This is a helper for SessionManager to create the context object.
 * The SessionManager passes `this` and the context builder extracts
 * the needed properties and methods.
 */
export function createSessionContext(
  config: SessionConfig,
  state: SessionState,
  ops: SessionOperations
): SessionContext {
  return {
    config,
    state,
    ops,
  };
}
