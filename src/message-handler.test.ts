/**
 * Tests for message-handler.ts - Core message handling logic
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { configureAuditLog, _resetAuditLog } from './persistence/audit-log.js';
import { handleMessage, isClaudeThreadsStatusPost, type MessageHandlerOptions } from './message-handler.js';
import type { PlatformClient, PlatformPost, PlatformUser } from './platform/index.js';
import type { SessionManager } from './session/index.js';
import { createMockFormatter } from './test-utils/mock-formatter.js';
import { resetResumeRefusalLimiter } from './session/refusal-limiter.js';

// The refusal limiter is module-global state; every test starts unthrottled.
beforeEach(() => resetResumeRefusalLimiter());

// Create mock platform client
function createMockPlatform(botName = 'claude-bot', platformType = 'slack') {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  return {
    platformId: 'test-platform',
    platformType,
    createPost: mock(async (message: string, threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: threadId || '',
        createAt: Date.now(),
      };
    }),
    isBotMentioned: mock((message: string) => message.includes(`@${botName}`)),
    extractPrompt: mock((message: string) => message.replace(new RegExp(`@${botName}\\s*`, 'gi'), '').trim()),
    isUserAllowed: mock((username: string) => username === 'allowed-user' || username === 'admin'),
    getBotName: mock(() => botName),
    getPostPermalink: mock((post: PlatformPost) => `https://mm.test/pl/${post.id}`),
    getFormatter: () => createMockFormatter(),
    addReaction: mock(() => Promise.resolve()),
    disconnect: mock(() => {}),
    posts,
  } as unknown as PlatformClient & { posts: Map<string, string> };
}

// Create mock session manager
function createMockSessionManager() {
  const mockGetActiveThreadIds = mock(() => [] as string[]);
  const mockGetBugReportsEnabled = mock(() => true);
  // Registry mocks - default to not finding sessions
  const mockFindByThreadId = mock(() => undefined);
  const mockGetPersistedByThreadId = mock(() => undefined);
  return {
    // Note: isInSessionThread and hasPausedSession removed - code uses registry directly
    isUserAllowedInSession: mock(() => true),
    addSideConversation: mock(() => {}),
    getActiveThreadIds: mockGetActiveThreadIds,
    getBugReportsEnabled: mockGetBugReportsEnabled,
    registry: {
      getActiveThreadIds: mockGetActiveThreadIds,
      findByThreadId: mockFindByThreadId,
      getPersistedByThreadId: mockGetPersistedByThreadId,
    },
    getPersistedSession: mock(() => undefined),
    killAllSessions: mock(async () => {}),
    transcribeForWatch: mock(async () => ''),
    cancelSession: mock(async () => {}),
    interruptSession: mock(async () => {}),
    inviteUser: mock(async () => {}),
    kickUser: mock(async () => {}),
    setRespondOnlyWhenMentioned: mock(async () => {}),
    enableInteractivePermissions: mock(async () => {}),
    setSessionPermissionMode: mock(async () => {}),
    changeDirectory: mock(async () => {}),
    listWorktreesCommand: mock(async () => {}),
    switchToWorktree: mock(async () => {}),
    removeWorktreeCommand: mock(async () => {}),
    disableWorktreePrompt: mock(async () => {}),
    cleanupWorktreeCommand: mock(async () => {}),
    createAndSwitchToWorktree: mock(async () => {}),
    hasPendingWorktreePrompt: mock(() => false),
    handleWorktreeBranchResponse: mock(async () => false),
    sendFollowUp: mock(async () => {}),
    evaluateWatches: mock(() => {}),
    resumePausedSession: mock(async () => {}),
    cancelPausedSession: mock(() => {}),
    startSession: mock(async () => {}),
    startSessionWithWorktree: mock(async () => {}),
    requestMessageApproval: mock(async () => {}),
    showUpdateStatusWithoutSession: mock(async () => {}),
    listWorktreesWithoutSession: mock(async () => {}),
    switchToWorktreeWithoutSession: mock(async () => {}),
  } as unknown as SessionManager;
}

describe('handleMessage', () => {
  let client: PlatformClient & { posts: Map<string, string> };
  let session: ReturnType<typeof createMockSessionManager>;
  let options: MessageHandlerOptions;

  beforeEach(() => {
    client = createMockPlatform();
    session = createMockSessionManager();
    options = {
      platformId: 'test-platform',
      logger: {
        error: mock(() => {}),
        debug: mock(() => {}),
      },
    };
  });

  describe('!kill command', () => {
    test('executes kill for authorized user', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kill',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'admin', displayName: 'Admin' };

      await handleMessage(client, session, post, user, options);

      expect(session.killAllSessions).toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
      expect(onKill).toHaveBeenCalledWith('admin');
    });

    test('rejects kill for unauthorized user', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kill',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'random-user', displayName: 'Random' };

      await handleMessage(client, session, post, user, options);

      expect(session.killAllSessions).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });

    test('handles @mention !kill', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !kill',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'admin', displayName: 'Admin' };

      await handleMessage(client, session, post, user, options);

      expect(session.killAllSessions).toHaveBeenCalled();
    });
  });

  describe('active session thread', () => {
    beforeEach(() => {
      // Configure registry to return a session object (active session exists)
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
    });

    test('handles !stop command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!stop',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.cancelSession).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !cancel command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!cancel',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.cancelSession).toHaveBeenCalled();
    });

    test('handles !escape command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!escape',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.interruptSession).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !help command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!help',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Commands');
    });

    test('handles !invite command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!invite @newuser',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.inviteUser).toHaveBeenCalledWith('thread1', 'newuser', 'allowed-user');
    });

    test('handles !kick command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kick @someuser',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.kickUser).toHaveBeenCalledWith('thread1', 'someuser', 'allowed-user');
    });

    test('handles !permissions interactive', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!permissions interactive',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      // 'interactive' is the legacy alias for 'default'; the command now
      // dispatches through setSessionPermissionMode with the canonical name.
      expect(session.setSessionPermissionMode).toHaveBeenCalledWith('thread1', 'allowed-user', 'default');
    });

    test('handles !cd command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!cd /new/path',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.changeDirectory).toHaveBeenCalledWith('thread1', '/new/path', 'allowed-user');
    });

    test('handles !worktree list', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree list',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.listWorktreesCommand).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !worktree switch <branch>', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree switch feature-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.switchToWorktree).toHaveBeenCalledWith('thread1', 'feature-branch', 'allowed-user');
    });

    test('ignores side conversations', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@someone-else hello!',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).not.toHaveBeenCalled();
      expect(session.addSideConversation).toHaveBeenCalledWith('thread1', expect.objectContaining({
        fromUser: 'allowed-user',
        mentionedUser: 'someone-else',
      }));
    });

    test('ignores side conversations in Slack raw mention form (<@U…>)', async () => {
      // Slack delivers mentions as '<@U0BOB>', never '@bob' — a guard
      // matching only '@name' is a silent no-op on Slack.
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '<@U0BOB> did you deploy?',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).not.toHaveBeenCalled();
      expect(session.addSideConversation).toHaveBeenCalledWith('thread1', expect.objectContaining({
        mentionedUser: 'U0BOB',
      }));
    });

    test('a message that ALSO mentions the bot is a follow-up, not a side conversation', async () => {
      // '@bob can you review? @claude-bot please summarize' explicitly asks
      // the bot — dropping it as a human-to-human aside loses a real request
      // (the DCM new-session guard already exempts bot mentions).
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@bob can you review? @claude-bot please summarize the diff',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.addSideConversation).not.toHaveBeenCalled();
      expect(session.sendFollowUp).toHaveBeenCalled();
    });

    test('a literal <@…> token on Mattermost is ordinary text, not an address', async () => {
      // Mattermost never produces raw mention tokens — someone pasting
      // Slack output must not have their follow-up silently dropped.
      client = createMockPlatform('claude-bot', 'mattermost');
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '<@U0BOB> is what the Slack log said — can you check it?',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.addSideConversation).not.toHaveBeenCalled();
      expect(session.sendFollowUp).toHaveBeenCalled();
    });

    test("Slack's legacy labeled mention form <@U0…|name> is recognized too", async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '<@U0BOB|bob> did you deploy?',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).not.toHaveBeenCalled();
      expect(session.addSideConversation).toHaveBeenCalledWith('thread1', expect.objectContaining({
        mentionedUser: 'U0BOB',
      }));
    });

    test('a raw-form mention of the BOT is a follow-up, not a side conversation', async () => {
      (client.isBotMentioned as any).mockImplementation((m: string) => m.includes('<@UBOT123>'));
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '<@UBOT123> what is the status?',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.addSideConversation).not.toHaveBeenCalled();
      expect(session.sendFollowUp).toHaveBeenCalled();
    });

    test('sends follow-up for regular messages', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'please help me with this code',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith(
        'thread1', 'please help me with this code', undefined, 'allowed-user', 'User',
      );
    });

    test('requests approval for unauthorized user', async () => {
      (session.isUserAllowedInSession as any).mockReturnValue(false);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'can I help?',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect(session.requestMessageApproval).toHaveBeenCalledWith('thread1', 'outsider', 'can I help?');
    });
  });

  describe('quiet mode (respondOnlyWhenMentioned, #402)', () => {
    test('handles !mentions on command', async () => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!mentions on',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.setRespondOnlyWhenMentioned).toHaveBeenCalledWith('thread1', 'allowed-user', 'on');
    });

    test('bare !mentions toggles (no arg)', async () => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!mentions',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.setRespondOnlyWhenMentioned).toHaveBeenCalledWith('thread1', 'allowed-user', undefined);
    });

    test('when quiet mode on, ignores a reply that does not @mention the bot', async () => {
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        respondOnlyWhenMentioned: true,
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'just chatting with a colleague here',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).not.toHaveBeenCalled();
    });

    test('when quiet mode on, responds to a reply that @mentions the bot', async () => {
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        respondOnlyWhenMentioned: true,
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot please continue',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', 'please continue', undefined, 'allowed-user', 'User');
    });

    test('when quiet mode off (default), responds to a non-mention reply', async () => {
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        respondOnlyWhenMentioned: false,
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'keep going please',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', 'keep going please', undefined, 'allowed-user', 'User');
    });

    test('when quiet mode on, a pending worktree-prompt reply is still handled (bypasses the gate)', async () => {
      // Regression for the config-default-on + worktree-prompt case: the bot
      // just asked for a branch name, so a plain reply (no @mention) must be
      // consumed even in quiet mode, not dropped by the gate.
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        respondOnlyWhenMentioned: true,
      });
      (session.hasPendingWorktreePrompt as any).mockReturnValue(true);
      (session.handleWorktreeBranchResponse as any).mockResolvedValue(true);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'feature/my-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.handleWorktreeBranchResponse).toHaveBeenCalledWith(
        'thread1',
        'feature/my-branch',
        'allowed-user',
        'post1'
      );
    });

    test('when quiet mode on, !mentions off command still works (commands bypass the gate)', async () => {
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        respondOnlyWhenMentioned: true,
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!mentions off',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.setRespondOnlyWhenMentioned).toHaveBeenCalledWith('thread1', 'allowed-user', 'off');
    });
  });

  describe('paused session', () => {
    beforeEach(() => {
      // Configure registry to return a persisted session (paused session exists)
      (session.registry.getPersistedByThreadId as any).mockReturnValue({ sessionAllowedUsers: ['allowed-user'] });
      (session.getPersistedSession as any).mockReturnValue({
        sessionAllowedUsers: ['allowed-user'],
      });
    });

    test('resumes session for authorized user', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'continue please',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).toHaveBeenCalledWith('thread1', 'continue please', undefined, 'allowed-user', 'test-platform');
    });

    test('a message addressing another user does not resume (Slack raw form)', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '<@U0BOB> can you take this one?',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
      // Silent skip: no rejection post either — it's a human-to-human aside.
      expect(client.createPost).not.toHaveBeenCalled();
    });

    test('rejects resume from an allowlisted non-participant under approvals: owner', async () => {
      // The platform allowlist alone must not resume an owner-scoped
      // session — parity with the reaction-based resume gate.
      (client as unknown as { approvals?: string }).approvals = 'owner';
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'continue please',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'admin', displayName: 'Admin' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });

    test('rejects resume for unauthorized user', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'continue',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });

    test('!stop cancels paused session instead of resuming it', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!stop',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
      expect(session.cancelPausedSession).toHaveBeenCalledWith('thread1', 'test-platform');
      // Should post a cancellation confirmation
      const postCalls = (client.createPost as any).mock.calls;
      const lastMessage = postCalls[postCalls.length - 1]?.[0];
      expect(lastMessage).toContain('Session cancelled');
    });

    test('!cancel also cancels paused session', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!cancel',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
      expect(session.cancelPausedSession).toHaveBeenCalledWith('thread1', 'test-platform');
    });

    test('a stopped thread starts a FRESH session, it does not resume', async () => {
      // The end-to-end shape of the bug, from the operator's side. After
      // `!stop` the record is a 'stopped' tombstone, which the paused-session
      // gate now hides — so the next message must reach the new-session path.
      //
      // Getting this wrong in either direction is bad: leave the record
      // visible and the thread is trapped (the original bug); revive it and
      // `!stop` silently undoes itself, resurrecting a conversation that has
      // already been distilled into channel memory as ended.
      (session.registry.getPersistedByThreadId as any).mockReturnValue(undefined);
      (session.getPersistedSession as any).mockReturnValue(undefined);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot pick this back up',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
      expect(session.startSession).toHaveBeenCalled();
    });

    test('a bare !stop on a stopped thread is a no-op, not a new prompt', async () => {
      // Once stopped tombstones route to the new-session path, `!stop` reaches
      // it too. It is not `worksInFirstMessage`, so without the guard it falls
      // through and starts a session whose opening prompt is the literal text
      // "!stop" — a bot that answers a request to stop by starting.
      (session.registry.getPersistedByThreadId as any).mockReturnValue(undefined);
      (session.getPersistedSession as any).mockReturnValue(undefined);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !stop',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSession).not.toHaveBeenCalled();
    });

    test('a non-allowlisted user gets no commands in a paused thread', async () => {
      // The paused branch must not become the one place an outsider can run
      // first-message commands. `worksInFirstMessage` covers `!worktree list`
      // and `!worktree switch`, which post repository branches and absolute
      // paths, and several handlers never consult `ctx.isAllowed` themselves —
      // so the refusal has to happen before the executor, exactly as the
      // new-session path does it.
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!help',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const outsider: PlatformUser = { id: 'u9', username: 'random-person', displayName: 'Nope' };

      await handleMessage(client, session, post, outsider, options);

      // `!help` is the mildest thing behind that gate and the easiest to
      // observe; the same refusal is what keeps `!worktree list` and
      // `!worktree switch` — which post branch names and absolute paths —
      // from answering an outsider here.
      expect(client.createPost).not.toHaveBeenCalled();
    });

    test('!help still answers in a paused thread', async () => {
      // Regression: every command except !stop was consumed here in silence.
      // !help needs no session at all, and it is the first thing anyone tries
      // when a thread stops answering — so the one command that could explain
      // the situation was also the one guaranteed to say nothing, making a
      // stuck thread look like a bot that had gone deaf.
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!help',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
      const helpText = (client.createPost as any).mock.calls.map(([m]: [string]) => m).join('\n');
      expect(helpText).toContain('!stop');
    });

    test('!worktree remove is dropped, not silently reported as done', async () => {
      // `worksInFirstMessage` is not "needs no session". !worktree remove
      // carries that flag and still calls active-session-only methods: routed
      // through the first-message executor in a paused thread it finds no
      // session, does nothing, and returns handled — succeeding at nothing,
      // quietly, which is the exact shape of failure this branch exists to
      // stop producing.
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree remove some-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.removeWorktreeCommand).not.toHaveBeenCalled();
      const logged = (options.logger!.debug as any).mock.calls.map(([m]: [string]) => m).join('\n');
      expect(logged).toContain('worktree');
      expect(logged).toContain('paused');
    });

    test('!stop the deploy stays a prompt, not a command', async () => {
      // The no-op guard is scoped to a bare command. Someone typing "!stop the
      // deploy" is talking, and must still reach Claude.
      (session.registry.getPersistedByThreadId as any).mockReturnValue(undefined);
      (session.getPersistedSession as any).mockReturnValue(undefined);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !stop the deploy',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSession).toHaveBeenCalled();
    });

    test('a session-only command is dropped, but says so in the log', async () => {
      // The other half: commands that genuinely need a live session still
      // cannot run — but the drop is recorded, so the next person debugging a
      // quiet thread sees a reason instead of nothing at all.
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!escape',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
      expect(session.interruptSession).not.toHaveBeenCalled();
      const logged = (options.logger!.debug as any).mock.calls.map(([m]: [string]) => m).join('\n');
      expect(logged).toContain('escape');
      expect(logged).toContain('paused');
    });

    test('other commands in paused session do not resume', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!help',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
    });

    test('quiet mode on: a non-mention reply does not resume the paused session (#410)', async () => {
      // Regression for #410: the persisted respondOnlyWhenMentioned flag must
      // survive the idle pause. A plain reply (no @mention) should be ignored,
      // not silently resume the session like it did before the fix.
      (session.getPersistedSession as any).mockReturnValue({
        sessionAllowedUsers: ['allowed-user'],
        respondOnlyWhenMentioned: true,
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'just chatting with a colleague here',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).not.toHaveBeenCalled();
    });

    test('quiet mode on: an @mention reply still resumes the paused session (#410)', async () => {
      (session.getPersistedSession as any).mockReturnValue({
        sessionAllowedUsers: ['allowed-user'],
        respondOnlyWhenMentioned: true,
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot please continue',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).toHaveBeenCalledWith('thread1', 'please continue', undefined, 'allowed-user', 'test-platform');
    });

    test('quiet mode off (default): a non-mention reply still resumes the paused session', async () => {
      (session.getPersistedSession as any).mockReturnValue({
        sessionAllowedUsers: ['allowed-user'],
        respondOnlyWhenMentioned: false,
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'continue please',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).toHaveBeenCalledWith('thread1', 'continue please', undefined, 'allowed-user', 'test-platform');
    });
  });

  describe('new session', () => {
    test('requires @mention to start', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'help me with code',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSession).not.toHaveBeenCalled();
    });

    test('rejects unauthorized users', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot help',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSession).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });

    test('starts session for authorized user with @mention', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot help me with this',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSession).toHaveBeenCalledWith(
        { prompt: 'help me with this', files: undefined },
        'allowed-user',
        'thread1',
        'test-platform',
        'User',
        'post1',  // triggeringPostId
        {}  // initialOptions
      );
    });

    test('prompts for message when mention has no content', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSession).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });

    test('handles inline branch syntax "on branch X"', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot on branch feature-x help me',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSessionWithWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.stringMatching(/help me/) }),
        'feature-x',
        'allowed-user',
        'thread1',
        'test-platform',
        'User',
        'post1',  // triggeringPostId
        {}  // initialOptions
      );
    });

    test('handles inline worktree syntax "!worktree X" with prompt', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree my-branch do something',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.startSessionWithWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.stringMatching(/do something/) }),
        'my-branch',
        'allowed-user',
        'thread1',
        'test-platform',
        'User',
        'post1',  // triggeringPostId
        {}  // initialOptions
      );
    });

    test('handles !worktree branch-name WITHOUT prompt - should start session in worktree', async () => {
      // BUG: "@bot !worktree try/try" (without additional text) returns "Mention me with your request"
      // Expected: Should start a session in the worktree, possibly with empty prompt or showing worktree prompt
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree try/try',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      // Should NOT show "Mention me with your request" error
      const postCalls = (client.createPost as any).mock.calls;
      const errorPost = postCalls.find((call: string[]) => call[0].includes('Mention me with your request'));
      expect(errorPost).toBeUndefined();

      // Should start session with worktree (empty prompt is OK for worktree-only sessions)
      expect(session.startSessionWithWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: '' }),  // Empty prompt is acceptable
        'try/try',
        'allowed-user',
        'thread1',
        'test-platform',
        'User',
        'post1',
        {}
      );
    });

    test('handles !worktree switch in root message without prompt - should switch and not start session', async () => {
      // !worktree switch branch-name without additional prompt
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree switch feature-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      // Should call switchToWorktreeWithoutSession (switch only, no session start)
      expect(session.switchToWorktreeWithoutSession).toHaveBeenCalledWith('test-platform', 'thread1', 'feature-branch');
      // Should NOT start a session since there's no prompt
      expect(session.startSession).not.toHaveBeenCalled();
      expect(session.startSessionWithWorktree).not.toHaveBeenCalled();
    });

    test('handles !worktree switch in root message WITH prompt - should switch and start session', async () => {
      // BUG: "@bot !worktree switch bla hi! waar ben je nu?" should switch to "bla" worktree
      // and start a session with prompt "hi! waar ben je nu?"
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree switch bla hi! waar ben je nu?',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      // Should start session with worktree "bla" and prompt "hi! waar ben je nu?"
      expect(session.startSessionWithWorktree).toHaveBeenCalledWith(
        { prompt: 'hi! waar ben je nu?', files: undefined },
        'bla',
        'allowed-user',
        'thread1',
        'test-platform',
        'User',
        'post1',
        { switchToExisting: true }  // flag to switch to existing worktree instead of creating
      );
    });

    test('handles !worktree list in root message - should list worktrees without session', async () => {
      // BUG: !worktree list in root message does nothing because listWorktreesCommand
      // requires an active session. In root message context, we need to list worktrees
      // directly without a session, or provide a way to list worktrees without session.
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree list',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      // The current behavior calls listWorktreesCommand which does nothing without session
      // We want to verify the EXPECTED behavior: worktrees should be listed to the user
      expect(session.listWorktreesWithoutSession).toHaveBeenCalledWith('test-platform', 'thread1');
      expect(session.startSession).not.toHaveBeenCalled();
      expect(session.startSessionWithWorktree).not.toHaveBeenCalled();
    });

    test('handles !worktree remove in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree remove old-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.removeWorktreeCommand).toHaveBeenCalledWith('thread1', 'old-branch', 'allowed-user');
      expect(session.startSessionWithWorktree).not.toHaveBeenCalled();
    });

    test('handles !worktree cleanup in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree cleanup',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.cleanupWorktreeCommand).toHaveBeenCalledWith('thread1', 'allowed-user');
      expect(session.startSessionWithWorktree).not.toHaveBeenCalled();
    });

    test('handles !worktree off in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree off',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.disableWorktreePrompt).toHaveBeenCalledWith('thread1', 'allowed-user');
      expect(session.startSessionWithWorktree).not.toHaveBeenCalled();
    });

    test('handles !worktree switch without branch name in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree switch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.switchToWorktree).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Usage');
    });

    test('handles !worktree remove without branch name in root message', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot !worktree remove',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.removeWorktreeCommand).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Usage');
    });

    // Tests for commands that work in the first message
    describe('first message commands', () => {
      test('!help in first message shows help without starting session', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !help',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).not.toHaveBeenCalled();
        expect(client.createPost).toHaveBeenCalled();
        const postContent = (client.createPost as any).mock.calls[0][0];
        expect(postContent).toContain('Commands');  // Help message contains commands
      });

      test('!cd in first message passes workingDir to startSession', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !cd /tmp write a file',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).toHaveBeenCalledWith(
          { prompt: 'write a file', files: undefined },
          'allowed-user',
          'thread1',
          'test-platform',
          'User',
          'post1',
          { workingDir: '/tmp' }  // initialOptions with workingDir
        );
      });

      test('!permissions interactive in first message passes forceInteractivePermissions', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !permissions interactive fix a bug',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).toHaveBeenCalledWith(
          { prompt: 'fix a bug', files: undefined },
          'allowed-user',
          'thread1',
          'test-platform',
          'User',
          'post1',
          { permissionMode: 'default', forceInteractivePermissions: true }  // initialOptions with permission mode
        );
      });

      test('!update in first message shows update status without starting session', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !update',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).not.toHaveBeenCalled();
        expect(session.showUpdateStatusWithoutSession).toHaveBeenCalledWith(
          'test-platform',
          'thread1'
        );
      });

      test('combined !cd and !permissions in first message', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !cd /tmp !permissions interactive do something',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).toHaveBeenCalledWith(
          { prompt: 'do something', files: undefined },
          'allowed-user',
          'thread1',
          'test-platform',
          'User',
          'post1',
          { workingDir: '/tmp', permissionMode: 'default', forceInteractivePermissions: true }
        );
      });

      test('!release-notes in first message shows release notes without starting session', async () => {
        const post: PlatformPost = {
          id: 'post1',
          platformId: 'test',
          channelId: 'channel1',
          userId: 'user1',
          message: '@claude-bot !release-notes',
          rootId: 'thread1',
          createAt: Date.now(),
        };
        const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

        await handleMessage(client, session, post, user, options);

        expect(session.startSession).not.toHaveBeenCalled();
        expect(client.createPost).toHaveBeenCalled();
      });
    });
  });

  describe('error handling', () => {
    test('catches and reports errors', async () => {
      (session.startSession as any).mockRejectedValue(new Error('Test error'));

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot help',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(options.logger?.error).toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });

    test('handles null user gracefully', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '@claude-bot help',
        rootId: 'thread1',
        createAt: Date.now(),
      };

      await handleMessage(client, session, post, null, options);

      // Should reject with "unknown" username as unauthorized
      expect(session.startSession).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
    });
  });

  describe('!permissions auto command', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
    });

    test('dispatches !permissions auto through setSessionPermissionMode', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!permissions auto',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      // `auto` is a canonical mode; it should respawn Claude with --permission-mode auto.
      expect(session.setSessionPermissionMode).toHaveBeenCalledWith('thread1', 'allowed-user', 'auto');
    });

    test('dispatches !permissions bypass through setSessionPermissionMode', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!permissions bypass',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.setSessionPermissionMode).toHaveBeenCalledWith('thread1', 'allowed-user', 'bypass');
    });

    test('rejects !permissions with unknown mode', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!permissions bogus',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      // Parser regex doesn't match; command is ignored. `setSessionPermissionMode`
      // is not called.
      expect(session.setSessionPermissionMode).not.toHaveBeenCalled();
    });
  });

  describe('!worktree commands', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
    });

    test('handles !worktree switch without branch name', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree switch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.switchToWorktree).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Usage');
    });

    test('handles !worktree remove without branch name', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree remove',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.removeWorktreeCommand).not.toHaveBeenCalled();
      expect(client.createPost).toHaveBeenCalled();
      const postContent = (client.createPost as any).mock.calls[0][0];
      expect(postContent).toContain('Usage');
    });

    test('handles !worktree off command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree off',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.disableWorktreePrompt).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !worktree cleanup command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree cleanup',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.cleanupWorktreeCommand).toHaveBeenCalledWith('thread1', 'allowed-user');
    });

    test('handles !worktree remove with branch name', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!worktree remove old-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.removeWorktreeCommand).toHaveBeenCalledWith('thread1', 'old-branch', 'allowed-user');
    });
  });

  describe('Claude Code slash commands', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
    });

    test('handles !context command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!context',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', '/context', undefined, undefined, undefined, { system: true });
    });

    test('handles !cost command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!cost',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', '/cost', undefined, undefined, undefined, { system: true });
    });

    test('handles !compact command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!compact',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', '/compact', undefined, undefined, undefined, { system: true });
    });

    test('does not send slash commands for unauthorized user', async () => {
      (session.isUserAllowedInSession as any).mockReturnValue(false);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!context',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).not.toHaveBeenCalled();
    });

    test('handles dynamic slash commands from init event', async () => {
      // Mock session with availableSlashCommands populated from init event
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        availableSlashCommands: new Set(['context', 'cost', 'compact', 'init', 'review', 'security-review']),
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!review',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', '/review', undefined, undefined, undefined, { system: true });
    });

    test('handles dynamic slash commands with arguments', async () => {
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        availableSlashCommands: new Set(['context', 'cost', 'compact', 'init', 'review']),
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!review --detailed',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', '/review --detailed', undefined, undefined, undefined, { system: true });
    });

    test('does not pass through unknown commands', async () => {
      (session.registry.findByThreadId as any).mockReturnValue({
        sessionId: 'test:thread1',
        availableSlashCommands: new Set(['context', 'cost', 'compact']),
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!unknowncommand',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      // Unknown command should not be passed through
      expect(session.sendFollowUp).not.toHaveBeenCalled();
    });
  });

  describe('!plugin command', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
      // Add mock for plugin methods
      (session as any).pluginList = mock(() => Promise.resolve());
      (session as any).pluginInstall = mock(() => Promise.resolve());
      (session as any).pluginUninstall = mock(() => Promise.resolve());
    });

    test('handles !plugin list command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin list',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect((session as any).pluginList).toHaveBeenCalledWith('thread1');
    });

    test('handles !plugin without subcommand (defaults to list)', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect((session as any).pluginList).toHaveBeenCalledWith('thread1');
    });

    test('handles !plugin install command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin install context7',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect((session as any).pluginInstall).toHaveBeenCalledWith('thread1', 'context7', 'allowed-user');
    });

    test('handles !plugin uninstall command', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin uninstall context7',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect((session as any).pluginUninstall).toHaveBeenCalledWith('thread1', 'context7', 'allowed-user');
    });

    test('shows error when !plugin install missing name', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin install',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
      expect((client.createPost as any).mock.calls[0][0]).toContain('!plugin install <plugin-name>');
    });

    test('shows error when !plugin uninstall missing name', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin uninstall',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
      expect((client.createPost as any).mock.calls[0][0]).toContain('!plugin uninstall <plugin-name>');
    });

    test('shows error for unknown plugin subcommand', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin unknown',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
      expect((client.createPost as any).mock.calls[0][0]).toContain('Unknown subcommand');
    });

    test('does not allow unauthorized users to use plugin commands', async () => {
      (session.isUserAllowedInSession as any).mockReturnValue(false);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!plugin install context7',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect((session as any).pluginInstall).not.toHaveBeenCalled();
    });
  });

  describe('!kill with active sessions', () => {
    test('notifies all active sessions before shutdown', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;
      (session.getActiveThreadIds as any).mockReturnValue(['thread1', 'thread2']);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kill',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'admin', displayName: 'Admin' };

      await handleMessage(client, session, post, user, options);

      // Should have posted: 1 confirmation to the kill thread + 2 notifications to active threads
      expect(client.createPost).toHaveBeenCalledTimes(3);
      // First call is the confirmation to the thread where !kill was issued
      expect((client.createPost as any).mock.calls[0][0]).toContain('EMERGENCY SHUTDOWN');
      expect((client.createPost as any).mock.calls[0][0]).toContain('killing 2 active sessions');
      expect(session.killAllSessions).toHaveBeenCalled();
    });

    test('posts confirmation even with no active sessions', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;
      (session.getActiveThreadIds as any).mockReturnValue([]);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kill',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'admin', displayName: 'Admin' };

      await handleMessage(client, session, post, user, options);

      // Should have posted confirmation even with no active sessions
      expect(client.createPost).toHaveBeenCalledTimes(1);
      expect((client.createPost as any).mock.calls[0][0]).toContain('killing 0 active sessions');
      expect(session.killAllSessions).toHaveBeenCalled();
    });

    test('does not duplicate notification when kill issued from active session thread', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;
      // The kill is issued from thread1, which is also an active session
      (session.getActiveThreadIds as any).mockReturnValue(['thread1', 'thread2']);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kill',
        rootId: 'thread1', // Kill issued from within an active session
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'admin', displayName: 'Admin' };

      await handleMessage(client, session, post, user, options);

      // Should have posted: 1 confirmation to thread1 + 1 notification to thread2 (not thread1 again)
      expect(client.createPost).toHaveBeenCalledTimes(2);
      // First call is the confirmation (includes session count)
      expect((client.createPost as any).mock.calls[0][0]).toContain('killing 2 active sessions');
      expect((client.createPost as any).mock.calls[0][1]).toBe('thread1');
      // Second call is notification to thread2 only
      expect((client.createPost as any).mock.calls[1][1]).toBe('thread2');
      expect(session.killAllSessions).toHaveBeenCalled();
    });

    test('continues kill even if notifying a thread fails', async () => {
      const onKill = mock(() => {});
      options.onKill = onKill;
      (session.getActiveThreadIds as any).mockReturnValue(['thread1', 'thread2']);
      // Make the first createPost call fail
      let callCount = 0;
      (client.createPost as any).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error');
        }
        return { id: 'post_1' };
      });

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!kill',
        rootId: '',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'admin', displayName: 'Admin' };

      await handleMessage(client, session, post, user, options);

      // Kill should still proceed
      expect(session.killAllSessions).toHaveBeenCalled();
      expect(onKill).toHaveBeenCalledWith('admin');
    });
  });

  describe('!release-notes command', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
    });

    test('shows release notes when available', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!release-notes',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
      // The post should contain version info (either formatted release notes or fallback message)
      const postContent = (client.createPost as any).mock.calls[0][0];
      // Either contains "Release Notes" (formatted) or "claude-threads" (fallback)
      expect(postContent.includes('Release Notes') || postContent.includes('claude-threads')).toBe(true);
    });

    test('handles !changelog alias', async () => {
      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: '!changelog',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(client.createPost).toHaveBeenCalled();
    });
  });

  describe('pending worktree prompt', () => {
    beforeEach(() => {
      (session.registry.findByThreadId as any).mockReturnValue({ sessionId: 'test:thread1' });
      (session.hasPendingWorktreePrompt as any).mockReturnValue(true);
    });

    test('handles branch response when user is allowed', async () => {
      (session.handleWorktreeBranchResponse as any).mockResolvedValue(true);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'feature/my-branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.handleWorktreeBranchResponse).toHaveBeenCalledWith(
        'thread1',
        'feature/my-branch',
        'allowed-user',
        'post1'
      );
      expect(session.sendFollowUp).not.toHaveBeenCalled();
    });

    test('falls through when branch response returns false', async () => {
      (session.handleWorktreeBranchResponse as any).mockResolvedValue(false);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'not a valid branch response',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

      await handleMessage(client, session, post, user, options);

      expect(session.handleWorktreeBranchResponse).toHaveBeenCalled();
      // Should fall through to sendFollowUp
      expect(session.sendFollowUp).toHaveBeenCalledWith('thread1', 'not a valid branch response', undefined, 'allowed-user', 'User');
    });

    test('does not handle branch response for unauthorized user', async () => {
      (session.isUserAllowedInSession as any).mockReturnValue(false);

      const post: PlatformPost = {
        id: 'post1',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'feature/branch',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

      await handleMessage(client, session, post, user, options);

      expect(session.handleWorktreeBranchResponse).not.toHaveBeenCalled();
      expect(session.requestMessageApproval).toHaveBeenCalled();
    });
  });
  describe('ack reaction (read receipt)', () => {
    const mentionPost = (): PlatformPost => ({
      id: 'post1',
      platformId: 'test',
      channelId: 'channel1',
      userId: 'user1',
      message: '@claude-bot help me',
      rootId: 'thread1',
      createAt: Date.now(),
    });
    const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

    test('is off by default', async () => {
      await handleMessage(client, session, mentionPost(), user, options);

      expect(session.startSession).toHaveBeenCalled();
      expect(client.addReaction).not.toHaveBeenCalled();
    });

    test('acks an accepted session start with eyes when enabled', async () => {
      (client as unknown as { ackReaction?: boolean | string }).ackReaction = true;

      await handleMessage(client, session, mentionPost(), user, options);

      expect(client.addReaction).toHaveBeenCalledWith('post1', 'eyes');
    });

    test('uses a custom emoji name when configured as a string', async () => {
      (client as unknown as { ackReaction?: boolean | string }).ackReaction = 'white_check_mark';

      await handleMessage(client, session, mentionPost(), user, options);

      expect(client.addReaction).toHaveBeenCalledWith('post1', 'white_check_mark');
    });

    test('acks an accepted follow-up in an active session', async () => {
      (client as unknown as { ackReaction?: boolean | string }).ackReaction = true;
      (session.registry.findByThreadId as any).mockReturnValue({
        respondOnlyWhenMentioned: false,
      });

      const post: PlatformPost = {
        id: 'post2',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'a follow-up',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      await handleMessage(client, session, post, user, options);

      expect(session.sendFollowUp).toHaveBeenCalled();
      expect(client.addReaction).toHaveBeenCalledWith('post2', 'eyes');
    });

    test('acks an accepted resume of a paused session', async () => {
      (client as unknown as { ackReaction?: boolean | string }).ackReaction = true;
      (session.registry.getPersistedByThreadId as any).mockReturnValue({ sessionAllowedUsers: ['allowed-user'] });
      (session.getPersistedSession as any).mockReturnValue({ sessionAllowedUsers: ['allowed-user'] });

      const post: PlatformPost = {
        id: 'post4',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'continue please',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      await handleMessage(client, session, post, user, options);

      expect(session.resumePausedSession).toHaveBeenCalled();
      expect(client.addReaction).toHaveBeenCalledWith('post4', 'eyes');
    });

    test('does not ack messages the bot ignores (no mention, no session)', async () => {
      (client as unknown as { ackReaction?: boolean | string }).ackReaction = true;

      const post: PlatformPost = {
        id: 'post3',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'user1',
        message: 'just chatting with someone else',
        rootId: '',
        createAt: Date.now(),
      };
      await handleMessage(client, session, post, user, options);

      expect(session.startSession).not.toHaveBeenCalled();
      expect(client.addReaction).not.toHaveBeenCalled();
    });

    test('does not ack an unauthorized user', async () => {
      (client as unknown as { ackReaction?: boolean | string }).ackReaction = true;

      const post = mentionPost();
      const outsider: PlatformUser = { id: 'u2', username: 'outsider', displayName: 'X' };
      await handleMessage(client, session, post, outsider, options);

      expect(session.startSession).not.toHaveBeenCalled();
      expect(client.addReaction).not.toHaveBeenCalled();
    });

    test('does not ack a follow-up from a user outside the session (message-approval path)', async () => {
      (client as unknown as { ackReaction?: boolean | string }).ackReaction = true;
      (session.registry.findByThreadId as any).mockReturnValue({
        respondOnlyWhenMentioned: false,
      });
      (session.isUserAllowedInSession as any).mockReturnValue(false);

      const post: PlatformPost = {
        id: 'post5',
        platformId: 'test',
        channelId: 'channel1',
        userId: 'u2',
        message: 'may I join in',
        rootId: 'thread1',
        createAt: Date.now(),
      };
      const outsider: PlatformUser = { id: 'u2', username: 'outsider', displayName: 'X' };
      await handleMessage(client, session, post, outsider, options);

      expect(session.requestMessageApproval).toHaveBeenCalled();
      expect(session.sendFollowUp).not.toHaveBeenCalled();
      expect(client.addReaction).not.toHaveBeenCalled();
    });
  });
});

describe('audit command taps', () => {
  let auditDir: string;
  let prevAuditDir: string | undefined;

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), 'ct-audit-mh-'));
    prevAuditDir = process.env.CLAUDE_THREADS_AUDIT_DIR;
    process.env.CLAUDE_THREADS_AUDIT_DIR = auditDir;
    _resetAuditLog();
  });

  afterEach(() => {
    if (prevAuditDir === undefined) delete process.env.CLAUDE_THREADS_AUDIT_DIR;
    else process.env.CLAUDE_THREADS_AUDIT_DIR = prevAuditDir;
    _resetAuditLog();
    rmSync(auditDir, { recursive: true, force: true });
  });

  test('!kill from an authorized user is recorded', async () => {
    const client = createMockPlatform();
    const session = createMockSessionManager();
    const options = { platformId: 'test-platform', logger: { error: mock(() => {}) }, onKill: mock(() => {}) };
    configureAuditLog('test-platform', true);

    const post: PlatformPost = {
      id: 'post-kill',
      platformId: 'test',
      channelId: 'channel1',
      userId: 'user1',
      message: '!kill',
      rootId: '',
      createAt: Date.now(),
    };
    const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

    await handleMessage(client as never, session as never, post, user, options as never);

    const rec = JSON.parse(readFileSync(join(auditDir, 'test-platform.jsonl'), 'utf-8').trim());
    expect(rec.kind).toBe('command');
    expect(rec.tool).toBe('kill');
    expect(rec.actor).toBe('allowed-user');
  });

  test('!kill from an unauthorized user is not recorded', async () => {
    const client = createMockPlatform();
    const session = createMockSessionManager();
    const options = { platformId: 'test-platform', logger: { error: mock(() => {}) }, onKill: mock(() => {}) };
    configureAuditLog('test-platform', true);

    const post: PlatformPost = {
      id: 'post-kill2',
      platformId: 'test',
      channelId: 'channel1',
      userId: 'user1',
      message: '!kill',
      rootId: '',
      createAt: Date.now(),
    };
    const user: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'X' };

    await handleMessage(client as never, session as never, post, user, options as never);

    expect(readdirSync(auditDir)).toHaveLength(0);
  });
});

describe('direct channel mode (DCM)', () => {
  let client: PlatformClient & { posts: Map<string, string> };
  let session: ReturnType<typeof createMockSessionManager>;
  let options: MessageHandlerOptions;

  const makePost = (overrides: Partial<PlatformPost> = {}): PlatformPost => ({
    id: 'post1',
    platformId: 'test',
    channelId: 'channel1',
    userId: 'user1',
    message: 'fix the flaky test',
    rootId: '',
    createAt: Date.now(),
    ...overrides,
  });
  const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

  beforeEach(() => {
    client = createMockPlatform();
    session = createMockSessionManager();
    options = { platformId: 'test-platform', directChannelMode: true };
  });

  test('starts a session without an @mention, keyed by the synthetic dcm id', async () => {
    await handleMessage(client, session, makePost(), user, options);

    expect(session.startSession).toHaveBeenCalled();
    const call = (session.startSession as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toEqual({ prompt: 'fix the flaky test', files: undefined });
    expect(call[2]).toBe('dcm:test-platform');
  });

  test('still extracts the prompt when the bot IS mentioned', async () => {
    await handleMessage(client, session, makePost({ message: '@claude-bot do the thing' }), user, options);

    const call = (session.startSession as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0].prompt).toBe('do the thing');
    expect(call[2]).toBe('dcm:test-platform');
  });

  test('routes a message posted inside any thread to the one channel session', async () => {
    (session.registry.findByThreadId as ReturnType<typeof mock>).mockImplementation(
      (threadId: string) => (threadId === 'dcm:test-platform' ? { respondOnlyWhenMentioned: false } : undefined)
    );

    await handleMessage(client, session, makePost({ rootId: 'some-real-thread', message: 'and also run the tests' }), user, options);

    expect(session.sendFollowUp).toHaveBeenCalled();
    const call = (session.sendFollowUp as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('dcm:test-platform');
    expect(call[1]).toBe('and also run the tests');
    expect(session.startSession).not.toHaveBeenCalled();
  });

  test('unauthorized users are silently ignored unless they @mention the bot', async () => {
    // In all-messages DCM EVERY channel message from a non-allowlisted
    // member reaches the authorization check — an unconditional warning
    // would be unbounded channel spam (and lets two bots warn at each
    // other in a loop on Mattermost, which passes other bots' posts
    // through).
    const badUser: PlatformUser = { id: 'u2', username: 'stranger', displayName: 'Stranger' };

    await handleMessage(client, session, makePost(), badUser, options);
    expect(session.startSession).not.toHaveBeenCalled();
    expect([...client.posts.values()].join('\n')).not.toContain('not authorized');

    // An explicit @mention still gets the warning — the user addressed the bot.
    await handleMessage(client, session, makePost({ message: '@claude-bot help me' }), badUser, options);
    expect(session.startSession).not.toHaveBeenCalled();
    expect([...client.posts.values()].join('\n')).toContain('not authorized');
  });

  test('a message addressed to another user never starts a session (side conversation)', async () => {
    // The active- and paused-session paths ignore @someone-else messages;
    // without the same guard here, '@bob did you deploy?' in a fresh DCM
    // channel would start a Claude session in a human-to-human exchange.
    await handleMessage(client, session, makePost({ message: '@bob did you deploy?' }), user, options);

    expect(session.startSession).not.toHaveBeenCalled();
    expect(session.sendFollowUp).not.toHaveBeenCalled();
  });

  test('the side-conversation guard also understands Slack raw mentions', async () => {
    // Slack delivers '<@U0BOB> did you deploy?' — the raw user-id form.
    // A guard matching only '@name' never fires on Slack, so every aside
    // between two humans would start a Claude session.
    await handleMessage(client, session, makePost({ message: '<@U0BOB> did you deploy?' }), user, options);

    expect(session.startSession).not.toHaveBeenCalled();
    expect(session.sendFollowUp).not.toHaveBeenCalled();
  });


  test('respondTo: mention — a channel message without @mention starts nothing', async () => {
    options = { platformId: 'test-platform', directChannelMode: { respondTo: 'mention' } };

    await handleMessage(client, session, makePost(), user, options);

    expect(session.startSession).not.toHaveBeenCalled();
  });

  test('respondTo: mention — a mentioned message starts the DCM session', async () => {
    options = { platformId: 'test-platform', directChannelMode: { respondTo: 'mention' } };

    await handleMessage(client, session, makePost({ message: '@claude-bot do it' }), user, options);

    const call = (session.startSession as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0].prompt).toBe('do it');
    expect(call[2]).toBe('dcm:test-platform');
  });

  test('without the flag, a message without @mention still starts nothing', async () => {
    options = { platformId: 'test-platform' };

    await handleMessage(client, session, makePost(), user, options);

    expect(session.startSession).not.toHaveBeenCalled();
    expect(session.sendFollowUp).not.toHaveBeenCalled();
  });

});

describe('handleMessage - legacy paused-session resume', () => {
  test("approvals 'owner' + a legacy record without sessionAllowedUsers still lets the owner resume", async () => {
    // Legacy persisted sessions (pre-collaboration versions) have no
    // sessionAllowedUsers. Under approvals 'owner' the global-allowlist
    // rescue is dropped, so without the [startedBy] fallback the owner's
    // own reply would be rejected and the session unresumable by text
    // (CLAUDE.md backward-compat rule; reaction-router already has the
    // fallback).
    const client = createMockPlatform();
    (client as unknown as { approvals: string }).approvals = 'owner';
    const session = createMockSessionManager();
    (session.registry.getPersistedByThreadId as ReturnType<typeof mock>).mockReturnValue({ startedBy: 'allowed-user' });
    (session.getPersistedSession as ReturnType<typeof mock>).mockReturnValue({ startedBy: 'allowed-user' });

    const post: PlatformPost = {
      id: 'post1',
      platformId: 'test',
      channelId: 'channel1',
      userId: 'user1',
      message: 'please continue',
      rootId: 'thread-1',
      createAt: Date.now(),
    };
    const owner: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

    await handleMessage(client, session, post, owner, { platformId: 'test-platform' });

    expect(session.resumePausedSession).toHaveBeenCalledTimes(1);
    const posted = [...client.posts.values()].join('\n');
    expect(posted).not.toContain('not authorized');
  });
});

describe('handleMessage - a voice note is evaluated as its words', () => {
  let client: ReturnType<typeof createMockPlatform>;
  let session: ReturnType<typeof createMockSessionManager>;
  let options: MessageHandlerOptions;

  beforeEach(() => {
    client = createMockPlatform();
    session = createMockSessionManager();
    options = { platformId: 'test-platform' };
  });

  const voiceNote: PlatformPost = {
    id: 'post1',
    platformId: 'test',
    channelId: 'channel1',
    userId: 'user1',
    message: '',
    rootId: '',
    createAt: Date.now(),
    metadata: { files: [{ id: 'f1', name: 'voice.webm', mimeType: 'audio/webm' }] },
  } as unknown as PlatformPost;
  const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

  test('the transcript, not the empty message, is what the evaluator sees', async () => {
    // A watch on "deploy" has to fire when somebody SAYS deploy. Without this
    // the evaluator receives '' and a file beside it, so voice notes are
    // invisible to every watch in the channel — the transcript would be a
    // courtesy for human readers and nothing more.
    (session.transcribeForWatch as any).mockResolvedValue('please deploy the trader');

    await handleMessage(client, session, voiceNote, user, options);

    expect(session.evaluateWatches).toHaveBeenCalledTimes(1);
    const evaluated = (session.evaluateWatches as any).mock.calls[0][3];
    expect(evaluated).toContain('please deploy the trader');
  });

  test('a typed message is unchanged when there is nothing spoken', async () => {
    (session.transcribeForWatch as any).mockResolvedValue('');

    await handleMessage(
      client,
      session,
      { ...voiceNote, message: 'ship it', metadata: undefined } as PlatformPost,
      user,
      options,
    );

    expect((session.evaluateWatches as any).mock.calls[0][3]).toBe('ship it');
  });

  test('an outsider cannot spend the transcription quota', async () => {
    // Evaluating a watch is free and has always run for anyone in the
    // channel. Transcribing is a paid vendor call, so it needs the gate the
    // free operation never did — otherwise any member of an invited channel
    // could drop a hundred voice notes and bill them to the operator.
    (session.transcribeForWatch as any).mockResolvedValue('should never be reached');
    const outsider: PlatformUser = { id: 'u9', username: 'random-person', displayName: 'Nope' };

    await handleMessage(client, session, voiceNote, outsider, options);

    expect(session.transcribeForWatch).not.toHaveBeenCalled();
    // The watch still sees the post, exactly as it did before this change.
    expect(session.evaluateWatches).toHaveBeenCalledTimes(1);
  });

  test('a caption and its transcript both reach the evaluator', async () => {
    // Someone can type and speak in one message; a watch must see both, or
    // whichever half it was not watching for silently stops mattering.
    (session.transcribeForWatch as any).mockResolvedValue('and restart the node');

    await handleMessage(
      client,
      session,
      { ...voiceNote, message: 'as discussed' } as PlatformPost,
      user,
      options,
    );

    const evaluated = (session.evaluateWatches as any).mock.calls[0][3];
    expect(evaluated).toContain('as discussed');
    expect(evaluated).toContain('and restart the node');
  });
});

describe('handleMessage - watch evaluation hook', () => {
  let client: PlatformClient & { posts: Map<string, string> };
  let session: ReturnType<typeof createMockSessionManager>;

  const makePost = (overrides: Partial<PlatformPost> = {}): PlatformPost => ({
    id: 'post1',
    platformId: 'test',
    channelId: 'channel1',
    userId: 'user1',
    message: 'the deploy pipeline is broken again',
    rootId: '',
    createAt: Date.now(),
    ...overrides,
  });
  const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };

  beforeEach(() => {
    client = createMockPlatform();
    session = createMockSessionManager();
  });

  test('an otherwise-ignored channel message is offered to the watch evaluator', async () => {
    await handleMessage(client, session, makePost(), user, { platformId: 'test-platform' });

    expect(session.evaluateWatches).toHaveBeenCalledTimes(1);
    const call = (session.evaluateWatches as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('test-platform');
    expect(call[3]).toBe('the deploy pipeline is broken again');
  });

  test('a mentioned message is never offered to the watch evaluator', async () => {
    await handleMessage(client, session, makePost({ message: '@claude-bot do something' }), user, { platformId: 'test-platform' });

    expect(session.evaluateWatches).not.toHaveBeenCalled();
  });

  test('watches are inert in DCM — a fired session would be keyed on the real thread and unreachable', async () => {
    // DCM routes every message to the synthetic dcm:<platformId> key, so a
    // watch-fired session on the message's real thread root could never
    // receive follow-ups or !stop. respondTo: 'mention' is the only DCM
    // shape whose non-mention messages even reach the fall-through.
    await handleMessage(client, session, makePost(), user, {
      platformId: 'test-platform',
      directChannelMode: { respondTo: 'mention' },
    });

    expect(session.startSession).not.toHaveBeenCalled();
    expect(session.evaluateWatches).not.toHaveBeenCalled();
  });
});

describe('bot-to-bot loop prevention (#491)', () => {
  let client: PlatformClient & { posts: Map<string, string> };
  let session: ReturnType<typeof createMockSessionManager>;

  const pausedThreadPost = (overrides: Partial<PlatformPost> = {}): PlatformPost => ({
    id: 'post1',
    platformId: 'test',
    channelId: 'channel1',
    userId: 'user1',
    message: 'continue please',
    rootId: 'thread1',
    createAt: Date.now(),
    ...overrides,
  });
  const outsider: PlatformUser = { id: 'user1', username: 'outsider', displayName: 'Outsider' };

  beforeEach(() => {
    client = createMockPlatform();
    session = createMockSessionManager();
    (session.registry.getPersistedByThreadId as ReturnType<typeof mock>).mockReturnValue({ sessionAllowedUsers: ['allowed-user'] });
    (session.getPersistedSession as ReturnType<typeof mock>).mockReturnValue({ sessionAllowedUsers: ['allowed-user'] });
  });

  test('the resume refusal never @-mentions the refused user', async () => {
    await handleMessage(client, session, pausedThreadPost(), outsider, { platformId: 'test-platform' });

    expect(session.resumePausedSession).not.toHaveBeenCalled();
    const posted = [...client.posts.values()].join('\n');
    expect(posted).toContain('is not authorized to resume this session');
    // Inline code reads the same to a human and notifies nobody.
    expect(posted).toContain('`outsider`');
    expect(posted).not.toContain('@outsider');
  });

  test('the resume refusal fires once per (thread, user), not once per message', async () => {
    for (let i = 0; i < 4; i++) {
      await handleMessage(client, session, pausedThreadPost({ id: `post${i}` }), outsider, { platformId: 'test-platform' });
    }

    const refusals = [...client.posts.values()].filter((m) => m.includes('is not authorized'));
    expect(refusals).toHaveLength(1);
  });

  test('a refusal for a different user in the same thread still posts', async () => {
    await handleMessage(client, session, pausedThreadPost(), outsider, { platformId: 'test-platform' });
    const other: PlatformUser = { id: 'user2', username: 'other-bot', displayName: 'Other' };
    await handleMessage(client, session, pausedThreadPost({ id: 'post2' }), other, { platformId: 'test-platform' });

    const refusals = [...client.posts.values()].filter((m) => m.includes('is not authorized'));
    expect(refusals).toHaveLength(2);
  });

  test("another bot's refusal post never engages this bot, even when it @-mentions it", async () => {
    // The incident shape: bot A's refusal @-mentions bot B, which passes B's
    // mention gate and would start a session / produce a reply — which
    // re-triggers A. The status-post guard drops it before any routing.
    const post = pausedThreadPost({
      message: '⚠️ @claude-bot is not authorized to resume this session',
      rootId: '',
    });
    (session.registry.getPersistedByThreadId as ReturnType<typeof mock>).mockReturnValue(undefined);
    (session.getPersistedSession as ReturnType<typeof mock>).mockReturnValue(undefined);

    await handleMessage(client, session, post, outsider, { platformId: 'test-platform' });

    expect(session.startSession).not.toHaveBeenCalled();
    expect(session.resumePausedSession).not.toHaveBeenCalled();
    expect(client.createPost).not.toHaveBeenCalled();
  });

  test('status posts are dropped in DCM before routing to the channel session', async () => {
    (session.registry.getPersistedByThreadId as ReturnType<typeof mock>).mockReturnValue(undefined);
    (session.getPersistedSession as ReturnType<typeof mock>).mockReturnValue(undefined);
    const post = pausedThreadPost({
      message: '⏱️ **Session idle** - will timeout in ~5 minutes without activity',
      rootId: '',
    });

    await handleMessage(client, session, post, outsider, {
      platformId: 'test-platform',
      directChannelMode: true,
    });

    expect(session.startSession).not.toHaveBeenCalled();
    expect(client.createPost).not.toHaveBeenCalled();
  });

  test('a human message that merely starts with the warning emoji still gets through', async () => {
    (session.registry.getPersistedByThreadId as ReturnType<typeof mock>).mockReturnValue(undefined);
    (session.getPersistedSession as ReturnType<typeof mock>).mockReturnValue(undefined);
    const user: PlatformUser = { id: 'user1', username: 'allowed-user', displayName: 'User' };
    const post = pausedThreadPost({
      message: '⚠️ @claude-bot the staging deploy looks broken, can you check?',
      rootId: '',
    });

    await handleMessage(client, session, post, user, { platformId: 'test-platform' });

    expect(session.startSession).toHaveBeenCalled();
  });
});

describe('isClaudeThreadsStatusPost (#491)', () => {
  test.each([
    ['⚠️ @some-bot is not authorized to resume this session'],
    ['⚠️ `some-bot` is not authorized to resume this session'],
    ['⚠️ <@U0BOTB> is not authorized'],
    ['⚠️ **Too busy** - 5 sessions active. Please try again later.'],
    ['⚠️ *Too busy* - 5 sessions active. Please try again later.'],
    ['⏱️ **Session timed out** after 30 minutes of inactivity'],
    ['⏱️ *Session idle* - will timeout in ~5 minutes without activity'],
    // #548 variants: a stalled or decision-blocked turn reports differently
    // from a genuinely idle one, and every variant must stay invisible.
    ['⏱️ **Session stopped responding** - no output for 31 minutes while a turn was still running'],
    ['⏱️ *Session stopped responding* - no output for 31 minutes while a turn was still running'],
    ['⏱️ **Session still waiting** for a reply - no answer for 31 minutes, so the turn was stopped'],
    ['⏱️ **No output for a while** - a turn is still running; will stop in ~4 minutes if nothing arrives'],
    ['⏱️ *No output for a while* - a turn is still running; will stop in ~4 minutes if nothing arrives'],
    ['⏱️ **Session still waiting** for a reply - will stop in ~4 minutes without one'],
    ['🛑 **Session cancelled** by @someone'],
    ['🔴 **EMERGENCY SHUTDOWN** initiated by @someone - killing 2 active sessions'],
    ['🔄 **Session resumed** by @someone'],
  ])('recognizes the bot status shape: %s', (message) => {
    expect(isClaudeThreadsStatusPost(message)).toBe(true);
  });

  test.each([
    ['⚠️ careful with the prod database'],
    ['⚠️ @claude-bot the deploy authorization is broken'],
    ['hello there'],
    ['🛑 stop the presses, but read this first'],
    ['is not authorized to resume this session'],
    ['something ⚠️ @bot is not authorized'],
    // #548: the new status phrases are far more natural as human sentences
    // than "Session timed out" ever was, so each pattern is anchored on the
    // clause that follows, not just the opening words.
    ['⏱️ No output for a while — is the build stuck?'],
    ['⏱️ **No output for a while** anyone know why?'],
    ['⏱️ Session still waiting? seems wrong'],
    ['⏱️ Session stopped responding, should I kill it?'],
  ])('lets ordinary messages through: %s', (message) => {
    expect(isClaudeThreadsStatusPost(message)).toBe(false);
  });

  /**
   * #551: the guard runs on every inbound message, on the event loop, before
   * routing. A greedy `\S+` in the refusal pattern made a non-matching message
   * quadratic in its length — ~150 ms at Mattermost's 16k post limit, 3.7 s at
   * 80k — which any channel member could trigger with one long token.
   *
   * The bound is deliberately loose (the fixed form runs in well under a
   * millisecond, the regression took seconds) so this fails on real
   * backtracking rather than on a slow CI runner.
   */
  // Explicit timeout: in the broken state the greedy form takes ~7.4 s, which
  // would also blow bun's 5 s default and report as a runner timeout on top of
  // the assertion. A generous per-test bound keeps a future regression legible
  // as the assertion failure it is.
  test('stays linear on a long non-matching message', () => {
    const cases = [
      `⚠️ ${'a'.repeat(80_000)}`,
      `⚠️ ${'*'.repeat(80_000)}`,
      `⏱️ ${'a'.repeat(80_000)}`,
    ];

    const started = performance.now();
    for (const message of cases) {
      expect(isClaudeThreadsStatusPost(message)).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(250);
  }, 30_000);
});
