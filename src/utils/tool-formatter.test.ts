import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  shortenPath,
  parseMcpToolName,
  formatToolUse,
  formatToolForPermission,
} from './tool-formatter.js';
import type { PlatformFormatter } from '../platform/formatter.js';

// Mock formatter for tests - uses standard markdown syntax
const formatter: PlatformFormatter = {
  formatBold: (text: string) => `**${text}**`,
  formatItalic: (text: string) => `_${text}_`,
  formatCode: (text: string) => `\`${text}\``,
  formatCodeBlock: (code: string, language?: string) =>
    language ? `\`\`\`${language}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``,
  formatUserMention: (username: string) => `@${username}`,
  formatLink: (text: string, url: string) => `[${text}](${url})`,
  formatListItem: (text: string) => `- ${text}`,
  formatNumberedListItem: (num: number, text: string) => `${num}. ${text}`,
  formatBlockquote: (text: string) => `> ${text}`,
  formatHorizontalRule: () => '---',
  formatHeading: (text: string, level: number) => `${'#'.repeat(level)} ${text}`,
  escapeText: (text: string) => text,
};

describe('shortenPath', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = '/Users/testuser';
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it('replaces home directory with ~', () => {
    expect(shortenPath('/Users/testuser/projects/file.ts')).toBe(
      '~/projects/file.ts'
    );
  });

  it('leaves paths not under home unchanged', () => {
    expect(shortenPath('/var/log/file.log')).toBe('/var/log/file.log');
  });

  it('handles empty path', () => {
    expect(shortenPath('')).toBe('');
  });

  it('uses provided homeDir over env', () => {
    expect(shortenPath('/custom/home/file.ts', '/custom/home')).toBe(
      '~/file.ts'
    );
  });

  it('handles path equal to home', () => {
    expect(shortenPath('/Users/testuser')).toBe('~');
  });
});

describe('parseMcpToolName', () => {
  it('parses valid MCP tool names', () => {
    expect(parseMcpToolName('mcp__server__tool')).toEqual({
      server: 'server',
      tool: 'tool',
    });
  });

  it('handles tool names with underscores', () => {
    expect(parseMcpToolName('mcp__my-server__my_complex__tool')).toEqual({
      server: 'my-server',
      tool: 'my_complex__tool',
    });
  });

  it('returns null for non-MCP tools', () => {
    expect(parseMcpToolName('Read')).toBeNull();
    expect(parseMcpToolName('Write')).toBeNull();
    expect(parseMcpToolName('Bash')).toBeNull();
  });

  it('returns null for invalid MCP format', () => {
    expect(parseMcpToolName('mcp__')).toBeNull();
    expect(parseMcpToolName('mcp__server')).toBeNull();
  });

  it('handles claude-in-chrome tools', () => {
    expect(parseMcpToolName('mcp__claude-in-chrome__computer')).toEqual({
      server: 'claude-in-chrome',
      tool: 'computer',
    });
  });
});

describe('formatToolUse', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = '/Users/testuser';
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  describe('Read tool', () => {
    it('formats Read with file path', () => {
      const result = formatToolUse('Read', {
        file_path: '/Users/testuser/file.ts',
      }, formatter);
      expect(result).toBe('📄 **Read** `~/file.ts`');
    });

    it('shows full path when not under home', () => {
      const result = formatToolUse('Read', { file_path: '/var/log/app.log' }, formatter);
      expect(result).toBe('📄 **Read** `/var/log/app.log`');
    });
  });

  describe('Edit tool', () => {
    it('formats Edit without diff in non-detailed mode', () => {
      const result = formatToolUse('Edit', {
        file_path: '/Users/testuser/file.ts',
        old_string: 'old',
        new_string: 'new',
      }, formatter);
      expect(result).toBe('✏️ **Edit** `~/file.ts`');
    });

    it('formats Edit with diff in detailed mode', () => {
      const result = formatToolUse(
        'Edit',
        {
          file_path: '/Users/testuser/file.ts',
          old_string: 'old line',
          new_string: 'new line',
        },
        formatter,
        { detailed: true }
      );
      expect(result).toContain('✏️ **Edit** `~/file.ts`');
      expect(result).toContain('```diff');
      expect(result).toContain('- old line');
      expect(result).toContain('+ new line');
    });

    it('truncates long diffs', () => {
      const oldLines = Array(30).fill('old line').join('\n');
      const newLines = Array(30).fill('new line').join('\n');
      const result = formatToolUse(
        'Edit',
        {
          file_path: '/Users/testuser/file.ts',
          old_string: oldLines,
          new_string: newLines,
        },
        formatter,
        { detailed: true, maxPreviewLines: 10 }
      );
      expect(result).toContain('more lines');
    });
  });

  describe('Write tool', () => {
    it('formats Write without preview in non-detailed mode', () => {
      const result = formatToolUse('Write', {
        file_path: '/Users/testuser/file.ts',
        content: 'hello world',
      }, formatter);
      expect(result).toBe('📝 **Write** `~/file.ts`');
    });

    it('formats Write with preview in detailed mode', () => {
      const result = formatToolUse(
        'Write',
        {
          file_path: '/Users/testuser/file.ts',
          content: 'line 1\nline 2\nline 3',
        },
        formatter,
        { detailed: true }
      );
      expect(result).toContain('📝 **Write** `~/file.ts`');
      expect(result).toContain('_(3 lines)_');
      expect(result).toContain('line 1');
    });

    it('truncates long content previews', () => {
      const content = Array(20).fill('line').join('\n');
      const result = formatToolUse(
        'Write',
        {
          file_path: '/Users/testuser/file.ts',
          content,
        },
        formatter,
        { detailed: true }
      );
      expect(result).toContain('more lines');
    });
  });

  describe('Bash tool', () => {
    it('formats short commands', () => {
      const result = formatToolUse('Bash', { command: 'ls -la' }, formatter);
      expect(result).toBe('💻 **Bash** `ls -la`');
    });

    it('truncates long commands', () => {
      const longCmd = 'x'.repeat(100);
      const result = formatToolUse('Bash', { command: longCmd }, formatter);
      expect(result).not.toBeNull();
      expect(result).toContain('...');
      expect(result!.length).toBeLessThan(120);
    });

    it('respects custom maxCommandLength', () => {
      const result = formatToolUse(
        'Bash',
        { command: '1234567890' },
        formatter,
        { maxCommandLength: 5 }
      );
      expect(result).toBe('💻 **Bash** `12345...`');
    });
  });

  describe('Other tools', () => {
    it('formats Glob', () => {
      const result = formatToolUse('Glob', { pattern: '**/*.ts' }, formatter);
      expect(result).toBe('🔍 **Glob** `**/*.ts`');
    });

    it('formats Grep', () => {
      const result = formatToolUse('Grep', { pattern: 'TODO' }, formatter);
      expect(result).toBe('🔎 **Grep** `TODO`');
    });

    it('formats EnterPlanMode', () => {
      const result = formatToolUse('EnterPlanMode', {}, formatter);
      expect(result).toBe('📋 **Planning...**');
    });

    it('formats WebFetch', () => {
      const result = formatToolUse('WebFetch', {
        url: 'https://example.com/page',
      }, formatter);
      expect(result).toBe('🌐 **Fetching** `https://example.com/page`');
    });

    it('formats WebSearch', () => {
      const result = formatToolUse('WebSearch', { query: 'typescript guide' }, formatter);
      expect(result).toBe('🔍 **Searching** `typescript guide`');
    });
  });

  describe('Tools that return null', () => {
    it('returns null for Task', () => {
      expect(formatToolUse('Task', {}, formatter)).toBeNull();
    });

    it('returns null for ExitPlanMode', () => {
      expect(formatToolUse('ExitPlanMode', {}, formatter)).toBeNull();
    });

    it('returns null for AskUserQuestion', () => {
      expect(formatToolUse('AskUserQuestion', {}, formatter)).toBeNull();
    });

    it('returns null for TodoWrite', () => {
      expect(formatToolUse('TodoWrite', {}, formatter)).toBeNull();
    });
  });

  describe('MCP tools', () => {
    it('formats MCP tools', () => {
      const result = formatToolUse('mcp__myserver__mytool', { arg: 'value' }, formatter);
      expect(result).toBe('🔌 **mytool** _(myserver)_');
    });

    it('formats MCP tools with underscores in name', () => {
      const result = formatToolUse('mcp__my_server__my_tool', { arg: 'value' }, formatter);
      expect(result).toBe('🔌 **my_tool** _(my_server)_');
    });
  });

  describe('Claude in Chrome tools', () => {
    it('formats computer screenshot action', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', { action: 'screenshot' }, formatter);
      expect(result).toBe('🌐 **Chrome**[computer] `screenshot`');
    });

    it('formats computer click actions with coordinates', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'left_click',
        coordinate: [100, 200],
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[computer] `left_click at (100, 200)`');
    });

    it('formats computer type action', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'type',
        text: 'hello world',
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[computer] `type "hello world"`');
    });

    it('truncates long type text', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'type',
        text: 'this is a very long text that should be truncated',
      }, formatter);
      expect(result).toContain('...');
    });

    it('formats computer key action', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'key',
        text: 'Enter',
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[computer] `key Enter`');
    });

    it('formats computer scroll action', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'scroll',
        scroll_direction: 'up',
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[computer] `scroll up`');
    });

    it('formats computer wait action', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'wait',
        duration: 2,
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[computer] `wait 2s`');
    });

    it('formats navigate tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__navigate', {
        url: 'https://example.com/page',
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[navigate] `https://example.com/page`');
    });

    it('truncates long URLs in navigate', () => {
      const result = formatToolUse('mcp__claude-in-chrome__navigate', {
        url: 'https://example.com/' + 'x'.repeat(100),
      }, formatter);
      expect(result).toContain('...');
    });

    it('formats tabs_context_mcp tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__tabs_context_mcp', {}, formatter);
      expect(result).toBe('🌐 **Chrome**[tabs] reading context');
    });

    it('formats tabs_create_mcp tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__tabs_create_mcp', {}, formatter);
      expect(result).toBe('🌐 **Chrome**[tabs] creating new tab');
    });

    it('formats read_page tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__read_page', {}, formatter);
      expect(result).toBe('🌐 **Chrome**[read_page] accessibility tree');
    });

    it('formats read_page tool with interactive filter', () => {
      const result = formatToolUse('mcp__claude-in-chrome__read_page', {
        filter: 'interactive',
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[read_page] interactive elements');
    });

    it('formats find tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__find', {
        query: 'login button',
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[find] `login button`');
    });

    it('formats form_input tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__form_input', {
        ref: 'ref_1',
        value: 'test',
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[form_input] setting value');
    });

    it('formats get_page_text tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__get_page_text', {}, formatter);
      expect(result).toBe('🌐 **Chrome**[get_page_text] extracting content');
    });

    it('formats javascript_tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__javascript_tool', {
        text: 'document.title',
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[javascript] executing script');
    });

    it('formats gif_creator tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__gif_creator', {
        action: 'start_recording',
      }, formatter);
      expect(result).toBe('🌐 **Chrome**[gif] start_recording');
    });

    it('formats unknown Chrome tools', () => {
      const result = formatToolUse('mcp__claude-in-chrome__new_tool', {}, formatter);
      expect(result).toBe('🌐 **Chrome**[new_tool]');
    });
  });

  describe('Unknown tools', () => {
    it('formats unknown tools with bullet', () => {
      const result = formatToolUse('CustomTool', {}, formatter);
      expect(result).toBe('● **CustomTool**');
    });
  });
});

describe('formatToolForPermission', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = '/Users/testuser';
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it('formats Read tool', () => {
    const result = formatToolForPermission('Read', {
      file_path: '/Users/testuser/file.ts',
    }, formatter);
    expect(result).toBe('📄 **Read** `~/file.ts`');
  });

  it('formats Write tool', () => {
    const result = formatToolForPermission('Write', {
      file_path: '/Users/testuser/file.ts',
    }, formatter);
    expect(result).toBe('📝 **Write** `~/file.ts`');
  });

  it('formats Edit tool', () => {
    const result = formatToolForPermission('Edit', {
      file_path: '/Users/testuser/file.ts',
    }, formatter);
    expect(result).toBe('✏️ **Edit** `~/file.ts`');
  });

  it('formats Bash with longer truncation limit (100 chars)', () => {
    const cmd = 'x'.repeat(100);
    const result = formatToolForPermission('Bash', { command: cmd }, formatter);
    // Should truncate at 100
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(150);
  });

  it('formats MCP tools', () => {
    const result = formatToolForPermission('mcp__server__tool', {}, formatter);
    expect(result).toBe('🔌 **tool** _(server)_');
  });

  it('formats unknown tools', () => {
    const result = formatToolForPermission('CustomTool', {}, formatter);
    expect(result).toBe('● **CustomTool**');
  });
});
