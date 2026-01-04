import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore, PersistedSession } from './session-store.js';

describe('SessionStore', () => {
  let store: SessionStore;

  // Helper to create a test session
  function createTestSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
    return {
      platformId: 'test-platform',
      threadId: 'thread-123',
      claudeSessionId: 'uuid-456',
      startedBy: 'testuser',
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      sessionNumber: 1,
      workingDir: '/tmp/test',
      planApproved: false,
      sessionAllowedUsers: ['testuser'],
      forceInteractivePermissions: false,
      sessionStartPostId: 'post-789',
      tasksPostId: null,
      lastTasksContent: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    store = new SessionStore();
    store.clear(); // Start with clean state
  });

  afterEach(() => {
    store.clear();
  });

  describe('save and load', () => {
    it('saves and loads a session', () => {
      const session = createTestSession();
      const sessionId = `${session.platformId}:${session.threadId}`;

      store.save(sessionId, session);
      const loaded = store.load();

      expect(loaded.size).toBe(1);
      expect(loaded.get(sessionId)).toEqual(session);
    });

    it('saves multiple sessions', () => {
      const session1 = createTestSession({ threadId: 'thread-1' });
      const session2 = createTestSession({ threadId: 'thread-2' });

      store.save('test-platform:thread-1', session1);
      store.save('test-platform:thread-2', session2);

      const loaded = store.load();
      expect(loaded.size).toBe(2);
    });
  });

  describe('remove', () => {
    it('removes a session', () => {
      const session = createTestSession();
      const sessionId = `${session.platformId}:${session.threadId}`;

      store.save(sessionId, session);
      expect(store.load().size).toBe(1);

      store.remove(sessionId);
      expect(store.load().size).toBe(0);
    });
  });

  describe('findByThread', () => {
    it('finds a session by platform and thread ID', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByThread('mattermost-main', 'thread-abc');
      expect(found).toEqual(session);
    });

    it('returns undefined for non-existent session', () => {
      const found = store.findByThread('nonexistent', 'thread-xyz');
      expect(found).toBeUndefined();
    });

    it('does not find session from different platform', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByThread('slack-main', 'thread-abc');
      expect(found).toBeUndefined();
    });
  });

  describe('findByPostId', () => {
    it('finds a session by timeoutPostId', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
        timeoutPostId: 'timeout-post-123',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByPostId('mattermost-main', 'timeout-post-123');
      expect(found).toEqual(session);
    });

    it('finds a session by sessionStartPostId', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
        sessionStartPostId: 'start-post-456',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByPostId('mattermost-main', 'start-post-456');
      expect(found).toEqual(session);
    });

    it('returns undefined for non-existent post ID', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
        timeoutPostId: 'timeout-post-123',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByPostId('mattermost-main', 'other-post-789');
      expect(found).toBeUndefined();
    });

    it('does not find session from different platform', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
        timeoutPostId: 'timeout-post-123',
      });
      store.save('mattermost-main:thread-abc', session);

      const found = store.findByPostId('slack-main', 'timeout-post-123');
      expect(found).toBeUndefined();
    });

    it('finds session when both timeoutPostId and sessionStartPostId are set', () => {
      const session = createTestSession({
        platformId: 'mattermost-main',
        threadId: 'thread-abc',
        sessionStartPostId: 'start-post-456',
        timeoutPostId: 'timeout-post-123',
      });
      store.save('mattermost-main:thread-abc', session);

      // Should find by either
      expect(store.findByPostId('mattermost-main', 'timeout-post-123')).toEqual(session);
      expect(store.findByPostId('mattermost-main', 'start-post-456')).toEqual(session);
    });
  });

  describe('softDelete', () => {
    it('marks a session as cleaned but keeps it', () => {
      const session = createTestSession();
      const sessionId = `${session.platformId}:${session.threadId}`;

      store.save(sessionId, session);
      expect(store.load().size).toBe(1);

      store.softDelete(sessionId);

      // Should not appear in load() (active sessions)
      expect(store.load().size).toBe(0);

      // But should appear in getHistory()
      const history = store.getHistory('test-platform');
      expect(history.length).toBe(1);
      expect(history[0].cleanedAt).toBeDefined();
    });
  });

  describe('cleanStale', () => {
    it('soft-deletes sessions older than maxAgeMs', () => {
      const oldSession = createTestSession({
        threadId: 'old-thread',
        lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      });
      const newSession = createTestSession({
        threadId: 'new-thread',
        lastActivityAt: new Date().toISOString(),
      });

      store.save('test-platform:old-thread', oldSession);
      store.save('test-platform:new-thread', newSession);

      const staleIds = store.cleanStale(60 * 60 * 1000); // 1 hour

      expect(staleIds).toContain('test-platform:old-thread');
      expect(staleIds).not.toContain('test-platform:new-thread');

      // Only new session should be in active sessions
      expect(store.load().size).toBe(1);

      // Old session should be in history
      const history = store.getHistory('test-platform');
      expect(history.length).toBe(1);
      expect(history[0].threadId).toBe('old-thread');
    });

    it('skips already soft-deleted sessions', () => {
      const session = createTestSession({
        threadId: 'old-thread',
        lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      });

      store.save('test-platform:old-thread', session);
      store.softDelete('test-platform:old-thread');

      // Should not soft-delete again
      const staleIds = store.cleanStale(60 * 60 * 1000);
      expect(staleIds.length).toBe(0);
    });
  });

  describe('getHistory', () => {
    it('returns soft-deleted sessions for a platform', () => {
      const session1 = createTestSession({ threadId: 'thread-1' });
      const session2 = createTestSession({ threadId: 'thread-2' });

      store.save('test-platform:thread-1', session1);
      store.save('test-platform:thread-2', session2);

      store.softDelete('test-platform:thread-1');

      const history = store.getHistory('test-platform');
      expect(history.length).toBe(1);
      expect(history[0].threadId).toBe('thread-1');
    });

    it('sorts by cleanedAt descending (most recent first)', async () => {
      const session1 = createTestSession({ threadId: 'thread-1' });
      const session2 = createTestSession({ threadId: 'thread-2' });

      store.save('test-platform:thread-1', session1);
      store.save('test-platform:thread-2', session2);

      store.softDelete('test-platform:thread-1');
      // Small delay to ensure different cleanedAt timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      store.softDelete('test-platform:thread-2');

      const history = store.getHistory('test-platform');
      expect(history.length).toBe(2);
      expect(history[0].threadId).toBe('thread-2'); // Most recently cleaned
      expect(history[1].threadId).toBe('thread-1');
    });

    it('only returns sessions for the specified platform', () => {
      const session1 = createTestSession({ platformId: 'platform-a', threadId: 'thread-1' });
      const session2 = createTestSession({ platformId: 'platform-b', threadId: 'thread-2' });

      store.save('platform-a:thread-1', session1);
      store.save('platform-b:thread-2', session2);

      store.softDelete('platform-a:thread-1');
      store.softDelete('platform-b:thread-2');

      const historyA = store.getHistory('platform-a');
      expect(historyA.length).toBe(1);
      expect(historyA[0].threadId).toBe('thread-1');

      const historyB = store.getHistory('platform-b');
      expect(historyB.length).toBe(1);
      expect(historyB[0].threadId).toBe('thread-2');
    });

    it('includes timed-out sessions (with timeoutPostId but no cleanedAt)', () => {
      const timedOutSession = createTestSession({
        threadId: 'timed-out-thread',
        timeoutPostId: 'timeout-post-123',
        // No cleanedAt - session timed out but wasn't soft-deleted
      });

      store.save('test-platform:timed-out-thread', timedOutSession);

      // Should appear in history when activeSessions excludes it
      const history = store.getHistory('test-platform', new Set());
      expect(history.length).toBe(1);
      expect(history[0].threadId).toBe('timed-out-thread');
      expect(history[0].timeoutPostId).toBe('timeout-post-123');
    });

    it('excludes timed-out sessions that are currently active', () => {
      const timedOutSession = createTestSession({
        threadId: 'timed-out-thread',
        timeoutPostId: 'timeout-post-123',
      });

      store.save('test-platform:timed-out-thread', timedOutSession);

      // Should NOT appear if the session is active
      const activeSessions = new Set(['test-platform:timed-out-thread']);
      const history = store.getHistory('test-platform', activeSessions);
      expect(history.length).toBe(0);
    });

    it('does not include timed-out sessions if activeSessions param is not provided', () => {
      const timedOutSession = createTestSession({
        threadId: 'timed-out-thread',
        timeoutPostId: 'timeout-post-123',
      });

      store.save('test-platform:timed-out-thread', timedOutSession);

      // Without activeSessions param, timed-out sessions should NOT appear
      // (backward compatibility - only soft-deleted sessions)
      const history = store.getHistory('test-platform');
      expect(history.length).toBe(0);
    });

    it('sorts timed-out and completed sessions together by most recent activity', async () => {
      // Completed session (with cleanedAt)
      const completedSession = createTestSession({
        threadId: 'completed-thread',
        lastActivityAt: new Date(Date.now() - 5000).toISOString(), // 5 seconds ago
      });
      store.save('test-platform:completed-thread', completedSession);
      store.softDelete('test-platform:completed-thread');

      // Small delay
      await new Promise(resolve => setTimeout(resolve, 10));

      // Timed-out session (more recent)
      const timedOutSession = createTestSession({
        threadId: 'timed-out-thread',
        timeoutPostId: 'timeout-post-123',
        lastActivityAt: new Date().toISOString(), // now
      });
      store.save('test-platform:timed-out-thread', timedOutSession);

      const history = store.getHistory('test-platform', new Set());
      expect(history.length).toBe(2);
      // Timed-out session should be first (more recent lastActivityAt)
      expect(history[0].threadId).toBe('timed-out-thread');
      expect(history[1].threadId).toBe('completed-thread');
    });
  });

  describe('cleanHistory', () => {
    it('permanently removes soft-deleted sessions older than retention period', () => {
      const oldTime = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(); // 4 days ago
      const session = createTestSession({
        threadId: 'old-thread',
        cleanedAt: oldTime,
      });

      store.save('test-platform:old-thread', session);

      // Clean history with 3-day retention
      const removedCount = store.cleanHistory(3 * 24 * 60 * 60 * 1000);

      expect(removedCount).toBe(1);
      expect(store.getHistory('test-platform').length).toBe(0);
    });

    it('keeps recent soft-deleted sessions', () => {
      const recentTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
      const session = createTestSession({
        threadId: 'recent-thread',
        cleanedAt: recentTime,
      });

      store.save('test-platform:recent-thread', session);

      // Clean history with 3-day retention
      const removedCount = store.cleanHistory(3 * 24 * 60 * 60 * 1000);

      expect(removedCount).toBe(0);
      expect(store.getHistory('test-platform').length).toBe(1);
    });

    it('does not affect active sessions', () => {
      const session = createTestSession({ threadId: 'active-thread' });

      store.save('test-platform:active-thread', session);

      // Clean history
      const removedCount = store.cleanHistory(0); // Would remove everything if it was in history

      expect(removedCount).toBe(0);
      expect(store.load().size).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all sessions', () => {
      store.save('test-platform:thread-1', createTestSession({ threadId: 'thread-1' }));
      store.save('test-platform:thread-2', createTestSession({ threadId: 'thread-2' }));

      expect(store.load().size).toBe(2);

      store.clear();

      expect(store.load().size).toBe(0);
    });
  });
});
