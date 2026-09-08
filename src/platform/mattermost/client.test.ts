/**
 * Unit tests for MattermostClient. HTTP calls are isolated by stubbing
 * `global.fetch`; WebSocket paths are exercised via the pure helpers.
 */

import { installFetchHarness, jsonResponse, type FetchResponder } from '../test-helpers/fetch-harness.js';
import { describe, it, expect } from 'bun:test';
import { MattermostClient } from './client.js';
import type { MattermostPlatformConfig } from '../../config/index.js';

// -----------------------------------------------------------------------------
// Fetch harness
// -----------------------------------------------------------------------------

let fetchResponder: FetchResponder = () => jsonResponse({});
const harness = installFetchHarness(() => fetchResponder);
const fetchCalls = harness.calls;

function errorResponse(status: number, text = 'oops'): Response {
  return new Response(text, { status });
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeConfig(overrides: Partial<MattermostPlatformConfig> = {}): MattermostPlatformConfig {
  return {
    id: 'mm-main',
    type: 'mattermost',
    displayName: 'Main',
    url: 'https://chat.example.test',
    token: 'secret-token',
    channelId: 'c-123',
    botName: 'claude',
    allowedUsers: ['alice', 'bob'],
    skipPermissions: false,
    ...overrides,
  };
}

function makeClient(overrides: Partial<MattermostPlatformConfig> = {}): MattermostClient {
  return new MattermostClient(makeConfig(overrides));
}

// -----------------------------------------------------------------------------
// Pure method tests
// -----------------------------------------------------------------------------

describe('MattermostClient pure helpers', () => {
  it('getMessageLimits returns Mattermost defaults', () => {
    expect(makeClient().getMessageLimits()).toEqual({ maxLength: 16000, hardThreshold: 14000 });
  });

  it('retryDelayMs grows exponentially, caps, and stays within equal-jitter bounds', () => {
    const c = makeClient();
    // ceil(n) = min(500 * 2^n, 2000); equal jitter => result in [ceil/2, ceil].
    const ceils = [500, 1000, 2000, 2000, 2000, 2000];
    for (let n = 0; n < ceils.length; n++) {
      const ceil = ceils[n];
      // Sample repeatedly to exercise the random jitter.
      for (let i = 0; i < 200; i++) {
        const d = c.retryDelayMs(n);
        expect(d).toBeGreaterThanOrEqual(ceil / 2);
        expect(d).toBeLessThanOrEqual(ceil);
      }
    }
  });

  it('retryDelayMs never exceeds the cap even for large retry counts', () => {
    const c = makeClient();
    for (let i = 0; i < 200; i++) {
      // Well past MAX_RETRIES — must still be bounded by the 2000ms cap.
      expect(c.retryDelayMs(20)).toBeLessThanOrEqual(2000);
    }
  });

  it('isBotMentioned matches @botname at start and mid-message', () => {
    const c = makeClient({ botName: 'claude' });
    expect(c.isBotMentioned('@claude do stuff')).toBe(true);
    expect(c.isBotMentioned('hey @claude please')).toBe(true);
    expect(c.isBotMentioned('no mention here')).toBe(false);
    expect(c.isBotMentioned('email me at claude@example.com')).toBe(false);
  });

  it('isBotMentioned is case-insensitive', () => {
    const c = makeClient({ botName: 'Claude' });
    expect(c.isBotMentioned('@claude hi')).toBe(true);
    expect(c.isBotMentioned('@CLAUDE hi')).toBe(true);
  });

  it('isBotMentioned handles bot names with special regex chars', () => {
    const c = makeClient({ botName: 'bot.v2' });
    expect(c.isBotMentioned('@bot.v2 hello')).toBe(true);
    // Literal dot should NOT match arbitrary chars
    expect(c.isBotMentioned('@botXv2 hello')).toBe(false);
  });

  it('extractPrompt strips bot mention and trims', () => {
    const c = makeClient({ botName: 'claude' });
    expect(c.extractPrompt('@claude write a test')).toBe('write a test');
    expect(c.extractPrompt('hey @claude fix this')).toBe('hey  fix this'.trim());
  });

  it('getMcpConfig exposes the platform credentials', () => {
    const c = makeClient({ url: 'https://x', token: 't', channelId: 'cc', allowedUsers: ['u'] });
    expect(c.getMcpConfig()).toEqual({
      type: 'mattermost',
      url: 'https://x',
      token: 't',
      channelId: 'cc',
      allowedUsers: ['u'],
      outboundFiles: undefined,
      mcpServers: undefined,
      strictMcpConfig: undefined,
      claudeAiConnectors: undefined,
    });
  });

  it('getMcpConfig carries the MCP posture and declared servers through (#560)', () => {
    const mcpServers = { gh: { type: 'stdio' as const, command: 'gh-mcp', args: ['--x'], env: { T: '1' } } };
    const c = makeClient({ mcpServers, strictMcpConfig: true, claudeAiConnectors: true });
    const mcp = c.getMcpConfig();
    expect(mcp.mcpServers).toEqual(mcpServers);
    expect(mcp.strictMcpConfig).toBe(true);
    expect(mcp.claudeAiConnectors).toBe(true);
  });

  it('getMcpConfig surfaces outboundFiles when configured', () => {
    const c = makeClient({
      url: 'https://x',
      token: 't',
      channelId: 'cc',
      allowedUsers: ['u'],
      outboundFiles: { enabled: false, maxBytes: 5_000_000 },
    });
    expect(c.getMcpConfig().outboundFiles).toEqual({ enabled: false, maxBytes: 5_000_000 });
  });

  it('getFormatter returns a stable formatter instance', () => {
    const c = makeClient();
    expect(c.getFormatter()).toBe(c.getFormatter());
  });

  it('getThreadLink uses lastMessageId when provided', () => {
    const c = makeClient({ url: 'https://x.test' });
    expect(c.getThreadLink('thread-1')).toBe('https://x.test/_redirect/pl/thread-1');
    expect(c.getThreadLink('thread-1', 'msg-9')).toBe('https://x.test/_redirect/pl/msg-9');
  });

  it('getPostPermalink links to the specific post, not the thread root', () => {
    const c = makeClient({ url: 'https://x.test' });
    const post = { id: 'reply-42', platformId: 'mm', channelId: 'c1', userId: 'u1', message: 'hi', rootId: 'thread-1' } as any;
    expect(c.getPostPermalink(post)).toBe('https://x.test/_redirect/pl/reply-42');
  });

  it('platform identity fields reflect config', () => {
    const c = makeClient({ id: 'mm-x', displayName: 'X' });
    expect(c.platformId).toBe('mm-x');
    expect(c.displayName).toBe('X');
    expect(c.platformType).toBe('mattermost');
  });
});

// -----------------------------------------------------------------------------
// HTTP method tests
// -----------------------------------------------------------------------------

describe('MattermostClient HTTP methods', () => {
  it('createPost posts to /posts with channel and body, returns normalized post', async () => {
    fetchResponder = () =>
      jsonResponse({
        id: 'p-1',
        channel_id: 'c-123',
        user_id: 'bot',
        message: 'hi',
        root_id: '',
        create_at: 1000,
      });
    const c = makeClient();
    const post = await c.createPost('hi');
    expect(post.id).toBe('p-1');
    expect(post.channelId).toBe('c-123');
    expect(post.userId).toBe('bot');
    expect(post.platformId).toBe('mm-main');

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe('https://chat.example.test/api/v4/posts');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer secret-token');
    expect(call.body).toEqual({ channel_id: 'c-123', message: 'hi', root_id: undefined });
  });

  it('createPost includes root_id when threadId is given', async () => {
    fetchResponder = () =>
      jsonResponse({ id: 'p', channel_id: 'c', user_id: 'u', message: '', root_id: 't', create_at: 1 });
    await makeClient().createPost('reply', 'thread-abc');
    expect((fetchCalls[0].body as Record<string, unknown>).root_id).toBe('thread-abc');
  });

  it('updatePost PUTs to /posts/:id', async () => {
    fetchResponder = () =>
      jsonResponse({ id: 'p-1', channel_id: 'c', user_id: 'u', message: 'updated', root_id: '', create_at: 1 });
    const result = await makeClient().updatePost('p-1', 'updated');
    expect(result.message).toBe('updated');
    expect(fetchCalls[0].method).toBe('PUT');
    expect(fetchCalls[0].url).toContain('/posts/p-1');
  });

  it('addReaction POSTs to /reactions', async () => {
    fetchResponder = () => jsonResponse({});
    await makeClient().addReaction('p-1', '+1');
    const call = fetchCalls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/reactions');
    expect((call.body as Record<string, unknown>).emoji_name).toBe('+1');
    expect((call.body as Record<string, unknown>).post_id).toBe('p-1');
  });

  it('removeReaction DELETEs to scoped endpoint', async () => {
    fetchResponder = () => jsonResponse({});
    await makeClient().removeReaction('p-1', '+1');
    expect(fetchCalls[0].method).toBe('DELETE');
    expect(fetchCalls[0].url).toContain('/posts/p-1/reactions/+1');
  });

  it('getPost returns null on error instead of throwing', async () => {
    fetchResponder = () => errorResponse(404, 'not found');
    const post = await makeClient().getPost('missing');
    expect(post).toBeNull();
  });

  it('unpinPost swallows 403/404 silently', async () => {
    fetchResponder = () => errorResponse(404, 'not found');
    await expect(makeClient().unpinPost('p-1')).resolves.toBeUndefined();
  });

  it('unpinPost still throws on 500', async () => {
    fetchResponder = () => errorResponse(500, 'boom');
    // 500 triggers retry-then-fail — accept either rethrow or eventual error.
    await expect(makeClient().unpinPost('p-1')).rejects.toThrow();
  }, 10_000);

  it('pinPost POSTs to /posts/:id/pin', async () => {
    fetchResponder = () => jsonResponse({});
    await makeClient().pinPost('p-1');
    expect(fetchCalls[0].method).toBe('POST');
    expect(fetchCalls[0].url).toContain('/posts/p-1/pin');
  });

  it('getPinnedPosts returns the order array', async () => {
    fetchResponder = () => jsonResponse({ order: ['p-1', 'p-2'], posts: {} });
    const ids = await makeClient().getPinnedPosts();
    expect(ids).toEqual(['p-1', 'p-2']);
  });

  it('getPinnedPosts returns empty array when order is missing', async () => {
    fetchResponder = () => jsonResponse({ posts: {} });
    expect(await makeClient().getPinnedPosts()).toEqual([]);
  });

  it('getThreadHistory sorts messages chronologically and filters bot posts', async () => {
    // Use a client and prime its bot user id via getBotUser.
    const c = makeClient();
    const responders: Record<string, Response> = {
      '/users/me': jsonResponse({ id: 'bot-id', username: 'claude', email: '', first_name: '' }),
      '/posts/thread-1/thread': jsonResponse({
        order: ['p-1', 'p-2', 'p-bot'],
        posts: {
          'p-1': { id: 'p-1', channel_id: 'c', user_id: 'u-alice', message: 'first', root_id: '', create_at: 300 },
          'p-2': { id: 'p-2', channel_id: 'c', user_id: 'u-alice', message: 'second', root_id: '', create_at: 100 },
          'p-bot': { id: 'p-bot', channel_id: 'c', user_id: 'bot-id', message: 'bot reply', root_id: '', create_at: 200 },
        },
      }),
      '/users/u-alice': jsonResponse({ id: 'u-alice', username: 'alice', email: '', first_name: 'Alice' }),
    };
    fetchResponder = (url) => {
      for (const [suffix, response] of Object.entries(responders)) {
        if (url.includes(suffix)) return response.clone();
      }
      return jsonResponse({});
    };

    await c.getBotUser();
    const history = await c.getThreadHistory('thread-1', { excludeBotMessages: true });
    expect(history.map(m => m.id)).toEqual(['p-2', 'p-1']);
    expect(history.every(m => m.username === 'alice')).toBe(true);
  });

  it('getThreadHistory respects limit (returns most recent N)', async () => {
    const c = makeClient();
    fetchResponder = (url) => {
      if (url.includes('/users/me')) return jsonResponse({ id: 'b', username: 'c', email: '', first_name: '' });
      if (url.includes('/posts/t/thread')) {
        return jsonResponse({
          order: ['a', 'b', 'c'],
          posts: {
            a: { id: 'a', channel_id: '', user_id: 'u', message: '1', root_id: '', create_at: 1 },
            b: { id: 'b', channel_id: '', user_id: 'u', message: '2', root_id: '', create_at: 2 },
            c: { id: 'c', channel_id: '', user_id: 'u', message: '3', root_id: '', create_at: 3 },
          },
        });
      }
      if (url.includes('/users/u')) return jsonResponse({ id: 'u', username: 'u', email: '', first_name: '' });
      return jsonResponse({});
    };
    await c.getBotUser();
    const limited = await c.getThreadHistory('t', { limit: 2 });
    expect(limited.map(m => m.id)).toEqual(['b', 'c']);
  });

  it('getThreadHistory returns [] on API error', async () => {
    fetchResponder = () => errorResponse(500);
    const c = makeClient();
    const history = await c.getThreadHistory('t');
    expect(history).toEqual([]);
  }, 10_000);

  it('getUser caches by user id', async () => {
    const c = makeClient();
    let calls = 0;
    fetchResponder = (url) => {
      if (url.includes('/users/u-1')) {
        calls += 1;
        return jsonResponse({ id: 'u-1', username: 'alice', email: '', first_name: '' });
      }
      return jsonResponse({});
    };
    const first = await c.getUser('u-1');
    const second = await c.getUser('u-1');
    expect(first?.username).toBe('alice');
    expect(second?.username).toBe('alice');
    expect(calls).toBe(1);
  });

  it('getUser returns null on 404', async () => {
    const c = makeClient();
    fetchResponder = () => errorResponse(404);
    expect(await c.getUser('u-missing')).toBeNull();
  }, 10_000);

  it('downloadFile returns a Buffer', async () => {
    fetchResponder = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    const buf = await makeClient().downloadFile('f-1');
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(3);
  });

  it('downloadFile throws on non-200', async () => {
    fetchResponder = () => errorResponse(403, 'forbidden');
    await expect(makeClient().downloadFile('f-1')).rejects.toThrow(/403/);
  });

  it('api retries on 500 with backoff', async () => {
    let attempts = 0;
    fetchResponder = (_url, _init) => {
      attempts += 1;
      if (attempts < 3) return errorResponse(500, 'transient');
      return jsonResponse({
        id: 'p', channel_id: 'c', user_id: 'u', message: 'ok', root_id: '', create_at: 1,
      });
    };
    const post = await makeClient().createPost('hi');
    expect(post.message).toBe('ok');
    expect(attempts).toBe(3);
  }, 10_000);
});

describe('heartbeat probe', () => {
  it('probes a quiet socket with ping instead of declaring it dead', async () => {
    const client = makeClient();
    const sent: string[] = [];
    const c = client as unknown as {
      ws: unknown; HEARTBEAT_INTERVAL_MS: number; HEARTBEAT_TIMEOUT_MS: number;
      startHeartbeat(): void; stopHeartbeat(): void; scheduleReconnect(): void; updateLastMessageTime(): void;
    };
    // Real timers: the timeout check runs before the probe, so an event-loop
    // stall longer than TIMEOUT between two ticks would reconnect and fail
    // the test. 25/250/500 keeps ten times the slack of a loaded CI runner
    // while the timeout can still trip inside the wait.
    Object.defineProperty(c, 'HEARTBEAT_INTERVAL_MS', { value: 25 });
    Object.defineProperty(c, 'HEARTBEAT_TIMEOUT_MS', { value: 250 });
    let reconnects = 0;
    c.scheduleReconnect = () => { reconnects++; };
    c.ws = { readyState: 1, send: (data: string) => { sent.push(data); c.updateLastMessageTime(); } };
    c.startHeartbeat();
    await new Promise((r) => setTimeout(r, 500));
    c.stopHeartbeat();
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.parse(sent[0])).toMatchObject({ action: 'ping' });
    expect(reconnects).toBe(0);
  });
});
