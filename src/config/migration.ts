import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { parse as parseEnv } from 'dotenv';
import YAML from 'yaml';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

// Legacy .env file paths (in order of priority)
const ENV_PATHS = [
  resolve(process.cwd(), '.env'),
  resolve(homedir(), '.config', 'claude-threads', '.env'),
  resolve(homedir(), '.claude-threads.env'),
];

// New YAML config path
export const CONFIG_PATH = resolve(homedir(), '.config', 'claude-threads', 'config.yaml');

// =============================================================================
// Types
// =============================================================================

interface LegacyEnvConfig {
  MATTERMOST_URL?: string;
  MATTERMOST_TOKEN?: string;
  MATTERMOST_CHANNEL_ID?: string;
  MATTERMOST_BOT_NAME?: string;
  ALLOWED_USERS?: string;
  SKIP_PERMISSIONS?: string;
  CLAUDE_CHROME?: string;
  WORKTREE_MODE?: string;
  DEFAULT_WORKING_DIR?: string;
}

export type WorktreeMode = 'off' | 'prompt' | 'require';

export interface NewConfig {
  version: number;
  workingDir: string;
  chrome: boolean;
  worktreeMode: WorktreeMode;
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
// Migration Logic
// =============================================================================

/**
 * Detect if legacy .env config exists
 */
function hasLegacyConfig(): { exists: boolean; path: string | null } {
  for (const envPath of ENV_PATHS) {
    if (existsSync(envPath)) {
      return { exists: true, path: envPath };
    }
  }
  return { exists: false, path: null };
}

/**
 * Convert legacy .env to new YAML config
 */
function migrateLegacyConfig(envPath: string): NewConfig {
  const content = readFileSync(envPath, 'utf-8');
  const env = parseEnv(content) as LegacyEnvConfig;

  // Convert to new format
  const config: NewConfig = {
    version: 2,
    workingDir: env.DEFAULT_WORKING_DIR || process.cwd(),
    chrome: env.CLAUDE_CHROME === 'true',
    worktreeMode: (env.WORKTREE_MODE as WorktreeMode) || 'prompt',
    platforms: [],
  };

  // Convert single Mattermost instance to platform config
  if (env.MATTERMOST_URL && env.MATTERMOST_TOKEN && env.MATTERMOST_CHANNEL_ID) {
    const platform: MattermostPlatformConfig = {
      id: 'default',
      type: 'mattermost',
      displayName: 'Mattermost',
      url: env.MATTERMOST_URL,
      token: env.MATTERMOST_TOKEN,
      channelId: env.MATTERMOST_CHANNEL_ID,
      botName: env.MATTERMOST_BOT_NAME || 'claude-code',
      allowedUsers: env.ALLOWED_USERS?.split(',').map(u => u.trim()).filter(u => u) || [],
      skipPermissions: env.SKIP_PERMISSIONS === 'true',
    };
    config.platforms.push(platform);
  }

  return config;
}

/**
 * Auto-migrate if needed and load config
 */
export function loadConfigWithMigration(): NewConfig | null {
  // Check if new config exists
  if (existsSync(CONFIG_PATH)) {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    return YAML.parse(content) as NewConfig;
  }

  // Check for legacy config
  const { exists, path } = hasLegacyConfig();
  if (exists && path) {
    console.log('');
    console.log('  🔄 Detected legacy .env config, migrating to new format...');

    const newConfig = migrateLegacyConfig(path);

    // Save new config
    const configDir = dirname(CONFIG_PATH);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    writeFileSync(CONFIG_PATH, YAML.stringify(newConfig), 'utf-8');

    // Backup old config
    const backupPath = path + '.backup';
    renameSync(path, backupPath);

    console.log(`  ✅ Migrated to ${CONFIG_PATH}`);
    console.log(`  📦 Backup saved: ${backupPath}`);
    console.log('');

    return newConfig;
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
  writeFileSync(CONFIG_PATH, YAML.stringify(config), 'utf-8');
}

/**
 * Check if any config exists (new or legacy)
 */
export function configExists(): boolean {
  return existsSync(CONFIG_PATH) || hasLegacyConfig().exists;
}
