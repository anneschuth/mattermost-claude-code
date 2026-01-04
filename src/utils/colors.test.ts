import { describe, it, expect } from 'bun:test';
import { colors, dim, bold, cyan, green, red, yellow } from './colors.js';

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
