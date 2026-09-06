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
});
