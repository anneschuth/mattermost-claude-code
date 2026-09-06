import { describe, it, expect, mock } from 'bun:test';
import { createThreadSink } from './thread.js';
import { ContentExecutor } from '../executors/content.js';
import type { ExecutorContext } from '../executors/types.js';
import { createToolActivityOp } from '../types.js';
import type { ToolActivityEvent } from './types.js';
import { DefaultContentBreaker } from '../content-breaker.js';
import { PostTracker } from '../post-tracker.js';

function fakeContext(root: string) {
  const created: Array<{ content: string; root: string }> = [];
  const updated: Array<{ id: string; content: string }> = [];
  const warnings: string[] = [];
  const platform = {
    getFormatter: () => ({ formatMarkdown: (t: string) => t }),
    createPost: mock(async (content: string, threadId: string) => {
      created.push({ content, root: threadId });
      return { id: `d${created.length}`, platformId: 'p', channelId: 'c', message: content, createAt: 0, userId: 'bot' };
    }),
    updatePost: mock(async (id: string, content: string) => { updated.push({ id, content }); }),
    getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
  };
  const ctx = {
    sessionId: 's',
    threadId: root,
    platform,
    formatter: { formatMarkdown: (t: string) => t },
    logger: { debug: () => undefined, info: () => undefined, warn: (m: string) => warnings.push(m), error: () => undefined },
    postTracker: new PostTracker(),
    contentBreaker: new DefaultContentBreaker(),
    createPost: async (content: string) => platform.createPost(content, root),
  } as unknown as ExecutorContext;
  return { ctx, created, updated, warnings };
}

const start = (id: string, display: string) => createToolActivityOp('s', { kind: 'start', toolUseId: id, name: 'Bash', display }) as ToolActivityEvent;
const end = (id: string) => createToolActivityOp('s', { kind: 'end', toolUseId: id, ok: true, elapsedMs: 0, display: '  ↳ ✓' }) as ToolActivityEvent;

describe('thread sink', () => {
  it('posts the tool lines under the turn root and closes at turn end', async () => {
    const { ctx, created, updated } = fakeContext('root-1');
    const sink = createThreadSink({ contextFor: () => ctx, makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }) });

    await sink.append(start('t1', 'Bash ls'), ctx);
    await sink.append(end('t1'), ctx);
    await sink.turnEnded(ctx);

    expect(created).toHaveLength(1);
    expect(created[0].root).toBe('root-1');
    expect(created[0].content).toContain('Bash ls');
    expect(created[0].content).toContain('↳ ✓');
    expect(updated).toHaveLength(0);
  });

  it('queues lines until a root exists, then delivers them together', async () => {
    const { ctx, created } = fakeContext('root-2');
    let available = false;
    const sink = createThreadSink({ contextFor: () => (available ? ctx : null), makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }) });

    await sink.append(start('t1', 'Read a'), ctx);
    expect(created).toHaveLength(0);
    available = true;
    await sink.append(start('t2', 'Read b'), ctx);
    await sink.turnEnded(ctx);

    expect(created).toHaveLength(1);
    expect(created[0].content).toContain('Read a');
    expect(created[0].content).toContain('Read b');
  });

  it('a turn that never gets a root drops its lines with a warning, not silently', async () => {
    const { ctx, created, warnings } = fakeContext('root-3');
    const sink = createThreadSink({ contextFor: () => null, makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }) });

    await sink.append(start('t1', 'Read a'), ctx);
    await sink.turnEnded(ctx);

    expect(created).toHaveLength(0);
    expect(warnings.join(' ')).toContain('dropped');
  });

  it('each turn starts a fresh executor under the current root', async () => {
    const { ctx, created } = fakeContext('root-4');
    let root = 'turn-a';
    const sink = createThreadSink({ contextFor: () => ({ ...ctx, createPost: async (c: string) => ctx.platform.createPost(c, root) }) as ExecutorContext, makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }) });

    await sink.append(start('t1', 'first turn'), ctx);
    await sink.turnEnded(ctx);
    root = 'turn-b';
    await sink.append(start('t2', 'second turn'), ctx);
    await sink.turnEnded(ctx);

    expect(created.map((c) => c.root)).toEqual(['turn-a', 'turn-b']);
  });

  it('reset forgets the turn in progress: nothing queued survives, nothing is posted later', async () => {
    const { ctx, created, warnings } = fakeContext('root-5');
    const sink = createThreadSink({ contextFor: () => null, makeExecutor: () => new ContentExecutor({ registerPost: () => undefined, updateLastMessage: () => undefined }) });

    await sink.append(start('t1', 'Read a'), ctx);
    sink.reset();
    await sink.turnEnded(ctx);

    expect(created).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});
