import { describe, test, expect } from 'bun:test';
import { resolveToolActivity } from './types.js';

describe('resolveToolActivity', () => {
  test('omitted means full with no details, exactly today\'s behaviour', () => {
    expect(resolveToolActivity(undefined, undefined, 'platforms[x]')).toEqual({ activity: 'full', details: 'none' });
  });

  test('summary defaults its details to a thread, hidden to none', () => {
    expect(resolveToolActivity('summary', undefined, 'p')).toEqual({ activity: 'summary', details: 'thread' });
    expect(resolveToolActivity('hidden', undefined, 'p')).toEqual({ activity: 'hidden', details: 'none' });
    expect(resolveToolActivity('summary', 'none', 'p')).toEqual({ activity: 'summary', details: 'none' });
  });

  test('details with full, or a thread under hidden, are config errors naming the field', () => {
    expect(() => resolveToolActivity('full', 'thread', 'platforms[slack-vvs]')).toThrow('platforms[slack-vvs].toolDetails');
    expect(() => resolveToolActivity('hidden', 'thread', 'platforms[slack-vvs]')).toThrow('hidden has no post');
  });

  test('unknown values are rejected with the field path', () => {
    expect(() => resolveToolActivity('quiet', undefined, 'platforms[a]')).toThrow('platforms[a].toolActivity');
    expect(() => resolveToolActivity('summary', 'commit', 'platforms[a]')).toThrow('platforms[a].toolDetails');
  });

  test('file: the directory defaults, the URL is optional, both are validated', () => {
    expect(resolveToolActivity('summary', 'file', 'p')).toEqual({ activity: 'summary', details: 'file', dir: '~/.claude-threads/tool-details', url: undefined });
    expect(resolveToolActivity('hidden', 'file', 'p', { dir: '/srv/details', url: 'https://agents.example.com/tool-details' }))
      .toEqual({ activity: 'hidden', details: 'file', dir: '/srv/details', url: 'https://agents.example.com/tool-details' });
    expect(() => resolveToolActivity('summary', 'file', 'p', { url: 'agents.example.com' })).toThrow('p.toolDetailsUrl');
    expect(() => resolveToolActivity('summary', 'file', 'p', { url: 'https://' })).toThrow('p.toolDetailsUrl');
    expect(() => resolveToolActivity('summary', 'file', 'p', { url: 'ftp://agents.example.com/x' })).toThrow('p.toolDetailsUrl');
    expect(() => resolveToolActivity('summary', 'file', 'p', { url: 'https://agents.example.com/x?y=1' })).toThrow('p.toolDetailsUrl');
    expect(() => resolveToolActivity('summary', 'file', 'p', { dir: '' })).toThrow('p.toolDetailsDir');
  });

  test('dir or url without file is a config error', () => {
    expect(() => resolveToolActivity('summary', 'thread', 'p', { url: 'https://x' })).toThrow('only meaningful with toolDetails file');
    expect(() => resolveToolActivity(undefined, undefined, 'p', { dir: '/x' })).toThrow('only meaningful with toolDetails file');
  });
});
