/**
 * Keeps the per-turn tool counter behind the summary line and hands every
 * tool line to the details sink. See docs/quiet-tools-spec.md.
 */

import type { PlatformFormatter } from '../../platform/index.js';
import type { ToolActivityOp } from '../types.js';
import type { ToolDetailsSink } from '../tool-details/types.js';
import type { ExecutorContext } from './types.js';

export interface ToolTurnStats {
  started: number;
  finished: number;
  failed: number;
  firstStartAt: number | null;
  lastEndAt: number | null;
}

const fresh = (): ToolTurnStats => ({ started: 0, finished: 0, failed: 0, firstStartAt: null, lastEndAt: null });

/** `🔧 12 tools · 40 s`, with `…` while tools are still running, `· 1 ❌` on failures, `· details` when linked. */
export function renderToolSummary(
  stats: ToolTurnStats,
  now: number,
  link: string | null,
  formatter: Pick<PlatformFormatter, 'formatLink'>,
): string {
  const running = stats.started > stats.finished;
  const until = running || stats.lastEndAt === null ? now : stats.lastEndAt;
  const seconds = stats.firstStartAt === null ? 0 : Math.max(0, Math.round((until - stats.firstStartAt) / 1000));
  const parts = [`🔧 ${stats.started} ${stats.started === 1 ? 'tool' : 'tools'}`, `${seconds} s${running ? '…' : ''}`];
  if (stats.failed > 0) parts.push(`${stats.failed} ❌`);
  if (link) parts.push(formatter.formatLink('details', link));
  return parts.join(' · ');
}

export interface ToolActivityExecutorOptions {
  mode: 'summary' | 'hidden';
  sink: ToolDetailsSink;
  /** Called with the new summary line whenever it changes (summary mode only). */
  onHeader: (line: string) => void;
  now?: () => number;
}

export class ToolActivityExecutor {
  private stats = fresh();

  constructor(private readonly options: ToolActivityExecutorOptions) {}

  getStats(): Readonly<ToolTurnStats> {
    return this.stats;
  }

  async execute(op: ToolActivityOp, ctx: ExecutorContext): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    if (op.kind === 'start') {
      this.stats.started++;
      this.stats.firstStartAt ??= now;
      await this.options.sink.append(op, ctx);
      this.renderHeader(now, ctx);
    } else if (op.kind === 'end') {
      this.stats.finished++;
      if (!op.ok) this.stats.failed++;
      this.stats.lastEndAt = now;
      await this.options.sink.append(op, ctx);
      this.renderHeader(now, ctx);
    } else if (this.stats.started > 0) {
      // turn_end: the final line, rendered by the result flush that follows.
      this.renderHeader(now, ctx);
    }
  }

  /**
   * After the reply's result flush: the turn's post exists (if it ever
   * will), so the sink can deliver and close, and the counter starts over.
   */
  async afterResultFlush(ctx: ExecutorContext): Promise<void> {
    if (this.stats.started === 0) return;
    await this.options.sink.turnEnded(ctx);
    this.stats = fresh();
  }

  /** Session restart: the turn in progress is gone, and so is its counter. */
  reset(): void {
    this.stats = fresh();
    this.options.sink.reset();
  }

  private renderHeader(now: number, ctx: ExecutorContext): void {
    if (this.options.mode !== 'summary') return;
    this.options.onHeader(renderToolSummary(this.stats, now, this.options.sink.link(), ctx.formatter));
  }
}
