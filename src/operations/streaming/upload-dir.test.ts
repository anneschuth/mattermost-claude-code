import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSessionUploadDir } from './handler.js';
function withHome(value: string | undefined, fn: () => void): void {
  const previous = process.env.CLAUDE_THREADS_HOME;
  if (value === undefined) delete process.env.CLAUDE_THREADS_HOME;
  else process.env.CLAUDE_THREADS_HOME = value;
  try { fn(); } finally {
    if (previous === undefined) delete process.env.CLAUDE_THREADS_HOME;
    else process.env.CLAUDE_THREADS_HOME = previous;
  }
}
describe('upload dir instance prefix', () => {
  test('default instance keeps the legacy path', () => {
    withHome(undefined, () => expect(getSessionUploadDir('p', 't')).toBe(join(tmpdir(), 'claude-threads-uploads', 'p-t')));
  });
  test('overriding instance gets a hash prefix, single segment', () => {
    withHome('/x/y', () => expect(getSessionUploadDir('p', 't')).toMatch(/claude-threads-uploads\/[0-9a-f]{12}-p-t$/));
  });
});
