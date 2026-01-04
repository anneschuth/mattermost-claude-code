/**
 * Platforms component - shows connected platforms with their status
 */
import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';
import type { PlatformStatus } from '../types.js';

interface PlatformsProps {
  platforms: Map<string, PlatformStatus>;
}

export function Platforms({ platforms }: PlatformsProps) {
  if (platforms.size === 0) {
    return (
      <Box marginTop={1}>
        <Spinner label="Connecting to platforms..." />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {Array.from(platforms.values()).map((platform) => (
        <Box key={platform.id} gap={1}>
          {/* Connection status indicator */}
          {platform.reconnecting ? (
            <Text color="yellow">◌</Text>
          ) : platform.connected ? (
            <Text color="green">●</Text>
          ) : (
            <Text color="red">○</Text>
          )}

          {/* Bot name */}
          <Text color="cyan">@{platform.botName}</Text>

          {/* Platform display name */}
          <Text dimColor>on</Text>
          <Text>{platform.displayName}</Text>

          {/* Reconnecting indicator */}
          {platform.reconnecting && (
            <Text color="yellow">(reconnecting {platform.reconnectAttempts}...)</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
