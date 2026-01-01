/**
 * Tests for streaming.ts - message streaming and sticky task list functionality
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { flush, bumpTasksToBottom } from './streaming.js';
import type { Session } from './types.js';
import type { PlatformClient, PlatformPost } from '../platform/index.js';

// Mock platform client
function createMockPlatform() {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

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
  };
}

describe('flush', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock((_postId: string, _threadId: string) => {});
  });

  test('creates new post when currentPostId is null', async () => {
    session.pendingContent = 'Hello world';

    await flush(session, registerPost);

    expect(platform.createPost).toHaveBeenCalledTimes(1);
    expect(session.currentPostId).toBe('post_1');
    expect(registerPost).toHaveBeenCalledWith('post_1', 'thread1');
  });

  test('updates existing post when currentPostId exists', async () => {
    session.currentPostId = 'existing_post';
    session.pendingContent = 'Updated content';

    await flush(session, registerPost);

    expect(platform.updatePost).toHaveBeenCalledWith('existing_post', 'Updated content');
    expect(platform.createPost).not.toHaveBeenCalled();
  });

  test('does nothing when pendingContent is empty', async () => {
    session.pendingContent = '';

    await flush(session, registerPost);

    expect(platform.createPost).not.toHaveBeenCalled();
    expect(platform.updatePost).not.toHaveBeenCalled();
  });

  test('bumps task list to bottom when creating new post with existing task list', async () => {
    // Set up existing task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 **Tasks** (0/1)\n○ Do something';
    session.pendingContent = 'New Claude response';

    await flush(session, registerPost);

    // Should have updated the old tasks post with new content
    expect(platform.updatePost).toHaveBeenCalledWith('tasks_post', 'New Claude response');
    // Should have created a new tasks post
    expect(platform.createPost).toHaveBeenCalledWith('📋 **Tasks** (0/1)\n○ Do something', 'thread1');
    // currentPostId should be the old tasks post (repurposed)
    expect(session.currentPostId).toBe('tasks_post');
    // tasksPostId should be the new post
    expect(session.tasksPostId).toBe('post_1');
  });

  test('does not bump task list when updating existing post', async () => {
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 **Tasks** (0/1)\n○ Do something';
    session.currentPostId = 'current_post';
    session.pendingContent = 'More content';

    await flush(session, registerPost);

    // Should only update the current post, not touch tasks
    expect(platform.updatePost).toHaveBeenCalledTimes(1);
    expect(platform.updatePost).toHaveBeenCalledWith('current_post', 'More content');
    expect(platform.createPost).not.toHaveBeenCalled();
    expect(session.tasksPostId).toBe('tasks_post'); // unchanged
  });
});

describe('bumpTasksToBottom', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
  });

  test('does nothing when no task list exists', async () => {
    session.tasksPostId = null;
    session.lastTasksContent = null;

    await bumpTasksToBottom(session);

    expect(platform.deletePost).not.toHaveBeenCalled();
    expect(platform.createPost).not.toHaveBeenCalled();
  });

  test('does nothing when tasksPostId exists but no content', async () => {
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = null;

    await bumpTasksToBottom(session);

    expect(platform.deletePost).not.toHaveBeenCalled();
    expect(platform.createPost).not.toHaveBeenCalled();
  });

  test('does nothing when task list is completed', async () => {
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 ~~Tasks~~ *(completed)*';
    session.tasksCompleted = true;

    await bumpTasksToBottom(session);

    // Should not delete or create - completed tasks stay in place
    expect(platform.deletePost).not.toHaveBeenCalled();
    expect(platform.createPost).not.toHaveBeenCalled();
    expect(session.tasksPostId).toBe('tasks_post');
  });

  test('deletes old task post and creates new one at bottom', async () => {
    session.tasksPostId = 'old_tasks_post';
    session.lastTasksContent = '📋 **Tasks** (1/2)\n✅ Done\n○ Pending';

    await bumpTasksToBottom(session);

    // Should delete the old post
    expect(platform.deletePost).toHaveBeenCalledWith('old_tasks_post');
    // Should create new post with same content
    expect(platform.createPost).toHaveBeenCalledWith(
      '📋 **Tasks** (1/2)\n✅ Done\n○ Pending',
      'thread1'
    );
    // tasksPostId should be updated to new post
    expect(session.tasksPostId).toBe('post_1');
  });

  test('handles errors gracefully', async () => {
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 Tasks';

    // Make deletePost throw an error
    (platform.deletePost as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('Network error');
    });

    // Should not throw
    await bumpTasksToBottom(session);

    // tasksPostId should remain unchanged due to error
    expect(session.tasksPostId).toBe('tasks_post');
  });
});

describe('flush with continuation (message splitting)', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock((_postId: string, _threadId: string) => {});
  });

  test('splits long content into multiple posts', async () => {
    // Create content that exceeds CONTINUATION_THRESHOLD (14000 chars)
    const longContent = 'A'.repeat(15000);
    session.currentPostId = 'current_post';
    session.pendingContent = longContent;

    await flush(session, registerPost);

    // Should update current post with first part
    expect(platform.updatePost).toHaveBeenCalled();
    const updateCall = (platform.updatePost as ReturnType<typeof mock>).mock.calls[0];
    expect(updateCall[0]).toBe('current_post');
    expect(updateCall[1]).toContain('*... (continued below)*');

    // Should create continuation post
    expect(platform.createPost).toHaveBeenCalled();
  });

  test('bumps task list when creating continuation post', async () => {
    // Set up task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 Tasks';

    // Create content that exceeds threshold
    const longContent = 'B'.repeat(15000);
    session.currentPostId = 'current_post';
    session.pendingContent = longContent;

    await flush(session, registerPost);

    // Should update current post with first part
    expect(platform.updatePost).toHaveBeenCalledWith('current_post', expect.stringContaining('*... (continued below)*'));

    // Should repurpose tasks post for continuation
    expect(platform.updatePost).toHaveBeenCalledWith('tasks_post', expect.stringContaining('*(continued)*'));

    // Should create new tasks post
    expect(platform.createPost).toHaveBeenCalledWith('📋 Tasks', 'thread1');
  });

  test('does not bump completed task list when creating continuation post', async () => {
    // Set up completed task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 ~~Tasks~~ *(completed)*';
    session.tasksCompleted = true;

    // Create content that exceeds threshold
    const longContent = 'C'.repeat(15000);
    session.currentPostId = 'current_post';
    session.pendingContent = longContent;

    await flush(session, registerPost);

    // Should update current post with first part
    expect(platform.updatePost).toHaveBeenCalledWith('current_post', expect.stringContaining('*... (continued below)*'));

    // Should NOT repurpose tasks post - create new post instead
    expect(platform.createPost).toHaveBeenCalledWith(expect.stringContaining('*(continued)*'), 'thread1');

    // Tasks post should remain unchanged
    expect(session.tasksPostId).toBe('tasks_post');
  });
});

describe('flush with completed tasks', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock((_postId: string, _threadId: string) => {});
  });

  test('does not bump completed task list when creating new post', async () => {
    // Set up completed task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 ~~Tasks~~ *(completed)*';
    session.tasksCompleted = true;

    // No current post, so flush will create one
    session.currentPostId = null;
    session.pendingContent = 'New response content';

    await flush(session, registerPost);

    // Should create a new post (not repurpose the tasks post)
    expect(platform.createPost).toHaveBeenCalledWith('New response content', 'thread1');

    // Tasks post should remain unchanged
    expect(session.tasksPostId).toBe('tasks_post');
  });

  test('bumps active task list when creating new post', async () => {
    // Set up active (non-completed) task list
    session.tasksPostId = 'tasks_post';
    session.lastTasksContent = '📋 **Tasks** (0/1)\n○ Pending task';
    session.tasksCompleted = false;

    // No current post, so flush will create one
    session.currentPostId = null;
    session.pendingContent = 'New response content';

    await flush(session, registerPost);

    // Should repurpose tasks post for new content
    expect(platform.updatePost).toHaveBeenCalledWith('tasks_post', 'New response content');

    // Should create new tasks post at bottom
    expect(platform.createPost).toHaveBeenCalledWith('📋 **Tasks** (0/1)\n○ Pending task', 'thread1');
  });
});
