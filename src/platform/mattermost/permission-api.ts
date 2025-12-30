/**
 * Mattermost implementation of Permission API
 *
 * Handles permission requests via Mattermost API and WebSocket.
 */

import WebSocket from 'ws';
import type { PermissionApi, PermissionApiConfig, ReactionEvent, PostedMessage } from '../permission-api.js';
import type { PlatformFormatter } from '../formatter.js';
import { MattermostFormatter } from './formatter.js';
import {
  getMe,
  getUser,
  createInteractivePost,
  updatePost,
  isUserAllowed,
  MattermostApiConfig,
} from '../../mattermost/api.js';
import { mcpLogger } from '../../utils/logger.js';

/**
 * Mattermost Permission API implementation
 */
class MattermostPermissionApi implements PermissionApi {
  private readonly apiConfig: MattermostApiConfig;
  private readonly config: PermissionApiConfig;
  private readonly formatter = new MattermostFormatter();
  private botUserIdCache: string | null = null;

  constructor(config: PermissionApiConfig) {
    this.config = config;
    this.apiConfig = {
      url: config.url,
      token: config.token,
    };
  }

  getFormatter(): PlatformFormatter {
    return this.formatter;
  }

  async getBotUserId(): Promise<string> {
    if (this.botUserIdCache) return this.botUserIdCache;
    const me = await getMe(this.apiConfig);
    this.botUserIdCache = me.id;
    return me.id;
  }

  async getUsername(userId: string): Promise<string | null> {
    try {
      const user = await getUser(this.apiConfig, userId);
      return user?.username ?? null;
    } catch {
      return null;
    }
  }

  isUserAllowed(username: string): boolean {
    return isUserAllowed(username, this.config.allowedUsers);
  }

  async createInteractivePost(
    message: string,
    reactions: string[],
    threadId?: string
  ): Promise<PostedMessage> {
    const botUserId = await this.getBotUserId();
    const post = await createInteractivePost(
      this.apiConfig,
      this.config.channelId,
      message,
      reactions,
      threadId,
      botUserId
    );
    return { id: post.id };
  }

  async updatePost(postId: string, message: string): Promise<void> {
    await updatePost(this.apiConfig, postId, message);
  }

  async waitForReaction(
    postId: string,
    botUserId: string,
    timeoutMs: number
  ): Promise<ReactionEvent | null> {
    return new Promise((resolve) => {
      // Parse WebSocket URL from HTTP URL
      const wsUrl = this.config.url.replace(/^http/, 'ws') + '/api/v4/websocket';
      mcpLogger.debug(`Connecting to WebSocket: ${wsUrl}`);

      const ws = new WebSocket(wsUrl);
      let resolved = false;

      const cleanup = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      };

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(null);
        }
      }, timeoutMs);

      ws.on('open', () => {
        mcpLogger.debug('WebSocket connected, sending auth...');
        ws.send(
          JSON.stringify({
            seq: 1,
            action: 'authentication_challenge',
            data: { token: this.config.token },
          })
        );
      });

      ws.on('message', async (data: WebSocket.Data) => {
        if (resolved) return;

        try {
          const event = JSON.parse(data.toString());
          mcpLogger.debug(`WebSocket event: ${event.event}`);

          if (event.event === 'reaction_added') {
            // Mattermost sends reaction as JSON string
            const reaction = typeof event.data.reaction === 'string'
              ? JSON.parse(event.data.reaction)
              : event.data.reaction;

            // Must be on our post
            if (reaction.post_id !== postId) return;

            // Must not be the bot's own reaction (adding the options)
            if (reaction.user_id === botUserId) return;

            mcpLogger.debug(`Reaction received: ${reaction.emoji_name} from user: ${reaction.user_id}`);

            // Got a valid reaction
            resolved = true;
            clearTimeout(timeout);
            cleanup();

            resolve({
              postId: reaction.post_id,
              userId: reaction.user_id,
              emojiName: reaction.emoji_name,
            });
          }
        } catch (err) {
          mcpLogger.debug(`Error parsing WebSocket message: ${err}`);
        }
      });

      ws.on('error', (error) => {
        mcpLogger.error(`WebSocket error: ${error.message}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      });

      ws.on('close', () => {
        mcpLogger.debug('WebSocket closed');
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      });
    });
  }
}

/**
 * Create a Mattermost permission API instance
 */
export function createMattermostPermissionApi(config: PermissionApiConfig): PermissionApi {
  return new MattermostPermissionApi(config);
}
