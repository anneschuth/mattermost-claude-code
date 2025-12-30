import {
  loadConfigWithMigration,
  configExists as checkConfigExists,
  type NewConfig,
  type PlatformInstanceConfig,
  type MattermostPlatformConfig,
  type WorktreeMode,
} from './config/migration.js';

// Re-export types
export type { NewConfig, PlatformInstanceConfig, MattermostPlatformConfig, WorktreeMode };

// Legacy Config format (for backward compatibility until Phase 4)
export interface Config {
  mattermost: {
    url: string;
    token: string;
    channelId: string;
    botName: string;
  };
  allowedUsers: string[];
  skipPermissions: boolean;
  chrome: boolean;
  worktreeMode: WorktreeMode;
}

/** CLI arguments that can override config (for backward compatibility) */
export interface CliArgs {
  url?: string;
  token?: string;
  channel?: string;
  botName?: string;
  allowedUsers?: string;
  skipPermissions?: boolean;
  chrome?: boolean;
  worktreeMode?: WorktreeMode;
}

/**
 * Load configuration with auto-migration from legacy .env format
 *
 * TEMPORARY: Returns legacy Config format for backward compatibility.
 * In Phase 4, this will be replaced with multi-platform aware code.
 *
 * Priority:
 * 1. New YAML config file (config.yaml)
 * 2. Legacy .env file (auto-migrated to YAML)
 * 3. CLI arguments (create temporary single-platform config)
 */
export function loadConfig(cliArgs?: CliArgs): Config {
  // Try to load from file (with auto-migration)
  let newConfig = loadConfigWithMigration();

  // If no config file exists, check if CLI args provide enough info
  if (!newConfig && cliArgs?.url && cliArgs?.token && cliArgs?.channel) {
    // Create temporary config from CLI args (backward compat)
    const platform: MattermostPlatformConfig = {
      id: 'cli-override',
      type: 'mattermost',
      displayName: 'Mattermost (CLI)',
      url: cliArgs.url.replace(/\/$/, ''), // Remove trailing slash
      token: cliArgs.token,
      channelId: cliArgs.channel,
      botName: cliArgs.botName || 'claude-code',
      allowedUsers: cliArgs.allowedUsers?.split(',').map(u => u.trim()).filter(u => u) || [],
      skipPermissions: cliArgs.skipPermissions ?? false,
    };

    newConfig = {
      version: 2,
      workingDir: process.cwd(),
      chrome: cliArgs.chrome ?? false,
      worktreeMode: cliArgs.worktreeMode ?? 'prompt',
      platforms: [platform],
    };
  }

  if (!newConfig) {
    throw new Error('No configuration found. Run with --setup to configure.');
  }

  // CLI args can override/replace the default platform (for testing/debugging)
  if (cliArgs?.url && cliArgs?.token && cliArgs?.channel) {
    const cliPlatform: MattermostPlatformConfig = {
      id: 'cli-override',
      type: 'mattermost',
      displayName: 'Mattermost (CLI Override)',
      url: cliArgs.url.replace(/\/$/, ''),
      token: cliArgs.token,
      channelId: cliArgs.channel,
      botName: cliArgs.botName || 'claude-code',
      allowedUsers: cliArgs.allowedUsers?.split(',').map(u => u.trim()).filter(u => u) || [],
      skipPermissions: cliArgs.skipPermissions ?? false,
    };

    // Replace 'default' platform or add as override
    const defaultIdx = newConfig.platforms.findIndex(p => p.id === 'default' || p.id === 'cli-override');
    if (defaultIdx >= 0) {
      newConfig.platforms[defaultIdx] = cliPlatform;
    } else {
      newConfig.platforms = [cliPlatform, ...newConfig.platforms];
    }
  }

  // CLI args can override global settings
  if (cliArgs?.chrome !== undefined) {
    newConfig.chrome = cliArgs.chrome;
  }
  if (cliArgs?.worktreeMode !== undefined) {
    newConfig.worktreeMode = cliArgs.worktreeMode;
  }

  // Convert to legacy format (use first platform)
  return convertToLegacyConfig(newConfig);
}

/**
 * Convert new multi-platform config to legacy single-platform format
 * TEMPORARY: Will be removed in Phase 4
 */
function convertToLegacyConfig(newConfig: NewConfig): Config {
  // Find first Mattermost platform
  const mattermostPlatform = newConfig.platforms.find(p => p.type === 'mattermost') as MattermostPlatformConfig;

  if (!mattermostPlatform) {
    throw new Error('No Mattermost platform configured. Legacy code only supports Mattermost.');
  }

  return {
    mattermost: {
      url: mattermostPlatform.url,
      token: mattermostPlatform.token,
      channelId: mattermostPlatform.channelId,
      botName: mattermostPlatform.botName,
    },
    allowedUsers: mattermostPlatform.allowedUsers,
    skipPermissions: mattermostPlatform.skipPermissions,
    chrome: newConfig.chrome,
    worktreeMode: newConfig.worktreeMode,
  };
}

/**
 * Check if any config exists (new YAML or legacy .env)
 */
export function configExists(): boolean {
  return checkConfigExists();
}
