/**
 * Event Transformer - Convert Claude events to message operations
 *
 * This module transforms Claude CLI events into MessageOperation objects.
 * This is a pure transformation layer with no side effects.
 *
 * The transformer extracts the logic from events.ts into testable functions
 * that don't depend on session state or platform APIs.
 */

import type { ClaudeEvent } from '../claude/cli.js';
import type { PlatformFormatter } from '../platform/formatter.js';
import type {
  MessageOperation,
  TaskItem,
  Question,
  QuestionOption,
} from './types.js';
import {
  createAppendContentOp,
  createFlushOp,
  createTaskListOp,
  createQuestionOp,
  createApprovalOp,
  createSubagentOp,
  createStatusUpdateOp,
  createToolActivityOp,
  type ToolActivityMode,
} from './types.js';
import { toolFormatterRegistry } from './tool-formatters/index.js';
import type { WorktreeContext } from './tool-formatters/index.js';
import type { TaskTracker } from './task-tracker.js';

// ---------------------------------------------------------------------------
// Transform Context
// ---------------------------------------------------------------------------

/**
 * Context for transforming events.
 * Contains only the information needed for transformation (no side effects).
 */
export interface TransformContext {
  /** Session ID for created operations */
  sessionId: string;
  /** Platform formatter for markdown */
  formatter: PlatformFormatter;
  /** Worktree info for path shortening (optional) */
  worktreeInfo?: WorktreeContext;
  /** Active tool start times (for elapsed time calculation) */
  toolStartTimes: Map<string, number>;
  /**
   * Accumulated TaskCreate/TaskUpdate state (persists across events).
   * Modern CLIs track tasks incrementally instead of TodoWrite's full list.
   */
  taskTracker: TaskTracker;
  /** Whether to include detailed previews */
  detailed?: boolean;
  /**
   * How tools render: `full` (default) inline; `summary` / `hidden` as
   * ToolActivityOps for the executor to count and route.
   */
  toolActivity?: ToolActivityMode;
}

function toolsInline(ctx: TransformContext): boolean {
  return (ctx.toolActivity ?? 'full') === 'full';
}

// ---------------------------------------------------------------------------
// Main Transform Function
// ---------------------------------------------------------------------------

/**
 * Transform a Claude event into message operations.
 *
 * @param event - The Claude event to transform
 * @param ctx - Transform context
 * @returns Array of operations (may be empty, may have multiple)
 */
export function transformEvent(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  // Sidechain events: some CLI versions forward subagent activity as
  // assistant/user events carrying parent_tool_use_id. That activity is
  // already represented by the SubagentExecutor; letting it through here
  // would render subagent tools into the main content stream and — worse —
  // let a subagent's TaskCreate/TaskUpdate calls permanently pollute the
  // main thread's task list (task ids are small integers in both
  // namespaces, so collisions corrupt updates).
  if ((event as { parent_tool_use_id?: unknown }).parent_tool_use_id) {
    return [];
  }

  switch (event.type) {
    case 'assistant':
      return transformAssistant(event, ctx);

    case 'user':
      return transformUser(event, ctx);

    // Legacy top-level tool_use/tool_result events. The real CLI wraps tool
    // results in `user` events (handled above) and tool uses in `assistant`
    // events; these cases are kept for old captures and test fixtures.
    case 'tool_use':
      return transformToolUse(event, ctx);

    case 'tool_result':
      return transformToolResult(event, ctx);

    case 'result':
      return transformResult(event, ctx);

    default:
      // Unknown event type - no operations
      return [];
  }
}

// ---------------------------------------------------------------------------
// Assistant Event Transformation
// ---------------------------------------------------------------------------

/**
 * Transform an assistant event.
 * Handles text, tool_use, and thinking blocks.
 *
 * Each tool_use block creates a separate operation with isToolOutput=true
 * so that the content executor can add proper spacing around tools.
 */
function transformAssistant(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  const msg = event.message as {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
  };

  const operations: MessageOperation[] = [];
  // Buffer for non-tool content (text, thinking, server_tool_use)
  const textBuffer: string[] = [];

  /**
   * Flush accumulated text content as a non-tool operation.
   */
  const flushTextBuffer = () => {
    if (textBuffer.length > 0) {
      operations.push(createAppendContentOp(ctx.sessionId, textBuffer.join('\n\n')));
      textBuffer.length = 0;
    }
  };

  for (const block of msg?.content || []) {
    if (block.type === 'text' && block.text) {
      // Filter out <thinking> tags that may appear in text content
      const text = block.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
      if (text) textBuffer.push(text);
    } else if (block.type === 'tool_use' && block.name) {
      // Handle special tools that create their own operations
      const specialOps = handleSpecialTool(block.name, block.id || '', block.input || {}, ctx);
      if (specialOps) {
        // Flush accumulated text content first
        flushTextBuffer();
        operations.push(...specialOps);
      } else {
        // Format regular tool use - flush text first, then add tool as separate operation
        const result = toolFormatterRegistry.format(block.name, block.input || {}, {
          formatter: ctx.formatter,
          detailed: ctx.detailed ?? true,
          worktreeInfo: ctx.worktreeInfo,
        });
        if (result.display && !result.hidden) {
          // Flush any accumulated text before the tool
          flushTextBuffer();
          if (toolsInline(ctx)) {
            // Create separate operation for tool with isToolOutput=true
            operations.push(createAppendContentOp(ctx.sessionId, result.display, true));
          } else {
            operations.push(createToolActivityOp(ctx.sessionId, {
              kind: 'start', toolUseId: block.id || '', name: block.name, display: result.display,
            }));
          }
          // Record the start time so the tool_result (arriving later in a
          // `user` event) can render a completion indicator with elapsed
          // time. Only displayed tools get one — hidden/special tools would
          // otherwise produce orphaned "↳ ✓" lines.
          if (block.id) {
            ctx.toolStartTimes.set(block.id, Date.now());
          }
        }
      }
    } else if (block.type === 'thinking' && block.thinking) {
      // Extended thinking - show abbreviated version
      const thinking = block.thinking as string;
      const preview = truncateAtWord(thinking, 200);
      const formatted = ctx.formatter.formatBlockquote(
        `💭 ${ctx.formatter.formatItalic(preview)}`
      );
      textBuffer.push(formatted);
    } else if (block.type === 'server_tool_use' && block.name) {
      // Server-managed tools (e.g., web search) - treat as tool output
      flushTextBuffer();
      const inputStr = block.input ? JSON.stringify(block.input).substring(0, 50) : '';
      const display = `🌐 ${ctx.formatter.formatBold(block.name)} ${inputStr}`;
      if (toolsInline(ctx)) {
        operations.push(createAppendContentOp(ctx.sessionId, display, true));
      } else {
        // Server tools have no tool_result; they start and end here.
        const toolUseId = block.id || '';
        operations.push(createToolActivityOp(ctx.sessionId, { kind: 'start', toolUseId, name: block.name, display }));
        operations.push(createToolActivityOp(ctx.sessionId, { kind: 'end', toolUseId, ok: true, elapsedMs: 0, display: '  ↳ ✓' }));
      }
    }
  }

  // Flush any remaining text content
  flushTextBuffer();

  // Coalesce task-list ops: each one renders the tracker's FULL state, so
  // when a single assistant event carries several TaskCreate/TaskUpdate
  // blocks (a parallel burst) only the last snapshot matters. Emitting all
  // of them would update the pinned task post N times back-to-back — enough
  // to trip platform rate limits.
  const taskListOps = operations.filter(op => op.type === 'task_list');
  if (taskListOps.length > 1) {
    const last = taskListOps[taskListOps.length - 1];
    return operations.filter(op => op.type !== 'task_list' || op === last);
  }

  return operations;
}

// ---------------------------------------------------------------------------
// User Event Transformation
// ---------------------------------------------------------------------------

/**
 * Transform a `user` event. The real CLI delivers tool results as
 * `tool_result` blocks inside `user` events (there are no top-level
 * tool_result events). Plain user text (echoed input) is ignored — the bot
 * already displays what the user typed in the chat thread itself.
 */
function transformUser(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  const msg = event.message as {
    content?: Array<{
      type: string;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }> | string;
  };

  if (!Array.isArray(msg?.content)) {
    return [];
  }

  const operations: MessageOperation[] = [];
  let indicatorCount = 0;

  for (const block of msg.content) {
    if (block?.type !== 'tool_result' || !block.tool_use_id) continue;

    // Late-resolve task ids: a TaskCreate's id is only revealed by its tool
    // result ("Task #3 created successfully: ..."). A failed create removes
    // the task again, and resolving may absorb a placeholder row — both
    // change the visible list, so refresh the display. Content extraction is
    // gated on a pending create: without one there is nothing to resolve, and
    // copying a multi-MB Read/Bash result into a string would be pure waste.
    if (ctx.taskTracker.hasPendingCreate(block.tool_use_id)) {
      const resolution = ctx.taskTracker.resolveCreatedId(
        block.tool_use_id,
        toolResultContentText(block.content),
        block.is_error === true
      );
      if (resolution === 'removed' || resolution === 'merged') {
        // Mirror handleTaskUpdate's action choice exactly: 'complete' only on
        // a genuinely completed set. An EMPTY remainder emits 'update' — a
        // 'complete' would delete the task post, which after a bot restart is
        // the RESTORED post for tasks this tracker never saw (the same resume
        // hazard the placeholder guard in allCompleted exists for). The
        // transient empty post is cleaned up by turn-end finalize().
        const action = ctx.taskTracker.allCompleted ? 'complete' : 'update';
        operations.push(
          createTaskListOp(ctx.sessionId, action, ctx.taskTracker.toTaskItems())
        );
      }
    }

    // Completion indicator — only for tools we actually displayed (their
    // start time was recorded when the tool_use block was rendered).
    // Hidden/special tools (TaskCreate, AskUserQuestion, ...) would
    // otherwise produce orphaned "↳ ✓" lines.
    if (ctx.toolStartTimes.has(block.tool_use_id)) {
      operations.push(
        toolsInline(ctx)
          ? createResultIndicatorOp(block.tool_use_id, block.is_error === true, ctx)
          : createToolEndOp(block.tool_use_id, block.is_error === true, ctx)
      );
      indicatorCount++;
    }
  }

  // Coalesce task-list ops, same as transformAssistant: N parallel creates'
  // results arrive in ONE user event, and each removed/merged resolution
  // would otherwise emit its own full-snapshot op (N platform calls).
  const taskListOps = operations.filter(op => op.type === 'task_list');
  if (taskListOps.length > 1) {
    const last = taskListOps[taskListOps.length - 1];
    const coalesced = operations.filter(op => op.type !== 'task_list' || op === last);
    operations.length = 0;
    operations.push(...coalesced);
  }

  if (indicatorCount > 0) {
    // Tool results are a natural break point - suggest flush
    operations.push(createFlushOp(ctx.sessionId, 'tool_complete'));
  }

  return operations;
}

/**
 * Extract the text of a tool_result block's content, which may be a plain
 * string or an array of content blocks.
 */
function toolResultContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
        ? (b as { text: string }).text
        : ''))
      .join('\n');
  }
  return '';
}

/**
 * Build the "↳ ✓ (5s)" / "↳ ❌ Error" completion indicator for a finished
 * tool, consuming its recorded start time.
 */
function createResultIndicatorOp(
  toolUseId: string,
  isError: boolean,
  ctx: TransformContext
): MessageOperation {
  let elapsed = '';
  const startTime = ctx.toolStartTimes.get(toolUseId);
  if (startTime) {
    const secs = Math.round((Date.now() - startTime) / 1000);
    if (secs >= 3) {
      elapsed = ` (${secs}s)`;
    }
    ctx.toolStartTimes.delete(toolUseId);
  }

  const icon = isError ? '❌' : '✓';
  const errorNote = isError ? ' Error' : '';
  return createAppendContentOp(ctx.sessionId, `  ↳ ${icon}${errorNote}${elapsed}`, true);
}

/**
 * The non-inline twin of createResultIndicatorOp: same ↳ line as `display`,
 * plus the outcome and elapsed time for the summary counter.
 */
function createToolEndOp(toolUseId: string, isError: boolean, ctx: TransformContext): MessageOperation {
  const startTime = ctx.toolStartTimes.get(toolUseId);
  const elapsedMs = startTime ? Date.now() - startTime : 0;
  const indicator = createResultIndicatorOp(toolUseId, isError, ctx) as { content: string };
  return createToolActivityOp(ctx.sessionId, { kind: 'end', toolUseId, ok: !isError, elapsedMs, display: indicator.content });
}

// ---------------------------------------------------------------------------
// Tool Use Event Transformation
// ---------------------------------------------------------------------------

/**
 * Transform a tool_use event.
 */
function transformToolUse(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  const tool = event.tool_use as {
    id?: string;
    name: string;
    input?: Record<string, unknown>;
  };

  // Track tool start time
  if (tool.id) {
    ctx.toolStartTimes.set(tool.id, Date.now());
  }

  // Check for special tools
  const specialOps = handleSpecialTool(tool.name, tool.id || '', tool.input || {}, ctx);
  if (specialOps) {
    return specialOps;
  }

  // Format regular tool use
  const result = toolFormatterRegistry.format(tool.name, tool.input || {}, {
    formatter: ctx.formatter,
    detailed: ctx.detailed ?? true,
    worktreeInfo: ctx.worktreeInfo,
  });

  if (result.display && !result.hidden) {
    return [
      toolsInline(ctx)
        ? createAppendContentOp(ctx.sessionId, result.display, true)
        : createToolActivityOp(ctx.sessionId, { kind: 'start', toolUseId: tool.id || '', name: tool.name, display: result.display }),
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Tool Result Event Transformation
// ---------------------------------------------------------------------------

/**
 * Transform a tool_result event.
 */
function transformToolResult(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  // Guard against undefined tool_result
  if (!event.tool_result) {
    return [];
  }

  const result = event.tool_result as {
    tool_use_id?: string;
    is_error?: boolean;
  };

  const toolUseId = result.tool_use_id || '';
  const isError = result.is_error === true;
  return [
    toolsInline(ctx) ? createResultIndicatorOp(toolUseId, isError, ctx) : createToolEndOp(toolUseId, isError, ctx),
    // Tool results are a natural break point - suggest flush
    createFlushOp(ctx.sessionId, 'tool_complete'),
  ];
}

// ---------------------------------------------------------------------------
// Result Event Transformation
// ---------------------------------------------------------------------------

/**
 * Transform a result event (Claude finished processing).
 */
function transformResult(
  event: ClaudeEvent,
  ctx: TransformContext
): MessageOperation[] {
  const operations: MessageOperation[] = [];

  // The turn is over: the tool summary line becomes final before the flush.
  if (!toolsInline(ctx)) {
    operations.push(createToolActivityOp(ctx.sessionId, { kind: 'turn_end' }));
  }

  // Result event triggers a final flush
  operations.push(createFlushOp(ctx.sessionId, 'result'));

  // Extract usage stats if available
  const result = event as ClaudeEvent & {
    result?: {
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      cost_usd?: number;
    };
  };

  // Always create StatusUpdateOp when Claude's turn ends
  // This triggers finalize() to clean up orphaned task lists
  const r = result.result;
  operations.push(
    createStatusUpdateOp(ctx.sessionId, {
      modelId: r?.model,
      totalCostUSD: r?.cost_usd,
      // Note: Full usage stats would require model-specific token tracking
    })
  );

  return operations;
}

// ---------------------------------------------------------------------------
// Special Tool Handling
// ---------------------------------------------------------------------------

/**
 * Handle special tools that create their own operations.
 * Returns null if the tool should use normal formatting.
 */
function handleSpecialTool(
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: TransformContext
): MessageOperation[] | null {
  switch (toolName) {
    case 'TodoWrite':
      return handleTodoWrite(input, ctx);

    case 'TaskCreate':
      return handleTaskCreate(toolUseId, input, ctx);

    case 'TaskUpdate':
      return handleTaskUpdate(input, ctx);

    case 'Task':
      return handleTaskStart(toolUseId, input, ctx);

    case 'AskUserQuestion':
      return handleAskUserQuestion(toolUseId, input, ctx);

    case 'ExitPlanMode':
      return handleExitPlanMode(toolUseId, ctx);

    default:
      return null;
  }
}

/**
 * Handle TodoWrite tool - update task list.
 */
function handleTodoWrite(
  input: Record<string, unknown>,
  ctx: TransformContext
): MessageOperation[] {
  const todos = (input.todos as Array<{
    content: string;
    status: string;
    activeForm: string;
  }>) || [];

  const tasks: TaskItem[] = todos.map(t => ({
    content: t.content,
    status: t.status as TaskItem['status'],
    activeForm: t.activeForm,
  }));

  // TodoWrite carries the FULL list, so it supersedes any state accumulated
  // from incremental TaskCreate/TaskUpdate calls. Without this, a session
  // mixing both dialects would flip-flop between two unrelated task sets.
  ctx.taskTracker.clear();

  // Determine if all tasks are completed
  const allCompleted = tasks.every(t => t.status === 'completed');
  const action = allCompleted ? 'complete' : 'update';

  return [createTaskListOp(ctx.sessionId, action, tasks)];
}

/**
 * Handle TaskCreate tool - add a task to the tracked list. Modern CLIs use
 * TaskCreate/TaskUpdate instead of TodoWrite; state accumulates in
 * ctx.taskTracker because each call is incremental.
 */
function handleTaskCreate(
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: TransformContext
): MessageOperation[] {
  ctx.taskTracker.create(toolUseId, input);
  return [createTaskListOp(ctx.sessionId, 'update', ctx.taskTracker.toTaskItems())];
}

/**
 * Handle TaskUpdate tool - update/delete a tracked task by id.
 */
function handleTaskUpdate(
  input: Record<string, unknown>,
  ctx: TransformContext
): MessageOperation[] {
  const changed = ctx.taskTracker.update(input);
  if (!changed) return [];
  const action = ctx.taskTracker.allCompleted ? 'complete' : 'update';
  return [createTaskListOp(ctx.sessionId, action, ctx.taskTracker.toTaskItems())];
}

/**
 * Handle Task tool - start a subagent.
 */
function handleTaskStart(
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: TransformContext
): MessageOperation[] {
  const description = (input.description as string) || (input.prompt as string) || 'Subagent';
  const subagentType = (input.subagent_type as string) || 'general-purpose';

  return [
    createSubagentOp(ctx.sessionId, toolUseId, 'start', description, subagentType),
  ];
}

/**
 * Handle AskUserQuestion tool - post questions.
 */
function handleAskUserQuestion(
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: TransformContext
): MessageOperation[] {
  const rawQuestions = (input.questions as Array<{
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>) || [];

  const questions: Question[] = rawQuestions.map(q => ({
    header: q.header,
    question: q.question,
    options: q.options.map((o): QuestionOption => ({
      label: o.label,
      description: o.description,
    })),
    multiSelect: q.multiSelect ?? false,
  }));

  return [createQuestionOp(ctx.sessionId, toolUseId, questions, 0)];
}

/**
 * Handle ExitPlanMode tool - request plan approval.
 */
function handleExitPlanMode(
  toolUseId: string,
  ctx: TransformContext
): MessageOperation[] {
  return [createApprovalOp(ctx.sessionId, toolUseId, 'plan')];
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Truncate text at word boundary.
 */
function truncateAtWord(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  let truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.7) {
    truncated = truncated.substring(0, lastSpace);
  }
  return truncated + '...';
}
