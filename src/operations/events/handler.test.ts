/**
 * Tests for events.ts - Pre/post processing and session-specific side effects
 *
 * NOTE: Main event handling (formatting, tool handling) is now tested in
 * src/operations/ tests. This file tests session-specific side effects that
 * wrap the MessageManager.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { configureAuditLog, _resetAuditLog } from '../../persistence/audit-log.js';
import {
  handleEventPreProcessing,
  handleEventPostProcessing,
} from './handler.js';
import type { SessionContext } from '../session-context/index.js';
import type { Session } from '../../session/types.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';
import type { PlatformClient, PlatformPost } from '../../platform/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

// Mock platform client
function createMockPlatform() {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  const mockPlatform = {
    getBotUser: mock(async () => ({
      id: 'bot',
      username: 'bot',
      displayName: 'Bot',
    })),
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
    pinPost: mock(async (_postId: string): Promise<void> => {}),
    unpinPost: mock(async (_postId: string): Promise<void> => {}),
    sendTyping: mock(() => {}),
    getFormatter: () => createMockFormatter(),
    getThreadHistory: mock(async (_threadId: string, _options?: { limit?: number }) => {
      return [];
    }),
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
    claude: {
      isRunning: () => true,
      sendMessage: mock(() => {}),
      getStatusData: () => null,
    } as any,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    respondOnlyWhenMentioned: false,
    userAttribution: false,
    sessionStartPostId: 'start_post',
    sessionHeaderMode: 'full',
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    timeoutWarningPosted: false,
    messageCount: 0,
    isProcessing: false,
    recentEvents: [],
    messageManager: undefined,
  };
}

function createSessionContext(): SessionContext {
  return {
    config: {
      debug: false,
      workingDir: '/test',
      permissionMode: 'bypass',
      chromeEnabled: false,
      maxSessions: 5,
    },
    state: {
      sessions: new Map(),
      postIndex: new Map(),
      platforms: new Map(),
      sessionStore: { save: () => {}, remove: () => {}, load: () => new Map(), findByPostId: () => undefined, cleanStale: () => [] } as any,
      githubEmailsStore: { get: () => undefined, set: () => {}, delete: () => false } as any,
      memoryStore: { buildChannelMemoryBlock: () => null, listChannelEntries: () => [] } as any,
      routinesStore: {
        list: mock(() => []),
        get: mock(() => undefined),
        add: mock(() => Promise.resolve({ ok: true, routine: {} })),
        update: mock(() => Promise.resolve(undefined)),
        remove: mock(() => Promise.resolve(undefined)),
      } as any,
      watchesStore: {
        list: mock(() => []),
        get: mock(() => undefined),
        add: mock(() => Promise.resolve({ ok: true, watch: {} })),
        update: mock(() => Promise.resolve(undefined)),
        remove: mock(() => Promise.resolve(undefined)),
      } as any,
      isShuttingDown: false,
    },
    ops: {
      getSessionId: (_p, t) => t,
      findSessionByThreadId: () => undefined,
      registerPost: mock((_postId: string, _threadId: string) => {}),
      flush: mock(async (_session: Session) => {}),
      startTyping: mock((_session: Session) => {}),
      stopTyping: mock((_session: Session) => {}),
      updateStickyMessage: mock(async () => {}),
      persistSession: mock((_session: Session) => {}),
      updateSessionHeader: mock(async (_session: Session) => {}),
      unpersistSession: mock((_sessionId: string) => {}),
      recordSessionStarted: mock(() => {}),
      buildMessageContent: mock(async (text: string) => ({ content: text, skipped: [] })),
      handleEvent: mock((_sessionId: string, _event: any) => {}),
      handleExit: mock(async (_sessionId: string, _code: number) => {}),
      killSession: mock(async (_threadId: string) => {}),
      shouldPromptForWorktree: mock(async (_session: Session) => null),
      postWorktreePrompt: mock(async (_session: Session, _reason: string) => {}),
      offerContextPrompt: mock(async (_session: Session, _queuedPrompt: string) => false),
      emitSessionAdd: mock(() => {}),
      emitSessionUpdate: mock(() => {}),
      emitSessionRemove: mock(() => {}),
      registerWorktreeUser: mock(() => {}),
      unregisterWorktreeUser: mock(() => {}),
      hasOtherSessionsUsingWorktree: mock(() => false),
      switchToWorktree: mock(async () => {}),
      forceUpdate: mock(async () => {}),
      deferUpdate: mock(() => {}),
      handleBugReportApproval: mock(async () => {}),
      acquireClaudeAccount: mock(() => null),
      getClaudeAccount: mock(() => undefined),
      releaseClaudeAccount: mock(() => {}),
      refreshClaudeAccountUsage: mock(async () => {}),
      markClaudeAccountCooling: mock(() => {}),
      getClaudeAccountPoolStatus: mock(() => []),
      getPlatformOverhead: mock(() => ({ sessionHeader: 'full' as const, stickyMessage: 'full' as const, turnMarker: { mode: 'off' as const } })),
      getPlatformMemoryConfig: mock(() => ({ enabled: false, repoLayer: false, channelLayer: false, distillation: false })),
      isRoutinesEnabled: mock(() => true),
      isWatchesEnabled: mock(() => true),
      fireRoutineNow: mock(() => Promise.resolve('ok' as const)),
    },
  };
}

describe('handleEventPreProcessing audit tap', () => {
  let dir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-audit-tap-'));
    prevDir = process.env.CLAUDE_THREADS_AUDIT_DIR;
    process.env.CLAUDE_THREADS_AUDIT_DIR = dir;
    _resetAuditLog();
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.CLAUDE_THREADS_AUDIT_DIR;
    else process.env.CLAUDE_THREADS_AUDIT_DIR = prevDir;
    _resetAuditLog();
    rmSync(dir, { recursive: true, force: true });
  });

  test('records tool_use blocks from assistant events when enabled', () => {
    const platform = createMockPlatform();
    const session = createTestSession(platform);
    const ctx = createSessionContext();
    configureAuditLog(session.platformId, true);

    handleEventPreProcessing(session, {
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'running' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      ] },
    } as never, ctx);

    const lines = readFileSync(join(dir, `${session.platformId}.jsonl`), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.kind).toBe('tool_use');
    expect(rec.tool).toBe('Bash');
    expect(rec.detail).toBe('ls -la');
    expect(rec.actor).toBe(session.startedBy);
    expect(rec.subagent).toBeUndefined();
  });

  test('marks subagent sidechain tool calls', () => {
    const platform = createMockPlatform();
    const session = createTestSession(platform);
    const ctx = createSessionContext();
    configureAuditLog(session.platformId, true);

    handleEventPreProcessing(session, {
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] },
    } as never, ctx);

    const rec = JSON.parse(readFileSync(join(dir, `${session.platformId}.jsonl`), 'utf-8').trim());
    expect(rec.subagent).toBe(true);
  });

  test('writes nothing when the platform is not enabled', () => {
    const platform = createMockPlatform();
    const session = createTestSession(platform);
    const ctx = createSessionContext();

    handleEventPreProcessing(session, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    } as never, ctx);

    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe('handleEventPreProcessing', () => {
  let platform: PlatformClient;
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
  });

  test('resets session activity on any event', () => {
    const oldTime = new Date(Date.now() - 10000);
    session.lastActivityAt = oldTime;

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    expect(session.lastActivityAt.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  test('sets hasClaudeResponded on first assistant event', () => {
    expect(session.lifecycle.hasClaudeResponded).toBe(false);

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    expect(session.lifecycle.hasClaudeResponded).toBe(true);
    expect(ctx.ops.persistSession).toHaveBeenCalled();
  });

  test('sets hasClaudeResponded on first tool_use event', () => {
    expect(session.lifecycle.hasClaudeResponded).toBe(false);

    handleEventPreProcessing(session, { type: 'tool_use', tool_use: { name: 'Read' } }, ctx);

    expect(session.lifecycle.hasClaudeResponded).toBe(true);
  });

  test('does not set hasClaudeResponded again if already set', () => {
    session.lifecycle.hasClaudeResponded = true;
    const callCount = (ctx.ops.persistSession as ReturnType<typeof mock>).mock.calls.length;

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    // Should not persist again
    expect((ctx.ops.persistSession as ReturnType<typeof mock>).mock.calls.length).toBe(callCount);
  });

  test('captures slash_commands from init event', () => {
    expect(session.availableSlashCommands).toBeUndefined();

    const initEvent = {
      type: 'system',
      subtype: 'init',
      slash_commands: ['compact', 'context', 'cost', 'init', 'review', 'security-review'],
    };

    handleEventPreProcessing(session, initEvent, ctx);

    expect(session.availableSlashCommands).toBeDefined();
    expect(session.availableSlashCommands?.size).toBe(6);
    expect(session.availableSlashCommands?.has('compact')).toBe(true);
    expect(session.availableSlashCommands?.has('review')).toBe(true);
  });

  test('handles slash_commands with leading slashes', () => {
    const initEvent = {
      type: 'system',
      subtype: 'init',
      slash_commands: ['/compact', '/context', '/cost'],
    };

    handleEventPreProcessing(session, initEvent, ctx);

    expect(session.availableSlashCommands?.size).toBe(3);
    // Leading slashes should be stripped
    expect(session.availableSlashCommands?.has('compact')).toBe(true);
    expect(session.availableSlashCommands?.has('/compact')).toBe(false);
  });

  test('a fast failure still resolves the start post (status events in one chunk, slow platform)', async () => {
    // Repro from review: both status lines can arrive in ONE stdout chunk
    // (dispatched back-to-back synchronously) while the platform post takes
    // 50-300ms. The failure handler must await the in-flight start post and
    // update IT — not post a second message while the first lands late and
    // stays stale forever.
    const rawCreate = platform.createPost;
    (platform as unknown as { createPost: unknown }).createPost = mock(async (message: string, threadId?: string) => {
      await new Promise((r) => setTimeout(r, 25));
      return (rawCreate as (m: string, t?: string) => Promise<PlatformPost>)(message, threadId);
    });

    // Back-to-back synchronous dispatch, like one stdout chunk
    handleEventPreProcessing(session, { type: 'system', subtype: 'status', status: 'compacting' }, ctx);
    handleEventPreProcessing(session, {
      type: 'system', subtype: 'status', status: null,
      compact_result: 'failed', compact_error: 'Not enough messages to compact.',
    }, ctx);
    await new Promise((r) => setTimeout(r, 150));

    const posts = (platform as unknown as { posts: Map<string, string> }).posts;
    const values = [...posts.values()];
    // Exactly one compaction-related post, resolved to the failure state
    const compactionPosts = values.filter((m) => /Compact/i.test(m));
    expect(compactionPosts).toHaveLength(1);
    expect(compactionPosts[0]).toMatch(/failed/i);
    expect(session.compactionPostId).toBeUndefined();
  });

  test('compact failure updates the compaction post instead of leaving it stale', async () => {
    // Real sequence captured from CLI 2.1.226 (compact.jsonl + a failed
    // /compact probe): status "compacting" → status {compact_result:
    // "failed", compact_error} with NO compact_boundary. The start post
    // must not stay at "Compacting context..." forever.
    handleEventPreProcessing(session, { type: 'system', subtype: 'status', status: 'compacting' }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(session.compactionPostId).toBeDefined();
    const postId = session.compactionPostId!;

    handleEventPreProcessing(session, {
      type: 'system', subtype: 'status', status: null,
      compact_result: 'failed', compact_error: 'Not enough messages to compact.',
    }, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const posts = (platform as unknown as { posts: Map<string, string> }).posts;
    expect(posts.get(postId)).toMatch(/failed/i);
    expect(posts.get(postId)).toContain('Not enough messages to compact.');
    expect(session.compactionPostId).toBeUndefined();
  });

  test('compact completion shows pre → post token counts', async () => {
    handleEventPreProcessing(session, { type: 'system', subtype: 'status', status: 'compacting' }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    const postId = session.compactionPostId!;

    handleEventPreProcessing(session, {
      type: 'system', subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 31103, post_tokens: 2777 },
    }, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const posts = (platform as unknown as { posts: Map<string, string> }).posts;
    expect(posts.get(postId)).toMatch(/31k.*→.*3k/);
    expect(session.compactionPostId).toBeUndefined();
  });

  test('auth_status with an error posts a warning to the thread', async () => {
    handleEventPreProcessing(session, {
      type: 'auth_status', isAuthenticating: false,
      output: [], error: 'OAuth token expired',
    }, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const posts = (platform as unknown as { posts: Map<string, string> }).posts;
    const warning = [...posts.values()].find((m) => /OAuth token expired/.test(m));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/auth/i);
  });

  test('auth_status warnings dedupe repeated identical errors', async () => {
    const ev = {
      type: 'auth_status', isAuthenticating: false,
      output: [], error: 'OAuth token expired',
    };
    handleEventPreProcessing(session, ev, ctx);
    handleEventPreProcessing(session, ev, ctx);
    handleEventPreProcessing(session, ev, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const posts = (platform as unknown as { posts: Map<string, string> }).posts;
    expect([...posts.values()].filter((m) => /OAuth token expired/.test(m))).toHaveLength(1);

    // A DIFFERENT error posts again
    handleEventPreProcessing(session, { ...ev, error: 'API key revoked' }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect([...posts.values()].filter((m) => /API key revoked/.test(m))).toHaveLength(1);
  });

  test('auth_status without an error is log-only (no thread post)', async () => {
    handleEventPreProcessing(session, {
      type: 'auth_status', isAuthenticating: true, output: ['Refreshing credentials...'],
    }, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const posts = (platform as unknown as { posts: Map<string, string> }).posts;
    expect(posts.size).toBe(0);
  });

  test('ignores init event without slash_commands', () => {
    const initEvent = {
      type: 'system',
      subtype: 'init',
      // No slash_commands field
    };

    handleEventPreProcessing(session, initEvent, ctx);

    expect(session.availableSlashCommands).toBeUndefined();
  });
});

describe('handleEventPostProcessing', () => {
  let platform: PlatformClient;
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
    // Post-processing runs on registered sessions; the deferred turn-end
    // persist checks this registration to avoid resurrecting torn-down ones.
    (ctx.state.sessions as Map<string, Session>).set(session.sessionId, session);
  });

  test('stops typing on result event', () => {
    handleEventPostProcessing(session, { type: 'result' }, ctx);

    expect(ctx.ops.stopTyping).toHaveBeenCalled();
    expect(session.isProcessing).toBe(false);
  });

  test('extracts PR URL from assistant text', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [{
          type: 'text',
          text: 'Created PR: https://github.com/user/repo/pull/123',
        }],
      },
    };

    handleEventPostProcessing(session, event, ctx);

    expect(session.pullRequestUrl).toBe('https://github.com/user/repo/pull/123');
    expect(ctx.ops.persistSession).toHaveBeenCalled();
  });

  test('does not overwrite existing PR URL', () => {
    session.pullRequestUrl = 'https://github.com/user/repo/pull/100';

    const event = {
      type: 'assistant' as const,
      message: {
        content: [{
          type: 'text',
          text: 'Created PR: https://github.com/user/repo/pull/200',
        }],
      },
    };

    handleEventPostProcessing(session, event, ctx);

    expect(session.pullRequestUrl).toBe('https://github.com/user/repo/pull/100');
  });

  // NOTE: Subagent toggle reaction tests have been moved to subagent.test.ts
  // since that functionality is now handled by SubagentExecutor via MessageManager

  // NOTE: postCurrentQuestion tests have been removed - question posting now
  // goes through QuestionApprovalExecutor via MessageManager

  test('result events persist the session (task tracker state reaches disk each turn)', () => {
    handleEventPostProcessing(session, {
      type: 'result', total_cost_usd: 0.1,
      modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000, costUSD: 0.1 } },
    }, ctx);
    expect(ctx.ops.persistSession).toHaveBeenCalled();
  });

  test('result events persist AFTER the main event handling settles (post-finalize snapshot)', async () => {
    // The StatusUpdateOp from a result event runs taskListExecutor.finalize()
    // inside MessageManager.handleEvent's promise — deleting an incomplete
    // task post and nulling its state. Persisting before that promise settles
    // snapshots exactly the state finalize is about to invalidate: a
    // tasksPostId pointing at a deleted post. So the persist must wait for
    // the main handling to settle.
    let resolveMain!: () => void;
    const mainHandling = new Promise<void>((r) => { resolveMain = r; });

    handleEventPostProcessing(session, {
      type: 'result', total_cost_usd: 0.1,
      modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000, costUSD: 0.1 } },
    }, ctx, mainHandling);

    // Not yet: the op chain (incl. finalize) hasn't settled
    expect(ctx.ops.persistSession).not.toHaveBeenCalled();

    resolveMain();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.ops.persistSession).toHaveBeenCalledTimes(1);
  });

  test('deferred persist is skipped when the session was torn down while main handling settled', async () => {
    // Race seen in CI: the CLI exits milliseconds after its result event, so
    // handleExit (removeFromRegistry + softDelete) runs before the deferred
    // turn-end persist lands. Persisting then would re-save the soft-deleted
    // record as active — resurrecting the session, so a later plain reply in
    // the thread resumes a session the bot just ended (the "should ignore
    // side conversations" integration flake).
    let resolveMain!: () => void;
    const mainHandling = new Promise<void>((r) => { resolveMain = r; });

    handleEventPostProcessing(session, {
      type: 'result', total_cost_usd: 0.1,
      modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000, costUSD: 0.1 } },
    }, ctx, mainHandling);

    // Session teardown wins the race: unregistered before mainHandling settles
    (ctx.state.sessions as Map<string, Session>).delete(session.sessionId);

    resolveMain();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.ops.persistSession).not.toHaveBeenCalled();
  });

  test('result events still persist when the main handling rejects', async () => {
    const mainHandling = Promise.reject(new Error('op chain blew up'));
    handleEventPostProcessing(session, {
      type: 'result', total_cost_usd: 0.1,
      modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000, costUSD: 0.1 } },
    }, ctx, mainHandling);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.ops.persistSession).toHaveBeenCalledTimes(1);
  });

  describe('current model tracking (/model switches)', () => {
    const resultWith = (modelUsage: Record<string, object>) => ({
      type: 'result' as const,
      total_cost_usd: 1,
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 5 },
      modelUsage,
    });
    const usage = (costUSD: number, contextWindow = 200000) => ({
      inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 0, contextWindow, costUSD,
    });

    test('init events capture the current model onto the session', () => {
      handleEventPreProcessing(session, {
        type: 'system', subtype: 'init', model: 'claude-sonnet-5', slash_commands: [],
      }, ctx);
      expect(session.currentModel).toBe('claude-sonnet-5');
    });

    test('usage stats prefer the current model over the highest-cost one', () => {
      // After a /model switch the OLD model has the larger cumulative cost —
      // the header must show what the session runs NOW, not what it spent
      // the most on. init.model (re-emitted per turn, see captures) is the
      // authoritative current model.
      session.currentModel = 'claude-sonnet-5';
      handleEventPostProcessing(session, resultWith({
        'claude-haiku-4-5-20251001': usage(5.0),
        'claude-sonnet-5': usage(0.01, 200000),
      }), ctx);

      expect(session.usageStats?.primaryModel).toBe('claude-sonnet-5');
      expect(session.usageStats?.modelDisplayName).toBe('Sonnet 5');
    });

    test('falls back to highest cost when no current model is known', () => {
      handleEventPostProcessing(session, resultWith({
        'claude-haiku-4-5-20251001': usage(5.0),
        'claude-sonnet-5': usage(0.01),
      }), ctx);
      expect(session.usageStats?.primaryModel).toBe('claude-haiku-4-5-20251001');
      expect(session.usageStats?.modelDisplayName).toBe('Haiku 4.5');
    });

    test('display names cover the Claude 5 family and dated ids', () => {
      const cases: Array<[string, string]> = [
        ['claude-fable-5', 'Fable 5'],
        ['claude-sonnet-5', 'Sonnet 5'],
        ['claude-opus-5', 'Opus 5'],
        ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
        ['claude-opus-4-5-20251101', 'Opus 4.5'],
        // Dated ids WITHOUT a minor: the optional minor group must not
        // swallow the date (review round caught "Sonnet 4.20250514")
        ['claude-sonnet-4-20250514', 'Sonnet 4'],
        ['claude-opus-4-20250514', 'Opus 4'],
        // Legacy version-first ids keep their family-only rendering
        ['claude-3-7-sonnet-20250219', 'Sonnet'],
      ];
      for (const [id, expected] of cases) {
        const fresh = createTestSession(platform);
        handleEventPostProcessing(fresh, resultWith({ [id]: usage(1.0) }), ctx);
        expect(fresh.usageStats?.modelDisplayName).toBe(expected);
      }
    });
  });
});
