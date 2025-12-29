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
 * Persisted session state for resuming after bot restart
 */
export interface PersistedSession {
  threadId: string;              // Mattermost thread ID
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
}

interface SessionStoreData {
  version: number;
  sessions: Record<string, PersistedSession>;
}

const STORE_VERSION = 1;
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
   */
  load(): Map<string, PersistedSession> {
    const sessions = new Map<string, PersistedSession>();

    if (!existsSync(SESSIONS_FILE)) {
      if (this.debug) console.log('  [persist] No sessions file found');
      return sessions;
    }

    try {
      const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as SessionStoreData;

      // Version check for future migrations
      if (data.version !== STORE_VERSION) {
        console.warn(`  [persist] Sessions file version mismatch (${data.version} vs ${STORE_VERSION}), starting fresh`);
        return sessions;
      }

      for (const [threadId, session] of Object.entries(data.sessions)) {
        sessions.set(threadId, session);
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
   */
  save(threadId: string, session: PersistedSession): void {
    const data = this.loadRaw();
    data.sessions[threadId] = session;
    this.writeAtomic(data);

    if (this.debug) {
      const shortId = threadId.substring(0, 8);
      console.log(`  [persist] Saved session ${shortId}...`);
    }
  }

  /**
   * Remove a session
   */
  remove(threadId: string): void {
    const data = this.loadRaw();
    if (data.sessions[threadId]) {
      delete data.sessions[threadId];
      this.writeAtomic(data);

      if (this.debug) {
        const shortId = threadId.substring(0, 8);
        console.log(`  [persist] Removed session ${shortId}...`);
      }
    }
  }

  /**
   * Remove sessions older than maxAgeMs
   */
  cleanStale(maxAgeMs: number): string[] {
    const data = this.loadRaw();
    const now = Date.now();
    const staleIds: string[] = [];

    for (const [threadId, session] of Object.entries(data.sessions)) {
      const lastActivity = new Date(session.lastActivityAt).getTime();
      if (now - lastActivity > maxAgeMs) {
        staleIds.push(threadId);
        delete data.sessions[threadId];
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
