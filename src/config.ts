import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

// Load .env file from multiple locations (in order of priority)
const envPaths = [
  resolve(process.cwd(), '.env'),                          // Current directory
  resolve(homedir(), '.config', 'mm-claude', '.env'),      // ~/.config/mm-claude/.env
  resolve(homedir(), '.mm-claude.env'),                    // ~/.mm-claude.env
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    console.log(`📄 Loading config from: ${envPath}`);
    config({ path: envPath });
    break;
  }
}

export interface Config {
  mattermost: {
    url: string;
    token: string;
    channelId: string;
    botName: string;
  };
  allowedUsers: string[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    mattermost: {
      url: requireEnv('MATTERMOST_URL').replace(/\/$/, ''), // Remove trailing slash
      token: requireEnv('MATTERMOST_TOKEN'),
      channelId: requireEnv('MATTERMOST_CHANNEL_ID'),
      botName: process.env.MATTERMOST_BOT_NAME || 'claude-code',
    },
    allowedUsers: (process.env.ALLOWED_USERS || '')
      .split(',')
      .map(u => u.trim())
      .filter(u => u.length > 0),
  };
}
