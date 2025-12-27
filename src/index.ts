#!/usr/bin/env node
import { loadConfig } from './config.js';
import { MattermostClient } from './mattermost/client.js';
import { SessionManager } from './claude/session.js';
import type { MattermostPost, MattermostUser } from './mattermost/types.js';

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`mm-claude - Share Claude Code sessions in Mattermost

Usage: cd /your/project && mm-claude`);
    process.exit(0);
  }

  const workingDir = process.cwd();
  const config = loadConfig();

  console.log(`🚀 mm-claude starting...`);
  console.log(`📂 ${workingDir}`);
  console.log(`📝 @${config.mattermost.botName} on ${config.mattermost.url}`);

  const mattermost = new MattermostClient(config);
  const session = new SessionManager(mattermost, workingDir);

  mattermost.on('message', async (post: MattermostPost, user: MattermostUser | null) => {
    const username = user?.username || 'unknown';
    const message = post.message;
    const threadRoot = post.root_id || post.id;

    // Follow-up in active thread
    if (session.isInCurrentSessionThread(threadRoot)) {
      if (!mattermost.isUserAllowed(username)) return;
      const content = mattermost.isBotMentioned(message)
        ? mattermost.extractPrompt(message)
        : message.trim();
      if (content) await session.sendFollowUp(content);
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

  mattermost.on('connected', () => console.log('✅ Connected'));
  mattermost.on('error', (e) => console.error('❌', e));

  await mattermost.connect();
  console.log(`🎉 Ready! @${config.mattermost.botName}`);

  const shutdown = () => {
    console.log('\n👋 Bye');
    session.killSession();
    mattermost.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => { console.error(e); process.exit(1); });
