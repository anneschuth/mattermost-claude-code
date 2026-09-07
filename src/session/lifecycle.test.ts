import { createMockSessionContext as createSharedMockSessionContext } from '../test-utils/mock-session-context.js';
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as lifecycle from './lifecycle.js';
import * as metadataSuggestions from './metadata-suggestions.js';
import { offerContextPrompt as offerContextPromptReal } from '../operations/context-prompt/handler.js';
import type { Session } from './types.js';
import { createSessionTimers, createSessionLifecycle, createResumedLifecycle } from './types.js';
import type { PlatformClient } from '../platform/index.js';
import { createMockFormatter } from '../test-utils/mock-formatter.js';
import { configureAuditLog, _resetAuditLog } from '../persistence/audit-log.js';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a mock platform client for testing
 */
function createMockPlatform(overrides?: Partial<PlatformClient>): PlatformClient {
  return {
    platformId: 'test-platform',
    platformType: 'mattermost',
    displayName: 'Test Platform',
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
    getFormatter: mock(() => createMockFormatter()),
    sendTyping: mock(() => Promise.resolve()),
    getThreadLink: mock(() => 'https://example.test/thread'),
    ...overrides,
  } as unknown as PlatformClient;
}

const createMockSessionContext = (sessions: Map<string, Session> = new Map()) =>
  createSharedMockSessionContext(createMockPlatform, sessions);

/**
 * Create a mock message manager for testing
 */
function createMockMessageManager() {
  return {
    clearClaudeSessionState: mock(() => {}),
    closeCurrentPost: mock(() => Promise.resolve()),
    handleEvent: mock(() => Promise.resolve()),
    flush: mock(() => Promise.resolve()),
    prepareForUserMessage: mock(() => Promise.resolve()),
    handleUserMessage: mock(() => Promise.resolve(true)),
    getCurrentPostId: mock(() => null),
    getCurrentPostContent: mock(() => ''),
    hasPendingQuestions: mock(() => false),
    hasPendingApproval: mock(() => false),
    getPendingApproval: mock(() => null),
    getPendingQuestionSet: mock(() => null),
    clearPendingApproval: mock(() => {}),
    clearPendingQuestionSet: mock(() => {}),
    advanceQuestionIndex: mock(() => {}),
    handleQuestionAnswer: mock(() => Promise.resolve(false)),
    handleApprovalResponse: mock(() => Promise.resolve(false)),
    handleSubagentToggle: mock(() => Promise.resolve(false)),
    handleTaskListToggle: mock(() => Promise.resolve(false)),
    bumpTaskList: mock(() => Promise.resolve()),
    getTaskListState: mock(() => ({ postId: null, content: null, isMinimized: false, isCompleted: false })),
    hydrateTaskListState: mock(() => {}),
    setWorktreeInfo: mock(() => {}),
    clearWorktreeInfo: mock(() => {}),
    postInfo: mock(() => Promise.resolve(undefined)),
    postWarning: mock(() => Promise.resolve(undefined)),
    postError: mock(() => Promise.resolve(undefined)),
    postSuccess: mock(() => Promise.resolve(undefined)),
    reset: mock(() => {}),
    dispose: mock(() => {}),
  };
}

/**
 * Create a mock session for testing
 */
function createMockSession(overrides?: Partial<Session> & {
  // Legacy flag aliases for backward compatibility in tests
  isRestarting?: boolean;
  isCancelled?: boolean;
  isResumed?: boolean;
  wasInterrupted?: boolean;
  hasClaudeResponded?: boolean;
}): Session {
  // Build lifecycle state from overrides or defaults
  let lifecycle = createSessionLifecycle();
  if (overrides?.isResumed) {
    lifecycle = createResumedLifecycle();
  }
  if (overrides?.isRestarting) {
    lifecycle.state = 'restarting';
  }
  if (overrides?.isCancelled) {
    lifecycle.state = 'cancelling';
  }
  if (overrides?.wasInterrupted) {
    lifecycle.state = 'interrupted';
  }
  if (overrides?.hasClaudeResponded) {
    lifecycle.hasClaudeResponded = true;
  }
  // Allow direct lifecycle override
  if (overrides?.lifecycle) {
    lifecycle = overrides.lifecycle;
  }

  return {
    sessionId: 'test-platform:thread-123',
    threadId: 'thread-123',
    platform: createMockPlatform(),
    claude: {
      isRunning: mock(() => true),
      kill: mock(() => Promise.resolve()),
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
    timers: createSessionTimers(),
    lifecycle,
    sessionStartPostId: 'start-post-id',
    timeoutWarningPosted: false,
    tasksCompleted: false,
    tasksMinimized: false,
    lastTasksContent: '',
    tasksPostId: null,
    skipPermissions: true,
    forceInteractivePermissions: false,
    respondOnlyWhenMentioned: false,
    userAttribution: false,
    messageManager: createMockMessageManager() as any,
    ...overrides,
  } as Session;
}

/**
 * Create a mock session context
 */

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

    // Regression test for issue #351 (memory leak). Without dispose() in
    // removeFromRegistry, PostTracker entries accumulated across every
    // kill/exit, eventually causing V8 OOM after long uptimes.
    it('disposes the message manager so post-tracker entries are released', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killSession(session, true, ctx);

      expect(session.messageManager?.dispose).toHaveBeenCalled();
    });
  });

  describe('killAllSessions', () => {
    it('kills all active sessions', async () => {
      const session1 = createMockSession({ sessionId: 'p:t1', threadId: 't1' });
      const session2 = createMockSession({ sessionId: 'p:t2', threadId: 't2' });
      const sessions = new Map([
        ['p:t1', session1],
        ['p:t2', session2],
      ]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killAllSessions(ctx);

      expect(session1.claude.kill).toHaveBeenCalled();
      expect(session2.claude.kill).toHaveBeenCalled();
      expect(sessions.size).toBe(0);
    });

    it('preserves sessions in store for resume', async () => {
      const session = createMockSession();
      const sessions = new Map([['test-platform:thread-123', session]]);
      const ctx = createMockSessionContext(sessions);

      await lifecycle.killAllSessions(ctx);

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

    /**
     * #548: the reaper decides idleness from `lastActivityAt` alone. That
     * clock is fed by every Claude event, so a streaming turn keeps it warm —
     * but a turn that goes silent (wedged CLI, dropped API connection, one
     * long tool call) is reaped with a message claiming inactivity, which is
     * false. These pin the two cases apart on the real function.
     */
    describe('a stalled mid-turn session is not reported as idle (#548)', () => {
      const postedText = (session: Session): string =>
        (session.platform.createPost as ReturnType<typeof mock>).mock.calls
          .map((c: unknown[]) => String(c[0]))
          .join('\n');

      it('says the session stopped responding when a turn was still open', async () => {
        const session = createMockSession({
          lastActivityAt: new Date(Date.now() - 40 * 60 * 1000),
          isProcessing: true,
        });
        const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

        await lifecycle.cleanupIdleSessions(30 * 60 * 1000, 5 * 60 * 1000, ctx);

        const text = postedText(session);
        expect(text).toContain('stopped responding');
        expect(text).not.toContain('inactivity');
      });

      it('still reports genuine idleness as a timeout', async () => {
        const session = createMockSession({
          lastActivityAt: new Date(Date.now() - 40 * 60 * 1000),
          isProcessing: false,
        });
        const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

        await lifecycle.cleanupIdleSessions(30 * 60 * 1000, 5 * 60 * 1000, ctx);

        const text = postedText(session);
        expect(text).toContain('inactivity');
        expect(text).not.toContain('stopped responding');
      });

      it('the pre-timeout warning does not call an open turn idle', async () => {
        const session = createMockSession({
          lastActivityAt: new Date(Date.now() - 26 * 60 * 1000),
          timeoutWarningPosted: false,
          isProcessing: true,
        });
        const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

        await lifecycle.cleanupIdleSessions(30 * 60 * 1000, 5 * 60 * 1000, ctx);

        const text = postedText(session);
        expect(text).toContain('No output');
        expect(text).not.toContain('Session idle');
      });

      it('names a pending decision rather than blaming the CLI', async () => {
        const session = createMockSession({
          lastActivityAt: new Date(Date.now() - 40 * 60 * 1000),
          isProcessing: true,
        });
        // Plan approvals and questions are held in-process, so the reaper can
        // tell "waiting on you" apart from "went silent". (An MCP permission
        // prompt lives in the MCP child and is still invisible here — #533.)
        (session.messageManager as unknown as { hasPendingApproval: () => boolean }).hasPendingApproval =
          () => true;
        const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

        await lifecycle.cleanupIdleSessions(30 * 60 * 1000, 5 * 60 * 1000, ctx);

        const text = postedText(session);
        expect(text).toContain('still waiting');
        expect(text).not.toContain('stopped responding');
      });

      it('the pre-timeout warning still says idle between turns', async () => {
        const session = createMockSession({
          lastActivityAt: new Date(Date.now() - 26 * 60 * 1000),
          timeoutWarningPosted: false,
          isProcessing: false,
        });
        const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

        await lifecycle.cleanupIdleSessions(30 * 60 * 1000, 5 * 60 * 1000, ctx);

        expect(postedText(session)).toContain('Session idle');
      });
    });
  });
});

describe('handleRateLimit (multi-account cooldown wiring)', () => {
  /**
   * Regression test for reviewer S1: without this coverage, the three
   * wiring bugs it pairs with (M1 restart-rebind, M2 false-positive, M3
   * account leak) could all regress silently. This test exercises the
   * actual handler function that bindings call.
   */
  it('cools the session account when a rate-limit hit fires', () => {
    const session = createMockSession({ claudeAccountId: 'alice' });
    const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

    lifecycle.handleRateLimit(
      session,
      { detected: true, matched: 'usage limit reached', resetAtEpochMs: Date.now() + 60_000 },
      ctx
    );

    expect(ctx.ops.markClaudeAccountCooling).toHaveBeenCalledTimes(1);
    const [acctId, deadlineMs] = (ctx.ops.markClaudeAccountCooling as ReturnType<typeof mock>).mock.calls[0];
    expect(acctId).toBe('alice');
    expect(deadlineMs).toBeGreaterThan(Date.now());
  });

  it('falls back to the default 1-hour cooldown when reset time is unknown', () => {
    const session = createMockSession({ claudeAccountId: 'bob' });
    const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

    const before = Date.now();
    lifecycle.handleRateLimit(session, { detected: true, matched: 'rate_limit_error' }, ctx);
    const after = Date.now();

    const [, deadlineMs] = (ctx.ops.markClaudeAccountCooling as ReturnType<typeof mock>).mock.calls[0];
    // Default is 1h — allow a wide window for clock drift in the test.
    expect(deadlineMs).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(deadlineMs).toBeLessThanOrEqual(after + 61 * 60_000);
  });

  it('is a no-op in single-account mode (no account id on session)', () => {
    const session = createMockSession({ claudeAccountId: undefined });
    const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

    lifecycle.handleRateLimit(
      session,
      { detected: true, matched: 'usage limit reached' },
      ctx
    );

    expect(ctx.ops.markClaudeAccountCooling).not.toHaveBeenCalled();
  });
});

describe('Session State Management', () => {
  // NOTE: Subagent tracking tests moved to subagent.test.ts since SubagentExecutor
  // now manages subagent state via MessageManager

  it('tracks session allowed users', () => {
    const session = createMockSession();

    expect(session.sessionAllowedUsers.has('testuser')).toBe(true);
    expect(session.sessionAllowedUsers.has('otheruser')).toBe(false);

    session.sessionAllowedUsers.add('otheruser');
    expect(session.sessionAllowedUsers.has('otheruser')).toBe(true);
  });

});

describe('CHAT_PLATFORM_PROMPT', () => {
  it('contains version information', () => {
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('Claude Threads Version:');
  });

  it('contains user command documentation', () => {
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!stop');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!escape');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!invite');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!kick');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!cd');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).toContain('!permissions');
  });

  it('does not contain session metadata instructions (now handled out-of-band)', () => {
    // Session metadata (title, description) is now generated out-of-band via quickQuery
    // so Claude no longer needs to output [SESSION_TITLE:] markers
    expect(lifecycle.CHAT_PLATFORM_PROMPT).not.toContain('[SESSION_TITLE:');
    expect(lifecycle.CHAT_PLATFORM_PROMPT).not.toContain('[SESSION_DESCRIPTION:');
  });
});

describe('maybeInjectMetadataReminder', () => {
  // Note: This function no longer injects reminders into messages.
  // It now just fires out-of-band reclassification and returns the message unchanged.
  // Session metadata (title, description) is generated via quickQuery, not Claude output markers.

  it('returns message unchanged for first message', () => {
    const message = 'Hello';
    const session = { messageCount: 1 };

    const result = metadataSuggestions.maybeInjectMetadataReminder(message, session);

    expect(result).toBe('Hello');
  });

  it('returns message unchanged for second message', () => {
    const message = 'Hello';
    const session = { messageCount: 2 };

    const result = metadataSuggestions.maybeInjectMetadataReminder(message, session);

    expect(result).toBe('Hello');
  });

  it('returns message unchanged at reclassification interval (every 5 messages)', () => {
    const message = 'Hello';

    // 5th message - still returns unchanged (just fires reclassification in background)
    const result5 = metadataSuggestions.maybeInjectMetadataReminder(message, { messageCount: 5 });
    expect(result5).toBe('Hello');

    // 10th message - same behavior
    const result10 = metadataSuggestions.maybeInjectMetadataReminder(message, { messageCount: 10 });
    expect(result10).toBe('Hello');

    // 15th message - same behavior
    const result15 = metadataSuggestions.maybeInjectMetadataReminder(message, { messageCount: 15 });
    expect(result15).toBe('Hello');
  });

  it('returns message unchanged at all message counts', () => {
    const message = 'Hello';

    // All messages should return unchanged
    expect(metadataSuggestions.maybeInjectMetadataReminder(message, { messageCount: 3 })).toBe('Hello');
    expect(metadataSuggestions.maybeInjectMetadataReminder(message, { messageCount: 4 })).toBe('Hello');
    expect(metadataSuggestions.maybeInjectMetadataReminder(message, { messageCount: 6 })).toBe('Hello');
    expect(metadataSuggestions.maybeInjectMetadataReminder(message, { messageCount: 7 })).toBe('Hello');
  });
});

describe('cleanupIdleSessions extended', () => {
  it('kills session that has exceeded timeout', async () => {
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 35 * 60 * 1000), // 35 min ago
      timeoutWarningPosted: true,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.cleanupIdleSessions(
      30 * 60 * 1000, // 30 min timeout
      5 * 60 * 1000,  // 5 min warning
      ctx
    );

    // Session should be killed
    expect(sessions.has('test-platform:thread-123')).toBe(false);
  });

  it('does not skip sessions with pending approval when timed out', async () => {
    // Note: The current implementation does NOT skip sessions with pending items when timing out
    // This tests the actual behavior
    const mockMsgManager = createMockMessageManager();
    (mockMsgManager.getPendingApproval as any).mockReturnValue({ postId: 'p1', toolUseId: 't1', type: 'action' });
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 35 * 60 * 1000), // 35 min ago
      timeoutWarningPosted: true,
      messageManager: mockMsgManager as any,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.cleanupIdleSessions(
      30 * 60 * 1000,
      5 * 60 * 1000,
      ctx
    );

    // Session is killed even with pending approval (current behavior)
    expect(sessions.has('test-platform:thread-123')).toBe(false);
  });

  it('does not skip sessions with pending question when timed out', async () => {
    // Note: The current implementation does NOT skip sessions with pending items when timing out
    const mockMsgManager = createMockMessageManager();
    (mockMsgManager.getPendingQuestionSet as any).mockReturnValue({ toolUseId: 't1', currentIndex: 0, currentPostId: 'p1', questions: [] });
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 35 * 60 * 1000),
      timeoutWarningPosted: true,
      messageManager: mockMsgManager as any,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.cleanupIdleSessions(
      30 * 60 * 1000,
      5 * 60 * 1000,
      ctx
    );

    // Session is killed even with pending question (current behavior)
    expect(sessions.has('test-platform:thread-123')).toBe(false);
  });

  it('does not skip sessions with pending worktree prompt when timed out', async () => {
    // Note: The current implementation does NOT skip sessions with pending items when timing out
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 35 * 60 * 1000),
      timeoutWarningPosted: true,
      pendingWorktreePrompt: true,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.cleanupIdleSessions(
      30 * 60 * 1000,
      5 * 60 * 1000,
      ctx
    );

    // Session is killed even with pending worktree prompt (current behavior)
    expect(sessions.has('test-platform:thread-123')).toBe(false);
  });

  it('handles empty sessions map', async () => {
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);

    // Should not throw
    await lifecycle.cleanupIdleSessions(30000, 5000, ctx);

    expect(sessions.size).toBe(0);
  });

  // Anne's review on #529: only the pure policy function was covered, so
  // removing the gate from cleanupIdleSessions left the whole suite green.
  // This pins the call site.
  it('posts no idle warning when the platform hides lifecycle notices', async () => {
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 26 * 60 * 1000), // inside the warning window
      timeoutWarningPosted: false,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);
    (ctx.ops.getPlatformOverhead as any).mockReturnValue({
      sessionHeader: 'full', stickyMessage: 'full', lifecycle: 'hidden',
    });

    await lifecycle.cleanupIdleSessions(30 * 60 * 1000, 5 * 60 * 1000, ctx);

    expect(sessions.has('test-platform:thread-123')).toBe(true); // not killed, just warned-or-not
    expect(session.platform.createPost).not.toHaveBeenCalled();
  });

  it('posts the idle warning at full, so the gate is what silences it', async () => {
    const session = createMockSession({
      lastActivityAt: new Date(Date.now() - 26 * 60 * 1000),
      timeoutWarningPosted: false,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.cleanupIdleSessions(30 * 60 * 1000, 5 * 60 * 1000, ctx);

    expect(session.platform.createPost).toHaveBeenCalled();
  });
});

describe('killSession edge cases', () => {
  it('clears session timers', async () => {
    const session = createMockSession();
    // Set up timers via the new timers object
    session.timers.updateTimer = setTimeout(() => {}, 10000) as any;
    session.timers.statusBarTimer = setInterval(() => {}, 10000) as any;
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.killSession(session, true, ctx);

    // Session should be removed and timers cleared
    expect(sessions.has('test-platform:thread-123')).toBe(false);
  });

  it('emits session remove event', async () => {
    const session = createMockSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.killSession(session, true, ctx);

    expect(ctx.ops.emitSessionRemove).toHaveBeenCalledWith('test-platform:thread-123');
  });

  it('decrements keepAlive session count', async () => {
    const session = createMockSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    // Start a session to increment keepAlive
    const { keepAlive } = await import('../utils/keep-alive.js');
    const initialCount = keepAlive.getSessionCount();

    await lifecycle.killSession(session, true, ctx);

    // Count should have decremented (or stayed at 0 if already 0)
    expect(keepAlive.getSessionCount()).toBeLessThanOrEqual(initialCount);
  });
});

describe('killAllSessions edge cases', () => {
  it('handles sessions with timers', async () => {
    const session = createMockSession();
    // Set up timer via the new timers object
    session.timers.updateTimer = setTimeout(() => {}, 10000) as any;
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.killAllSessions(ctx);

    expect(sessions.size).toBe(0);
  });

  it('handles empty sessions gracefully', async () => {
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);

    // Should not throw
    await lifecycle.killAllSessions(ctx);

    expect(sessions.size).toBe(0);
  });

  it('calls killSession for each session', async () => {
    const session = createMockSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.killAllSessions(ctx);

    // Claude CLI kill should be called
    expect(session.claude.kill).toHaveBeenCalled();
  });
});

describe('sendFollowUp', () => {
  it('delegates to messageManager.handleUserMessage', async () => {
    // Mock messageManager with handleUserMessage
    const mockMsgManager = createMockMessageManager();
    const session = createMockSession({
      messageManager: mockMsgManager as any,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx, 'user', 'User Name');

    // Should have delegated to handleUserMessage
    expect(mockMsgManager.handleUserMessage).toHaveBeenCalledWith('New message', undefined, 'user', 'User Name');
  });

  it('does not send if Claude is not running', async () => {
    const session = createMockSession();
    (session.claude.isRunning as any).mockReturnValue(false);

    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx, 'user');

    // Should not have called handleUserMessage (early return)
    const mockMsgManager = session.messageManager as any;
    expect(mockMsgManager.handleUserMessage).not.toHaveBeenCalled();
  });

  it('increments message counter', async () => {
    const mockMsgManager = createMockMessageManager();
    const session = createMockSession({
      messageCount: 5,
      messageManager: mockMsgManager as any,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.sendFollowUp(session, 'New message', undefined, ctx, 'user');

    expect(session.messageCount).toBe(6);
  });
});

describe('handleExit', () => {
  it('skips cleanup when session is cancelled', async () => {
    const session = createMockSession({ isCancelled: true, isResumed: true });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    // handleExit should return early for cancelled sessions
    await lifecycle.handleExit('test-platform:thread-123', 1, ctx);

    // persistSession should NOT be called for cancelled sessions
    // (cancelled sessions are handled by killSession, not handleExit)
    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
  });

  it('returns early when session is not found', async () => {
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);

    // Should not throw when session doesn't exist
    await lifecycle.handleExit('nonexistent-session', 1, ctx);

    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
  });

  it('skips cleanup when session is restarting', async () => {
    const session = createMockSession({ isRestarting: true });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit('test-platform:thread-123', 1, ctx);

    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
    // lifecycle state should be reset to active
    expect(session.lifecycle.state).toBe('active');
  });
});

// NOTE: Task list bump on resume is tested in src/operations/message-manager.test.ts
// under the "restoreTaskListFromPersistence" describe block. The tests there properly
// verify the RED-GREEN behavior by testing the actual MessageManager method.

// NOTE: startSession worktree prompt skip tests are not included here because testing
// startSession directly requires mocking the Claude CLI spawn, which is complex.
// The fix is verified by:
// 1. manager.ts startSessionWithWorktree passes { ...options, skipWorktreePrompt: true }
// 2. lifecycle.ts startSession checks options.skipWorktreePrompt before shouldPromptForWorktree
// See src/session/manager.ts:1280 and src/session/lifecycle.ts:692

describe('attemptMetadataFetch', () => {
  it('returns success when both metadata and tags are fetched', async () => {
    // Create session with no existing metadata
    const session = createMockSession({
      sessionTitle: undefined,
      sessionDescription: undefined,
      sessionTags: undefined,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    const result = await metadataSuggestions.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => ({
        title: 'Test Title',
        description: 'Test Description',
      }),
      suggestTags: async () => ['bug-fix'],
    });

    expect(result.success).toBe(true);
    expect(result.metadataSet).toBe(true);
    expect(result.tagsSet).toBe(true);
    expect(session.sessionTitle).toBe('Test Title');
    expect(session.sessionDescription).toBe('Test Description');
    expect(session.sessionTags).toEqual(['bug-fix']);
  });

  it('returns partial success when only metadata fails', async () => {
    const session = createMockSession({
      sessionTitle: undefined,
      sessionDescription: undefined,
      sessionTags: undefined,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    const result = await metadataSuggestions.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => null,
      suggestTags: async () => ['feature'],
    });

    expect(result.success).toBe(false);
    expect(result.metadataSet).toBe(false);
    expect(result.tagsSet).toBe(true);
    expect(session.sessionTitle).toBeUndefined();
    expect(session.sessionTags).toEqual(['feature']);
  });

  it('returns partial success when only tags fail', async () => {
    const session = createMockSession({
      sessionTitle: undefined,
      sessionDescription: undefined,
      sessionTags: undefined,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    const result = await metadataSuggestions.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => ({
        title: 'Success Title',
        description: 'Success Desc',
      }),
      suggestTags: async () => [],
    });

    expect(result.success).toBe(false);
    expect(result.metadataSet).toBe(true);
    expect(result.tagsSet).toBe(false);
    expect(session.sessionTitle).toBe('Success Title');
    expect(session.sessionTags).toBeUndefined();
  });

  it('reports session already has metadata as success', async () => {
    const session = createMockSession({
      sessionTitle: 'Existing Title',
      sessionDescription: 'Existing Desc',
      sessionTags: ['refactor'],
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    // Even if suggestions fail, existing metadata counts as success
    const result = await metadataSuggestions.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => null,
      suggestTags: async () => [],
    });

    expect(result.success).toBe(true);
    expect(result.metadataSet).toBe(true);
    expect(result.tagsSet).toBe(true);
    // Original values should be preserved
    expect(session.sessionTitle).toBe('Existing Title');
    expect(session.sessionTags).toEqual(['refactor']);
  });

  it('returns early if session is gone', async () => {
    const session = createMockSession();
    // Session is NOT in the sessions map (simulating cleanup while fetching)
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);

    const result = await metadataSuggestions.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => ({
        title: 'Title',
        description: 'Desc',
      }),
      suggestTags: async () => ['test'],
    });

    // Should return failure since session is gone
    expect(result.success).toBe(false);
    expect(result.metadataSet).toBe(false);
    expect(result.tagsSet).toBe(false);
  });

  it('updates UI when metadata changes', async () => {
    const session = createMockSession({
      sessionTitle: undefined,
      sessionDescription: undefined,
      sessionTags: undefined,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await metadataSuggestions.attemptMetadataFetch(session, 'test prompt', ctx, 1, {
      suggestMetadata: async () => ({
        title: 'New Title',
        description: 'New Desc',
      }),
      suggestTags: async () => ['docs'],
    });

    // Should have updated persistence and UI
    expect(ctx.ops.persistSession).toHaveBeenCalled();
    expect(ctx.ops.updateStickyMessage).toHaveBeenCalled();
    expect(ctx.ops.updateSessionHeader).toHaveBeenCalled();
  });
});

// ============================================================================
// handleExit branch coverage — PR 1 safety net
// ============================================================================

/** Build a session whose .claude mock has isPermanentFailure & reason hooks. */
function createExitTestSession(overrides: Partial<Session> & {
  isPermanent?: boolean;
  permanentReason?: string;
  isRestarting?: boolean;
  isCancelled?: boolean;
  wasInterrupted?: boolean;
  hasClaudeResponded?: boolean;
  resumeFailCount?: number;
} = {}): Session {
  const session = createMockSession(overrides);
  session.claude = {
    ...session.claude,
    isPermanentFailure: mock(() => overrides.isPermanent ?? false),
    getPermanentFailureReason: mock(() => overrides.permanentReason ?? null),
  } as any;
  if (overrides.resumeFailCount !== undefined) {
    session.lifecycle.resumeFailCount = overrides.resumeFailCount;
  }
  return session;
}

describe('handleExit', () => {
  it('is a no-op when session is not found', async () => {
    const ctx = createMockSessionContext(new Map());
    await expect(lifecycle.handleExit('test-platform:missing', 0, ctx)).resolves.toBeUndefined();
    expect(ctx.ops.updateStickyMessage).not.toHaveBeenCalled();
  });

  it('skips cleanup and resets state when session is restarting', async () => {
    const session = createExitTestSession({ isRestarting: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx);
    expect(session.lifecycle.state).toBe('active');
    expect(sessions.has(session.sessionId)).toBe(true);
    expect(ctx.ops.updateStickyMessage).not.toHaveBeenCalled();
  });

  it('skips cleanup when session was cancelled', async () => {
    const session = createExitTestSession({ isCancelled: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 137, ctx);
    // killSession handles cleanup; handleExit just returns.
    expect(ctx.ops.updateStickyMessage).not.toHaveBeenCalled();
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
  });

  it('preserves persistence when bot is shutting down', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);
    (ctx.state as { isShuttingDown: boolean }).isShuttingDown = true;

    await lifecycle.handleExit(session.sessionId, 0, ctx);
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
  });

  it('pauses session after interrupt when Claude has responded', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true, wasInterrupted: true });
    const mockCreatePost = mock(() => Promise.resolve({
      id: 'pause-post', platformId: 'test-platform', channelId: 'c', userId: 'bot', message: '', createAt: 0,
    }));
    session.platform = createMockPlatform({ createPost: mockCreatePost as any });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx);

    expect(session.lifecycle.state).toBe('paused');
    expect(ctx.ops.persistSession).toHaveBeenCalled();
    expect(sessions.has(session.sessionId)).toBe(false);
    expect(ctx.ops.updateStickyMessage).toHaveBeenCalled();
  });

  it('does not persist interrupt when Claude has not yet responded', async () => {
    const session = createExitTestSession({ hasClaudeResponded: false, wasInterrupted: true });
    session.platform = createMockPlatform({
      createPost: mock(() => Promise.resolve({
        id: 'p', platformId: 'test-platform', channelId: 'c', userId: 'bot', message: '', createAt: 0,
      })) as any,
    });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx);
    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
  });

  it('warns and cleans up when session exits before Claude responded', async () => {
    const session = createExitTestSession({ hasClaudeResponded: false });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 1, ctx);
    expect(sessions.has(session.sessionId)).toBe(false);
    expect(ctx.ops.updateStickyMessage).toHaveBeenCalled();
  });

  // Regression test for issue #351 (memory leak). Without dispose() in
  // cleanupSession, every early-exit/shutdown/resume-fail path leaked the
  // MessageManager's PostTracker entries.
  it('disposes the message manager on early exit', async () => {
    const session = createExitTestSession({ hasClaudeResponded: false });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 1, ctx);

    expect(session.messageManager?.dispose).toHaveBeenCalled();
  });

  it('immediately unpersists on permanent failure for a resumed session', async () => {
    const session = createExitTestSession({
      hasClaudeResponded: true,
      isPermanent: true,
      permanentReason: 'corrupt session state',
      resumeFailCount: 1,
    });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 2, ctx);
    expect(ctx.ops.unpersistSession).toHaveBeenCalledWith(session.sessionId);
    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
  });

  it('unpersists resumed session after MAX_RESUME_FAILURES', async () => {
    const session = createExitTestSession({
      hasClaudeResponded: true,
      resumeFailCount: 2, // will increment to 3 = MAX
    });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 1, ctx);
    expect(session.lifecycle.resumeFailCount).toBe(3);
    expect(ctx.ops.unpersistSession).toHaveBeenCalledWith(session.sessionId);
  });

  it('persists resumed session with retries left after transient failure', async () => {
    const session = createExitTestSession({
      hasClaudeResponded: true,
      resumeFailCount: 0, // will increment to 1
    });
    // Force "resumed" state so handleExit hits the wasResumed branch.
    session.lifecycle.state = 'active';
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 1, ctx);
    expect(session.lifecycle.resumeFailCount).toBe(1);
    expect(ctx.ops.persistSession).toHaveBeenCalled();
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
  });

  it('unpersists on normal (code 0) exit', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx);
    expect(ctx.ops.unpersistSession).toHaveBeenCalledWith(session.sessionId);
    expect(sessions.has(session.sessionId)).toBe(false);
  });

  it('preserves persistence on non-zero exit (retry on restart)', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 137, ctx);
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
    expect(sessions.has(session.sessionId)).toBe(false);
  });

  it('unregisters worktree user when session has worktreeInfo', async () => {
    const session = createExitTestSession({
      hasClaudeResponded: true,
      worktreeInfo: {
        worktreePath: '/tmp/wt/abc',
        branch: 'feature/x',
        createdAt: new Date().toISOString(),
      } as any,
    });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx);
    expect(ctx.ops.unregisterWorktreeUser).toHaveBeenCalledWith('/tmp/wt/abc', session.sessionId);
  });

  it('ignores a stale exit from a replaced Claude process', async () => {
    // Race seen in CI (slack integration, "!cd should restart Claude CLI"):
    // the old process's 'exit' event can arrive after restartClaudeSession
    // already swapped session.claude to the new instance and the session is
    // back in 'active'. That exit must not tear down the restarted session.
    const session = createExitTestSession({ hasClaudeResponded: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    const replacedCli = { isPermanentFailure: () => false } as any;
    await lifecycle.handleExit(session.sessionId, 0, ctx, replacedCli);

    expect(sessions.has(session.sessionId)).toBe(true);
    expect(ctx.ops.unpersistSession).not.toHaveBeenCalled();
    expect(ctx.ops.updateStickyMessage).not.toHaveBeenCalled();
  });

  it('handles the exit normally when source is the current Claude process', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 0, ctx, session.claude);

    expect(sessions.has(session.sessionId)).toBe(false);
    expect(ctx.ops.unpersistSession).toHaveBeenCalledWith(session.sessionId);
  });

  it('posts [Exited: code] notification on non-zero exit', async () => {
    const session = createExitTestSession({ hasClaudeResponded: true });
    const mockCreatePost = mock(() => Promise.resolve({
      id: 'p', platformId: 'test-platform', channelId: 'c', userId: 'bot', message: '', createAt: 0,
    }));
    session.platform = createMockPlatform({ createPost: mockCreatePost as any });
    const sessions = new Map([[session.sessionId, session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit(session.sessionId, 42, ctx);
    const posts = (mockCreatePost as any).mock.calls.map((c: any[]) => c[0]);
    expect(posts.some((msg: string) => msg.includes('[Exited: 42]'))).toBe(true);
  });
});

// ===========================================================================
// resolveSessionHeaderMode — issue #383 / PR #384
// Pure helper extracted from startSession so the hidden/minimal/full
// branching is testable without mocking ClaudeCli + MessageManager.
// ===========================================================================

describe('resolveSessionHeaderMode', () => {
  it('returns full when configured is undefined (platform never registered overhead)', () => {
    expect(lifecycle.resolveSessionHeaderMode(undefined, 'thread-1', 'mm')).toBe('full');
  });

  it('passes full and minimal through unchanged regardless of replyToPostId', () => {
    expect(lifecycle.resolveSessionHeaderMode('full', 'thread-1', 'mm')).toBe('full');
    expect(lifecycle.resolveSessionHeaderMode('full', undefined, 'mm')).toBe('full');
    expect(lifecycle.resolveSessionHeaderMode('minimal', 'thread-1', 'mm')).toBe('minimal');
    expect(lifecycle.resolveSessionHeaderMode('minimal', undefined, 'mm')).toBe('minimal');
  });

  it('honors hidden when a replyToPostId is supplied', () => {
    expect(lifecycle.resolveSessionHeaderMode('hidden', 'thread-1', 'mm')).toBe('hidden');
  });

  it('downgrades hidden to minimal when replyToPostId is missing (defensive fallback)', () => {
    // The bot's message router always supplies post.rootId || post.id, so
    // this branch only fires for a programmer-error caller. Verify the
    // downgrade so the user does NOT silently get the full table they
    // explicitly hid.
    expect(lifecycle.resolveSessionHeaderMode('hidden', undefined, 'mm')).toBe('minimal');
    expect(lifecycle.resolveSessionHeaderMode('hidden', '', 'mm')).toBe('minimal');
  });
});

// ===========================================================================
// resumeSessionHeaderMode — issue #383 / PR #384
// Fallback cascade for resumed sessions.
// ===========================================================================

// =============================================================================
// Fail-closed authorization at the sinks (#388)
// =============================================================================

describe('authorization gate at sinks (#388)', () => {
  describe('startSession', () => {
    it('refuses to start for an unauthorized user (no Claude account acquired)', async () => {
      // Platform with a non-empty allowlist that excludes jonas.gn.
      const platform = createMockPlatform({
        isUserAllowed: mock((u: string) => u === 'alice') as any,
      });
      const sessions = new Map<string, Session>();
      const ctx = createMockSessionContext(sessions);
      (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);

      await lifecycle.startSession(
        { prompt: 'do something' },
        'jonas.gn',
        'Jonas',
        'thread-new',
        'test-platform',
        ctx,
      );

      // The Claude-invoking path is reached only after the gate. If the gate
      // is removed, startSession reserves an account and commits a session.
      expect(ctx.ops.acquireClaudeAccount).not.toHaveBeenCalled();
      expect(sessions.size).toBe(0);
      expect(ctx.ops.emitSessionAdd).not.toHaveBeenCalled();
    });

    it('starts for a globally allowlisted user', async () => {
      const platform = createMockPlatform({
        isUserAllowed: mock((u: string) => u === 'alice') as any,
      });
      const sessions = new Map<string, Session>();
      const ctx = createMockSessionContext(sessions);
      (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);

      await lifecycle.startSession(
        { prompt: 'do something' },
        'alice',
        'Alice',
        'thread-new',
        'test-platform',
        ctx,
      );

      // Gate passed: startSession proceeded to reserve a Claude account.
      expect(ctx.ops.acquireClaudeAccount).toHaveBeenCalled();
    });

    it('starts for any user when the allowlist is empty (allow-all)', async () => {
      const platform = createMockPlatform({ isUserAllowed: mock(() => true) as any });
      const sessions = new Map<string, Session>();
      const ctx = createMockSessionContext(sessions);
      (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);

      await lifecycle.startSession(
        { prompt: 'do something' },
        'anyone',
        'Anyone',
        'thread-new',
        'test-platform',
        ctx,
      );

      expect(ctx.ops.acquireClaudeAccount).toHaveBeenCalled();
    });
  });

  describe('sendFollowUp', () => {
    it('does not reach handleUserMessage for an unauthorized user', async () => {
      const mockMsgManager = createMockMessageManager();
      const session = createMockSession({
        platform: createMockPlatform({ isUserAllowed: mock((u: string) => u === 'alice') as any }),
        sessionAllowedUsers: new Set(['alice']),
        messageManager: mockMsgManager as any,
      });
      const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

      await lifecycle.sendFollowUp(session, 'do it', undefined, ctx, 'jonas.gn');

      expect(mockMsgManager.handleUserMessage).not.toHaveBeenCalled();
    });

    it('reaches handleUserMessage for a per-session invited user', async () => {
      const mockMsgManager = createMockMessageManager();
      const session = createMockSession({
        platform: createMockPlatform({ isUserAllowed: mock((u: string) => u === 'alice') as any }),
        sessionAllowedUsers: new Set(['alice', 'invited']),
        messageManager: mockMsgManager as any,
      });
      const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

      await lifecycle.sendFollowUp(session, 'do it', undefined, ctx, 'invited');

      expect(mockMsgManager.handleUserMessage).toHaveBeenCalled();
    });

    it('reaches handleUserMessage for a system follow-up with no username', async () => {
      const mockMsgManager = createMockMessageManager();
      const session = createMockSession({
        platform: createMockPlatform({ isUserAllowed: mock((u: string) => u === 'alice') as any }),
        sessionAllowedUsers: new Set(['alice']),
        messageManager: mockMsgManager as any,
      });
      const ctx = createMockSessionContext(new Map([['test-platform:thread-123', session]]));

      await lifecycle.sendFollowUp(session, '/context', undefined, ctx, undefined, undefined, {
        system: true,
      });

      expect(mockMsgManager.handleUserMessage).toHaveBeenCalled();
    });
  });

  describe('resumePausedSession', () => {
    // These tests now reach `claude.start()` (the harness supplies a
    // getMcpConfig, without which resume threw before the notice). Spawning
    // must therefore be deterministic: another test file sets CLAUDE_PATH to
    // a nonexistent binary, and in a shared process that leaks in as ENOENT.
    let prevClaudePath: string | undefined;
    beforeEach(() => {
      prevClaudePath = process.env.CLAUDE_PATH;
      process.env.CLAUDE_PATH = '/bin/echo';
    });
    afterEach(() => {
      if (prevClaudePath === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = prevClaudePath;
    });

    function persistedState(overrides?: Record<string, unknown>) {
      return {
        threadId: 'thread-paused',
        platformId: 'test-platform',
        claudeSessionId: 'claude-session-1',
        // Use a directory that actually exists so resumeSession proceeds past
        // its existsSync check and reaches acquireClaudeAccount when the gate
        // allows it. The negative test bails at the gate before this matters.
        workingDir: process.cwd(),
        startedBy: 'alice',
        sessionAllowedUsers: ['alice'],
        ...overrides,
      };
    }

    function contextWithPersisted(state: Record<string, unknown>) {
      // Platform with a non-empty allowlist excluding the resumer, and a
      // getPost that returns a thread so resumeSession would proceed if the
      // gate were absent.
      const platform = createMockPlatform({
        isUserAllowed: mock((u: string) => u === 'alice') as any,
        getPost: mock(() => Promise.resolve({ id: 'thread-paused' })) as any,
        // Resume builds real CLI options from this; without allowedUsers it
        // throws before ever reaching the resume notice.
        getMcpConfig: mock(() => ({
          type: 'mattermost', url: 'https://chat.example.com',
          token: 't', channelId: 'c', allowedUsers: ['alice'],
        })) as any,
      });
      const ctx = createMockSessionContext(new Map());
      (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);
      (ctx.state.sessionStore.load as any).mockReturnValue(
        new Map([['test-platform:thread-paused', state]]),
      );
      return ctx;
    }

    it('does not resume for an unauthorized user (no Claude account acquired)', async () => {
      const ctx = contextWithPersisted(persistedState());

      await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'jonas.gn', 'test-platform');

      // resumeSession (reached only past the gate) acquires a Claude account.
      expect(ctx.ops.acquireClaudeAccount).not.toHaveBeenCalled();
    });

    it('proceeds past the gate for the session owner', async () => {
      const ctx = contextWithPersisted(persistedState());

      await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'alice', 'test-platform');

      // Owner clears the gate, so resumeSession runs and acquires an account.
      expect(ctx.ops.acquireClaudeAccount).toHaveBeenCalled();
    });

    it('proceeds for an invited collaborator from persisted sessionAllowedUsers', async () => {
      const ctx = contextWithPersisted(
        persistedState({ sessionAllowedUsers: ['alice', 'invited'] }),
      );

      await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'invited', 'test-platform');

      expect(ctx.ops.acquireClaudeAccount).toHaveBeenCalled();
    });

    // Anne's review on #529: at `hidden` the pause post is suppressed, so no
    // lifecyclePostId is stored and resume created a BRAND NEW post claiming
    // a bot restart. The quiet setting made a pause/resume cycle noisier
    // than `full`, and wrong.
    it('posts no resume notice when the platform hides lifecycle notices', async () => {
      const ctx = contextWithPersisted(persistedState());
      (ctx.ops.getPlatformOverhead as any).mockReturnValue({
        sessionHeader: 'full', stickyMessage: 'full', lifecycle: 'hidden',
      });
      const platform = (ctx.state.platforms as Map<string, PlatformClient>).get('test-platform')!;

      await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'alice', 'test-platform');

      expect(ctx.ops.acquireClaudeAccount).toHaveBeenCalled();  // it really did resume
      const created = (platform.createPost as any).mock.calls.map((c: unknown[]) => String(c[0]));
      expect(created.some((t: string) => t.includes('Session resumed'))).toBe(false);
    });

    it('posts the resume notice at full, so the gate is what silences it', async () => {
      const ctx = contextWithPersisted(persistedState());
      const platform = (ctx.state.platforms as Map<string, PlatformClient>).get('test-platform')!;

      await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'alice', 'test-platform');

      const created = (platform.createPost as any).mock.calls.map((c: unknown[]) => String(c[0]));
      expect(created.some((t: string) => t.includes('Session resumed'))).toBe(true);
    });

    it('does not resume a session from another platform (cross-platform threadId collision)', async () => {
      // SECURITY regression: a session lives under platform-a. A message
      // arrives on platform-b whose threadId collides. The resume sink must be
      // scoped to the message's platform — without scoping, platform-b's
      // message would resume platform-a's session (importing its allowlist,
      // working dir, worktree and Claude account), and the authorization check
      // would run against platform-a's allowlist instead of platform-b's.
      const platformA = createMockPlatform({
        isUserAllowed: mock((u: string) => u === 'alice') as any,
        getPost: mock(() => Promise.resolve({ id: 'shared-thread' })) as any,
      });
      const ctx = createMockSessionContext(new Map());
      (ctx.state.platforms as Map<string, PlatformClient>).set('platform-a', platformA);
      (ctx.state.sessionStore.load as any).mockReturnValue(
        new Map([[
          'platform-a:shared-thread',
          persistedState({ threadId: 'shared-thread', platformId: 'platform-a' }),
        ]]),
      );

      // Alice is authorized on platform-a; the message arrives on platform-b.
      await lifecycle.resumePausedSession('shared-thread', 'continue', undefined, ctx, 'alice', 'platform-b');

      // Scoped out: no session resolves for platform-b, so nothing is resumed.
      // (Without the platformId scope, platform-a's session would be found and
      // resumed here — acquireClaudeAccount would be called.)
      expect(ctx.ops.acquireClaudeAccount).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Regression: the trapped-thread bug.
    //
    // `registry.getPersistedByThreadId()` deliberately returns SOFT-DELETED
    // records so a plain reply can revive a session `cleanStale()` tombstoned
    // at startup (see registry.test.ts, "returns soft-deleted sessions too").
    // That gate is what routes a message into the paused-session branch.
    //
    // But this sink resolved its state through `load()`, which SKIPS records
    // with `cleanedAt`. So the two lookups disagreed: the gate said "a paused
    // session lives here", the sink said "No persisted session found" and
    // returned — silently. The thread was then unreachable in both
    // directions: the paused branch owns the message, so the new-session path
    // never runs either.
    //
    // In a DCM channel, where the channel IS the session, that is terminal:
    // `!stop` soft-deletes the record and nothing can ever start a session in
    // that channel again. Observed 2026-09-05 and reproduced on demand.
    // -----------------------------------------------------------------------
    function contextWithTombstone(state: Record<string, unknown>) {
      const platform = createMockPlatform({
        isUserAllowed: mock((u: string) => u === 'alice') as any,
        getPost: mock(() => Promise.resolve({ id: 'thread-paused' })) as any,
      });
      const ctx = createMockSessionContext(new Map());
      (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);
      // The real store's asymmetry, mocked exactly: load() hides it, the
      // raw scan still returns it.
      (ctx.state.sessionStore.load as any).mockReturnValue(new Map());
      (ctx.state.sessionStore.findByThreadIdAnyState as any).mockImplementation(
        (threadId: string, platformId?: string) =>
          threadId === state.threadId && (platformId === undefined || platformId === state.platformId)
            ? state
            : undefined,
      );
      return ctx;
    }

    it('resumes a soft-deleted record instead of dropping the message', async () => {
      const ctx = contextWithTombstone(
        persistedState({ isPaused: true, cleanedAt: new Date().toISOString(), endReason: 'stale' }),
      );

      await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'alice', 'test-platform');

      // Before the fix this returned at "No persisted session found".
      expect(ctx.ops.acquireClaudeAccount).toHaveBeenCalled();
    });

    it('clears the tombstone it resurrected, so the record stops being half-dead', async () => {
      const state = persistedState({ isPaused: true, cleanedAt: new Date().toISOString(), endReason: 'stale' });
      const ctx = contextWithTombstone(state);

      await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'alice', 'test-platform');

      // Leaving `cleanedAt` set would put the record straight back into the
      // state where load() hides it — reviving the thread for exactly one
      // message and then trapping it again on the next restart.
      expect((state as { cleanedAt?: string }).cleanedAt).toBeUndefined();
    });

    it('writes the revived record back to the store, not just the object', async () => {
      // Clearing the field in memory is not enough: a restart before the next
      // save would reload the tombstone from disk and trap the thread again.
      const state = persistedState({ isPaused: true, cleanedAt: new Date().toISOString(), endReason: 'stale' });
      const ctx = contextWithTombstone(state);

      await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'alice', 'test-platform');

      const saved = (ctx.state.sessionStore.save as any).mock.calls
        .find(([id]: [string]) => id === 'test-platform:thread-paused');
      expect(saved).toBeDefined();
      expect(saved[1].cleanedAt).toBeUndefined();
      // The pair is written together and must be cleared together, or the
      // record keeps a reason for an ending that no longer happened.
      expect(saved[1].endReason).toBeUndefined();
    });

    it('does not revive the tombstone for a refused user', async () => {
      // The write-back sits after the #388 gate on purpose: a refused resume
      // must not launder a soft-deleted session back into the visible set.
      const state = persistedState({ isPaused: true, cleanedAt: new Date().toISOString(), endReason: 'stale' });
      const ctx = contextWithTombstone(state);

      await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'jonas.gn', 'test-platform');

      expect((state as { cleanedAt?: string }).cleanedAt).toBeDefined();
      expect(ctx.state.sessionStore.save).not.toHaveBeenCalled();
    });

    it('still refuses an unauthorized user when the record is soft-deleted', async () => {
      // Resurrecting a tombstone must not become a way around the #388
      // identity gate: the authorization check runs on the same state either
      // way.
      const ctx = contextWithTombstone(
        persistedState({ isPaused: true, cleanedAt: new Date().toISOString(), endReason: 'stale' }),
      );

      await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'jonas.gn', 'test-platform');

      expect(ctx.ops.acquireClaudeAccount).not.toHaveBeenCalled();
    });
  });
});

describe('resumeSessionHeaderMode', () => {
  it('honors the persisted mode when present', () => {
    // Even if the platform config has flipped back to 'full' since the
    // session was started, the user's original choice wins on resume.
    expect(lifecycle.resumeSessionHeaderMode('hidden', 'full')).toBe('hidden');
    expect(lifecycle.resumeSessionHeaderMode('minimal', 'full')).toBe('minimal');
    expect(lifecycle.resumeSessionHeaderMode('full', 'hidden')).toBe('full');
  });

  it('falls back to platform config when persisted is missing (old sessions.json)', () => {
    // Backward compat: pre-PR-384 sessions.json files have no
    // sessionHeaderMode — they should pick up whatever the platform is
    // currently set to.
    expect(lifecycle.resumeSessionHeaderMode(undefined, 'minimal')).toBe('minimal');
    expect(lifecycle.resumeSessionHeaderMode(undefined, 'hidden')).toBe('hidden');
  });

  it('falls back to full when both are missing (legacy + unconfigured platform)', () => {
    expect(lifecycle.resumeSessionHeaderMode(undefined, undefined)).toBe('full');
  });
});

describe('resumeSession backward compatibility', () => {
  // Persisted sessions written before sessionAllowedUsers existed lack the
  // field entirely. Restoring them as an empty set silently drops the owner
  // from their own session — under `approvals: owner` that locks them out of
  // every approval gate. The rebuild must fall back to [startedBy], like the
  // restore sites at resumePausedSession and pause-state reconstruction do.
  it('restores the owner into sessionAllowedUsers when the persisted field is missing (legacy data)', async () => {
    const platform = createMockPlatform({
      getPost: mock(() => Promise.resolve({ id: 'thread-legacy' })) as any,
    });
    const ctx = createMockSessionContext(new Map());
    (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);

    const legacyState = {
      threadId: 'thread-legacy',
      platformId: 'test-platform',
      claudeSessionId: 'claude-session-legacy',
      workingDir: process.cwd(),
      startedBy: 'alice',
      startedAt: new Date().toISOString(),
      // no sessionAllowedUsers — the legacy shape under test
    };

    // emitSessionAdd fires with the rebuilt Session after registration and
    // before the spawn attempt, so the assertion holds even though
    // claude.start() fails and rolls the session back in this mock harness.
    await lifecycle.resumeSession(legacyState as never, ctx);

    const calls = (ctx.ops.emitSessionAdd as ReturnType<typeof mock>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const session = calls[0][0] as Session;
    expect(session.sessionAllowedUsers.has('alice')).toBe(true);
  });
});

describe('userAttribution flag seeding', () => {
  // startSession fails at claude.start() in this mock environment and rolls
  // the session back out of the registry, so assertions read the session from
  // the updateSessionHeader call — it fires after the Session object is built
  // and registered, before the spawn attempt.
  async function startAndCaptureSession(userAttribution?: boolean): Promise<Session> {
    const platform = createMockPlatform();
    const ctx = createMockSessionContext(new Map());
    if (userAttribution !== undefined) {
      ctx.config.userAttribution = userAttribution;
    }
    (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);

    await lifecycle.startSession(
      { prompt: 'do something' }, 'alice', 'Alice', 'thread-new', 'test-platform', ctx,
    );

    const calls = (ctx.ops.updateSessionHeader as any).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[0][0] as Session;
  }

  it('seeds Session.userAttribution from the config default', async () => {
    const session = await startAndCaptureSession(true);
    expect(session.userAttribution).toBe(true);
  });

  it('defaults Session.userAttribution to true when the config omits it', async () => {
    const session = await startAndCaptureSession(undefined);
    expect(session.userAttribution).toBe(true);
  });

  // Resume registers the session (and emits session:add) before claude.start(),
  // so the added session is observable even though the spawn fails in mocks.
  function resumeCtx(stateOverrides: Record<string, unknown>) {
    const platform = createMockPlatform({
      getPost: mock(() => Promise.resolve({ id: 'thread-paused' })) as any,
    });
    const ctx = createMockSessionContext(new Map());
    (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);
    (ctx.state.sessionStore.load as any).mockReturnValue(
      new Map([['test-platform:thread-paused', {
        threadId: 'thread-paused',
        platformId: 'test-platform',
        claudeSessionId: 'claude-session-1',
        workingDir: process.cwd(),
        startedBy: 'alice',
        sessionAllowedUsers: ['alice'],
        ...stateOverrides,
      }]]),
    );
    return ctx;
  }

  it('seeds userAttribution from persisted state on resume', async () => {
    const ctx = resumeCtx({ userAttribution: true });

    await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'alice', 'test-platform');

    const added = (ctx.ops.emitSessionAdd as any).mock.calls[0]?.[0] as Session;
    expect(added.userAttribution).toBe(true);
  });

  it('reads absent persisted userAttribution as false (pre-flag sessions.json)', async () => {
    const ctx = resumeCtx({});

    await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'alice', 'test-platform');

    const added = (ctx.ops.emitSessionAdd as any).mock.calls[0]?.[0] as Session;
    expect(added.userAttribution).toBe(false);
  });
});

describe('resumePausedSession sender attribution (regression)', () => {
  it('sends the reviving username, not the persisted session owner, as the message sender', async () => {
    // Owner 'alice' started the session; 'bob' (an invited collaborator) is
    // the one reviving it now. handleUserMessage's 3rd arg must be the real
    // sender so [@bob]: (not [@alice]:) is what Claude sees when
    // userAttribution is on.
    const platform = createMockPlatform({
      isUserAllowed: mock((u: string) => u === 'alice') as any,
      getPost: mock(() => Promise.resolve({ id: 'thread-paused' })) as any,
    });
    // resumeSession's internal ClaudeCli.start() throws in this mock
    // environment (no real platformConfig), so the session it builds gets
    // rolled back out of the registry before resumePausedSession looks it
    // up. Seed the sessions map under the COMPOSITE key with a mock session
    // (and a mock messageManager) so handleUserMessage's call args are
    // observable — that map, keyed `platformId:threadId`, is the same seam
    // resumePausedSession queries to find the session to message.
    const mockMsgManager = createMockMessageManager();
    const mockSession = createMockSession({ messageManager: mockMsgManager as any });
    const ctx = createMockSessionContext(
      new Map([['test-platform:thread-paused', mockSession]]),
    );
    (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);
    (ctx.state.sessionStore.load as any).mockReturnValue(
      new Map([['test-platform:thread-paused', {
        threadId: 'thread-paused',
        platformId: 'test-platform',
        claudeSessionId: 'claude-session-1',
        workingDir: process.cwd(),
        startedBy: 'alice',
        sessionAllowedUsers: ['alice', 'bob'],
      }]]),
    );

    await lifecycle.resumePausedSession('thread-paused', 'continue', undefined, ctx, 'bob', 'test-platform');

    expect(mockMsgManager.handleUserMessage).toHaveBeenCalledTimes(1);
    const sender = (mockMsgManager.handleUserMessage as any).mock.calls[0][2];
    expect(sender).toBe('bob');
  });
});


// =============================================================================
// Decision-bridge listener wiring (createMessageManager)
// =============================================================================

describe('decision-bridge listener wiring', () => {
  // startSession reaches a real ClaudeCli.start() in this harness; point it
  // at a harmless long-running binary so the spawn succeeds without the real
  // CLI (killed in teardown).
  let prevClaudePath: string | undefined;
  beforeEach(() => {
    prevClaudePath = process.env.CLAUDE_PATH;
    // Any real executable works — it exits quickly on the CLI's args, which
    // is fine: the listeners under test don't need a live child.
    process.env.CLAUDE_PATH = ['/bin/sh', '/usr/bin/sh', '/bin/cat', '/usr/bin/cat']
      .find(p => existsSync(p)) ?? '/bin/sh';
  });
  afterEach(() => {
    if (prevClaudePath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = prevClaudePath;
  });

  async function startSmokeSession() {
    const platform = createMockPlatform({
      isUserAllowed: mock((u: string) => u === 'alice') as any,
      getMcpConfig: mock(() => ({
        type: 'mattermost',
        url: 'https://chat.example.com',
        token: 't',
        channelId: 'c',
        allowedUsers: ['alice'],
      })) as any,
    });
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);
    // The mock config's '/test' does not exist — spawn would fail with
    // ENOENT on the cwd before the child even runs.
    (ctx.config as { workingDir: string }).workingDir = '/tmp';
    (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);

    await lifecycle.startSession(
      { prompt: 'do something' },
      'alice',
      'Alice',
      'thread-bridge',
      'test-platform',
      ctx,
    );
    const session = sessions.get('test-platform:thread-bridge');
    expect(session).toBeDefined();
    return { session: session!, ctx };
  }

  async function teardown(session: Session) {
    await session.claude.kill().catch(() => {});
    session.messageManager?.dispose();
    await session.decisionBridge?.close().catch(() => {});
  }

  it('a pending bridge plan request suppresses the stdin send; without one stdin falls back', async () => {
    const { session } = await startSmokeSession();
    try {
      const sendSpy = mock(() => {});
      (session.claude as unknown as { sendMessage: unknown }).sendMessage = sendSpy;

      // Modern-CLI path: a bridge request is pending → the approval resolves
      // it and MUST NOT also send 'approved' over stdin (stray user message).
      const pending = session.messageManager!.handleBridgeRequest({
        kind: 'plan_approval',
        toolName: 'ExitPlanMode',
        input: { plan: 'p' },
      });
      session.messageManager!.events.emit('approval:complete', { toolUseId: 't1', approved: true });
      expect((await pending).behavior).toBe('allow');
      expect(sendSpy).not.toHaveBeenCalled();

      // Legacy path: nothing pending → the stdin fallback must still fire.
      session.messageManager!.events.emit('approval:complete', { toolUseId: 't2', approved: true });
      expect(sendSpy).toHaveBeenCalledWith('approved');
    } finally {
      await teardown(session);
    }
  });

  it('a denied plan resolves the bridge with deny (no stdin send)', async () => {
    const { session } = await startSmokeSession();
    try {
      const sendSpy = mock(() => {});
      (session.claude as unknown as { sendMessage: unknown }).sendMessage = sendSpy;

      const pending = session.messageManager!.handleBridgeRequest({
        kind: 'plan_approval',
        toolName: 'ExitPlanMode',
        input: { plan: 'p' },
      });
      session.messageManager!.events.emit('approval:complete', { toolUseId: 't1', approved: false });
      expect((await pending).behavior).toBe('deny');
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      await teardown(session);
    }
  });

  it('question answers resolve a pending bridge request instead of stdin, with fallback', async () => {
    const { session } = await startSmokeSession();
    try {
      const sendSpy = mock(() => {});
      (session.claude as unknown as { sendMessage: unknown }).sendMessage = sendSpy;

      const pending = session.messageManager!.handleBridgeRequest({
        kind: 'question',
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Red or blue?', header: 'Color', options: [] }] },
      });
      session.messageManager!.events.emit('question:complete', {
        toolUseId: 't1',
        answers: [{ header: 'Color', answer: 'Blue' }],
      });
      const decision = await pending;
      expect(decision.behavior).toBe('allow');
      expect((decision.updatedInput as { answers: unknown }).answers).toEqual({ 'Red or blue?': 'Blue' });
      expect(sendSpy).not.toHaveBeenCalled();

      // Legacy path: no pending request → answers go over stdin as JSON.
      session.messageManager!.events.emit('question:complete', {
        toolUseId: 't2',
        answers: [{ header: 'Color', answer: 'Red' }],
      });
      expect(sendSpy).toHaveBeenCalledWith(JSON.stringify([{ header: 'Color', answer: 'Red' }]));
    } finally {
      await teardown(session);
    }
  });
});

describe('resumeSession with direct channel mode', () => {
  // resumeSessionImpl drives all the way into ClaudeCli.start(), which spawns
  // the CLI binary. On dev machines the real `claude` exists (the test would
  // silently launch one); on CI runners it does not (ENOENT → red). Same shim
  // as the decision-bridge describe: point CLAUDE_PATH at a harmless
  // executable so the spawn succeeds without the real CLI.
  let prevClaudePath: string | undefined;
  beforeEach(() => {
    prevClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = ['/bin/sh', '/usr/bin/sh', '/bin/cat', '/usr/bin/cat']
      .find(p => existsSync(p)) ?? '/bin/sh';
  });
  afterEach(() => {
    if (prevClaudePath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = prevClaudePath;
  });

  function dcmState(threadId: string) {
    return {
      threadId,
      platformId: 'test-platform',
      claudeSessionId: 'claude-session-dcm',
      workingDir: process.cwd(),
      startedBy: 'alice',
      sessionAllowedUsers: ['alice'],
    } as any;
  }

  const dcmEnabled = { enabled: true, respondTo: 'all_messages' } as const;

  it('skips the thread-existence check for a synthetic DCM session id', async () => {
    // getPost resolves null (a real thread id would be treated as deleted).
    const getPost = mock(() => Promise.resolve(null));
    const platform = createMockPlatform({ getPost: getPost as any, directChannelMode: dcmEnabled as any });
    const ctx = createMockSessionContext(new Map());
    (ctx.state.platforms as Map<string, unknown>).set('test-platform', platform);

    await lifecycle.resumeSession(dcmState('dcm:test-platform'), ctx);

    // The synthetic id must never be looked up as a post, and resume must
    // get past the thread-existence gate to account acquisition. (Later
    // steps may still fail in this mocked environment — the gate is what
    // this test pins down.)
    expect(getPost).not.toHaveBeenCalled();
    expect(ctx.ops.acquireClaudeAccount).toHaveBeenCalled();
  });

  it('drops a persisted DCM session when direct channel mode was turned off', async () => {
    const platform = createMockPlatform({ getPost: mock(() => Promise.resolve(null)) as any });
    const ctx = createMockSessionContext(new Map());
    (ctx.state.platforms as Map<string, unknown>).set('test-platform', platform);

    await lifecycle.resumeSession(dcmState('dcm:test-platform'), ctx);

    expect(ctx.state.sessionStore.remove).toHaveBeenCalledWith('test-platform:dcm:test-platform');
    expect(ctx.ops.acquireClaudeAccount).not.toHaveBeenCalled();
  });

  it('still drops a regular session whose thread was deleted', async () => {
    const platform = createMockPlatform({ getPost: mock(() => Promise.resolve(null)) as any });
    const ctx = createMockSessionContext(new Map());
    (ctx.state.platforms as Map<string, unknown>).set('test-platform', platform);

    await lifecycle.resumeSession(dcmState('a1b2c3realthread'), ctx);

    expect(ctx.state.sessionStore.remove).toHaveBeenCalledWith('test-platform:a1b2c3realthread');
    expect(ctx.ops.acquireClaudeAccount).not.toHaveBeenCalled();
  });
});

describe('_inFlightSessionStarts (start dedup and retry hand-off)', () => {
  const KEY = 'test-platform:thread-123';

  afterEach(() => {
    lifecycle._inFlightSessionStarts.delete(KEY);
  });

  it('delivers a message arriving during an in-flight start as a follow-up', async () => {
    const mockMsgManager = createMockMessageManager();
    const session = createMockSession({ messageManager: mockMsgManager as any });
    const sessions = new Map([[KEY, session]]);
    const ctx = createMockSessionContext(sessions);

    // A start for this key is in flight and succeeds.
    let resolveStart!: () => void;
    lifecycle._inFlightSessionStarts.set(KEY, new Promise<void>((res) => { resolveStart = res; }));

    const call = lifecycle.startSession(
      { prompt: 'queued while starting' },
      'user',
      'User Name',
      'thread-123',
      'test-platform',
      ctx
    );
    resolveStart();
    await call;

    // Delivered as follow-up to the session the attempt registered — no
    // second attempt was placed into the in-flight map by this caller.
    expect(mockMsgManager.handleUserMessage).toHaveBeenCalledWith(
      'queued while starting',
      undefined,
      'user',
      'User Name'
    );
  });

  it('waits for a retry registered by another waiter after a failed attempt', async () => {
    const mockMsgManager = createMockMessageManager();
    const session = createMockSession({ messageManager: mockMsgManager as any });
    // The first attempt failed: no session registered yet.
    const sessions = new Map<string, any>();
    const ctx = createMockSessionContext(sessions as any);

    let rejectFirst!: (e: Error) => void;
    const firstAttempt = new Promise<void>((_, rej) => { rejectFirst = rej; });
    let resolveRetry!: () => void;
    const retryAttempt = new Promise<void>((res) => { resolveRetry = res; });

    // Simulates the OTHER waiter: on failure it synchronously registers its
    // retry, which succeeds shortly after and registers the session.
    const handoff = firstAttempt.catch(() => {
      lifecycle._inFlightSessionStarts.set(KEY, retryAttempt);
      setTimeout(() => {
        sessions.set(KEY, session);
        resolveRetry();
      }, 10);
    });

    lifecycle._inFlightSessionStarts.set(KEY, firstAttempt);
    const call = lifecycle.startSession(
      { prompt: 'queued behind retry' },
      'user',
      'User Name',
      'thread-123',
      'test-platform',
      ctx
    );

    rejectFirst(new Error('first attempt failed'));
    await handoff;
    await call;

    // The caller waited out BOTH attempts instead of fanning out its own
    // parallel retry, then delivered its message to the retried session.
    expect(mockMsgManager.handleUserMessage).toHaveBeenCalledWith(
      'queued behind retry',
      undefined,
      'user',
      'User Name'
    );
  });

  it('sendFollowUp waits for a registered-but-not-yet-running session when its start is in flight', async () => {
    const mockMsgManager = createMockMessageManager();
    const session = createMockSession({ messageManager: mockMsgManager as any });
    let running = false;
    (session.claude.isRunning as any).mockImplementation(() => running);
    const sessions = new Map([[KEY, session]]);
    const ctx = createMockSessionContext(sessions);

    // Session is registered, Claude still coming up, start in flight.
    lifecycle._inFlightSessionStarts.set(session.sessionId, new Promise<void>(() => {}));
    setTimeout(() => { running = true; }, 300);

    await lifecycle.sendFollowUp(session, 'early message', undefined, ctx, 'user', 'User Name');

    expect(mockMsgManager.handleUserMessage).toHaveBeenCalledWith(
      'early message',
      undefined,
      'user',
      'User Name'
    );
    lifecycle._inFlightSessionStarts.delete(session.sessionId);
  });
});

// =============================================================================
// Session-end audit causes — regression tests
// =============================================================================
// closeThreadLogger runs before removeFromRegistry on every teardown path, and
// auditSessionEnd's exactly-once guard makes the first writer win. Without the
// auditReason override the trail recorded the generic logger action ('kill',
// 'exit') and the precise cause ('timeout', 'exit:<code>', 'pause') was
// unreachable — exactly the distinction an audit log exists for.

describe('session end audit causes', () => {
  let auditDir: string;
  let prevAuditDir: string | undefined;

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), 'ct-audit-lc-'));
    prevAuditDir = process.env.CLAUDE_THREADS_AUDIT_DIR;
    process.env.CLAUDE_THREADS_AUDIT_DIR = auditDir;
    _resetAuditLog();
    configureAuditLog('test-platform', true);
  });

  afterEach(() => {
    if (prevAuditDir === undefined) delete process.env.CLAUDE_THREADS_AUDIT_DIR;
    else process.env.CLAUDE_THREADS_AUDIT_DIR = prevAuditDir;
    _resetAuditLog();
    rmSync(auditDir, { recursive: true, force: true });
  });

  /** All session_end entries — every test asserts exactly one is recorded. */
  function sessionEndEntries(): Array<{ kind: string; detail?: string }> {
    const file = join(auditDir, 'test-platform.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .filter(entry => entry.kind === 'session_end');
  }

  function expectSingleEndCause(detail: string): void {
    const ends = sessionEndEntries();
    expect(ends).toHaveLength(1);
    expect(ends[0].detail).toBe(detail);
  }

  /** An 'active' session as production creates it once Claude responded. */
  function activeSession(overrides?: Parameters<typeof createMockSession>[0]) {
    return createMockSession({
      platformId: 'test-platform',
      lifecycle: { state: 'active', resumeFailCount: 0, hasClaudeResponded: true },
      claude: {
        isRunning: mock(() => true),
        kill: mock(() => Promise.resolve()),
        start: mock(() => {}),
        sendMessage: mock(() => {}),
        on: mock(() => {}),
        interrupt: mock(() => {}),
        isPermanentFailure: mock(() => false),
        getPermanentFailureReason: mock(() => undefined),
      } as any,
      ...overrides,
    });
  }

  it('idle timeout records "timeout", not the generic "kill"', async () => {
    const session = activeSession({ lastActivityAt: new Date(Date.now() - 10_000) });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.cleanupIdleSessions(1_000, 500, ctx);

    expectSingleEndCause('timeout');
  });

  it('a non-zero exit of an active session records the exit code', async () => {
    const session = activeSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit('test-platform:thread-123', 2, ctx);

    expectSingleEndCause('exit:2');
  });

  it('a clean exit of an active session records plain "exit"', async () => {
    const session = activeSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit('test-platform:thread-123', 0, ctx);

    expectSingleEndCause('exit');
  });

  it('a signal death (code null) records plain "exit", not "exit:null"', async () => {
    const session = activeSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit('test-platform:thread-123', null as unknown as number, ctx);

    expectSingleEndCause('exit');
  });

  it('a user kill still records "kill"', async () => {
    const session = createMockSession({ platformId: 'test-platform' });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.killSession(session, true, ctx);

    expectSingleEndCause('kill');
  });

  it('an interrupt-pause records "pause"', async () => {
    const session = createMockSession({
      platformId: 'test-platform',
      wasInterrupted: true,
      hasClaudeResponded: true,
    });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit('test-platform:thread-123', 0, ctx);

    expectSingleEndCause('pause');
  });

  it('a graceful shutdown records "shutdown", not "exit"', async () => {
    const session = activeSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);
    (ctx.state as { isShuttingDown: boolean }).isShuttingDown = true;

    await lifecycle.handleExit('test-platform:thread-123', 0, ctx);

    expectSingleEndCause('shutdown');
  });

  it('an exit before Claude responded records "early-exit"', async () => {
    const session = createMockSession({ platformId: 'test-platform' });
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.handleExit('test-platform:thread-123', 1, ctx);

    expectSingleEndCause('early-exit');
  });

  it('emergency killAllSessions records "kill" per session', async () => {
    const session = activeSession();
    const sessions = new Map([['test-platform:thread-123', session]]);
    const ctx = createMockSessionContext(sessions);

    await lifecycle.killAllSessions(ctx);

    expectSingleEndCause('kill');
  });
});

// =============================================================================
// Attachments are built once on the start path (docs/audio-transcription-spec.md)
// =============================================================================

describe('startSession builds attachments once', () => {
  // Same harness as the decision-bridge tests: point ClaudeCli.start() at a
  // harmless executable so startSession runs to the send/queue branch.
  let prevClaudePath: string | undefined;
  beforeEach(() => {
    prevClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = ['/bin/sh', '/usr/bin/sh', '/bin/cat', '/usr/bin/cat']
      .find(p => existsSync(p)) ?? '/bin/sh';
  });
  afterEach(() => {
    if (prevClaudePath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = prevClaudePath;
  });

  function harness() {
    const platform = createMockPlatform({
      isUserAllowed: mock(() => true) as any,
      getMcpConfig: mock(() => ({
        type: 'mattermost',
        url: 'https://chat.example.com',
        token: 't',
        channelId: 'c',
        allowedUsers: ['alice'],
      })) as any,
    });
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);
    (ctx.config as { workingDir: string }).workingDir = '/tmp';
    (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);
    return { platform, sessions, ctx };
  }

  async function teardown(sessions: Map<string, Session>) {
    for (const session of sessions.values()) {
      await session.claude.kill().catch(() => {});
      session.messageManager?.dispose();
      await session.decisionBridge?.close().catch(() => {});
    }
  }

  it('a thread start hands the raw prompt and files to offerContextPrompt without building content first', async () => {
    const { sessions, ctx } = harness();
    const files = [{ id: 'F1', name: 'voice.webm', size: 3, mimeType: 'audio/webm' }];

    await lifecycle.startSession(
      { prompt: 'listen to this', files },
      'alice',
      'Alice',
      'thread-voice',
      'test-platform',
      ctx,
      'msg-trigger',
    );

    try {
      expect(ctx.ops.buildMessageContent).not.toHaveBeenCalled();
      expect(ctx.ops.offerContextPrompt).toHaveBeenCalledTimes(1);
      const [, queuedPrompt, queuedFiles] = (ctx.ops.offerContextPrompt as any).mock.calls[0];
      expect(queuedPrompt).toBe('listen to this');
      expect(queuedFiles).toBe(files);
    } finally {
      await teardown(sessions);
    }
  });

  it('a direct-channel start builds content exactly once and echoes the transcript into the channel', async () => {
    const { platform, sessions, ctx } = harness();
    const dcmThreadId = 'dcm:test-platform';
    (ctx.ops.buildMessageContent as any).mockImplementation(() => Promise.resolve({
      content: 'built once',
      skipped: [],
      transcripts: [{ name: 'voice.webm', provider: 'elevenlabs', text: 'rerun the backfill' }],
    }));

    await lifecycle.startSession(
      { prompt: 'listen to this', files: [{ id: 'F1', name: 'voice.webm', size: 3, mimeType: 'audio/webm' }] },
      'alice',
      'Alice',
      dcmThreadId,
      'test-platform',
      ctx,
    );

    try {
      expect(ctx.ops.buildMessageContent).toHaveBeenCalledTimes(1);
      expect(ctx.ops.offerContextPrompt).not.toHaveBeenCalled();
      expect(platform.createPost).toHaveBeenCalledWith(
        '🎙️ **Transcript of voice.webm:**\n> rerun the backfill',
        dcmThreadId,
      );
    } finally {
      await teardown(sessions);
    }
  });
});

// =============================================================================
// Context-prompt reaction route keeps the queued attachments
// =============================================================================

describe('context-prompt reaction route keeps queued attachments', () => {
  let prevClaudePath: string | undefined;
  beforeEach(() => {
    prevClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = ['/bin/sh', '/usr/bin/sh', '/bin/cat', '/usr/bin/cat']
      .find(p => existsSync(p)) ?? '/bin/sh';
  });
  afterEach(() => {
    if (prevClaudePath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = prevClaudePath;
  });

  async function waitFor(condition: () => boolean, attempts = 50): Promise<void> {
    for (let i = 0; i < attempts && !condition(); i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  it('files parked behind a context prompt are built, and their transcript echoed, when the user picks an option', async () => {
    const platform = createMockPlatform({
      isUserAllowed: mock(() => true) as any,
      getMcpConfig: mock(() => ({ type: 'mattermost', url: 'https://chat.example.com', token: 't', channelId: 'c', allowedUsers: ['alice'] })) as any,
      // Enough thread history that offerContextPrompt posts the prompt and parks the files
      getThreadHistory: mock(() => Promise.resolve([
        { id: 'm1', userId: 'u', username: 'bob', message: 'one', createAt: 1 },
        { id: 'm2', userId: 'u', username: 'bob', message: 'two', createAt: 2 },
        { id: 'm3', userId: 'u', username: 'bob', message: 'three', createAt: 3 },
      ])) as any,
    });
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);
    (ctx.config as { workingDir: string }).workingDir = '/tmp';
    (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);
    const files = [{ id: 'F1', name: 'voice.webm', size: 3, mimeType: 'audio/webm' }];

    await lifecycle.startSession({ prompt: 'listen', files }, 'alice', 'Alice', 'thread-deferred', 'test-platform', ctx, 'msg-trigger');
    const session = sessions.get('test-platform:thread-deferred')!;
    try {
      // Park the files exactly as production does: the real offerContextPrompt
      // with thread history posts the prompt and keeps the PlatformFile[] aside.
      const posted = await offerContextPromptReal(session, 'listen', files, {
        registerPost: ctx.ops.registerPost,
        startTyping: ctx.ops.startTyping,
        persistSession: ctx.ops.persistSession,
        injectMetadataReminder: (message) => message,
        buildMessageContent: (text, s, f) => ctx.ops.buildMessageContent(text, s.platform, '/tmp', f),
      }, 'msg-trigger', 'alice');
      expect(posted).toBe(true);

      (ctx.ops.buildMessageContent as any).mockClear();
      (ctx.ops.buildMessageContent as any).mockImplementation(() => Promise.resolve({
        content: 'built',
        skipped: [],
        transcripts: [{ name: 'voice.webm', provider: 'elevenlabs', text: 'hello from the deferred path' }],
      }));

      // The user reacts: the prompt executor emits completion with simplified refs only.
      session.messageManager!.events.emit('context-prompt:complete', {
        selection: 0,
        queuedPrompt: 'listen',
        queuedByUsername: 'alice',
        queuedFiles: [{ id: 'F1', name: 'voice.webm' }],
        threadMessageCount: 3,
      });
      await waitFor(() => (platform.createPost as any).mock.calls.some((c: unknown[]) => String(c[0]).startsWith('🎙️')));

      expect(ctx.ops.buildMessageContent).toHaveBeenCalledTimes(1);
      const [, , , filesArg] = (ctx.ops.buildMessageContent as any).mock.calls[0];
      expect(filesArg).toBe(files);
      expect(platform.createPost).toHaveBeenCalledWith('🎙️ **Transcript of voice.webm:**\n> hello from the deferred path', 'thread-deferred');
    } finally {
      await session.claude.kill().catch(() => {});
      session.messageManager?.dispose();
      await session.decisionBridge?.close().catch(() => {});
    }
  });
});

describe('context-prompt reaction route survives a failed feedback post', () => {
  let prevClaudePath: string | undefined;
  beforeEach(() => {
    prevClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = ['/bin/sh', '/usr/bin/sh', '/bin/cat', '/usr/bin/cat']
      .find(p => existsSync(p)) ?? '/bin/sh';
  });
  afterEach(() => {
    if (prevClaudePath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = prevClaudePath;
  });

  async function waitFor(condition: () => boolean, attempts = 50): Promise<void> {
    for (let i = 0; i < attempts && !condition(); i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  it('a rejected transcript echo is reported in the thread and the session state still advances', async () => {
    const platform = createMockPlatform({
      isUserAllowed: mock(() => true) as any,
      getMcpConfig: mock(() => ({ type: 'mattermost', url: 'https://chat.example.com', token: 't', channelId: 'c', allowedUsers: ['alice'] })) as any,
      // The transcript echo fails (rate limit, network); every other post succeeds
      createPost: mock((text: string) => text.startsWith('🎙️')
        ? Promise.reject(new Error('slack says no: ratelimited'))
        : Promise.resolve({ id: 'post-1', message: '', userId: 'bot' })) as any,
    });
    const sessions = new Map<string, Session>();
    const ctx = createMockSessionContext(sessions);
    (ctx.config as { workingDir: string }).workingDir = '/tmp';
    (ctx.state.platforms as Map<string, PlatformClient>).set('test-platform', platform);

    await lifecycle.startSession({ prompt: 'listen' }, 'alice', 'Alice', 'thread-flaky', 'test-platform', ctx, 'msg-trigger');
    const session = sessions.get('test-platform:thread-flaky')!;
    try {
      (ctx.ops.persistSession as any).mockClear();
      (ctx.ops.buildMessageContent as any).mockImplementation(() => Promise.resolve({
        content: 'built',
        skipped: [],
        transcripts: [{ name: 'voice.webm', provider: 'elevenlabs', text: 'hello' }],
      }));

      session.messageManager!.events.emit('context-prompt:complete', {
        selection: 0,
        queuedPrompt: 'listen',
        queuedByUsername: 'alice',
        queuedFiles: undefined,
        threadMessageCount: 3,
      });
      await waitFor(() => (ctx.ops.persistSession as any).mock.calls.length > 0);

      const posts = (platform.createPost as any).mock.calls.map((c: unknown[]) => String(c[0]));
      expect(posts.some((p: string) => p.includes('Send queued message after context prompt failed') && p.includes('ratelimited'))).toBe(true);
      expect(ctx.ops.persistSession).toHaveBeenCalled();
    } finally {
      await session.claude.kill().catch(() => {});
      session.messageManager?.dispose();
      await session.decisionBridge?.close().catch(() => {});
    }
  });
});
