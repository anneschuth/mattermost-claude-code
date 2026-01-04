/**
 * Spinner component - wrapper around @inkjs/ui Spinner
 */
import { Box, Text } from 'ink';
import { Spinner as InkSpinner } from '@inkjs/ui';

interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps) {
  return (
    <Box gap={1}>
      <InkSpinner />
      {label && <Text dimColor>{label}</Text>}
    </Box>
  );
}
