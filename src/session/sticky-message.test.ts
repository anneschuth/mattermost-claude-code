import { describe, it, expect, mock } from 'bun:test';
import { buildStickyMessage, StickyMessageConfig, getPendingPrompts, formatPendingPrompts } from './sticky-message.js';
import type { Session } from './types.js';
import type { PlatformClient } from '../platform/index.js';

// Default test config
const testConfig: StickyMessageConfig = {
  maxSessions: 5,
  chromeEnabled: false,
  skipPermissions: false,
  worktreeMode: 'prompt',
  workingDir: '/home/user/projects',
  debug: false,
};

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
    statusBarTimer: null,
    ...overrides,
  } as Session;
}

describe('buildStickyMessage', () => {
  it('shows no active sessions message when empty', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('Active Claude Threads');
    expect(result).toContain('No active sessions');
    expect(result).toContain('Mention me to start a session');
    expect(result).toContain('npm i -g claude-threads');
  });

  it('shows status bar with version and session count', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    // Should contain version (with optional CLI version appended)
    expect(result).toMatch(/`v\d+\.\d+\.\d+( · CLI \d+\.\d+\.\d+)?`/);
    // Should contain session count
    expect(result).toContain('`0/5 sessions`');
    // Should contain uptime
    expect(result).toMatch(/`⏱️ <?\d+[mhd]`/);
  });

  it('shows Chrome status when enabled', async () => {
    const sessions = new Map<string, Session>();
    const chromeConfig = { ...testConfig, chromeEnabled: true };
    const result = await buildStickyMessage(sessions, 'test-platform', chromeConfig);

    expect(result).toContain('`🌐 Chrome`');
  });

  it('hides Chrome status when disabled', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).not.toContain('Chrome');
  });

  it('shows Interactive permission mode by default', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('`🔐 Interactive`');
  });

  it('shows Auto permission mode when skipPermissions is true', async () => {
    const sessions = new Map<string, Session>();
    const autoConfig = { ...testConfig, skipPermissions: true };
    const result = await buildStickyMessage(sessions, 'test-platform', autoConfig);

    expect(result).toContain('`⚡ Auto`');
  });

  it('shows worktree mode when not default prompt', async () => {
    const sessions = new Map<string, Session>();
    const requireConfig = { ...testConfig, worktreeMode: 'require' as const };
    const result = await buildStickyMessage(sessions, 'test-platform', requireConfig);

    expect(result).toContain('`🌿 Worktree: require`');
  });

  it('hides worktree mode when set to prompt (default)', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).not.toContain('Worktree');
  });

  it('shows debug mode when enabled', async () => {
    const sessions = new Map<string, Session>();
    const debugConfig = { ...testConfig, debug: true };
    const result = await buildStickyMessage(sessions, 'test-platform', debugConfig);

    expect(result).toContain('`🐛 Debug`');
  });

  it('shows working directory', async () => {
    const sessions = new Map<string, Session>();
    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('`📂 /home/user/projects`');
  });

  it('shows active sessions in card-style list', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '@botname Help me debug this function',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('Active Claude Threads');
    expect(result).toContain('(1)');
    expect(result).toContain('▸');
    expect(result).toContain('testuser');
    expect(result).not.toContain('@testuser'); // No @ prefix
    expect(result).toContain('Help me debug this function');
    // Status bar should show 1/5 sessions
    expect(result).toContain('`1/5 sessions`');
  });

  it('truncates long prompts', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: 'This is a very long prompt that should be truncated because it exceeds the maximum length allowed for display in the sticky message table',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('…');
    expect(result.length).toBeLessThan(1000);
  });

  it('removes @mentions from topic', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '@claude-bot @other-user Help me with this',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).not.toContain('@claude-bot');
    expect(result).toContain('Help me with this');
  });

  it('filters sessions by platform', async () => {
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

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('(1)');
    expect(result).toContain('Session 1');
    expect(result).not.toContain('Session 2');
  });

  it('sorts sessions by start time (newest first)', async () => {
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

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('(2)');
    // Newer session should appear first in the list
    const newerIndex = result.indexOf('Newer session');
    const olderIndex = result.indexOf('Older session');
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  it('shows task progress when available', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (3/7 · 43%)\n✅ Done\n○ Pending',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('3/7');
  });

  it('does not show task progress when no tasks', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: null,
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    // Should not have double dots from missing progress
    expect(result).not.toMatch(/· ·/);
  });

  it('shows active task when in progress', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (2/5 · 40%)\n\n✅ ~~First task~~\n✅ ~~Second task~~\n🔄 **Building the API** (15s)\n○ Fourth task\n○ Fifth task',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('2/5');
    expect(result).toContain('🔄 _Building the API_');
  });

  it('shows active task without elapsed time', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (1/3 · 33%)\n\n✅ ~~Done~~\n🔄 **Running tests**\n○ Deploy',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('1/3');
    expect(result).toContain('🔄 _Running tests_');
  });

  it('does not show active task when all completed', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (3/3 · 100%)\n\n✅ ~~First~~\n✅ ~~Second~~\n✅ ~~Third~~',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('3/3');
    expect(result).not.toContain('🔄');
  });

  it('does not show active task when only pending tasks', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (0/2 · 0%)\n\n○ First task\n○ Second task',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('0/2');
    expect(result).not.toContain('🔄');
  });

  it('handles session without firstPrompt', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: undefined,
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('No topic');
  });

  it('shows "No topic" for bot commands like !worktree', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '!worktree switch sticky-channel-message',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('No topic');
    expect(result).not.toContain('!worktree');
  });

  it('shows "No topic" for !cd commands', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '@botname !cd /some/path',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('No topic');
    expect(result).not.toContain('!cd');
  });

  it('uses sessionTitle when available instead of firstPrompt', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      firstPrompt: '!worktree switch sticky-channel-message',
      sessionTitle: 'Improve sticky message feature',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('Improve sticky message feature');
    expect(result).not.toContain('No topic');
    expect(result).not.toContain('!worktree');
  });

  it('shows pending plan approval', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('⏳');
    expect(result).toContain('📋 Plan approval');
  });

  it('shows pending question with progress', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingQuestionSet: {
        toolUseId: 'tool1',
        currentIndex: 1,
        currentPostId: 'post1',
        questions: [
          { header: 'Q1', question: 'Question 1', options: [], answer: 'yes' },
          { header: 'Q2', question: 'Question 2', options: [], answer: null },
          { header: 'Q3', question: 'Question 3', options: [], answer: null },
        ],
      },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('⏳');
    expect(result).toContain('❓ Question 2/3');
  });

  it('shows pending message approval', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingMessageApproval: { postId: 'post1', originalMessage: 'Hello', fromUser: 'alice' },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('⏳');
    expect(result).toContain('💬 Message approval');
  });

  it('shows pending worktree prompt', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingWorktreePrompt: true,
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('⏳');
    expect(result).toContain('🌿 Branch name');
  });

  it('shows pending existing worktree prompt', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingExistingWorktreePrompt: {
        postId: 'post1',
        branch: 'feature-branch',
        worktreePath: '/path/to/worktree',
        username: 'alice',
      },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('⏳');
    expect(result).toContain('🌿 Join worktree');
  });

  it('shows pending context prompt', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingContextPrompt: {
        postId: 'post1',
        queuedPrompt: 'Help me',
        threadMessageCount: 10,
        createdAt: Date.now(),
        availableOptions: [3, 5, 10],
      },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('⏳');
    expect(result).toContain('📝 Context selection');
  });

  it('shows multiple pending prompts', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
      pendingMessageApproval: { postId: 'post2', originalMessage: 'Hello', fromUser: 'alice' },
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('⏳');
    expect(result).toContain('📋 Plan approval');
    expect(result).toContain('💬 Message approval');
    expect(result).toContain('·'); // Multiple prompts separated by ·
  });

  it('hides active task when pending prompts are shown', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
      lastTasksContent: '📋 **Tasks** (2/5 · 40%)\n\n🔄 **Running tests** (15s)',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    // Should show pending prompt
    expect(result).toContain('📋 Plan approval');
    // Should NOT show active task (pending prompts take priority)
    expect(result).not.toContain('🔄 _Running tests_');
  });

  it('shows active task when no pending prompts', async () => {
    const sessions = new Map<string, Session>();
    const session = createMockSession({
      lastTasksContent: '📋 **Tasks** (2/5 · 40%)\n\n🔄 **Running tests** (15s)',
    });
    sessions.set(session.sessionId, session);

    const result = await buildStickyMessage(sessions, 'test-platform', testConfig);

    expect(result).toContain('🔄 _Running tests_');
    expect(result).not.toContain('⏳');
  });
});

describe('getPendingPrompts', () => {
  it('returns empty array when no pending prompts', () => {
    const session = createMockSession();
    const prompts = getPendingPrompts(session);
    expect(prompts).toEqual([]);
  });

  it('returns plan approval prompt', () => {
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'plan', label: 'Plan approval', emoji: '📋' });
  });

  it('ignores action type approval (only plan)', () => {
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'action', toolUseId: 'tool1' },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toEqual([]);
  });

  it('returns question prompt with progress', () => {
    const session = createMockSession({
      pendingQuestionSet: {
        toolUseId: 'tool1',
        currentIndex: 2,
        currentPostId: 'post1',
        questions: [
          { header: 'Q1', question: 'Q1', options: [], answer: 'yes' },
          { header: 'Q2', question: 'Q2', options: [], answer: 'no' },
          { header: 'Q3', question: 'Q3', options: [], answer: null },
          { header: 'Q4', question: 'Q4', options: [], answer: null },
        ],
      },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'question', label: 'Question 3/4', emoji: '❓' });
  });

  it('returns message approval prompt', () => {
    const session = createMockSession({
      pendingMessageApproval: { postId: 'post1', originalMessage: 'Hello', fromUser: 'alice' },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'message_approval', label: 'Message approval', emoji: '💬' });
  });

  it('returns worktree prompt', () => {
    const session = createMockSession({
      pendingWorktreePrompt: true,
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'worktree', label: 'Branch name', emoji: '🌿' });
  });

  it('returns existing worktree prompt', () => {
    const session = createMockSession({
      pendingExistingWorktreePrompt: {
        postId: 'post1',
        branch: 'feature-branch',
        worktreePath: '/path/to/worktree',
        username: 'alice',
      },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'existing_worktree', label: 'Join worktree', emoji: '🌿' });
  });

  it('returns context prompt', () => {
    const session = createMockSession({
      pendingContextPrompt: {
        postId: 'post1',
        queuedPrompt: 'Help me',
        threadMessageCount: 10,
        createdAt: Date.now(),
        availableOptions: [3, 5, 10],
      },
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: 'context', label: 'Context selection', emoji: '📝' });
  });

  it('returns multiple prompts in order', () => {
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
      pendingMessageApproval: { postId: 'post2', originalMessage: 'Hello', fromUser: 'alice' },
      pendingWorktreePrompt: true,
    });
    const prompts = getPendingPrompts(session);
    expect(prompts).toHaveLength(3);
    expect(prompts[0].type).toBe('plan');
    expect(prompts[1].type).toBe('message_approval');
    expect(prompts[2].type).toBe('worktree');
  });
});

describe('formatPendingPrompts', () => {
  it('returns null when no pending prompts', () => {
    const session = createMockSession();
    const result = formatPendingPrompts(session);
    expect(result).toBeNull();
  });

  it('formats single prompt', () => {
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
    });
    const result = formatPendingPrompts(session);
    expect(result).toBe('⏳ 📋 Plan approval');
  });

  it('formats multiple prompts with separator', () => {
    const session = createMockSession({
      pendingApproval: { postId: 'post1', type: 'plan', toolUseId: 'tool1' },
      pendingMessageApproval: { postId: 'post2', originalMessage: 'Hello', fromUser: 'alice' },
    });
    const result = formatPendingPrompts(session);
    expect(result).toBe('⏳ 📋 Plan approval · 💬 Message approval');
  });
});
