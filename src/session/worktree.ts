/**
 * Git worktree management utilities
 *
 * Handles worktree prompts, creation, switching, and cleanup.
 */

import type { Session } from './types.js';
import type { WorktreeMode } from '../config.js';
import {
  isGitRepository,
  getRepositoryRoot,
  hasUncommittedChanges,
  listWorktrees as listGitWorktrees,
  createWorktree as createGitWorktree,
  removeWorktree as removeGitWorktree,
  getWorktreeDir,
  findWorktreeByBranch,
  isValidBranchName,
} from '../git/worktree.js';
import type { ClaudeCliOptions, ClaudeEvent } from '../claude/cli.js';
import { ClaudeCli } from '../claude/cli.js';
import { randomUUID } from 'crypto';

/**
 * Check if we should prompt the user to create a worktree.
 * Returns the reason for prompting, or null if we shouldn't prompt.
 */
export async function shouldPromptForWorktree(
  session: Session,
  worktreeMode: WorktreeMode,
  hasOtherSessionInRepo: (repoRoot: string, excludeThreadId: string) => boolean
): Promise<string | null> {
  // Skip if worktree mode is off
  if (worktreeMode === 'off') return null;

  // Skip if user disabled prompts for this session
  if (session.worktreePromptDisabled) return null;

  // Skip if already in a worktree
  if (session.worktreeInfo) return null;

  // Check if we're in a git repository
  const isRepo = await isGitRepository(session.workingDir);
  if (!isRepo) return null;

  // For 'require' mode, always prompt
  if (worktreeMode === 'require') {
    return 'require';
  }

  // For 'prompt' mode, check conditions
  // Condition 1: uncommitted changes
  const hasChanges = await hasUncommittedChanges(session.workingDir);
  if (hasChanges) return 'uncommitted';

  // Condition 2: another session using the same repo
  const repoRoot = await getRepositoryRoot(session.workingDir);
  const hasConcurrent = hasOtherSessionInRepo(repoRoot, session.threadId);
  if (hasConcurrent) return 'concurrent';

  return null;
}

/**
 * Post the worktree prompt message to the user.
 */
export async function postWorktreePrompt(
  session: Session,
  reason: string,
  registerPost: (postId: string, threadId: string) => void
): Promise<void> {
  let message: string;
  switch (reason) {
    case 'uncommitted':
      message = `🌿 **This repo has uncommitted changes.**\n` +
        `Reply with a branch name to work in an isolated worktree, or react with ❌ to continue in the main repo.`;
      break;
    case 'concurrent':
      message = `⚠️ **Another session is already using this repo.**\n` +
        `Reply with a branch name to work in an isolated worktree, or react with ❌ to continue anyway.`;
      break;
    case 'require':
      message = `🌿 **This deployment requires working in a worktree.**\n` +
        `Please reply with a branch name to continue.`;
      break;
    default:
      message = `🌿 **Would you like to work in an isolated worktree?**\n` +
        `Reply with a branch name, or react with ❌ to continue in the main repo.`;
  }

  // Create post with ❌ reaction option (except for 'require' mode)
  // Use 'x' emoji name, not Unicode ❌ character
  const reactionOptions = reason === 'require' ? [] : ['x'];
  const post = await session.platform.createInteractivePost(
    message,
    reactionOptions,
    session.threadId
  );

  // Track the post for reaction handling
  session.worktreePromptPostId = post.id;
  registerPost(post.id, session.threadId);
}

/**
 * Handle user providing a branch name in response to worktree prompt.
 * Returns true if handled (whether successful or not).
 */
export async function handleWorktreeBranchResponse(
  session: Session,
  branchName: string,
  username: string,
  createAndSwitch: (threadId: string, branch: string, username: string) => Promise<void>
): Promise<boolean> {
  if (!session.pendingWorktreePrompt) return false;

  // Only session owner can respond
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    return false;
  }

  // Validate branch name
  if (!isValidBranchName(branchName)) {
    await session.platform.createPost(
      `❌ Invalid branch name: \`${branchName}\`. Please provide a valid git branch name.`,
      session.threadId
    );
    return true; // We handled it, but need another response
  }

  // Create and switch to worktree
  await createAndSwitch(session.threadId, branchName, username);
  return true;
}

/**
 * Handle ❌ reaction on worktree prompt - skip worktree and continue in main repo.
 */
export async function handleWorktreeSkip(
  session: Session,
  username: string,
  persistSession: (session: Session) => void,
  startTyping: (session: Session) => void
): Promise<void> {
  if (!session.pendingWorktreePrompt) return;

  // Only session owner can skip
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    return;
  }

  // Update the prompt post
  if (session.worktreePromptPostId) {
    try {
      await session.platform.updatePost(session.worktreePromptPostId,
        `✅ Continuing in main repo (skipped by @${username})`);
    } catch (err) {
      console.error('  ⚠️ Failed to update worktree prompt:', err);
    }
  }

  // Clear pending state
  session.pendingWorktreePrompt = false;
  session.worktreePromptPostId = undefined;
  const queuedPrompt = session.queuedPrompt;
  session.queuedPrompt = undefined;

  // Persist updated state
  persistSession(session);

  // Now send the queued message to Claude
  if (queuedPrompt && session.claude.isRunning()) {
    session.claude.sendMessage(queuedPrompt);
    startTyping(session);
  }
}

/**
 * Create a new worktree and switch the session to it.
 */
export async function createAndSwitchToWorktree(
  session: Session,
  branch: string,
  username: string,
  options: {
    skipPermissions: boolean;
    chromeEnabled: boolean;
    handleEvent: (sessionId: string, event: ClaudeEvent) => void;
    handleExit: (sessionId: string, code: number) => Promise<void>;
    updateSessionHeader: (session: Session) => Promise<void>;
    flush: (session: Session) => Promise<void>;
    persistSession: (session: Session) => void;
    startTyping: (session: Session) => void;
    stopTyping: (session: Session) => void;
  }
): Promise<void> {
  // Only session owner or admins can manage worktrees
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await session.platform.createPost(
      `⚠️ Only @${session.startedBy} or allowed users can manage worktrees`,
      session.threadId
    );
    return;
  }

  // Check if we're in a git repo
  const isRepo = await isGitRepository(session.workingDir);
  if (!isRepo) {
    await session.platform.createPost(
      `❌ Current directory is not a git repository`,
      session.threadId
    );
    return;
  }

  // Get repo root
  const repoRoot = await getRepositoryRoot(session.workingDir);

  // Check if worktree already exists for this branch
  const existing = await findWorktreeByBranch(repoRoot, branch);
  if (existing && !existing.isMain) {
    await session.platform.createPost(
      `⚠️ Worktree for branch \`${branch}\` already exists at \`${existing.path}\`. Use \`!worktree switch ${branch}\` to switch to it.`,
      session.threadId
    );
    return;
  }

  const shortId = session.threadId.substring(0, 8);
  console.log(`  🌿 Session (${shortId}…) creating worktree for branch ${branch}`);

  // Generate worktree path
  const worktreePath = getWorktreeDir(repoRoot, branch);

  try {
    // Create the worktree
    await createGitWorktree(repoRoot, branch, worktreePath);

    // Update the prompt post if it exists
    if (session.worktreePromptPostId) {
      try {
        await session.platform.updatePost(session.worktreePromptPostId,
          `✅ Created worktree for \`${branch}\``);
      } catch (err) {
        console.error('  ⚠️ Failed to update worktree prompt:', err);
      }
    }

    // Clear pending state
    const wasPending = session.pendingWorktreePrompt;
    session.pendingWorktreePrompt = false;
    session.worktreePromptPostId = undefined;
    const queuedPrompt = session.queuedPrompt;
    session.queuedPrompt = undefined;

    // Store worktree info
    session.worktreeInfo = {
      repoRoot,
      worktreePath,
      branch,
    };

    // Update working directory
    session.workingDir = worktreePath;

    // If Claude is already running, restart it in the new directory
    if (session.claude.isRunning()) {
      options.stopTyping(session);
      session.isRestarting = true;
      session.claude.kill();

      // Flush any pending content
      await options.flush(session);
      session.currentPostId = null;
      session.pendingContent = '';

      // Generate new session ID for fresh start in new directory
      // (Claude CLI sessions are tied to working directory, can't resume across directories)
      const newSessionId = randomUUID();
      session.claudeSessionId = newSessionId;

      // Create new CLI with new working directory
      const cliOptions: ClaudeCliOptions = {
        workingDir: worktreePath,
        threadId: session.threadId,
        skipPermissions: options.skipPermissions || !session.forceInteractivePermissions,
        sessionId: newSessionId,
        resume: false,  // Fresh start - can't resume across directories
        chrome: options.chromeEnabled,
        platformConfig: session.platform.getMcpConfig(),
      };
      session.claude = new ClaudeCli(cliOptions);

      // Rebind event handlers (use sessionId which is the composite key)
      session.claude.on('event', (e: ClaudeEvent) => options.handleEvent(session.sessionId, e));
      session.claude.on('exit', (code: number) => options.handleExit(session.sessionId, code));

      // Start the new CLI
      session.claude.start();
    }

    // Update session header
    await options.updateSessionHeader(session);

    // Post confirmation
    const shortWorktreePath = worktreePath.replace(process.env.HOME || '', '~');
    await session.platform.createPost(
      `✅ **Created worktree** for branch \`${branch}\`\n📁 Working directory: \`${shortWorktreePath}\`\n*Claude Code restarted in the new worktree*`,
      session.threadId
    );

    // Update activity and persist
    session.lastActivityAt = new Date();
    session.timeoutWarningPosted = false;
    options.persistSession(session);

    // If there was a queued prompt (from initial session start), send it now
    if (wasPending && queuedPrompt && session.claude.isRunning()) {
      session.claude.sendMessage(queuedPrompt);
      options.startTyping(session);
    }

    console.log(`  🌿 Session (${shortId}…) switched to worktree ${branch} at ${shortWorktreePath}`);
  } catch (err) {
    console.error(`  ❌ Failed to create worktree:`, err);
    await session.platform.createPost(
      `❌ Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
      session.threadId
    );
  }
}

/**
 * Switch to an existing worktree.
 */
export async function switchToWorktree(
  session: Session,
  branchOrPath: string,
  username: string,
  changeDirectory: (threadId: string, newDir: string, username: string) => Promise<void>
): Promise<void> {
  // Only session owner or admins can manage worktrees
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await session.platform.createPost(
      `⚠️ Only @${session.startedBy} or allowed users can manage worktrees`,
      session.threadId
    );
    return;
  }

  // Get current repo root
  const repoRoot = session.worktreeInfo?.repoRoot || await getRepositoryRoot(session.workingDir);

  // Find the worktree
  const worktrees = await listGitWorktrees(repoRoot);
  const target = worktrees.find(wt =>
    wt.branch === branchOrPath ||
    wt.path === branchOrPath ||
    wt.path.endsWith(branchOrPath)
  );

  if (!target) {
    await session.platform.createPost(
      `❌ Worktree not found: \`${branchOrPath}\`. Use \`!worktree list\` to see available worktrees.`,
      session.threadId
    );
    return;
  }

  // Use changeDirectory logic to switch
  await changeDirectory(session.threadId, target.path, username);

  // Update worktree info
  session.worktreeInfo = {
    repoRoot,
    worktreePath: target.path,
    branch: target.branch,
  };
}

/**
 * List all worktrees for the current repository.
 */
export async function listWorktreesCommand(session: Session): Promise<void> {
  // Check if we're in a git repo
  const isRepo = await isGitRepository(session.workingDir);
  if (!isRepo) {
    await session.platform.createPost(
      `❌ Current directory is not a git repository`,
      session.threadId
    );
    return;
  }

  // Get repo root (either from worktree info or current dir)
  const repoRoot = session.worktreeInfo?.repoRoot || await getRepositoryRoot(session.workingDir);
  const worktrees = await listGitWorktrees(repoRoot);

  if (worktrees.length === 0) {
    await session.platform.createPost(
      `📋 No worktrees found for this repository`,
      session.threadId
    );
    return;
  }

  const shortRepoRoot = repoRoot.replace(process.env.HOME || '', '~');
  let message = `📋 **Worktrees for** \`${shortRepoRoot}\`:\n\n`;

  for (const wt of worktrees) {
    const shortPath = wt.path.replace(process.env.HOME || '', '~');
    const isCurrent = session.workingDir === wt.path;
    const marker = isCurrent ? ' ← current' : '';
    const label = wt.isMain ? '(main repository)' : '';
    message += `• \`${wt.branch}\` → \`${shortPath}\` ${label}${marker}\n`;
  }

  await session.platform.createPost(message, session.threadId);
}

/**
 * Remove a worktree.
 */
export async function removeWorktreeCommand(
  session: Session,
  branchOrPath: string,
  username: string
): Promise<void> {
  // Only session owner or admins can manage worktrees
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await session.platform.createPost(
      `⚠️ Only @${session.startedBy} or allowed users can manage worktrees`,
      session.threadId
    );
    return;
  }

  // Get current repo root
  const repoRoot = session.worktreeInfo?.repoRoot || await getRepositoryRoot(session.workingDir);

  // Find the worktree
  const worktrees = await listGitWorktrees(repoRoot);
  const target = worktrees.find(wt =>
    wt.branch === branchOrPath ||
    wt.path === branchOrPath ||
    wt.path.endsWith(branchOrPath)
  );

  if (!target) {
    await session.platform.createPost(
      `❌ Worktree not found: \`${branchOrPath}\`. Use \`!worktree list\` to see available worktrees.`,
      session.threadId
    );
    return;
  }

  // Can't remove the main repository
  if (target.isMain) {
    await session.platform.createPost(
      `❌ Cannot remove the main repository. Use \`!worktree remove\` only for worktrees.`,
      session.threadId
    );
    return;
  }

  // Can't remove the current working directory
  if (session.workingDir === target.path) {
    await session.platform.createPost(
      `❌ Cannot remove the current working directory. Switch to another worktree first.`,
      session.threadId
    );
    return;
  }

  try {
    await removeGitWorktree(repoRoot, target.path);

    const shortPath = target.path.replace(process.env.HOME || '', '~');
    await session.platform.createPost(
      `✅ Removed worktree \`${target.branch}\` at \`${shortPath}\``,
      session.threadId
    );

    console.log(`  🗑️ Removed worktree ${target.branch} at ${shortPath}`);
  } catch (err) {
    console.error(`  ❌ Failed to remove worktree:`, err);
    await session.platform.createPost(
      `❌ Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`,
      session.threadId
    );
  }
}

/**
 * Disable worktree prompts for a session.
 */
export async function disableWorktreePrompt(
  session: Session,
  username: string,
  persistSession: (session: Session) => void
): Promise<void> {
  // Only session owner or admins can manage worktrees
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    await session.platform.createPost(
      `⚠️ Only @${session.startedBy} or allowed users can manage worktrees`,
      session.threadId
    );
    return;
  }

  session.worktreePromptDisabled = true;
  persistSession(session);

  await session.platform.createPost(
    `✅ Worktree prompts disabled for this session`,
    session.threadId
  );
}
