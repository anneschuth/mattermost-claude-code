/**
 * Platform-agnostic markdown formatter interface
 *
 * Different platforms have slightly different markdown dialects:
 * - Mattermost: Standard markdown (**bold**, _italic_, @username)
 * - Slack: mrkdwn (*bold*, _italic_, <@U123> for mentions)
 *
 * This interface abstracts those differences.
 */
export interface PlatformFormatter {
  /**
   * Format text as bold
   * Mattermost: **text**
   * Slack: *text*
   */
  formatBold(text: string): string;

  /**
   * Format text as italic
   * Mattermost: _text_ or *text*
   * Slack: _text_
   */
  formatItalic(text: string): string;

  /**
   * Format text as inline code
   * Both: `code`
   */
  formatCode(text: string): string;

  /**
   * Format text as code block with optional language
   * Both: ```lang\ncode\n```
   */
  formatCodeBlock(code: string, language?: string): string;

  /**
   * Format a user mention
   * Mattermost: @username
   * Slack: <@U123456> (requires user ID)
   */
  formatUserMention(username: string, userId?: string): string;

  /**
   * Format a hyperlink
   * Mattermost: [text](url)
   * Slack: <url|text>
   */
  formatLink(text: string, url: string): string;

  /**
   * Format a bulleted list item
   * Both: - item or * item
   */
  formatListItem(text: string): string;

  /**
   * Format a numbered list item
   * Both: 1. item
   */
  formatNumberedListItem(number: number, text: string): string;

  /**
   * Format a blockquote
   * Both: > text
   */
  formatBlockquote(text: string): string;

  /**
   * Format a horizontal rule
   * Both: ---
   */
  formatHorizontalRule(): string;

  /**
   * Format a heading
   * Both: # Heading (level 1), ## Heading (level 2), etc.
   */
  formatHeading(text: string, level: number): string;

  /**
   * Escape special characters in text to prevent formatting
   */
  escapeText(text: string): string;
}
