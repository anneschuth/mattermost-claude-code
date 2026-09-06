/**
 * Slack client unit tests
 *
 * Tests for Slack-specific functionality, including emoji handling and the
 * SlackClient HTTP surface (fetch-backed).
 */

import { installFetchHarness, jsonResponse, type FetchResponder } from '../test-helpers/fetch-harness.js';
import { describe, it, expect } from 'bun:test';
import { getEmojiName } from '../utils.js';
import { SlackClient } from './client.js';
import type { SlackPlatformConfig } from '../../config/types.js';
import { setLogHandler } from '../../utils/logger.js';

describe('Slack Client Emoji Handling', () => {
  describe('getEmojiName conversion for reactions', () => {
    it('converts Unicode thumbs up to +1', () => {
      expect(getEmojiName('👍')).toBe('+1');
    });

    it('converts Unicode thumbs down to -1', () => {
      expect(getEmojiName('👎')).toBe('-1');
    });

    it('converts Unicode checkmark to white_check_mark', () => {
      expect(getEmojiName('✅')).toBe('white_check_mark');
    });

    it('converts Unicode X to x', () => {
      expect(getEmojiName('❌')).toBe('x');
    });

    it('passes through already-valid emoji names', () => {
      expect(getEmojiName('+1')).toBe('+1');
      expect(getEmojiName('-1')).toBe('-1');
      expect(getEmojiName('white_check_mark')).toBe('white_check_mark');
      expect(getEmojiName('thumbsup')).toBe('thumbsup');
    });

    it('passes through unknown emoji unchanged', () => {
      expect(getEmojiName('custom_emoji')).toBe('custom_emoji');
      expect(getEmojiName('🦄')).toBe('🦄');
    });
  });

  describe('reaction emoji used in update prompts', () => {
    const updatePromptEmoji = ['👍', '👎'];
    it('converts all update prompt emoji to valid Slack names', () => {
      const converted = updatePromptEmoji.map(getEmojiName);
      expect(converted).toEqual(['+1', '-1']);
    });
  });

  describe('reaction emoji used in permission prompts', () => {
    const permissionPromptEmoji = ['👍', '✅', '👎'];
    it('converts all permission prompt emoji to valid Slack names', () => {
      const converted = permissionPromptEmoji.map(getEmojiName);
      expect(converted).toEqual(['+1', 'white_check_mark', '-1']);
    });
  });

  describe('reaction emoji used in message approval', () => {
    const messageApprovalEmoji = ['👍', '✅', '👎'];
    it('converts all message approval emoji to valid Slack names', () => {
      const converted = messageApprovalEmoji.map(getEmojiName);
      expect(converted).toEqual(['+1', 'white_check_mark', '-1']);
    });
  });
});

// -----------------------------------------------------------------------------
// SlackClient tests — fetch is stubbed; Socket Mode paths are exercised via
// pure helpers that don't need a WebSocket.
// -----------------------------------------------------------------------------

let fetchResponder: FetchResponder = () => jsonResponse({ ok: true });
const harness = installFetchHarness(() => fetchResponder);
const fetchCalls = harness.calls;

function ok(body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function notOk(error: string, status = 200): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function httpError(status: number, text = 'server error'): Response {
  return new Response(text, { status });
}

function makeConfig(overrides: Partial<SlackPlatformConfig> = {}): SlackPlatformConfig {
  return {
    id: 'slack-main',
    type: 'slack',
    displayName: 'Slack Main',
    botToken: 'xoxb-bot-token',
    appToken: 'xapp-app-token',
    channelId: 'C123',
    botName: 'claude',
    allowedUsers: ['alice', 'bob'],
    skipPermissions: false,
    apiUrl: 'https://mock.slack.test/api',
    ...overrides,
  };
}

function makeClient(overrides: Partial<SlackPlatformConfig> = {}): SlackClient {
  return new SlackClient(makeConfig(overrides));
}

async function primeBotUser(client: SlackClient, userId = 'U-BOT') {
  fetchResponder = (url) => {
    if (url.endsWith('auth.test')) return ok({ user_id: userId, team_id: 'T-OURS', url: 'https://team.slack.com/' });
    if (url.includes('users.info')) {
      return ok({ user: { id: userId, name: 'claude', real_name: 'Claude', profile: {} } });
    }
    return ok();
  };
  await client.getBotUser();
  fetchCalls.length = 0;
}

describe('SlackClient pure helpers', () => {
  it('getMessageLimits returns Slack-specific stricter limits', () => {
    expect(makeClient().getMessageLimits()).toEqual({ maxLength: 12000, hardThreshold: 10000 });
  });

  it('isBotMentioned detects <@USERID> mentions when bot user id is known', async () => {
    const c = makeClient();
    await primeBotUser(c, 'U-BOT');
    expect(c.isBotMentioned('<@U-BOT> hello')).toBe(true);
    expect(c.isBotMentioned('<@U-OTHER> hi')).toBe(false);
  });

  it('isBotMentioned detects @botname (case-insensitive)', () => {
    const c = makeClient({ botName: 'claude' });
    expect(c.isBotMentioned('@claude help')).toBe(true);
    expect(c.isBotMentioned('@CLAUDE help')).toBe(true);
    expect(c.isBotMentioned('claude help')).toBe(false);
  });

  it('extractPrompt strips <@USERID> mentions when bot user id is known', async () => {
    const c = makeClient();
    await primeBotUser(c, 'U-BOT');
    expect(c.extractPrompt('<@U-BOT> do something')).toBe('do something');
    expect(c.extractPrompt('hey <@U-BOT>, fix this')).toBe('hey , fix this');
  });

  it('extractPrompt strips @botname mentions', () => {
    const c = makeClient({ botName: 'claude' });
    expect(c.extractPrompt('@claude write code')).toBe('write code');
  });

  it('sendTyping is a no-op and does not throw', () => {
    expect(() => makeClient().sendTyping()).not.toThrow();
  });

  it('platform identity fields reflect config', () => {
    const c = makeClient({ id: 'slack-x', displayName: 'X' });
    expect(c.platformId).toBe('slack-x');
    expect(c.displayName).toBe('X');
    expect(c.platformType).toBe('slack');
  });

  it('getFormatter returns a stable formatter instance', () => {
    const c = makeClient();
    expect(c.getFormatter()).toBe(c.getFormatter());
  });

  it('getPostPermalink links to the specific post via its ts (not the thread root)', () => {
    const c = makeClient();
    // teamUrl is resolved at connect time; set it + channelId for the test.
    (c as any).teamUrl = 'https://x.slack.com';
    (c as any).channelId = 'C1';
    const post = { id: '1767690059.430179', platformId: 'slack', channelId: 'C1', userId: 'u1', message: 'hi', rootId: '1767690000.000100' } as any;
    const link = c.getPostPermalink(post);
    // Points at the reply's own ts, and carries the thread_ts of the root.
    expect(link).toContain('/archives/C1/p1767690059430179');
    expect(link).toContain('thread_ts=1767690000.000100');
  });
});

describe('SlackClient API methods', () => {
  it('createPost calls chat.postMessage with channel + thread + unfurl flags', async () => {
    fetchResponder = () =>
      ok({ ts: '1000.0001', channel: 'C123', message: { text: 'hi' } });
    const post = await makeClient().createPost('hi', '999.0001');
    expect(post.id).toBe('1000.0001');
    expect(post.channelId).toBe('C123');
    expect(post.rootId).toBe('999.0001');

    const call = fetchCalls[0];
    expect(call.url).toBe('https://mock.slack.test/api/chat.postMessage');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer xoxb-bot-token');
    const body = call.body as Record<string, unknown>;
    expect(body.channel).toBe('C123');
    expect(body.thread_ts).toBe('999.0001');
    expect(body.unfurl_links).toBe(true);
  });

  it('createPost disables unfurling for channel-level posts by default', async () => {
    fetchResponder = () => ok({ ts: '1.1', channel: 'C123', message: { text: 'ping' } });
    await makeClient().createPost('ping');
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.unfurl_links).toBe(false);
    expect(body.thread_ts).toBeUndefined();
  });

  it('createPost allows explicit unfurl=true for channel-level posts', async () => {
    fetchResponder = () => ok({ ts: '1.1', channel: 'C123', message: { text: 'ping' } });
    await makeClient().createPost('ping', undefined, { unfurl: true });
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.unfurl_links).toBe(true);
  });

  it('createPost truncates oversized messages before sending', async () => {
    fetchResponder = () => ok({ ts: '1.1', channel: 'C123', message: { text: 'truncated' } });
    const bigMessage = 'x'.repeat(20_000);
    await makeClient().createPost(bigMessage);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect((body.text as string).length).toBeLessThanOrEqual(12_200);
    expect(body.text).toContain('(truncated)');
  });

  it('updatePost calls chat.update', async () => {
    fetchResponder = () =>
      ok({ ts: '100.1', channel: 'C123', text: 'updated' });
    const post = await makeClient().updatePost('100.1', 'updated');
    expect(post.message).toBe('updated');
    expect(fetchCalls[0].url).toContain('chat.update');
  });

  it('addReaction posts to reactions.add', async () => {
    fetchResponder = () => ok();
    await makeClient().addReaction('100.1', '+1');
    expect(fetchCalls[0].url).toContain('reactions.add');
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.name).toBe('+1');
    expect(body.timestamp).toBe('100.1');
  });

  it('removeReaction posts to reactions.remove', async () => {
    fetchResponder = () => ok();
    await makeClient().removeReaction('100.1', '+1');
    expect(fetchCalls[0].url).toContain('reactions.remove');
  });

  it('pinPost swallows already_pinned errors', async () => {
    fetchResponder = () => notOk('already_pinned');
    await expect(makeClient().pinPost('100.1')).resolves.toBeUndefined();
  });

  it('unpinPost swallows no_pin errors', async () => {
    fetchResponder = () => notOk('no_pin');
    await expect(makeClient().unpinPost('100.1')).resolves.toBeUndefined();
  });

  it('pinPost rethrows unexpected errors', async () => {
    fetchResponder = () => notOk('something_else');
    await expect(makeClient().pinPost('100.1')).rejects.toThrow(/something_else/);
  });

  it('getPost returns null on API error', async () => {
    fetchResponder = () => notOk('channel_not_found');
    const post = await makeClient().getPost('100.1');
    expect(post).toBeNull();
  });

  it('getPinnedPosts returns timestamps from items', async () => {
    fetchResponder = () => ok({
      items: [
        { message: { ts: '1.1' } },
        { message: { ts: '2.2' } },
        { /* no message */ },
      ],
    });
    const ids = await makeClient().getPinnedPosts();
    expect(ids).toEqual(['1.1', '2.2']);
  });

  it('getThreadHistory sorts chronologically and filters bot messages', async () => {
    const c = makeClient();
    await primeBotUser(c, 'U-BOT');
    fetchResponder = (url) => {
      if (url.includes('conversations.replies')) {
        return ok({
          messages: [
            { ts: '300.0', user: 'U-ALICE', text: 'first' },
            { ts: '100.0', user: 'U-ALICE', text: 'second' },
            { ts: '200.0', user: 'U-BOT', text: 'bot reply' },
          ],
        });
      }
      if (url.includes('users.info')) {
        return ok({ user: { id: 'U-ALICE', name: 'alice', real_name: 'Alice', profile: {} } });
      }
      return ok();
    };
    const history = await c.getThreadHistory('thread-1', { excludeBotMessages: true });
    expect(history).toHaveLength(2);
    expect(history.every(m => m.username === 'alice')).toBe(true);
  });

  it('getThreadHistory limit selects the most RECENT N messages (not the oldest)', async () => {
    // Regression-defender: conversations.replies paginates oldest-first, so
    // forwarding the caller's limit to the API returned the oldest N of a
    // long thread. Callers (context prompt, work summary, distillation) want
    // the newest N — the client must fetch a full page and slice from the end.
    const c = makeClient();
    fetchResponder = (url) => {
      if (url.includes('conversations.replies')) {
        // The request must not narrow the fetch to the caller's limit.
        expect(url).not.toContain('limit=2');
        return ok({
          messages: [
            { ts: '100.0', user: 'U-ALICE', text: 'oldest' },
            { ts: '200.0', user: 'U-ALICE', text: 'middle' },
            { ts: '300.0', user: 'U-ALICE', text: 'newest' },
          ],
        });
      }
      if (url.includes('users.info')) {
        return ok({ user: { id: 'U-ALICE', name: 'alice', real_name: 'Alice', profile: {} } });
      }
      return ok();
    };
    const history = await c.getThreadHistory('thread-1', { limit: 2 });
    expect(history.map(m => m.message)).toEqual(['middle', 'newest']);
  });

  it('getThreadHistory follows cursor pagination past the first page', async () => {
    // A thread longer than one conversations.replies page (1000 messages)
    // returns its OLDEST page first; without walking next_cursor the
    // "most recent N" slice would come from that oldest page and serve
    // long-ago content as recent context.
    const c = makeClient();
    fetchResponder = (url) => {
      if (url.includes('conversations.replies')) {
        if (!url.includes('cursor=')) {
          return ok({
            messages: [
              { ts: '100.0', user: 'U-ALICE', text: 'old-1' },
              { ts: '200.0', user: 'U-ALICE', text: 'old-2' },
            ],
            response_metadata: { next_cursor: 'page2' },
          });
        }
        expect(url).toContain('cursor=page2');
        return ok({
          messages: [
            { ts: '300.0', user: 'U-ALICE', text: 'new-1' },
            { ts: '400.0', user: 'U-ALICE', text: 'new-2' },
          ],
        });
      }
      if (url.includes('users.info')) {
        return ok({ user: { id: 'U-ALICE', name: 'alice', real_name: 'Alice', profile: {} } });
      }
      return ok();
    };
    const history = await c.getThreadHistory('thread-1', { limit: 2 });
    expect(history.map(m => m.message)).toEqual(['new-1', 'new-2']);
  });

  it('getThreadHistory without a limit fetches a single page (no unbounded walk)', async () => {
    // With no limit there is no sliding window to keep bounded: walking
    // every cursor would accumulate the whole thread in memory and issue a
    // getUser call per message. The no-limit caller (getThreadContextCount)
    // gets exactly one 1000-message page — the pre-walk behavior.
    const c = makeClient();
    let pages = 0;
    fetchResponder = (url) => {
      if (url.includes('conversations.replies')) {
        pages++;
        return ok({
          messages: [{ ts: `${pages * 100}.0`, user: 'U-ALICE', text: `page-${pages}` }],
          // Always offers another page; the client must not take it.
          response_metadata: { next_cursor: `page${pages + 1}` },
        });
      }
      if (url.includes('users.info')) {
        return ok({ user: { id: 'U-ALICE', name: 'alice', real_name: 'Alice', profile: {} } });
      }
      return ok();
    };
    const history = await c.getThreadHistory('thread-1');
    expect(pages).toBe(1);
    expect(history.map(m => m.message)).toEqual(['page-1']);
  });

  it('getThreadHistory returns [] on API error', async () => {
    fetchResponder = () => notOk('channel_not_found');
    const history = await makeClient().getThreadHistory('thread-1');
    expect(history).toEqual([]);
  });

  it('getUser caches by user id', async () => {
    const c = makeClient();
    let calls = 0;
    fetchResponder = (url) => {
      if (url.includes('users.info?user=U-1')) {
        calls += 1;
        return ok({ user: { id: 'U-1', name: 'alice', real_name: 'Alice', profile: {} } });
      }
      return ok();
    };
    const first = await c.getUser('U-1');
    const second = await c.getUser('U-1');
    expect(first?.username).toBe('alice');
    expect(second?.username).toBe('alice');
    expect(calls).toBe(1);
  });

  it('getUser returns null when userId is empty', async () => {
    expect(await makeClient().getUser('')).toBeNull();
  });

  it('getUser returns null on API error', async () => {
    fetchResponder = () => notOk('user_not_found');
    expect(await makeClient().getUser('U-missing')).toBeNull();
  });

  it('api() throws on HTTP non-2xx', async () => {
    fetchResponder = () => httpError(500, 'server error');
    await expect(makeClient().getPinnedPosts()).rejects.toThrow(/500/);
  });

  it('downloadFile fetches the private URL with bot token', async () => {
    let second = false;
    fetchResponder = (_url) => {
      if (!second) {
        second = true;
        return ok({
          file: {
            url_private: 'https://files.test/abc',
            id: 'F1', name: 'x', size: 3, mimetype: 'text/plain',
          },
        });
      }
      return new Response(new Uint8Array([7, 8, 9]), { status: 200 });
    };
    const buf = await makeClient().downloadFile('F1');
    expect(buf.length).toBe(3);
  });

  it('downloadFile throws when no download URL is available', async () => {
    fetchResponder = () => ok({ file: { id: 'F1', name: 'x', size: 0, mimetype: '' } });
    await expect(makeClient().downloadFile('F1')).rejects.toThrow(/No download URL/);
  });
});

describe('SlackClient working status degrades silently (#525 review)', () => {
  /**
   * `assistant.threads.setStatus` is documented as AI-assistant-threads-only
   * and works in ordinary channels today. If Slack ever tightens that, or a
   * workspace lacks the method, `api()` would warn-log every unexpected
   * `ok:false` — once per 20s heartbeat per active session, forever. The
   * expectedErrors list is what makes the documented failure silent, which is
   * what the fire-and-forget shape promises.
   */
  const withWarnSpy = async (fn: () => Promise<void> | void): Promise<string[]> => {
    const warnings: string[] = [];
    setLogHandler((level, _component, message) => {
      if (level === 'warn') warnings.push(message);
    });
    try {
      await fn();
      // Let the fire-and-forget .catch() settle before restoring.
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      setLogHandler(null);
    }
    return warnings;
  };

  it.each([
    'method_not_supported_for_channel_type',
    'missing_scope',
    'invalid_thread_ts',
    'channel_not_found',
  ])('does not warn when setStatus is unavailable: %s', async (code) => {
    fetchResponder = () => notOk(code);
    const client = makeClient();

    const warnings = await withWarnSpy(() => {
      client.sendTyping('1700000000.000100');
    });

    expect(warnings).toEqual([]);
  });

  it('still warns on a genuinely unexpected setStatus error', async () => {
    fetchResponder = () => notOk('internal_error');
    const client = makeClient();

    const warnings = await withWarnSpy(() => {
      client.sendTyping('1700000000.000200');
    });

    expect(warnings.join('\n')).toContain('assistant.threads.setStatus');
  });
});

describe('SlackClient bot-authored filter', () => {
  // Slack stamps every API-posted message with the app's bot_id/app_id, even
  // when it is posted with a person's user token. Only the person's own
  // messages and posts made through this app's user token should reach Claude.
  const OUR_APP = 'A-OURS';
  const OUR_TEAM = 'T-OURS';

  function hello(client: SlackClient, appId = OUR_APP) {
    (client as any).handleSocketModeEvent({ type: 'hello', connection_info: { app_id: appId } });
  }

  function collectMessages(client: SlackClient): Array<{ userId: string }> {
    const seen: Array<{ userId: string }> = [];
    client.on('message', (post) => seen.push({ userId: post.userId }));
    return seen;
  }

  async function inject(client: SlackClient, event: Record<string, unknown>) {
    client._injectSlackEvent({ type: 'message', channel: 'C123', ts: '1.1', text: 'hi', team: OUR_TEAM, ...event } as any);
    await new Promise((r) => setTimeout(r, 0));
  }

  it('a post made through this app\'s own user token is the person\'s message', async () => {
    const client = makeClient();
    await primeBotUser(client);
    hello(client);
    const seen = collectMessages(client);

    await inject(client, { user: 'U-ALMIR', bot_id: 'B-PER-AUTH', app_id: OUR_APP });

    expect(seen).toEqual([{ userId: 'U-ALMIR' }]);
  });

  it('the app id is also learned from an events_api envelope, for a socket that missed hello', async () => {
    const client = makeClient();
    await primeBotUser(client);
    const seen = collectMessages(client);

    (client as any).handleSocketModeEvent({
      type: 'events_api',
      envelope_id: 'e1',
      payload: { api_app_id: OUR_APP, event: { type: 'message', channel: 'C123', ts: '1.2', text: 'hi', user: 'U-ALMIR', bot_id: 'B-PER-AUTH', app_id: OUR_APP, team: OUR_TEAM } },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual([{ userId: 'U-ALMIR' }]);
  });

  it('the bot\'s own replies stay ignored', async () => {
    const client = makeClient();
    await primeBotUser(client, 'U-BOT');
    hello(client);
    const seen = collectMessages(client);

    await inject(client, { user: 'U-BOT', bot_id: 'B-OURS', app_id: OUR_APP });

    expect(seen).toEqual([]);
  });

  it('another app\'s bot posts stay ignored', async () => {
    const client = makeClient();
    await primeBotUser(client);
    hello(client);
    const seen = collectMessages(client);

    await inject(client, { user: 'U-GITHUB-BOT', bot_id: 'B-GITHUB', app_id: 'A-GITHUB' });

    expect(seen).toEqual([]);
  });

  it('a bot copy of this same app in another workspace (Slack Connect) stays ignored', async () => {
    const client = makeClient();
    await primeBotUser(client);
    hello(client);
    const seen = collectMessages(client);

    await inject(client, { user: 'U-BOT-REMOTE', bot_id: 'B-REMOTE', app_id: OUR_APP, team: 'T-REMOTE' });

    expect(seen).toEqual([]);
  });

  it('a bot post without a user stays ignored, and so does everything with a bot_id before the app id is known', async () => {
    const client = makeClient();
    await primeBotUser(client);
    const seen = collectMessages(client);

    await inject(client, { bot_id: 'B-CLASSIC', app_id: OUR_APP });
    await inject(client, { user: 'U-ALMIR', bot_id: 'B-PER-AUTH', app_id: OUR_APP, ts: '1.3' });

    expect(seen).toEqual([]);
  });

  it('missed-message recovery applies the same rule', async () => {
    const client = makeClient();
    await primeBotUser(client);
    hello(client);
    const seen = collectMessages(client);
    (client as any).lastProcessedTs = '1.0';
    fetchResponder = (url) => {
      if (url.includes('conversations.history')) {
        return ok({
          messages: [
            { type: 'message', ts: '1.1', text: 'relayed', user: 'U-ALMIR', bot_id: 'B-PER-AUTH', app_id: OUR_APP, team: OUR_TEAM },
            { type: 'message', ts: '1.2', text: 'reply', user: 'U-BOT', bot_id: 'B-OURS', app_id: OUR_APP, team: OUR_TEAM },
            { type: 'message', ts: '1.3', text: 'ci', user: 'U-GITHUB-BOT', bot_id: 'B-GITHUB', app_id: 'A-GITHUB', team: OUR_TEAM },
            { type: 'message', ts: '1.4', text: 'remote copy', user: 'U-BOT-REMOTE', bot_id: 'B-REMOTE', app_id: OUR_APP, team: 'T-REMOTE' },
          ],
        });
      }
      return ok({ user: { id: 'U-ALMIR', name: 'almir', real_name: 'Almir', profile: {} } });
    };

    await (client as any).recoverMissedMessages();

    expect(seen).toEqual([{ userId: 'U-ALMIR' }]);
  });
});

describe('SlackClient post metadata (turn marker)', () => {
  it('createPost and updatePost carry metadata only when given', async () => {
    fetchResponder = () => ok({ ts: '1.1', channel: 'C123', message: { text: 'x' }, text: 'x' });
    const client = makeClient();
    const meta = { event_type: 'claude_threads_turn_complete', event_payload: { session: 's', turn: 1, ok: true } };

    await client.updatePost('1.1', 'final text', { metadata: meta });
    await client.updatePost('1.1', 'plain');
    await client.createPost('new', undefined, { metadata: meta });

    const bodies = fetchCalls.map((c) => c.body as Record<string, unknown>);
    expect(bodies[0].metadata).toEqual(meta);
    expect(bodies[1].metadata).toBeUndefined();
    expect(bodies[2].metadata).toEqual(meta);
  });
});
