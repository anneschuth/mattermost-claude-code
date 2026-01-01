import { describe, it, expect, mock } from 'bun:test';
import { buildStickyMessage } from './sticky-message.js';
import type { Session } from './types.js';
import type { PlatformClient } from '../platform/index.js';

// Create a mock platform client
function createMockPlatform(platformId: string): PlatformClient {
  return {
    platformId,
    platformType: 'mattermost',
    displayName: 'Test Platform',
    isUserAllowed: mock(() => true),
    getBotUser: mock(),
    getUser: mock(),
    createPost: mock(),
    updatePost: mock(),
    deletePost: mock(),
    addReaction: mock(),
    createInteractivePost: mock(),
    getPost: mock(),
    getThreadHistory: mock(),
    downloadFile: mock(),
    getFileInfo: mock(),
    getFormatter: mock(),
    connect: mock(),
    disconnect: mock(),
    on: mock(),
    off: mock(),
    emit: mock(),
  } as unknown as PlatformClient;
}

// Create a mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
  const platform = createMockPlatform('test-platform');
  return {
    platformId: 'test-platform',
    threadId: 'thread123',
    sessionId: 'test-platform:thread123',
    claudeSessionId: 'claude-session-id',
    startedBy: 'testuser',
    startedAt: new Date('2024-01-15T10:00:00Z'),
    lastActivityAt: new Date('2024-01-15T10:05:00Z'),
    sessionNumber: 1,
    platform,
    workingDir: '/home/user/projects/myproject',
    claude: { isRunning: () => true, kill: mock(), sendMessage: mock() } as any,
    currentPostId: null,
    pendingContent: '',
    pendingApproval: null,
    pendingQuestionSet: null,
    pendingMessageApproval: null,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: null,
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
    firstPrompt: 'Help me with this task',
    ...overrides,
  } as Session;
}

describe('buildStickyMessage', () => {
  it('shows no active sessions message when empty', () => {
    const sessions = new Map<string, Session>();
    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).toContain('Active Claude Threads');
    expect(result).toContain('No active sessions');
    expect(result).toContain('Mention me to start a session');
    expect(result).toContain('npm i -g claude-threads');
  });

  it('shows active sessions in card-style list', () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '@botname Help me debug this function',
    });
    sessions.set(session.sessionId, session);

    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).toContain('Active Claude Threads');
    expect(result).toContain('(1)');
    expect(result).toContain('▸');
    expect(result).toContain('testuser');
    expect(result).not.toContain('@testuser'); // No @ prefix
    expect(result).toContain('Help me debug this function');
  });

  it('truncates long prompts', () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: 'This is a very long prompt that should be truncated because it exceeds the maximum length allowed for display in the sticky message table',
    });
    sessions.set(session.sessionId, session);

    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).toContain('…');
    expect(result.length).toBeLessThan(1000);
  });

  it('removes @mentions from topic', () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '@claude-bot @other-user Help me with this',
    });
    sessions.set(session.sessionId, session);

    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).not.toContain('@claude-bot');
    expect(result).toContain('Help me with this');
  });

  it('filters sessions by platform', () => {
    const sessions = new Map<string, Session>();

    // Session for test-platform
    const session1 = createMockSession({
      platformId: 'test-platform',
      sessionId: 'test-platform:thread1',
      firstPrompt: 'Session 1',
    });
    sessions.set(session1.sessionId, session1);

    // Session for other-platform
    const session2 = createMockSession({
      platformId: 'other-platform',
      sessionId: 'other-platform:thread2',
      firstPrompt: 'Session 2',
    });
    sessions.set(session2.sessionId, session2);

    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).toContain('(1)');
    expect(result).toContain('Session 1');
    expect(result).not.toContain('Session 2');
  });

  it('sorts sessions by start time (newest first)', () => {
    const sessions = new Map<string, Session>();

    const session1 = createMockSession({
      sessionId: 'test-platform:thread1',
      startedAt: new Date('2024-01-15T10:00:00Z'),
      firstPrompt: 'Older session',
    });
    sessions.set(session1.sessionId, session1);

    const session2 = createMockSession({
      sessionId: 'test-platform:thread2',
      startedAt: new Date('2024-01-15T12:00:00Z'),
      firstPrompt: 'Newer session',
    });
    sessions.set(session2.sessionId, session2);

    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).toContain('(2)');
    // Newer session should appear first in the list
    const newerIndex = result.indexOf('Newer session');
    const olderIndex = result.indexOf('Older session');
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  it('shows task progress when available', () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (3/7 · 43%)\n✅ Done\n○ Pending',
    });
    sessions.set(session.sessionId, session);

    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).toContain('3/7');
  });

  it('does not show task progress when no tasks', () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: null,
    });
    sessions.set(session.sessionId, session);

    const result = buildStickyMessage(sessions, 'test-platform');

    // Should not have double dots from missing progress
    expect(result).not.toMatch(/· ·/);
  });

  it('handles session without firstPrompt', () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: undefined,
    });
    sessions.set(session.sessionId, session);

    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).toContain('No topic');
  });

  it('shows "No topic" for bot commands like !worktree', () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '!worktree switch sticky-channel-message',
    });
    sessions.set(session.sessionId, session);

    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).toContain('No topic');
    expect(result).not.toContain('!worktree');
  });

  it('shows "No topic" for !cd commands', () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '@botname !cd /some/path',
    });
    sessions.set(session.sessionId, session);

    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).toContain('No topic');
    expect(result).not.toContain('!cd');
  });

  it('uses sessionTitle when available instead of firstPrompt', () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '!worktree switch sticky-channel-message',
      sessionTitle: 'Improve sticky message feature',
    });
    sessions.set(session.sessionId, session);

    const result = buildStickyMessage(sessions, 'test-platform');

    expect(result).toContain('Improve sticky message feature');
    expect(result).not.toContain('No topic');
    expect(result).not.toContain('!worktree');
  });
});
