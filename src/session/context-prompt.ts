/**
 * Thread context prompt module
 *
 * Handles offering users the option to include previous thread context
 * when a session restarts (via !cd, worktree creation, or mid-thread @mention).
 */

import type { Session } from './types.js';
import type { ThreadMessage } from '../platform/index.js';
import { NUMBER_EMOJIS, DENIAL_EMOJIS, getNumberEmojiIndex, isDenialEmoji } from '../utils/emoji.js';
import { withErrorHandling } from './error-handler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('context');

/** Get session-scoped logger for routing to correct UI panel */
function sessionLog(session: Session) {
  return log.forSession(session.sessionId);
}

// Context timeout in milliseconds (30 seconds)
export const CONTEXT_PROMPT_TIMEOUT_MS = 30000;

// Context options: last N messages
export const CONTEXT_OPTIONS = [3, 5, 10] as const;

/**
 * Pending context prompt state
 */
export interface PendingContextPrompt {
  postId: string;
  queuedPrompt: string;       // The prompt to send after decision
  threadMessageCount: number; // Total messages in thread before this point
  createdAt: number;          // Timestamp for timeout tracking
  timeoutId?: ReturnType<typeof setTimeout>; // Reference to timeout for cleanup
  availableOptions: number[]; // The actual options shown (e.g., [3, 5, 8] for 8 messages)
}

// ---------------------------------------------------------------------------
// Context prompt functions
// ---------------------------------------------------------------------------

/**
 * Check if we should prompt for context.
 * Returns the number of messages available, or 0 if we shouldn't prompt.
 */
export async function getThreadContextCount(
  session: Session,
  excludePostId?: string
): Promise<number> {
  try {
    const messages = await session.platform.getThreadHistory(
      session.threadId,
      { excludeBotMessages: true }
    );

    // Filter out the current post if specified
    const relevantMessages = excludePostId
      ? messages.filter(m => m.id !== excludePostId)
      : messages;

    return relevantMessages.length;
  } catch {
    return 0;
  }
}

/**
 * Get the valid context options based on available message count.
 * Only returns options that are <= messageCount.
 */
export function getValidContextOptions(messageCount: number): number[] {
  return CONTEXT_OPTIONS.filter(opt => opt <= messageCount);
}

/**
 * Post the context prompt to the user.
 * Returns the pending context prompt state.
 */
export async function postContextPrompt(
  session: Session,
  queuedPrompt: string,
  messageCount: number,
  registerPost: (postId: string, threadId: string) => void,
  onTimeout: () => void
): Promise<PendingContextPrompt> {
  // Filter options to only those <= messageCount
  const validOptions = getValidContextOptions(messageCount);

  // Build message with only valid options
  let optionsText = '';
  const reactionOptions: string[] = [];

  for (let i = 0; i < validOptions.length; i++) {
    const opt = validOptions[i];
    const emoji = ['1️⃣', '2️⃣', '3️⃣'][i];
    optionsText += `${emoji} Last ${opt} messages\n`;
    reactionOptions.push(NUMBER_EMOJIS[i]);
  }

  // Add "All messages" option if messageCount > largest option shown
  // or if no options are valid (messageCount < smallest option)
  if (validOptions.length === 0 || messageCount > validOptions[validOptions.length - 1]) {
    const nextIndex = validOptions.length;
    if (nextIndex < 3) {
      const emoji = ['1️⃣', '2️⃣', '3️⃣'][nextIndex];
      optionsText += `${emoji} All ${messageCount} messages\n`;
      reactionOptions.push(NUMBER_EMOJIS[nextIndex]);
    }
  }

  // Add no context option
  optionsText += `❌ No context (default after 30s)`;
  reactionOptions.push(DENIAL_EMOJIS[0]);

  const message =
    `🧵 **Include thread context?**\n` +
    `This thread has ${messageCount} message${messageCount === 1 ? '' : 's'} before this point.\n` +
    `React to include previous messages, or continue without context.\n\n` +
    optionsText;

  const post = await session.platform.createInteractivePost(
    message,
    reactionOptions,
    session.threadId
  );

  // Register for reaction routing
  registerPost(post.id, session.threadId);

  // Set up timeout
  const timeoutId = setTimeout(onTimeout, CONTEXT_PROMPT_TIMEOUT_MS);

  // Build the list of available options that were shown
  // This includes the valid CONTEXT_OPTIONS plus potentially "all messages"
  const availableOptions = [...validOptions];
  if (validOptions.length === 0 || messageCount > validOptions[validOptions.length - 1]) {
    if (validOptions.length < 3) {
      availableOptions.push(messageCount); // "All X messages" option
    }
  }

  return {
    postId: post.id,
    queuedPrompt,
    threadMessageCount: messageCount,
    createdAt: Date.now(),
    timeoutId,
    availableOptions,
  };
}

/**
 * Handle a reaction on the context prompt.
 * Returns the number of messages to include, or null if not a valid reaction.
 * Returns 0 for "no context" selection.
 *
 * @param emojiName - The emoji that was reacted with
 * @param availableOptions - The options that were shown in the prompt
 */
export function getContextSelectionFromReaction(
  emojiName: string,
  availableOptions: number[]
): number | null {
  // Check for number emoji (1, 2, 3)
  const numberIndex = getNumberEmojiIndex(emojiName);
  if (numberIndex >= 0 && numberIndex < availableOptions.length) {
    return availableOptions[numberIndex];
  }

  // Check for "no context" / denial emoji
  if (isDenialEmoji(emojiName)) {
    return 0;
  }

  // Also accept 'x' emoji as "no context"
  if (emojiName === 'x') {
    return 0;
  }

  return null; // Not a valid context selection reaction
}

/**
 * Get thread messages for context.
 */
export async function getThreadMessagesForContext(
  session: Session,
  limit: number,
  excludePostId?: string
): Promise<ThreadMessage[]> {
  const messages = await session.platform.getThreadHistory(
    session.threadId,
    { limit, excludeBotMessages: true }
  );

  // Filter out the current post if specified
  return excludePostId
    ? messages.filter(m => m.id !== excludePostId)
    : messages;
}

/**
 * Format thread messages as context for Claude.
 */
export function formatContextForClaude(messages: ThreadMessage[]): string {
  if (messages.length === 0) return '';

  const lines = ['[Previous conversation in this thread:]', ''];

  for (const msg of messages) {
    // Truncate very long messages
    const content = msg.message.length > 500
      ? msg.message.substring(0, 500) + '...'
      : msg.message;
    lines.push(`@${msg.username}: ${content}`);
  }

  lines.push('', '---', '', '[Current request:]');

  return lines.join('\n');
}

/**
 * Update the context prompt post to show the user's selection.
 */
export async function updateContextPromptPost(
  session: Session,
  postId: string,
  selection: number | 'timeout' | 'skip',
  username?: string
): Promise<void> {
  let message: string;

  if (selection === 'timeout') {
    message = '⏱️ Continuing without context (no response)';
  } else if (selection === 'skip' || selection === 0) {
    message = username
      ? `✅ Continuing without context (skipped by @${username})`
      : '✅ Continuing without context';
  } else {
    message = username
      ? `✅ Including last ${selection} messages (selected by @${username})`
      : `✅ Including last ${selection} messages`;
  }

  await withErrorHandling(
    () => session.platform.updatePost(postId, message),
    { action: 'Update context prompt post', session }
  );
}

/**
 * Clear the context prompt timeout.
 */
export function clearContextPromptTimeout(pending: PendingContextPrompt): void {
  if (pending.timeoutId) {
    clearTimeout(pending.timeoutId);
    pending.timeoutId = undefined;
  }
}

// =============================================================================
// High-level Context Prompt Handling
// =============================================================================

/**
 * Context for handling context prompts.
 */
export interface ContextPromptHandler {
  registerPost: (postId: string, threadId: string) => void;
  startTyping: (session: Session) => void;
  persistSession: (session: Session) => void;
  injectMetadataReminder: (message: string, session: Session) => string;
}

/**
 * Handle reaction on a context prompt.
 * Returns true if the reaction was handled.
 */
export async function handleContextPromptReaction(
  session: Session,
  emojiName: string,
  username: string,
  ctx: ContextPromptHandler
): Promise<boolean> {
  if (!session.pendingContextPrompt) return false;

  const selection = getContextSelectionFromReaction(
    emojiName,
    session.pendingContextPrompt.availableOptions
  );
  if (selection === null) return false; // Not a valid context selection reaction

  const pending = session.pendingContextPrompt;

  // Clear the timeout
  clearContextPromptTimeout(pending);

  // Update the post to show selection
  await updateContextPromptPost(session, pending.postId, selection, username);

  // Get the queued prompt
  const queuedPrompt = pending.queuedPrompt;

  // Clear pending context prompt
  session.pendingContextPrompt = undefined;

  // Build message with or without context
  let messageToSend = queuedPrompt;
  if (selection > 0) {
    const messages = await getThreadMessagesForContext(session, selection, pending.postId);
    if (messages.length > 0) {
      const contextPrefix = formatContextForClaude(messages);
      messageToSend = contextPrefix + queuedPrompt;
    }
  }

  // Increment message counter
  session.messageCount++;

  // Inject metadata reminder periodically
  messageToSend = ctx.injectMetadataReminder(messageToSend, session);

  // Send the message to Claude
  if (session.claude.isRunning()) {
    session.claude.sendMessage(messageToSend);
    ctx.startTyping(session);
  }

  // Persist updated state
  ctx.persistSession(session);

  sessionLog(session).debug(`🧵 Context selection: ${selection === 0 ? 'none' : `last ${selection} messages`} by @${username}`);

  return true;
}

/**
 * Handle context prompt timeout.
 */
export async function handleContextPromptTimeout(
  session: Session,
  ctx: ContextPromptHandler
): Promise<void> {
  if (!session.pendingContextPrompt) return;

  const pending = session.pendingContextPrompt;

  // Update the post to show timeout
  await updateContextPromptPost(session, pending.postId, 'timeout');

  // Get the queued prompt
  const queuedPrompt = pending.queuedPrompt;

  // Clear pending context prompt
  session.pendingContextPrompt = undefined;

  // Increment message counter
  session.messageCount++;

  // Inject metadata reminder periodically
  const messageToSend = ctx.injectMetadataReminder(queuedPrompt, session);

  // Send the message without context
  if (session.claude.isRunning()) {
    session.claude.sendMessage(messageToSend);
    ctx.startTyping(session);
  }

  // Persist updated state
  ctx.persistSession(session);

  sessionLog(session).debug(`🧵 Context prompt timed out, continuing without context`);
}

/**
 * Offer context prompt after a session restart or mid-thread start.
 * If there's thread history, posts the context prompt and queues the message.
 * If no history, sends the message immediately.
 * Returns true if context prompt was posted, false if message was sent directly.
 */
export async function offerContextPrompt(
  session: Session,
  queuedPrompt: string,
  ctx: ContextPromptHandler,
  excludePostId?: string
): Promise<boolean> {
  // Get thread history count (exclude bot messages and the triggering message)
  const messageCount = await getThreadContextCount(session, excludePostId);

  if (messageCount === 0) {
    // No previous messages, send directly
    session.messageCount++;
    const messageToSend = ctx.injectMetadataReminder(queuedPrompt, session);
    if (session.claude.isRunning()) {
      session.claude.sendMessage(messageToSend);
      ctx.startTyping(session);
    }
    return false;
  }

  if (messageCount === 1) {
    // Only one message (the thread starter) - auto-include without asking
    const messages = await getThreadMessagesForContext(session, 1, excludePostId);
    let messageToSend = queuedPrompt;
    if (messages.length > 0) {
      const contextPrefix = formatContextForClaude(messages);
      messageToSend = contextPrefix + queuedPrompt;
    }

    session.messageCount++;
    messageToSend = ctx.injectMetadataReminder(messageToSend, session);
    if (session.claude.isRunning()) {
      session.claude.sendMessage(messageToSend);
      ctx.startTyping(session);
    }

    sessionLog(session).debug(`🧵 Auto-included 1 message as context (thread starter)`);

    return false;
  }

  // Post context prompt
  const pending = await postContextPrompt(
    session,
    queuedPrompt,
    messageCount,
    ctx.registerPost,
    () => handleContextPromptTimeout(session, ctx)
  );

  session.pendingContextPrompt = pending;
  ctx.persistSession(session);

  sessionLog(session).debug(`🧵 Context prompt posted (${messageCount} messages available)`);

  return true;
}
