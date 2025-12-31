import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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
  threadMessageCount: number;
  createdAt: number;
  availableOptions: number[];
}

/**
 * Persisted session state for resuming after bot restart
 */
export interface PersistedSession {
  platformId: string;            // Which platform instance (e.g., 'default', 'mattermost-main')
  threadId: string;              // Thread ID within that platform
  claudeSessionId: string;       // UUID for --session-id / --resume
  startedBy: string;             // Username who started the session
  startedAt: string;             // ISO date
  sessionNumber: number;
  workingDir: string;            // Can change via !cd
  sessionAllowedUsers: string[]; // Collaboration list
  forceInteractivePermissions: boolean;
  sessionStartPostId: string | null;
  tasksPostId: string | null;
  lastActivityAt: string;        // For stale cleanup
  planApproved: boolean;
  // Worktree support
  worktreeInfo?: WorktreeInfo;              // Active worktree info
  pendingWorktreePrompt?: boolean;          // Waiting for branch name response
  worktreePromptDisabled?: boolean;         // User opted out with !worktree off
  queuedPrompt?: string;                    // User's original message when waiting for worktree response
  firstPrompt?: string;                     // First user message, sent again after mid-session worktree creation
  // Context prompt support
  pendingContextPrompt?: PersistedContextPrompt; // Waiting for context selection
}

/**
 * v1 session format (before platformId was added)
 */
type PersistedSessionV1 = Omit<PersistedSession, 'platformId'> & {
  platformId?: string;
}

interface SessionStoreData {
  version: number;
  sessions: Record<string, PersistedSession>;
}

const STORE_VERSION = 2; // v2: Added platformId for multi-platform support
const CONFIG_DIR = join(homedir(), '.config', 'claude-threads');
const SESSIONS_FILE = join(CONFIG_DIR, 'sessions.json');

/**
 * SessionStore - Persistence layer for session state
 * Stores session data as JSON file for resume after restart
 */
export class SessionStore {
  private debug = process.env.DEBUG === '1' || process.argv.includes('--debug');

  constructor() {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  /**
   * Load all persisted sessions
   * Returns Map with composite sessionId ("platformId:threadId") as key
   */
  load(): Map<string, PersistedSession> {
    const sessions = new Map<string, PersistedSession>();

    if (!existsSync(SESSIONS_FILE)) {
      if (this.debug) console.log('  [persist] No sessions file found');
      return sessions;
    }

    try {
      const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as SessionStoreData;

      // Migration: v1 → v2 (add platformId and convert keys to composite format)
      if (data.version === 1) {
        console.log('  [persist] Migrating sessions from v1 to v2 (adding platformId)');
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
        console.warn(`  [persist] Sessions file version ${data.version} not supported, starting fresh`);
        return sessions;
      }

      // Load sessions with composite sessionId as key
      for (const session of Object.values(data.sessions)) {
        const sessionId = `${session.platformId}:${session.threadId}`;
        sessions.set(sessionId, session);
      }

      if (this.debug) {
        console.log(`  [persist] Loaded ${sessions.size} session(s)`);
      }
    } catch (err) {
      console.error('  [persist] Failed to load sessions:', err);
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

    if (this.debug) {
      const shortId = sessionId.substring(0, 20);
      console.log(`  [persist] Saved session ${shortId}...`);
    }
  }

  /**
   * Remove a session
   * @param sessionId - Composite key "platformId:threadId"
   */
  remove(sessionId: string): void {
    const data = this.loadRaw();
    if (data.sessions[sessionId]) {
      delete data.sessions[sessionId];
      this.writeAtomic(data);

      if (this.debug) {
        const shortId = sessionId.substring(0, 20);
        console.log(`  [persist] Removed session ${shortId}...`);
      }
    }
  }

  /**
   * Remove sessions older than maxAgeMs
   * @returns Array of sessionIds that were removed
   */
  cleanStale(maxAgeMs: number): string[] {
    const data = this.loadRaw();
    const now = Date.now();
    const staleIds: string[] = [];

    for (const [sessionId, session] of Object.entries(data.sessions)) {
      const lastActivity = new Date(session.lastActivityAt).getTime();
      if (now - lastActivity > maxAgeMs) {
        staleIds.push(sessionId);
        delete data.sessions[sessionId];
      }
    }

    if (staleIds.length > 0) {
      this.writeAtomic(data);
      if (this.debug) {
        console.log(`  [persist] Cleaned ${staleIds.length} stale session(s)`);
      }
    }

    return staleIds;
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    this.writeAtomic({ version: STORE_VERSION, sessions: {} });
    if (this.debug) {
      console.log('  [persist] Cleared all sessions');
    }
  }

  /**
   * Load raw data from file
   */
  private loadRaw(): SessionStoreData {
    if (!existsSync(SESSIONS_FILE)) {
      return { version: STORE_VERSION, sessions: {} };
    }

    try {
      return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as SessionStoreData;
    } catch {
      return { version: STORE_VERSION, sessions: {} };
    }
  }

  /**
   * Write data atomically (write to temp file, then rename)
   */
  private writeAtomic(data: SessionStoreData): void {
    const tempFile = `${SESSIONS_FILE}.tmp`;
    writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tempFile, SESSIONS_FILE);
  }
}
