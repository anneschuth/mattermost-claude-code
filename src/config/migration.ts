import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

// YAML config path
export const CONFIG_PATH = resolve(homedir(), '.config', 'claude-threads', 'config.yaml');

// =============================================================================
// Types
// =============================================================================

export type WorktreeMode = 'off' | 'prompt' | 'require';

export interface NewConfig {
  version: number;
  workingDir: string;
  chrome: boolean;
  worktreeMode: WorktreeMode;
  keepAlive?: boolean; // Optional, defaults to true when undefined
  platforms: PlatformInstanceConfig[];
}

export interface PlatformInstanceConfig {
  id: string;
  type: 'mattermost' | 'slack';
  displayName: string;
  // Platform-specific fields (TypeScript allows extra properties)
  [key: string]: unknown;
}

export interface MattermostPlatformConfig extends PlatformInstanceConfig {
  type: 'mattermost';
  url: string;
  token: string;
  channelId: string;
  botName: string;
  allowedUsers: string[];
  skipPermissions: boolean;
}

export interface SlackPlatformConfig extends PlatformInstanceConfig {
  type: 'slack';
  botToken: string;
  appToken: string;
  channelId: string;
  botName: string;
  allowedUsers: string[];
  skipPermissions: boolean;
}

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Load config from YAML file
 */
export function loadConfigWithMigration(): NewConfig | null {
  if (existsSync(CONFIG_PATH)) {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    return Bun.YAML.parse(content) as NewConfig;
  }
  return null; // No config found
}

/**
 * Save config to YAML file
 */
export function saveConfig(config: NewConfig): void {
  const configDir = dirname(CONFIG_PATH);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, Bun.YAML.stringify(config), 'utf-8');
}

/**
 * Check if config exists
 */
export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}
