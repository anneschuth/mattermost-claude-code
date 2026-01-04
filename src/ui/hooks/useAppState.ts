/**
 * useAppState hook - central state management for the UI
 */
import { useState, useCallback } from 'react';
import type { AppState, AppConfig, SessionInfo, LogEntry, PlatformStatus } from '../types.js';

let logIdCounter = 0;

export function useAppState(initialConfig: AppConfig) {
  const [state, setState] = useState<AppState>({
    config: initialConfig,
    platforms: new Map(),
    sessions: new Map(),
    logs: [],
    expandedSessions: new Set(),
    ready: false,
    shuttingDown: false,
  });

  const setReady = useCallback(() => {
    setState((prev) => ({ ...prev, ready: true }));
  }, []);

  const setShuttingDown = useCallback(() => {
    setState((prev) => ({ ...prev, shuttingDown: true }));
  }, []);

  const addSession = useCallback((session: SessionInfo) => {
    setState((prev) => {
      const sessions = new Map(prev.sessions);
      sessions.set(session.id, session);
      // Auto-expand the first session, or new sessions
      const expandedSessions = new Set(prev.expandedSessions);
      if (sessions.size === 1 || !expandedSessions.has(session.id)) {
        expandedSessions.add(session.id);
      }
      return { ...prev, sessions, expandedSessions };
    });
  }, []);

  const updateSession = useCallback((sessionId: string, updates: Partial<SessionInfo>) => {
    setState((prev) => {
      const sessions = new Map(prev.sessions);
      const session = sessions.get(sessionId);
      if (session) {
        sessions.set(sessionId, { ...session, ...updates });
      }
      return { ...prev, sessions };
    });
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    setState((prev) => {
      const sessions = new Map(prev.sessions);
      sessions.delete(sessionId);
      const expandedSessions = new Set(prev.expandedSessions);
      expandedSessions.delete(sessionId);
      return { ...prev, sessions, expandedSessions };
    });
  }, []);

  const addLog = useCallback((entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    const newEntry: LogEntry = {
      ...entry,
      id: `log-${++logIdCounter}`,
      timestamp: new Date(),
    };
    setState((prev) => {
      // Keep last 100 logs per session (or global)
      const logs = [...prev.logs, newEntry].slice(-500);
      return { ...prev, logs };
    });
  }, []);

  const toggleSession = useCallback((sessionId: string) => {
    setState((prev) => {
      const expandedSessions = new Set(prev.expandedSessions);
      if (expandedSessions.has(sessionId)) {
        expandedSessions.delete(sessionId);
      } else {
        expandedSessions.add(sessionId);
      }
      return { ...prev, expandedSessions };
    });
  }, []);

  const setPlatformStatus = useCallback((platformId: string, status: Partial<PlatformStatus>) => {
    setState((prev) => {
      const platforms = new Map(prev.platforms);
      const current = platforms.get(platformId) || {
        id: platformId,
        displayName: platformId,
        botName: 'bot',
        url: '',
        connected: false,
        reconnecting: false,
        reconnectAttempts: 0,
      };
      platforms.set(platformId, { ...current, ...status });
      return { ...prev, platforms };
    });
  }, []);

  const getLogsForSession = useCallback((sessionId: string): LogEntry[] => {
    return state.logs.filter((log) => log.sessionId === sessionId);
  }, [state.logs]);

  const getGlobalLogs = useCallback((): LogEntry[] => {
    return state.logs.filter((log) => !log.sessionId);
  }, [state.logs]);

  return {
    state,
    setReady,
    setShuttingDown,
    addSession,
    updateSession,
    removeSession,
    addLog,
    toggleSession,
    setPlatformStatus,
    getLogsForSession,
    getGlobalLogs,
  };
}
