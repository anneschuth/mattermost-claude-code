/**
 * Platform abstraction layer
 *
 * This module provides platform-agnostic interfaces and types that allow
 * claude-threads to work with multiple chat platforms (Mattermost, Slack, etc.)
 * without coupling the core logic to any specific platform.
 */

// Core interfaces
export type { PlatformClient, PlatformClientEvents } from './client.js';
export type { PlatformFormatter } from './formatter.js';
export type {
  McpPlatformApi,
  MattermostMcpApiConfig,
  SlackMcpApiConfig,
  ReactionEvent,
  PostedMessage,
  McpPost,
} from './mcp-platform-api.js';

// Normalized types
export type {
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
  ThreadMessage,
  PostMetadata,
  PostWriteOptions,
} from './types.js';

// Platform implementations
export { BasePlatformClient } from './base-client.js';
export { MattermostClient } from './mattermost/client.js';
export { SlackClient } from './slack/client.js';

// MCP platform API factory
export { createMcpPlatformApi } from './mcp-platform-api-factory.js';
