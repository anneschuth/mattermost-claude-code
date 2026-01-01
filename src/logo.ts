/**
 * ASCII Art Logo for Claude Threads
 *
 * Stylized CT in Claude Code's block character style.
 */

import { colors } from './utils/output.js';

/**
 * ASCII logo for CLI display (with ANSI colors)
 * Stylized CT in block characters
 */
const CLI_LOGO = `
${colors.orange} ✴${colors.reset} ${colors.blue}▄█▀ ███${colors.reset} ${colors.orange}✴${colors.reset}   ${colors.bold}claude-threads${colors.reset}
${colors.orange}✴${colors.reset}  ${colors.blue}█▀   █${colors.reset}   ${colors.orange}✴${colors.reset}  ${colors.dim}Chat × Claude Code${colors.reset}
 ${colors.orange}✴${colors.reset} ${colors.blue}▀█▄  █${colors.reset}  ${colors.orange}✴${colors.reset}
`;

/**
 * Get ASCII logo for claude-threads with version included
 * For display in chat platforms (plain text, no ANSI codes)
 */
export function getLogo(version: string): string {
  return `\`\`\`
 ✴ ▄█▀ ███ ✴   claude-threads v${version}
✴  █▀   █   ✴  Chat × Claude Code
 ✴ ▀█▄  █  ✴
\`\`\``;
}

/**
 * Print CLI logo to stdout
 */
export function printLogo(): void {
  console.log(CLI_LOGO);
}
