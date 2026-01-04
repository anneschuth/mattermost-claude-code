/**
 * Claude event handling module
 *
 * Handles events from Claude CLI: assistant messages, tool use,
 * tool results, tasks, questions, and plan approvals.
 */

import type { Session, SessionUsageStats, ModelTokenUsage } from './types.js';
import { getSessionStatus } from './types.js';
import type { ClaudeEvent } from '../claude/cli.js';
import { formatToolUse as sharedFormatToolUse } from '../utils/tool-formatter.js';
import {
  NUMBER_EMOJIS,
  APPROVAL_EMOJIS,
  DENIAL_EMOJIS,
  TASK_TOGGLE_EMOJIS,
} from '../utils/emoji.js';
import {
  shouldFlushEarly,
  MIN_BREAK_THRESHOLD,
} from './streaming.js';
import { withErrorHandling } from './error-handler.js';
import { resetSessionActivity } from './post-helpers.js';
import type { SessionContext } from './context.js';
import { createLogger } from '../utils/logger.js';
import { extractPullRequestUrl } from '../utils/pr-detector.js';

const log = createLogger('events');

/** Get session-scoped logger for routing to correct UI panel */
function sessionLog(session: Session) {
  return log.forSession(session.sessionId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Metadata extraction configuration
 */
interface MetadataConfig {
  marker: string;       // e.g., 'SESSION_TITLE'
  minLength: number;
  maxLength: number;
  placeholder: string;  // e.g., '<short title>'
}

/**
 * Extract and validate session metadata (title or description) from text.
 * Updates session if valid and different from current value.
 * Returns the text with the marker removed.
 */
function extractAndUpdateMetadata(
  text: string,
  session: Session,
  config: MetadataConfig,
  sessionField: 'sessionTitle' | 'sessionDescription',
  ctx: SessionContext
): string {
  const regex = new RegExp(`\\[${config.marker}:\\s*([^\\]]+)\\]`);
  const match = text.match(regex);

  if (match) {
    const newValue = match[1].trim();
    // Validate: reject placeholders, too short/long, dots-only
    const isValid = newValue.length >= config.minLength &&
      newValue.length <= config.maxLength &&
      !/^\.+$/.test(newValue) &&
      !/^…+$/.test(newValue) &&
      newValue !== config.placeholder &&
      !newValue.startsWith('...');

    if (isValid && newValue !== session[sessionField]) {
      session[sessionField] = newValue;
      // Persist and update UI (async, don't wait)
      ctx.ops.persistSession(session);
      ctx.ops.updateStickyMessage().catch(() => {});
      ctx.ops.updateSessionHeader(session).catch(() => {});
      // Update CLI UI with new title/description
      const updates: Record<string, string> = {};
      if (sessionField === 'sessionTitle') updates.title = newValue;
      if (sessionField === 'sessionDescription') updates.description = newValue;
      ctx.ops.emitSessionUpdate(session.sessionId, updates);
    }
  }

  // Always remove the marker from displayed text (even if validation failed)
  const removeRegex = new RegExp(`\\[${config.marker}:\\s*[^\\]]+\\]\\s*`, 'g');
  return text.replace(removeRegex, '').trim();
}

// Metadata configs for title and description
const TITLE_CONFIG: MetadataConfig = {
  marker: 'SESSION_TITLE',
  minLength: 3,
  maxLength: 50,
  placeholder: '<short title>',
};

const DESCRIPTION_CONFIG: MetadataConfig = {
  marker: 'SESSION_DESCRIPTION',
  minLength: 5,
  maxLength: 100,
  placeholder: '<brief description>',
};

/**
 * Extract and update pull request URL from text.
 * Unlike title/description, PR URLs are detected from the actual content
 * (not from special markers), as Claude outputs them when running gh pr create.
 *
 * Only updates if we don't already have a PR URL (first one wins).
 */
function extractAndUpdatePullRequest(
  text: string,
  session: Session,
  ctx: SessionContext
): void {
  // Skip if we already have a PR URL
  if (session.pullRequestUrl) return;

  const prUrl = extractPullRequestUrl(text);
  if (prUrl) {
    session.pullRequestUrl = prUrl;
    sessionLog(session).info(`🔗 Detected PR URL: ${prUrl}`);

    // Persist and update UI
    ctx.ops.persistSession(session);
    ctx.ops.updateStickyMessage().catch(() => {});
    ctx.ops.updateSessionHeader(session).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main event handler
// ---------------------------------------------------------------------------

/**
 * Handle a Claude event from the CLI stream.
 * Routes to appropriate handler based on event type.
 */
export function handleEvent(
  session: Session,
  event: ClaudeEvent,
  ctx: SessionContext
): void {
  // Reset activity and clear timeout tracking (prevents updating stale posts in long threads)
  // Note: compactionPostId is NOT cleared here because compaction events come in sequence
  // and we need to preserve the ID between start and completion events
  resetSessionActivity(session);

  // On first meaningful response from Claude, mark session as safe to resume and persist
  // This ensures we don't persist sessions where Claude dies before saving its conversation
  if (!session.hasClaudeResponded && (event.type === 'assistant' || event.type === 'tool_use')) {
    session.hasClaudeResponded = true;
    ctx.ops.persistSession(session);
    // Update UI status from 'starting' to 'active'
    ctx.ops.emitSessionUpdate(session.sessionId, { status: getSessionStatus(session) });
  }

  // Check for special tool uses that need custom handling
  if (event.type === 'assistant') {
    const msg = event.message as {
      content?: Array<{
        type: string;
        name?: string;
        id?: string;
        input?: Record<string, unknown>;
      }>;
    };
    let hasSpecialTool = false;
    for (const block of msg?.content || []) {
      if (block.type === 'tool_use') {
        if (block.name === 'ExitPlanMode') {
          handleExitPlanMode(session, block.id as string, ctx);
          hasSpecialTool = true;
        } else if (block.name === 'TodoWrite') {
          handleTodoWrite(session, block.input as Record<string, unknown>, ctx);
        } else if (block.name === 'Task') {
          handleTaskStart(session, block.id as string, block.input as Record<string, unknown>, ctx);
        } else if (block.name === 'AskUserQuestion') {
          handleAskUserQuestion(session, block.id as string, block.input as Record<string, unknown>, ctx);
          hasSpecialTool = true;
        }
      }
    }
    if (hasSpecialTool) return;
  }

  // Check for tool_result to update subagent status
  if (event.type === 'user') {
    const msg = event.message as {
      content?: Array<{ type: string; tool_use_id?: string; content?: string }>;
    };
    for (const block of msg?.content || []) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const postId = session.activeSubagents.get(block.tool_use_id);
        if (postId) {
          handleTaskComplete(session, block.tool_use_id, postId);
        }
      }
    }
  }

  // Handle compaction events specially - repurpose the "Compacting..." post
  if (event.type === 'system') {
    const e = event as ClaudeEvent & { subtype?: string; status?: string; compact_metadata?: unknown };
    if (e.subtype === 'status' && e.status === 'compacting') {
      handleCompactionStart(session, ctx);
      return; // Don't process further - we've handled this event
    }
    if (e.subtype === 'compact_boundary') {
      handleCompactionComplete(session, e.compact_metadata, ctx);
      return; // Don't process further - we've handled this event
    }
  }

  const formatted = formatEvent(session, event, ctx);
  sessionLog(session).debugJson(`handleEvent: ${event.type}`, event);
  if (formatted) ctx.ops.appendContent(session, formatted);

  // After tool_result events, check if we should flush and start a new post
  // This creates natural message breaks after tool completions
  if (event.type === 'tool_result' &&
      session.currentPostId &&
      session.pendingContent.length > MIN_BREAK_THRESHOLD &&
      shouldFlushEarly(session.pendingContent)) {
    // Flush and clear to start a new post for subsequent content
    ctx.ops.flush(session).then(() => {
      session.currentPostId = null;
      session.pendingContent = '';
    });
  }
}

// ---------------------------------------------------------------------------
// Event formatters
// ---------------------------------------------------------------------------

/**
 * Format a Claude event for display in chat platforms.
 */
function formatEvent(
  session: Session,
  e: ClaudeEvent,
  ctx: SessionContext
): string | null {
  switch (e.type) {
    case 'assistant': {
      const msg = e.message as {
        content?: Array<{
          type: string;
          text?: string;
          thinking?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
      };
      const parts: string[] = [];
      for (const block of msg?.content || []) {
        if (block.type === 'text' && block.text) {
          // Filter out <thinking> tags that may appear in text content
          let text = block.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();

          // Extract and update session title if present
          text = extractAndUpdateMetadata(text, session, TITLE_CONFIG, 'sessionTitle', ctx);

          // Extract and update session description if present
          text = extractAndUpdateMetadata(text, session, DESCRIPTION_CONFIG, 'sessionDescription', ctx);

          // Detect and store pull request URLs
          extractAndUpdatePullRequest(text, session, ctx);

          if (text) parts.push(text);
        } else if (block.type === 'tool_use' && block.name) {
          const formatted = sharedFormatToolUse(block.name, block.input || {}, session.platform.getFormatter(), { detailed: true });
          if (formatted) parts.push(formatted);
        } else if (block.type === 'thinking' && block.thinking) {
          // Extended thinking - show abbreviated version in blockquote
          const thinking = block.thinking as string;
          const maxLength = 200;
          let preview = thinking;
          if (thinking.length > maxLength) {
            // Cut at word boundary
            const truncated = thinking.substring(0, maxLength);
            const lastSpace = truncated.lastIndexOf(' ');
            preview = (lastSpace > maxLength * 0.7 ? truncated.substring(0, lastSpace) : truncated) + '...';
          }
          // Use blockquote for better formatting
          parts.push(`> 💭 *${preview}*`);
        } else if (block.type === 'server_tool_use' && block.name) {
          // Server-managed tools like web search
          parts.push(
            `🌐 **${block.name}** ${block.input ? JSON.stringify(block.input).substring(0, 50) : ''}`
          );
        }
      }
      return parts.length > 0 ? parts.join('\n') : null;
    }
    case 'tool_use': {
      const tool = e.tool_use as { id?: string; name: string; input?: Record<string, unknown> };
      // Track tool start time for elapsed display
      if (tool.id) {
        session.activeToolStarts.set(tool.id, Date.now());
      }
      return sharedFormatToolUse(tool.name, tool.input || {}, session.platform.getFormatter(), { detailed: true }) || null;
    }
    case 'tool_result': {
      const result = e.tool_result as { tool_use_id?: string; is_error?: boolean };
      // Calculate elapsed time
      let elapsed = '';
      if (result.tool_use_id) {
        const startTime = session.activeToolStarts.get(result.tool_use_id);
        if (startTime) {
          const secs = Math.round((Date.now() - startTime) / 1000);
          if (secs >= 3) {
            // Only show if >= 3 seconds
            elapsed = ` (${secs}s)`;
          }
          session.activeToolStarts.delete(result.tool_use_id);
        }
      }
      if (result.is_error) return `  ↳ ❌ Error${elapsed}`;
      if (elapsed) return `  ↳ ✓${elapsed}`;
      return null;
    }
    case 'result': {
      // Response complete - stop typing and start new post for next message
      ctx.ops.stopTyping(session);
      ctx.ops.flush(session);
      session.currentPostId = null;
      session.pendingContent = '';

      // Mark as no longer processing and update UI
      session.isProcessing = false;
      ctx.ops.emitSessionUpdate(session.sessionId, { status: getSessionStatus(session) });

      // Extract usage stats from result event
      updateUsageStats(session, e, ctx);

      return null;
    }
    case 'system': {
      if (e.subtype === 'error') return `❌ ${e.error}`;
      // Note: Compaction events (status: 'compacting' and compact_boundary) are handled
      // specially in handleEvent to support post repurposing - they never reach here.
      return null;
    }
    case 'user': {
      // Handle local command output (e.g., /context, /cost responses)
      const msg = e.message as { content?: string };
      if (typeof msg?.content === 'string') {
        // Extract content from <local-command-stdout> tags
        const match = msg.content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
        if (match) {
          return match[1].trim();
        }
      }
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Plan mode handling
// ---------------------------------------------------------------------------

/**
 * Handle ExitPlanMode tool use - post approval prompt.
 */
async function handleExitPlanMode(
  session: Session,
  toolUseId: string,
  ctx: SessionContext
): Promise<void> {
  // If already approved in this session, do nothing
  // Claude Code CLI handles ExitPlanMode internally (generating its own tool_result),
  // so we can't send another tool_result - just let the CLI handle it
  if (session.planApproved) {
    sessionLog(session).debug('Plan already approved, letting CLI handle it');
    return;
  }

  // If we already have a pending approval, don't post another one
  if (session.pendingApproval && session.pendingApproval.type === 'plan') {
    sessionLog(session).debug('Plan approval already pending, waiting');
    return;
  }

  // Flush any pending content first
  await ctx.ops.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  // Post approval message with reactions
  const message =
    `✅ **Plan ready for approval**\n\n` +
    `👍 Approve and start building\n` +
    `👎 Request changes\n\n` +
    `*React to respond*`;

  const post = await session.platform.createInteractivePost(
    message,
    [APPROVAL_EMOJIS[0], DENIAL_EMOJIS[0]],
    session.threadId
  );

  // Register post for reaction routing
  ctx.ops.registerPost(post.id, session.threadId);

  // Track this for reaction handling
  // Note: toolUseId is stored but not used - Claude Code CLI handles ExitPlanMode internally,
  // so we send a user message instead of a tool_result when the user approves
  session.pendingApproval = { postId: post.id, type: 'plan', toolUseId };

  // Stop typing while waiting
  ctx.ops.stopTyping(session);
}

// ---------------------------------------------------------------------------
// Task/Todo handling
// ---------------------------------------------------------------------------

/**
 * Handle TodoWrite tool use - update task list display.
 */
async function handleTodoWrite(
  session: Session,
  input: Record<string, unknown>,
  ctx: SessionContext
): Promise<void> {
  const todos = input.todos as Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }>;

  if (!todos || todos.length === 0) {
    // Clear tasks display if empty
    session.tasksCompleted = true;
    const tasksPostId = session.tasksPostId;
    if (tasksPostId) {
      const completedMsg = '---\n📋 ~~Tasks~~ *(completed)*';
      await withErrorHandling(
        () => session.platform.updatePost(tasksPostId, completedMsg),
        { action: 'Update tasks', session }
      );
      session.lastTasksContent = completedMsg;
    }
    return;
  }

  // Check if all tasks are completed
  const allCompleted = todos.every((t) => t.status === 'completed');
  session.tasksCompleted = allCompleted;

  // Count progress
  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const pct = Math.round((completed / total) * 100);

  // Check if there's an in_progress task and track timing
  const hasInProgress = todos.some((t) => t.status === 'in_progress');
  if (hasInProgress && !session.inProgressTaskStart) {
    session.inProgressTaskStart = Date.now();
  } else if (!hasInProgress) {
    session.inProgressTaskStart = null;
  }

  // Find the current in-progress task for minimized display
  const inProgressTask = todos.find((t) => t.status === 'in_progress');
  let currentTaskText = '';
  if (inProgressTask) {
    let elapsed = '';
    if (session.inProgressTaskStart) {
      const secs = Math.round((Date.now() - session.inProgressTaskStart) / 1000);
      if (secs >= 5) {
        elapsed = ` (${secs}s)`;
      }
    }
    currentTaskText = ` · 🔄 ${inProgressTask.activeForm}${elapsed}`;
  }

  // Build full task list (always computed for lastTasksContent)
  let fullMessage = `---\n📋 **Tasks** (${completed}/${total} · ${pct}%)\n\n`;
  for (const todo of todos) {
    let icon: string;
    let text: string;
    switch (todo.status) {
      case 'completed':
        icon = '✅';
        text = `~~${todo.content}~~`;
        break;
      case 'in_progress': {
        icon = '🔄';
        // Add elapsed time if we have a start time
        let elapsed = '';
        if (session.inProgressTaskStart) {
          const secs = Math.round((Date.now() - session.inProgressTaskStart) / 1000);
          if (secs >= 5) {
            // Only show if >= 5 seconds
            elapsed = ` (${secs}s)`;
          }
        }
        text = `**${todo.activeForm}**${elapsed}`;
        break;
      }
      default:
        // pending
        icon = '○';
        text = todo.content;
    }
    fullMessage += `${icon} ${text}\n`;
  }

  // Save full content for sticky task list feature and expansion
  session.lastTasksContent = fullMessage;

  // Choose display format based on minimized state
  // Minimized: show only progress bar with current task
  // Expanded: show full task list
  const minimizedMessage = `---\n📋 **Tasks** (${completed}/${total} · ${pct}%)${currentTaskText} 🔽`;
  const displayMessage = session.tasksMinimized ? minimizedMessage : fullMessage;

  // Update or create tasks post
  const existingTasksPostId = session.tasksPostId;
  if (existingTasksPostId) {
    await withErrorHandling(
      () => session.platform.updatePost(existingTasksPostId, displayMessage),
      { action: 'Update tasks', session }
    );
  } else {
    // Create with toggle emoji reaction so users can click to collapse
    const post = await withErrorHandling(
      () => session.platform.createInteractivePost(
        displayMessage,
        [TASK_TOGGLE_EMOJIS[0]], // 🔽 arrow_down_small
        session.threadId
      ),
      { action: 'Create tasks post', session }
    );
    if (post) {
      session.tasksPostId = post.id;
      // Register the task post so reaction clicks are routed to this session
      ctx.ops.registerPost(post.id, session.threadId);
    }
  }
  // Update sticky message with new task progress
  ctx.ops.updateStickyMessage().catch(() => {});
}

/**
 * Handle Task (subagent) start - post status message.
 */
async function handleTaskStart(
  session: Session,
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: SessionContext
): Promise<void> {
  const description = (input.description as string) || 'Working...';
  const subagentType = (input.subagent_type as string) || 'general';

  // Flush any pending content first to avoid empty continuation messages
  await ctx.ops.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  // Post subagent status
  const message = `🤖 **Subagent** *(${subagentType})*\n` + `> ${description}\n` + `⏳ Running...`;

  const post = await withErrorHandling(
    () => session.platform.createPost(message, session.threadId),
    { action: 'Post subagent status', session }
  );
  if (post) {
    session.activeSubagents.set(toolUseId, post.id);
    // Bump task list to stay below subagent messages
    await ctx.ops.bumpTasksToBottom(session);
  }
}

/**
 * Handle Task (subagent) completion - update status message.
 */
async function handleTaskComplete(
  session: Session,
  toolUseId: string,
  postId: string
): Promise<void> {
  const completionMessage = session.activeSubagents.has(toolUseId)
    ? `🤖 **Subagent** ✅ *completed*`
    : `🤖 **Subagent** ✅`;
  await withErrorHandling(
    () => session.platform.updatePost(postId, completionMessage),
    { action: 'Update subagent completion', session }
  );
  session.activeSubagents.delete(toolUseId);
}

// ---------------------------------------------------------------------------
// Compaction handling
// ---------------------------------------------------------------------------

/**
 * Handle compaction start - create a dedicated post that we can update later.
 */
async function handleCompactionStart(
  session: Session,
  ctx: SessionContext
): Promise<void> {
  // Flush any pending content first to avoid mixing with compaction message
  await ctx.ops.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  // Create the compaction status post
  const message = '🗜️ **Compacting context...** *(freeing up memory)*';
  const post = await withErrorHandling(
    () => session.platform.createPost(message, session.threadId),
    { action: 'Post compaction start', session }
  );

  if (post) {
    session.compactionPostId = post.id;
  }
}

/**
 * Handle compaction complete - update the existing compaction post.
 */
async function handleCompactionComplete(
  session: Session,
  compactMetadata: unknown,
  _ctx: SessionContext
): Promise<void> {
  // Build the completion message with metadata
  const metadata = compactMetadata as { trigger?: string; pre_tokens?: number } | undefined;
  const trigger = metadata?.trigger || 'auto';
  const preTokens = metadata?.pre_tokens;
  let info = trigger === 'manual' ? 'manual' : 'auto';
  if (preTokens && preTokens > 0) {
    info += `, ${Math.round(preTokens / 1000)}k tokens`;
  }
  const completionMessage = `✅ **Context compacted** *(${info})*`;

  if (session.compactionPostId) {
    // Update the existing compaction post
    await withErrorHandling(
      () => session.platform.updatePost(session.compactionPostId!, completionMessage),
      { action: 'Update compaction complete', session }
    );
    session.compactionPostId = undefined;
  } else {
    // Fallback: create a new post if we don't have the original
    await withErrorHandling(
      () => session.platform.createPost(completionMessage, session.threadId),
      { action: 'Post compaction complete', session }
    );
  }
}

// ---------------------------------------------------------------------------
// Question handling
// ---------------------------------------------------------------------------

/**
 * Handle AskUserQuestion tool use - start interactive question flow.
 */
async function handleAskUserQuestion(
  session: Session,
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: SessionContext
): Promise<void> {
  // If we already have pending questions, don't start another set
  if (session.pendingQuestionSet) {
    sessionLog(session).debug('Questions already pending, waiting');
    return;
  }

  // Flush any pending content first
  await ctx.ops.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  const questions = input.questions as Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;

  if (!questions || questions.length === 0) return;

  // Create a new question set - we'll ask one at a time
  session.pendingQuestionSet = {
    toolUseId,
    currentIndex: 0,
    currentPostId: null,
    questions: questions.map((q) => ({
      header: q.header,
      question: q.question,
      options: q.options,
      answer: null,
    })),
  };

  // Post the first question
  await postCurrentQuestion(session, ctx);

  // Stop typing while waiting for answer
  ctx.ops.stopTyping(session);
}

/**
 * Post the current question in the question set.
 */
export async function postCurrentQuestion(
  session: Session,
  ctx: SessionContext
): Promise<void> {
  if (!session.pendingQuestionSet) return;

  const { currentIndex, questions } = session.pendingQuestionSet;
  if (currentIndex >= questions.length) return;

  const q = questions[currentIndex];
  const total = questions.length;

  // Format the question message
  let message = `❓ **Question** *(${currentIndex + 1}/${total})*\n`;
  message += `**${q.header}:** ${q.question}\n\n`;
  for (let i = 0; i < q.options.length && i < 4; i++) {
    const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i];
    message += `${emoji} **${q.options[i].label}**`;
    if (q.options[i].description) {
      message += ` - ${q.options[i].description}`;
    }
    message += '\n';
  }

  // Post the question with reaction options
  const reactionOptions = NUMBER_EMOJIS.slice(0, q.options.length);
  const post = await session.platform.createInteractivePost(
    message,
    reactionOptions,
    session.threadId
  );
  session.pendingQuestionSet.currentPostId = post.id;

  // Register post for reaction routing
  ctx.ops.registerPost(post.id, session.threadId);
}

// ---------------------------------------------------------------------------
// Usage stats extraction
// ---------------------------------------------------------------------------

/**
 * Result event structure from Claude CLI
 */
interface ResultEvent {
  type: 'result';
  subtype?: string;
  total_cost_usd?: number;
  /** Per-request token usage (accurate for context window calculation) */
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
  /** Cumulative billing per model across the session */
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    costUSD: number;
  }>;
}

/**
 * Convert model ID to display name
 * e.g., "claude-opus-4-5-20251101" -> "Opus 4.5"
 */
function getModelDisplayName(modelId: string): string {
  // Common model name patterns
  if (modelId.includes('opus-4-5') || modelId.includes('opus-4.5')) return 'Opus 4.5';
  if (modelId.includes('opus-4')) return 'Opus 4';
  if (modelId.includes('opus')) return 'Opus';
  if (modelId.includes('sonnet-4')) return 'Sonnet 4';
  if (modelId.includes('sonnet-3-5') || modelId.includes('sonnet-3.5')) return 'Sonnet 3.5';
  if (modelId.includes('sonnet')) return 'Sonnet';
  if (modelId.includes('haiku-4-5') || modelId.includes('haiku-4.5')) return 'Haiku 4.5';
  if (modelId.includes('haiku')) return 'Haiku';
  // Fallback: extract the model family name
  const match = modelId.match(/claude-(\w+)/);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : modelId;
}

/**
 * Extract usage stats from a result event and update session
 */
function updateUsageStats(
  session: Session,
  event: ClaudeEvent,
  ctx: SessionContext
): void {
  const result = event as ResultEvent;

  if (!result.modelUsage) return;

  // Find the primary model (highest cost, usually the main model)
  let primaryModel = '';
  let highestCost = 0;
  let contextWindowSize = 200000; // Default

  const modelUsage: Record<string, ModelTokenUsage> = {};
  let totalTokensUsed = 0;

  for (const [modelId, usage] of Object.entries(result.modelUsage)) {
    modelUsage[modelId] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      contextWindow: usage.contextWindow,
      costUSD: usage.costUSD,
    };

    // Sum all tokens (for billing display)
    totalTokensUsed += usage.inputTokens + usage.outputTokens +
      usage.cacheReadInputTokens + usage.cacheCreationInputTokens;

    // Track primary model by highest cost
    if (usage.costUSD > highestCost) {
      highestCost = usage.costUSD;
      primaryModel = modelId;
      contextWindowSize = usage.contextWindow;
    }
  }

  // Calculate context tokens from per-request usage (accurate)
  // Falls back to primary model's cumulative tokens if usage not available
  let contextTokens = 0;
  if (result.usage) {
    // Per-request usage: actual tokens in current context window
    contextTokens = result.usage.input_tokens +
      result.usage.cache_creation_input_tokens +
      result.usage.cache_read_input_tokens;
  } else if (primaryModel && result.modelUsage[primaryModel]) {
    // Fallback: estimate from primary model's cumulative billing
    const primary = result.modelUsage[primaryModel];
    contextTokens = primary.inputTokens + primary.cacheReadInputTokens;
  }

  // Create or update usage stats
  const usageStats: SessionUsageStats = {
    primaryModel,
    modelDisplayName: getModelDisplayName(primaryModel),
    contextWindowSize,
    contextTokens,
    totalTokensUsed,
    totalCostUSD: result.total_cost_usd || 0,
    modelUsage,
    lastUpdated: new Date(),
  };

  session.usageStats = usageStats;

  const contextPct = contextWindowSize > 0
    ? Math.round((contextTokens / contextWindowSize) * 100)
    : 0;
  sessionLog(session).info(
    `Updated usage stats: ${usageStats.modelDisplayName}, ` +
    `context ${contextTokens}/${contextWindowSize} (${contextPct}%), ` +
    `$${usageStats.totalCostUSD.toFixed(4)}`
  );

  // Start periodic status bar timer if not already running
  if (!session.statusBarTimer) {
    const STATUS_BAR_UPDATE_INTERVAL = 30000; // 30 seconds
    session.statusBarTimer = setInterval(() => {
      // Only update if session is still active
      if (session.claude.isRunning()) {
        // Try to get more accurate context data from status line
        updateUsageFromStatusLine(session);
        ctx.ops.updateSessionHeader(session).catch(() => {});
      }
    }, STATUS_BAR_UPDATE_INTERVAL);
  }

  // Update status bar with new usage info
  ctx.ops.updateSessionHeader(session).catch(() => {});
}

/**
 * Update usage stats from the status line file if available.
 * This provides more accurate context window usage than result events.
 */
function updateUsageFromStatusLine(session: Session): void {
  const statusData = session.claude.getStatusData();
  if (!statusData) return;

  // Only update if we have existing usage stats
  if (!session.usageStats) return;

  // Use total_input_tokens which represents the cumulative context usage
  // (not current_usage which is just the per-request tokens)
  const contextTokens = statusData.total_input_tokens || 0;

  // Update context tokens if the status line data is newer
  if (statusData.timestamp > session.usageStats.lastUpdated.getTime()) {
    session.usageStats.contextTokens = contextTokens;
    session.usageStats.contextWindowSize = statusData.context_window_size;
    session.usageStats.lastUpdated = new Date(statusData.timestamp);

    // Update model info if available
    if (statusData.model) {
      session.usageStats.primaryModel = statusData.model.id;
      session.usageStats.modelDisplayName = statusData.model.display_name;
    }

    // Update cost if available
    if (statusData.cost) {
      session.usageStats.totalCostUSD = statusData.cost.total_cost_usd;
    }

    const contextPct = session.usageStats.contextWindowSize > 0
      ? Math.round((contextTokens / session.usageStats.contextWindowSize) * 100)
      : 0;
    sessionLog(session).debug(
      `Updated from status line: context ${contextTokens}/${session.usageStats.contextWindowSize} (${contextPct}%)`
    );
  }
}
