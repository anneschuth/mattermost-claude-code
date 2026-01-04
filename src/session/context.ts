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

import type { Session } from './types.js';
import type { ClaudeEvent, ContentBlock } from '../claude/cli.js';
import type { PlatformClient, PlatformFile } from '../platform/index.js';
import type { SessionStore } from '../persistence/session-store.js';
import type { SessionInfo } from '../ui/types.js';

// =============================================================================
// Configuration (read-only state)
// =============================================================================

/**
 * Session configuration - immutable settings for the session manager
 */
export interface SessionConfig {
  /** Base working directory for sessions */
  workingDir: string;
  /** Whether to skip permission prompts (dangerously-skip-permissions) */
  skipPermissions: boolean;
  /** Whether Chrome browser automation is enabled */
  chromeEnabled: boolean;
  /** Debug mode flag */
  debug: boolean;
  /** Maximum concurrent sessions allowed */
  maxSessions: number;
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

  /** Flush pending content to chat */
  flush(session: Session): Promise<void>;

  /** Append content to session's pending buffer */
  appendContent(session: Session, text: string): void;

  /** Start typing indicator for session */
  startTyping(session: Session): void;

  /** Stop typing indicator for session */
  stopTyping(session: Session): void;

  /** Build message content with optional file attachments */
  buildMessageContent(
    text: string,
    platform: PlatformClient,
    files?: PlatformFile[]
  ): Promise<string | ContentBlock[]>;

  /** Move task list to bottom of thread */
  bumpTasksToBottom(session: Session): Promise<void>;

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /** Persist session state to disk */
  persistSession(session: Session): void;

  /** Remove session from persistence */
  unpersistSession(sessionId: string): void;

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

  /** Handle Claude CLI process exit */
  handleExit(sessionId: string, code: number): Promise<void>;

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
    excludePostId?: string
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
 * export function handleEvent(session: Session, event: ClaudeEvent, ctx: SessionContext): void {
 *   ctx.ops.appendContent(session, formatted);
 *   ctx.ops.flush(session);
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
