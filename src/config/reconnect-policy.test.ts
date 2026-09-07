import { describe, test, expect } from 'bun:test';
import { resolveReconnectPolicy } from './types.js';

describe('resolveReconnectPolicy', () => {
  test('defaults to retry, which needs no supervisor to recover', () => {
    // The maintainer's call on #531: a hand-run bot dying silently at 3am
    // because the wifi dropped is a worse default than a noisy retry loop.
    expect(resolveReconnectPolicy(undefined, 'platforms[x]')).toBe('retry');
    expect(resolveReconnectPolicy(null, 'platforms[x]')).toBe('retry');
  });

  test('accepts exit for supervised deployments', () => {
    expect(resolveReconnectPolicy('exit', 'platforms[x]')).toBe('exit');
    expect(resolveReconnectPolicy('retry', 'platforms[x]')).toBe('retry');
  });

  test('rejects anything else with the field path', () => {
    expect(() => resolveReconnectPolicy('restart', 'platforms[slack-a]')).toThrow('platforms[slack-a].reconnectPolicy');
    expect(() => resolveReconnectPolicy(true, 'platforms[slack-a]')).toThrow('platforms[slack-a].reconnectPolicy');
  });
});
