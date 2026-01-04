/**
 * Logging Utility
 *
 * Provides consistent logging across the codebase with:
 * - Configurable prefix for different components
 * - DEBUG environment variable check
 * - stdout vs stderr routing option
 * - Pre-configured loggers for common components
 * - Custom log handler for Ink UI integration
 *
 * Benefits:
 * - DRY: Single implementation for all logging
 * - Consistency: Standard output formats
 * - Debugging: Easy to enable/disable debug logs
 * - Filtering: Component-based prefixes make logs filterable
 */

// =============================================================================
// Logger Interface
// =============================================================================

export interface Logger {
  /** Log a debug message (only when DEBUG=1) */
  debug: (msg: string, ...args: unknown[]) => void;
  /** Log a debug message with JSON data, truncated to avoid line-wrapping (only when DEBUG=1) */
  debugJson: (label: string, data: unknown, maxLen?: number) => void;
  /** Log an info message (always shown) */
  info: (msg: string, ...args: unknown[]) => void;
  /** Log a warning message (always shown) */
  warn: (msg: string, ...args: unknown[]) => void;
  /** Log an error message (always shown, to stderr) */
  error: (msg: string, err?: Error) => void;
  /** Create a session-scoped logger that attaches sessionId to all messages */
  forSession: (sessionId: string) => Logger;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogHandler {
  (level: LogLevel, component: string, message: string, sessionId?: string): void;
}

// Global log handler - when set, logs go through this instead of console
let globalLogHandler: LogHandler | null = null;

/**
 * Set a global log handler for UI integration.
 * When set, all log output is routed through this handler instead of console.
 *
 * @param handler - Function to handle log messages, or null to use console
 */
export function setLogHandler(handler: LogHandler | null): void {
  globalLogHandler = handler;
}

// =============================================================================
// Logger Factory
// =============================================================================

/**
 * Create a logger with a specific component name.
 *
 * @param component - Component name (e.g., 'lifecycle', 'events', 'mcp')
 * @param useStderr - If true, use stderr for all output (default: false)
 * @param sessionId - Optional session ID to attach to all log messages
 * @returns Logger object with debug, info, warn, and error methods
 *
 * @example
 * const log = createLogger('lifecycle');
 * log.info('Session started');
 * log.debug('Processing event'); // Only shown when DEBUG=1
 * log.error('Something failed', error);
 *
 * // Create session-scoped logger
 * const sessionLog = log.forSession('session-123');
 * sessionLog.info('Processing'); // Will include sessionId for UI routing
 */
export function createLogger(component: string, useStderr = false, sessionId?: string): Logger {
  const isDebug = () => process.env.DEBUG === '1';
  const consoleLog = useStderr ? console.error : console.log;

  // Helper to format message with args
  const formatMessage = (msg: string, args: unknown[]): string => {
    if (args.length === 0) return msg;
    return `${msg} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
  };

  // Max length for JSON in debugJson (leaves room for component prefix)
  const DEFAULT_JSON_MAX_LEN = 60;

  return {
    debug: (msg: string, ...args: unknown[]) => {
      if (isDebug()) {
        const fullMsg = formatMessage(msg, args);
        if (globalLogHandler) {
          globalLogHandler('debug', component, fullMsg, sessionId);
        } else {
          consoleLog(`  [${component}] ${fullMsg}`);
        }
      }
    },
    debugJson: (label: string, data: unknown, maxLen = DEFAULT_JSON_MAX_LEN) => {
      if (isDebug()) {
        const json = JSON.stringify(data);
        const truncated = json.length > maxLen ? `${json.substring(0, maxLen)}…` : json;
        const fullMsg = `${label}: ${truncated}`;
        if (globalLogHandler) {
          globalLogHandler('debug', component, fullMsg, sessionId);
        } else {
          consoleLog(`  [${component}] ${fullMsg}`);
        }
      }
    },
    info: (msg: string, ...args: unknown[]) => {
      const fullMsg = formatMessage(msg, args);
      if (globalLogHandler) {
        globalLogHandler('info', component, fullMsg, sessionId);
      } else {
        consoleLog(`  [${component}] ${fullMsg}`);
      }
    },
    warn: (msg: string, ...args: unknown[]) => {
      const fullMsg = formatMessage(msg, args);
      if (globalLogHandler) {
        globalLogHandler('warn', component, fullMsg, sessionId);
      } else {
        console.warn(`  [${component}] ⚠️ ${fullMsg}`);
      }
    },
    error: (msg: string, err?: Error) => {
      const fullMsg = err && isDebug() ? `${msg}\n${err.stack || err.message}` : msg;
      if (globalLogHandler) {
        globalLogHandler('error', component, fullMsg, sessionId);
      } else {
        console.error(`  [${component}] ❌ ${msg}`);
        if (err && isDebug()) {
          console.error(err);
        }
      }
    },
    forSession: (sid: string) => createLogger(component, useStderr, sid),
  };
}

// =============================================================================
// Pre-configured Loggers
// =============================================================================

/**
 * Logger for MCP permission server.
 * Uses stderr (required for MCP stdio communication).
 */
export const mcpLogger = createLogger('MCP', true);

/**
 * Logger for WebSocket client.
 */
export const wsLogger = createLogger('ws', false);

/**
 * Logger for session lifecycle operations.
 */
export const lifecycleLogger = createLogger('lifecycle');

/**
 * Logger for Claude event handling.
 */
export const eventsLogger = createLogger('events');

/**
 * Logger for user commands.
 */
export const commandsLogger = createLogger('commands');

/**
 * Logger for worktree management.
 */
export const worktreeLogger = createLogger('worktree');

/**
 * Logger for message streaming.
 */
export const streamingLogger = createLogger('streaming');

/**
 * Logger for reactions handling.
 */
export const reactionsLogger = createLogger('reactions');

/**
 * Logger for persistence operations.
 */
export const persistLogger = createLogger('persist');

/**
 * Logger for sticky message management.
 */
export const stickyLogger = createLogger('sticky');

/**
 * Logger for cleanup operations.
 */
export const cleanupLogger = createLogger('cleanup');

/**
 * Logger for context prompts.
 */
export const contextLogger = createLogger('context');
