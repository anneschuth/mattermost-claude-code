/**
 * Session module public exports
 *
 * Provides SessionManager for managing multiple concurrent Claude Code sessions.
 */

export { SessionManager } from './manager.js';
export type {
  Session,
  PendingApproval,
  PendingQuestionSet,
  PendingMessageApproval,
} from './types.js';
