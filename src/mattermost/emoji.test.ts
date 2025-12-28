import { describe, it, expect } from 'vitest';
import {
  isApprovalEmoji,
  isDenialEmoji,
  isAllowAllEmoji,
  isCancelEmoji,
  isEscapeEmoji,
  getNumberEmojiIndex,
  APPROVAL_EMOJIS,
  DENIAL_EMOJIS,
  ALLOW_ALL_EMOJIS,
  NUMBER_EMOJIS,
  CANCEL_EMOJIS,
  ESCAPE_EMOJIS,
} from './emoji.js';

describe('emoji helpers', () => {
  describe('isApprovalEmoji', () => {
    it('returns true for +1', () => {
      expect(isApprovalEmoji('+1')).toBe(true);
    });

    it('returns true for thumbsup', () => {
      expect(isApprovalEmoji('thumbsup')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isApprovalEmoji('heart')).toBe(false);
      expect(isApprovalEmoji('-1')).toBe(false);
      expect(isApprovalEmoji('x')).toBe(false);
    });

    it('matches all APPROVAL_EMOJIS', () => {
      for (const emoji of APPROVAL_EMOJIS) {
        expect(isApprovalEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('isDenialEmoji', () => {
    it('returns true for -1', () => {
      expect(isDenialEmoji('-1')).toBe(true);
    });

    it('returns true for thumbsdown', () => {
      expect(isDenialEmoji('thumbsdown')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isDenialEmoji('heart')).toBe(false);
      expect(isDenialEmoji('+1')).toBe(false);
      expect(isDenialEmoji('thumbsup')).toBe(false);
    });

    it('matches all DENIAL_EMOJIS', () => {
      for (const emoji of DENIAL_EMOJIS) {
        expect(isDenialEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('isAllowAllEmoji', () => {
    it('returns true for white_check_mark', () => {
      expect(isAllowAllEmoji('white_check_mark')).toBe(true);
    });

    it('returns true for heavy_check_mark', () => {
      expect(isAllowAllEmoji('heavy_check_mark')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isAllowAllEmoji('heart')).toBe(false);
      expect(isAllowAllEmoji('+1')).toBe(false);
      expect(isAllowAllEmoji('thumbsup')).toBe(false);
    });

    it('matches all ALLOW_ALL_EMOJIS', () => {
      for (const emoji of ALLOW_ALL_EMOJIS) {
        expect(isAllowAllEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('isCancelEmoji', () => {
    it('returns true for x', () => {
      expect(isCancelEmoji('x')).toBe(true);
    });

    it('returns true for octagonal_sign', () => {
      expect(isCancelEmoji('octagonal_sign')).toBe(true);
    });

    it('returns true for stop_sign', () => {
      expect(isCancelEmoji('stop_sign')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isCancelEmoji('heart')).toBe(false);
      expect(isCancelEmoji('-1')).toBe(false);
    });

    it('matches all CANCEL_EMOJIS', () => {
      for (const emoji of CANCEL_EMOJIS) {
        expect(isCancelEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('isEscapeEmoji', () => {
    it('returns true for double_vertical_bar', () => {
      expect(isEscapeEmoji('double_vertical_bar')).toBe(true);
    });

    it('returns true for pause_button', () => {
      expect(isEscapeEmoji('pause_button')).toBe(true);
    });

    it('returns false for other emojis', () => {
      expect(isEscapeEmoji('heart')).toBe(false);
      expect(isEscapeEmoji('x')).toBe(false);
    });

    it('matches all ESCAPE_EMOJIS', () => {
      for (const emoji of ESCAPE_EMOJIS) {
        expect(isEscapeEmoji(emoji)).toBe(true);
      }
    });
  });

  describe('getNumberEmojiIndex', () => {
    it('returns 0 for "one"', () => {
      expect(getNumberEmojiIndex('one')).toBe(0);
    });

    it('returns 1 for "two"', () => {
      expect(getNumberEmojiIndex('two')).toBe(1);
    });

    it('returns 2 for "three"', () => {
      expect(getNumberEmojiIndex('three')).toBe(2);
    });

    it('returns 3 for "four"', () => {
      expect(getNumberEmojiIndex('four')).toBe(3);
    });

    it('returns 0 for "1️⃣" (unicode)', () => {
      expect(getNumberEmojiIndex('1️⃣')).toBe(0);
    });

    it('returns 1 for "2️⃣" (unicode)', () => {
      expect(getNumberEmojiIndex('2️⃣')).toBe(1);
    });

    it('returns 2 for "3️⃣" (unicode)', () => {
      expect(getNumberEmojiIndex('3️⃣')).toBe(2);
    });

    it('returns 3 for "4️⃣" (unicode)', () => {
      expect(getNumberEmojiIndex('4️⃣')).toBe(3);
    });

    it('returns -1 for non-number emojis', () => {
      expect(getNumberEmojiIndex('heart')).toBe(-1);
      expect(getNumberEmojiIndex('five')).toBe(-1);
      expect(getNumberEmojiIndex('+1')).toBe(-1);
    });

    it('returns correct index for all NUMBER_EMOJIS', () => {
      for (let i = 0; i < NUMBER_EMOJIS.length; i++) {
        expect(getNumberEmojiIndex(NUMBER_EMOJIS[i])).toBe(i);
      }
    });
  });
});
