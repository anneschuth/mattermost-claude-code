/**
 * Session management types and interfaces
 */

import type { ClaudeCli } from '../claude/cli.js';
import type { PlatformClient } from '../platform/index.js';
import type { WorktreeInfo } from '../persistence/session-store.js';
import type { PendingContextPrompt } from './context-prompt.js';
import type { SessionInfo } from '../ui/types.js';

// =============================================================================
// Model and Usage Types
// =============================================================================

/**
 * Token usage for a single model
 */
export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;  // Maximum context window size
  costUSD: number;
}

/**
 * Aggregated usage stats from Claude CLI result events
 */
export interface SessionUsageStats {
  /** Primary model being used (e.g., "claude-opus-4-5-20251101") */
  primaryModel: string;
  /** Display name for the model (e.g., "Opus 4.5") */
  modelDisplayName: string;
  /** Maximum context window size */
  contextWindowSize: number;
  /** Estimated context tokens (primary model input + cache read only) */
  contextTokens: number;
  /** Total tokens used (input + output across all models, for billing display) */
  totalTokensUsed: number;
  /** Total cost in USD */
  totalCostUSD: number;
  /** Per-model usage breakdown */
  modelUsage: Record<string, ModelTokenUsage>;
  /** Last update timestamp */
  lastUpdated: Date;
}

// =============================================================================
// Interactive State Types
// =============================================================================

export interface QuestionOption {
  label: string;
  description: string;
}

export interface PendingQuestionSet {
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

export interface PendingApproval {
  postId: string;
  type: 'plan' | 'action';
  toolUseId: string;
}

/**
 * Pending message from unauthorized user awaiting approval
 */
export interface PendingMessageApproval {
  postId: string;
  originalMessage: string;
  fromUser: string;
}

/**
 * Pending prompt asking user if they want to join an existing worktree
 */
export interface PendingExistingWorktreePrompt {
  postId: string;
  branch: string;
  worktreePath: string;
  username: string;  // User who triggered the prompt
}

// =============================================================================
// Session Type
// =============================================================================

/**
 * Represents a single Claude Code session tied to a platform thread.
 * Each session has its own Claude CLI process and state.
 */
export interface Session {
  // Identity
  platformId: string;       // Which platform instance (e.g., 'mattermost-main')
  threadId: string;         // Thread ID within that platform
  sessionId: string;        // Composite key "platformId:threadId"
  claudeSessionId: string;  // UUID for --session-id / --resume
  startedBy: string;            // Username (for permissions)
  startedByDisplayName?: string; // Display name (for UI)
  startedAt: Date;
  lastActivityAt: Date;
  sessionNumber: number;  // Session # when created

  // Platform reference
  platform: PlatformClient;  // Reference to platform client

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
  lastTasksContent: string | null;  // Last task list content (for re-posting when bumping to bottom)
  tasksCompleted: boolean;  // True when all tasks are done (stops sticky behavior)
  tasksMinimized: boolean;  // True when task list is minimized (show only progress)
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

  // Count of consecutive resume failures (for giving up after too many)
  resumeFailCount: number;

  // Flag to track if session was interrupted (SIGINT sent) - don't unpersist on exit
  wasInterrupted: boolean;

  // Flag to track if Claude has responded at least once (safe to persist for resume)
  hasClaudeResponded: boolean;

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
  worktreeResponsePostId?: string;          // Post ID of user's worktree branch response (to exclude from context)
  firstPrompt?: string;                     // First user message, sent again after mid-session worktree creation
  pendingExistingWorktreePrompt?: PendingExistingWorktreePrompt; // Waiting for user to confirm joining existing worktree

  // Thread context prompt support
  pendingContextPrompt?: PendingContextPrompt; // Waiting for context selection
  needsContextPromptOnNextMessage?: boolean;   // Offer context prompt on next follow-up message (after !cd)

  // Resume support
  lifecyclePostId?: string;  // Post ID of timeout message (for resume via reaction)

  // Compaction support
  compactionPostId?: string;  // Post ID of "Compacting..." message (for updating on completion)

  // Session title and description (dynamically generated by Claude)
  sessionTitle?: string;       // Short title describing the session topic (3-6 words)
  sessionDescription?: string; // Longer description of what's happening (1-2 sentences)

  // Pull request URL (detected from Claude output when PR is created)
  pullRequestUrl?: string;     // Full URL to the PR (GitHub, GitLab, Bitbucket, Azure DevOps, etc.)

  // Message counter for periodic reminders
  messageCount: number;  // Number of user messages sent to Claude in this session

  // Processing state - true when Claude is actively processing a request
  isProcessing: boolean;

  // Usage stats from Claude CLI (updated on each result event)
  usageStats?: SessionUsageStats;

  // Status bar update timer (for periodic refreshes)
  statusBarTimer: ReturnType<typeof setInterval> | null;
}

// =============================================================================
// Status Helpers
// =============================================================================

/**
 * Compute the UI status for a session based on its state.
 */
export function getSessionStatus(session: Session): SessionInfo['status'] {
  if (session.isProcessing) {
    return session.hasClaudeResponded ? 'active' : 'starting';
  }
  return 'idle';
}

// =============================================================================
// Configuration Constants
// =============================================================================

export const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '5', 10);
export const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || '1800000', 10); // 30 min
export const SESSION_WARNING_MS = 5 * 60 * 1000; // Warn 5 minutes before timeout
