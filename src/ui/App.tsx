/**
 * Main App component - root of the Ink UI
 */
import React from 'react';
import { Box, Static, Text } from 'ink';
import { Header, ConfigSummary, Platforms, CollapsibleSession, StatusLine, LogPanel } from './components/index.js';
import { useAppState } from './hooks/useAppState.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import type { AppConfig, SessionInfo, LogEntry, PlatformStatus } from './types.js';

interface AppProps {
  config: AppConfig;
  onStateReady: (handlers: AppHandlers) => void;
  onResizeReady?: (handler: () => void) => void;
  onQuit?: () => void;
}

export interface AppHandlers {
  setReady: () => void;
  setShuttingDown: () => void;
  addSession: (session: SessionInfo) => void;
  updateSession: (sessionId: string, updates: Partial<SessionInfo>) => void;
  removeSession: (sessionId: string) => void;
  addLog: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  setPlatformStatus: (platformId: string, status: Partial<PlatformStatus>) => void;
}

export function App({ config, onStateReady, onResizeReady, onQuit }: AppProps) {
  const {
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
  } = useAppState(config);

  // Resize counter to force re-render on terminal resize
  const [resizeCount, setResizeCount] = React.useState(0);

  // Expose handlers to the outside world
  // This runs once when the component mounts
  React.useEffect(() => {
    onStateReady({
      setReady,
      setShuttingDown,
      addSession,
      updateSession,
      removeSession,
      addLog,
      setPlatformStatus,
    });
  }, [onStateReady, setReady, setShuttingDown, addSession, updateSession, removeSession, addLog, setPlatformStatus]);

  // Register resize handler
  React.useEffect(() => {
    if (onResizeReady) {
      onResizeReady(() => setResizeCount((c) => c + 1));
    }
  }, [onResizeReady]);

  // Get session IDs for keyboard handling
  const sessionIds = Array.from(state.sessions.keys());

  // Handle keyboard input
  useKeyboard({
    sessionIds,
    onToggle: toggleSession,
    onQuit,
  });


  // Static content - re-created on resize to fix artifacts
  // Note: Platforms is NOT static because it needs to update on connect/disconnect
  const staticContent = React.useMemo(() => [
    { id: `header-${resizeCount}`, element: <Header version={config.version} /> },
    { id: `config-${resizeCount}`, element: <ConfigSummary config={config} /> },
  ], [config, resizeCount]);

  // Get global logs (not associated with a session)
  const globalLogs = getGlobalLogs();
  const hasLogs = globalLogs.length > 0;
  const hasSessions = state.sessions.size > 0;

  return (
    <Box flexDirection="column">
      {/* Static header - renders once, never re-renders */}
      <Static items={staticContent}>
        {(item) => <Box key={item.id}>{item.element}</Box>}
      </Static>

      {/* Platforms - dynamic, updates on connect/disconnect */}
      <Platforms platforms={state.platforms} />

      {/* Global logs (system messages, keep-alive, etc.) */}
      {hasLogs && (
        <>
          <Box marginTop={1}>
            <Text dimColor>{'─'.repeat(50)}</Text>
          </Box>
          <LogPanel logs={globalLogs} maxLines={10} />
        </>
      )}

      {/* Sessions section */}
      {hasSessions && (
        <>
          <Box marginTop={1}>
            <Text dimColor>{'─'.repeat(50)}</Text>
          </Box>
          <Box marginTop={0}>
            <Text dimColor>Sessions ({state.sessions.size})</Text>
          </Box>
          {Array.from(state.sessions.entries()).map(([id, session], index) => (
            <CollapsibleSession
              key={id}
              session={session}
              logs={getLogsForSession(id)}
              expanded={state.expandedSessions.has(id)}
              sessionNumber={index + 1}
            />
          ))}
        </>
      )}

      <StatusLine
        ready={state.ready}
        shuttingDown={state.shuttingDown}
        sessionCount={state.sessions.size}
      />
    </Box>
  );
}
