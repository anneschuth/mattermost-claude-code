/**
 * CLI Output Styling
 *
 * Provides ANSI color helpers for CLI output.
 */

// ANSI color codes
export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  // Claude brand colors
  blue: '\x1b[38;5;27m',
  orange: '\x1b[38;5;209m',
};

// Helper functions for styling text
export const dim = (s: string): string => `${colors.dim}${s}${colors.reset}`;
export const bold = (s: string): string => `${colors.bold}${s}${colors.reset}`;
export const cyan = (s: string): string => `${colors.cyan}${s}${colors.reset}`;
export const green = (s: string): string => `${colors.green}${s}${colors.reset}`;
export const red = (s: string): string => `${colors.red}${s}${colors.reset}`;
export const yellow = (s: string): string => `${colors.yellow}${s}${colors.reset}`;
