/**
 * Tests for the help message generator
 */

import { describe, it, expect } from 'bun:test';
import { generateHelpMessage } from './help-generator.js';
import type { PlatformFormatter } from '../platform/index.js';

// Mock formatter for testing (must match PlatformFormatter interface)
const mockFormatter: PlatformFormatter = {
  formatBold: (text: string) => `**${text}**`,
  formatItalic: (text: string) => `_${text}_`,
  formatCode: (text: string) => `\`${text}\``,
  formatCodeBlock: (code: string, language?: string) => `\`\`\`${language || ''}\n${code}\n\`\`\``,
  formatUserMention: (username: string) => `@${username}`,
  formatLink: (text: string, url: string) => `[${text}](${url})`,
  formatListItem: (text: string) => `- ${text}`,
  formatNumberedListItem: (number: number, text: string) => `${number}. ${text}`,
  formatBlockquote: (text: string) => `> ${text}`,
  formatHorizontalRule: () => '---',
  formatHeading: (text: string, level: number) => `${'#'.repeat(level)} ${text}`,
  formatStrikethrough: (text: string) => `~~${text}~~`,
  escapeText: (text: string) => text,
  formatTable: (headers: string[], rows: string[][]) => {
    const headerRow = `| ${headers.join(' | ')} |`;
    const separator = `| ${headers.map(() => '---').join(' | ')} |`;
    const dataRows = rows.map(row => `| ${row.join(' | ')} |`).join('\n');
    return `${headerRow}\n${separator}\n${dataRows}`;
  },
  formatKeyValueList: (items: [string, string, string][]) => {
    return items.map(([icon, label, value]) => `${icon} **${label}:** ${value}`).join('\n');
  },
  formatMarkdown: (content: string) => content,
};

describe('generateHelpMessage', () => {
  it('generates a non-empty help message', () => {
    const message = generateHelpMessage(mockFormatter);

    expect(message).toBeTruthy();
    expect(message.length).toBeGreaterThan(100);
  });

  it('includes Commands header', () => {
    const message = generateHelpMessage(mockFormatter);

    expect(message).toContain('**Commands:**');
  });

  it('includes Reactions header', () => {
    const message = generateHelpMessage(mockFormatter);

    expect(message).toContain('**Reactions:**');
  });

  it('includes expected commands', () => {
    const message = generateHelpMessage(mockFormatter);

    // Session commands
    expect(message).toContain('!stop');
    expect(message).toContain('!escape');
    expect(message).toContain('!approve');

    // Worktree commands
    expect(message).toContain('!worktree');
    expect(message).toContain('!worktree list');

    // Collaboration
    expect(message).toContain('!invite');
    expect(message).toContain('!kick');

    // Settings
    expect(message).toContain('!cd');
    expect(message).toContain('!permissions');

    // System
    expect(message).toContain('!update');
    expect(message).toContain('!kill');
    expect(message).toContain('!bug');
  });

  it('includes expected reactions', () => {
    const message = generateHelpMessage(mockFormatter);

    expect(message).toContain('👍');
    expect(message).toContain('👎');
    expect(message).toContain('✅');
    expect(message).toContain('⏸️');
    expect(message).toContain('❌');
    expect(message).toContain('🛑');
  });

  it('uses formatter for code formatting', () => {
    const message = generateHelpMessage(mockFormatter);

    // Should use backticks for code (from our mock formatter)
    expect(message).toContain('`!stop`');
    expect(message).toContain('`!cd <path>`');
  });

  it('excludes passthrough commands from the command table', () => {
    const message = generateHelpMessage(mockFormatter);

    // Passthrough commands get no table rows of their own (they are
    // mentioned collectively in the slash-command footer hint instead)
    expect(message).not.toContain('| `!context`');
    expect(message).not.toContain('| `!cost`');
    expect(message).not.toContain('| `!compact`');
    expect(message).not.toContain('| `!model`');
  });
});

describe('slash-command passthrough hint', () => {
  it('mentions !model and !effort in the help footer', async () => {
    const { generateHelpMessage } = await import('./help-generator.js');
    const { createMockFormatter } = await import('../test-utils/mock-formatter.js');
    const message = generateHelpMessage(createMockFormatter());
    expect(message).toContain('!model sonnet');
    expect(message).toContain('!effort high');
  });

  it('omits !bug when the operator has disabled bug reporting', () => {
    // Advertising a command that will be refused wastes everyone's time, and
    // in a locked-down deployment the command should simply not be on offer.
    const withBug = generateHelpMessage(mockFormatter);
    const without = generateHelpMessage(mockFormatter, { bugReportsEnabled: false });

    expect(withBug).toContain('!bug');
    expect(without).not.toContain('!bug');
    // Everything else survives the filter.
    expect(without).toContain('!help');
  });
});
