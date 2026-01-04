/**
 * UI entry point - exports startUI() function
 */
import React from 'react';
import { render } from 'ink';
import { App, type AppHandlers } from './App.js';
import type { AppConfig, UIInstance, SessionInfo, LogEntry, PlatformStatus } from './types.js';

export type { UIInstance, AppConfig, SessionInfo, LogEntry, PlatformStatus };

interface StartUIOptions {
  config: AppConfig;
  onQuit?: () => void;
}

export async function startUI(options: StartUIOptions): Promise<UIInstance> {
  const { config, onQuit } = options;

  // Check for TTY - fail fast if not interactive
  if (!process.stdout.isTTY) {
    throw new Error('claude-threads requires an interactive terminal (TTY)');
  }

  // Promise that resolves when handlers are ready
  let resolveHandlers: (handlers: AppHandlers) => void;
  const handlersPromise = new Promise<AppHandlers>((resolve) => {
    resolveHandlers = resolve;
  });

  // Track resize handler from App component
  let onResize: (() => void) | null = null;

  // Render the app (hide cursor since we don't have text input)
  const { waitUntilExit } = render(
    React.createElement(App, {
      config,
      onStateReady: (handlers: AppHandlers) => resolveHandlers(handlers),
      onResizeReady: (handler: () => void) => { onResize = handler; },
      onQuit,
    }),
    {
      // Hide the cursor - we only use keyboard shortcuts, not text input
      patchConsole: false,
      // Disable default Ctrl+C handling so we can show "Shutting down..." first
      exitOnCtrlC: false,
    }
  );

  // Hide cursor explicitly
  process.stdout.write('\x1b[?25l');

  // Restore cursor on exit
  const restoreCursor = () => process.stdout.write('\x1b[?25h');
  process.on('exit', restoreCursor);

  // Handle terminal resize - clear screen and trigger re-render
  const handleResize = () => {
    // Clear the screen to remove artifacts
    process.stdout.write('\x1b[2J\x1b[H');
    // Trigger state update in App to force re-render
    if (onResize) onResize();
  };
  process.on('SIGWINCH', handleResize);

  // Wait for handlers to be ready
  const handlers = await handlersPromise;

  // Return the UI instance
  return {
    setReady: handlers.setReady,
    setShuttingDown: handlers.setShuttingDown,
    addSession: handlers.addSession,
    updateSession: handlers.updateSession,
    removeSession: handlers.removeSession,
    addLog: handlers.addLog,
    setPlatformStatus: handlers.setPlatformStatus,
    waitUntilExit,
  };
}
