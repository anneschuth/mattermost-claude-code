/**
 * Types for the Ink-based CLI UI
 */

export interface SessionInfo {
  id: string;
  threadId: string;
  startedBy: string;
  displayName?: string;
  status: 'starting' | 'active' | 'idle' | 'stopping' | 'paused';
  workingDir: string;
  sessionNumber: number;
  worktreeBranch?: string;
  // Rich session metadata
  title?: string;
  description?: string;
  lastActivity?: Date;
  // Typing indicator state (for spinner display)
  isTyping?: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  message: string;
  sessionId?: string;
}

export interface PlatformStatus {
  id: string;
  displayName: string;
  botName: string;
  url: string;
  connected: boolean;
  reconnecting: boolean;
  reconnectAttempts: number;
}

export interface AppConfig {
  version: string;
  workingDir: string;
  claudeVersion: string;
  claudeCompatible: boolean;
  skipPermissions: boolean;
  chromeEnabled: boolean;
  keepAliveEnabled: boolean;
}

export interface AppState {
  config: AppConfig;
  platforms: Map<string, PlatformStatus>;
  sessions: Map<string, SessionInfo>;
  logs: LogEntry[];
  expandedSessions: Set<string>;
  ready: boolean;
  shuttingDown: boolean;
}

export interface UIInstance {
  setReady: () => void;
  setShuttingDown: () => void;
  addSession: (session: SessionInfo) => void;
  updateSession: (sessionId: string, updates: Partial<SessionInfo>) => void;
  removeSession: (sessionId: string) => void;
  addLog: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  setPlatformStatus: (platformId: string, status: Partial<PlatformStatus>) => void;
  waitUntilExit: () => Promise<void>;
}
