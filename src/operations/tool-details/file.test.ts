import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, readdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileSink, safeSegment, stripAnsi } from './file.js';
import { createToolActivityOp } from '../types.js';
import type { ExecutorContext } from '../executors/types.js';
import type { ToolActivityEvent } from './types.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tool-details-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function ctxWith() {
  const posts: string[] = [];
  const errors: string[] = [];
  const ctx = {
    sessionId: 'slack-vvs:1.23',
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: (m: string) => errors.push(m) },
    createPost: async (content: string) => { posts.push(content); return { id: 'p', platformId: 'p', channelId: 'c', message: content, createAt: 0, userId: 'bot' }; },
  } as unknown as ExecutorContext;
  return { ctx, posts, errors };
}

const start = (id: string, display: string) => createToolActivityOp('s', { kind: 'start', toolUseId: id, name: 'Bash', display }) as ToolActivityEvent;
const end = (id: string, ok = true) => createToolActivityOp('s', { kind: 'end', toolUseId: id, ok, elapsedMs: 0, display: ok ? '  ↳ ✓ (5s)' : '  ↳ ❌ Error' }) as ToolActivityEvent;

describe('file sink', () => {
  it('writes one HTML page per turn under <dir>/<platform>/<session>/, escaped, and links it when a URL base is set', async () => {
    const { ctx } = ctxWith();
    const sink = createFileSink({ dir, urlBase: 'https://agents.example.com/tool-details', platformId: 'slack-vvs', sessionId: 'slack-vvs:1.23' });

    await sink.append(start('t1', 'Bash `ls -la <dir>`'), ctx);
    expect(sink.link()).toBe('https://agents.example.com/tool-details/slack-vvs/slack-vvs_3A1_2E23/1.html');
    await sink.append(end('t1'), ctx);
    await sink.turnEnded(ctx);

    const page = await readFile(join(dir, 'slack-vvs', 'slack-vvs_3A1_2E23', '1.html'), 'utf8');
    expect(page).toContain('Bash `ls -la &lt;dir&gt;`');
    expect(page).toContain('↳ ✓ (5s)');
    expect(page).not.toContain('<dir>');
  });

  it('the second turn gets its own page and the index lists both', async () => {
    const { ctx } = ctxWith();
    const sink = createFileSink({ dir, platformId: 'p', sessionId: 's' });

    await sink.append(start('t1', 'Read a'), ctx);
    await sink.turnEnded(ctx);
    await sink.append(start('t2', 'Read b'), ctx);
    await sink.turnEnded(ctx);

    expect((await readdir(join(dir, 'p', 's'))).sort()).toEqual(['1.html', '2.html', 'index.html']);
    const index = await readFile(join(dir, 'p', 's', 'index.html'), 'utf8');
    expect(index).toContain('href="1.html"');
    expect(index).toContain('href="2.html"');
  });

  it('without a URL base there is no link, and the page is still written', async () => {
    const { ctx } = ctxWith();
    const sink = createFileSink({ dir, platformId: 'p', sessionId: 's' });

    await sink.append(start('t1', 'Read a'), ctx);

    expect(sink.link()).toBeNull();
    expect(await readFile(join(dir, 'p', 's', '1.html'), 'utf8')).toContain('Read a');
  });

  it('a reset while a write is pending leaves that write on its own turn and body (Gemini review)', async () => {
    const { ctx } = ctxWith();
    const sink = createFileSink({ dir, platformId: 'p', sessionId: 's' });

    const pending = sink.append(start('t1', 'Read before reset'), ctx);
    sink.reset();
    await pending;
    await sink.append(start('t2', 'Read after reset'), ctx);
    await sink.turnEnded(ctx);

    expect(await readFile(join(dir, 'p', 's', '1.html'), 'utf8')).toContain('Read before reset');
    const second = await readFile(join(dir, 'p', 's', '2.html'), 'utf8');
    expect(second).toContain('Read after reset');
    expect(second).not.toContain('Read before reset');
  });

  it('path segments are injective and cannot escape: distinct ids never share a directory, dot segments cannot occur', () => {
    expect(safeSegment('a:b')).not.toBe(safeSegment('a/b'));
    expect(safeSegment('..')).toBe('_2E_2E');
    expect(safeSegment('.')).toBe('_2E');
    expect(safeSegment('plain-id')).toBe('plain-id');
    expect(safeSegment('')).toBe('_');
  });

  it('pages and their directory are private to the daemon user', async () => {
    const { ctx } = ctxWith();
    const sink = createFileSink({ dir, platformId: 'p', sessionId: 's' });
    await sink.append(start('t1', 'Read a'), ctx);
    await sink.turnEnded(ctx);

    expect((await stat(join(dir, 'p', 's'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'p', 's', '1.html'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'p', 's', 'index.html'))).mode & 0o777).toBe(0o600);
  });

  it('ANSI escape sequences are stripped', () => {
    expect(stripAnsi('\x1b[32mok\x1b[0m and \x1b[1;31mred\x1b[m')).toBe('ok and red');
    // OSC 8 hyperlink (BEL-terminated) and an ST-terminated title (Codex review)
    expect(stripAnsi('\x1b]8;;https://x\x07link\x1b]8;;\x07 \x1b]0;title\x1b\\end')).toBe('link end');
  });

  it('a write failure is reported once in the channel and the sink stops, the reply is unaffected', async () => {
    const { ctx, posts, errors } = ctxWith();
    const sink = createFileSink({ dir: join(dir, 'not-a-dir.txt', 'x'), platformId: 'p', sessionId: 's' });
    await Bun.write(join(dir, 'not-a-dir.txt'), 'a file where a directory is needed');

    await sink.append(start('t1', 'Read a'), ctx);
    await sink.append(start('t2', 'Read b'), ctx);
    await sink.turnEnded(ctx);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('tool details');
    expect(errors).toHaveLength(1);
    expect(sink.link()).toBeNull();
  });
});
