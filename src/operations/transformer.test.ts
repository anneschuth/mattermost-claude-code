/**
 * Tests for Event Transformer
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { transformEvent, type TransformContext } from './transformer.js';
import { TaskTracker } from './task-tracker.js';
import type { ClaudeEvent } from '../claude/cli.js';
import type { PlatformFormatter } from '../platform/formatter.js';

// Mock formatter
const mockFormatter: PlatformFormatter = {
  formatBold: (text: string) => `**${text}**`,
  formatItalic: (text: string) => `_${text}_`,
  formatCode: (text: string) => `\`${text}\``,
  formatCodeBlock: (text: string, lang?: string) =>
    lang ? `\`\`\`${lang}\n${text}\n\`\`\`` : `\`\`\`\n${text}\n\`\`\``,
  formatLink: (text: string, url: string) => `[${text}](${url})`,
  formatStrikethrough: (text: string) => `~~${text}~~`,
  formatMarkdown: (text: string) => text,
  formatUserMention: (userId: string) => `@${userId}`,
  formatHorizontalRule: () => '---',
  formatBlockquote: (text: string) => `> ${text}`,
  formatListItem: (text: string) => `- ${text}`,
  formatNumberedListItem: (n: number, text: string) => `${n}. ${text}`,
  formatHeading: (text: string, level: number) => `${'#'.repeat(level)} ${text}`,
  escapeText: (text: string) => text,
  formatTable: (_headers: string[], _rows: string[][]) => '',
  formatKeyValueList: (_items: [string, string, string][]) => '',
};

describe('Event Transformer', () => {
  let ctx: TransformContext;

  beforeEach(() => {
    ctx = {
      sessionId: 'test-session',
      formatter: mockFormatter,
      toolStartTimes: new Map(),
      taskTracker: new TaskTracker(),
      detailed: true,
    };
  });

  // ---------------------------------------------------------------------------
  // Assistant Events
  // ---------------------------------------------------------------------------

  describe('assistant events', () => {
    it('transforms text content', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello, world!' }],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toBe('Hello, world!');
    });

    it('filters out thinking tags', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello <thinking>internal thought</thinking> world!' }],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect((ops[0] as { content: string }).content).toBe('Hello  world!');
    });

    it('transforms tool_use in assistant message', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', id: 'tool1', input: { file_path: '/test/file.ts' } },
          ],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('Read');
    });

    it('handles thinking blocks', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Let me think about this problem...' }],
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect((ops[0] as { content: string }).content).toContain('💭');
      expect((ops[0] as { content: string }).content).toContain('think');
    });

    it('returns empty for empty content', () => {
      const event: ClaudeEvent = {
        type: 'assistant',
        message: { content: [] },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool Use Events
  // ---------------------------------------------------------------------------

  describe('tool_use events', () => {
    it('transforms Read tool', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool1', name: 'Read', input: { file_path: '/path/file.ts' } },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('Read');
    });

    it('transforms Bash tool', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool1', name: 'Bash', input: { command: 'ls -la' } },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect((ops[0] as { content: string }).content).toContain('Bash');
      expect((ops[0] as { content: string }).content).toContain('ls');
    });

    it('tracks tool start time', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool123', name: 'Read', input: {} },
      };

      transformEvent(event, ctx);

      expect(ctx.toolStartTimes.has('tool123')).toBe(true);
    });

    it('handles TodoWrite specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'pending', activeForm: 'Doing task 1' },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('task_list');
    });

    it('handles Task specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'Task',
          input: { description: 'Search codebase', subagent_type: 'Explore' },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('subagent');
      expect((ops[0] as { action: string }).action).toBe('start');
    });

    it('handles AskUserQuestion specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Choice',
                question: 'Which option?',
                options: [
                  { label: 'Option A', description: 'First option' },
                  { label: 'Option B', description: 'Second option' },
                ],
              },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('question');
      expect((ops[0] as { questions: unknown[] }).questions.length).toBe(1);
    });

    it('handles ExitPlanMode specially', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: { id: 'tool1', name: 'ExitPlanMode', input: {} },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('approval');
      expect((ops[0] as { approvalType: string }).approvalType).toBe('plan');
    });
  });

  // ---------------------------------------------------------------------------
  // Tool Result Events
  // ---------------------------------------------------------------------------

  describe('tool_result events', () => {
    it('transforms success result', () => {
      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(2);
      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('✓');
      expect(ops[1].type).toBe('flush');
    });

    it('transforms error result', () => {
      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: true },
      };

      const ops = transformEvent(event, ctx);

      expect(ops[0].type).toBe('append_content');
      expect((ops[0] as { content: string }).content).toContain('❌');
      expect((ops[0] as { content: string }).content).toContain('Error');
    });

    it('includes elapsed time for long-running tools', () => {
      // Simulate tool started 5 seconds ago
      ctx.toolStartTimes.set('tool1', Date.now() - 5000);

      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { content: string }).content).toContain('5s');
    });

    it('does not include elapsed time for quick tools', () => {
      // Simulate tool started 1 second ago
      ctx.toolStartTimes.set('tool1', Date.now() - 1000);

      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { content: string }).content).not.toContain('s)');
    });

    it('cleans up tool start time', () => {
      ctx.toolStartTimes.set('tool1', Date.now());

      const event: ClaudeEvent = {
        type: 'tool_result',
        tool_result: { tool_use_id: 'tool1', is_error: false },
      };

      transformEvent(event, ctx);

      expect(ctx.toolStartTimes.has('tool1')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Result Events
  // ---------------------------------------------------------------------------

  describe('result events', () => {
    it('creates flush operation', () => {
      const event: ClaudeEvent = {
        type: 'result',
        result: {},
      };

      const ops = transformEvent(event, ctx);

      expect(ops.some(op => op.type === 'flush')).toBe(true);
    });

    it('creates status update with usage stats', () => {
      const event: ClaudeEvent = {
        type: 'result',
        result: {
          model: 'claude-opus-4-5',
          cost_usd: 0.05,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
          },
        },
      };

      const ops = transformEvent(event, ctx);

      const statusOp = ops.find(op => op.type === 'status_update');
      expect(statusOp).toBeDefined();
      expect((statusOp as { modelId: string }).modelId).toBe('claude-opus-4-5');
      expect((statusOp as { totalCostUSD: number }).totalCostUSD).toBe(0.05);
    });

    /**
     * Regression test: StatusUpdateOp must ALWAYS be created when Claude's turn ends.
     * This is critical because StatusUpdateOp triggers finalize() to clean up orphaned task lists.
     *
     * Bug: Previously, StatusUpdateOp was only created if result.result existed.
     * If Claude's result event didn't have that property, finalize() was never called,
     * leaving orphaned task lists visible to users.
     */
    it('ALWAYS creates status update even when result.result is missing', () => {
      // This simulates a result event without the result property
      const event: ClaudeEvent = {
        type: 'result',
        // No 'result' property - this used to cause StatusUpdateOp to not be created
      };

      const ops = transformEvent(event, ctx);

      // CRITICAL: StatusUpdateOp must be created to trigger finalize()
      const statusOp = ops.find(op => op.type === 'status_update');
      expect(statusOp).toBeDefined();
    });

    it('ALWAYS creates status update even when result.result is empty', () => {
      const event: ClaudeEvent = {
        type: 'result',
        result: {}, // Empty result object
      };

      const ops = transformEvent(event, ctx);

      const statusOp = ops.find(op => op.type === 'status_update');
      expect(statusOp).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Special Tools
  // ---------------------------------------------------------------------------

  describe('TodoWrite handling', () => {
    it('creates task list operation with tasks', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
              { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
              { content: 'Task 3', status: 'pending', activeForm: 'Planning task 3' },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('task_list');
      const taskOp = ops[0] as { action: string; tasks: unknown[] };
      expect(taskOp.action).toBe('update');
      expect(taskOp.tasks.length).toBe(3);
    });

    it('sets action to complete when all tasks done', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'completed', activeForm: 'Done' },
              { content: 'Task 2', status: 'completed', activeForm: 'Done' },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { action: string }).action).toBe('complete');
    });
  });

  describe('Task (subagent) handling', () => {
    it('creates subagent start operation', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'subagent-123',
          name: 'Task',
          input: {
            description: 'Search for authentication code',
            subagent_type: 'Explore',
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('subagent');
      const subOp = ops[0] as {
        toolUseId: string;
        action: string;
        description: string;
        subagentType: string;
      };
      expect(subOp.toolUseId).toBe('subagent-123');
      expect(subOp.action).toBe('start');
      expect(subOp.description).toBe('Search for authentication code');
      expect(subOp.subagentType).toBe('Explore');
    });

    it('uses prompt field if description missing', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'tool1',
          name: 'Task',
          input: { prompt: 'Do something' },
        },
      };

      const ops = transformEvent(event, ctx);

      expect((ops[0] as { description: string }).description).toBe('Do something');
    });
  });

  describe('AskUserQuestion handling', () => {
    it('creates question operation with all fields', () => {
      const event: ClaudeEvent = {
        type: 'tool_use',
        tool_use: {
          id: 'q-123',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Framework',
                question: 'Which framework should we use?',
                options: [
                  { label: 'React', description: 'Popular UI library' },
                  { label: 'Vue', description: 'Progressive framework' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('question');
      const qOp = ops[0] as {
        toolUseId: string;
        questions: Array<{
          header: string;
          question: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>;
        currentIndex: number;
      };
      expect(qOp.toolUseId).toBe('q-123');
      expect(qOp.questions.length).toBe(1);
      expect(qOp.questions[0].header).toBe('Framework');
      expect(qOp.questions[0].options.length).toBe(2);
      expect(qOp.currentIndex).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown Events
  // ---------------------------------------------------------------------------

  describe('unknown events', () => {
    it('returns empty array for unknown event types', () => {
      const event: ClaudeEvent = {
        type: 'unknown_event_type',
      };

      const ops = transformEvent(event, ctx);

      expect(ops.length).toBe(0);
    });
  });
});

// =============================================================================
// Modern CLI event shapes (verified against Claude CLI 2.1.223)
//
// The real CLI wraps tool uses in `assistant` events and tool results in
// `user` events; it tracks tasks with incremental TaskCreate/TaskUpdate calls
// instead of TodoWrite. These tests replay captured real shapes.
// =============================================================================

describe('Event Transformer - modern CLI shapes', () => {
  let ctx: TransformContext;

  beforeEach(() => {
    ctx = {
      sessionId: 'test-session',
      formatter: mockFormatter,
      toolStartTimes: new Map(),
      taskTracker: new TaskTracker(),
      detailed: true,
    };
  });

  const assistantToolUse = (
    name: string,
    id: string,
    input: Record<string, unknown>
  ): ClaudeEvent => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id, input }] },
  });

  const userToolResult = (
    toolUseId: string,
    content: string,
    isError = false
  ): ClaudeEvent => ({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) },
      ],
    },
  });

  describe('TaskCreate/TaskUpdate task tracking', () => {
    it('TaskCreate produces a task list update with the new task', () => {
      const ops = transformEvent(
        assistantToolUse('TaskCreate', 'tu-1', { subject: 'task one', description: 'First task' }),
        ctx
      );

      expect(ops.length).toBe(1);
      expect(ops[0].type).toBe('task_list');
      const op = ops[0] as { action: string; tasks: Array<{ content: string; status: string; activeForm: string }> };
      expect(op.action).toBe('update');
      expect(op.tasks).toEqual([
        { content: 'task one', status: 'pending', activeForm: 'task one' },
      ]);
    });

    it('accumulates tasks across TaskCreate calls and applies TaskUpdate by resolved id', () => {
      transformEvent(assistantToolUse('TaskCreate', 'tu-1', { subject: 'task one', description: 'd' }), ctx);
      transformEvent(assistantToolUse('TaskCreate', 'tu-2', { subject: 'task two', description: 'd' }), ctx);
      // Real tool results reveal the task ids
      transformEvent(userToolResult('tu-1', 'Task #1 created successfully: task one'), ctx);
      transformEvent(userToolResult('tu-2', 'Task #2 created successfully: task two'), ctx);

      const ops = transformEvent(
        assistantToolUse('TaskUpdate', 'tu-3', { taskId: '1', status: 'in_progress' }),
        ctx
      );

      expect(ops.length).toBe(1);
      const op = ops[0] as { action: string; tasks: Array<{ content: string; status: string; activeForm: string }> };
      expect(op.action).toBe('update');
      expect(op.tasks).toEqual([
        { content: 'task one', status: 'in_progress', activeForm: 'task one' },
        { content: 'task two', status: 'pending', activeForm: 'task two' },
      ]);
    });

    it('emits complete action when the last task completes', () => {
      transformEvent(assistantToolUse('TaskCreate', 'tu-1', { subject: 'only task', description: 'd' }), ctx);
      transformEvent(userToolResult('tu-1', 'Task #1 created successfully: only task'), ctx);

      const ops = transformEvent(
        assistantToolUse('TaskUpdate', 'tu-2', { taskId: '1', status: 'completed' }),
        ctx
      );

      const op = ops[0] as { action: string };
      expect(op.action).toBe('complete');
    });

    it('removes a task on status deleted', () => {
      transformEvent(assistantToolUse('TaskCreate', 'tu-1', { subject: 'doomed', description: 'd' }), ctx);
      transformEvent(userToolResult('tu-1', 'Task #1 created successfully: doomed'), ctx);

      const ops = transformEvent(
        assistantToolUse('TaskUpdate', 'tu-2', { taskId: '1', status: 'deleted' }),
        ctx
      );

      const op = ops[0] as { tasks: unknown[] };
      expect(op.tasks).toEqual([]);
    });

    it('shows a placeholder for TaskUpdate on an unknown task id', () => {
      const ops = transformEvent(
        assistantToolUse('TaskUpdate', 'tu-1', { taskId: '7', status: 'in_progress' }),
        ctx
      );

      const op = ops[0] as { tasks: Array<{ content: string; status: string; activeForm: string }> };
      expect(op.tasks).toEqual([
        { content: 'Task #7', status: 'in_progress', activeForm: 'Task #7' },
      ]);
    });

    it('uses activeForm from TaskCreate input when provided', () => {
      const ops = transformEvent(
        assistantToolUse('TaskCreate', 'tu-1', {
          subject: 'Run tests',
          description: 'd',
          activeForm: 'Running tests',
        }),
        ctx
      );

      const op = ops[0] as { tasks: Array<{ activeForm: string }> };
      expect(op.tasks[0].activeForm).toBe('Running tests');
    });
  });

  describe('user events with tool_result blocks', () => {
    it('emits a completion indicator and flush for a displayed tool', () => {
      // Bash is displayed, so its start time is recorded
      transformEvent(assistantToolUse('Bash', 'tu-1', { command: 'ls' }), ctx);
      expect(ctx.toolStartTimes.has('tu-1')).toBe(true);

      const ops = transformEvent(userToolResult('tu-1', 'file.txt'), ctx);

      expect(ops.length).toBe(2);
      expect((ops[0] as { content: string }).content).toContain('↳ ✓');
      expect(ops[1].type).toBe('flush');
      expect(ctx.toolStartTimes.has('tu-1')).toBe(false);
    });

    it('marks errored tool results', () => {
      transformEvent(assistantToolUse('Bash', 'tu-1', { command: 'false' }), ctx);

      const ops = transformEvent(userToolResult('tu-1', 'boom', true), ctx);

      expect((ops[0] as { content: string }).content).toContain('❌ Error');
    });

    it('does not emit indicators for hidden tools', () => {
      // TaskCreate is hidden - no start time is recorded, so its result
      // must not produce an orphaned indicator (but still resolves the id)
      transformEvent(assistantToolUse('TaskCreate', 'tu-1', { subject: 't', description: 'd' }), ctx);
      expect(ctx.toolStartTimes.has('tu-1')).toBe(false);

      const ops = transformEvent(userToolResult('tu-1', 'Task #1 created successfully: t'), ctx);

      expect(ops).toEqual([]);
    });

    it('ignores plain-string user message content', () => {
      const event: ClaudeEvent = {
        type: 'user',
        message: { content: 'just some text the user typed' },
      };

      expect(transformEvent(event, ctx)).toEqual([]);
    });

    it('handles tool_result content given as content-block arrays', () => {
      transformEvent(assistantToolUse('TaskCreate', 'tu-1', { subject: 't', description: 'd' }), ctx);
      const event: ClaudeEvent = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: [{ type: 'text', text: 'Task #4 created successfully: t' }],
            },
          ],
        },
      };
      transformEvent(event, ctx);

      const ops = transformEvent(
        assistantToolUse('TaskUpdate', 'tu-2', { taskId: '4', status: 'completed' }),
        ctx
      );
      const op = ops[0] as { action: string };
      expect(op.action).toBe('complete');
    });
  });
});

describe('Event Transformer - review fixes', () => {
  let ctx: TransformContext;

  beforeEach(() => {
    ctx = {
      sessionId: 'test-session',
      formatter: mockFormatter,
      toolStartTimes: new Map(),
      taskTracker: new TaskTracker(),
      detailed: true,
    };
  });

  it('skips sidechain events carrying parent_tool_use_id', () => {
    const assistantEvent: ClaudeEvent = {
      type: 'assistant',
      parent_tool_use_id: 'parent-1',
      message: {
        content: [
          { type: 'tool_use', name: 'TaskCreate', id: 'sub-1', input: { subject: 'subagent task', description: 'd' } },
        ],
      },
    };
    const userEvent: ClaudeEvent = {
      type: 'user',
      parent_tool_use_id: 'parent-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'sub-1', content: 'Task #1 created successfully: subagent task' }],
      },
    };

    expect(transformEvent(assistantEvent, ctx)).toEqual([]);
    expect(transformEvent(userEvent, ctx)).toEqual([]);
    // The subagent's task never entered the main thread's tracker
    expect(ctx.taskTracker.isEmpty).toBe(true);
  });

  it('drops the ghost row and refreshes the display when a TaskCreate fails', () => {
    transformEvent(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'TaskCreate', id: 'tu-1', input: { subject: 'doomed', description: 'd' } }] },
      },
      ctx
    );

    const ops = transformEvent(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'Error: task store unavailable', is_error: true }],
        },
      },
      ctx
    );

    // A task-list refresh with the ghost removed (no orphaned indicator:
    // TaskCreate is hidden so no flush/indicator ops either). The action is
    // 'update', NOT 'complete': after a bot restart an empty tracker coexists
    // with a restored task post holding real tasks — 'complete' would delete
    // it. The transient empty post is cleaned by turn-end finalize().
    expect(ops.length).toBe(1);
    expect(ops[0].type).toBe('task_list');
    expect((ops[0] as { action: string }).action).toBe('update');
    expect((ops[0] as { tasks: unknown[] }).tasks).toEqual([]);
    expect(ctx.taskTracker.allCompleted).toBe(false);
    expect(ctx.taskTracker.isEmpty).toBe(true);
  });

  it('TodoWrite supersedes accumulated TaskCreate state', () => {
    transformEvent(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'TaskCreate', id: 'tu-1', input: { subject: 'incremental', description: 'd' } }] },
      },
      ctx
    );
    expect(ctx.taskTracker.isEmpty).toBe(false);

    const ops = transformEvent(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TodoWrite',
              id: 'tu-2',
              input: { todos: [{ content: 'full list', status: 'pending', activeForm: 'doing' }] },
            },
          ],
        },
      },
      ctx
    );

    expect(ops[0].type).toBe('task_list');
    // Tracker cleared: a later TaskUpdate can't resurrect the old incremental set
    expect(ctx.taskTracker.isEmpty).toBe(true);
  });
});

describe('Event Transformer - round-2 review fixes', () => {
  let ctx: TransformContext;

  beforeEach(() => {
    ctx = {
      sessionId: 'test-session',
      formatter: mockFormatter,
      toolStartTimes: new Map(),
      taskTracker: new TaskTracker(),
      detailed: true,
    };
  });

  const toolUseBlock = (name: string, id: string, input: Record<string, unknown>) => ({
    type: 'tool_use',
    name,
    id,
    input,
  });

  it('processes every tool_result block in one user event (real CLIs batch parallel results)', () => {
    // Two displayed tools + one pending TaskCreate, all resolving in ONE user
    // event, mixed with a text block.
    transformEvent(
      {
        type: 'assistant',
        message: {
          content: [
            toolUseBlock('Bash', 'tu-bash', { command: 'ls' }),
            toolUseBlock('Read', 'tu-read', { file_path: '/x' }),
            toolUseBlock('TaskCreate', 'tu-task', { subject: 'doomed', description: 'd' }),
          ],
        },
      },
      ctx
    );

    const ops = transformEvent(
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-bash', content: 'ok' },
            { type: 'text', text: 'interleaved text block' },
            { type: 'tool_result', tool_use_id: 'tu-task', content: 'nope', is_error: true },
            { type: 'tool_result', tool_use_id: 'tu-read', content: 'file contents', is_error: true },
          ],
        },
      },
      ctx
    );

    const types = ops.map(o => o.type);
    // Both indicators present (one success, one error), the failed-create
    // task refresh present, and EXACTLY one trailing flush.
    expect(types.filter(t => t === 'flush')).toHaveLength(1);
    expect(types[types.length - 1]).toBe('flush');
    expect(types.filter(t => t === 'task_list')).toHaveLength(1);
    const indicators = ops.filter(
      o => o.type === 'append_content'
    ) as Array<{ content: string }>;
    expect(indicators).toHaveLength(2);
    expect(indicators[0].content).toContain('↳ ✓');
    expect(indicators[1].content).toContain('↳ ❌ Error');
    // All start times consumed
    expect(ctx.toolStartTimes.size).toBe(0);
  });

  it('coalesces a burst of TaskCreate blocks in one assistant event into a single task_list op', () => {
    const ops = transformEvent(
      {
        type: 'assistant',
        message: {
          content: [
            toolUseBlock('TaskCreate', 'tu-1', { subject: 'one', description: 'd' }),
            toolUseBlock('TaskCreate', 'tu-2', { subject: 'two', description: 'd' }),
            toolUseBlock('TaskCreate', 'tu-3', { subject: 'three', description: 'd' }),
          ],
        },
      },
      ctx
    );

    const taskOps = ops.filter(o => o.type === 'task_list') as Array<{ tasks: unknown[] }>;
    expect(taskOps).toHaveLength(1);
    // The surviving op carries the final snapshot (all three tasks)
    expect(taskOps[0].tasks).toHaveLength(3);
  });

  it('refreshes the display when resolving a create absorbs a placeholder row', () => {
    transformEvent(
      {
        type: 'assistant',
        message: { content: [toolUseBlock('TaskCreate', 'tu-1', { subject: 'real', description: 'd' })] },
      },
      ctx
    );
    // Early update creates a placeholder row for id 3 (2 rows displayed)
    transformEvent(
      {
        type: 'assistant',
        message: { content: [toolUseBlock('TaskUpdate', 'tu-2', { taskId: '3', status: 'in_progress' })] },
      },
      ctx
    );

    const ops = transformEvent(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'Task #3 created successfully: real' }],
        },
      },
      ctx
    );

    // The merge collapsed two rows into one — the stale 2-row display must
    // be refreshed immediately, not at the next task op.
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('task_list');
    expect((ops[0] as { tasks: Array<{ content: string; status: string; activeForm: string }> }).tasks).toEqual([
      { content: 'real', status: 'in_progress', activeForm: 'real' },
    ]);
  });
});

describe('Event Transformer - round-3 review fixes', () => {
  let ctx: TransformContext;

  beforeEach(() => {
    ctx = {
      sessionId: 'test-session',
      formatter: mockFormatter,
      toolStartTimes: new Map(),
      taskTracker: new TaskTracker(),
      detailed: true,
    };
  });

  it('coalesces multiple failed-create refreshes in one user event into a single op', () => {
    // Three parallel TaskCreates...
    transformEvent(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'TaskCreate', id: 'tu-1', input: { subject: 'a', description: 'd' } },
            { type: 'tool_use', name: 'TaskCreate', id: 'tu-2', input: { subject: 'b', description: 'd' } },
            { type: 'tool_use', name: 'TaskCreate', id: 'tu-3', input: { subject: 'c', description: 'd' } },
          ],
        },
      },
      ctx
    );
    // ...all failing in ONE user event must not emit three task-post updates
    const ops = transformEvent(
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'boom', is_error: true },
            { type: 'tool_result', tool_use_id: 'tu-2', content: 'boom', is_error: true },
            { type: 'tool_result', tool_use_id: 'tu-3', content: 'boom', is_error: true },
          ],
        },
      },
      ctx
    );

    const taskOps = ops.filter(o => o.type === 'task_list') as Array<{ tasks: unknown[] }>;
    expect(taskOps).toHaveLength(1);
    expect(taskOps[0].tasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tool activity modes (docs/quiet-tools-spec.md)
// ---------------------------------------------------------------------------

describe('tool activity: summary and hidden modes', () => {
  const read = { type: 'tool_use', name: 'Read', id: 'tool1', input: { file_path: '/test/file.ts' } };
  const readDone = { type: 'tool_result', tool_use_id: 'tool1', content: 'ok' };
  const readFailed = { type: 'tool_result', tool_use_id: 'tool1', content: 'boom', is_error: true };

  function make(toolActivity: 'summary' | 'hidden'): TransformContext {
    return {
      sessionId: 'test-session',
      formatter: mockFormatter,
      toolStartTimes: new Map(),
      taskTracker: new TaskTracker(),
      detailed: true,
      toolActivity,
    };
  }

  for (const mode of ['summary', 'hidden'] as const) {
    it(`${mode}: a tool_use becomes a tool_activity start op, not inline content`, () => {
      const ctx = make(mode);

      const ops = transformEvent({ type: 'assistant', message: { content: [read] } }, ctx);

      expect(ops.map((op) => op.type)).toEqual(['tool_activity']);
      expect(ops[0]).toMatchObject({ kind: 'start', toolUseId: 'tool1', name: 'Read' });
      expect((ops[0] as { display: string }).display).toContain('Read');
      expect(ctx.toolStartTimes.has('tool1')).toBe(true);
    });

    it(`${mode}: the tool_result becomes an end op with the outcome, and never an inline ↳ line`, () => {
      const ctx = make(mode);
      transformEvent({ type: 'assistant', message: { content: [read] } }, ctx);

      const ops = transformEvent({ type: 'user', message: { content: [readFailed] } }, ctx);

      const end = ops.find((op) => op.type === 'tool_activity');
      expect(end).toMatchObject({ kind: 'end', toolUseId: 'tool1', ok: false });
      expect((end as { display: string }).display).toContain('❌');
      expect(ops.some((op) => op.type === 'append_content')).toBe(false);
      expect(ctx.toolStartTimes.has('tool1')).toBe(false);
    });
  }

  it('summary: a successful result carries ok=true and elapsed time', () => {
    const ctx = make('summary');
    transformEvent({ type: 'assistant', message: { content: [read] } }, ctx);
    ctx.toolStartTimes.set('tool1', Date.now() - 5000);

    const ops = transformEvent({ type: 'user', message: { content: [readDone] } }, ctx);

    const end = ops.find((op) => op.type === 'tool_activity') as { ok: boolean; elapsedMs: number };
    expect(end.ok).toBe(true);
    expect(end.elapsedMs).toBeGreaterThanOrEqual(4900);
  });

  it('summary: text around a tool still streams as content, in order', () => {
    const ctx = make('summary');

    const ops = transformEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Looking.' }, read, { type: 'text', text: 'Found it.' }] },
    }, ctx);

    expect(ops.map((op) => op.type)).toEqual(['append_content', 'tool_activity', 'append_content']);
  });

  it('summary: a server tool (web search) counts as a start and an immediate end', () => {
    const ctx = make('summary');

    const ops = transformEvent({
      type: 'assistant',
      message: { content: [{ type: 'server_tool_use', name: 'web_search', id: 'srv1', input: { query: 'x' } }] },
    }, ctx);

    expect(ops.map((op) => (op as { kind?: string }).kind)).toEqual(['start', 'end']);
    expect(ops[0]).toMatchObject({ toolUseId: 'srv1', name: 'web_search' });
  });

  it('summary: the result event emits a turn_end op before the final flush', () => {
    const ctx = make('summary');

    const ops = transformEvent({ type: 'result', result: {} } as ClaudeEvent, ctx);

    expect(ops.slice(0, 2).map((op) => op.type)).toEqual(['tool_activity', 'flush']);
    expect(ops[0]).toMatchObject({ kind: 'turn_end' });
  });

  it('full (default): nothing changes — tool_use is inline content and no tool_activity ops appear', () => {
    const ctx: TransformContext = { sessionId: 's', formatter: mockFormatter, toolStartTimes: new Map(), taskTracker: new TaskTracker(), detailed: true };

    const ops = [
      ...transformEvent({ type: 'assistant', message: { content: [read] } }, ctx),
      ...transformEvent({ type: 'user', message: { content: [readDone] } }, ctx),
      ...transformEvent({ type: 'result', result: {} } as ClaudeEvent, ctx),
    ];

    expect(ops.some((op) => op.type === 'tool_activity')).toBe(false);
    expect(ops.filter((op) => op.type === 'append_content').every((op) => (op as { isToolOutput?: boolean }).isToolOutput)).toBe(true);
  });

  it('legacy top-level tool_use / tool_result events follow the mode too (Codex review)', () => {
    const ctx = make('hidden');

    const startOps = transformEvent({ type: 'tool_use', tool_use: { id: 'legacy1', name: 'Bash', input: { command: 'ls' } } } as ClaudeEvent, ctx);
    const endOps = transformEvent({ type: 'tool_result', tool_result: { tool_use_id: 'legacy1', is_error: false } } as ClaudeEvent, ctx);

    expect(startOps.map((op) => op.type)).toEqual(['tool_activity']);
    expect(startOps[0]).toMatchObject({ kind: 'start', toolUseId: 'legacy1', name: 'Bash' });
    expect(endOps.map((op) => op.type)).toEqual(['tool_activity', 'flush']);
    expect(endOps[0]).toMatchObject({ kind: 'end', toolUseId: 'legacy1', ok: true });
  });

  it('special tools (task list, questions) keep their own ops in summary mode', () => {
    const ctx = make('summary');

    const ops = transformEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'TodoWrite', id: 't1', input: { todos: [{ content: 'a', status: 'pending', activeForm: 'a' }] } }] },
    }, ctx);

    expect(ops.some((op) => op.type === 'tool_activity')).toBe(false);
    expect(ops.some((op) => op.type === 'task_list')).toBe(true);
  });
});
