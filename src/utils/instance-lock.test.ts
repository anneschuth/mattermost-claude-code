import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { acquireInstanceLock } from './instance-lock.js';
import { hasStateHomeOverride, stateHome } from './state-home.js';

function withHome(fn: (lock: string) => void): void {
  const previous = process.env.CLAUDE_THREADS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'ct-lock-'));
  process.env.CLAUDE_THREADS_HOME = home;
  const lock = join(home, '.config', 'claude-threads', 'instance.lock');
  try {
    fn(lock);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_THREADS_HOME;
    else process.env.CLAUDE_THREADS_HOME = previous;
  }
}

describe('acquireInstanceLock', () => {
  test('takes, refuses for a live pid, and takes over a dead pid', () => {
    withHome((lock) => {
      const release = acquireInstanceLock();
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
      release();
      expect(existsSync(lock)).toBe(false);
      mkdirSync(join(lock, '..'), { recursive: true });
      writeFileSync(lock, '999999999'); // dead pid
      acquireInstanceLock()();
      writeFileSync(lock, String(process.ppid)); // live pid
      expect(() => acquireInstanceLock()).toThrow(/already uses/);
    });
  });

  test('the holding process may re-acquire its own lock', () => {
    withHome((lock) => {
      acquireInstanceLock();
      acquireInstanceLock()(); // 'wx' fails on the existing file, own pid is not a foreign holder
      expect(existsSync(lock)).toBe(false);
    });
  });

  test('takes over a stale lock and leaves no stray files', () => {
    withHome((lock) => {
      mkdirSync(join(lock, '..'), { recursive: true });
      writeFileSync(lock, '999999999');
      const release = acquireInstanceLock();
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
      expect(readdirSync(join(lock, '..'))).toEqual(['instance.lock']);
      release();
      expect(readdirSync(join(lock, '..'))).toEqual([]);
    });
  });

  test('resolves a relative CLAUDE_THREADS_HOME against cwd; $HOME itself is not an override', () => {
    const previous = process.env.CLAUDE_THREADS_HOME;
    try {
      process.env.CLAUDE_THREADS_HOME = './rel-state-home';
      expect(stateHome()).toBe(join(process.cwd(), 'rel-state-home'));
      expect(hasStateHomeOverride()).toBe(true);
      process.env.CLAUDE_THREADS_HOME = homedir();
      expect(hasStateHomeOverride()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_THREADS_HOME;
      else process.env.CLAUDE_THREADS_HOME = previous;
    }
  });

  test('the refusal names the lock file and how to clear a reused pid', () => {
    withHome((lock) => {
      mkdirSync(join(lock, '..'), { recursive: true });
      writeFileSync(lock, String(process.ppid));
      expect(() => acquireInstanceLock()).toThrow(`delete ${lock}`);
    });
  });

  test('creates the config directory owner-only when it is the first writer', () => {
    withHome((lock) => {
      acquireInstanceLock()();
      expect(statSync(join(lock, '..')).mode & 0o777).toBe(0o700);
    });
  });

  test('release does not remove a lock that a successor took over', () => {
    withHome((lock) => {
      const release = acquireInstanceLock();
      writeFileSync(lock, String(process.ppid)); // successor (live) overwrote it
      release();
      expect(readFileSync(lock, 'utf8')).toBe(String(process.ppid));
    });
  });
});
