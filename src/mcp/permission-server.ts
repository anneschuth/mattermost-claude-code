#!/usr/bin/env node
/**
 * MCP Permission Server
 *
 * This server handles Claude Code's permission prompts by forwarding them to
 * the chat platform for user approval via emoji reactions.
 *
 * Platform-agnostic design: Uses PermissionApi interface with platform-specific
 * implementations selected based on PLATFORM_TYPE environment variable.
 *
 * It is spawned by Claude Code when using --permission-prompt-tool and
 * communicates via stdio (MCP protocol).
 *
 * Approval options:
 *   - 👍 (+1) Allow this tool use
 *   - ✅ (white_check_mark) Allow all future tool uses in this session
 *   - 👎 (-1) Deny this tool use
 *
 * Environment variables (passed by claude-threads):
 *   - PLATFORM_TYPE: Platform type ('mattermost' or 'slack')
 *   - PLATFORM_URL: Platform server URL
 *   - PLATFORM_TOKEN: Bot access token
 *   - PLATFORM_CHANNEL_ID: Channel to post permission requests
 *   - PLATFORM_THREAD_ID: Thread ID for the current session
 *   - ALLOWED_USERS: Comma-separated list of authorized usernames
 *   - DEBUG: Set to '1' for debug logging
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { isApprovalEmoji, isAllowAllEmoji, APPROVAL_EMOJIS, ALLOW_ALL_EMOJIS, DENIAL_EMOJIS } from '../utils/emoji.js';
import { formatToolForPermission } from '../utils/tool-formatter.js';
import { mcpLogger } from '../utils/logger.js';
import type { PermissionApi, PermissionApiConfig } from '../platform/permission-api.js';
import { createPermissionApi } from '../platform/permission-api-factory.js';

// =============================================================================
// Configuration
// =============================================================================

const PLATFORM_TYPE = process.env.PLATFORM_TYPE || '';
const PLATFORM_URL = process.env.PLATFORM_URL || '';
const PLATFORM_TOKEN = process.env.PLATFORM_TOKEN || '';
const PLATFORM_CHANNEL_ID = process.env.PLATFORM_CHANNEL_ID || '';
const PLATFORM_THREAD_ID = process.env.PLATFORM_THREAD_ID || '';
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '')
  .split(',')
  .map(u => u.trim())
  .filter(u => u.length > 0);

const PERMISSION_TIMEOUT_MS = 120000; // 2 minutes

// =============================================================================
// Permission API Instance
// =============================================================================
const apiConfig: PermissionApiConfig = {
  url: PLATFORM_URL,
  token: PLATFORM_TOKEN,
  channelId: PLATFORM_CHANNEL_ID,
  threadId: PLATFORM_THREAD_ID || undefined,
  allowedUsers: ALLOWED_USERS,
  debug: process.env.DEBUG === '1',
};

let permissionApi: PermissionApi | null = null;

function getApi(): PermissionApi {
  if (!permissionApi) {
    permissionApi = createPermissionApi(PLATFORM_TYPE, apiConfig);
  }
  return permissionApi;
}

// Session state
let allowAllSession = false;

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

  if (!PLATFORM_URL || !PLATFORM_TOKEN || !PLATFORM_CHANNEL_ID) {
    mcpLogger.error('Missing platform config');
    return { behavior: 'deny', message: 'Permission service not configured' };
  }

  try {
    const api = getApi();
    const formatter = api.getFormatter();

    // Post permission request with reaction options
    const toolInfo = formatToolForPermission(toolName, toolInput, formatter);
    const message = `⚠️ **Permission requested**\n\n${toolInfo}\n\n` +
      `👍 Allow | ✅ Allow all | 👎 Deny`;

    const botUserId = await api.getBotUserId();
    const post = await api.createInteractivePost(
      message,
      [APPROVAL_EMOJIS[0], ALLOW_ALL_EMOJIS[0], DENIAL_EMOJIS[0]],
      PLATFORM_THREAD_ID || undefined
    );

    // Wait for user's reaction
    const reaction = await api.waitForReaction(post.id, botUserId, PERMISSION_TIMEOUT_MS);

    if (!reaction) {
      await api.updatePost(post.id, `⏱️ **Timed out** - permission denied\n\n${toolInfo}`);
      mcpLogger.info(`Timeout: ${toolName}`);
      return { behavior: 'deny', message: 'Permission request timed out' };
    }

    // Get username and check if allowed
    const username = await api.getUsername(reaction.userId);
    if (!username || !api.isUserAllowed(username)) {
      mcpLogger.debug(`Ignoring unauthorized user: ${username || reaction.userId}`);
      // Keep waiting for authorized user - for now just deny
      return { behavior: 'deny', message: 'Unauthorized user' };
    }

    const emoji = reaction.emojiName;
    mcpLogger.debug(`Reaction ${emoji} from ${username}`);

    if (isApprovalEmoji(emoji)) {
      await api.updatePost(post.id, `✅ **Allowed** by @${username}\n\n${toolInfo}`);
      mcpLogger.info(`Allowed: ${toolName}`);
      return { behavior: 'allow', updatedInput: toolInput };
    } else if (isAllowAllEmoji(emoji)) {
      allowAllSession = true;
      await api.updatePost(post.id, `✅ **Allowed all** by @${username}\n\n${toolInfo}`);
      mcpLogger.info(`Allowed all: ${toolName}`);
      return { behavior: 'allow', updatedInput: toolInput };
    } else {
      await api.updatePost(post.id, `❌ **Denied** by @${username}\n\n${toolInfo}`);
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
    name: 'claude-threads-permissions',
    version: '1.0.0',
  });

  server.tool(
    'permission_prompt',
    'Handle permission requests via chat platform reactions',
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
  mcpLogger.info(`Permission server ready (platform: ${PLATFORM_TYPE})`);
}

main().catch((err) => {
  mcpLogger.error(`Fatal: ${err}`);
  process.exit(1);
});
