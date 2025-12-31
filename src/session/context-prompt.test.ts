import { describe, it, expect } from 'bun:test';
import {
  getContextSelectionFromReaction,
  formatContextForClaude,
  getValidContextOptions,
  CONTEXT_OPTIONS,
} from './context-prompt.js';
import type { ThreadMessage } from '../platform/index.js';

describe('context-prompt', () => {
  describe('getValidContextOptions', () => {
    it('returns empty array for 0 messages', () => {
      expect(getValidContextOptions(0)).toEqual([]);
    });

    it('returns empty array for 2 messages (less than smallest option)', () => {
      expect(getValidContextOptions(2)).toEqual([]);
    });

    it('returns [3] for 3 messages', () => {
      expect(getValidContextOptions(3)).toEqual([3]);
    });

    it('returns [3] for 4 messages', () => {
      expect(getValidContextOptions(4)).toEqual([3]);
    });

    it('returns [3, 5] for 5 messages', () => {
      expect(getValidContextOptions(5)).toEqual([3, 5]);
    });

    it('returns [3, 5] for 8 messages', () => {
      expect(getValidContextOptions(8)).toEqual([3, 5]);
    });

    it('returns [3, 5, 10] for 10 messages', () => {
      expect(getValidContextOptions(10)).toEqual([3, 5, 10]);
    });

    it('returns [3, 5, 10] for 20 messages', () => {
      expect(getValidContextOptions(20)).toEqual([3, 5, 10]);
    });
  });

  describe('getContextSelectionFromReaction', () => {
    const standardOptions = [3, 5, 10];
    const customOptions = [3, 5, 8]; // For 8 messages

    it('returns first option for "one" emoji', () => {
      expect(getContextSelectionFromReaction('one', standardOptions)).toBe(3);
      expect(getContextSelectionFromReaction('one', customOptions)).toBe(3);
    });

    it('returns second option for "two" emoji', () => {
      expect(getContextSelectionFromReaction('two', standardOptions)).toBe(5);
      expect(getContextSelectionFromReaction('two', customOptions)).toBe(5);
    });

    it('returns third option for "three" emoji', () => {
      expect(getContextSelectionFromReaction('three', standardOptions)).toBe(10);
      expect(getContextSelectionFromReaction('three', customOptions)).toBe(8); // "All 8 messages"
    });

    it('returns 0 (no context) for denial emojis', () => {
      expect(getContextSelectionFromReaction('-1', standardOptions)).toBe(0);
      expect(getContextSelectionFromReaction('thumbsdown', standardOptions)).toBe(0);
    });

    it('returns 0 (no context) for "x" emoji', () => {
      expect(getContextSelectionFromReaction('x', standardOptions)).toBe(0);
    });

    it('returns null for invalid emojis', () => {
      expect(getContextSelectionFromReaction('heart', standardOptions)).toBe(null);
      expect(getContextSelectionFromReaction('+1', standardOptions)).toBe(null);
    });

    it('returns null for out-of-range number emojis', () => {
      const twoOptions = [3, 5];
      expect(getContextSelectionFromReaction('three', twoOptions)).toBe(null);
    });

    it('handles unicode number emojis', () => {
      expect(getContextSelectionFromReaction('1️⃣', standardOptions)).toBe(3);
      expect(getContextSelectionFromReaction('2️⃣', standardOptions)).toBe(5);
      expect(getContextSelectionFromReaction('3️⃣', standardOptions)).toBe(10);
    });
  });

  describe('formatContextForClaude', () => {
    it('returns empty string for empty messages', () => {
      expect(formatContextForClaude([])).toBe('');
    });

    it('formats single message correctly', () => {
      const messages: ThreadMessage[] = [
        {
          id: '1',
          userId: 'user1',
          username: 'alice',
          message: 'Hello world',
          createAt: Date.now(),
        },
      ];

      const result = formatContextForClaude(messages);
      expect(result).toContain('[Previous conversation in this thread:]');
      expect(result).toContain('@alice: Hello world');
      expect(result).toContain('[Current request:]');
    });

    it('formats multiple messages in order', () => {
      const messages: ThreadMessage[] = [
        {
          id: '1',
          userId: 'user1',
          username: 'alice',
          message: 'First message',
          createAt: 1000,
        },
        {
          id: '2',
          userId: 'user2',
          username: 'bob',
          message: 'Second message',
          createAt: 2000,
        },
      ];

      const result = formatContextForClaude(messages);
      expect(result).toContain('@alice: First message');
      expect(result).toContain('@bob: Second message');
      // Check order (alice before bob)
      const aliceIndex = result.indexOf('@alice');
      const bobIndex = result.indexOf('@bob');
      expect(aliceIndex).toBeLessThan(bobIndex);
    });

    it('truncates very long messages', () => {
      const longMessage = 'x'.repeat(600);
      const messages: ThreadMessage[] = [
        {
          id: '1',
          userId: 'user1',
          username: 'alice',
          message: longMessage,
          createAt: Date.now(),
        },
      ];

      const result = formatContextForClaude(messages);
      expect(result).toContain('...');
      expect(result).not.toContain(longMessage);
    });

    it('includes separator and current request header', () => {
      const messages: ThreadMessage[] = [
        {
          id: '1',
          userId: 'user1',
          username: 'alice',
          message: 'Test',
          createAt: Date.now(),
        },
      ];

      const result = formatContextForClaude(messages);
      expect(result).toContain('---');
      expect(result).toContain('[Current request:]');
    });
  });

  describe('CONTEXT_OPTIONS', () => {
    it('has exactly 3 options', () => {
      expect(CONTEXT_OPTIONS.length).toBe(3);
    });

    it('options are in ascending order', () => {
      for (let i = 1; i < CONTEXT_OPTIONS.length; i++) {
        expect(CONTEXT_OPTIONS[i]).toBeGreaterThan(CONTEXT_OPTIONS[i - 1]);
      }
    });

    it('first option is 3 messages', () => {
      expect(CONTEXT_OPTIONS[0]).toBe(3);
    });
  });
});
