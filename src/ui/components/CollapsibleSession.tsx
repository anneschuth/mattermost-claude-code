/**
 * CollapsibleSession component - expandable session panel
 */
import { Box, Text } from 'ink';
import type { SessionInfo, LogEntry } from '../types.js';
import { SessionLog } from './SessionLog.js';
import { Spinner } from './Spinner.js';
import { formatShortId, formatRelativeTimeShort } from '../../utils/format.js';

interface CollapsibleSessionProps {
  session: SessionInfo;
  logs: LogEntry[];
  expanded: boolean;
  sessionNumber: number;
}

function getStatusIndicator(status: SessionInfo['status']): { icon: string; color: string } {
  switch (status) {
    case 'active':
    case 'starting':
      return { icon: '●', color: 'green' };
    case 'idle':
      return { icon: '○', color: 'gray' };
    case 'stopping':
      return { icon: '◌', color: 'yellow' };
    case 'paused':
      return { icon: '⏸', color: 'blue' };
    default:
      return { icon: '○', color: 'gray' };
  }
}

export function CollapsibleSession({
  session,
  logs,
  expanded,
  sessionNumber,
}: CollapsibleSessionProps) {
  const { icon, color } = getStatusIndicator(session.status);
  const arrow = expanded ? '▼' : '▶';
  const shortId = formatShortId(session.id);
  const timeAgo = session.lastActivity ? formatRelativeTimeShort(session.lastActivity) : '';

  // Use title if available, otherwise fall back to short ID
  const displayTitle = session.title || `Session ${shortId}`;

  return (
    <Box flexDirection="column" marginTop={0}>
      {/* Header line: arrow + title + user + status + branch */}
      <Box gap={1}>
        <Text dimColor>{arrow}</Text>
        <Text color={session.title ? 'cyan' : 'white'} bold>{displayTitle}</Text>
        <Text dimColor>·</Text>
        <Text color="yellow">{session.startedBy}</Text>
        {timeAgo && (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>{timeAgo}</Text>
          </>
        )}
        <Text color={color}>{icon}</Text>
        {session.worktreeBranch && (
          <>
            <Text dimColor>│</Text>
            <Text color="magenta">{session.worktreeBranch}</Text>
          </>
        )}
      </Box>

      {/* Description line (if available, shown when collapsed too) */}
      {session.description && (
        <Box paddingLeft={2}>
          <Text dimColor italic>{session.description}</Text>
        </Box>
      )}

      {/* Expanded content */}
      {expanded && (
        <Box flexDirection="column" paddingLeft={2}>
          <SessionLog logs={logs} />
          {session.status === 'starting' && (
            <Box marginTop={0}>
              <Spinner label="Starting..." />
            </Box>
          )}
          {session.isTyping && session.status !== 'starting' && (
            <Box marginTop={0}>
              <Spinner label="Typing..." />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
