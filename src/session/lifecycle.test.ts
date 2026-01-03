import { describe, it, expect, mock } from 'bun:test';
import * as lifecycle from './lifecycle.js';
import type { SessionContext } from './context.js';
import type { Session } from './types.js';
import type { PlatformClient } from '../platform/index.js';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a mock platform client for testing
 */
function createMockPlatform(overrides?: Partial<PlatformClient>): PlatformClient {
  return {
    platformId: 'test-platform',
    createPost: mock(() => Promise.resolve({ id: 'post-1', message: '', userId: 'bot' })),
    updatePost: mock(() => Promise.resolve({ id: 'post-1', message: '', userId: 'bot' })),
    deletePost: mock(() => Promise.resolve()),
    addReaction: mock(() => Promise.resolve()),
    removeReaction: mock(() => Promise.resolve()),
    getBotUser: mock(() => Promise.resolve({ id: 'bot', username: 'testbot' })),
    getUser: mock(() => Promise.resolve({ id: 'user-1', username: 'testuser' })),
    isUserAllowed: mock(() => true),
    connect: mock(() => Promise.resolve()),
    disconnect: mock(() => Promise.resolve()),
    onMessage: mock(() => {}),
    onReaction: mock(() => {}),
    getMcpConfig: mock(() => ({})),
    createInteractivePost: mock(() => Promise.resolve({ id: 'post-1', message: '', userId: 'bot' })),
    getChannelId: mock(() => 'channel-1'),
    getThreadHistory: mock(() => Promise.resolve([])),
    pinPost: mock(() => Promise.resolve()),
    unpinPost: mock(() => Promise.resolve()),
    getPinnedPosts: mock(() => Promise.resolve([])),
    getPost: mock(() => Promise.resolve(null)),
    ...overrides,
  } as unknown as PlatformClient;
}

/**
 * Create a mock session for testing
 */
function createMockSession(overrides?: Partial<Session>): Session {
  return {
    sessionId: 'test-platform:thread-123',
    threadId: 'thread-123',
    platform: createMockPlatform(),
    claude: {
      isRunning: mock(() => true),
      kill: mock(() => {}),
      start: mock(() => {}),
      sendMessage: mock(() => {}),
      on: mock(() => {}),
      interrupt: mock(() => {}),
    } as any,
    claudeSessionId: 'claude-session-1',
    owner: 'testuser',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    buffer: '',
    taskListPostId: null,
    taskListBuffer: '',
    sessionAllowedUsers: new Set(['testuser']),
    workingDir: '/test',
    activeSubagents: new Map(),
    isResumed: false,
    sessionStartPostId: 'start-post-id',
    pendingContent: '',
    timeoutWarningPosted: false,
    tasksCompleted: false,
    tasksMinimized: false,
    lastTasksContent: '',
    tasksPostId: null,
    skipPermissions: true,
    forceInteractivePermissions: false,
    ...overrides,
  } as Session;
}

/**
 * Create a mock session context
 */
function createMockSessionContext(sessions: Map<string, Session> = new Map()): SessionContext {
  return {
    config: {
      workingDir: '/test',
      skipPermissions: true,
      chromeEnabled: false,
      debug: false,
      maxSessions: 5,
    },
    state: {
      sessions,
      postIndex: new Map(),
      platforms: new Map([['test-platform', createMockPlatform()]]),
      sessionStore: {
        save: mock(() => {}),
        remove: mock(() => {}),
        getAll: mock(() => []),
        get: mock(() => null),
        cleanStale: mock(() => []),
        saveStickyPostId: mock(() => {}),
        getStickyPostId: mock(() => null),
        load: mock(() => new Map()),
        findByPostId: mock(() => undefined),
      } as any,
      isShuttingDown: false,
    },
    ops: {
      getSessionId: mock((platformId, threadId) => `${platformId}:${threadId}`),
      findSessionByThreadId: mock((threadId) => sessions.get(`test-platform:${threadId}`)),
      registerPost: mock(() => {}),
      handleEvent: mock(() => {}),
      handleExit: mock(() => Promise.resolve()),
      startTyping: mock(() => {}),
      stopTyping: mock(() => {}),
      flush: mock(() => Promise.resolve()),
      appendContent: mock(() => {}),
      updateStickyMessage: mock(() => Promise.resolve()),
      updateSessionHeader: mock(() => Promise.resolve()),
      persistSession: mock(() => {}),
      unpersistSession: mock(() => {}),
      shouldPromptForWorktree: mock(() => Promise.resolve(null)),
      postWorktreePrompt: mock(() => Promise.resolve()),
      buildMessageContent: mock((prompt) => Promise.resolve(prompt)),
      offerContextPrompt: mock(() => Promise.resolve(false)),
      bumpTasksToBottom: mock(() => Promise.resolve()),
      killSession: mock(() => Promise.resolve()),
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Lifecycle Module', () => {
  describe('killSession', () => {
    it('kills the Claude CLI and removes session', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, true, ctx);

      expect(session.claude.kill).toHaveBeenCalled();
      expect(sessions.has('test-platform:thread-123')).toBe(false);
    });

    it('unpersists when requested', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, true, ctx);

      expect(ctx.ops.unpersistSession).toHaveBeenCalledWith('test-platform:thread-123');
    });

    it('preserves persistence when not unpersisting', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, false, ctx);

      expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
    });

    it('updates sticky message after killing', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, true, ctx);

      expect(ctx.ops.updateStickyMessage).toHaveBeenCalled();
    });

    it('stops typing indicator', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, true, ctx);

      expect(ctx.ops.stopTyping).toHaveBeenCalledWith(session);
    });
  });

  describe('killAllSessions', () => {
    it('kills all active sessions', () => {
      const session1 = createMockSession({ sessionId: 'p:t1', threadId: 't1' });
      const session2 = createMockSession({ sessionId: 'p:t2', threadId: 't2' });
      const sessions = new Map([
        ['p:t1', session1],
        ['p:t2', session2],
      ]);
      const ctx = createMockSessionContext(sessions);

      lifecycle.killAllSessions(ctx);

      expect(session1.claude.kill).toHaveBeenCalled();
      expect(session2.claude.kill).toHaveBeenCalled();
      expect(sessions.size).toBe(0);
    });

    it('preserves sessions in store for resume', () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      lifecycle.killAllSessions(ctx);

      // killAllSessions preserves state for resume, so remove should NOT be called
      expect(ctx.state.sessionStore.remove).not.toHaveBeenCalled();
    });
  });

  describe('cleanupIdleSessions', () => {
    it('does not cleanup active sessions', async () => {
      const session = createMockSession({
        lastActivityAt: new Date(), // Just now
      });
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.cleanupIdleSessions(
        30 * 60 * 1000, // 30 min timeout
        5 * 60 * 1000,  // 5 min warning
        ctx
      );

      expect(sessions.has('test-platform:thread-123')).toBe(true);
      expect(session.claude.kill).not.toHaveBeenCalled();
    });

    it('posts timeout warning before killing', async () => {
      const session = createMockSession({
        lastActivityAt: new Date(Date.now() - 26 * 60 * 1000), // 26 min ago
        timeoutWarningPosted: false,
      });
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.cleanupIdleSessions(
        30 * 60 * 1000, // 30 min timeout
        5 * 60 * 1000,  // 5 min warning
        ctx
      );

      // Should post warning but not kill yet
      expect(session.timeoutWarningPosted).toBe(true);
      expect(sessions.has('test-platform:thread-123')).toBe(true);
    });
  });
});

describe('Session State Management', () => {
  it('tracks active subagents', () => {
    const session = createMockSession();

    expect(session.activeSubagents.size).toBe(0);

    session.activeSubagents.set('tool-1', 'post-1');
    session.activeSubagents.set('tool-2', 'post-2');

    expect(session.activeSubagents.size).toBe(2);
    expect(session.activeSubagents.get('tool-1')).toBe('post-1');
  });

  it('tracks session allowed users', () => {
    const session = createMockSession();

    expect(session.sessionAllowedUsers.has('testuser')).toBe(true);
    expect(session.sessionAllowedUsers.has('otheruser')).toBe(false);

    session.sessionAllowedUsers.add('otheruser');
    expect(session.sessionAllowedUsers.has('otheruser')).toBe(true);
  });

  it('tracks pending content buffer', () => {
    const session = createMockSession();

    session.pendingContent = '';
    session.pendingContent += 'Hello ';
    session.pendingContent += 'World';

    expect(session.pendingContent).toBe('Hello World');
  });
});
