/**
 * Tool formatting utilities for displaying Claude tool calls in chat platforms
 *
 * This module provides shared formatting logic used by both:
 * - src/session/events.ts (main bot)
 * - src/mcp/permission-server.ts (MCP permission handler)
 *
 * Uses PlatformFormatter abstraction to support different markdown dialects
 * (e.g., standard markdown vs Slack mrkdwn).
 */

import * as Diff from 'diff';
import type { PlatformFormatter } from '../platform/formatter.js';

export interface ToolInput {
  [key: string]: unknown;
}

export interface FormatOptions {
  /** Include detailed previews (diffs, file content). Default: false */
  detailed?: boolean;
  /** Max command length for Bash. Default: 50 */
  maxCommandLength?: number;
  /** Max path display length. Default: 60 */
  maxPathLength?: number;
  /** Max lines to show in previews. Default: 20 for diff, 6 for content */
  maxPreviewLines?: number;
}

const DEFAULT_OPTIONS: Required<FormatOptions> = {
  detailed: false,
  maxCommandLength: 50,
  maxPathLength: 60,
  maxPreviewLines: 20,
};

/**
 * Shorten a file path for display by replacing home directory with ~
 */
export function shortenPath(path: string, homeDir?: string): string {
  if (!path) return '';
  const home = homeDir ?? process.env.HOME ?? '';
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
}

/**
 * Check if a tool name is an MCP tool and extract server/tool parts
 */
export function parseMcpToolName(
  toolName: string
): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;

  const parts = toolName.split('__');
  if (parts.length < 3) return null;

  return {
    server: parts[1],
    tool: parts.slice(2).join('__'),
  };
}

/**
 * Format a tool use for display in chat platforms
 *
 * @param toolName - The name of the tool being called
 * @param input - The tool input parameters
 * @param options - Formatting options
 * @returns Formatted string or null if the tool should not be displayed
 */
export function formatToolUse(
  toolName: string,
  input: ToolInput,
  formatter: PlatformFormatter,
  options: FormatOptions = {}
): string | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const short = (p: string) => shortenPath(p);

  switch (toolName) {
    case 'Read':
      return `📄 ${formatter.formatBold('Read')} ${formatter.formatCode(short(input.file_path as string))}`;

    case 'Edit': {
      const filePath = short(input.file_path as string);
      const oldStr = (input.old_string as string) || '';
      const newStr = (input.new_string as string) || '';

      // Show diff if detailed mode and we have old/new strings
      if (opts.detailed && (oldStr || newStr)) {
        const changes = Diff.diffLines(oldStr, newStr);
        const maxLines = opts.maxPreviewLines;
        let lineCount = 0;
        const diffLines: string[] = [];

        for (const change of changes) {
          const lines = change.value.replace(/\n$/, '').split('\n');
          for (const line of lines) {
            if (lineCount >= maxLines) break;
            if (change.added) {
              diffLines.push(`+ ${line}`);
              lineCount++;
            } else if (change.removed) {
              diffLines.push(`- ${line}`);
              lineCount++;
            } else {
              diffLines.push(`  ${line}`);
              lineCount++;
            }
          }
          if (lineCount >= maxLines) break;
        }

        const totalLines = changes.reduce(
          (sum, c) => sum + c.value.split('\n').length - 1,
          0
        );

        let diff = `✏️ ${formatter.formatBold('Edit')} ${formatter.formatCode(filePath)}\n${formatter.formatCodeBlock(diffLines.join('\n'), 'diff')}`;
        if (totalLines > maxLines) {
          diff = `✏️ ${formatter.formatBold('Edit')} ${formatter.formatCode(filePath)}\n`;
          diff += formatter.formatCodeBlock(
            diffLines.join('\n') + `\n... (+${totalLines - maxLines} more lines)`,
            'diff'
          );
        }
        return diff;
      }
      return `✏️ ${formatter.formatBold('Edit')} ${formatter.formatCode(filePath)}`;
    }

    case 'Write': {
      const filePath = short(input.file_path as string);
      const content = (input.content as string) || '';
      const lines = content.split('\n');
      const lineCount = lines.length;

      // Show preview if detailed mode
      if (opts.detailed && content && lineCount > 0) {
        const maxLines = 6;
        const previewLines = lines.slice(0, maxLines);
        let preview = `📝 ${formatter.formatBold('Write')} ${formatter.formatCode(filePath)} ${formatter.formatItalic(`(${lineCount} lines)`)}\n`;
        if (lineCount > maxLines) {
          preview += formatter.formatCodeBlock(
            previewLines.join('\n') + `\n... (${lineCount - maxLines} more lines)`
          );
        } else {
          preview += formatter.formatCodeBlock(previewLines.join('\n'));
        }
        return preview;
      }
      return `📝 ${formatter.formatBold('Write')} ${formatter.formatCode(filePath)}`;
    }

    case 'Bash': {
      const cmd = ((input.command as string) || '').substring(
        0,
        opts.maxCommandLength
      );
      const truncated = cmd.length >= opts.maxCommandLength;
      return `💻 ${formatter.formatBold('Bash')} ${formatter.formatCode(cmd + (truncated ? '...' : ''))}`;
    }

    case 'Glob':
      return `🔍 ${formatter.formatBold('Glob')} ${formatter.formatCode(input.pattern as string)}`;

    case 'Grep':
      return `🔎 ${formatter.formatBold('Grep')} ${formatter.formatCode(input.pattern as string)}`;

    case 'Task':
      return null; // Handled specially with subagent display

    case 'EnterPlanMode':
      return `📋 ${formatter.formatBold('Planning...')}`;

    case 'ExitPlanMode':
      return null; // Handled specially with approval buttons

    case 'AskUserQuestion':
      return null; // Don't show, the question text follows

    case 'TodoWrite':
      return null; // Handled specially with task list display

    case 'WebFetch': {
      const url = ((input.url as string) || '').substring(0, 40);
      return `🌐 ${formatter.formatBold('Fetching')} ${formatter.formatCode(url)}`;
    }

    case 'WebSearch':
      return `🔍 ${formatter.formatBold('Searching')} ${formatter.formatCode(input.query as string)}`;

    default: {
      // Handle MCP tools: mcp__server__tool
      const mcpParts = parseMcpToolName(toolName);
      if (mcpParts) {
        // Special formatting for Claude in Chrome tools
        if (mcpParts.server === 'claude-in-chrome') {
          return formatChromeToolUse(mcpParts.tool, input, formatter);
        }
        return `🔌 ${formatter.formatBold(mcpParts.tool)} ${formatter.formatItalic(`(${mcpParts.server})`)}`;
      }
      return `● ${formatter.formatBold(toolName)}`;
    }
  }
}

/**
 * Format tool info for permission prompts (simpler format)
 *
 * @param toolName - The name of the tool
 * @param input - The tool input parameters
 * @param formatter - Platform-specific markdown formatter
 * @returns Formatted string for permission prompts
 */
export function formatToolForPermission(
  toolName: string,
  input: ToolInput,
  formatter: PlatformFormatter
): string {
  const short = (p: string) => shortenPath(p);

  switch (toolName) {
    case 'Read':
      return `📄 ${formatter.formatBold('Read')} ${formatter.formatCode(short(input.file_path as string))}`;
    case 'Write':
      return `📝 ${formatter.formatBold('Write')} ${formatter.formatCode(short(input.file_path as string))}`;
    case 'Edit':
      return `✏️ ${formatter.formatBold('Edit')} ${formatter.formatCode(short(input.file_path as string))}`;
    case 'Bash': {
      const cmd = ((input.command as string) || '').substring(0, 100);
      return `💻 ${formatter.formatBold('Bash')} ${formatter.formatCode(cmd + (cmd.length >= 100 ? '...' : ''))}`;
    }
    default: {
      const mcpParts = parseMcpToolName(toolName);
      if (mcpParts) {
        return `🔌 ${formatter.formatBold(mcpParts.tool)} ${formatter.formatItalic(`(${mcpParts.server})`)}`;
      }
      return `● ${formatter.formatBold(toolName)}`;
    }
  }
}

/**
 * Format Claude in Chrome tool calls
 *
 * @param tool - The Chrome tool name (after mcp__claude-in-chrome__)
 * @param input - The tool input parameters
 * @param formatter - Platform-specific markdown formatter
 * @returns Formatted string for display
 */
function formatChromeToolUse(
  tool: string,
  input: ToolInput,
  formatter: PlatformFormatter
): string {
  const action = (input.action as string) || '';
  const coord = input.coordinate as number[] | undefined;
  const url = (input.url as string) || '';
  const text = (input.text as string) || '';

  switch (tool) {
    case 'computer': {
      let detail = '';
      switch (action) {
        case 'screenshot':
          detail = 'screenshot';
          break;
        case 'left_click':
        case 'right_click':
        case 'double_click':
        case 'triple_click':
          detail = coord ? `${action} at (${coord[0]}, ${coord[1]})` : action;
          break;
        case 'type':
          detail = `type "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`;
          break;
        case 'key':
          detail = `key ${text}`;
          break;
        case 'scroll':
          detail = `scroll ${input.scroll_direction || 'down'}`;
          break;
        case 'wait':
          detail = `wait ${input.duration}s`;
          break;
        default:
          detail = action || 'action';
      }
      return `🌐 ${formatter.formatBold('Chrome')}[computer] ${formatter.formatCode(detail)}`;
    }
    case 'navigate':
      return `🌐 ${formatter.formatBold('Chrome')}[navigate] ${formatter.formatCode(url.substring(0, 50) + (url.length > 50 ? '...' : ''))}`;
    case 'tabs_context_mcp':
      return `🌐 ${formatter.formatBold('Chrome')}[tabs] reading context`;
    case 'tabs_create_mcp':
      return `🌐 ${formatter.formatBold('Chrome')}[tabs] creating new tab`;
    case 'read_page':
      return `🌐 ${formatter.formatBold('Chrome')}[read_page] ${input.filter === 'interactive' ? 'interactive elements' : 'accessibility tree'}`;
    case 'find':
      return `🌐 ${formatter.formatBold('Chrome')}[find] ${formatter.formatCode((input.query as string) || '')}`;
    case 'form_input':
      return `🌐 ${formatter.formatBold('Chrome')}[form_input] setting value`;
    case 'get_page_text':
      return `🌐 ${formatter.formatBold('Chrome')}[get_page_text] extracting content`;
    case 'javascript_tool':
      return `🌐 ${formatter.formatBold('Chrome')}[javascript] executing script`;
    case 'gif_creator':
      return `🌐 ${formatter.formatBold('Chrome')}[gif] ${action}`;
    default:
      return `🌐 ${formatter.formatBold('Chrome')}[${tool}]`;
  }
}
