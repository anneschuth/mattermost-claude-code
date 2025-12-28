import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  shortenPath,
  parseMcpToolName,
  formatToolUse,
  formatToolForPermission,
} from './tool-formatter.js';

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
      });
      expect(result).toBe('📄 **Read** `~/file.ts`');
    });

    it('shows full path when not under home', () => {
      const result = formatToolUse('Read', { file_path: '/var/log/app.log' });
      expect(result).toBe('📄 **Read** `/var/log/app.log`');
    });
  });

  describe('Edit tool', () => {
    it('formats Edit without diff in non-detailed mode', () => {
      const result = formatToolUse('Edit', {
        file_path: '/Users/testuser/file.ts',
        old_string: 'old',
        new_string: 'new',
      });
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
      });
      expect(result).toBe('📝 **Write** `~/file.ts`');
    });

    it('formats Write with preview in detailed mode', () => {
      const result = formatToolUse(
        'Write',
        {
          file_path: '/Users/testuser/file.ts',
          content: 'line 1\nline 2\nline 3',
        },
        { detailed: true }
      );
      expect(result).toContain('📝 **Write** `~/file.ts`');
      expect(result).toContain('*(3 lines)*');
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
        { detailed: true }
      );
      expect(result).toContain('more lines');
    });
  });

  describe('Bash tool', () => {
    it('formats short commands', () => {
      const result = formatToolUse('Bash', { command: 'ls -la' });
      expect(result).toBe('💻 **Bash** `ls -la`');
    });

    it('truncates long commands', () => {
      const longCmd = 'x'.repeat(100);
      const result = formatToolUse('Bash', { command: longCmd });
      expect(result).not.toBeNull();
      expect(result).toContain('...');
      expect(result!.length).toBeLessThan(120);
    });

    it('respects custom maxCommandLength', () => {
      const result = formatToolUse(
        'Bash',
        { command: '1234567890' },
        { maxCommandLength: 5 }
      );
      expect(result).toBe('💻 **Bash** `12345...`');
    });
  });

  describe('Other tools', () => {
    it('formats Glob', () => {
      const result = formatToolUse('Glob', { pattern: '**/*.ts' });
      expect(result).toBe('🔍 **Glob** `**/*.ts`');
    });

    it('formats Grep', () => {
      const result = formatToolUse('Grep', { pattern: 'TODO' });
      expect(result).toBe('🔎 **Grep** `TODO`');
    });

    it('formats EnterPlanMode', () => {
      const result = formatToolUse('EnterPlanMode', {});
      expect(result).toBe('📋 **Planning...**');
    });

    it('formats WebFetch', () => {
      const result = formatToolUse('WebFetch', {
        url: 'https://example.com/page',
      });
      expect(result).toBe('🌐 **Fetching** `https://example.com/page`');
    });

    it('formats WebSearch', () => {
      const result = formatToolUse('WebSearch', { query: 'typescript guide' });
      expect(result).toBe('🔍 **Searching** `typescript guide`');
    });
  });

  describe('Tools that return null', () => {
    it('returns null for Task', () => {
      expect(formatToolUse('Task', {})).toBeNull();
    });

    it('returns null for ExitPlanMode', () => {
      expect(formatToolUse('ExitPlanMode', {})).toBeNull();
    });

    it('returns null for AskUserQuestion', () => {
      expect(formatToolUse('AskUserQuestion', {})).toBeNull();
    });

    it('returns null for TodoWrite', () => {
      expect(formatToolUse('TodoWrite', {})).toBeNull();
    });
  });

  describe('MCP tools', () => {
    it('formats MCP tools', () => {
      const result = formatToolUse('mcp__myserver__mytool', { arg: 'value' });
      expect(result).toBe('🔌 **mytool** *(myserver)*');
    });

    it('formats MCP tools with underscores in name', () => {
      const result = formatToolUse('mcp__my_server__my_tool', { arg: 'value' });
      expect(result).toBe('🔌 **my_tool** *(my_server)*');
    });
  });

  describe('Claude in Chrome tools', () => {
    it('formats computer screenshot action', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', { action: 'screenshot' });
      expect(result).toBe('🌐 **Chrome**[computer] `screenshot`');
    });

    it('formats computer click actions with coordinates', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'left_click',
        coordinate: [100, 200],
      });
      expect(result).toBe('🌐 **Chrome**[computer] `left_click at (100, 200)`');
    });

    it('formats computer type action', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'type',
        text: 'hello world',
      });
      expect(result).toBe('🌐 **Chrome**[computer] `type "hello world"`');
    });

    it('truncates long type text', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'type',
        text: 'this is a very long text that should be truncated',
      });
      expect(result).toContain('...');
    });

    it('formats computer key action', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'key',
        text: 'Enter',
      });
      expect(result).toBe('🌐 **Chrome**[computer] `key Enter`');
    });

    it('formats computer scroll action', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'scroll',
        scroll_direction: 'up',
      });
      expect(result).toBe('🌐 **Chrome**[computer] `scroll up`');
    });

    it('formats computer wait action', () => {
      const result = formatToolUse('mcp__claude-in-chrome__computer', {
        action: 'wait',
        duration: 2,
      });
      expect(result).toBe('🌐 **Chrome**[computer] `wait 2s`');
    });

    it('formats navigate tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__navigate', {
        url: 'https://example.com/page',
      });
      expect(result).toBe('🌐 **Chrome**[navigate] `https://example.com/page`');
    });

    it('truncates long URLs in navigate', () => {
      const result = formatToolUse('mcp__claude-in-chrome__navigate', {
        url: 'https://example.com/' + 'x'.repeat(100),
      });
      expect(result).toContain('...');
    });

    it('formats tabs_context_mcp tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__tabs_context_mcp', {});
      expect(result).toBe('🌐 **Chrome**[tabs] reading context');
    });

    it('formats tabs_create_mcp tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__tabs_create_mcp', {});
      expect(result).toBe('🌐 **Chrome**[tabs] creating new tab');
    });

    it('formats read_page tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__read_page', {});
      expect(result).toBe('🌐 **Chrome**[read_page] accessibility tree');
    });

    it('formats read_page tool with interactive filter', () => {
      const result = formatToolUse('mcp__claude-in-chrome__read_page', {
        filter: 'interactive',
      });
      expect(result).toBe('🌐 **Chrome**[read_page] interactive elements');
    });

    it('formats find tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__find', {
        query: 'login button',
      });
      expect(result).toBe('🌐 **Chrome**[find] `login button`');
    });

    it('formats form_input tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__form_input', {
        ref: 'ref_1',
        value: 'test',
      });
      expect(result).toBe('🌐 **Chrome**[form_input] setting value');
    });

    it('formats get_page_text tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__get_page_text', {});
      expect(result).toBe('🌐 **Chrome**[get_page_text] extracting content');
    });

    it('formats javascript_tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__javascript_tool', {
        text: 'document.title',
      });
      expect(result).toBe('🌐 **Chrome**[javascript] executing script');
    });

    it('formats gif_creator tool', () => {
      const result = formatToolUse('mcp__claude-in-chrome__gif_creator', {
        action: 'start_recording',
      });
      expect(result).toBe('🌐 **Chrome**[gif] start_recording');
    });

    it('formats unknown Chrome tools', () => {
      const result = formatToolUse('mcp__claude-in-chrome__new_tool', {});
      expect(result).toBe('🌐 **Chrome**[new_tool]');
    });
  });

  describe('Unknown tools', () => {
    it('formats unknown tools with bullet', () => {
      const result = formatToolUse('CustomTool', {});
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
    });
    expect(result).toBe('📄 **Read** `~/file.ts`');
  });

  it('formats Write tool', () => {
    const result = formatToolForPermission('Write', {
      file_path: '/Users/testuser/file.ts',
    });
    expect(result).toBe('📝 **Write** `~/file.ts`');
  });

  it('formats Edit tool', () => {
    const result = formatToolForPermission('Edit', {
      file_path: '/Users/testuser/file.ts',
    });
    expect(result).toBe('✏️ **Edit** `~/file.ts`');
  });

  it('formats Bash with longer truncation limit (100 chars)', () => {
    const cmd = 'x'.repeat(100);
    const result = formatToolForPermission('Bash', { command: cmd });
    // Should truncate at 100
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(150);
  });

  it('formats MCP tools', () => {
    const result = formatToolForPermission('mcp__server__tool', {});
    expect(result).toBe('🔌 **tool** *(server)*');
  });

  it('formats unknown tools', () => {
    const result = formatToolForPermission('CustomTool', {});
    expect(result).toBe('● **CustomTool**');
  });
});
