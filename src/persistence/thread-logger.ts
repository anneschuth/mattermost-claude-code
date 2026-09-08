/**
 * Thread Logger - Persists Claude events and messages to JSONL files
 *
 * Stores logs in ~/.claude-threads/logs/{platformId}/{threadId}.jsonl
 * Each line is a JSON object representing an event with timestamp.
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync, rmdirSync, readFileSync, chmodSync } from 'fs';
import { stateHome } from '../utils/state-home.js';
import { join, dirname } from 'path';
import { createLogger } from '../utils/logger.js';
import type { ClaudeEvent } from '../claude/cli.js';

const log = createLogger('thread-log');

// Base directory for thread logs (data directory, not config)
const LOGS_BASE_DIR = join(stateHome(), '.claude-threads', 'logs');

// =============================================================================
// Log Entry Types
// =============================================================================

/**
 * Base interface for all log entries
 */
interface BaseLogEntry {
  ts: number;           // Timestamp (Date.now())
  sessionId: string;    // Claude session ID (for resume correlation)
  type: string;         // Entry type discriminator
}

/**
 * Claude event from CLI (raw)
 */
export interface ClaudeEventEntry extends BaseLogEntry {
  type: 'claude_event';
  eventType: string;    // 'assistant' | 'tool_use' | 'tool_result' | 'result' | 'system'
  event: ClaudeEvent;   // Raw event object
}

/**
 * User message from chat platform
 */
export interface UserMessageEntry extends BaseLogEntry {
  type: 'user_message';
  username: string;
  displayName?: string;
  message: string;
  hasFiles?: boolean;
}

/**
 * Session lifecycle events
 */
export interface LifecycleEntry extends BaseLogEntry {
  type: 'lifecycle';
  action: 'start' | 'resume' | 'exit' | 'timeout' | 'interrupt' | 'kill' | 'restart';
  username?: string;
  workingDir?: string;
  exitCode?: number;
  reason?: string;
  details?: Record<string, unknown>;
}

/**
 * User commands (!cd, !invite, etc.)
 */
export interface CommandEntry extends BaseLogEntry {
  type: 'command';
  command: string;      // 'cd' | 'invite' | 'kick' | 'permissions' | 'stop' | 'escape' | etc.
  args?: string;
  username: string;
}

/**
 * Permission requests/responses
 */
export interface PermissionEntry extends BaseLogEntry {
  type: 'permission';
  action: 'request' | 'approve' | 'deny';
  permission?: string;
  username?: string;
}

/**
 * Reaction events (plan approval, question answers, etc.)
 */
export interface ReactionEntry extends BaseLogEntry {
  type: 'reaction';
  action: 'plan_approve' | 'plan_reject' | 'question_answer' | 'message_approve' | 'message_invite' | 'message_reject' | 'cancel' | 'interrupt';
  username: string;
  emoji?: string;
  answer?: string;
}

/**
 * Executor operation events (task list, content, etc.)
 * Used for debugging post creation/update/delete issues
 */
export interface ExecutorEntry extends BaseLogEntry {
  type: 'executor';
  executor: 'task_list' | 'content' | 'subagent' | 'system';
  operation: 'create' | 'create_start' | 'update' | 'delete' | 'bump' | 'complete' | 'error' | 'close';
  method?: string;  // Which method originated this log (e.g., 'updateTaskList', 'bumpToBottom')
  postId?: string;
  details?: Record<string, unknown>;
}

export type LogEntry =
  | ClaudeEventEntry
  | UserMessageEntry
  | LifecycleEntry
  | CommandEntry
  | PermissionEntry
  | ReactionEntry
  | ExecutorEntry;

// =============================================================================
// ThreadLogger Interface
// =============================================================================

export interface ThreadLoggerOptions {
  enabled?: boolean;           // Default: true
  bufferSize?: number;         // Max entries before auto-flush (default: 10)
  flushIntervalMs?: number;    // Auto-flush interval (default: 1000ms)
}

export interface ThreadLogger {
  /** Log a raw Claude event */
  logEvent(event: ClaudeEvent): void;

  /** Log a user message from chat */
  logUserMessage(username: string, message: string, displayName?: string, hasFiles?: boolean): void;

  /** Log session lifecycle event */
  logLifecycle(action: LifecycleEntry['action'], details?: Record<string, unknown>): void;

  /** Log user command */
  logCommand(command: string, args: string | undefined, username: string): void;

  /** Log permission request/response */
  logPermission(action: 'request' | 'approve' | 'deny', permission?: string, username?: string): void;

  /** Log reaction event */
  logReaction(action: ReactionEntry['action'], username: string, emoji?: string, answer?: string): void;

  /** Log executor operation (for debugging post management) */
  logExecutor(
    executor: ExecutorEntry['executor'],
    operation: ExecutorEntry['operation'],
    postId?: string,
    details?: Record<string, unknown>,
    method?: string
  ): void;

  /** Flush pending writes (for graceful shutdown) */
  flush(): Promise<void>;

  /** Close the logger (cleanup) */
  close(): Promise<void>;

  /** Check if logger is enabled */
  isEnabled(): boolean;

  /** Get the log file path */
  getLogPath(): string;
}

// =============================================================================
// ThreadLogger Implementation
// =============================================================================

class ThreadLoggerImpl implements ThreadLogger {
  private readonly platformId: string;
  private readonly threadId: string;
  private readonly claudeSessionId: string;
  private readonly enabled: boolean;
  private readonly bufferSize: number;
  private readonly flushIntervalMs: number;
  private readonly logPath: string;

  private buffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isClosed = false;

  constructor(
    platformId: string,
    threadId: string,
    claudeSessionId: string,
    options?: ThreadLoggerOptions
  ) {
    this.platformId = platformId;
    this.threadId = threadId;
    this.claudeSessionId = claudeSessionId;
    this.enabled = options?.enabled ?? true;
    this.bufferSize = options?.bufferSize ?? 10;
    this.flushIntervalMs = options?.flushIntervalMs ?? 1000;

    // Compute log file path - use sessionId (platform-agnostic) rather than threadId
    this.logPath = join(LOGS_BASE_DIR, platformId, `${claudeSessionId}.jsonl`);

    if (this.enabled) {
      // Ensure directory exists
      const dir = dirname(this.logPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Start auto-flush timer
      this.flushTimer = setInterval(() => {
        this.flushSync();
      }, this.flushIntervalMs);

      log.debug(`Thread logger initialized: ${this.logPath}`);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getLogPath(): string {
    return this.logPath;
  }

  logEvent(event: ClaudeEvent): void {
    if (!this.enabled || this.isClosed) return;

    const entry: ClaudeEventEntry = {
      ts: Date.now(),
      sessionId: this.claudeSessionId,
      type: 'claude_event',
      eventType: event.type,
      event,
    };
    this.addEntry(entry);
  }

  logUserMessage(username: string, message: string, displayName?: string, hasFiles?: boolean): void {
    if (!this.enabled || this.isClosed) return;

    const entry: UserMessageEntry = {
      ts: Date.now(),
      sessionId: this.claudeSessionId,
      type: 'user_message',
      username,
      displayName,
      message,
      hasFiles,
    };
    this.addEntry(entry);
  }

  logLifecycle(action: LifecycleEntry['action'], details?: Record<string, unknown>): void {
    if (!this.enabled || this.isClosed) return;

    const entry: LifecycleEntry = {
      ts: Date.now(),
      sessionId: this.claudeSessionId,
      type: 'lifecycle',
      action,
      ...details,
    };
    this.addEntry(entry);
  }

  logCommand(command: string, args: string | undefined, username: string): void {
    if (!this.enabled || this.isClosed) return;

    const entry: CommandEntry = {
      ts: Date.now(),
      sessionId: this.claudeSessionId,
      type: 'command',
      command,
      args,
      username,
    };
    this.addEntry(entry);
  }

  logPermission(action: 'request' | 'approve' | 'deny', permission?: string, username?: string): void {
    if (!this.enabled || this.isClosed) return;

    const entry: PermissionEntry = {
      ts: Date.now(),
      sessionId: this.claudeSessionId,
      type: 'permission',
      action,
      permission,
      username,
    };
    this.addEntry(entry);
  }

  logReaction(action: ReactionEntry['action'], username: string, emoji?: string, answer?: string): void {
    if (!this.enabled || this.isClosed) return;

    const entry: ReactionEntry = {
      ts: Date.now(),
      sessionId: this.claudeSessionId,
      type: 'reaction',
      action,
      username,
      emoji,
      answer,
    };
    this.addEntry(entry);
  }

  logExecutor(
    executor: ExecutorEntry['executor'],
    operation: ExecutorEntry['operation'],
    postId?: string,
    details?: Record<string, unknown>,
    method?: string
  ): void {
    if (!this.enabled || this.isClosed) return;

    const entry: ExecutorEntry = {
      ts: Date.now(),
      sessionId: this.claudeSessionId,
      type: 'executor',
      executor,
      operation,
      postId,
      method,
      details,
    };
    this.addEntry(entry);
  }

  async flush(): Promise<void> {
    this.flushSync();
  }

  async close(): Promise<void> {
    if (this.isClosed) return;

    this.isClosed = true;

    // Stop auto-flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush
    this.flushSync();

    log.debug(`Thread logger closed: ${this.logPath}`);
  }

  private addEntry(entry: LogEntry): void {
    this.buffer.push(entry);

    // Auto-flush if buffer is full
    if (this.buffer.length >= this.bufferSize) {
      this.flushSync();
    }
  }

  private flushSync(): void {
    if (this.buffer.length === 0) return;

    try {
      // Convert entries to JSONL format
      const lines = this.buffer.map(entry => JSON.stringify(entry)).join('\n') + '\n';

      // Check if file exists (for setting permissions on new files)
      const isNewFile = !existsSync(this.logPath);

      // Append to file
      appendFileSync(this.logPath, lines, { encoding: 'utf8', mode: 0o600 });

      // Set restrictive permissions on new files (appendFileSync mode only applies on create)
      if (isNewFile) {
        chmodSync(this.logPath, 0o600);
      }

      // Clear buffer
      this.buffer = [];
    } catch (err) {
      log.error(`Failed to flush thread log: ${err}`);
    }
  }
}

// =============================================================================
// Disabled Logger (no-op implementation)
// =============================================================================

class DisabledThreadLogger implements ThreadLogger {
  logEvent(): void { /* no-op */ }
  logUserMessage(): void { /* no-op */ }
  logLifecycle(): void { /* no-op */ }
  logCommand(): void { /* no-op */ }
  logPermission(): void { /* no-op */ }
  logReaction(): void { /* no-op */ }
  logExecutor(): void { /* no-op */ }
  async flush(): Promise<void> { /* no-op */ }
  async close(): Promise<void> { /* no-op */ }
  isEnabled(): boolean { return false; }
  getLogPath(): string { return ''; }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a thread logger for a session
 */
export function createThreadLogger(
  platformId: string,
  threadId: string,
  claudeSessionId: string,
  options?: ThreadLoggerOptions
): ThreadLogger {
  if (options?.enabled === false) {
    return new DisabledThreadLogger();
  }
  return new ThreadLoggerImpl(platformId, threadId, claudeSessionId, options);
}

// =============================================================================
// Cleanup Functions
// =============================================================================

/**
 * Clean up old log files based on retention policy.
 * Deletes log files older than retentionDays.
 *
 * @param retentionDays - Number of days to keep logs (default: 30)
 * @returns Number of files deleted
 */
export function cleanupOldLogs(retentionDays: number = 30): number {
  const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  let deletedCount = 0;

  if (!existsSync(LOGS_BASE_DIR)) {
    return 0;
  }

  try {
    // Iterate through platform directories
    const platformDirs = readdirSync(LOGS_BASE_DIR);
    for (const platformId of platformDirs) {
      const platformDir = join(LOGS_BASE_DIR, platformId);
      const stat = statSync(platformDir);
      if (!stat.isDirectory()) continue;

      // Iterate through log files in this platform directory
      const logFiles = readdirSync(platformDir);
      for (const file of logFiles) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = join(platformDir, file);
        try {
          const fileStat = statSync(filePath);
          // Delete if file's mtime is older than cutoff
          if (fileStat.mtimeMs < cutoffMs) {
            unlinkSync(filePath);
            deletedCount++;
            log.debug(`Deleted old log file: ${filePath}`);
          }
        } catch (err) {
          log.warn(`Failed to check/delete log file ${filePath}: ${err}`);
        }
      }

      // Remove empty platform directory
      try {
        const remaining = readdirSync(platformDir);
        if (remaining.length === 0) {
          rmdirSync(platformDir);
          log.debug(`Removed empty platform log directory: ${platformDir}`);
        }
      } catch {
        // Ignore errors removing directories
      }
    }

    if (deletedCount > 0) {
      log.info(`Cleaned up ${deletedCount} old log file(s)`);
    }
  } catch (err) {
    log.error(`Failed to clean up old logs: ${err}`);
  }

  return deletedCount;
}

/**
 * Get log file path for a session (for external use, e.g., debugging)
 */
export function getLogFilePath(platformId: string, sessionId: string): string {
  return join(LOGS_BASE_DIR, platformId, `${sessionId}.jsonl`);
}

/**
 * Read the last N lines from a log file.
 * Returns an array of parsed log entries (most recent last).
 *
 * @param platformId - Platform identifier
 * @param sessionId - Session identifier (claudeSessionId)
 * @param maxLines - Maximum number of lines to read (default: 50)
 * @returns Array of log entries, or empty array if file doesn't exist
 */
export function readRecentLogEntries(
  platformId: string,
  sessionId: string,
  maxLines: number = 50
): LogEntry[] {
  const logPath = getLogFilePath(platformId, sessionId);
  log.debug(`Reading log entries from: ${logPath}`);

  if (!existsSync(logPath)) {
    log.debug(`Log file does not exist: ${logPath}`);
    return [];
  }

  try {
    const content = readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n');
    log.debug(`Log file has ${lines.length} lines`);

    // Take last N lines
    const recentLines = lines.slice(-maxLines);

    // Parse each line as JSON
    const entries: LogEntry[] = [];
    for (const line of recentLines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    log.debug(`Parsed ${entries.length} log entries`);
    return entries;
  } catch (err) {
    log.error(`Failed to read log file: ${err}`);
    return [];
  }
}
