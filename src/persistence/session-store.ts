import { existsSync, mkdirSync, readFileSync } from 'fs';
import { writeFileAtomic } from './atomic-file.js';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { milestoneReached } from '../sponsor.js';
import type { PlatformFile } from '../platform/types.js';
import type { PersistedTrackedTask } from '../operations/task-tracker.js';
import type { ContextPromptFile } from '../operations/executors/types.js';
import type { OverheadVisibility } from '../config/types.js';
import { stateHome } from '../utils/state-home.js';

const log = createLogger('persist');

/**
 * Worktree information for a session
 */
export interface WorktreeInfo {
  repoRoot: string;      // Original git repo path
  worktreePath: string;  // Current worktree path
  branch: string;        // Branch name
}

/**
 * Persisted context prompt state (without timeoutId which can't be serialized)
 */
export interface PersistedContextPrompt {
  postId: string;
  queuedPrompt: string;
  queuedFiles?: ContextPromptFile[];  // Simplified file refs (id, name) for storage
  queuedByUsername?: string;   // Sender login for attribution (backward-compatible; undefined on old data)
  threadMessageCount: number;
  createdAt: number;
  availableOptions: number[];
}

/**
 * Why a session was soft-deleted. `cleanedAt` alone cannot say: it is stamped
 * both when a session is deliberately ended and when a long-idle one is aged
 * out, and those two want opposite behaviour on the next message.
 *
 * - `'stopped'` — the conversation is over. `!stop`, a kill, a normal exit.
 *   `killSession` has already distilled it into channel memory as ended, so
 *   reviving it would distill the same conversation a second time at its next
 *   death. The next message must start a FRESH session.
 * - `'stale'` — nothing ended it; it was aged out of the visible set by
 *   `cleanStale()`. A reply in the thread is meant to bring it back, which is
 *   why the paused-session gate looks past `cleanedAt` at all.
 *
 * Records written before this field existed carry no reason; see
 * `resolveEndReason` for how they are read.
 */
export type EndReason = 'stopped' | 'stale';

/**
 * The end reason of a soft-deleted record, inferred for records written before
 * `endReason` existed.
 *
 * ⚠️ The legacy fallback is `'stopped'`, and deliberately so: it is the safe
 * default in both directions. Reading a stale record as stopped costs one
 * fresh session; reading a stopped record as stale resurrects a conversation
 * the user ended and double-counts its distillation. `isPaused` looks like a
 * better discriminator and is not one — shutdown persists still-active
 * sessions with `isPaused: false`, and `cleanStale()` then ages those out into
 * `false + cleanedAt` records that are perfectly revivable.
 */
export function resolveEndReason(session: PersistedSession): EndReason | undefined {
  if (!session.cleanedAt) return undefined;
  return session.endReason ?? 'stopped';
}

/**
 * Whether a persisted record should still answer messages in its thread —
 * either it is live, or it is a stale tombstone a reply is meant to revive.
 *
 * This is THE predicate the paused-session gate and the resume sink must
 * share. When they disagreed, a record visible to one and hidden from the
 * other made its thread unreachable in both directions: the gate claimed the
 * message, the sink dropped it, and the new-session path never ran.
 */
export function isRevivable(session: PersistedSession): boolean {
  return resolveEndReason(session) !== 'stopped';
}

/**
 * Persisted session state for resuming after bot restart
 */
export interface PersistedSession {
  platformId: string;            // Which platform instance (e.g., 'default', 'mattermost-main')
  threadId: string;              // Thread ID within that platform
  claudeSessionId: string;       // UUID for --session-id / --resume
  startedBy: string;             // Username who started the session
  startedByDisplayName?: string; // Display name for UI
  startedAt: string;             // ISO date
  sessionNumber: number;
  workingDir: string;            // Can change via !cd
  sessionAllowedUsers: string[]; // Collaboration list
  forceInteractivePermissions: boolean;
  respondOnlyWhenMentioned?: boolean; // Quiet mode: only respond to messages that @mention the bot (default false)
  userAttribution?: boolean;     // Per-message [@username]: attribution (absent on pre-flag sessions → read as false on resume)
  sessionStartPostId: string | null;
  tasksPostId: string | null;
  lastTasksContent: string | null;  // For re-posting tasks when bumping to bottom
  tasksCompleted?: boolean;      // True when all tasks done (stops sticky behavior)
  tasksMinimized?: boolean;      // True when task list is minimized (show only progress)
  /**
   * Incremental TaskTracker snapshot (id/subject/status per task). Restored
   * on resume so post-restart TaskUpdate calls render real subjects instead
   * of "Task #N" placeholders. Absent on pre-1.24.1 data → tracker starts
   * empty, the previous behavior.
   */
  taskTrackerState?: PersistedTrackedTask[];
  lastActivityAt: string;        // For stale cleanup
  planApproved: boolean;
  // Worktree support
  worktreeInfo?: WorktreeInfo;              // Active worktree info
  isWorktreeOwner?: boolean;                // True if this session CREATED the worktree (vs joining existing)
  pendingWorktreePrompt?: boolean;          // Waiting for branch name response
  worktreePromptDisabled?: boolean;         // User opted out with !worktree off
  queuedPrompt?: string;                    // User's original message when waiting for worktree response
  queuedByUsername?: string;                // Sender login for attribution (backward-compatible; undefined on old data)
  queuedFiles?: PlatformFile[];             // Files attached to the queued prompt (for images)
  firstPrompt?: string;                     // First user message, sent again after mid-session worktree creation
  // Context prompt support
  pendingContextPrompt?: PersistedContextPrompt; // Waiting for context selection
  needsContextPromptOnNextMessage?: boolean;     // Offer context prompt on next follow-up message (after !cd)
  // Resume support
  lifecyclePostId?: string;                        // Post ID of timeout/shutdown message (for resume via reaction or restart)
  isPaused?: boolean;                              // True if session was paused (timeout/interrupt) - won't auto-resume on restart
  // Session title and description
  sessionTitle?: string;                         // Short title describing the session topic
  sessionDescription?: string;                   // Longer description of what's happening (1-2 sentences)
  sessionTags?: string[];                        // Auto-generated classification tags (e.g., 'bug-fix', 'feature')
  // Pull request URL
  pullRequestUrl?: string;                       // Full URL to PR (GitHub, GitLab, Bitbucket, Azure DevOps, etc.)
  // Message counter
  messageCount?: number;                         // Number of user messages sent to Claude
  // Resume failure tracking
  resumeFailCount?: number;                      // Count of consecutive resume failures
  // History retention (soft delete)
  cleanedAt?: string;                            // ISO date when session was soft-deleted (kept for history)
  endReason?: EndReason;                         // WHY it was soft-deleted — see EndReason
  // Multi-account support
  /**
   * Claude account id the session was started under, if the bot is configured
   * with a `claudeAccounts` pool. Resume MUST pick the same account — for
   * OAuth accounts the conversation history lives under that account's HOME
   * and cannot be read from a different one. Undefined for legacy sessions
   * and for bots running in single-account mode.
   */
  claudeAccountId?: string;
  /**
   * Per-thread session header visibility resolved at session start.
   * Optional for backward compatibility — old `sessions.json` files predate
   * this field and resume with `'full'` (today's behavior).
   */
  sessionHeaderMode?: OverheadVisibility;
  /**
   * True for unattended runs (routine/watch fires). Resume must keep the
   * flag so the agent propose_* tools stay suppressed after a bot restart.
   * Optional for backward compatibility (missing = attended).
   */
  unattended?: boolean;
}

/**
 * v1 session format (before platformId was added)
 */
type PersistedSessionV1 = Omit<PersistedSession, 'platformId'> & {
  platformId?: string;
}

/**
 * Instance-wide counters backing the sponsor milestone celebrations.
 * Absent on data written by older versions — all readers must default
 * missing fields.
 */
export interface SponsorStats {
  totalSessionsStarted: number;
  milestone?: { n: number; reachedAt: string };  // Last milestone hit (ISO date)
}

interface SessionStoreData {
  version: number;
  sessions: Record<string, PersistedSession>;
  stickyPostIds?: Record<string, string>;  // platformId -> postId
  platformEnabledState?: Record<string, boolean>;  // platformId -> enabled (defaults to true if not set)
  stats?: SponsorStats;
}

const STORE_VERSION = 2; // v2: Added platformId for multi-platform support
const DEFAULT_CONFIG_DIR = join(stateHome(), '.config', 'claude-threads');
const DEFAULT_SESSIONS_FILE = join(DEFAULT_CONFIG_DIR, 'sessions.json');

/**
 * SessionStore - Persistence layer for session state
 * Stores session data as JSON file for resume after restart
 */
export class SessionStore {
  private readonly sessionsFile: string;
  private readonly configDir: string;

  /**
   * Create a SessionStore instance
   * @param sessionsPath - Custom path for sessions.json (default: ~/.config/claude-threads/sessions.json)
   *                       Can also be set via CLAUDE_THREADS_SESSIONS_PATH environment variable.
   *                       Useful for testing to isolate session state between test files.
   */
  constructor(sessionsPath?: string) {
    const envPath = process.env.CLAUDE_THREADS_SESSIONS_PATH;
    const effectivePath = sessionsPath ?? envPath;

    if (effectivePath) {
      this.sessionsFile = effectivePath;
      this.configDir = join(effectivePath, '..');
    } else {
      this.sessionsFile = DEFAULT_SESSIONS_FILE;
      this.configDir = DEFAULT_CONFIG_DIR;
    }

    // Ensure config directory exists
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Load all persisted sessions
   * Returns Map with composite sessionId ("platformId:threadId") as key
   */
  load(): Map<string, PersistedSession> {
    const sessions = new Map<string, PersistedSession>();

    if (!existsSync(this.sessionsFile)) {
      log.debug('No sessions file found');
      return sessions;
    }

    try {
      const data = this.loadRaw();

      // Migration: v1 → v2 (add platformId and convert keys to composite format)
      if (data.version === 1) {
        log.info('Migrating sessions from v1 to v2 (adding platformId)');
        const newSessions: Record<string, PersistedSession> = {};
        for (const [_oldKey, session] of Object.entries(data.sessions)) {
          const v1Session = session as PersistedSessionV1;
          if (!v1Session.platformId) {
            v1Session.platformId = 'default';
          }
          // Convert key from threadId to platformId:threadId
          const newKey = `${v1Session.platformId}:${v1Session.threadId}`;
          newSessions[newKey] = v1Session as PersistedSession;
        }
        data.sessions = newSessions;
        data.version = 2;
        // Save migrated data
        this.writeAtomic(data);
      } else if (data.version !== STORE_VERSION) {
        log.warn(`Sessions file version ${data.version} not supported, starting fresh`);
        return sessions;
      }

      // Load active sessions only (exclude soft-deleted)
      for (const session of Object.values(data.sessions)) {
        // Skip soft-deleted sessions (they're kept for history only)
        if (session.cleanedAt) continue;

        const sessionId = `${session.platformId}:${session.threadId}`;
        sessions.set(sessionId, session);
      }

      log.debug(`Loaded ${sessions.size} active session(s)`);
    } catch (err) {
      log.error(`Failed to load sessions: ${err}`);
    }

    return sessions;
  }

  /**
   * Save a session (creates or updates)
   * @param sessionId - Composite key "platformId:threadId"
   * @param session - Session data to persist
   */
  save(sessionId: string, session: PersistedSession): void {
    const data = this.loadRaw();
    // Use sessionId as key (already composite)
    data.sessions[sessionId] = session;
    this.writeAtomic(data);

    const shortId = sessionId.substring(0, 20);
    log.debug(`Saved session ${shortId}...`);
  }

  /**
   * Remove a session permanently
   * @param sessionId - Composite key "platformId:threadId"
   */
  remove(sessionId: string): void {
    const data = this.loadRaw();
    if (data.sessions[sessionId]) {
      delete data.sessions[sessionId];
      this.writeAtomic(data);

      const shortId = sessionId.substring(0, 20);
      log.debug(`Removed session ${shortId}...`);
    }
  }

  /**
   * Soft-delete a session (mark as cleaned but keep for history)
   * @param sessionId - Composite key "platformId:threadId"
   */
  softDelete(sessionId: string, reason: EndReason): void {
    const data = this.loadRaw();
    if (data.sessions[sessionId]) {
      data.sessions[sessionId].cleanedAt = new Date().toISOString();
      // Required, not optional: a tombstone with no reason is the ambiguity
      // that made `!stop` and "aged out" indistinguishable in the first place.
      data.sessions[sessionId].endReason = reason;
      this.writeAtomic(data);

      const shortId = sessionId.substring(0, 20);
      log.debug(`Soft-deleted session ${shortId}...`);
    }
  }

  /**
   * Soft-delete sessions older than maxAgeMs (keeps them for history display)
   * Only affects active sessions (not already soft-deleted)
   * @returns Array of sessionIds that were soft-deleted
   */
  cleanStale(maxAgeMs: number): string[] {
    const data = this.loadRaw();
    const now = Date.now();
    const staleIds: string[] = [];

    for (const [sessionId, session] of Object.entries(data.sessions)) {
      // Skip already soft-deleted sessions
      if (session.cleanedAt) continue;

      // DCM sessions are channel-scoped tasks: the channel's archive/teardown
      // owns their lifecycle, not idle age. Tombstoning one after a quiet hour
      // makes the whole channel permanently unresponsive (every message dies
      // on "No persisted session found").
      if (session.threadId.startsWith('dcm:')) continue;

      const lastActivity = new Date(session.lastActivityAt).getTime();
      if (now - lastActivity > maxAgeMs) {
        staleIds.push(sessionId);
        session.cleanedAt = new Date().toISOString();
        // Aged out, not ended — a reply in the thread is still meant to bring
        // this one back. See EndReason.
        session.endReason = 'stale';
      }
    }

    if (staleIds.length > 0) {
      this.writeAtomic(data);
      log.debug(`Soft-deleted ${staleIds.length} stale session(s)`);
    }

    return staleIds;
  }

  /**
   * Permanently remove soft-deleted sessions older than historyRetentionMs
   * @param historyRetentionMs - How long to keep soft-deleted sessions (default: 3 days)
   * @returns Number of sessions permanently removed
   */
  cleanHistory(historyRetentionMs: number = 3 * 24 * 60 * 60 * 1000): number {
    const data = this.loadRaw();
    const now = Date.now();
    let removedCount = 0;

    for (const [sessionId, session] of Object.entries(data.sessions)) {
      if (!session.cleanedAt) continue;

      const cleanedTime = new Date(session.cleanedAt).getTime();
      if (now - cleanedTime > historyRetentionMs) {
        delete data.sessions[sessionId];
        removedCount++;
      }
    }

    if (removedCount > 0) {
      this.writeAtomic(data);
      log.debug(`Permanently removed ${removedCount} old session(s) from history`);
    }

    return removedCount;
  }

  /**
   * Get all inactive sessions for a platform (for history display).
   * Includes both soft-deleted sessions (completed) and timed-out sessions (resumable).
   * @param platformId - Platform instance ID
   * @param activeSessions - Set of currently active session IDs to exclude
   * @returns Array of inactive sessions, sorted by most recent activity
   */
  getHistory(platformId: string, activeSessions?: Set<string>): PersistedSession[] {
    const data = this.loadRaw();
    const historySessions: PersistedSession[] = [];

    for (const [sessionId, session] of Object.entries(data.sessions)) {
      if (session.platformId !== platformId) continue;

      // Include soft-deleted sessions (completed normally)
      if (session.cleanedAt) {
        historySessions.push(session);
        continue;
      }

      // Include timed-out sessions that are not currently active
      // These have lifecyclePostId set but no cleanedAt
      if (session.lifecyclePostId && activeSessions && !activeSessions.has(sessionId)) {
        historySessions.push(session);
      }
    }

    // Sort by most recent activity (cleanedAt for completed, lastActivityAt for timed out)
    return historySessions.sort((a, b) => {
      const aTime = new Date(a.cleanedAt || a.lastActivityAt).getTime();
      const bTime = new Date(b.cleanedAt || b.lastActivityAt).getTime();
      return bTime - aTime;
    });
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    const data = this.loadRaw();
    // Preserve sticky post IDs when clearing sessions
    this.writeAtomic({ version: STORE_VERSION, sessions: {}, stickyPostIds: data.stickyPostIds });
    log.debug('Cleared all sessions');
  }

  // ---------------------------------------------------------------------------
  // Sticky Post ID Management
  // ---------------------------------------------------------------------------

  /**
   * Save a sticky post ID for a platform
   */
  saveStickyPostId(platformId: string, postId: string): void {
    const data = this.loadRaw();
    if (!data.stickyPostIds) {
      data.stickyPostIds = {};
    }
    data.stickyPostIds[platformId] = postId;
    this.writeAtomic(data);

    log.debug(`Saved sticky post ID for ${platformId}: ${postId.substring(0, 8)}...`);
  }

  /**
   * Get all sticky post IDs
   */
  getStickyPostIds(): Map<string, string> {
    const data = this.loadRaw();
    return new Map(Object.entries(data.stickyPostIds || {}));
  }

  /**
   * Remove a sticky post ID for a platform
   */
  removeStickyPostId(platformId: string): void {
    const data = this.loadRaw();
    if (data.stickyPostIds && data.stickyPostIds[platformId]) {
      delete data.stickyPostIds[platformId];
      this.writeAtomic(data);

      log.debug(`Removed sticky post ID for ${platformId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Platform Enabled State Management
  // ---------------------------------------------------------------------------

  /**
   * Get all platform enabled states
   * Returns a map of platformId -> enabled (defaults to true if not set)
   */
  getPlatformEnabledState(): Map<string, boolean> {
    const data = this.loadRaw();
    return new Map(Object.entries(data.platformEnabledState || {}));
  }

  /**
   * Check if a specific platform is enabled
   * @param platformId - Platform instance ID
   * @returns true if enabled or not set (defaults to enabled), false if explicitly disabled
   */
  isPlatformEnabled(platformId: string): boolean {
    const data = this.loadRaw();
    // Default to true if not set
    return data.platformEnabledState?.[platformId] ?? true;
  }

  /**
   * Set the enabled state for a platform
   * @param platformId - Platform instance ID
   * @param enabled - Whether the platform is enabled
   */
  setPlatformEnabled(platformId: string, enabled: boolean): void {
    const data = this.loadRaw();
    if (!data.platformEnabledState) {
      data.platformEnabledState = {};
    }
    data.platformEnabledState[platformId] = enabled;
    this.writeAtomic(data);

    log.debug(`Set platform ${platformId} enabled state to ${enabled}`);
  }

  /**
   * Find a persisted session by platform and thread ID
   * @param platformId - Platform instance ID
   * @param threadId - Thread ID within the platform
   * @returns Session data if found, undefined otherwise
   */
  findByThread(platformId: string, threadId: string): PersistedSession | undefined {
    const sessionId = `${platformId}:${threadId}`;
    const data = this.loadRaw();
    return data.sessions[sessionId];
  }

  /**
   * Find a persisted session by thread ID, searching across all platforms
   * AND across soft-deleted records that `load()` hides.
   *
   * Used by the plain-reply resume path in `message-handler.ts`: after the
   * bot restarts and `cleanStale()` soft-deletes a paused session whose last
   * activity is older than 2× timeout, the session is still in the file for
   * the 3-day history window and can legitimately be resumed if the user
   * replies in the thread. This mirrors `findByPostId()`'s behavior (which
   * the 🔄 reaction resume path already uses) so both UX paths promised by
   * the timeout message — "React with 🔄 OR send a new message to continue"
   * — work equivalently.
   *
   * @param threadId - Thread ID within any platform
   * @returns Session data if found (including soft-deleted), undefined otherwise
   */
  findByThreadIdAnyState(threadId: string, platformId?: string): PersistedSession | undefined {
    const data = this.loadRaw();
    for (const session of Object.values(data.sessions)) {
      if (session.threadId !== threadId) continue;
      // SECURITY: when the caller knows which platform the thread belongs to,
      // scope to it. platformId is the store's hard privacy boundary (composite
      // keys are `platformId:threadId`); without this, a thread id on platform
      // B that happens to equal one persisted under platform A would resume A's
      // session — its allowlist, working dir, worktree and Claude account —
      // from B. Real platform ids don't collide today (Mattermost 26-char ids
      // vs Slack dotted-ts), so this is defense-in-depth for the invariant.
      if (platformId !== undefined && session.platformId !== platformId) continue;
      return session;
    }
    return undefined;
  }

  /**
   * Find a persisted session by lifecycle post ID or session start post ID
   * Used for resuming sessions via emoji reaction
   * @param platformId - Platform instance ID
   * @param postId - Post ID to search for
   * @returns Session data if found, undefined otherwise
   */
  findByPostId(platformId: string, postId: string): PersistedSession | undefined {
    const data = this.loadRaw();
    for (const session of Object.values(data.sessions)) {
      if (session.platformId !== platformId) continue;
      if (session.lifecyclePostId === postId || session.sessionStartPostId === postId) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Get instance-wide sponsor stats (missing fields default to zero-state).
   */
  getStats(): SponsorStats {
    const data = this.loadRaw();
    return data.stats ?? { totalSessionsStarted: 0 };
  }

  /**
   * Record a session start: increments the cumulative counter and stamps a
   * milestone when the new total hits one exactly. Returns the new total.
   */
  recordSessionStarted(): number {
    const data = this.loadRaw();
    const stats = data.stats ?? { totalSessionsStarted: 0 };
    stats.totalSessionsStarted = (stats.totalSessionsStarted ?? 0) + 1;
    const milestone = milestoneReached(stats.totalSessionsStarted);
    if (milestone) {
      stats.milestone = { n: milestone, reachedAt: new Date().toISOString() };
    }
    data.stats = stats;
    this.writeAtomic(data);
    return stats.totalSessionsStarted;
  }

  /**
   * Load raw data from file
   */
  /**
   * True while the most recent loadRaw() could not faithfully read an
   * EXISTING file (parse failure, malformed sessions map). Every mutation
   * is a synchronous loadRaw() → mutate → writeAtomic() pair, so the flag
   * always describes the read that produced the data about to be written.
   */
  private lastReadDegraded = false;

  private loadRaw(): SessionStoreData {
    if (!existsSync(this.sessionsFile)) {
      this.lastReadDegraded = false;
      return { version: STORE_VERSION, sessions: {} };
    }

    try {
      const raw = readFileSync(this.sessionsFile, 'utf-8');
      if (raw.trim() === '') {
        // Zero-length/whitespace file (e.g. a crashed first write): provably
        // nothing to lose, so it must NOT trip the degraded-read write
        // refusal — that would leave the store permanently read-only.
        this.lastReadDegraded = false;
        return { version: STORE_VERSION, sessions: {} };
      }
      const data = JSON.parse(raw) as SessionStoreData;
      if (!data || typeof data !== 'object') {
        // Parsed to a scalar — unrecognizable content, refuse writes over it.
        this.lastReadDegraded = true;
        return { version: STORE_VERSION, sessions: {} };
      }
      if (data.sessions === undefined || data.sessions === null) {
        // No sessions key at all (e.g. a bare '{}'): provably nothing to
        // lose — an empty store that writes may safely replace (#258).
        this.lastReadDegraded = false;
        data.sessions = {};
      } else if (typeof data.sessions !== 'object') {
        // A sessions value we cannot read faithfully: degrade reads, but
        // refuse writes (see writeAtomic) — overwriting would destroy it.
        this.lastReadDegraded = true;
        data.sessions = {};
      } else {
        this.lastReadDegraded = false;
      }
      if (!data.version) {
        data.version = STORE_VERSION;
      }
      return data;
    } catch (err) {
      log.warn(`Failed to read ${this.sessionsFile}: ${(err as Error).message} — reads degrade to empty`);
      this.lastReadDegraded = true;
      return { version: STORE_VERSION, sessions: {} };
    }
  }

  /**
   * Write data atomically (write to temp file, then rename)
   * Sets restrictive permissions (0600) to protect sensitive session data
   *
   * Refuses (logs, no throw — persist paths are fire-and-forget) when the
   * data descends from a degraded read: sessions.json EXISTS but could not
   * be read faithfully, so writing the degraded view would atomically
   * destroy every persisted session across all platforms. The unreadable
   * file stays on disk for recovery; one lost bookkeeping write is the
   * acceptable outcome.
   */
  private writeAtomic(data: SessionStoreData): void {
    if (this.lastReadDegraded) {
      log.error(`Refusing to write ${this.sessionsFile}: the last read of the existing file was degraded — writing would destroy persisted sessions`);
      return;
    }
    writeFileAtomic(this.sessionsFile, JSON.stringify(data, null, 2));
  }
}
