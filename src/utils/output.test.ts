import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { colors, dim, bold, cyan, green, red, yellow, log, debug, error, warn, logPlain, logEmpty } from './output.js';

describe('colors', () => {
  it('exports ANSI color codes', () => {
    expect(colors.reset).toBe('\x1b[0m');
    expect(colors.bold).toBe('\x1b[1m');
    expect(colors.dim).toBe('\x1b[2m');
    expect(colors.cyan).toBe('\x1b[36m');
    expect(colors.green).toBe('\x1b[32m');
    expect(colors.red).toBe('\x1b[31m');
    expect(colors.yellow).toBe('\x1b[33m');
    expect(colors.blue).toBe('\x1b[38;5;27m');
    expect(colors.orange).toBe('\x1b[38;5;209m');
  });
});

describe('styling helpers', () => {
  it('dim wraps text with dim codes', () => {
    expect(dim('test')).toBe('\x1b[2mtest\x1b[0m');
  });

  it('bold wraps text with bold codes', () => {
    expect(bold('test')).toBe('\x1b[1mtest\x1b[0m');
  });

  it('cyan wraps text with cyan codes', () => {
    expect(cyan('test')).toBe('\x1b[36mtest\x1b[0m');
  });

  it('green wraps text with green codes', () => {
    expect(green('test')).toBe('\x1b[32mtest\x1b[0m');
  });

  it('red wraps text with red codes', () => {
    expect(red('test')).toBe('\x1b[31mtest\x1b[0m');
  });

  it('yellow wraps text with yellow codes', () => {
    expect(yellow('test')).toBe('\x1b[33mtest\x1b[0m');
  });
});

describe('logging functions', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env.DEBUG;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DEBUG;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (originalEnv !== undefined) {
      process.env.DEBUG = originalEnv;
    } else {
      delete process.env.DEBUG;
    }
  });

  describe('log', () => {
    it('logs with emoji and 2-space indent', () => {
      log('☕', 'test message');
      expect(consoleLogSpy).toHaveBeenCalledWith('  ☕ test message');
    });
  });

  describe('debug', () => {
    it('does not log when DEBUG is not set', () => {
      debug('☕', 'test message');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('logs with dim styling when DEBUG=1', () => {
      process.env.DEBUG = '1';
      debug('☕', 'test message');
      expect(consoleLogSpy).toHaveBeenCalledWith(`  ☕ ${dim('test message')}`);
    });
  });

  describe('error', () => {
    it('logs to stderr with emoji and 2-space indent', () => {
      error('❌', 'error message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('  ❌ error message');
    });
  });

  describe('warn', () => {
    it('logs with emoji and 2-space indent', () => {
      warn('⚠️', 'warning message');
      expect(consoleLogSpy).toHaveBeenCalledWith('  ⚠️ warning message');
    });
  });

  describe('logPlain', () => {
    it('logs with 2-space indent but no emoji', () => {
      logPlain('plain message');
      expect(consoleLogSpy).toHaveBeenCalledWith('  plain message');
    });
  });

  describe('logEmpty', () => {
    it('logs an empty line', () => {
      logEmpty();
      expect(consoleLogSpy).toHaveBeenCalledWith('');
    });
  });
});
