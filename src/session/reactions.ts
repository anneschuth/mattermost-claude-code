/**
 * User reaction handling module
 *
 * Handles emoji reactions on posts: plan approval, question answers,
 * message approval, cancel/escape actions.
 */

import type { Session } from './types.js';
import {
  isApprovalEmoji,
  isDenialEmoji,
  isAllowAllEmoji,
  getNumberEmojiIndex,
} from '../utils/emoji.js';
import { postCurrentQuestion } from './events.js';

// ---------------------------------------------------------------------------
// Context types for dependency injection
// ---------------------------------------------------------------------------

export interface ReactionContext {
  debug: boolean;
  startTyping: (session: Session) => void;
  stopTyping: (session: Session) => void;
  updateSessionHeader: (session: Session) => Promise<void>;
  registerPost: (postId: string, threadId: string) => void;
}

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
  ctx: ReactionContext
): Promise<void> {
  if (!session.pendingQuestionSet) return;

  const { currentIndex, questions } = session.pendingQuestionSet;
  const question = questions[currentIndex];
  if (!question) return;

  const optionIndex = getNumberEmojiIndex(emojiName);
  if (optionIndex < 0 || optionIndex >= question.options.length) return;

  const selectedOption = question.options[optionIndex];
  question.answer = selectedOption.label;
  if (ctx.debug) console.log(`  💬 @${username} answered "${question.header}": ${selectedOption.label}`);

  // Update the post to show answer
  try {
    await session.platform.updatePost(postId, `✅ **${question.header}**: ${selectedOption.label}`);
  } catch (err) {
    console.error('  ⚠️ Failed to update answered question:', err);
  }

  // Move to next question or finish
  session.pendingQuestionSet.currentIndex++;

  if (session.pendingQuestionSet.currentIndex < questions.length) {
    // Post next question - must register post for reaction routing
    await postCurrentQuestion(session, {
      debug: ctx.debug,
      registerPost: ctx.registerPost,
      flush: async () => {},
      startTyping: ctx.startTyping,
      stopTyping: ctx.stopTyping,
      appendContent: () => {},
    });
  } else {
    // All questions answered - send user message (NOT tool_result)
    // Claude Code CLI handles AskUserQuestion internally (generating its own tool_result),
    // so we can't send another tool_result. Instead, send a user message with answers.
    let answersText = 'Here are my answers:\n';
    for (const q of questions) {
      answersText += `- **${q.header}**: ${q.answer}\n`;
    }

    if (ctx.debug) console.log('  ✅ All questions answered');

    // Clear pending questions
    session.pendingQuestionSet = null;

    // Send user message to Claude with the answers
    if (session.claude.isRunning()) {
      session.claude.sendMessage(answersText);
      ctx.startTyping(session);
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
  ctx: ReactionContext
): Promise<void> {
  if (!session.pendingApproval) return;

  const isApprove = isApprovalEmoji(emojiName);
  const isReject = isDenialEmoji(emojiName);

  if (!isApprove && !isReject) return;

  const { postId } = session.pendingApproval;
  // Note: toolUseId is no longer used - Claude Code CLI handles ExitPlanMode internally
  const shortId = session.threadId.substring(0, 8);
  console.log(`  ${isApprove ? '✅' : '❌'} Plan ${isApprove ? 'approved' : 'rejected'} (${shortId}…) by @${username}`);

  // Update the post to show the decision
  try {
    const statusMessage = isApprove
      ? `✅ **Plan approved** by @${username} - starting implementation...`
      : `❌ **Changes requested** by @${username}`;
    await session.platform.updatePost(postId, statusMessage);
  } catch (err) {
    console.error('  ⚠️ Failed to update approval post:', err);
  }

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
    ctx.startTyping(session);
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
  ctx: ReactionContext
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
    ctx.startTyping(session);
    console.log(`  ✅ Message from @${pending.fromUser} approved by @${approver}`);
  } else if (isInvite) {
    // Invite user to session
    session.sessionAllowedUsers.add(pending.fromUser);
    await session.platform.updatePost(
      pending.postId,
      `✅ @${pending.fromUser} invited to session by @${approver}`
    );
    await ctx.updateSessionHeader(session);
    session.claude.sendMessage(pending.originalMessage);
    session.lastActivityAt = new Date();
    ctx.startTyping(session);
    console.log(`  👋 @${pending.fromUser} invited to session by @${approver}`);
  } else if (isDeny) {
    // Deny
    await session.platform.updatePost(
      pending.postId,
      `❌ Message from @${pending.fromUser} denied by @${approver}`
    );
    console.log(`  ❌ Message from @${pending.fromUser} denied by @${approver}`);
  }

  session.pendingMessageApproval = null;
}
