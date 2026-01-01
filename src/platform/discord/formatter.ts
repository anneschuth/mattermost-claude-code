import type { PlatformFormatter } from '../formatter.js';

/**
 * Discord markdown formatter
 *
 * Discord uses a variant of markdown similar to standard markdown,
 * but with some differences in user mentions and link formatting.
 */
export class DiscordFormatter implements PlatformFormatter {
  formatBold(text: string): string {
    return `**${text}**`;
  }

  formatItalic(text: string): string {
    return `*${text}*`;
  }

  formatCode(text: string): string {
    return `\`${text}\``;
  }

  formatCodeBlock(code: string, language?: string): string {
    const lang = language || '';
    return `\`\`\`${lang}\n${code}\n\`\`\``;
  }

  formatUserMention(username: string, userId?: string): string {
    // Discord uses <@userId> format for mentions
    // If we have the userId, use that; otherwise fall back to @username
    if (userId) {
      return `<@${userId}>`;
    }
    return `@${username}`;
  }

  formatLink(text: string, url: string): string {
    // Discord supports standard markdown links
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
    // Discord doesn't have a true horizontal rule, use a line of dashes
    return '───────────────────';
  }

  formatHeading(text: string, level: number): string {
    // Discord supports # headings but they're less prominent
    const hashes = '#'.repeat(Math.min(Math.max(level, 1), 3));
    return `${hashes} ${text}`;
  }

  escapeText(text: string): string {
    // Escape Discord markdown special characters
    return text.replace(/([*_`~|\\])/g, '\\$1');
  }
}
