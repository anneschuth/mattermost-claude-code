/**
 * Thread context prompt module
 *
 * Handles offering users the option to include previous thread context
 * when a session restarts (via !cd, worktree creation, or mid-thread @mention).
 */

import type { Session } from './types.js';
import type { ThreadMessage } from '../platform/index.js';
import { NUMBER_EMOJIS, DENIAL_EMOJIS, getNumberEmojiIndex, isDenialEmoji } from '../utils/emoji.js';

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

  try {
    await session.platform.updatePost(postId, message);
  } catch (err) {
    console.error('  ⚠️ Failed to update context prompt post:', err);
  }
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
