/**
 * Emoji constants and helpers for chat platform reactions
 *
 * Platform-agnostic emoji utilities used across session management,
 * permission handling, and user interactions.
 */

/** Emoji names that indicate approval */
export const APPROVAL_EMOJIS = ['+1', 'thumbsup'] as const;

/** Emoji names that indicate denial */
export const DENIAL_EMOJIS = ['-1', 'thumbsdown'] as const;

/** Emoji names that indicate "allow all" / invite / session-wide approval */
export const ALLOW_ALL_EMOJIS = ['white_check_mark', 'heavy_check_mark'] as const;

/** Number emojis for multi-choice questions (1-4) */
export const NUMBER_EMOJIS = ['one', 'two', 'three', 'four'] as const;

/** Emojis for canceling/killing a session */
export const CANCEL_EMOJIS = ['x', 'octagonal_sign', 'stop_sign'] as const;

/** Emojis for escaping/pausing a session */
export const ESCAPE_EMOJIS = ['double_vertical_bar', 'pause_button'] as const;

/**
 * Check if the emoji indicates approval (thumbs up)
 */
export function isApprovalEmoji(emoji: string): boolean {
  return (APPROVAL_EMOJIS as readonly string[]).includes(emoji);
}

/**
 * Check if the emoji indicates denial (thumbs down)
 */
export function isDenialEmoji(emoji: string): boolean {
  return (DENIAL_EMOJIS as readonly string[]).includes(emoji);
}

/**
 * Check if the emoji indicates "allow all" or invitation
 */
export function isAllowAllEmoji(emoji: string): boolean {
  return (ALLOW_ALL_EMOJIS as readonly string[]).includes(emoji);
}

/**
 * Check if the emoji indicates session cancellation
 */
export function isCancelEmoji(emoji: string): boolean {
  return (CANCEL_EMOJIS as readonly string[]).includes(emoji);
}

/**
 * Check if the emoji indicates escape/pause
 */
export function isEscapeEmoji(emoji: string): boolean {
  return (ESCAPE_EMOJIS as readonly string[]).includes(emoji);
}

/** Unicode number emoji variants that also map to indices */
const UNICODE_NUMBER_EMOJIS: Record<string, number> = {
  '1️⃣': 0,
  '2️⃣': 1,
  '3️⃣': 2,
  '4️⃣': 3,
};

/**
 * Get the index (0-based) for a number emoji, or -1 if not a number emoji
 * Handles both text names ('one', 'two') and unicode variants ('1️⃣', '2️⃣')
 */
export function getNumberEmojiIndex(emoji: string): number {
  const textIndex = (NUMBER_EMOJIS as readonly string[]).indexOf(emoji);
  if (textIndex >= 0) return textIndex;
  return UNICODE_NUMBER_EMOJIS[emoji] ?? -1;
}
