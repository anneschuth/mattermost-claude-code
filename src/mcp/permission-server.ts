#!/usr/bin/env node
/**
 * MCP Permission Server for Mattermost
 *
 * This server handles Claude Code's permission prompts by forwarding them to
 * Mattermost for user approval via emoji reactions.
 *
 * It is spawned by Claude Code when using --permission-prompt-tool and
 * communicates via stdio (MCP protocol).
 *
 * Approval options:
 *   - 👍 (+1) Allow this tool use
 *   - ✅ (white_check_mark) Allow all future tool uses in this session
 *   - 👎 (-1) Deny this tool use
 *
 * Environment variables (passed by mm-claude):
 *   - MATTERMOST_URL: Mattermost server URL
 *   - MATTERMOST_TOKEN: Bot access token
 *   - MATTERMOST_CHANNEL_ID: Channel to post permission requests
 *   - MM_THREAD_ID: Thread ID for the current session
 *   - ALLOWED_USERS: Comma-separated list of authorized usernames
 *   - DEBUG: Set to '1' for debug logging
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';
import { isApprovalEmoji, isAllowAllEmoji, APPROVAL_EMOJIS, ALLOW_ALL_EMOJIS, DENIAL_EMOJIS } from '../mattermost/emoji.js';
import { formatToolForPermission } from '../utils/tool-formatter.js';
import { mcpLogger } from '../utils/logger.js';
import {
  getMe,
  getUser,
  createInteractivePost,
  updatePost,
  isUserAllowed,
  MattermostApiConfig,
} from '../mattermost/api.js';

// =============================================================================
// Configuration
// =============================================================================

const MM_URL = process.env.MATTERMOST_URL || '';
const MM_TOKEN = process.env.MATTERMOST_TOKEN || '';
const MM_CHANNEL_ID = process.env.MATTERMOST_CHANNEL_ID || '';
const MM_THREAD_ID = process.env.MM_THREAD_ID || '';
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '')
  .split(',')
  .map(u => u.trim())
  .filter(u => u.length > 0);

const PERMISSION_TIMEOUT_MS = 120000; // 2 minutes

// API configuration (created from environment variables)
const apiConfig: MattermostApiConfig = {
  url: MM_URL,
  token: MM_TOKEN,
};

// Session state
let allowAllSession = false;
let botUserId: string | null = null;

// =============================================================================
// Mattermost API Helpers (using shared API layer)
// =============================================================================

async function getBotUserId(): Promise<string> {
  if (botUserId) return botUserId;
  const me = await getMe(apiConfig);
  botUserId = me.id;
  return botUserId;
}

async function getUserById(userId: string): Promise<string | null> {
  const user = await getUser(apiConfig, userId);
  return user?.username || null;
}

function checkUserAllowed(username: string): boolean {
  return isUserAllowed(username, ALLOWED_USERS);
}

// =============================================================================
// Reaction Handling
// =============================================================================

function waitForReaction(postId: string): Promise<{ emoji: string; username: string }> {
  return new Promise((resolve, reject) => {
    const wsUrl = MM_URL.replace(/^http/, 'ws') + '/api/v4/websocket';
    mcpLogger.debug(`Connecting to WebSocket: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      mcpLogger.debug(`Timeout waiting for reaction on ${postId}`);
      ws.close();
      reject(new Error('Permission request timed out'));
    }, PERMISSION_TIMEOUT_MS);

    ws.on('open', () => {
      mcpLogger.debug(`WebSocket connected, authenticating...`);
      ws.send(JSON.stringify({
        seq: 1,
        action: 'authentication_challenge',
        data: { token: MM_TOKEN },
      }));
    });

    ws.on('message', async (data) => {
      try {
        const event = JSON.parse(data.toString());
        mcpLogger.debug(`WS event: ${event.event || event.status || 'unknown'}`);

        if (event.event === 'reaction_added') {
          const reactionData = event.data;
          // Mattermost sends reaction as JSON string
          const reaction = typeof reactionData.reaction === 'string'
            ? JSON.parse(reactionData.reaction)
            : reactionData.reaction;

          mcpLogger.debug(`Reaction on post ${reaction?.post_id}, looking for ${postId}`);

          if (reaction?.post_id === postId) {
            const userId = reaction.user_id;
            mcpLogger.debug(`Reaction from user ${userId}, emoji: ${reaction.emoji_name}`);

            // Ignore bot's own reactions (from adding reaction options)
            const myId = await getBotUserId();
            if (userId === myId) {
              mcpLogger.debug(`Ignoring bot's own reaction`);
              return;
            }

            // Check if user is authorized
            const username = await getUserById(userId);
            mcpLogger.debug(`Username: ${username}, allowed: ${ALLOWED_USERS.join(',') || '(all)'}`);

            if (!username || !checkUserAllowed(username)) {
              mcpLogger.debug(`Ignoring unauthorized user: ${username || userId}`);
              return;
            }

            mcpLogger.debug(`Accepting reaction ${reaction.emoji_name} from ${username}`);
            clearTimeout(timeout);
            ws.close();
            resolve({ emoji: reaction.emoji_name, username });
          }
        }
      } catch (e) {
        mcpLogger.debug(`Parse error: ${e}`);
      }
    });

    ws.on('error', (err) => {
      mcpLogger.debug(`WebSocket error: ${err}`);
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Tool formatting is now imported from ../utils/tool-formatter.js

// =============================================================================
// Permission Handler
// =============================================================================

interface PermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

async function handlePermission(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<PermissionResult> {
  mcpLogger.debug(`handlePermission called for ${toolName}`);

  // Auto-approve if "allow all" was selected earlier
  if (allowAllSession) {
    mcpLogger.debug(`Auto-allowing ${toolName} (allow all active)`);
    return { behavior: 'allow', updatedInput: toolInput };
  }

  if (!MM_URL || !MM_TOKEN || !MM_CHANNEL_ID) {
    mcpLogger.error('Missing Mattermost config');
    return { behavior: 'deny', message: 'Permission service not configured' };
  }

  try {
    // Post permission request to Mattermost with reaction options
    const toolInfo = formatToolForPermission(toolName, toolInput);
    const message = `⚠️ **Permission requested**\n\n${toolInfo}\n\n` +
      `👍 Allow | ✅ Allow all | 👎 Deny`;

    const userId = await getBotUserId();
    const post = await createInteractivePost(
      apiConfig,
      MM_CHANNEL_ID,
      message,
      [APPROVAL_EMOJIS[0], ALLOW_ALL_EMOJIS[0], DENIAL_EMOJIS[0]],
      MM_THREAD_ID || undefined,
      userId
    );

    // Wait for user's reaction
    const { emoji, username } = await waitForReaction(post.id);

    if (isApprovalEmoji(emoji)) {
      await updatePost(apiConfig, post.id, `✅ **Allowed** by @${username}\n\n${toolInfo}`);
      mcpLogger.info(`Allowed: ${toolName}`);
      return { behavior: 'allow', updatedInput: toolInput };
    } else if (isAllowAllEmoji(emoji)) {
      allowAllSession = true;
      await updatePost(apiConfig, post.id, `✅ **Allowed all** by @${username}\n\n${toolInfo}`);
      mcpLogger.info(`Allowed all: ${toolName}`);
      return { behavior: 'allow', updatedInput: toolInput };
    } else {
      await updatePost(apiConfig, post.id, `❌ **Denied** by @${username}\n\n${toolInfo}`);
      mcpLogger.info(`Denied: ${toolName}`);
      return { behavior: 'deny', message: 'User denied permission' };
    }
  } catch (error) {
    mcpLogger.error(`Permission error: ${error}`);
    return { behavior: 'deny', message: String(error) };
  }
}

// =============================================================================
// MCP Server Setup
// =============================================================================

async function main() {
  const server = new McpServer({
    name: 'mm-claude-permissions',
    version: '1.0.0',
  });

  server.tool(
    'permission_prompt',
    'Handle permission requests via Mattermost reactions',
    {
      tool_name: z.string().describe('Name of the tool requesting permission'),
      input: z.record(z.string(), z.unknown()).describe('Tool input parameters'),
    },
    async ({ tool_name, input }) => {
      const result = await handlePermission(tool_name, input as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpLogger.info('Permission server ready');
}

main().catch((err) => {
  mcpLogger.error(`Fatal: ${err}`);
  process.exit(1);
});
