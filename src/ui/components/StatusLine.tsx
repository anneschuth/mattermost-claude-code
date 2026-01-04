/**
 * StatusLine component - bot status bar at the bottom
 *
 * Shows the overall bot status, not session-specific info.
 * Visually separated from sessions with a line.
 */
import { Box, Text } from 'ink';

interface StatusLineProps {
  ready: boolean;
  shuttingDown?: boolean;
  sessionCount: number;
}

export function StatusLine({
  ready,
  shuttingDown,
  sessionCount,
}: StatusLineProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Separator line */}
      <Text dimColor>{'─'.repeat(50)}</Text>

      {/* Status row - all on one line */}
      <Box gap={2}>
        {shuttingDown ? (
          <Box gap={1}>
            <Text color="yellow">⏻</Text>
            <Text color="yellow">Shutting down...</Text>
          </Box>
        ) : ready ? (
          <Box gap={1}>
            <Text color="green">✓</Text>
            <Text dimColor>Ready</Text>
          </Box>
        ) : (
          <Box gap={1}>
            <Text color="yellow">○</Text>
            <Text dimColor>Starting...</Text>
          </Box>
        )}

        {sessionCount > 0 && !shuttingDown && (
          <>
            <Text dimColor>│</Text>
            <Text dimColor>Press</Text>
            <Text bold>1-{Math.min(sessionCount, 9)}</Text>
            <Text dimColor>to toggle sessions</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
