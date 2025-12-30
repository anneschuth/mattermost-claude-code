import type { PlatformFormatter } from '../formatter.js';

/**
 * Mattermost markdown formatter
 *
 * Mattermost uses standard markdown syntax.
 */
export class MattermostFormatter implements PlatformFormatter {
  formatBold(text: string): string {
    return `**${text}**`;
  }

  formatItalic(text: string): string {
    return `_${text}_`;
  }

  formatCode(text: string): string {
    return `\`${text}\``;
  }

  formatCodeBlock(code: string, language?: string): string {
    const lang = language || '';
    return `\`\`\`${lang}\n${code}\n\`\`\``;
  }

  formatUserMention(username: string): string {
    return `@${username}`;
  }

  formatLink(text: string, url: string): string {
    return `[${text}](${url})`;
  }

  formatListItem(text: string): string {
    return `- ${text}`;
  }

  formatNumberedListItem(number: number, text: string): string {
    return `${number}. ${text}`;
  }

  formatBlockquote(text: string): string {
    return `> ${text}`;
  }

  formatHorizontalRule(): string {
    return '---';
  }

  formatHeading(text: string, level: number): string {
    const hashes = '#'.repeat(Math.min(Math.max(level, 1), 6));
    return `${hashes} ${text}`;
  }

  escapeText(text: string): string {
    // Escape markdown special characters
    return text.replace(/([*_`[\]()#+\-.!])/g, '\\$1');
  }
}
