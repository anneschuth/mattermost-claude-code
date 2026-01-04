/**
 * Header component with ASCII logo in a bordered box
 */
import { Box, Text } from 'ink';

interface HeaderProps {
  version: string;
}

export function Header({ version }: HeaderProps) {
  // Match the original logo from src/logo.ts exactly:
  //  ✴ ▄█▀ ███ ✴   claude-threads
  // ✴  █▀   █   ✴  Chat × Claude Code
  //  ✴ ▀█▄  █  ✴
  return (
    <Box
      borderStyle="round"
      paddingX={1}
      flexDirection="column"
    >
      <Text>
        <Text color="yellow"> ✴</Text>
        <Text> </Text>
        <Text color="blue">▄█▀ ███</Text>
        <Text> </Text>
        <Text color="yellow">✴</Text>
        <Text>   </Text>
        <Text bold>claude-threads</Text>
        <Text dimColor>  v{version}</Text>
      </Text>
      <Text>
        <Text color="yellow">✴</Text>
        <Text>  </Text>
        <Text color="blue">█▀   █</Text>
        <Text>   </Text>
        <Text color="yellow">✴</Text>
        <Text>  </Text>
        <Text dimColor>Chat × Claude Code</Text>
      </Text>
      <Text>
        <Text> </Text>
        <Text color="yellow">✴</Text>
        <Text> </Text>
        <Text color="blue">▀█▄  █</Text>
        <Text>  </Text>
        <Text color="yellow">✴</Text>
      </Text>
    </Box>
  );
}
