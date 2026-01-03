import { describe, it, expect } from 'bun:test';
import {
  isVersionCompatible,
  CLAUDE_CLI_VERSION_RANGE,
  validateClaudeCli,
} from './version-check.js';

describe('version-check', () => {
  describe('CLAUDE_CLI_VERSION_RANGE', () => {
    it('is defined', () => {
      expect(CLAUDE_CLI_VERSION_RANGE).toBeDefined();
      expect(typeof CLAUDE_CLI_VERSION_RANGE).toBe('string');
    });
  });

  describe('isVersionCompatible', () => {
    it('returns true for versions in the valid range', () => {
      expect(isVersionCompatible('2.0.74')).toBe(true);
      expect(isVersionCompatible('2.0.75')).toBe(true);
      expect(isVersionCompatible('2.0.76')).toBe(true);
    });

    it('returns false for versions outside the range', () => {
      expect(isVersionCompatible('2.0.73')).toBe(false);
      expect(isVersionCompatible('2.0.77')).toBe(false);
      expect(isVersionCompatible('2.1.0')).toBe(false);
      expect(isVersionCompatible('1.0.17')).toBe(false);
    });

    it('handles invalid version strings', () => {
      expect(isVersionCompatible('')).toBe(false);
      expect(isVersionCompatible('invalid')).toBe(false);
    });
  });

  describe('validateClaudeCli', () => {
    it('returns validation result with expected structure', () => {
      const result = validateClaudeCli();

      expect(result).toHaveProperty('installed');
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('compatible');
      expect(result).toHaveProperty('message');
      expect(typeof result.installed).toBe('boolean');
      expect(typeof result.compatible).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });
  });
});
