/**
 * Format Utilities
 *
 * Centralizes common formatting patterns used throughout the codebase.
 * This eliminates duplication of ID formatting and console logging patterns.
 *
 * Benefits:
 * - DRY: Single implementation for all formatting
 * - Consistency: Standard output formats
 * - Maintainability: Easy to change formats globally
 */

// =============================================================================
// ID Formatting
// =============================================================================

/**
 * Extract the thread ID from a composite session ID.
 * Composite IDs are in format "platformId:threadId".
 *
 * @param sessionId - The composite session ID or plain thread ID
 * @returns The thread ID portion
 */
export function extractThreadId(sessionId: string): string {
  const colonIndex = sessionId.indexOf(':');
  return colonIndex >= 0 ? sessionId.substring(colonIndex + 1) : sessionId;
}

/**
 * Format a session/thread ID for display.
 * Shows first 8 characters followed by ellipsis.
 * Handles both composite IDs (platformId:threadId) and plain thread IDs.
 *
 * @param id - The full ID string (composite or plain)
 * @returns Shortened ID like "abc12345…"
 */
export function formatShortId(id: string): string {
  const threadId = extractThreadId(id);
  if (threadId.length <= 8) return threadId;
  return `${threadId.substring(0, 8)}…`;
}

/**
 * Format a session/thread ID with parentheses.
 * For use in log messages.
 *
 * @param id - The full ID string
 * @returns Formatted ID like "(abc12345…)"
 */
export function formatSessionId(id: string): string {
  return `(${formatShortId(id)})`;
}

// =============================================================================
// Console Logging
// =============================================================================

/**
 * Handler for session log output.
 * When set, all session logs route through this handler instead of console.log.
 * The sessionId allows routing logs to specific session panels in the UI.
 */
export type SessionLogHandler = (
  level: 'info' | 'error' | 'debug',
  message: string,
  sessionId?: string
) => void;

let sessionLogHandler: SessionLogHandler | null = null;

/**
 * Set the global session log handler.
 * Used by the Ink UI to capture all session logs.
 */
export function setSessionLogHandler(handler: SessionLogHandler | null): void {
  sessionLogHandler = handler;
}

/**
 * Internal helper to output a session log message.
 */
function outputSessionLog(
  level: 'info' | 'error' | 'debug',
  message: string,
  sessionId?: string
): void {
  if (sessionLogHandler) {
    sessionLogHandler(level, message, sessionId);
  } else if (level === 'error') {
    console.error(message);
  } else if (level === 'debug') {
    if (process.env.DEBUG === '1') {
      console.log(message);
    }
  } else {
    console.log(message);
  }
}

/**
 * Log a session action to the console.
 * Provides consistent formatting for session-related logs.
 *
 * @param emoji - Emoji prefix for the log
 * @param action - Action description
 * @param threadId - The thread ID
 * @param username - Optional username who performed the action
 */
export function logSessionAction(
  emoji: string,
  action: string,
  threadId: string,
  username?: string
): void {
  const shortId = formatShortId(threadId);
  const userPart = username ? ` by @${username}` : '';
  outputSessionLog('info', `${emoji} ${action} (${shortId})${userPart}`, threadId);
}

/**
 * Pre-defined session log helpers for common actions.
 * Use these for consistent logging throughout the codebase.
 */
export const sessionLog = {
  /**
   * Log session started
   */
  started: (threadId: string, user: string, dir: string): void => {
    outputSessionLog('info', `✅ Session started (${formatShortId(threadId)}) by @${user} in ${dir}`, threadId);
  },

  /**
   * Log session cancelled
   */
  cancelled: (threadId: string, user: string): void => {
    logSessionAction('🛑', 'Session cancelled', threadId, user);
  },

  /**
   * Log session timed out
   */
  timeout: (threadId: string): void => {
    logSessionAction('⏱️', 'Session timed out', threadId);
  },

  /**
   * Log session resumed
   */
  resumed: (threadId: string, user?: string): void => {
    logSessionAction('🔄', 'Session resumed', threadId, user);
  },

  /**
   * Log session interrupted
   */
  interrupted: (threadId: string, user: string): void => {
    logSessionAction('⏸️', 'Session interrupted', threadId, user);
  },

  /**
   * Log session exited
   */
  exited: (threadId: string, code: number): void => {
    const emoji = code === 0 ? '✅' : '⚠️';
    outputSessionLog('info', `${emoji} Session (${formatShortId(threadId)}) exited with code ${code}`, threadId);
  },

  /**
   * Log session error
   */
  error: (threadId: string, error: string): void => {
    outputSessionLog('error', `⚠️ Session (${formatShortId(threadId)}): ${error}`, threadId);
  },

  /**
   * Log directory change
   */
  cdChanged: (threadId: string, newDir: string, user: string): void => {
    outputSessionLog('info', `📂 Session (${formatShortId(threadId)}) changed to ${newDir} by @${user}`, threadId);
  },

  /**
   * Log user invited
   */
  invited: (threadId: string, invitedUser: string, invitedBy: string): void => {
    outputSessionLog('info', `👤 @${invitedUser} invited to session (${formatShortId(threadId)}) by @${invitedBy}`, threadId);
  },

  /**
   * Log user kicked
   */
  kicked: (threadId: string, kickedUser: string, kickedBy: string): void => {
    outputSessionLog('info', `👤 @${kickedUser} removed from session (${formatShortId(threadId)}) by @${kickedBy}`, threadId);
  },

  /**
   * Log worktree created
   */
  worktreeCreated: (threadId: string, branch: string): void => {
    outputSessionLog('info', `🌿 Worktree created for branch "${branch}" (${formatShortId(threadId)})`, threadId);
  },

  /**
   * Log context prompt
   */
  contextPrompt: (threadId: string, selection: number | 'timeout', user?: string): void => {
    const desc = selection === 'timeout'
      ? 'timed out'
      : selection === 0
        ? 'no context selected'
        : `last ${selection} messages selected`;
    const userPart = user ? ` by @${user}` : '';
    outputSessionLog('info', `🧵 Session (${formatShortId(threadId)}) context: ${desc}${userPart}`, threadId);
  },

  /**
   * Log permission mode change
   */
  permissionMode: (threadId: string, mode: 'interactive' | 'skip', user: string): void => {
    const emoji = mode === 'interactive' ? '🔐' : '⚡';
    outputSessionLog('info', `${emoji} Session (${formatShortId(threadId)}) permissions set to ${mode} by @${user}`, threadId);
  },

  /**
   * Log debug message (only if debug enabled)
   */
  debug: (threadId: string, message: string): void => {
    outputSessionLog('debug', `[debug] Session (${formatShortId(threadId)}): ${message}`, threadId);
  },
};

// =============================================================================
// Time Formatting
// =============================================================================

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string like "5m 30s" or "2h 15m"
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}

/**
 * Format a relative time from a date to now (long format).
 *
 * @param date - The date to format relative to now
 * @returns Formatted string like "5 minutes ago"
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

/**
 * Format a relative time from a date to now (short format).
 * Used in compact displays like sticky messages.
 *
 * @param date - The date to format relative to now
 * @returns Formatted string like "5m ago", "2h ago", "3d ago"
 */
export function formatRelativeTimeShort(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return '<1m ago';
}

// =============================================================================
// Number Formatting
// =============================================================================

/**
 * Format a number with thousands separators.
 *
 * @param n - The number to format
 * @returns Formatted string like "1,234,567"
 */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Format a percentage.
 *
 * @param value - The value (0-100 or 0-1)
 * @param isDecimal - Whether the value is a decimal (0-1)
 * @returns Formatted string like "75%"
 */
export function formatPercent(value: number, isDecimal = false): string {
  const percent = isDecimal ? value * 100 : value;
  return `${Math.round(percent)}%`;
}

/**
 * Format bytes to a human-readable size.
 *
 * @param bytes - Number of bytes
 * @returns Formatted string like "1.5 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${units[i]}`;
}

// =============================================================================
// String Formatting
// =============================================================================

/**
 * Truncate a string to a maximum length with ellipsis.
 *
 * @param str - The string to truncate
 * @param maxLength - Maximum length including ellipsis
 * @returns Truncated string
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 1) + '…';
}

/**
 * Pluralize a word based on count.
 *
 * @param count - The count
 * @param singular - Singular form
 * @param plural - Plural form (defaults to singular + 's')
 * @returns Pluralized word with count
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${count} ${word}`;
}
