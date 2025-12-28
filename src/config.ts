import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

let envLoaded = false;

// Paths to search for .env files (in order of priority)
const ENV_PATHS = [
  resolve(process.cwd(), '.env'),                          // Current directory
  resolve(homedir(), '.config', 'mm-claude', '.env'),      // ~/.config/mm-claude/.env
  resolve(homedir(), '.mm-claude.env'),                    // ~/.mm-claude.env
];

function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;

  for (const envPath of ENV_PATHS) {
    if (existsSync(envPath)) {
      if (process.env.DEBUG === '1' || process.argv.includes('--debug')) {
        console.log(`  [config] Loading from: ${envPath}`);
      }
      config({ path: envPath });
      break;
    }
  }
}

/** Check if any .env config file exists */
export function configExists(): boolean {
  return ENV_PATHS.some(p => existsSync(p));
}

export type WorktreeMode = 'off' | 'prompt' | 'require';

/** CLI arguments that can override config */
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

function getRequired(cliValue: string | undefined, envName: string, name: string): string {
  const value = cliValue || process.env[envName];
  if (!value) {
    throw new Error(`Missing required config: ${name}. Set ${envName} in .env or use --${name.toLowerCase().replace(/ /g, '-')} flag.`);
  }
  return value;
}

export function loadConfig(cliArgs?: CliArgs): Config {
  loadEnv();

  // CLI args take priority over env vars
  const url = getRequired(cliArgs?.url, 'MATTERMOST_URL', 'url');
  const token = getRequired(cliArgs?.token, 'MATTERMOST_TOKEN', 'token');
  const channelId = getRequired(cliArgs?.channel, 'MATTERMOST_CHANNEL_ID', 'channel');

  const botName = cliArgs?.botName || process.env.MATTERMOST_BOT_NAME || 'claude-code';

  const allowedUsersStr = cliArgs?.allowedUsers || process.env.ALLOWED_USERS || '';
  const allowedUsers = allowedUsersStr
    .split(',')
    .map(u => u.trim())
    .filter(u => u.length > 0);

  // CLI --skip-permissions or --no-skip-permissions takes priority
  // Then env SKIP_PERMISSIONS, then legacy flag
  let skipPermissions: boolean;
  if (cliArgs?.skipPermissions !== undefined) {
    // CLI explicitly set (--skip-permissions or --no-skip-permissions)
    skipPermissions = cliArgs.skipPermissions;
  } else {
    skipPermissions = process.env.SKIP_PERMISSIONS === 'true' ||
      process.argv.includes('--dangerously-skip-permissions');
  }

  // Chrome integration: CLI flag or env var
  let chrome: boolean;
  if (cliArgs?.chrome !== undefined) {
    chrome = cliArgs.chrome;
  } else {
    chrome = process.env.CLAUDE_CHROME === 'true';
  }

  // Worktree mode: CLI flag or env var, default to 'prompt'
  let worktreeMode: WorktreeMode;
  if (cliArgs?.worktreeMode !== undefined) {
    worktreeMode = cliArgs.worktreeMode;
  } else {
    const envValue = process.env.WORKTREE_MODE?.toLowerCase();
    if (envValue === 'off' || envValue === 'prompt' || envValue === 'require') {
      worktreeMode = envValue;
    } else {
      worktreeMode = 'prompt'; // Default
    }
  }

  return {
    mattermost: {
      url: url.replace(/\/$/, ''), // Remove trailing slash
      token,
      channelId,
      botName,
    },
    allowedUsers,
    skipPermissions,
    chrome,
    worktreeMode,
  };
}
