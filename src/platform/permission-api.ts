/**
 * Permission API interface for MCP permission server
 *
 * This interface defines the operations needed by the permission server
 * to post permission requests and receive user responses via reactions.
 * Each platform implements this interface with its specific API.
 */

import type { PlatformFormatter } from './formatter.js';

/**
 * Reaction event from WebSocket
 */
export interface ReactionEvent {
  postId: string;
  userId: string;
  emojiName: string;
}

/**
 * Posted message with ID
 */
export interface PostedMessage {
  id: string;
}

/**
 * Platform-specific permission API
 */
export interface PermissionApi {
  /**
   * Get the markdown formatter for this platform
   */
  getFormatter(): PlatformFormatter;

  /**
   * Get the bot's user ID
   */
  getBotUserId(): Promise<string>;

  /**
   * Get a username from a user ID
   */
  getUsername(userId: string): Promise<string | null>;

  /**
   * Check if a username is in the allowed users list
   */
  isUserAllowed(username: string): boolean;

  /**
   * Create a post with reaction options
   */
  createInteractivePost(
    message: string,
    reactions: string[],
    threadId?: string
  ): Promise<PostedMessage>;

  /**
   * Update an existing post
   */
  updatePost(postId: string, message: string): Promise<void>;

  /**
   * Wait for a reaction on a post
   * Returns the reaction event or null on timeout
   */
  waitForReaction(
    postId: string,
    botUserId: string,
    timeoutMs: number
  ): Promise<ReactionEvent | null>;
}

/**
 * Configuration for permission API
 */
export interface PermissionApiConfig {
  url: string;
  token: string;
  channelId: string;
  threadId?: string;
  allowedUsers: string[];
  debug?: boolean;
}
