/**
 * ASCII Art Logo for Mattermost Claude Code
 *
 * Stylized M in Claude Code's block character style.
 */

// ANSI color codes for terminal
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // Mattermost blue (#1C58D9)
  blue: '\x1b[38;5;27m',
  // Claude orange/coral
  orange: '\x1b[38;5;209m',
};

/**
 * ASCII logo for CLI display (with ANSI colors)
 * Stylized M in block characters
 */
export const CLI_LOGO = `
${colors.orange} ✴${colors.reset} ${colors.blue}▐█▙ ▟█▌${colors.reset} ${colors.orange}✴${colors.reset}   ${colors.bold}mm-claude${colors.reset}
${colors.orange}✴${colors.reset}  ${colors.blue}▐█▐█▌█▌${colors.reset}  ${colors.orange}✴${colors.reset}  ${colors.dim}Mattermost × Claude Code${colors.reset}
 ${colors.orange}✴${colors.reset} ${colors.blue}▐█▌ ▐█▌${colors.reset} ${colors.orange}✴${colors.reset}
`;

/**
 * ASCII logo for Mattermost (plain text, no ANSI codes)
 * Use getMattermostLogo(version) instead to include version
 */
export const MATTERMOST_LOGO = `\`\`\`
 ✴ ▐█▙ ▟█▌ ✴   mm-claude
✴  ▐█▐█▌█▌  ✴  Mattermost × Claude Code
 ✴ ▐█▌ ▐█▌ ✴
\`\`\``;

/**
 * Get ASCII logo for Mattermost with version included
 */
export function getMattermostLogo(version: string): string {
  return `\`\`\`
 ✴ ▐█▙ ▟█▌ ✴   mm-claude v${version}
✴  ▐█▐█▌█▌  ✴  Mattermost × Claude Code
 ✴ ▐█▌ ▐█▌ ✴
\`\`\``;
}

/**
 * Compact inline logo for Mattermost headers
 */
export const MATTERMOST_LOGO_INLINE = '`▐▛M▜▌` **mm-claude**';

/**
 * Very compact logo for space-constrained contexts
 */
export const LOGO_COMPACT = '▐▛M▜▌ mm-claude';

/**
 * Print CLI logo to stdout
 */
export function printLogo(): void {
  console.log(CLI_LOGO);
}
