import prompts from 'prompts';
import { existsSync, readFileSync } from 'fs';
import {
  CONFIG_PATH,
  saveConfig,
  type NewConfig,
  type PlatformInstanceConfig,
  type MattermostPlatformConfig,
  type SlackPlatformConfig,
} from './config/migration.js';
import { bold, dim, green } from './utils/output.js';

const onCancel = () => {
  console.log('');
  console.log(dim('  Setup cancelled.'));
  process.exit(0);
};

export async function runOnboarding(reconfigure = false): Promise<void> {
  console.log('');
  console.log(bold('  claude-threads setup'));
  console.log(dim('  ─────────────────────────────────'));
  console.log('');

  // Load existing config if reconfiguring
  let existingConfig: NewConfig | null = null;
  if (reconfigure && existsSync(CONFIG_PATH)) {
    try {
      const content = readFileSync(CONFIG_PATH, 'utf-8');
      existingConfig = Bun.YAML.parse(content) as NewConfig;
      console.log(dim('  Reconfiguring existing setup.'));
    } catch {
      console.log(dim('  Could not load existing config, starting fresh.'));
    }
  } else {
    console.log('  Welcome! Let\'s configure claude-threads.');
  }
  console.log('');

  // Step 1: Global settings
  const globalSettings = await prompts([
    {
      type: 'text',
      name: 'workingDir',
      message: 'Default working directory',
      initial: existingConfig?.workingDir || process.cwd(),
      hint: 'Where Claude Code runs by default',
    },
    {
      type: 'confirm',
      name: 'chrome',
      message: 'Enable Chrome integration?',
      initial: existingConfig?.chrome || false,
      hint: 'Requires Claude in Chrome extension',
    },
    {
      type: 'select',
      name: 'worktreeMode',
      message: 'Git worktree mode',
      choices: [
        { title: 'Prompt', value: 'prompt', description: 'Ask when starting sessions' },
        { title: 'Off', value: 'off', description: 'Never use worktrees' },
        { title: 'Require', value: 'require', description: 'Always require branch name' },
      ],
      initial: existingConfig?.worktreeMode === 'off' ? 1 :
               existingConfig?.worktreeMode === 'require' ? 2 : 0,
    },
  ], { onCancel });

  const config: NewConfig = {
    version: 2,
    ...globalSettings,
    platforms: [],
  };

  // Step 2: Add platforms (loop)
  console.log('');
  console.log(dim('  Now let\'s add your platform connections.'));
  console.log('');

  let platformNumber = 1;
  let addMore = true;

  while (addMore) {
    const isFirst = platformNumber === 1;
    const existingPlatform = existingConfig?.platforms[platformNumber - 1];

    // Ask what platform type
    const { platformType } = await prompts({
      type: 'select',
      name: 'platformType',
      message: isFirst ? 'First platform' : `Platform #${platformNumber}`,
      choices: [
        { title: 'Mattermost', value: 'mattermost' },
        { title: 'Slack', value: 'slack' },
        ...(isFirst ? [] : [{ title: '(Done - finish setup)', value: 'done' }]),
      ],
      initial: existingPlatform?.type === 'slack' ? 1 : 0,
    }, { onCancel });

    if (platformType === 'done') {
      addMore = false;
      break;
    }

    // Get platform ID and name
    const { platformId, displayName } = await prompts([
      {
        type: 'text',
        name: 'platformId',
        message: 'Platform ID',
        initial: existingPlatform?.id ||
                 (config.platforms.length === 0 ? 'default' : `${platformType}-${platformNumber}`),
        hint: 'Unique identifier (e.g., mattermost-main, slack-eng)',
        validate: (v: string) => {
          if (!v.match(/^[a-z0-9-]+$/)) return 'Use lowercase letters, numbers, hyphens only';
          if (config.platforms.some(p => p.id === v)) return 'ID already in use';
          return true;
        },
      },
      {
        type: 'text',
        name: 'displayName',
        message: 'Display name',
        initial: existingPlatform?.displayName ||
                 (platformType === 'mattermost' ? 'Mattermost' : 'Slack'),
        hint: 'Human-readable name (e.g., "Internal Team", "Engineering")',
      },
    ], { onCancel });

    // Configure the platform
    if (platformType === 'mattermost') {
      const platform = await setupMattermostPlatform(platformId, displayName, existingPlatform);
      config.platforms.push(platform);
    } else {
      const platform = await setupSlackPlatform(platformId, displayName, existingPlatform);
      config.platforms.push(platform);
    }

    console.log(green(`  ✓ Added ${displayName}`));
    console.log('');

    // Ask to add more (after first one)
    if (platformNumber === 1) {
      const { addAnother } = await prompts({
        type: 'confirm',
        name: 'addAnother',
        message: 'Add another platform?',
        initial: (existingConfig?.platforms.length || 0) > 1,
      }, { onCancel });

      addMore = addAnother;
    }

    platformNumber++;
  }

  // Validate at least one platform
  if (config.platforms.length === 0) {
    console.log('');
    console.log(dim('  ⚠️  No platforms configured. Setup cancelled.'));
    process.exit(1);
  }

  // Save config
  saveConfig(config);

  console.log('');
  console.log(green('  ✓ Configuration saved!'));
  console.log(dim(`    ${CONFIG_PATH}`));
  console.log('');
  console.log(dim(`  Configured ${config.platforms.length} platform(s):`));
  for (const platform of config.platforms) {
    console.log(dim(`    • ${platform.displayName} (${platform.type})`));
  }
  console.log('');
  console.log(dim('  Starting claude-threads...'));
  console.log('');
}

async function setupMattermostPlatform(
  id: string,
  displayName: string,
  existing?: PlatformInstanceConfig
): Promise<MattermostPlatformConfig> {
  console.log('');
  console.log(dim('  Mattermost setup:'));
  console.log('');

  const existingMattermost = existing?.type === 'mattermost' ? existing as MattermostPlatformConfig : undefined;

  const response = await prompts([
    {
      type: 'text',
      name: 'url',
      message: 'Server URL',
      initial: existingMattermost?.url || 'https://chat.example.com',
      validate: (v: string) => v.startsWith('http') ? true : 'Must start with http(s)://',
    },
    {
      type: 'password',
      name: 'token',
      message: 'Bot token',
      initial: existingMattermost?.token,
      hint: existingMattermost?.token ? 'Enter to keep existing, or type new token' : 'Create at: Integrations > Bot Accounts',
      validate: (v: string) => {
        // Allow empty if we have existing token
        if (!v && existingMattermost?.token) return true;
        return v.length > 0 ? true : 'Token is required';
      },
    },
    {
      type: 'text',
      name: 'channelId',
      message: 'Channel ID',
      initial: existingMattermost?.channelId || '',
      hint: 'Click channel > View Info > copy ID from URL',
      validate: (v: string) => v.length > 0 ? true : 'Channel ID is required',
    },
    {
      type: 'text',
      name: 'botName',
      message: 'Bot mention name',
      initial: existingMattermost?.botName || 'claude-code',
      hint: 'Users will @mention this name',
    },
    {
      type: 'text',
      name: 'allowedUsers',
      message: 'Allowed usernames (optional)',
      initial: existingMattermost?.allowedUsers?.join(',') || '',
      hint: 'Comma-separated, or empty to allow everyone',
    },
    {
      type: 'confirm',
      name: 'skipPermissions',
      message: 'Auto-approve all actions?',
      initial: existingMattermost?.skipPermissions || false,
      hint: 'If no, you\'ll approve via emoji reactions',
    },
  ], { onCancel });

  // Use existing token if user left it empty
  const finalToken = response.token || existingMattermost?.token;
  if (!finalToken) {
    console.log('');
    console.log(dim('  ⚠️  Token is required. Setup cancelled.'));
    process.exit(1);
  }

  return {
    id,
    type: 'mattermost',
    displayName,
    url: response.url,
    token: finalToken,
    channelId: response.channelId,
    botName: response.botName,
    allowedUsers: response.allowedUsers?.split(',').map((u: string) => u.trim()).filter((u: string) => u) || [],
    skipPermissions: response.skipPermissions,
  };
}

async function setupSlackPlatform(
  id: string,
  displayName: string,
  existing?: PlatformInstanceConfig
): Promise<SlackPlatformConfig> {
  console.log('');
  console.log(dim('  Slack setup (requires Socket Mode):'));
  console.log(dim('  Create app at: api.slack.com/apps'));
  console.log('');

  const existingSlack = existing?.type === 'slack' ? existing as SlackPlatformConfig : undefined;

  const response = await prompts([
    {
      type: 'password',
      name: 'botToken',
      message: 'Bot User OAuth Token',
      initial: existingSlack?.botToken,
      hint: existingSlack?.botToken ? 'Enter to keep existing' : 'Starts with xoxb-',
      validate: (v: string) => {
        if (!v && existingSlack?.botToken) return true;
        return v.startsWith('xoxb-') ? true : 'Must start with xoxb-';
      },
    },
    {
      type: 'password',
      name: 'appToken',
      message: 'App-Level Token',
      initial: existingSlack?.appToken,
      hint: existingSlack?.appToken ? 'Enter to keep existing' : 'Starts with xapp- (enable Socket Mode first)',
      validate: (v: string) => {
        if (!v && existingSlack?.appToken) return true;
        return v.startsWith('xapp-') ? true : 'Must start with xapp-';
      },
    },
    {
      type: 'text',
      name: 'channelId',
      message: 'Channel ID',
      initial: existingSlack?.channelId || '',
      hint: 'Right-click channel > View details > copy ID',
      validate: (v: string) => v.length > 0 ? true : 'Channel ID is required',
    },
    {
      type: 'text',
      name: 'botName',
      message: 'Bot mention name',
      initial: existingSlack?.botName || 'claude',
      hint: 'Users will @mention this name',
    },
    {
      type: 'text',
      name: 'allowedUsers',
      message: 'Allowed usernames (optional)',
      initial: existingSlack?.allowedUsers?.join(',') || '',
      hint: 'Comma-separated, or empty for everyone',
    },
    {
      type: 'confirm',
      name: 'skipPermissions',
      message: 'Auto-approve all actions?',
      initial: existingSlack?.skipPermissions || false,
      hint: 'If no, you\'ll approve via emoji reactions',
    },
  ], { onCancel });

  // Use existing tokens if user left them empty
  const finalBotToken = response.botToken || existingSlack?.botToken;
  const finalAppToken = response.appToken || existingSlack?.appToken;

  if (!finalBotToken || !finalAppToken) {
    console.log('');
    console.log(dim('  ⚠️  Both tokens are required. Setup cancelled.'));
    process.exit(1);
  }

  return {
    id,
    type: 'slack',
    displayName,
    botToken: finalBotToken,
    appToken: finalAppToken,
    channelId: response.channelId,
    botName: response.botName,
    allowedUsers: response.allowedUsers?.split(',').map((u: string) => u.trim()).filter((u: string) => u) || [],
    skipPermissions: response.skipPermissions,
  };
}
