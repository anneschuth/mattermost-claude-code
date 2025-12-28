#!/usr/bin/env node
import { program } from 'commander';
import { loadConfig, configExists, type CliArgs } from './config.js';
import { runOnboarding } from './onboarding.js';
import { MattermostClient } from './mattermost/client.js';
import { SessionManager } from './claude/session.js';
import type { MattermostPost, MattermostUser } from './mattermost/types.js';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

// Define CLI options
program
  .name('mm-claude')
  .version(pkg.version)
  .description('Share Claude Code sessions in Mattermost')
  .option('--url <url>', 'Mattermost server URL')
  .option('--token <token>', 'Mattermost bot token')
  .option('--channel <id>', 'Mattermost channel ID')
  .option('--bot-name <name>', 'Bot mention name (default: claude-code)')
  .option('--allowed-users <users>', 'Comma-separated allowed usernames')
  .option('--skip-permissions', 'Skip interactive permission prompts')
  .option('--no-skip-permissions', 'Enable interactive permission prompts (override env)')
  .option('--debug', 'Enable debug logging')
  .parse();

const opts = program.opts();

// Check if required args are provided via CLI
function hasRequiredCliArgs(args: typeof opts): boolean {
  return !!(args.url && args.token && args.channel);
}

async function main() {
  // Set debug mode from CLI flag
  if (opts.debug) {
    process.env.DEBUG = '1';
  }

  // Build CLI args object
  const cliArgs: CliArgs = {
    url: opts.url,
    token: opts.token,
    channel: opts.channel,
    botName: opts.botName,
    allowedUsers: opts.allowedUsers,
    skipPermissions: opts.skipPermissions,
  };

  // Check if we need onboarding
  if (!configExists() && !hasRequiredCliArgs(opts)) {
    await runOnboarding();
  }

  const workingDir = process.cwd();
  const config = loadConfig(cliArgs);

  // Nice startup banner
  console.log('');
  console.log(bold(`  🤖 mm-claude v${pkg.version}`));
  console.log(dim('  ─────────────────────────────────'));
  console.log(`  📂 ${cyan(workingDir)}`);
  console.log(`  💬 ${cyan('@' + config.mattermost.botName)}`);
  console.log(`  🌐 ${dim(config.mattermost.url)}`);
  if (config.skipPermissions) {
    console.log(`  ⚠️  ${dim('Permissions disabled')}`);
  } else {
    console.log(`  🔐 ${dim('Interactive permissions')}`);
  }
  console.log('');

  const mattermost = new MattermostClient(config);
  const session = new SessionManager(mattermost, workingDir, config.skipPermissions);

  mattermost.on('message', async (post: MattermostPost, user: MattermostUser | null) => {
    const username = user?.username || 'unknown';
    const message = post.message;
    const threadRoot = post.root_id || post.id;

    // Follow-up in active thread
    if (session.isInSessionThread(threadRoot)) {
      // If message starts with @mention to someone else, ignore it (side conversation)
      // Note: Mattermost usernames can contain letters, numbers, hyphens, periods, and underscores
      const mentionMatch = message.trim().match(/^@([\w.-]+)/);
      if (mentionMatch && mentionMatch[1].toLowerCase() !== mattermost.getBotName().toLowerCase()) {
        return; // Side conversation, don't interrupt
      }

      const content = mattermost.isBotMentioned(message)
        ? mattermost.extractPrompt(message)
        : message.trim();
      const lowerContent = content.toLowerCase();

      // Check for stop/cancel commands (only from allowed users)
      if (lowerContent === '/stop' || lowerContent === 'stop' ||
          lowerContent === '/cancel' || lowerContent === 'cancel') {
        if (session.isUserAllowedInSession(threadRoot, username)) {
          await session.cancelSession(threadRoot, username);
        }
        return;
      }

      // Check for /help command
      if (lowerContent === '/help' || lowerContent === 'help') {
        await mattermost.createPost(
          `**Available commands:**\n\n` +
          `| Command | Description |\n` +
          `|:--------|:------------|\n` +
          `| \`/help\` | Show this help message |\n` +
          `| \`/invite @user\` | Invite a user to this session |\n` +
          `| \`/kick @user\` | Remove an invited user |\n` +
          `| \`/permissions interactive\` | Enable interactive permissions |\n` +
          `| \`/stop\` | Stop this session |\n\n` +
          `**Reactions:**\n` +
          `- 👍 Approve action · ✅ Approve all · 👎 Deny\n` +
          `- ❌ or 🛑 on any message to stop session`,
          threadRoot
        );
        return;
      }

      // Check for /invite command
      const inviteMatch = content.match(/^\/invite\s+@?(\w+)/i);
      if (inviteMatch) {
        await session.inviteUser(threadRoot, inviteMatch[1], username);
        return;
      }

      // Check for /kick command
      const kickMatch = content.match(/^\/kick\s+@?(\w+)/i);
      if (kickMatch) {
        await session.kickUser(threadRoot, kickMatch[1], username);
        return;
      }

      // Check for /permissions command
      const permMatch = content.match(/^\/permissions?\s+(interactive|auto)/i);
      if (permMatch) {
        const mode = permMatch[1].toLowerCase();
        if (mode === 'interactive') {
          await session.enableInteractivePermissions(threadRoot, username);
        } else {
          // Can't upgrade to auto - that would be less secure
          await mattermost.createPost(
            `⚠️ Cannot upgrade to auto permissions - can only downgrade to interactive`,
            threadRoot
          );
        }
        return;
      }

      // Check if user is allowed in this session
      if (!session.isUserAllowedInSession(threadRoot, username)) {
        // Request approval for their message
        if (content) await session.requestMessageApproval(threadRoot, username, content);
        return;
      }

      if (content) await session.sendFollowUp(threadRoot, content);
      return;
    }

    // New session requires @mention
    if (!mattermost.isBotMentioned(message)) return;

    if (!mattermost.isUserAllowed(username)) {
      await mattermost.createPost(`⚠️ @${username} is not authorized`, threadRoot);
      return;
    }

    const prompt = mattermost.extractPrompt(message);
    if (!prompt) {
      await mattermost.createPost(`Mention me with your request`, threadRoot);
      return;
    }

    await session.startSession({ prompt }, username, threadRoot);
  });

  mattermost.on('connected', () => {});
  mattermost.on('error', (e) => console.error('  ❌ Error:', e));

  await mattermost.connect();
  console.log(`  ✅ ${bold('Ready!')} Waiting for @${config.mattermost.botName} mentions...`);
  console.log('');

  const shutdown = () => {
    console.log('');
    console.log(`  👋 ${dim('Shutting down...')}`);
    session.killAllSessions();
    mattermost.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => { console.error(e); process.exit(1); });
