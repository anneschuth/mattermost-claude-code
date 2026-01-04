/**
 * ASCII Art Logo for Claude Threads
 *
 * Stylized CT in Claude Code's block character style.
 */

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
