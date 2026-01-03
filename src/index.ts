#!/usr/bin/env bun
import { program } from 'commander';
import { loadConfigWithMigration, configExists as checkConfigExists, type MattermostPlatformConfig } from './config/migration.js';
import type { CliArgs } from './config.js';
import { runOnboarding } from './onboarding.js';
import { MattermostClient } from './platform/mattermost/client.js';
import { SessionManager } from './session/index.js';
import type { PlatformPost, PlatformUser } from './platform/index.js';
import { checkForUpdates } from './update-notifier.js';
import { getReleaseNotes, formatReleaseNotes } from './changelog.js';
import { printLogo } from './logo.js';
import { VERSION } from './version.js';
import { keepAlive } from './utils/keep-alive.js';
import { dim, bold, cyan, yellow, red } from './utils/output.js';
import { validateClaudeCli } from './claude/version-check.js';

// Define CLI options
program
  .name('claude-threads')
  .version(VERSION)
  .description('Share Claude Code sessions in Mattermost')
  .option('--url <url>', 'Mattermost server URL')
  .option('--token <token>', 'Mattermost bot token')
  .option('--channel <id>', 'Mattermost channel ID')
  .option('--bot-name <name>', 'Bot mention name (default: claude-code)')
  .option('--allowed-users <users>', 'Comma-separated allowed usernames')
  .option('--skip-permissions', 'Skip interactive permission prompts')
  .option('--no-skip-permissions', 'Enable interactive permission prompts (override env)')
  .option('--chrome', 'Enable Claude in Chrome integration')
  .option('--no-chrome', 'Disable Claude in Chrome integration')
  .option('--worktree-mode <mode>', 'Git worktree mode: off, prompt, require (default: prompt)')
  .option('--keep-alive', 'Enable system sleep prevention (default: enabled)')
  .option('--no-keep-alive', 'Disable system sleep prevention')
  .option('--setup', 'Run interactive setup wizard (reconfigure existing settings)')
  .option('--debug', 'Enable debug logging')
  .option('--skip-version-check', 'Skip Claude CLI version compatibility check')
  .parse();

const opts = program.opts();

// Check if required args are provided via CLI
function hasRequiredCliArgs(args: typeof opts): boolean {
  return !!(args.url && args.token && args.channel);
}

async function main() {
  // Check for updates (non-blocking, shows notification if available)
  checkForUpdates();

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
    chrome: opts.chrome,
    worktreeMode: opts.worktreeMode,
    keepAlive: opts.keepAlive,
  };

  // Check if we need onboarding
  if (opts.setup) {
    await runOnboarding(true); // reconfigure mode
  } else if (!checkConfigExists() && !hasRequiredCliArgs(opts)) {
    await runOnboarding(false); // first-time mode
  }

  const workingDir = process.cwd();
  const newConfig = loadConfigWithMigration();

  if (!newConfig) {
    throw new Error('No configuration found. Run with --setup to configure.');
  }

  // CLI args can override global settings
  if (cliArgs.chrome !== undefined) {
    newConfig.chrome = cliArgs.chrome;
  }
  if (cliArgs.worktreeMode !== undefined) {
    newConfig.worktreeMode = cliArgs.worktreeMode;
  }
  if (cliArgs.keepAlive !== undefined) {
    newConfig.keepAlive = cliArgs.keepAlive;
  }

  // Apply keep-alive setting (default to true if not specified)
  const keepAliveEnabled = newConfig.keepAlive !== false;
  keepAlive.setEnabled(keepAliveEnabled);

  // Get first Mattermost platform
  const platformConfig = newConfig.platforms.find(p => p.type === 'mattermost') as MattermostPlatformConfig;
  if (!platformConfig) {
    throw new Error('No Mattermost platform configured.');
  }

  const config = newConfig;

  // Print ASCII logo
  printLogo();

  // Check Claude CLI version
  const claudeValidation = validateClaudeCli();

  // Startup info
  console.log(dim(`  v${VERSION}`));
  console.log('');
  console.log(`  📂 ${cyan(workingDir)}`);
  console.log(`  💬 ${cyan('@' + platformConfig.botName)}`);
  console.log(`  🌐 ${dim(platformConfig.url)}`);

  // Display Claude CLI version
  if (claudeValidation.installed) {
    if (claudeValidation.compatible) {
      console.log(`  🤖 ${dim(`Claude CLI ${claudeValidation.version}`)}`);
    } else {
      console.log(`  🤖 ${yellow(`Claude CLI ${claudeValidation.version} (incompatible)`)}`);
    }
  } else {
    console.log(`  🤖 ${red('Claude CLI not found')}`);
  }

  if (platformConfig.skipPermissions) {
    console.log(`  ⚠️ ${dim('Permissions disabled')}`);
  } else {
    console.log(`  🔐 ${dim('Interactive permissions')}`);
  }
  if (config.chrome) {
    console.log(`  🌐 ${dim('Chrome integration enabled')}`);
  }
  if (keepAliveEnabled) {
    console.log(`  ☕ ${dim('Keep-alive enabled')}`);
  }
  console.log('');

  // Fail on incompatible version unless --skip-version-check is set
  if (!claudeValidation.compatible && !opts.skipVersionCheck) {
    console.error(red(`  ❌ ${claudeValidation.message}`));
    console.error('');
    console.error(dim(`  Use --skip-version-check to bypass this check (not recommended)`));
    console.error('');
    process.exit(1);
  }

  const mattermost = new MattermostClient(platformConfig);
  const session = new SessionManager(workingDir, platformConfig.skipPermissions, config.chrome, config.worktreeMode);

  // Register platform (connects event handlers)
  session.addPlatform(platformConfig.id, mattermost);

  mattermost.on('message', async (post: PlatformPost, user: PlatformUser | null) => {
    try {
    const username = user?.username || 'unknown';
    const message = post.message;
    const threadRoot = post.rootId || post.id;

    // Check for !kill command FIRST - works anywhere, even as the first message
    const lowerMessage = message.trim().toLowerCase();
    if (lowerMessage === '!kill' || (mattermost.isBotMentioned(message) && mattermost.extractPrompt(message).toLowerCase() === '!kill')) {
      if (!mattermost.isUserAllowed(username)) {
        await mattermost.createPost('⛔ Only authorized users can use `!kill`', threadRoot);
        return;
      }
      // Notify all active sessions before killing
      for (const tid of session.getActiveThreadIds()) {
        try {
          await mattermost.createPost(`🔴 **EMERGENCY SHUTDOWN** by @${username}`, tid);
        } catch { /* ignore */ }
      }
      console.log(`  🔴 EMERGENCY SHUTDOWN initiated by @${username}`);
      session.killAllSessionsAndUnpersist();
      mattermost.disconnect();
      process.exit(1);
    }

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
      // Note: Using ! prefix instead of / to avoid Mattermost slash command interception
      if (lowerContent === '!stop' || lowerContent === 'stop' ||
          lowerContent === '!cancel' || lowerContent === 'cancel') {
        if (session.isUserAllowedInSession(threadRoot, username)) {
          await session.cancelSession(threadRoot, username);
        }
        return;
      }

      // Check for !escape/!interrupt commands (soft interrupt, keeps session alive)
      if (lowerContent === '!escape' || lowerContent === '!interrupt') {
        if (session.isUserAllowedInSession(threadRoot, username)) {
          await session.interruptSession(threadRoot, username);
        }
        return;
      }

      // Note: !kill is handled at the top level, before session thread check

      // Check for !help command
      if (lowerContent === '!help' || lowerContent === 'help') {
        await mattermost.createPost(
          `**Available commands:**\n\n` +
          `| Command | Description |\n` +
          `|:--------|:------------|\n` +
          `| \`!help\` | Show this help message |\n` +
          `| \`!release-notes\` | Show release notes for current version |\n` +
          `| \`!context\` | Show context usage (tokens used/remaining) |\n` +
          `| \`!cost\` | Show token usage and cost for this session |\n` +
          `| \`!compact\` | Compress context to free up space |\n` +
          `| \`!cd <path>\` | Change working directory (restarts Claude) |\n` +
          `| \`!worktree <branch>\` | Create and switch to a git worktree |\n` +
          `| \`!worktree list\` | List all worktrees for the repo |\n` +
          `| \`!worktree switch <branch>\` | Switch to an existing worktree |\n` +
          `| \`!worktree remove <branch>\` | Remove a worktree |\n` +
          `| \`!worktree off\` | Disable worktree prompts for this session |\n` +
          `| \`!invite @user\` | Invite a user to this session |\n` +
          `| \`!kick @user\` | Remove an invited user |\n` +
          `| \`!permissions interactive\` | Enable interactive permissions |\n` +
          `| \`!escape\` | Interrupt current task (session stays active) |\n` +
          `| \`!stop\` | Stop this session |\n` +
          `| \`!kill\` | Emergency shutdown (kills ALL sessions, exits bot) |\n\n` +
          `**Reactions:**\n` +
          `- 👍 Approve action · ✅ Approve all · 👎 Deny\n` +
          `- ⏸️ Interrupt current task (session stays active)\n` +
          `- ❌ or 🛑 Stop session`,
          threadRoot
        );
        return;
      }

      // Check for !release-notes command
      if (lowerContent === '!release-notes' || lowerContent === '!changelog') {
        const notes = getReleaseNotes(VERSION);
        if (notes) {
          await mattermost.createPost(formatReleaseNotes(notes), threadRoot);
        } else {
          await mattermost.createPost(
            `📋 **claude-threads v${VERSION}**\n\nRelease notes not available. See [GitHub releases](https://github.com/anneschuth/claude-threads/releases).`,
            threadRoot
          );
        }
        return;
      }

      // Check for !invite command
      const inviteMatch = content.match(/^!invite\s+@?([\w.-]+)/i);
      if (inviteMatch) {
        await session.inviteUser(threadRoot, inviteMatch[1], username);
        return;
      }

      // Check for !kick command
      const kickMatch = content.match(/^!kick\s+@?([\w.-]+)/i);
      if (kickMatch) {
        await session.kickUser(threadRoot, kickMatch[1], username);
        return;
      }

      // Check for !permissions command
      const permMatch = content.match(/^!permissions?\s+(interactive|auto)/i);
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

      // Check for !cd command
      const cdMatch = content.match(/^!cd\s+(.+)/i);
      if (cdMatch) {
        await session.changeDirectory(threadRoot, cdMatch[1].trim(), username);
        return;
      }

      // Check for !worktree command
      const worktreeMatch = content.match(/^!worktree\s+(\S+)(?:\s+(.*))?$/i);
      if (worktreeMatch) {
        const subcommand = worktreeMatch[1].toLowerCase();
        const args = worktreeMatch[2]?.trim();

        switch (subcommand) {
          case 'list':
            await session.listWorktreesCommand(threadRoot, username);
            break;
          case 'switch':
            if (!args) {
              await mattermost.createPost('❌ Usage: `!worktree switch <branch>`', threadRoot);
            } else {
              await session.switchToWorktree(threadRoot, args, username);
            }
            break;
          case 'remove':
            if (!args) {
              await mattermost.createPost('❌ Usage: `!worktree remove <branch>`', threadRoot);
            } else {
              await session.removeWorktreeCommand(threadRoot, args, username);
            }
            break;
          case 'off':
            await session.disableWorktreePrompt(threadRoot, username);
            break;
          default:
            // Treat as branch name: !worktree feature/foo
            await session.createAndSwitchToWorktree(threadRoot, subcommand, username);
        }
        return;
      }

      // Check for pending worktree prompt - treat message as branch name response
      if (session.hasPendingWorktreePrompt(threadRoot)) {
        // Only session owner can respond
        if (session.isUserAllowedInSession(threadRoot, username)) {
          const handled = await session.handleWorktreeBranchResponse(threadRoot, content, username, post.id);
          if (handled) return;
        }
      }

      // Check for Claude Code slash commands (translate ! to /)
      // These are sent directly to Claude Code as /commands
      if (lowerContent === '!context' || lowerContent === '!cost' || lowerContent === '!compact') {
        if (session.isUserAllowedInSession(threadRoot, username)) {
          // Translate !command to /command for Claude Code
          const claudeCommand = '/' + lowerContent.substring(1);
          await session.sendFollowUp(threadRoot, claudeCommand);
        }
        return;
      }

      // Check if user is allowed in this session
      if (!session.isUserAllowedInSession(threadRoot, username)) {
        // Request approval for their message
        if (content) await session.requestMessageApproval(threadRoot, username, content);
        return;
      }

      // Get any attached files (images)
      const files = post.metadata?.files;

      if (content || files?.length) await session.sendFollowUp(threadRoot, content, files);
      return;
    }

    // Check for paused session that can be resumed
    if (session.hasPausedSession(threadRoot)) {
      // If message starts with @mention to someone else, ignore it (side conversation)
      const mentionMatch = message.trim().match(/^@([\w.-]+)/);
      if (mentionMatch && mentionMatch[1].toLowerCase() !== mattermost.getBotName().toLowerCase()) {
        return; // Side conversation, don't interrupt
      }

      const content = mattermost.isBotMentioned(message)
        ? mattermost.extractPrompt(message)
        : message.trim();

      // Check if user is allowed in the paused session
      const persistedSession = session.getPersistedSession(threadRoot);
      if (persistedSession) {
        const allowedUsers = new Set(persistedSession.sessionAllowedUsers);
        if (!allowedUsers.has(username) && !mattermost.isUserAllowed(username)) {
          // Not allowed - could request approval but that would require the session to be active
          await mattermost.createPost(`⚠️ @${username} is not authorized to resume this session`, threadRoot);
          return;
        }
      }

      // Get any attached files (images)
      const files = post.metadata?.files;

      if (content || files?.length) {
        await session.resumePausedSession(threadRoot, content, files);
      }
      return;
    }

    // New session requires @mention
    if (!mattermost.isBotMentioned(message)) return;

    if (!mattermost.isUserAllowed(username)) {
      await mattermost.createPost(`⚠️ @${username} is not authorized`, threadRoot);
      return;
    }

    const prompt = mattermost.extractPrompt(message);
    const files = post.metadata?.files;

    if (!prompt && !files?.length) {
      await mattermost.createPost(`Mention me with your request`, threadRoot);
      return;
    }

    // Check for inline branch syntax: "on branch X" or "!worktree X"
    const branchMatch = prompt.match(/(?:on branch|!worktree)\s+(\S+)/i);
    if (branchMatch) {
      const branch = branchMatch[1];
      // Remove the branch specification from the prompt
      const cleanedPrompt = prompt.replace(/(?:on branch|!worktree)\s+\S+/i, '').trim();
      await session.startSessionWithWorktree({ prompt: cleanedPrompt || prompt, files }, branch, username, threadRoot, platformConfig.id, user?.displayName);
      return;
    }

    await session.startSession({ prompt, files }, username, threadRoot, platformConfig.id, user?.displayName);
    } catch (err) {
      console.error('  ❌ Error handling message:', err);
      // Try to notify user if possible
      try {
        const threadRoot = post.rootId || post.id;
        await mattermost.createPost(
          `⚠️ An error occurred. Please try again.`,
          threadRoot
        );
      } catch {
        // Ignore if we can't post the error message
      }
    }
  });

  mattermost.on('connected', () => {});
  mattermost.on('error', (e) => console.error('  ❌ Error:', e));

  await mattermost.connect();

  // Resume any persisted sessions from before restart
  await session.initialize();

  console.log(`  ✅ ${bold('Ready!')} Waiting for @${platformConfig.botName} mentions...`);
  console.log('');

  let isShuttingDown = false;
  const shutdown = async () => {
    // Guard against multiple shutdown calls (SIGINT + SIGTERM)
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('');
    console.log(`  👋 ${dim('Shutting down...')}`);

    // Set shutdown flag FIRST to prevent race conditions with exit events
    session.setShuttingDown();

    // Post shutdown message to active sessions
    const activeThreads = session.getActiveThreadIds();
    if (activeThreads.length > 0) {
      console.log(`  📤 Notifying ${activeThreads.length} active session(s)...`);
      for (const threadId of activeThreads) {
        try {
          await mattermost.createPost(
            `⏸️ **Bot shutting down** - session will resume on restart`,
            threadId
          );
        } catch {
          // Ignore errors, we're shutting down
        }
      }
    }

    session.killAllSessions();
    mattermost.disconnect();
    // Don't call process.exit() here - let the signal handler do it after we resolve
  };
  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
}

main().catch(e => { console.error(e); process.exit(1); });
