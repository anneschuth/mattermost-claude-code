import { describe, it, expect } from 'bun:test';
import { ToolActivityExecutor, renderToolSummary } from './tool-activity.js';
import { noneSink, type ToolDetailsSink, type ToolActivityEvent } from '../tool-details/types.js';
import { createToolActivityOp } from '../types.js';
import type { ExecutorContext } from './types.js';

const formatter = { formatLink: (text: string, url: string) => `[${text}](${url})` };
const ctx = { formatter, sessionId: 's' } as unknown as ExecutorContext;

function recordingSink(link: string | null = null) {
  const appended: ToolActivityEvent[] = [];
  let ended = 0;
  let resets = 0;
  const sink: ToolDetailsSink = {
    append: async (op) => { appended.push(op); },
    turnEnded: async () => { ended++; },
    link: () => link,
    reset: () => { resets++; },
  };
  return { sink, appended, ended: () => ended, resets: () => resets };
}

describe('renderToolSummary', () => {
  it('counts, times and marks running, failed and linked turns', () => {
    const base = { started: 1, finished: 0, failed: 0, firstStartAt: 1000, lastEndAt: null };
    expect(renderToolSummary(base, 3500, null, formatter)).toBe('🔧 1 tool · 3 s…');
    expect(renderToolSummary({ ...base, started: 12, finished: 12, failed: 1, lastEndAt: 41000 }, 99000, null, formatter)).toBe('🔧 12 tools · 40 s · 1 ❌');
    expect(renderToolSummary({ ...base, finished: 1, lastEndAt: 2000 }, 9000, 'https://x/t/1.html', formatter)).toBe('🔧 1 tool · 1 s · [details](https://x/t/1.html)');
  });
});

describe('ToolActivityExecutor', () => {
  it('summary: every start and end re-renders the header and reaches the sink; turn_end renders the final line', async () => {
    const headers: string[] = [];
    const { sink, appended } = recordingSink();
    let now = 1000;
    const exec = new ToolActivityExecutor({ mode: 'summary', sink, onHeader: (l) => headers.push(l), now: () => now });

    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 't1', name: 'Bash', display: 'Bash ls' }), ctx);
    now = 6000;
    await exec.execute(createToolActivityOp('s', { kind: 'end', toolUseId: 't1', ok: false, elapsedMs: 5000, display: '  ↳ ❌' }), ctx);
    now = 9000;
    await exec.execute(createToolActivityOp('s', { kind: 'turn_end' }), ctx);

    expect(headers).toEqual(['🔧 1 tool · 0 s…', '🔧 1 tool · 5 s · 1 ❌', '🔧 1 tool · 5 s · 1 ❌']);
    expect(appended.map((op) => op.kind)).toEqual(['start', 'end']);
  });

  it('hidden: the sink still gets every line, the header is never rendered', async () => {
    const headers: string[] = [];
    const { sink, appended } = recordingSink();
    const exec = new ToolActivityExecutor({ mode: 'hidden', sink, onHeader: (l) => headers.push(l) });

    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 't1', name: 'Read', display: 'Read x' }), ctx);
    await exec.execute(createToolActivityOp('s', { kind: 'end', toolUseId: 't1', ok: true, elapsedMs: 10, display: '  ↳ ✓' }), ctx);

    expect(headers).toEqual([]);
    expect(appended).toHaveLength(2);
  });

  it('after the result flush the sink is told the turn ended and the counter starts over; a turn without tools is silent', async () => {
    const { sink, ended } = recordingSink();
    const exec = new ToolActivityExecutor({ mode: 'summary', sink, onHeader: () => undefined });

    await exec.afterResultFlush(ctx);
    expect(ended()).toBe(0);

    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 't1', name: 'Read', display: 'Read x' }), ctx);
    await exec.execute(createToolActivityOp('s', { kind: 'turn_end' }), ctx);
    await exec.afterResultFlush(ctx);

    expect(ended()).toBe(1);
    expect(exec.getStats().started).toBe(0);
  });

  it('the none sink accepts everything and links nothing', async () => {
    await noneSink.append(createToolActivityOp('s', { kind: 'start', toolUseId: 't', name: 'n', display: 'd' }) as ToolActivityEvent, ctx);
    await noneSink.turnEnded(ctx);
    expect(noneSink.link()).toBeNull();
  });

  it('reset clears the counter and resets the sink', async () => {
    const { sink, resets } = recordingSink();
    const exec = new ToolActivityExecutor({ mode: 'summary', sink, onHeader: () => undefined });
    await exec.execute(createToolActivityOp('s', { kind: 'start', toolUseId: 't1', name: 'Read', display: 'Read x' }), ctx);

    exec.reset();

    expect(exec.getStats().started).toBe(0);
    expect(resets()).toBe(1);
  });
});
