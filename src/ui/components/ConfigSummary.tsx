/**
 * Configuration summary component - compact display of startup info
 */
import { Box, Text } from 'ink';
import type { AppConfig } from '../types.js';

interface ConfigSummaryProps {
  config: AppConfig;
}

export function ConfigSummary({ config }: ConfigSummaryProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Line 1: Working directory */}
      <Box gap={1}>
        <Text>📂</Text>
        <Text color="cyan">{config.workingDir}</Text>
      </Box>

      {/* Line 2: Claude version and settings */}
      <Box gap={2}>
        <Box gap={1}>
          <Text>🤖</Text>
          <Text dimColor>Claude {config.claudeVersion}</Text>
          {config.claudeCompatible ? (
            <Text color="green">✓</Text>
          ) : (
            <Text color="yellow">⚠</Text>
          )}
        </Box>
        <Text dimColor>│</Text>
        {config.skipPermissions ? (
          <Text color="yellow">⚠️ Perms off</Text>
        ) : (
          <Text dimColor>🔐 Perms</Text>
        )}
        {config.chromeEnabled && (
          <>
            <Text dimColor>│</Text>
            <Text dimColor>🌐 Chrome</Text>
          </>
        )}
        {config.keepAliveEnabled && (
          <>
            <Text dimColor>│</Text>
            <Text dimColor>☕ Awake</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
