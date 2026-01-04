/**
 * useKeyboard hook - handle keyboard input for session toggling
 */
import { useInput } from 'ink';

interface UseKeyboardOptions {
  sessionIds: string[];
  onToggle: (sessionId: string) => void;
  onQuit?: () => void;
}

export function useKeyboard({ sessionIds, onToggle, onQuit }: UseKeyboardOptions) {
  useInput((input, key) => {
    // Ctrl+C to quit - handle explicitly since Ink captures it in raw mode
    // Ctrl+C can appear as '\x03' (raw) or 'c' with key.ctrl
    if (input === '\x03' || (input === 'c' && key.ctrl)) {
      if (onQuit) {
        onQuit();
      }
      return;
    }

    // Number keys 1-9 to toggle sessions
    const num = parseInt(input, 10);
    if (num >= 1 && num <= 9) {
      const sessionId = sessionIds[num - 1];
      if (sessionId) {
        onToggle(sessionId);
      }
    }

    // q to quit (optional)
    if (input === 'q' && onQuit) {
      onQuit();
    }
  });
}
