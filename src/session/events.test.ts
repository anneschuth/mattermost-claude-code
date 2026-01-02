/**
 * Tests for events.ts - Claude event handling
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { handleEvent, EventContext } from './events.js';
import type { Session } from './types.js';
import type { PlatformClient, PlatformPost, PlatformFormatter } from '../platform/index.js';

// Mock platform client
function createMockPlatform() {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  const mockFormatter: PlatformFormatter = {
    formatBold: (text: string) => `**${text}**`,
    formatItalic: (text: string) => `_${text}_`,
    formatCode: (text: string) => `\`${text}\``,
    formatCodeBlock: (code: string, lang?: string) => `\`\`\`${lang || ''}\n${code}\n\`\`\``,
    formatUserMention: (username: string) => `@${username}`,
    formatLink: (text: string, url: string) => `[${text}](${url})`,
    formatListItem: (text: string) => `- ${text}`,
    formatNumberedListItem: (num: number, text: string) => `${num}. ${text}`,
    formatBlockquote: (text: string) => `> ${text}`,
    formatHorizontalRule: () => '---',
    formatHeading: (text: string, level: number) => `${'#'.repeat(level)} ${text}`,
    escapeText: (text: string) => text,
  };

  const mockPlatform = {
    createPost: mock(async (message: string, _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: _threadId || '',
        createAt: Date.now(),
      };
    }),
    updatePost: mock(async (postId: string, message: string): Promise<PlatformPost> => {
      posts.set(postId, message);
      return {
        id: postId,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: '',
        createAt: Date.now(),
      };
    }),
    deletePost: mock(async (postId: string): Promise<void> => {
      posts.delete(postId);
    }),
    createInteractivePost: mock(async (message: string, _reactions: string[], _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: _threadId || '',
        createAt: Date.now(),
      };
    }),
    sendTyping: mock(() => {}),
    getFormatter: () => mockFormatter,
    posts,
  };

  return mockPlatform as unknown as PlatformClient & { posts: Map<string, string> };
}

// Create a minimal session for testing
function createTestSession(platform: PlatformClient): Session {
  return {
    platformId: 'test',
    threadId: 'thread1',
    sessionId: 'test:thread1',
    claudeSessionId: 'uuid-123',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    platform,
    workingDir: '/test',
    claude: null as any,
    currentPostId: null,
    pendingContent: '',
    pendingApproval: null,
    pendingQuestionSet: null,
    pendingMessageApproval: null,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: 'start_post',
    tasksPostId: null,
    lastTasksContent: null,
    tasksCompleted: false,
    tasksMinimized: false,
    activeSubagents: new Map(),
    updateTimer: null,
    typingTimer: null,
    timeoutWarningPosted: false,
    isRestarting: false,
    isResumed: false,
    wasInterrupted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    messageCount: 0,
    statusBarTimer: null,
  };
}

function createEventContext(): EventContext {
  return {
    debug: false,
    registerPost: mock((_postId: string, _threadId: string) => {}),
    flush: mock(async (_session: Session) => {}),
    startTyping: mock((_session: Session) => {}),
    stopTyping: mock((_session: Session) => {}),
    appendContent: mock((_session: Session, _text: string) => {}),
    bumpTasksToBottom: mock(async (_session: Session) => {}),
    updateStickyMessage: mock(async () => {}),
    persistSession: mock((_session: Session) => {}),
    updateSessionHeader: mock(async (_session: Session) => {}),
  };
}

describe('handleEvent with TodoWrite', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: EventContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createEventContext();
  });

  test('sets tasksCompleted=false when tasks have pending items', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [
                { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
                { content: 'Task 2', status: 'pending', activeForm: 'Doing task 2' },
              ],
            },
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    expect(session.tasksCompleted).toBe(false);
  });

  test('sets tasksCompleted=false when tasks have in_progress items', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [
                { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
                { content: 'Task 2', status: 'in_progress', activeForm: 'Doing task 2' },
              ],
            },
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    expect(session.tasksCompleted).toBe(false);
  });

  test('sets tasksCompleted=true when all tasks are completed', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [
                { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
                { content: 'Task 2', status: 'completed', activeForm: 'Completing task 2' },
                { content: 'Task 3', status: 'completed', activeForm: 'Completing task 3' },
              ],
            },
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    expect(session.tasksCompleted).toBe(true);
  });

  test('sets tasksCompleted=true when todos array is empty', () => {
    session.tasksPostId = 'existing_tasks_post';

    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [],
            },
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    expect(session.tasksCompleted).toBe(true);
  });

  test('task list is not bumped when all tasks completed', async () => {
    // First, simulate having an active task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 **Tasks** (2/3)\n✅ Task 1\n✅ Task 2\n🔄 Task 3';
    session.tasksCompleted = false;

    // Now complete all tasks
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id: 'tool_1',
            input: {
              todos: [
                { content: 'Task 1', status: 'completed', activeForm: 'Task 1' },
                { content: 'Task 2', status: 'completed', activeForm: 'Task 2' },
                { content: 'Task 3', status: 'completed', activeForm: 'Task 3' },
              ],
            },
          },
        ],
      },
    };

    handleEvent(session, event, ctx);

    // tasksCompleted should be true
    expect(session.tasksCompleted).toBe(true);

    // The task list content should show all completed
    expect(session.lastTasksContent).toContain('3/3');
    expect(session.lastTasksContent).toContain('100%');
  });
});

describe('handleEvent with result event (usage stats)', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let ctx: EventContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createEventContext();
  });

  test('extracts usage stats from result event with modelUsage', () => {
    const event = {
      type: 'result' as const,
      subtype: 'success',
      total_cost_usd: 0.072784,
      modelUsage: {
        'claude-opus-4-5-20251101': {
          inputTokens: 2471,
          outputTokens: 193,
          cacheReadInputTokens: 12671,
          cacheCreationInputTokens: 7378,
          contextWindow: 200000,
          costUSD: 0.069628,
        },
        'claude-haiku-4-5-20251001': {
          inputTokens: 2341,
          outputTokens: 163,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          costUSD: 0.003156,
        },
      },
    };

    handleEvent(session, event, ctx);

    // Check usage stats were extracted
    expect(session.usageStats).toBeDefined();
    expect(session.usageStats?.primaryModel).toBe('claude-opus-4-5-20251101');
    expect(session.usageStats?.modelDisplayName).toBe('Opus 4.5');
    expect(session.usageStats?.contextWindowSize).toBe(200000);
    expect(session.usageStats?.totalCostUSD).toBe(0.072784);
    // Total tokens: 2471+193+12671+7378 + 2341+163+0+0 = 25217
    expect(session.usageStats?.totalTokensUsed).toBe(25217);
  });

  test('identifies primary model by highest cost', () => {
    const event = {
      type: 'result' as const,
      total_cost_usd: 0.10,
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          costUSD: 0.01,
        },
        'claude-sonnet-4-20251101': {
          inputTokens: 500,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          costUSD: 0.09, // Higher cost = primary model
        },
      },
    };

    handleEvent(session, event, ctx);

    expect(session.usageStats?.primaryModel).toBe('claude-sonnet-4-20251101');
    expect(session.usageStats?.modelDisplayName).toBe('Sonnet 4');
  });

  test('does not set usage stats when modelUsage is missing', () => {
    const event = {
      type: 'result' as const,
      subtype: 'success',
      total_cost_usd: 0.05,
      // No modelUsage field
    };

    handleEvent(session, event, ctx);

    expect(session.usageStats).toBeUndefined();
  });

  test('starts status bar timer on first result event', () => {
    expect(session.statusBarTimer).toBeNull();

    const event = {
      type: 'result' as const,
      total_cost_usd: 0.01,
      modelUsage: {
        'claude-opus-4-5-20251101': {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          costUSD: 0.01,
        },
      },
    };

    handleEvent(session, event, ctx);

    expect(session.statusBarTimer).not.toBeNull();

    // Clean up the timer
    if (session.statusBarTimer) {
      clearInterval(session.statusBarTimer);
      session.statusBarTimer = null;
    }
  });

  test('calls updateSessionHeader after extracting usage stats', () => {
    const event = {
      type: 'result' as const,
      total_cost_usd: 0.01,
      modelUsage: {
        'claude-opus-4-5-20251101': {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          costUSD: 0.01,
        },
      },
    };

    handleEvent(session, event, ctx);

    expect(ctx.updateSessionHeader).toHaveBeenCalled();

    // Clean up
    if (session.statusBarTimer) {
      clearInterval(session.statusBarTimer);
      session.statusBarTimer = null;
    }
  });

  test('handles various model name formats correctly', () => {
    const testCases = [
      { modelId: 'claude-opus-4-5-20251101', expected: 'Opus 4.5' },
      { modelId: 'claude-opus-4-20251101', expected: 'Opus 4' },
      { modelId: 'claude-sonnet-3-5-20240620', expected: 'Sonnet 3.5' },
      { modelId: 'claude-sonnet-4-20251101', expected: 'Sonnet 4' },
      { modelId: 'claude-haiku-4-5-20251001', expected: 'Haiku 4.5' },
      { modelId: 'claude-haiku-3-20240307', expected: 'Haiku' },
    ];

    for (const { modelId, expected } of testCases) {
      session = createTestSession(platform); // Fresh session
      const event = {
        type: 'result' as const,
        total_cost_usd: 0.01,
        modelUsage: {
          [modelId]: {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 200000,
            costUSD: 0.01,
          },
        },
      };

      handleEvent(session, event, ctx);

      expect(session.usageStats?.modelDisplayName).toBe(expected);

      // Clean up timer
      if (session.statusBarTimer) {
        clearInterval(session.statusBarTimer);
        session.statusBarTimer = null;
      }
    }
  });
});
