/**
 * `!bug` sends session context off-infrastructure: screenshots to a public
 * anonymous file host, and a report body — including recent daemon log lines —
 * to a public GitHub issue on the maintainer's repository. Redaction is
 * best-effort. Operators in regulated environments need one switch that takes
 * the whole path away, and it has to fail closed.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { resolveBugReportsEnabled } from './types.js';

describe('resolveBugReportsEnabled', () => {
  test('an absent key keeps today\'s behaviour', () => {
    expect(resolveBugReportsEnabled(undefined)).toBe(true);
    expect(resolveBugReportsEnabled(true)).toBe(true);
  });

  test('a bare `bugReports:` disables it, because someone wrote the key', () => {
    // YAML parses `bugReports:` with no value as null. The sibling resolvers
    // treat null as absent; here it means an operator started to set the flag
    // and left it blank, which must not read as "on" (CodeRabbit review).
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveBugReportsEnabled(null)).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('false disables it', () => {
    expect(resolveBugReportsEnabled(false)).toBe(false);
  });

  test('a malformed value disables it, unlike the other feature flags', () => {
    // The siblings (auditLog, watches, routines) warn and fall back to their
    // default, which for those is harmless. Here the default direction sends
    // data to a public repository, so a typo in a config written to RESTRICT
    // the bot must not quietly leave it enabled.
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveBugReportsEnabled('false')).toBe(false);
      expect(resolveBugReportsEnabled('no')).toBe(false);
      expect(resolveBugReportsEnabled(0)).toBe(false);
      expect(resolveBugReportsEnabled({})).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
