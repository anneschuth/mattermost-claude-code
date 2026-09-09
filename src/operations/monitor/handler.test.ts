import { describe, it, expect, afterEach, mock } from 'bun:test';
import { SessionMonitor } from './handler.js';
import type { SessionContext } from '../session-context/index.js';

// Create a minimal mock context
function createMockContext(): SessionContext {
  return {
    state: {
      sessions: new Map(),
      platforms: new Map(),
      postIndex: new Map(),
      sessionStore: {} as never,
      githubEmailsStore: {} as never,
      memoryStore: {} as never,
      routinesStore: {} as never,
      watchesStore: {} as never,
      isShuttingDown: false,
    },
    config: {
      workingDir: '/tmp',
      permissionMode: 'bypass',
      chromeEnabled: false,
      debug: false,
      bugReportsEnabled: true,
      maxSessions: 5,
    },
    ops: {} as never,
  };
}

describe('SessionMonitor', () => {
  let monitor: SessionMonitor;

  afterEach(() => {
    monitor?.stop();
  });

  describe('constructor', () => {
    it('should create monitor with required options', () => {
      const getContext = mock(() => createMockContext());
      const getSessionCount = mock(() => 0);
      const updateStickyMessage = mock(async () => {});

      monitor = new SessionMonitor({
        sessionTimeoutMs: 1800000,
        sessionWarningMs: 300000,
        getContext,
        getSessionCount,
        updateStickyMessage,
      });

      expect(monitor).toBeDefined();
    });

    it('should accept custom interval', () => {
      const getContext = mock(() => createMockContext());
      const getSessionCount = mock(() => 0);
      const updateStickyMessage = mock(async () => {});

      monitor = new SessionMonitor({
        intervalMs: 5000,
        sessionTimeoutMs: 1800000,
        sessionWarningMs: 300000,
        getContext,
        getSessionCount,
        updateStickyMessage,
      });

      expect(monitor).toBeDefined();
    });
  });

  describe('start/stop', () => {
    it('should start and stop without errors', () => {
      const getContext = mock(() => createMockContext());
      const getSessionCount = mock(() => 0);
      const updateStickyMessage = mock(async () => {});

      monitor = new SessionMonitor({
        intervalMs: 60000, // Long interval to avoid actual runs
        sessionTimeoutMs: 1800000,
        sessionWarningMs: 300000,
        getContext,
        getSessionCount,
        updateStickyMessage,
      });

      monitor.start();
      monitor.stop();
    });

    it('should handle multiple start calls gracefully', () => {
      const getContext = mock(() => createMockContext());
      const getSessionCount = mock(() => 0);
      const updateStickyMessage = mock(async () => {});

      monitor = new SessionMonitor({
        intervalMs: 60000,
        sessionTimeoutMs: 1800000,
        sessionWarningMs: 300000,
        getContext,
        getSessionCount,
        updateStickyMessage,
      });

      monitor.start();
      monitor.start(); // Should not throw
      monitor.stop();
    });

    it('should handle multiple stop calls gracefully', () => {
      const getContext = mock(() => createMockContext());
      const getSessionCount = mock(() => 0);
      const updateStickyMessage = mock(async () => {});

      monitor = new SessionMonitor({
        intervalMs: 60000,
        sessionTimeoutMs: 1800000,
        sessionWarningMs: 300000,
        getContext,
        getSessionCount,
        updateStickyMessage,
      });

      monitor.start();
      monitor.stop();
      monitor.stop(); // Should not throw
    });
  });
});
