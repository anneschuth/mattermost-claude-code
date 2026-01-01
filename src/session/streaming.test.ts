/**
 * Tests for streaming.ts - message streaming and sticky task list functionality
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  flush,
  bumpTasksToBottom,
  findLogicalBreakpoint,
  shouldFlushEarly,
  endsAtBreakpoint,
  getCodeBlockState,
  SOFT_BREAK_THRESHOLD,
  MIN_BREAK_THRESHOLD,
  MAX_LINES_BEFORE_BREAK,
} from './streaming.js';
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
    messageCount: 0,
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

// ---------------------------------------------------------------------------
// Logical breakpoint detection tests
// ---------------------------------------------------------------------------

describe('findLogicalBreakpoint', () => {
  test('finds tool result marker as highest priority', () => {
    const content = 'Some text\n  ↳ ✓\nMore text\n## Heading';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('tool_marker');
    expect(result?.position).toBe(content.indexOf('  ↳ ✓') + '  ↳ ✓\n'.length);
  });

  test('finds tool error marker', () => {
    const content = 'Some text\n  ↳ ❌ Error\nMore text';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('tool_marker');
  });

  test('finds heading as second priority', () => {
    const content = 'Some text without tool markers\n## New Section\nContent';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('heading');
    // Should break BEFORE the heading
    expect(result?.position).toBe(content.indexOf('\n## New Section'));
  });

  test('finds h3 headings', () => {
    const content = 'Some text\n### Subsection\nContent';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('heading');
  });

  test('finds code block end as third priority', () => {
    const content = 'Some text\n```typescript\ncode\n```\nMore text';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('code_block_end');
    expect(result?.position).toBe(content.indexOf('```\n') + 4);
  });

  test('finds paragraph break as fourth priority', () => {
    const content = 'Some text without other markers.\n\nNew paragraph starts here.';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('paragraph');
  });

  test('falls back to line break', () => {
    const content = 'First line\nSecond line continues without other markers';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('none');
    expect(result?.position).toBe(content.indexOf('\n') + 1);
  });

  test('returns null for content without breaks', () => {
    const content = 'Single line of content with no breaks at all';
    const result = findLogicalBreakpoint(content, 0);
    expect(result).toBeNull();
  });

  test('respects startPos parameter', () => {
    const content = '  ↳ ✓\nEarly marker\n## Later heading';
    // Start after the tool marker
    const result = findLogicalBreakpoint(content, 15);
    expect(result?.type).toBe('heading');
  });

  test('respects maxLookAhead parameter', () => {
    const content = 'Short window\n' + 'X'.repeat(600) + '\n## Far heading';
    // Only look 50 chars ahead - won't find the heading
    const result = findLogicalBreakpoint(content, 0, 50);
    expect(result?.type).toBe('none'); // Falls back to line break
  });
});

describe('shouldFlushEarly', () => {
  test('returns true when content exceeds soft threshold', () => {
    const longContent = 'X'.repeat(SOFT_BREAK_THRESHOLD + 1);
    expect(shouldFlushEarly(longContent)).toBe(true);
  });

  test('returns false when content is under threshold', () => {
    const shortContent = 'Short content';
    expect(shouldFlushEarly(shortContent)).toBe(false);
  });

  test('returns true when line count exceeds threshold', () => {
    const manyLines = Array(MAX_LINES_BEFORE_BREAK + 1).fill('Line').join('\n');
    expect(shouldFlushEarly(manyLines)).toBe(true);
  });

  test('returns false for few lines under character threshold', () => {
    const fewLines = 'Line1\nLine2\nLine3';
    expect(shouldFlushEarly(fewLines)).toBe(false);
  });
});

describe('endsAtBreakpoint', () => {
  test('detects tool marker at end', () => {
    expect(endsAtBreakpoint('Some output\n  ↳ ✓')).toBe('tool_marker');
    expect(endsAtBreakpoint('Some output\n  ↳ ✓  ')).toBe('tool_marker'); // with trailing whitespace
  });

  test('detects tool error at end', () => {
    expect(endsAtBreakpoint('Output\n  ↳ ❌ Error occurred')).toBe('tool_marker');
  });

  test('detects code block end', () => {
    expect(endsAtBreakpoint('```typescript\ncode\n```')).toBe('code_block_end');
  });

  test('detects paragraph break at end', () => {
    expect(endsAtBreakpoint('Some text\n\n')).toBe('paragraph');
  });

  test('returns none for regular content', () => {
    expect(endsAtBreakpoint('Just regular text')).toBe('none');
    expect(endsAtBreakpoint('Text ending with newline\n')).toBe('none');
  });
});

describe('flush with smart breaking', () => {
  let platform: PlatformClient & { posts: Map<string, string> };
  let session: Session;
  let registerPost: ReturnType<typeof mock>;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    registerPost = mock((_postId: string, _threadId: string) => {});
  });

  test('breaks at logical breakpoint when exceeding soft threshold', async () => {
    // Create content that exceeds soft threshold with a logical breakpoint
    const firstPart = 'X'.repeat(SOFT_BREAK_THRESHOLD);
    const content = firstPart + '\n  ↳ ✓\nRemaining content after tool result';

    session.currentPostId = 'existing_post';
    session.pendingContent = content;

    await flush(session, registerPost);

    // Should have updated existing post with first part
    expect(platform.updatePost).toHaveBeenCalled();

    // Should have created continuation post
    expect(platform.createPost).toHaveBeenCalled();
  });

  test('does not break when under minimum threshold', async () => {
    // Short content - should not break even with breakpoints
    const content = 'Short\n  ↳ ✓\nMore';

    session.currentPostId = 'existing_post';
    session.pendingContent = content;

    await flush(session, registerPost);

    // Should just update the existing post
    expect(platform.updatePost).toHaveBeenCalledWith('existing_post', content);
    expect(platform.createPost).not.toHaveBeenCalled();
  });

  test('adds continuation marker when breaking', async () => {
    const longContent = 'X'.repeat(SOFT_BREAK_THRESHOLD) + '\n  ↳ ✓\nMore content';

    session.currentPostId = 'existing_post';
    session.pendingContent = longContent;

    await flush(session, registerPost);

    // First call to updatePost should include continuation marker
    const firstCallArgs = (platform.updatePost as ReturnType<typeof mock>).mock.calls[0];
    expect(firstCallArgs[1]).toContain('*... (continued below)*');
  });
});

describe('threshold constants', () => {
  test('SOFT_BREAK_THRESHOLD is reasonable', () => {
    expect(SOFT_BREAK_THRESHOLD).toBeGreaterThan(1000);
    expect(SOFT_BREAK_THRESHOLD).toBeLessThan(5000);
  });

  test('MIN_BREAK_THRESHOLD is reasonable', () => {
    expect(MIN_BREAK_THRESHOLD).toBeGreaterThan(100);
    expect(MIN_BREAK_THRESHOLD).toBeLessThan(SOFT_BREAK_THRESHOLD);
  });

  test('MAX_LINES_BEFORE_BREAK is reasonable', () => {
    expect(MAX_LINES_BEFORE_BREAK).toBeGreaterThan(5); // More than Mattermost's 5
    expect(MAX_LINES_BEFORE_BREAK).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// Code block state detection tests
// ---------------------------------------------------------------------------

describe('getCodeBlockState', () => {
  test('detects when inside a code block', () => {
    const content = 'Some text\n```typescript\nconst x = 1;\n';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(true);
    expect(result.language).toBe('typescript');
  });

  test('detects when outside a closed code block', () => {
    const content = 'Some text\n```typescript\nconst x = 1;\n```\nMore text';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(false);
  });

  test('detects when inside a diff block', () => {
    const content = 'Edit file.ts\n```diff\n- old line\n+ new line\n';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(true);
    expect(result.language).toBe('diff');
  });

  test('detects code block without language', () => {
    const content = 'Some text\n```\ncode here\n';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(true);
    // Language is undefined when no language is specified
    expect(result.language).toBeUndefined();
  });

  test('tracks position of opening marker', () => {
    const content = 'Prefix\n```typescript\ncode';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(true);
    expect(result.openPosition).toBe(content.indexOf('```typescript'));
  });

  test('handles multiple code blocks correctly', () => {
    const content = '```js\ncode1\n```\ntext\n```python\ncode2';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(true);
    expect(result.language).toBe('python');
  });

  test('handles position in middle of content', () => {
    const content = '```js\ncode\n```\nmore\n```diff\nchanges\n```';
    // Check at position after first code block
    const pos = content.indexOf('more');
    const result = getCodeBlockState(content, pos);
    expect(result.isInside).toBe(false);
  });

  test('returns false for content without code blocks', () => {
    const content = 'Just regular text without any code blocks';
    const result = getCodeBlockState(content, content.length);
    expect(result.isInside).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findLogicalBreakpoint with code block awareness tests
// ---------------------------------------------------------------------------

describe('findLogicalBreakpoint with code blocks', () => {
  test('returns null when inside code block without closing in window', () => {
    // Content where we're inside a code block and the closing is beyond the search window
    const longCode = 'x'.repeat(600);
    const longContent = `Text\n\`\`\`diff\n${longCode}\n\`\`\`\nafter`;

    // Search from position 20 (inside the diff block) with 100 char lookahead
    // The closing ``` is beyond the 100 char window
    const result = findLogicalBreakpoint(longContent, 20, 100);
    // Should return null because we can't find closing in the 100 char window
    expect(result).toBeNull();
  });

  test('finds code block end when inside block and closing is within window', () => {
    const content = 'Text\n```diff\n- old\n+ new\n```\nMore text after';
    // Start searching from inside the diff block
    const result = findLogicalBreakpoint(content, 15);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('code_block_end');
    // Should break after the closing ```
    expect(result?.position).toBeGreaterThan(content.indexOf('```\n'));
  });

  test('does not suggest break inside code block for paragraph markers', () => {
    const content = '```typescript\ncode\n\nmore code\n```';
    // The \n\n inside the code block should NOT be a valid break point
    const result = findLogicalBreakpoint(content, 0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('code_block_end');
    // Position should be after the closing ```
    expect(result?.position).toBe(content.length);
  });

  test('prefers code block end over other markers inside the block', () => {
    // Content with a "heading" pattern inside a code block
    const content = '```markdown\n## Heading inside block\n```\noutside';
    const result = findLogicalBreakpoint(content, 0);
    expect(result?.type).toBe('code_block_end');
  });
});
