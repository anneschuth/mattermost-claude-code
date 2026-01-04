/**
 * Centralized Error Handler
 *
 * Provides consistent error handling across the codebase.
 * This eliminates the 4 different try-catch patterns found throughout
 * and standardizes how errors are logged and optionally reported to users.
 *
 * Benefits:
 * - Consistency: Single pattern for all error handling
 * - User feedback: Optionally notify users of errors
 * - Debugging: Structured error logging with context
 * - Recovery: Clear severity levels for different responses
 */

import type { Session } from './types.js';
import { createLogger } from '../utils/logger.js';
import { formatShortId } from '../utils/format.js';

const log = createLogger('error');

// =============================================================================
// Types
// =============================================================================

/**
 * Error severity levels determine how errors are handled.
 *
 * - recoverable: Log and continue (don't re-throw)
 * - session-fatal: Log, notify user, and re-throw
 * - system-fatal: Log and re-throw (system-level failure)
 */
export type ErrorSeverity = 'recoverable' | 'session-fatal' | 'system-fatal';

/**
 * Context about where/how the error occurred.
 */
export interface ErrorContext {
  /** Human-readable description of the action that failed */
  action: string;
  /** The session where the error occurred (optional) */
  session?: Session;
  /** Whether to post an error message to the user (default: false) */
  notifyUser?: boolean;
  /** Additional context for logging */
  details?: Record<string, unknown>;
}

// =============================================================================
// Error Classes
// =============================================================================

/**
 * SessionError - Error that occurred within a session context.
 * Includes session ID and action for debugging.
 */
export class SessionError extends Error {
  public readonly sessionId?: string;
  public readonly action: string;
  public readonly severity: ErrorSeverity;
  public readonly originalError?: Error;

  constructor(
    action: string,
    message: string,
    options?: {
      session?: Session;
      severity?: ErrorSeverity;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = 'SessionError';
    this.action = action;
    this.sessionId = options?.session?.threadId;
    this.severity = options?.severity ?? 'recoverable';
    this.originalError = options?.cause;

    // Capture original stack trace if available
    if (options?.cause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
    }
  }
}

// =============================================================================
// Error Handling Functions
// =============================================================================

/**
 * Handle an error with consistent logging and optional user notification.
 *
 * @param error - The error that occurred
 * @param context - Context about where the error occurred
 * @param severity - How severe the error is (determines if re-thrown)
 *
 * @example
 * try {
 *   await session.platform.updatePost(postId, message);
 * } catch (err) {
 *   await handleError(err, { action: 'Update post', session });
 * }
 */
export async function handleError(
  error: unknown,
  context: ErrorContext,
  severity: ErrorSeverity = 'recoverable'
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const sessionId = context.session?.threadId;

  // Format log message
  const sessionPart = sessionId ? ` (${formatShortId(sessionId)})` : '';
  const logMessage = `${context.action}${sessionPart}: ${message}`;

  // Log based on severity
  if (severity === 'recoverable') {
    log.warn(logMessage);
  } else {
    log.error(logMessage, error instanceof Error ? error : undefined);
  }

  // Log additional details in debug mode
  if (context.details) {
    log.debugJson('Error details', context.details);
  }

  // Notify user if requested and session available
  if (context.notifyUser && context.session) {
    try {
      await context.session.platform.createPost(
        `⚠️ **Error**: ${context.action} failed. Please try again.`,
        context.session.threadId
      );
    } catch (notifyError) {
      log.warn(`Could not notify user: ${notifyError}`);
    }
  }

  // Re-throw for fatal errors
  if (severity === 'session-fatal' || severity === 'system-fatal') {
    if (error instanceof SessionError) {
      throw error;
    }
    throw new SessionError(context.action, message, {
      session: context.session,
      severity,
      cause: error instanceof Error ? error : undefined,
    });
  }
}

/**
 * Wrapper for async operations with consistent error handling.
 * Returns undefined on recoverable errors, throws on fatal errors.
 *
 * @param operation - The async operation to execute
 * @param context - Context about the operation
 * @param severity - Error severity (default: recoverable)
 * @returns The operation result, or undefined if error occurred
 *
 * @example
 * const result = await withErrorHandling(
 *   () => session.platform.updatePost(postId, message),
 *   { action: 'Update post', session }
 * );
 * if (result) {
 *   // Success
 * }
 */
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  context: ErrorContext,
  severity: ErrorSeverity = 'recoverable'
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    await handleError(error, context, severity);
    return undefined;
  }
}

/**
 * Wrapper for sync operations with consistent error handling.
 * Returns undefined on recoverable errors, throws on fatal errors.
 *
 * @param operation - The sync operation to execute
 * @param context - Context about the operation
 * @param severity - Error severity (default: recoverable)
 * @returns The operation result, or undefined if error occurred
 */
export function withErrorHandlingSync<T>(
  operation: () => T,
  context: ErrorContext,
  severity: ErrorSeverity = 'recoverable'
): T | undefined {
  try {
    return operation();
  } catch (error) {
    // Fire-and-forget async handleError
    handleError(error, context, severity).catch(() => {});
    return undefined;
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Log an error without re-throwing (recoverable error).
 * Shorthand for handleError with severity 'recoverable'.
 */
export async function logError(
  error: unknown,
  context: ErrorContext
): Promise<void> {
  await handleError(error, context, 'recoverable');
}

/**
 * Log an error and notify the user.
 * Shorthand for handleError with notifyUser: true.
 */
export async function logAndNotify(
  error: unknown,
  context: ErrorContext
): Promise<void> {
  await handleError(error, { ...context, notifyUser: true }, 'recoverable');
}

/**
 * Try to execute an operation, returning a boolean success indicator.
 * Useful for operations where you only care if it succeeded.
 *
 * @example
 * const updated = await tryOperation(
 *   () => session.platform.updatePost(postId, message),
 *   { action: 'Update post', session }
 * );
 */
export async function tryOperation(
  operation: () => Promise<unknown>,
  context: ErrorContext
): Promise<boolean> {
  const result = await withErrorHandling(operation, context);
  return result !== undefined;
}

// =============================================================================
// Error Formatting
// =============================================================================

/**
 * Format an error for display to users.
 * Strips technical details and provides a friendly message.
 */
export function formatErrorForUser(error: unknown, action?: string): string {
  const actionPart = action ? `${action}: ` : '';

  if (error instanceof SessionError) {
    return `${actionPart}${error.message}`;
  }

  if (error instanceof Error) {
    // Remove technical prefixes and stack traces
    const message = error.message.split('\n')[0];
    return `${actionPart}${message}`;
  }

  return `${actionPart}An unexpected error occurred`;
}

/**
 * Check if an error is a specific type.
 * Useful for handling specific error cases differently.
 */
export function isErrorType(error: unknown, errorName: string): boolean {
  return error instanceof Error && error.name === errorName;
}

/**
 * Check if an error message contains a specific string.
 */
export function errorContains(error: unknown, substring: string): boolean {
  if (error instanceof Error) {
    return error.message.toLowerCase().includes(substring.toLowerCase());
  }
  return String(error).toLowerCase().includes(substring.toLowerCase());
}
