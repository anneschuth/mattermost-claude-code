/**
 * User reaction handling module
 *
 * Handles emoji reactions on posts: plan approval, question answers,
 * message approval, cancel/escape actions.
 */

import type { Session } from './types.js';
import type { SessionContext } from './context.js';
import {
  isApprovalEmoji,
  isDenialEmoji,
  isAllowAllEmoji,
  getNumberEmojiIndex,
  TASK_TOGGLE_EMOJIS,
} from '../utils/emoji.js';
import { postCurrentQuestion } from './events.js';
import { withErrorHandling } from './error-handler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('reactions');

// ---------------------------------------------------------------------------
// Question reaction handling
// ---------------------------------------------------------------------------

/**
 * Handle a reaction on a question post (number emoji to select an option).
 */
export async function handleQuestionReaction(
  session: Session,
  postId: string,
  emojiName: string,
  username: string,
  ctx: SessionContext
): Promise<void> {
  if (!session.pendingQuestionSet) return;

  const { currentIndex, questions } = session.pendingQuestionSet;
  const question = questions[currentIndex];
  if (!question) return;

  const optionIndex = getNumberEmojiIndex(emojiName);
  if (optionIndex < 0 || optionIndex >= question.options.length) return;

  const selectedOption = question.options[optionIndex];
  question.answer = selectedOption.label;
  if (ctx.config.debug) log.debug(`💬 @${username} answered "${question.header}": ${selectedOption.label}`);

  // Update the post to show answer
  await withErrorHandling(
    () => session.platform.updatePost(postId, `✅ **${question.header}**: ${selectedOption.label}`),
    { action: 'Update answered question', session }
  );

  // Move to next question or finish
  session.pendingQuestionSet.currentIndex++;

  if (session.pendingQuestionSet.currentIndex < questions.length) {
    // Post next question - must register post for reaction routing
    await postCurrentQuestion(session, ctx);
  } else {
    // All questions answered - send user message (NOT tool_result)
    // Claude Code CLI handles AskUserQuestion internally (generating its own tool_result),
    // so we can't send another tool_result. Instead, send a user message with answers.
    let answersText = 'Here are my answers:\n';
    for (const q of questions) {
      answersText += `- **${q.header}**: ${q.answer}\n`;
    }

    if (ctx.config.debug) log.debug('✅ All questions answered');

    // Clear pending questions
    session.pendingQuestionSet = null;

    // Send user message to Claude with the answers
    if (session.claude.isRunning()) {
      session.claude.sendMessage(answersText);
      ctx.ops.startTyping(session);
    }
  }
}

// ---------------------------------------------------------------------------
// Plan approval reaction handling
// ---------------------------------------------------------------------------

/**
 * Handle a reaction on a plan approval post (thumbs up/down).
 */
export async function handleApprovalReaction(
  session: Session,
  emojiName: string,
  username: string,
  ctx: SessionContext
): Promise<void> {
  if (!session.pendingApproval) return;

  const isApprove = isApprovalEmoji(emojiName);
  const isReject = isDenialEmoji(emojiName);

  if (!isApprove && !isReject) return;

  const { postId } = session.pendingApproval;
  // Note: toolUseId is no longer used - Claude Code CLI handles ExitPlanMode internally
  const shortId = session.threadId.substring(0, 8);
  log.info(`${isApprove ? '✅' : '❌'} Plan ${isApprove ? 'approved' : 'rejected'} (${shortId}…) by @${username}`);

  // Update the post to show the decision
  const statusMessage = isApprove
    ? `✅ **Plan approved** by @${username} - starting implementation...`
    : `❌ **Changes requested** by @${username}`;
  await withErrorHandling(
    () => session.platform.updatePost(postId, statusMessage),
    { action: 'Update approval post', session }
  );

  // Clear pending approval and mark as approved
  session.pendingApproval = null;
  if (isApprove) {
    session.planApproved = true;
  }

  // Send user message to Claude - NOT a tool_result
  // Claude Code CLI handles ExitPlanMode internally (generating its own tool_result),
  // so we can't send another tool_result. Instead, send a user message to continue.
  if (session.claude.isRunning()) {
    const message = isApprove
      ? 'Plan approved! Please proceed with the implementation.'
      : 'Please revise the plan. I would like some changes.';
    session.claude.sendMessage(message);
    ctx.ops.startTyping(session);
  }
}

// ---------------------------------------------------------------------------
// Message approval reaction handling
// ---------------------------------------------------------------------------

/**
 * Handle a reaction on a message approval post (approve/invite/deny).
 */
export async function handleMessageApprovalReaction(
  session: Session,
  emoji: string,
  approver: string,
  ctx: SessionContext
): Promise<void> {
  const pending = session.pendingMessageApproval;
  if (!pending) return;

  // Only session owner or globally allowed users can approve
  if (session.startedBy !== approver && !session.platform.isUserAllowed(approver)) {
    return;
  }

  const isAllow = isApprovalEmoji(emoji);
  const isInvite = isAllowAllEmoji(emoji);
  const isDeny = isDenialEmoji(emoji);

  if (!isAllow && !isInvite && !isDeny) return;

  if (isAllow) {
    // Allow this single message
    await session.platform.updatePost(
      pending.postId,
      `✅ Message from @${pending.fromUser} approved by @${approver}`
    );
    session.claude.sendMessage(pending.originalMessage);
    session.lastActivityAt = new Date();
    ctx.ops.startTyping(session);
    log.info(`✅ Message from @${pending.fromUser} approved by @${approver}`);
  } else if (isInvite) {
    // Invite user to session
    session.sessionAllowedUsers.add(pending.fromUser);
    await session.platform.updatePost(
      pending.postId,
      `✅ @${pending.fromUser} invited to session by @${approver}`
    );
    await ctx.ops.updateSessionHeader(session);
    session.claude.sendMessage(pending.originalMessage);
    session.lastActivityAt = new Date();
    ctx.ops.startTyping(session);
    log.info(`👋 @${pending.fromUser} invited to session by @${approver}`);
  } else if (isDeny) {
    // Deny
    await session.platform.updatePost(
      pending.postId,
      `❌ Message from @${pending.fromUser} denied by @${approver}`
    );
    log.info(`❌ Message from @${pending.fromUser} denied by @${approver}`);
  }

  session.pendingMessageApproval = null;
}

// ---------------------------------------------------------------------------
// Task list toggle reaction handling
// ---------------------------------------------------------------------------

/**
 * Handle a reaction on the task list post to minimize/expand.
 * State-based: user adds their reaction = minimized, user removes = expanded.
 * (The bot's emoji is always present as a clickable toggle button.)
 * Returns true if the toggle was handled, false otherwise.
 */
export async function handleTaskToggleReaction(
  session: Session,
  action: 'added' | 'removed',
  ctx: SessionContext
): Promise<boolean> {
  if (!session.tasksPostId || !session.lastTasksContent) {
    return false;
  }

  // State-based: user adds reaction = minimize, user removes reaction = expand
  // (The bot's emoji is always there; user clicks it to add their reaction = minimize)
  const shouldMinimize = action === 'added';

  // Skip if already in desired state
  if (session.tasksMinimized === shouldMinimize) {
    return true;
  }

  session.tasksMinimized = shouldMinimize;

  if (ctx.config.debug) {
    log.debug(`🔽 Tasks ${session.tasksMinimized ? 'minimized' : 'expanded'} (user ${action} reaction)`);
  }

  // Compute the display message
  // Parse progress from lastTasksContent (format: "📋 **Tasks** (X/Y · Z%)")
  const progressMatch = session.lastTasksContent.match(/\((\d+)\/(\d+) · (\d+)%\)/);
  const completed = progressMatch ? parseInt(progressMatch[1], 10) : 0;
  const total = progressMatch ? parseInt(progressMatch[2], 10) : 0;
  const pct = progressMatch ? parseInt(progressMatch[3], 10) : 0;

  // Find current in-progress task from lastTasksContent
  const inProgressMatch = session.lastTasksContent.match(/🔄 \*\*([^*]+)\*\*(?:\s*\((\d+)s\))?/);
  let currentTaskText = '';
  if (inProgressMatch) {
    const taskName = inProgressMatch[1];
    const elapsed = inProgressMatch[2] ? ` (${inProgressMatch[2]}s)` : '';
    currentTaskText = ` · 🔄 ${taskName}${elapsed}`;
  }

  const minimizedMessage = `---\n📋 **Tasks** (${completed}/${total} · ${pct}%)${currentTaskText} 🔽`;
  const displayMessage = session.tasksMinimized ? minimizedMessage : session.lastTasksContent;
  const tasksPostId = session.tasksPostId;

  await withErrorHandling(
    () => session.platform.updatePost(tasksPostId, displayMessage),
    { action: 'Toggle tasks display', session }
  );

  // Ensure the toggle emoji is present (may have been removed during toggle)
  try {
    await session.platform.addReaction(tasksPostId, TASK_TOGGLE_EMOJIS[0]);
  } catch {
    // Ignore errors - emoji may already exist or reaction failed
  }

  return true;
}

// ---------------------------------------------------------------------------
// Existing worktree join prompt reaction handling
// ---------------------------------------------------------------------------

/**
 * Handle a reaction on an existing worktree prompt (join or skip).
 * Returns true if the reaction was handled, false otherwise.
 *
 * @param switchToWorktree - Callback to switch session to existing worktree
 *                           (not part of SessionOperations as it's specific to this use case)
 */
export async function handleExistingWorktreeReaction(
  session: Session,
  postId: string,
  emojiName: string,
  username: string,
  ctx: SessionContext,
  switchToWorktree: (threadId: string, branchOrPath: string, username: string) => Promise<void>
): Promise<boolean> {
  const pending = session.pendingExistingWorktreePrompt;
  if (!pending || pending.postId !== postId) {
    return false;
  }

  // Only session owner or allowed users can respond
  if (session.startedBy !== username && !session.platform.isUserAllowed(username)) {
    return false;
  }

  const isApprove = isApprovalEmoji(emojiName);
  const isDeny = isDenialEmoji(emojiName);

  if (!isApprove && !isDeny) {
    return false;
  }

  const shortPath = pending.worktreePath.replace(process.env.HOME || '', '~');

  if (isApprove) {
    // Join the existing worktree
    await session.platform.updatePost(
      pending.postId,
      `✅ Joining worktree for branch \`${pending.branch}\` at \`${shortPath}\``
    );

    // Clear the pending prompt before switching
    session.pendingExistingWorktreePrompt = undefined;
    ctx.ops.persistSession(session);

    // Switch to the existing worktree
    await switchToWorktree(session.threadId, pending.worktreePath, pending.username);

    log.info(`🌿 @${username} joined existing worktree ${pending.branch} at ${shortPath}`);
  } else {
    // Skip - continue in current directory
    await session.platform.updatePost(
      pending.postId,
      `✅ Continuing in current directory (skipped by @${username})`
    );

    // Clear the pending prompt
    session.pendingExistingWorktreePrompt = undefined;
    ctx.ops.persistSession(session);

    log.info(`❌ @${username} skipped joining existing worktree ${pending.branch}`);
  }

  return true;
}
