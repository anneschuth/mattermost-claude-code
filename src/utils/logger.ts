/**
 * Simple debug logging utility
 *
 * Provides consistent logging across the codebase with:
 * - Configurable prefix for different components
 * - DEBUG environment variable check
 * - stdout vs stderr routing option
 */

export interface Logger {
  /** Log a debug message (only when DEBUG=1) */
  debug: (msg: string) => void;
  /** Log an info message (always shown) */
  info: (msg: string) => void;
  /** Log an error message (always shown, to stderr) */
  error: (msg: string) => void;
}

/**
 * Create a logger with a specific prefix
 *
 * @param prefix - Prefix to add to all messages (e.g., '[MCP]', '[ws]')
 * @param useStderr - If true, use stderr for all output (default: false)
 * @returns Logger object with debug, info, and error methods
 */
export function createLogger(prefix: string, useStderr = false): Logger {
  const isDebug = () => process.env.DEBUG === '1';
  const log = useStderr ? console.error : console.log;

  return {
    debug: (msg: string) => {
      if (isDebug()) {
        log(`${prefix} ${msg}`);
      }
    },
    info: (msg: string) => {
      log(`${prefix} ${msg}`);
    },
    error: (msg: string) => {
      console.error(`${prefix} ${msg}`);
    },
  };
}

/**
 * Pre-configured logger for MCP permission server
 * Uses stderr (required for MCP stdio communication)
 */
export const mcpLogger = createLogger('[MCP]', true);

/**
 * Pre-configured logger for WebSocket client
 * Uses stdout with indentation for visual hierarchy
 */
export const wsLogger = createLogger('  [ws]', false);
