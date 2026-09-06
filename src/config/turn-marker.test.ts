import { describe, test, expect } from 'bun:test';
import { resolveTurnMarker } from './types.js';

describe('resolveTurnMarker', () => {
  test('omitted means off', () => {
    expect(resolveTurnMarker(undefined, undefined, 'slack', 'platforms[a]')).toEqual({ mode: 'off' });
    expect(resolveTurnMarker('off', undefined, 'mattermost', 'platforms[a]')).toEqual({ mode: 'off' });
  });

  test('reaction gets the default emoji, or the configured one', () => {
    expect(resolveTurnMarker('reaction', undefined, 'mattermost', 'p')).toEqual({ mode: 'reaction', emoji: 'checkered_flag' });
    expect(resolveTurnMarker('reaction', 'white_check_mark', 'slack', 'p')).toEqual({ mode: 'reaction', emoji: 'white_check_mark' });
  });

  test('metadata is Slack only', () => {
    expect(resolveTurnMarker('metadata', undefined, 'slack', 'p')).toEqual({ mode: 'metadata' });
    expect(() => resolveTurnMarker('metadata', undefined, 'mattermost', 'platforms[mm]')).toThrow('platforms[mm].turnMarker');
  });

  test('an emoji with another mode is ignored; a malformed one is an error naming the field', () => {
    expect(resolveTurnMarker('off', 'tada', 'slack', 'p')).toEqual({ mode: 'off' });
    expect(resolveTurnMarker('metadata', 'tada', 'slack', 'p')).toEqual({ mode: 'metadata' });
    expect(() => resolveTurnMarker('reaction', ':tada:', 'slack', 'p')).toThrow('p.turnMarkerEmoji');
    expect(() => resolveTurnMarker('emoji', undefined, 'slack', 'p')).toThrow('p.turnMarker');
  });
});
