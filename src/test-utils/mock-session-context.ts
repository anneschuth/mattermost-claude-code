/**
 * Shared mock SessionContext for unit tests. Extracted from
 * lifecycle.test.ts and commands/handler.test.ts, which carried
 * byte-identical 96-line copies.
 */

import { mock } from 'bun:test';
import type { Session } from '../session/types.js';
import type { SessionContext } from '../operations/session-context/index.js';

/**
 * The two source files' platform mocks genuinely differ (e.g. isUserAllowed
 * true vs false), so the platform stays injected — each test file passes its
 * own factory through a thin local wrapper.
 */
export function createMockSessionContext(makePlatform: () => import('../platform/index.js').PlatformClient, sessions: Map<string, Session> = new Map()): SessionContext {
  // One raw map behind both lookups, modelled on the real store: `load()`
  // returns the visible subset (soft-deleted records filtered out), the
  // any-state scan returns everything.
  //
  // ⚠️ Deriving the any-state scan FROM `load()` would be the tempting
  // shortcut and is the one thing this mock must not do: the two lookups
  // could then never disagree, and "the two lookups disagreed" is precisely
  // the bug class that made a thread unreachable in both directions. A mock
  // that cannot express the bug cannot catch its return.
  // Tests seed this store by stubbing `load()`, so the any-state scan derives
  // from it: a record a test made visible is also findable raw, which is true
  // of the real store too.
  //
  // ⚠️ What this default CANNOT express is the two lookups disagreeing — a
  // soft-deleted record that `load()` hides and the raw scan still returns.
  // That divergence is the whole bug class, so any test about it MUST override
  // `findByThreadIdAnyState` explicitly rather than trust this default (see
  // `contextWithTombstone` in lifecycle.test.ts).
  const load = mock(() => new Map());
  const findByThreadIdAnyState = mock((threadId: string, platformId?: string) => {
    for (const persisted of load().values()) {
      const s = persisted as { threadId: string; platformId: string };
      if (s.threadId !== threadId) continue;
      if (platformId !== undefined && s.platformId !== platformId) continue;
      return persisted;
    }
    return undefined;
  });

  return {
    config: {
      workingDir: '/test',
      permissionMode: 'bypass',
      chromeEnabled: false,
      debug: false,
      maxSessions: 5,
    },
    state: {
      sessions,
      postIndex: new Map(),
      platforms: new Map([['test-platform', makePlatform()]]),
      sessionStore: {
        save: mock(() => {}),
        remove: mock(() => {}),
        getAll: mock(() => []),
        get: mock(() => null),
        cleanStale: mock(() => []),
        saveStickyPostId: mock(() => {}),
        getStickyPostId: mock(() => null),
        load,
        findByPostId: mock(() => undefined),
        findByThreadIdAnyState,
      } as unknown as SessionContext['state']['sessionStore'],
      githubEmailsStore: {
        get: mock(() => undefined),
        set: mock(() => {}),
        delete: mock(() => false),
      } as unknown as SessionContext['state']['githubEmailsStore'],
      memoryStore: {
        buildChannelMemoryBlock: mock(() => null),
        listChannelEntries: mock(() => []),
        addChannelEntries: mock(() => Promise.resolve({ added: [], duplicates: [], superseded: [] })),
        forgetChannelEntry: mock(() => Promise.resolve({ ok: false, reason: 'empty', matches: [] })),
        clearChannel: mock(() => Promise.resolve()),
        repoMemoryDir: mock(() => '/tmp/test-memory'),
      } as unknown as SessionContext['state']['memoryStore'],
      routinesStore: {
        list: mock(() => []),
        get: mock(() => undefined),
        add: mock(() => Promise.resolve({ ok: true, routine: {} })),
        update: mock(() => Promise.resolve(undefined)),
        remove: mock(() => Promise.resolve(undefined)),
      } as unknown as SessionContext['state']['routinesStore'],
      watchesStore: {
        list: mock(() => []),
        get: mock(() => undefined),
        add: mock(() => Promise.resolve({ ok: true, watch: {} })),
        update: mock(() => Promise.resolve(undefined)),
        remove: mock(() => Promise.resolve(undefined)),
      } as unknown as SessionContext['state']['watchesStore'],
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
      updateStickyMessage: mock(() => Promise.resolve()),
      updateSessionHeader: mock(() => Promise.resolve()),
      persistSession: mock(() => {}),
      unpersistSession: mock(() => {}),
      recordSessionStarted: mock(() => {}),
      shouldPromptForWorktree: mock(() => Promise.resolve(null)),
      postWorktreePrompt: mock(() => Promise.resolve()),
      buildMessageContent: mock((prompt: string) => Promise.resolve({ content: prompt, skipped: [] })),
      offerContextPrompt: mock(() => Promise.resolve(false)),
      killSession: mock(() => Promise.resolve()),
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
