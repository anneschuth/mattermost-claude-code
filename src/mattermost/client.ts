/**
 * Backward compatibility wrapper
 * Re-exports MattermostClient from new location with legacy Config support
 */
import { MattermostClient as PlatformMattermostClient } from '../platform/mattermost/client.js';
import type { Config } from '../config.js';

/**
 * Legacy MattermostClient wrapper
 * Converts old Config format to new MattermostPlatformConfig
 */
export class MattermostClient extends PlatformMattermostClient {
  constructor(config: Config) {
    // Convert legacy Config to MattermostPlatformConfig
    super({
      id: 'default',
      type: 'mattermost',
      displayName: 'Mattermost',
      url: config.mattermost.url,
      token: config.mattermost.token,
      channelId: config.mattermost.channelId,
      botName: config.mattermost.botName,
      allowedUsers: config.allowedUsers,
      skipPermissions: config.skipPermissions,
    });
  }
}

// Re-export types for backward compat
export type * from '../platform/mattermost/types.js';
