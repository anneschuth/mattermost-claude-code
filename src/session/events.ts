/**
 * Claude event handling module
 *
 * Handles events from Claude CLI: assistant messages, tool use,
 * tool results, tasks, questions, and plan approvals.
 */

import type { Session, SessionUsageStats, ModelTokenUsage } from './types.js';
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

// ---------------------------------------------------------------------------
// Context types for dependency injection
// ---------------------------------------------------------------------------

export interface EventContext {
  debug: boolean;
  registerPost: (postId: string, threadId: string) => void;
  flush: (session: Session) => Promise<void>;
  startTyping: (session: Session) => void;
  stopTyping: (session: Session) => void;
  appendContent: (session: Session, text: string) => void;
  bumpTasksToBottom: (session: Session) => Promise<void>;
  updateStickyMessage: () => Promise<void>;
  updateSessionHeader: (session: Session) => Promise<void>;
  persistSession: (session: Session) => void;
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
  ctx: EventContext
): void {
  // Update last activity and reset timeout warning
  session.lastActivityAt = new Date();
  session.timeoutWarningPosted = false;

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

  const formatted = formatEvent(session, event, ctx);
  if (ctx.debug) {
    console.log(
      `[DEBUG] handleEvent(${session.threadId}): ${event.type} -> ${formatted ? formatted.substring(0, 100) : '(null)'}`
    );
  }
  if (formatted) ctx.appendContent(session, formatted);

  // After tool_result events, check if we should flush and start a new post
  // This creates natural message breaks after tool completions
  if (event.type === 'tool_result' &&
      session.currentPostId &&
      session.pendingContent.length > MIN_BREAK_THRESHOLD &&
      shouldFlushEarly(session.pendingContent)) {
    // Flush and clear to start a new post for subsequent content
    ctx.flush(session).then(() => {
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
  ctx: EventContext
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

          // Extract session title if present: [SESSION_TITLE: ...]
          const titleMatch = text.match(/\[SESSION_TITLE:\s*([^\]]+)\]/);
          if (titleMatch) {
            const newTitle = titleMatch[1].trim();
            // Validate title: reject placeholders like "...", empty, or too short
            const isValidTitle = newTitle.length >= 3 &&
              !/^\.+$/.test(newTitle) &&
              !/^…+$/.test(newTitle) &&
              newTitle !== '<short title>' &&
              !newTitle.startsWith('...');
            if (isValidTitle && newTitle !== session.sessionTitle) {
              session.sessionTitle = newTitle;
              // Persist the updated title
              ctx.persistSession(session);
              // Update sticky message and session header with new title (async, don't wait)
              ctx.updateStickyMessage().catch(() => {});
              ctx.updateSessionHeader(session).catch(() => {});
            }
            // Remove the title marker from the displayed text
            text = text.replace(/\[SESSION_TITLE:\s*[^\]]+\]\s*/g, '').trim();
          }

          // Extract session description if present: [SESSION_DESCRIPTION: ...]
          const descMatch = text.match(/\[SESSION_DESCRIPTION:\s*([^\]]+)\]/);
          if (descMatch) {
            const newDesc = descMatch[1].trim();
            // Validate description: reject placeholders like "...", empty, or too short
            const isValidDesc = newDesc.length >= 5 &&
              !/^\.+$/.test(newDesc) &&
              !/^…+$/.test(newDesc) &&
              newDesc !== '<brief description>' &&
              !newDesc.startsWith('...');
            if (isValidDesc && newDesc !== session.sessionDescription) {
              session.sessionDescription = newDesc;
              // Persist the updated description
              ctx.persistSession(session);
              // Update sticky message and session header with new description (async, don't wait)
              ctx.updateStickyMessage().catch(() => {});
              ctx.updateSessionHeader(session).catch(() => {});
            }
            // Remove the description marker from the displayed text
            text = text.replace(/\[SESSION_DESCRIPTION:\s*[^\]]+\]\s*/g, '').trim();
          }

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
      ctx.stopTyping(session);
      ctx.flush(session);
      session.currentPostId = null;
      session.pendingContent = '';

      // Extract usage stats from result event
      updateUsageStats(session, e, ctx);

      return null;
    }
    case 'system':
      if (e.subtype === 'error') return `❌ ${e.error}`;
      return null;
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
  ctx: EventContext
): Promise<void> {
  // If already approved in this session, do nothing
  // Claude Code CLI handles ExitPlanMode internally (generating its own tool_result),
  // so we can't send another tool_result - just let the CLI handle it
  if (session.planApproved) {
    if (ctx.debug) console.log('  ↪ Plan already approved, letting CLI handle it');
    return;
  }

  // If we already have a pending approval, don't post another one
  if (session.pendingApproval && session.pendingApproval.type === 'plan') {
    if (ctx.debug) console.log('  ↪ Plan approval already pending, waiting');
    return;
  }

  // Flush any pending content first
  await ctx.flush(session);
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
  ctx.registerPost(post.id, session.threadId);

  // Track this for reaction handling
  // Note: toolUseId is stored but not used - Claude Code CLI handles ExitPlanMode internally,
  // so we send a user message instead of a tool_result when the user approves
  session.pendingApproval = { postId: post.id, type: 'plan', toolUseId };

  // Stop typing while waiting
  ctx.stopTyping(session);
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
  ctx: EventContext
): Promise<void> {
  const todos = input.todos as Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }>;

  if (!todos || todos.length === 0) {
    // Clear tasks display if empty
    session.tasksCompleted = true;
    if (session.tasksPostId) {
      try {
        const completedMsg = '---\n📋 ~~Tasks~~ *(completed)*';
        await session.platform.updatePost(session.tasksPostId, completedMsg);
        session.lastTasksContent = completedMsg;
      } catch (err) {
        console.error('  ⚠️ Failed to update tasks:', err);
      }
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
  try {
    if (session.tasksPostId) {
      await session.platform.updatePost(session.tasksPostId, displayMessage);
    } else {
      // Create with toggle emoji reaction so users can click to collapse
      const post = await session.platform.createInteractivePost(
        displayMessage,
        [TASK_TOGGLE_EMOJIS[0]], // 🔽 arrow_down_small
        session.threadId
      );
      session.tasksPostId = post.id;
      // Register the task post so reaction clicks are routed to this session
      ctx.registerPost(post.id, session.threadId);
    }
    // Update sticky message with new task progress
    ctx.updateStickyMessage().catch(() => {});
  } catch (err) {
    console.error('  ⚠️ Failed to update tasks:', err);
  }
}

/**
 * Handle Task (subagent) start - post status message.
 */
async function handleTaskStart(
  session: Session,
  toolUseId: string,
  input: Record<string, unknown>,
  ctx: EventContext
): Promise<void> {
  const description = (input.description as string) || 'Working...';
  const subagentType = (input.subagent_type as string) || 'general';

  // Flush any pending content first to avoid empty continuation messages
  await ctx.flush(session);
  session.currentPostId = null;
  session.pendingContent = '';

  // Post subagent status
  const message = `🤖 **Subagent** *(${subagentType})*\n` + `> ${description}\n` + `⏳ Running...`;

  try {
    const post = await session.platform.createPost(message, session.threadId);
    session.activeSubagents.set(toolUseId, post.id);

    // Bump task list to stay below subagent messages
    await ctx.bumpTasksToBottom(session);
  } catch (err) {
    console.error('  ⚠️ Failed to post subagent status:', err);
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
  try {
    await session.platform.updatePost(
      postId,
      session.activeSubagents.has(toolUseId)
        ? `🤖 **Subagent** ✅ *completed*`
        : `🤖 **Subagent** ✅`
    );
    session.activeSubagents.delete(toolUseId);
  } catch (err) {
    console.error('  ⚠️ Failed to update subagent completion:', err);
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
  ctx: EventContext
): Promise<void> {
  // If we already have pending questions, don't start another set
  if (session.pendingQuestionSet) {
    if (ctx.debug) console.log('  ↪ Questions already pending, waiting');
    return;
  }

  // Flush any pending content first
  await ctx.flush(session);
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
  ctx.stopTyping(session);
}

/**
 * Post the current question in the question set.
 */
export async function postCurrentQuestion(
  session: Session,
  ctx: EventContext
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
  ctx.registerPost(post.id, session.threadId);
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
  ctx: EventContext
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

    // Sum all tokens
    totalTokensUsed += usage.inputTokens + usage.outputTokens +
      usage.cacheReadInputTokens + usage.cacheCreationInputTokens;

    // Track primary model by highest cost
    if (usage.costUSD > highestCost) {
      highestCost = usage.costUSD;
      primaryModel = modelId;
      contextWindowSize = usage.contextWindow;
    }
  }

  // Create or update usage stats
  const usageStats: SessionUsageStats = {
    primaryModel,
    modelDisplayName: getModelDisplayName(primaryModel),
    contextWindowSize,
    totalTokensUsed,
    totalCostUSD: result.total_cost_usd || 0,
    modelUsage,
    lastUpdated: new Date(),
  };

  session.usageStats = usageStats;

  if (ctx.debug) {
    console.log(
      `[DEBUG] Updated usage stats: ${usageStats.modelDisplayName}, ` +
      `${usageStats.totalTokensUsed}/${usageStats.contextWindowSize} tokens, ` +
      `$${usageStats.totalCostUSD.toFixed(4)}`
    );
  }

  // Start periodic status bar timer if not already running
  if (!session.statusBarTimer) {
    const STATUS_BAR_UPDATE_INTERVAL = 30000; // 30 seconds
    session.statusBarTimer = setInterval(() => {
      // Only update if session is still active
      if (session.claude.isRunning()) {
        ctx.updateSessionHeader(session).catch(() => {});
      }
    }, STATUS_BAR_UPDATE_INTERVAL);
  }

  // Update status bar with new usage info
  ctx.updateSessionHeader(session).catch(() => {});
}
