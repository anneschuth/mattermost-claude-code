/**
 * Help Message Generator
 *
 * Generates the !help message from the unified command registry.
 * This ensures help is always in sync with the actual commands.
 */

import type { PlatformFormatter } from '../platform/index.js';
import {
  getUserHelpCommands,
  REACTION_REGISTRY,
  type CommandDefinition,
} from './registry.js';
import { formatSponsorFooter } from '../sponsor.js';

/**
 * Format a single command for the help table.
 * Includes the command and all its subcommands as separate rows.
 */
function formatCommandRows(
  cmd: CommandDefinition,
  code: (text: string) => string
): Array<[string, string]> {
  const rows: Array<[string, string]> = [];

  // Main command
  const cmdStr = cmd.args ? `!${cmd.command} ${cmd.args}` : `!${cmd.command}`;
  rows.push([code(cmdStr), cmd.description]);

  // Subcommands
  if (cmd.subcommands) {
    for (const sub of cmd.subcommands) {
      const subCmdStr = sub.args
        ? `!${cmd.command} ${sub.name} ${sub.args}`
        : `!${cmd.command} ${sub.name}`;
      rows.push([code(subCmdStr), sub.description]);
    }
  }

  return rows;
}

/**
 * Generate the help message from the command registry.
 *
 * @param formatter - Platform formatter for markdown formatting
 * @returns Formatted help message string
 */
export function generateHelpMessage(
  formatter: PlatformFormatter,
  options?: { bugReportsEnabled?: boolean },
): string {
  const code = formatter.formatCode.bind(formatter);
  // A command the operator has switched off should not be advertised —
  // otherwise every user finds it in !help and then gets refused.
  const commands = getUserHelpCommands().filter(
    (c) => c.command !== 'bug' || options?.bugReportsEnabled !== false,
  );

  // Build command table rows
  const rows: Array<[string, string]> = [];
  for (const cmd of commands) {
    rows.push(...formatCommandRows(cmd, code));
  }

  // Build command table
  const commandTable = formatter.formatTable(['Command', 'Description'], rows);

  // Build reactions section
  const approvalReactions = REACTION_REGISTRY
    .filter(r => r.context === 'approval')
    .map(r => `${r.emoji} ${r.description}`)
    .join(' · ');

  const sessionReactions = REACTION_REGISTRY
    .filter(r => r.context === 'session')
    .map(r => `${r.emoji} ${r.description}`)
    .join(' · ');

  // Combine everything
  return (
    `${formatter.formatBold('Commands:')}\n\n` +
    commandTable +
    `\n\n${formatter.formatBold('Reactions:')}\n` +
    `${formatter.formatListItem(approvalReactions)}\n` +
    `${formatter.formatListItem(sessionReactions)}\n\n` +
    `Claude Code slash commands work with ${code('!')} too — e.g. ${code('!model sonnet')}, ${code('!effort high')}, ${code('!compact')}, ${code('!context')}.\n\n` +
    formatSponsorFooter(formatter)
  );
}
