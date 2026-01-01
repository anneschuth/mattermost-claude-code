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
