/**
 * Tests for MessageManager
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MessageManager } from './message-manager.js';
import type { PlatformClient, PlatformFormatter, PlatformPost } from '../platform/index.js';
import type { Session } from '../session/types.js';
import { PostTracker } from './post-tracker.js';

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

// Create mock platform
function createMockPlatform(): PlatformClient {
  const posts = new Map<string, { content: string; reactions: string[] }>();
  let postIdCounter = 0;

  return {
    getFormatter: () => mockFormatter,
    createPost: mock(async (content: string, _threadId: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content, reactions: [] });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    createInteractivePost: mock(async (content: string, reactions: string[], _threadId: string): Promise<PlatformPost> => {
      const id = `post_${++postIdCounter}`;
      posts.set(id, { content, reactions });
      return { id, platformId: 'test', channelId: 'channel-1', message: content, createAt: Date.now(), userId: 'bot' };
    }),
    updatePost: mock(async (postId: string, content: string): Promise<void> => {
      const post = posts.get(postId);
      if (post) {
        post.content = content;
      }
    }),
    deletePost: mock(async (_postId: string): Promise<void> => {}),
    getMessageLimits: () => ({ maxLength: 16000, hardThreshold: 12000 }),
    pinPost: mock(async () => {}),
    unpinPost: mock(async () => {}),
    addReaction: mock(async () => {}),
    removeReaction: mock(async () => {}),
  } as unknown as PlatformClient;
}

// Create mock session for MessageManager
function createMockSession(platform: PlatformClient): Session {
  return {
    sessionId: 'test:session-1',
    platformId: 'test',
    threadId: 'thread-123',
    platform,
    claude: {
      isRunning: mock(() => true),
      sendMessage: mock(() => {}),
      on: mock(() => {}),
      kill: mock(() => Promise.resolve()),
      interrupt: mock(() => true),
    },
    claudeSessionId: 'claude-session-1',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    workingDir: '/test/working/dir',
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    respondOnlyWhenMentioned: false,
    userAttribution: false,
    sessionStartPostId: null,
    tasksPostId: null,
    lastTasksContent: null,
    tasksCompleted: false,
    tasksMinimized: false,
    timers: { updateTimer: undefined, typingTimer: undefined, idleTimer: undefined },
    lifecycle: { state: 'active', resumeFailCount: 0, hasClaudeResponded: false },
    timeoutWarningPosted: false,
    inProgressTaskStart: null,
    activeToolStarts: new Map(),
    messageCount: 0,
    isProcessing: false,
    recentEvents: [],
  } as unknown as Session;
}

describe('MessageManager', () => {
  let manager: MessageManager;
  let platform: PlatformClient;
  let session: Session;
  let postTracker: PostTracker;
  let registeredPosts: Map<string, unknown>;
  let _lastMessage: PlatformPost | null;
  let _questionCompleted: { toolUseId: string; answers: Array<{ header: string; answer: string }> } | null;
  let _approvalCompleted: { toolUseId: string; approved: boolean } | null;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createMockSession(platform);
    postTracker = new PostTracker();
    registeredPosts = new Map();
    _lastMessage = null;
    _questionCompleted = null;
    _approvalCompleted = null;

    manager = new MessageManager({
      session,
      platform,
      postTracker,
      sessionId: 'test:session-1',
      threadId: 'thread-123',
      registerPost: (postId, options) => {
        registeredPosts.set(postId, options);
      },
      updateLastMessage: (post) => {
        _lastMessage = post;
      },
    });

    // Subscribe to events for testing (replaces old callback approach)
    manager.events.on('question:complete', ({ toolUseId, answers }) => {
      _questionCompleted = { toolUseId, answers };
    });
    manager.events.on('approval:complete', ({ toolUseId, approved }) => {
      _approvalCompleted = { toolUseId, approved };
    });
  });

  describe('Initialization', () => {
    it('creates manager with correct options', () => {
      expect(manager).toBeDefined();
    });

    it('starts with no pending questions', () => {
      expect(manager.hasPendingQuestions()).toBe(false);
    });

    it('starts with no pending approval', () => {
      expect(manager.hasPendingApproval()).toBe(false);
    });

    it('starts with empty task list state', () => {
      const state = manager.getTaskListState();
      expect(state.postId).toBeNull();
      expect(state.content).toBeNull();
      expect(state.isMinimized).toBe(false);
      expect(state.isCompleted).toBe(false);
    });
  });

  describe('System Messages', () => {
    it('posts info message', async () => {
      const post = await manager.postInfo('Test info message');

      expect(post).toBeDefined();
      expect(post?.message).toContain('ℹ️');
      expect(post?.message).toContain('Test info message');
    });

    it('posts warning message', async () => {
      const post = await manager.postWarning('Test warning message');

      expect(post).toBeDefined();
      expect(post?.message).toContain('⚠️');
    });

    it('posts error message', async () => {
      const post = await manager.postError('Test error message');

      expect(post).toBeDefined();
      expect(post?.message).toContain('❌');
    });

    it('posts success message', async () => {
      const post = await manager.postSuccess('Test success message');

      expect(post).toBeDefined();
      expect(post?.message).toContain('✅');
    });
  });

  describe('Worktree Info', () => {
    it('sets worktree info', () => {
      manager.setWorktreeInfo('/path/to/worktree', 'feature-branch');
      // No assertion needed - just verify no error
    });

    it('clears worktree info', () => {
      manager.setWorktreeInfo('/path/to/worktree', 'feature-branch');
      manager.clearWorktreeInfo();
      // No assertion needed - just verify no error
    });
  });

  describe('Lifecycle', () => {
    it('resets state', () => {
      manager.reset();

      expect(manager.hasPendingQuestions()).toBe(false);
      expect(manager.hasPendingApproval()).toBe(false);
      expect(manager.getTaskListState().postId).toBeNull();
    });

    it('disposes resources', () => {
      manager.dispose();

      // Should not throw
      expect(manager.hasPendingQuestions()).toBe(false);
    });

    it('clears its postTracker entries on dispose', () => {
      // Register a few posts under this session and an unrelated session.
      postTracker.register('post-a', 'thread-123', 'test:session-1', { type: 'content' });
      postTracker.register('post-b', 'thread-123', 'test:session-1', { type: 'content' });
      postTracker.register('post-c', 'thread-other', 'test:other-session', { type: 'content' });

      expect(postTracker.getPostsForSession('test:session-1')).toHaveLength(2);
      expect(postTracker.getPostsForSession('test:other-session')).toHaveLength(1);

      manager.dispose();

      // Without the dispose() fix, this leaked across sessions and contributed
      // to OOM crashes after long uptimes (issue #351).
      expect(postTracker.getPostsForSession('test:session-1')).toHaveLength(0);
      // Other sessions must not be affected.
      expect(postTracker.getPostsForSession('test:other-session')).toHaveLength(1);
    });

    it('removes all event listeners on dispose', () => {
      // Sessions attach listeners (question:complete, task:update, etc.) to the
      // per-instance emitter. Their closures hold session state alive, so
      // dispose() must remove them or they leak across many sessions (#394).
      manager.events.on('task:update', () => {});
      manager.events.on('question:complete', () => {});

      expect(manager.events.listenerCount('task:update')).toBeGreaterThan(0);
      expect(manager.events.listenerCount('question:complete')).toBeGreaterThan(0);

      manager.dispose();

      expect(manager.events.listenerCount('task:update')).toBe(0);
      expect(manager.events.listenerCount('question:complete')).toBe(0);
    });
  });

  describe('Event Handling', () => {
    it('handles assistant text event', async () => {
      const event = {
        type: 'assistant' as const,
        message: {
          content: [
            { type: 'text', text: 'Hello, world!' },
          ],
        },
      };

      await manager.handleEvent(event);

      // Content is accumulated but not immediately flushed
      // Manual flush to verify content was processed
      await manager.flush();

      expect(platform.createPost).toHaveBeenCalled();
    });

    it('handles result event', async () => {
      // First send some content
      const textEvent = {
        type: 'assistant' as const,
        message: {
          content: [
            { type: 'text', text: 'Processing complete.' },
          ],
        },
      };
      await manager.handleEvent(textEvent);

      // Then send result event
      const resultEvent = {
        type: 'result' as const,
        result: {},
      };
      await manager.handleEvent(resultEvent);

      // Result event triggers flush
      expect(platform.createPost).toHaveBeenCalled();
    });
  });

  describe('Flush Behavior', () => {
    it('flushes pending content manually', async () => {
      const event = {
        type: 'assistant' as const,
        message: {
          content: [
            { type: 'text', text: 'Test content' },
          ],
        },
      };

      await manager.handleEvent(event);
      await manager.flush();

      expect(platform.createPost).toHaveBeenCalled();
    });
  });

  describe('State Hydration', () => {
    it('hydrates task list state', () => {
      manager.hydrateTaskListState({
        tasksPostId: 'task-post-123',
        lastTasksContent: '📋 Tasks (1/2)',
        tasksCompleted: false,
        tasksMinimized: true,
      });

      const state = manager.getTaskListState();
      expect(state.postId).toBe('task-post-123');
      expect(state.content).toBe('📋 Tasks (1/2)');
      expect(state.isCompleted).toBe(false);
      expect(state.isMinimized).toBe(true);
    });

    it('hydrates interactive state with pending questions', () => {
      manager.hydrateInteractiveState({
        pendingQuestionSet: {
          toolUseId: 'tool-123',
          currentIndex: 1,
          currentPostId: 'question-post-456',
          questions: [
            {
              header: 'Q1',
              question: 'First?',
              options: [{ label: 'A', description: 'desc' }],
              answer: 'A',
            },
            {
              header: 'Q2',
              question: 'Second?',
              options: [{ label: 'B', description: 'desc' }],
              answer: null,
            },
          ],
        },
        pendingApproval: null,
      });

      expect(manager.hasPendingQuestions()).toBe(true);
      expect(manager.hasPendingApproval()).toBe(false);

      const questionSet = manager.getPendingQuestionSet();
      expect(questionSet).not.toBeNull();
      expect(questionSet!.toolUseId).toBe('tool-123');
      expect(questionSet!.currentIndex).toBe(1);
    });

    it('hydrates interactive state with pending approval', () => {
      manager.hydrateInteractiveState({
        pendingQuestionSet: null,
        pendingApproval: {
          postId: 'approval-post-789',
          type: 'plan',
          toolUseId: 'tool-456',
        },
      });

      expect(manager.hasPendingQuestions()).toBe(false);
      expect(manager.hasPendingApproval()).toBe(true);

      const approval = manager.getPendingApproval();
      expect(approval).not.toBeNull();
      expect(approval!.postId).toBe('approval-post-789');
      expect(approval!.type).toBe('plan');
    });

    it('hydrates empty interactive state', () => {
      // First set some state
      manager.hydrateInteractiveState({
        pendingQuestionSet: {
          toolUseId: 'tool-123',
          currentIndex: 0,
          currentPostId: 'post-1',
          questions: [],
        },
        pendingApproval: null,
      });

      expect(manager.hasPendingQuestions()).toBe(true);

      // Now hydrate with empty state
      manager.hydrateInteractiveState({});

      expect(manager.hasPendingQuestions()).toBe(false);
      expect(manager.hasPendingApproval()).toBe(false);
    });
  });

  describe('Worktree Path Shortening', () => {
    it('shortens file paths in tool output when worktree info is set', async () => {
      // Create a new manager with worktree info
      const worktreePath = '/home/testuser/.claude-threads/worktrees/testuser-myrepo--feature-branch-abc12345';
      const newPostTracker = new PostTracker();
      const managerWithWorktree = new MessageManager({
        session,
        platform,
        postTracker: newPostTracker,
        sessionId: 'test:session-wt',
        threadId: 'thread-wt',
        worktreePath,
        worktreeBranch: 'feature/my-branch',
        registerPost: () => {},
        updateLastMessage: () => {},
      });

      // Send a Read tool_use event with a file path in the worktree
      const event = {
        type: 'tool_use' as const,
        tool_use: {
          id: 'tool-read-1',
          name: 'Read',
          input: {
            file_path: `${worktreePath}/src/index.ts`,
          },
        },
      };

      await managerWithWorktree.handleEvent(event);

      // Flush to trigger content creation
      await managerWithWorktree.flush();

      // Check the post content contains shortened path
      const postContent = managerWithWorktree.getCurrentPostContent();
      expect(postContent).toContain('[feature/my-branch]');
      expect(postContent).not.toContain('testuser-myrepo--feature-branch');
    });

    it('shortens paths after setWorktreeInfo is called', async () => {
      // Create a manager WITHOUT worktree info initially
      const worktreePath = '/home/testuser/.claude-threads/worktrees/testuser-myrepo--feature-branch-abc12345';
      const newPostTracker = new PostTracker();
      const managerNoWorktree = new MessageManager({
        session,
        platform,
        postTracker: newPostTracker,
        sessionId: 'test:session-nwt',
        threadId: 'thread-nwt',
        // NO worktreePath or worktreeBranch
        registerPost: () => {},
        updateLastMessage: () => {},
      });

      // Set worktree info dynamically (simulates joining a worktree mid-session)
      managerNoWorktree.setWorktreeInfo(worktreePath, 'feature/my-branch');

      // Send a Read tool_use event with a file path in the worktree
      const event = {
        type: 'tool_use' as const,
        tool_use: {
          id: 'tool-read-dynamic',
          name: 'Read',
          input: {
            file_path: `${worktreePath}/src/index.ts`,
          },
        },
      };

      await managerNoWorktree.handleEvent(event);
      await managerNoWorktree.flush();

      // Check the post content contains shortened path
      const postContent = managerNoWorktree.getCurrentPostContent();
      expect(postContent).toContain('[feature/my-branch]');
      expect(postContent).not.toContain('testuser-myrepo--feature-branch');
    });

    it('uses ~ fallback when worktree info is not set', async () => {
      // Use the home dir that will be used for ~ substitution
      const home = process.env.HOME || '/home/user';
      const filePath = `${home}/.claude-threads/worktrees/some-repo--some-branch/src/index.ts`;

      // The default manager has no worktree info
      const event = {
        type: 'tool_use' as const,
        tool_use: {
          id: 'tool-read-2',
          name: 'Read',
          input: {
            file_path: filePath,
          },
        },
      };

      await manager.handleEvent(event);
      await manager.flush();

      // Should use ~ fallback instead of [branch]
      const postContent = manager.getCurrentPostContent();
      expect(postContent).toContain('~/.claude-threads');
      expect(postContent).not.toContain('[');
    });
  });

  describe('User Message Flow', () => {
    it('creates a new post after user message instead of updating existing post', async () => {
      // 1. Claude sends initial response (creates post_1)
      const event1 = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'First response from Claude' }],
        },
      };
      await manager.handleEvent(event1);
      await manager.flush();

      expect(platform.createPost).toHaveBeenCalledTimes(1);
      const firstPostContent = manager.getCurrentPostContent();
      expect(firstPostContent).toContain('First response');

      // 2. User sends a follow-up message
      await manager.handleUserMessage('User follow-up question', undefined, 'testuser');

      // 3. Claude responds again - should create NEW post, not update post_1
      const event2 = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'Second response from Claude' }],
        },
      };
      await manager.handleEvent(event2);
      await manager.flush();

      // Should have created 2 posts total (not updated the first one)
      expect(platform.createPost).toHaveBeenCalledTimes(2);
      const secondPostContent = manager.getCurrentPostContent();
      expect(secondPostContent).toContain('Second response');
      expect(secondPostContent).not.toContain('First response');
    });

    it('closeCurrentPost signals that next content goes to a new post', async () => {
      // 1. Create initial content in a post
      const event1 = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'Initial content' }],
        },
      };
      await manager.handleEvent(event1);
      await manager.flush();

      expect(platform.createPost).toHaveBeenCalledTimes(1);

      // 2. Close the current post (flushes + signals completion)
      await manager.closeCurrentPost();

      // 3. Next content should go to a NEW post
      const event2 = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'New content after close' }],
        },
      };
      await manager.handleEvent(event2);
      await manager.flush();

      // Should have created 2 posts, not updated the first
      expect(platform.createPost).toHaveBeenCalledTimes(2);
    });

    it('prepareForUserMessage flushes pending content and closes current post', async () => {
      // 1. Accumulate some content (but don't flush yet)
      const event = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'Pending content' }],
        },
      };
      await manager.handleEvent(event);

      // Content is pending, no post created yet
      expect(platform.createPost).toHaveBeenCalledTimes(0);

      // 2. Prepare for user message (should flush + close)
      await manager.prepareForUserMessage();

      // Should have flushed the pending content
      expect(platform.createPost).toHaveBeenCalledTimes(1);

      // 3. Next content should go to a new post
      const event2 = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'After user message' }],
        },
      };
      await manager.handleEvent(event2);
      await manager.flush();

      // Should have created 2 posts
      expect(platform.createPost).toHaveBeenCalledTimes(2);
    });
  });

  describe('restoreTaskListFromPersistence', () => {
    /**
     * Regression test: When a session is resumed with an active task list,
     * the task list should be bumped to the bottom of the thread.
     *
     * Without this, the task list would stay at its old position (above
     * the resume message) which confuses users.
     */
    it('bumps active task list to bottom after hydration', async () => {
      // Simulate having an active task list in persisted state
      const persistedState = {
        tasksPostId: 'old-task-post-id',
        lastTasksContent: '📋 Tasks (1/3)',
        tasksCompleted: false,
        tasksMinimized: false,
      };

      // Track how many interactive posts were created before restore
      // (bump uses createInteractivePost because it adds the toggle emoji)
      const createInteractivePostCallsBefore = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls.length;

      // Restore from persistence - this should hydrate AND bump
      await manager.restoreTaskListFromPersistence(persistedState);

      // Verify hydration happened (state was restored)
      const restoredState = manager.getTaskListState();
      expect(restoredState.content).toBe('📋 Tasks (1/3)');

      // Verify bump happened - a new interactive post should have been created
      // (bump deletes old post and creates new one with toggle emoji)
      const createInteractivePostCallsAfter = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls.length;
      expect(createInteractivePostCallsAfter).toBeGreaterThan(createInteractivePostCallsBefore);
    });

    it('does not bump completed task list', async () => {
      const persistedState = {
        tasksPostId: 'old-task-post-id',
        lastTasksContent: '📋 Tasks (3/3)',
        tasksCompleted: true,  // Completed - should not bump
        tasksMinimized: false,
      };

      const createPostCallsBefore = (platform.createPost as ReturnType<typeof mock>).mock.calls.length;

      await manager.restoreTaskListFromPersistence(persistedState);

      // No bump should happen for completed task lists
      const createPostCallsAfter = (platform.createPost as ReturnType<typeof mock>).mock.calls.length;
      expect(createPostCallsAfter).toBe(createPostCallsBefore);
    });

    it('does not bump when no task list exists', async () => {
      const persistedState = {
        tasksPostId: null,
        lastTasksContent: null,
        tasksCompleted: false,
        tasksMinimized: false,
      };

      const createPostCallsBefore = (platform.createPost as ReturnType<typeof mock>).mock.calls.length;

      await manager.restoreTaskListFromPersistence(persistedState);

      // No bump should happen when there's no task list
      const createPostCallsAfter = (platform.createPost as ReturnType<typeof mock>).mock.calls.length;
      expect(createPostCallsAfter).toBe(createPostCallsBefore);
    });

    /**
     * Regression test: When restoring a COMPLETED task list and then receiving
     * new todo_write events, the new tasks should create a FRESH post, not
     * update the old completed one.
     *
     * Without this fix, after resume, new tasks would update the old completed
     * task list post (which is above the resume message) instead of creating
     * a new one at the bottom.
     */
    it('clears tasksPostId for completed task lists so new tasks create fresh post', async () => {
      // Restore a COMPLETED task list
      const persistedState = {
        tasksPostId: 'old-completed-task-post',
        lastTasksContent: '📋 Tasks (8/8)',
        tasksCompleted: true,
        tasksMinimized: false,
      };

      await manager.restoreTaskListFromPersistence(persistedState);

      // After restoring a completed task list, the tasksPostId should be cleared
      // so that new todo_write events create a fresh post
      const state = manager.getTaskListState();
      expect(state.postId).toBeNull();
    });
  });

  describe('Event serialization', () => {
    /**
     * Regression test: When tool_use (TodoWrite) and assistant events arrive
     * in quick succession, events must be serialized so task list is created
     * before content tries to flush.
     *
     * The real-world scenario: SessionManager fires events with `void`:
     *   void manager.handleEvent(event1);  // fire-and-forget
     *   void manager.handleEvent(event2);  // fire-and-forget
     *
     * Without serialization, event2 might complete before event1, causing
     * the task list to be stuck above content.
     */
    it('serializes concurrent events so task list is created before content flushes', async () => {
      // Create events
      const todoEvent = {
        type: 'tool_use' as const,
        tool_use: {
          name: 'TodoWrite',
          id: 'test-tool-123',
          input: {
            todos: [
              { content: 'Task 1', status: 'pending', activeForm: 'Doing task 1' },
            ],
          },
        },
      };

      const contentEvent = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'Here is some content after the task list.' }],
        },
      };

      // Simulate fire-and-forget pattern from SessionManager
      // Both events start processing concurrently
      void manager.handleEvent(todoEvent as any);
      void manager.handleEvent(contentEvent);

      // Wait a bit for both events to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Flush any remaining content
      await manager.flush();

      // Get final state
      const taskState = manager.getTaskListState();
      const createInteractivePostCalls = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls.length;

      // With proper serialization:
      // 1. TodoWrite event is queued first, creates task list post (createInteractivePost)
      // 2. Assistant event is queued second, waits for TodoWrite to complete
      // 3. Content flush finds existing task list, bumps it (createInteractivePost again)
      // Result: task list exists, 2+ createInteractivePost calls, content goes via bump
      //
      // Without serialization (race condition):
      // 1. Both events start concurrently
      // 2. Content might flush before task list exists
      // 3. Content creates regular post (createPost), task list created after
      // Result: task list exists but may be above content, fewer bumps

      // The task list should exist
      expect(taskState.postId).not.toBeNull();

      // If serialization works correctly, content should have found the task list
      // and used bumpAndGetOldPost (which creates 2 createInteractivePost calls total)
      // If race condition occurred, content would use createPost (non-interactive)
      expect(createInteractivePostCalls).toBeGreaterThanOrEqual(2);
    });

    it('bumps task list to bottom when content creates new post (not via bump)', async () => {
      /**
       * Regression test: When content creates a new post (because there's no task
       * post to repurpose), the task list should still be bumped to the bottom.
       *
       * This test verifies the onBumpTaskListToBottom callback chain is wired up
       * correctly in MessageManager. The unit test in content.test.ts verifies
       * the callback is called; this test verifies the integration.
       *
       * We simulate the scenario by making updatePost fail during bumpAndGetOldPost,
       * which causes it to return null, forcing content to create a new post.
       */

      // First, create a task list with ACTIVE (not completed) tasks
      const todoEvent = {
        type: 'tool_use' as const,
        tool_use: {
          name: 'TodoWrite',
          id: 'test-tool-456',
          input: {
            todos: [
              { content: 'Task 1', status: 'in_progress', activeForm: 'Task 1' },
            ],
          },
        },
      };
      await manager.handleEvent(todoEvent as any);

      // Record createInteractivePost calls before content
      const bumpCallsBefore = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls.length;

      // Make updatePost fail so bumpAndGetOldPost cannot repurpose the task post
      // This simulates a network error during bump
      let updatePostCallCount = 0;
      const originalUpdatePost = platform.updatePost;
      (platform.updatePost as ReturnType<typeof mock>) = mock(async (postId: string, content: string) => {
        updatePostCallCount++;
        // Fail the first updatePost call (the one from bumpAndGetOldPost trying to repurpose)
        // but let subsequent calls succeed (for the new task post)
        if (updatePostCallCount === 1) {
          throw new Error('Simulated network error');
        }
        return originalUpdatePost(postId, content);
      });

      // Now send content event
      const contentEvent = {
        type: 'assistant' as const,
        message: {
          content: [{ type: 'text', text: 'Content that creates a new post.' }],
        },
      };
      await manager.handleEvent(contentEvent);
      await manager.flush();

      // Check that task list was bumped after content creation
      const bumpCallsAfter = (platform.createInteractivePost as ReturnType<typeof mock>).mock.calls.length;

      // With the fix, after content creates a new post, onBumpTaskListToBottom
      // is called which creates another task list post at the bottom
      // So we should see multiple createInteractivePost calls:
      // 1. Initial task list creation
      // 2. New task list after failed repurpose (from bumpAndGetOldPost error recovery)
      // 3. Bump to bottom after content post (from onBumpTaskListToBottom)
      expect(bumpCallsAfter).toBeGreaterThan(bumpCallsBefore);
    });
  });

  /**
   * Regression test: Task updates must emit 'task:update' event for sticky message refresh.
   *
   * Bug: The sticky message shows task progress (e.g., "3/7") and active task name,
   * but wasn't being updated when tasks changed. This is because the TaskListOp
   * execution didn't notify anyone that tasks had changed.
   *
   * Fix: Emit 'task:update' event after TaskListOp execution so the session layer
   * can call updateStickyMessage() to refresh the display.
   */
  describe('Task update event emission', () => {
    it('emits task:update event when tasks are updated', async () => {
      let taskUpdateReceived: { completed: number; total: number; allComplete: boolean } | null = null;

      manager.events.on('task:update', (data) => {
        taskUpdateReceived = data;
      });

      // Send a task list update event
      const todoEvent = {
        type: 'tool_use' as const,
        tool_use: {
          name: 'TodoWrite',
          id: 'test-task-update',
          input: {
            todos: [
              { content: 'Task 1', status: 'completed', activeForm: 'Done with task 1' },
              { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
              { content: 'Task 3', status: 'pending', activeForm: 'Task 3 waiting' },
            ],
          },
        },
      };

      await manager.handleEvent(todoEvent as any);

      // CRITICAL: The task:update event must be emitted so sticky message can refresh
      expect(taskUpdateReceived).not.toBeNull();
      expect(taskUpdateReceived!.completed).toBe(1);
      expect(taskUpdateReceived!.total).toBe(3);
      expect(taskUpdateReceived!.allComplete).toBe(false);
    });

    it('emits task:update with allComplete=true when all tasks done', async () => {
      let taskUpdateReceived: { completed: number; total: number; allComplete: boolean } | null = null;

      manager.events.on('task:update', (data) => {
        taskUpdateReceived = data;
      });

      // Send a task list with all completed
      const todoEvent = {
        type: 'tool_use' as const,
        tool_use: {
          name: 'TodoWrite',
          id: 'test-task-complete',
          input: {
            todos: [
              { content: 'Task 1', status: 'completed', activeForm: 'Done' },
              { content: 'Task 2', status: 'completed', activeForm: 'Done' },
            ],
          },
        },
      };

      await manager.handleEvent(todoEvent as any);

      expect(taskUpdateReceived).not.toBeNull();
      expect(taskUpdateReceived!.completed).toBe(2);
      expect(taskUpdateReceived!.total).toBe(2);
      expect(taskUpdateReceived!.allComplete).toBe(true);
    });
  });

  describe('handleUserMessage attribution', () => {
    it('prefixes the sent message with the sender login when the session flag is on', async () => {
      session.userAttribution = true;
      // Attribution only applies once a thread is genuinely shared.
      session.sessionAllowedUsers.add('collaborator');
      await manager.handleUserMessage('deploy it', undefined, 'alice');
      const sent = (session.claude.sendMessage as any).mock.calls[0][0];
      expect(sent).toBe('[@alice]: deploy it');
    });

    it('sends the raw message when the session flag is off (default)', async () => {
      await manager.handleUserMessage('deploy it', undefined, 'alice');
      const sent = (session.claude.sendMessage as any).mock.calls[0][0];
      expect(sent).toBe('deploy it');
    });

    it('does NOT attribute when no username is provided (system/control send)', async () => {
      session.userAttribution = true;
      // Attribution only applies once a thread is genuinely shared.
      session.sessionAllowedUsers.add('collaborator');
      await manager.handleUserMessage('/context', undefined, undefined);
      const sent = (session.claude.sendMessage as any).mock.calls[0][0];
      expect(sent).toBe('/context');
    });
  });

  describe('handleUserMessage side-conversation composition', () => {
    it('keeps the [@user]: prefix on the sender turn only — side-conversation context stays OUTSIDE it', async () => {
      // Regression-defender for the attribution/side-conversation collision:
      // the sender's turn must be the only thing wrapped by [@alice]:, while
      // other users' side remarks (which are self-attributed) sit before it.
      // A revert to "wrap the whole sideContext+message" would prefix bob's
      // words with [@alice]: and fail the negative assertion below.
      session.userAttribution = true;
      // Attribution only applies once a thread is genuinely shared.
      session.sessionAllowedUsers.add('collaborator');
      session.pendingSideConversations = [
        { fromUser: 'bob', mentionedUser: 'carol', message: 'ping carol', timestamp: new Date() },
      ] as unknown as Session['pendingSideConversations'];

      await manager.handleUserMessage('deploy it', undefined, 'alice');
      const sent = (session.claude.sendMessage as any).mock.calls[0][0] as string;

      // The sender's own turn is attributed...
      expect(sent).toContain('[@alice]: deploy it');
      // ...but the [@alice]: prefix does NOT swallow the side-conversation block.
      expect(sent).not.toContain('[@alice]: [Side conversation');
      // Ordering: the side context precedes the attributed turn.
      expect(sent.indexOf('Side conversation')).toBeLessThan(sent.indexOf('[@alice]:'));
      // bob's remark is still present for Claude's awareness.
      expect(sent).toContain('@bob to @carol');
    });

    it('clears pending side conversations once composed into the outgoing message', async () => {
      session.pendingSideConversations = [
        { fromUser: 'bob', mentionedUser: 'carol', message: 'x', timestamp: new Date() },
      ] as unknown as Session['pendingSideConversations'];

      await manager.handleUserMessage('hi', undefined, 'alice');

      expect(session.pendingSideConversations?.length ?? 0).toBe(0);
    });
  });
});

describe('clearClaudeSessionState', () => {
  let manager: MessageManager;

  beforeEach(() => {
    const platform = createMockPlatform();
    const session = createMockSession(platform);
    manager = new MessageManager({
      session,
      platform,
      postTracker: new PostTracker(),
      sessionId: 'test:session-1',
      threadId: 'thread-123',
      registerPost: () => {},
      updateLastMessage: () => {},
    });
  });

  it('drops accumulated task and tool-timing state', async () => {
    // Accumulate state through the real event path
    await manager.handleEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'TaskCreate', id: 'tu-1', input: { subject: 'a task', description: 'd' } },
          { type: 'tool_use', name: 'Bash', id: 'tu-2', input: { command: 'ls' } },
        ],
      },
    });
    const internals = manager as unknown as {
      taskTracker: { isEmpty: boolean };
      toolStartTimes: Map<string, number>;
    };
    expect(internals.taskTracker.isEmpty).toBe(false);
    expect(internals.toolStartTimes.size).toBe(1);

    manager.clearClaudeSessionState();

    expect(internals.taskTracker.isEmpty).toBe(true);
    expect(internals.toolStartTimes.size).toBe(0);
  });
});

describe('decision bridge integration', () => {
  let manager: MessageManager;

  beforeEach(() => {
    const platform = createMockPlatform();
    const session = createMockSession(platform);
    manager = new MessageManager({
      session,
      platform,
      postTracker: new PostTracker(),
      sessionId: 'test:session-1',
      threadId: 'thread-123',
      registerPost: () => {},
      updateLastMessage: () => {},
    });
  });

  it('resolves a pending plan request on approval and reports consumption', async () => {
    const pending = manager.handleBridgeRequest({
      kind: 'plan_approval',
      toolName: 'ExitPlanMode',
      input: { plan: 'p' },
    });

    expect(manager.resolveBridgePlan(true)).toBe(true);
    const decision = await pending;
    expect(decision.behavior).toBe('allow');
    expect(decision.updatedInput).toEqual({ plan: 'p' });

    // Consumed: a second resolution finds nothing pending → stdin fallback
    expect(manager.resolveBridgePlan(true)).toBe(false);
  });

  it('denies a rejected plan', async () => {
    const pending = manager.handleBridgeRequest({
      kind: 'plan_approval',
      toolName: 'ExitPlanMode',
      input: { plan: 'p' },
    });
    expect(manager.resolveBridgePlan(false)).toBe(true);
    const decision = await pending;
    expect(decision.behavior).toBe('deny');
  });

  it('maps question answers from header keys to question-text keys', async () => {
    const input = {
      questions: [
        { question: 'Do you prefer red or blue?', header: 'Color', options: [] },
        { question: 'Tabs or spaces?', header: 'Style', options: [], multiSelect: false },
      ],
    };
    const pending = manager.handleBridgeRequest({
      kind: 'question',
      toolName: 'AskUserQuestion',
      input,
    });

    expect(
      manager.resolveBridgeQuestion([
        { header: 'Color', answer: 'Blue' },
        { header: 'Style', answer: 'Spaces' },
      ])
    ).toBe(true);

    const decision = await pending;
    expect(decision.behavior).toBe('allow');
    expect((decision.updatedInput as { answers: unknown }).answers).toEqual({
      'Do you prefer red or blue?': 'Blue',
      'Tabs or spaces?': 'Spaces',
    });
  });

  it('returns false with no pending bridge request (stdin path keeps working)', () => {
    expect(manager.resolveBridgePlan(true)).toBe(false);
    expect(manager.resolveBridgeQuestion([{ header: 'X', answer: 'y' }])).toBe(false);
  });

  it('a newer plan request supersedes (denies) an abandoned one', async () => {
    const first = manager.handleBridgeRequest({
      kind: 'plan_approval',
      toolName: 'ExitPlanMode',
      input: { plan: 'old' },
    });
    const second = manager.handleBridgeRequest({
      kind: 'plan_approval',
      toolName: 'ExitPlanMode',
      input: { plan: 'new' },
    });

    const firstDecision = await first;
    expect(firstDecision.behavior).toBe('deny');
    expect(firstDecision.message).toContain('Superseded');

    manager.resolveBridgePlan(true);
    expect((await second).behavior).toBe('allow');
  });

  it('dispose() denies pending bridge requests so the MCP child is not stranded', async () => {
    const pending = manager.handleBridgeRequest({
      kind: 'question',
      toolName: 'AskUserQuestion',
      input: { questions: [] },
    });
    manager.dispose();
    const decision = await pending;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain('Session ended');
  });

  it('clearClaudeSessionState() denies pending bridge requests (fresh CLI, fresh MCP child)', async () => {
    const pending = manager.handleBridgeRequest({
      kind: 'plan_approval',
      toolName: 'ExitPlanMode',
      input: { plan: 'p' },
    });
    manager.clearClaudeSessionState();
    const decision = await pending;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain('restarted');
  });
});

describe('decision bridge abort handling', () => {
  let manager: MessageManager;

  beforeEach(() => {
    const platform = createMockPlatform();
    const session = createMockSession(platform);
    manager = new MessageManager({
      session,
      platform,
      postTracker: new PostTracker(),
      sessionId: 'test:session-1',
      threadId: 'thread-123',
      registerPost: () => {},
      updateLastMessage: () => {},
    });
  });

  it('an aborted request clears the pending so the next decision falls back to stdin', () => {
    const aborter = new AbortController();
    void manager.handleBridgeRequest(
      { kind: 'plan_approval', toolName: 'ExitPlanMode', input: { plan: 'p' } },
      aborter.signal
    );

    // The MCP-side request died (its timeout, a cancelled tool call, a dead
    // MCP child). A stale pending must NOT swallow the user's later reaction.
    aborter.abort();

    expect(manager.resolveBridgePlan(true)).toBe(false);
  });

  it('an abort of a superseded request does not clear the live one', async () => {
    const firstAborter = new AbortController();
    const first = manager.handleBridgeRequest(
      { kind: 'plan_approval', toolName: 'ExitPlanMode', input: { plan: 'old' } },
      firstAborter.signal
    );
    const second = manager.handleBridgeRequest(
      { kind: 'plan_approval', toolName: 'ExitPlanMode', input: { plan: 'new' } },
      new AbortController().signal
    );
    expect((await first).behavior).toBe('deny');

    // The dead first request's socket closing must not disarm the live one
    firstAborter.abort();
    expect(manager.resolveBridgePlan(true)).toBe(true);
    expect((await second).behavior).toBe('allow');
  });

  it('question aborts behave the same', () => {
    const aborter = new AbortController();
    void manager.handleBridgeRequest(
      { kind: 'question', toolName: 'AskUserQuestion', input: { questions: [] } },
      aborter.signal
    );
    aborter.abort();
    expect(manager.resolveBridgeQuestion([{ header: 'X', answer: 'y' }])).toBe(false);
  });
});

describe('MessageManager tool activity (summary / hidden)', () => {
  let platform: PlatformClient;
  let session: Session;
  let registeredPosts: Map<string, unknown>;
  let lastMessage: PlatformPost | null;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createMockSession(platform);
    registeredPosts = new Map();
    lastMessage = null;
  });

  function withToolActivity(settings: { activity: 'summary' | 'hidden'; details: 'thread' | 'none' }) {
    return new MessageManager({
      session, platform, postTracker: new PostTracker(),
      sessionId: 'test:session-1', threadId: 'thread-123',
      registerPost: (postId, options) => { registeredPosts.set(postId, options); },
      updateLastMessage: (post) => { lastMessage = post; },
      toolActivity: settings,
    });
  }
  const toolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'ls' } }] } } as never;
  const toolDone = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } } as never;
  const text = { type: 'assistant', message: { content: [{ type: 'text', text: 'Two files.' }] } } as never;
  const result = { type: 'result', result: {} } as never;
  const allTexts = () => [
    ...(platform.createPost as ReturnType<typeof mock>).mock.calls.map((c) => c[0] as string),
    ...(platform.updatePost as ReturnType<typeof mock>).mock.calls.map((c) => c[1] as string),
  ];

  it('summary + none: the reply carries the summary line above the text and no tool line', async () => {
    const m = withToolActivity({ activity: 'summary', details: 'none' });
    for (const ev of [toolUse, toolDone, text, result]) await m.handleEvent(ev);

    const finalText = allTexts().at(-1) as string;
    expect(finalText.startsWith('🔧 1 tool · ')).toBe(true);
    expect(finalText).toContain('Two files.');
    expect(finalText).not.toContain('Bash');
    expect(allTexts().some((t) => t.includes('↳'))).toBe(false);
  });

  it('summary + thread: the tool lines land in a post under the session thread, registered as tool_details, never as the latest reply', async () => {
    const m = withToolActivity({ activity: 'summary', details: 'thread' });
    for (const ev of [toolUse, toolDone, text, result]) await m.handleEvent(ev);

    const calls = (platform.createPost as ReturnType<typeof mock>).mock.calls as Array<[string, string]>;
    const details = calls.find(([content]) => content.includes('Bash'));
    expect(details).toBeDefined();
    expect(details?.[1]).toBe('thread-123');
    // The reply post comes first even though the tool was the first event.
    expect(calls[0][0].startsWith('🔧')).toBe(true);
    expect(calls.indexOf(details as [string, string])).toBeGreaterThan(0);
    expect(details?.[0]).toContain('↳ ✓');
    const detailsId = `post_${calls.indexOf(details as [string, string]) + 1}`;
    expect((registeredPosts.get(detailsId) as { type: string }).type).toBe('tool_details');
    expect(lastMessage?.message.includes('Bash')).toBe(false);
  });

  it('hidden + none: neither the tools nor a summary appear', async () => {
    const m = withToolActivity({ activity: 'hidden', details: 'none' });
    for (const ev of [toolUse, toolDone, text, result]) await m.handleEvent(ev);

    expect(allTexts().some((t) => t.includes('Bash') || t.includes('🔧') || t.includes('↳'))).toBe(false);
    expect(allTexts().at(-1)).toContain('Two files.');
  });
});
