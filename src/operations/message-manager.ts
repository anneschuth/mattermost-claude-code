/**
 * Message Manager - Orchestrates the operation pipeline
 *
 * Handles Claude events by transforming them to operations and
 * dispatching to appropriate executors.
 *
 * Uses an EventEmitter pattern for communicating with Session/Lifecycle layers:
 * - Subscribe to events via `messageManager.events.on('event-name', handler)`
 * - No more callback parameters in the constructor
 * - Easy to add new event types by updating MessageManagerEventMap
 */

import type { PlatformClient, PlatformPost, PlatformFile } from '../platform/index.js';
import type { PendingQuestionSet, Session } from '../session/types.js';
import type { ClaudeEvent } from '../claude/cli.js';
import { transformEvent, type TransformContext } from './transformer.js';
import { ToolActivityExecutor } from './executors/tool-activity.js';
import { createThreadSink } from './tool-details/thread.js';
import { noneSink } from './tool-details/types.js';
import { isDcmThreadId } from '../platform/utils.js';
import type { ToolActivitySettings } from '../config/types.js';
import { TaskTracker, type PersistedTrackedTask } from './task-tracker.js';
import type { BridgeRequest, BridgeResponse } from '../mcp/decision-bridge.js';
import {
  ContentExecutor,
  TaskListExecutor,
  QuestionApprovalExecutor,
  MessageApprovalExecutor,
  PromptExecutor,
  BugReportExecutor,
  SubagentExecutor,
  SystemExecutor,
} from './executors/index.js';
import type {
  MessageApprovalDecision,
} from './executors/message-approval.js';
import type {
  ContextPromptSelection,
} from './executors/prompt.js';
import type {
  Executor,
  ExecutorContext,
  RegisterPostCallback,
  UpdateLastMessageCallback,
  PendingMessageApproval,
  PendingContextPrompt,
  PendingExistingWorktreePrompt,
  PendingUpdatePrompt,
  PendingRoutinePrompt,
  PendingWatchPrompt,
  PendingBugReport,
} from './executors/types.js';
import { PostTracker } from './post-tracker.js';
import { DefaultContentBreaker } from './content-breaker.js';
import type {
  MessageOperation,
  AppendContentOp,
  FlushOp,
} from './types.js';
import {
  isContentOp,
  isFlushOp,
  isTaskListOp,
  isQuestionOp,
  isApprovalOp,
  isSystemMessageOp,
  isSubagentOp,
  isStatusUpdateOp,
  isLifecycleOp,
  createFlushOp,
  isToolActivityOp,
} from './types.js';
import { createLogger } from '../utils/logger.js';
import { TypedEventEmitter, createMessageManagerEvents } from './message-manager-events.js';
import { postSkippedFilesFeedback, postTranscriptFeedback, type BuiltMessageContent, type SkippedFile } from './streaming/handler.js';
import { formatUserTurn, shouldAttribute } from './user-attribution/index.js';
import { formatSideConversationsForClaude } from './side-conversation/index.js';

const log = createLogger('msg-mgr');

/**
 * Callback to build message content (handles image attachments)
 */
export type BuildMessageContentCallback = (
  text: string,
  platform: PlatformClient,
  files?: PlatformFile[]
) => Promise<BuiltMessageContent>;

/**
 * Callback to start typing indicator
 */
export type StartTypingCallback = () => void;

/**
 * Callback to emit session update events
 */
export type EmitSessionUpdateCallback = (updates: Record<string, unknown>) => void;

/**
 * Options for creating a MessageManager
 *
 * Note: Event-based callbacks have been removed. Instead, subscribe to
 * events on `messageManager.events` after creating the MessageManager.
 *
 * @example
 * const manager = new MessageManager({ platform, postTracker, ... });
 * manager.events.on('question:complete', ({ toolUseId, answers }) => { ... });
 * manager.events.on('approval:complete', ({ toolUseId, approved }) => { ... });
 */
export interface MessageManagerOptions {
  /** The session this MessageManager belongs to (for direct access to Claude CLI, logger, etc.) */
  session: Session;
  platform: PlatformClient;
  postTracker: PostTracker;
  threadId: string;
  sessionId: string;
  worktreePath?: string;
  worktreeBranch?: string;
  registerPost: RegisterPostCallback;
  updateLastMessage: UpdateLastMessageCallback;
  /** Callback to build message content (handles image attachments) */
  buildMessageContent?: BuildMessageContentCallback;
  /** Callback to start typing indicator */
  startTyping?: StartTypingCallback;
  /** Callback to emit session update events */
  emitSessionUpdate?: EmitSessionUpdateCallback;
  /**
   * Delay between the first streaming chunk and flushing, in ms. When undefined,
   * uses MessageManager.DEFAULT_FLUSH_DELAY_MS (500ms). Plumbed from
   * ResolvedLimits.flushDelayMs.
   */
  flushDelayMs?: number;
  /**
   * Per-platform tool rendering (docs/quiet-tools-spec.md). Omitted means
   * `full`: every tool inline, exactly today's behaviour.
   */
  toolActivity?: ToolActivitySettings;
}

/**
 * Message Manager - Orchestrates the operation pipeline
 *
 * Transforms Claude CLI events into operations and dispatches them
 * to the appropriate executors for rendering to the chat platform.
 *
 * Uses TypedEventEmitter for communication with Session/Lifecycle layers.
 * Subscribe to events via `messageManager.events.on('event-name', handler)`.
 */
export class MessageManager {
  private platform: PlatformClient;
  private postTracker: PostTracker;
  private contentBreaker: DefaultContentBreaker;
  private readonly toolActivity: ToolActivitySettings;
  private toolActivityExecutor: ToolActivityExecutor | null = null;

  // Session reference for direct access to Claude CLI, logger, etc.
  private session: Session;

  // Executors
  private contentExecutor: ContentExecutor;
  private taskListExecutor: TaskListExecutor;
  private questionApprovalExecutor: QuestionApprovalExecutor;
  private messageApprovalExecutor: MessageApprovalExecutor;
  private promptExecutor: PromptExecutor;
  private bugReportExecutor: BugReportExecutor;
  private subagentExecutor: SubagentExecutor;
  private systemExecutor: SystemExecutor;

  // Context for transformation
  private sessionId: string;
  private threadId: string;
  private worktreePath?: string;
  private worktreeBranch?: string;

  // Callbacks (only structural, not event-based)
  private registerPost: RegisterPostCallback;
  private updateLastMessage: UpdateLastMessageCallback;
  private buildMessageContentCallback?: BuildMessageContentCallback;
  private startTypingCallback?: StartTypingCallback;
  private emitSessionUpdateCallback?: EmitSessionUpdateCallback;

  // Tool start times for elapsed time calculation
  private toolStartTimes: Map<string, number> = new Map();

  // Accumulated TaskCreate/TaskUpdate state (modern CLIs' incremental task tools)
  private taskTracker = new TaskTracker();

  // Pending decision-bridge requests (modern CLIs block ExitPlanMode /
  // AskUserQuestion on the MCP permission prompt; the MCP server forwards
  // those here and the reaction UI resolves them). At most one of each can be
  // pending — Claude can't have two plans or two question sets in flight.
  private pendingBridgePlan: {
    resolve: (r: BridgeResponse) => void;
    input: Record<string, unknown>;
  } | null = null;
  private pendingBridgeQuestion: {
    resolve: (r: BridgeResponse) => void;
    input: Record<string, unknown>;
  } | null = null;

  // Flush scheduling
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEFAULT_FLUSH_DELAY_MS = 500;
  private readonly flushDelayMs: number;

  /**
   * Event emitter for MessageManager events.
   *
   * Subscribe to events to receive notifications when interactive operations complete:
   *
   * @example
   * manager.events.on('question:complete', ({ toolUseId, answers }) => {
   *   // Send answers back to Claude
   *   session.claude.sendMessage(JSON.stringify(answers));
   * });
   *
   * manager.events.on('approval:complete', ({ toolUseId, approved }) => {
   *   // Handle approval/denial
   *   session.claude.sendMessage(approved ? 'approved' : 'denied');
   * });
   *
   * manager.events.on('message-approval:complete', ({ decision, fromUser, originalMessage }) => {
   *   // Handle message approval from unauthorized user
   * });
   *
   * manager.events.on('context-prompt:complete', ({ selection, queuedPrompt }) => {
   *   // Handle context selection for mid-thread session start
   * });
   *
   * manager.events.on('status:update', (statusInfo) => {
   *   // Update session header with status info
   * });
   */
  public readonly events: TypedEventEmitter;

  constructor(options: MessageManagerOptions) {
    this.session = options.session;
    this.platform = options.platform;
    this.postTracker = options.postTracker;
    this.sessionId = options.sessionId;
    this.threadId = options.threadId;
    this.worktreePath = options.worktreePath;
    this.worktreeBranch = options.worktreeBranch;
    this.registerPost = options.registerPost;
    this.updateLastMessage = options.updateLastMessage;
    this.buildMessageContentCallback = options.buildMessageContent;
    this.startTypingCallback = options.startTyping;
    this.emitSessionUpdateCallback = options.emitSessionUpdate;
    this.flushDelayMs = options.flushDelayMs ?? MessageManager.DEFAULT_FLUSH_DELAY_MS;

    // Create event emitter
    this.events = createMessageManagerEvents();

    // Create content breaker
    this.contentBreaker = new DefaultContentBreaker();

    // Create executors - pass the events emitter for callbacks
    this.contentExecutor = new ContentExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      // Wire up bump callback to call taskListExecutor.bumpAndGetOldPost
      // This returns the old task list post ID so content can reuse it
      onBumpTaskList: async (content: string, ctx: ExecutorContext) => {
        return this.taskListExecutor.bumpAndGetOldPost(ctx, content);
      },
      // When content creates a new post (not reusing task post), bump task list to bottom
      // This ensures task list always stays at the bottom during streaming
      onBumpTaskListToBottom: async () => {
        await this.taskListExecutor.bumpToBottom(this.getExecutorContext());
      },
    });

    this.taskListExecutor = new TaskListExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
    });

    this.questionApprovalExecutor = new QuestionApprovalExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      events: this.events,
    });

    this.messageApprovalExecutor = new MessageApprovalExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      events: this.events,
    });

    this.promptExecutor = new PromptExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      events: this.events,
    });

    this.bugReportExecutor = new BugReportExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      events: this.events,
    });

    this.subagentExecutor = new SubagentExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      // NOTE: We intentionally do NOT bump task list here.
      // The content executor handles all task list bumping when it flushes content.
      // Having two independent bump mechanisms caused race conditions and duplicate task lists.
    });

    this.systemExecutor = new SystemExecutor({
      registerPost: options.registerPost,
      updateLastMessage: options.updateLastMessage,
      events: this.events,
    });

    this.toolActivity = options.toolActivity ?? { activity: 'full', details: 'none' };
    if (this.toolActivity.activity !== 'full') {
      const sink = this.toolActivity.details === 'thread'
        ? createThreadSink({
            contextFor: () => this.toolDetailsContext(),
            // No task-list bump callbacks: a details post must never repurpose the task list.
            makeExecutor: () => new ContentExecutor({ registerPost: options.registerPost, updateLastMessage: () => undefined }),
          })
        : noneSink;
      this.toolActivityExecutor = new ToolActivityExecutor({
        mode: this.toolActivity.activity,
        sink,
        onHeader: (line) => {
          this.contentExecutor.setHeader(line);
          this.scheduleFlush(this.getExecutorContext());
        },
      });
    }
  }

  /**
   * Where a details thread hangs: under the turn's first post in direct
   * channel mode; in a thread session there are no nested threads, so under
   * the session thread itself. Null until that post exists.
   */
  private toolDetailsContext(): ExecutorContext | null {
    // Either way the details wait for the reply post: in direct channel mode
    // because they hang under it, in a thread session so they follow it
    // rather than precede it (Codex review).
    const replyPost = this.contentExecutor.getHeaderPostId();
    if (!replyPost) return null;
    const root = isDcmThreadId(this.threadId) ? replyPost : this.threadId;
    const base = this.getExecutorContext();
    return {
      ...base,
      createPost: async (content, options) => {
        const post = await this.platform.createPost(content, root);
        // Registered for cleanup, but never as the session's latest reply.
        this.registerPost(post.id, { ...options, type: 'tool_details' });
        return post;
      },
    };
  }

  /**
   * Handle a Claude CLI event
   */
  async handleEvent(event: ClaudeEvent): Promise<void> {
    const logger = log.forSession(this.sessionId);

    // Build transformation context
    const transformCtx: TransformContext = {
      sessionId: this.sessionId,
      formatter: this.platform.getFormatter(),
      toolStartTimes: this.toolStartTimes,
      taskTracker: this.taskTracker,
      detailed: true,
      toolActivity: this.toolActivity.activity,
      worktreeInfo: this.worktreePath && this.worktreeBranch
        ? { path: this.worktreePath, branch: this.worktreeBranch }
        : undefined,
    };

    // Transform event to operations
    const ops = transformEvent(event, transformCtx);

    // A non-error TaskCreate result that didn't carry the expected
    // "Task #N created" wording means the CLI's result text drifted — the
    // task tracker silently drops such tasks, so surface it loudly: this is
    // exactly how the task display would go dark again on a future CLI.
    if (this.taskTracker.consumeUnmatchedCreateResultFlag()) {
      logger.warn(
        'TaskCreate result did not match the expected "Task #N created" wording — ' +
        'task dropped from the displayed list. If this repeats, the Claude CLI ' +
        'likely changed its result text and the task display will be incomplete.'
      );
    }

    if (ops.length === 0) {
      // System events are expected to produce no operations (handled separately for compaction/errors)
      if (event.type !== 'system') {
        logger.debug(`No operations from event: ${event.type}`);
      }
      return;
    }

    const opTypes = ops.map(op => op.type).join(', ');
    logger.debug(`Transformed ${event.type} to ${ops.length} operation(s): ${opTypes}`);

    // Log detailed tool information for tool_use events
    if (event.type === 'tool_use' && event.tool_use) {
      const tool = event.tool_use as { name?: string; input?: Record<string, unknown> };
      const toolName = tool.name || 'unknown';
      const toolInput = tool.input || {};

      // Extract a brief description based on common input patterns
      let briefDesc = '';
      if ('file_path' in toolInput) {
        briefDesc = String(toolInput.file_path).slice(0, 50);
      } else if ('command' in toolInput) {
        briefDesc = String(toolInput.command).slice(0, 50);
      } else if ('pattern' in toolInput) {
        briefDesc = String(toolInput.pattern).slice(0, 50);
      } else if ('query' in toolInput) {
        briefDesc = String(toolInput.query).slice(0, 50);
      } else if ('url' in toolInput) {
        briefDesc = String(toolInput.url).slice(0, 50);
      } else if ('content' in toolInput) {
        briefDesc = String(toolInput.content).slice(0, 50);
      } else if ('description' in toolInput) {
        briefDesc = String(toolInput.description).slice(0, 50);
      } else if ('todos' in toolInput && Array.isArray(toolInput.todos)) {
        briefDesc = `${toolInput.todos.length} tasks`;
      }

      if (briefDesc) {
        logger.debug(`Tool: ${toolName} - ${briefDesc}${briefDesc.length >= 50 ? '...' : ''}`);
      } else {
        logger.debug(`Tool: ${toolName}`);
      }
    }

    // Execute each operation
    for (const op of ops) {
      await this.executeOperation(op);
    }
  }

  /**
   * Execute a single operation
   */
  private async executeOperation(op: MessageOperation): Promise<void> {
    const logger = log.forSession(this.sessionId);
    const ctx = this.getExecutorContext();

    try {
      if (isContentOp(op)) {
        await this.handleContentOp(op, ctx);
      } else if (isToolActivityOp(op)) {
        await this.toolActivityExecutor?.execute(op, ctx);
      } else if (isFlushOp(op)) {
        await this.handleFlushOp(op, ctx);
      } else if (isTaskListOp(op)) {
        await this.taskListExecutor.execute(op, ctx);
        // Emit task:update event so sticky message can refresh with new progress
        const completed = op.tasks.filter(t => t.status === 'completed').length;
        const total = op.tasks.length;
        this.events.emit('task:update', {
          completed,
          total,
          allComplete: completed === total && total > 0,
        });
      } else if (isQuestionOp(op) || isApprovalOp(op)) {
        await this.questionApprovalExecutor.execute(op, ctx);
      } else if (isSystemMessageOp(op) || isStatusUpdateOp(op) || isLifecycleOp(op)) {
        await this.systemExecutor.execute(op, ctx);
        // When Claude's turn ends (StatusUpdateOp), finalize the task list
        // This handles cases where Claude forgets to mark the last task as complete
        if (isStatusUpdateOp(op)) {
          logger.debug(`StatusUpdateOp received, finalizing task list (tasksPostId=${this.taskListExecutor.getTasksPostId()?.substring(0, 8) ?? 'none'})`);
          await this.taskListExecutor.finalize(ctx);
        }
      } else if (isSubagentOp(op)) {
        await this.subagentExecutor.execute(op, ctx);
      } else {
        // Type narrowing - if we get here, it means we have an unhandled operation type
        const unknownOp = op as { type: string };
        logger.warn(`Unknown operation type: ${unknownOp.type}`);
      }
    } catch (err) {
      logger.error(`Failed to execute operation ${op.type}: ${err}`);
    }
  }

  /**
   * Handle content append operation
   */
  private async handleContentOp(op: AppendContentOp, ctx: ExecutorContext): Promise<void> {
    // Append content to executor
    await this.contentExecutor.executeAppend(op, ctx);

    // Schedule flush if not already scheduled
    this.scheduleFlush(ctx);
  }

  /**
   * Handle flush operation
   */
  private async handleFlushOp(op: FlushOp, ctx: ExecutorContext): Promise<void> {
    // Cancel any pending scheduled flush
    this.cancelScheduledFlush();

    // Execute the flush
    await this.contentExecutor.executeFlush(op, ctx);

    // The turn's post now exists (if it ever will): deliver the tool details.
    if (op.reason === 'result') {
      await this.toolActivityExecutor?.afterResultFlush(ctx);
    }
  }

  /**
   * Schedule a delayed flush
   */
  private scheduleFlush(ctx: ExecutorContext): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      const flushOp = createFlushOp(this.sessionId, 'soft_threshold');
      await this.contentExecutor.executeFlush(flushOp, ctx);
    }, this.flushDelayMs);
  }

  /**
   * Cancel any pending scheduled flush
   */
  private cancelScheduledFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Force flush any pending content
   */
  async flush(): Promise<void> {
    this.cancelScheduledFlush();
    const flushOp = createFlushOp(this.sessionId, 'explicit');
    await this.contentExecutor.executeFlush(flushOp, this.getExecutorContext());
  }

  /**
   * Get the executor context
   */
  private getExecutorContext(): ExecutorContext {
    return {
      sessionId: this.sessionId,
      threadId: this.threadId,
      platform: this.platform,
      formatter: this.platform.getFormatter(),
      logger: log.forSession(this.sessionId),
      postTracker: this.postTracker,
      contentBreaker: this.contentBreaker,
      threadLogger: this.session.threadLogger,

      // Helper methods that combine create + register + track
      createPost: async (content, options) => {
        const post = await this.platform.createPost(content, this.threadId);
        this.registerPost(post.id, options);
        this.updateLastMessage(post);
        return post;
      },
      createInteractivePost: async (content, reactions, options) => {
        const post = await this.platform.createInteractivePost(content, reactions, this.threadId);
        this.registerPost(post.id, options);
        this.updateLastMessage(post);
        return post;
      },
    };
  }

  /**
   * Update worktree info (e.g., after !cd command)
   */
  setWorktreeInfo(path: string, branch: string): void {
    this.worktreePath = path;
    this.worktreeBranch = branch;
  }

  /**
   * Clear worktree info
   */
  clearWorktreeInfo(): void {
    this.worktreePath = undefined;
    this.worktreeBranch = undefined;
  }

  // ---------------------------------------------------------------------------
  // Delegation to executors
  // ---------------------------------------------------------------------------

  /**
   * Handle a question answer reaction
   */
  async handleQuestionAnswer(postId: string, optionIndex: number): Promise<boolean> {
    return this.questionApprovalExecutor.handleQuestionAnswer(postId, optionIndex, this.getExecutorContext());
  }

  /**
   * Handle an approval response reaction
   */
  async handleApprovalResponse(postId: string, approved: boolean): Promise<boolean> {
    return this.questionApprovalExecutor.handleApprovalResponse(postId, approved, this.getExecutorContext());
  }

  /**
   * Handle a subagent toggle reaction
   */
  async handleSubagentToggle(postId: string, action: 'added' | 'removed'): Promise<boolean> {
    return this.subagentExecutor.handleToggleReaction(postId, action, this.getExecutorContext());
  }

  /**
   * Handle a task list toggle reaction
   */
  async handleTaskListToggle(postId: string, _action: 'added' | 'removed'): Promise<boolean> {
    // Check if this is the task list post
    const state = this.taskListExecutor.getState();
    if (!state.tasksPostId || state.tasksPostId !== postId) {
      return false;
    }
    await this.taskListExecutor.toggleMinimize(this.getExecutorContext());
    return true;
  }

  /**
   * Check if there are pending questions
   */
  hasPendingQuestions(): boolean {
    return this.questionApprovalExecutor.hasPendingQuestions();
  }

  /**
   * Check if there is a pending approval
   */
  hasPendingApproval(): boolean {
    return this.questionApprovalExecutor.hasPendingApproval();
  }

  /**
   * Get pending approval info
   */
  getPendingApproval(): { postId: string; type: string; toolUseId: string } | null {
    return this.questionApprovalExecutor.getPendingApproval();
  }

  /**
   * Get pending question set (full data including questions)
   */
  getPendingQuestionSet(): PendingQuestionSet | null {
    const state = this.questionApprovalExecutor.getState();
    return state.pendingQuestionSet ?? null;
  }

  /**
   * Clear pending approval state
   */
  clearPendingApproval(): void {
    this.questionApprovalExecutor.clearPendingApproval();
  }

  /**
   * Clear pending question set state
   */
  clearPendingQuestionSet(): void {
    this.questionApprovalExecutor.clearPendingQuestionSet();
  }

  /**
   * Advance to the next question in the pending question set
   */
  advanceQuestionIndex(): void {
    this.questionApprovalExecutor.advanceQuestionIndex();
  }

  // ---------------------------------------------------------------------------
  // Message approval delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending message approval state.
   * Called when an unauthorized user sends a message that needs approval.
   */
  setPendingMessageApproval(approval: PendingMessageApproval): void {
    this.messageApprovalExecutor.setPendingMessageApproval(approval);
  }

  /**
   * Get pending message approval state.
   */
  getPendingMessageApproval(): PendingMessageApproval | null {
    return this.messageApprovalExecutor.getPendingMessageApproval();
  }

  /**
   * Check if there's a pending message approval.
   */
  hasPendingMessageApproval(): boolean {
    return this.messageApprovalExecutor.hasPendingMessageApproval();
  }

  /**
   * Clear pending message approval state.
   */
  clearPendingMessageApproval(): void {
    this.messageApprovalExecutor.clearPendingMessageApproval();
  }

  /**
   * Handle a message approval reaction.
   * Returns true if the reaction was handled, false otherwise.
   */
  async handleMessageApprovalResponse(
    postId: string,
    decision: MessageApprovalDecision,
    approver: string
  ): Promise<boolean> {
    return this.messageApprovalExecutor.handleMessageApprovalResponse(
      postId,
      decision,
      approver,
      this.getExecutorContext()
    );
  }

  // ---------------------------------------------------------------------------
  // Context prompt delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending context prompt state.
   * Called when prompting user for thread context inclusion.
   */
  setPendingContextPrompt(prompt: PendingContextPrompt): void {
    this.promptExecutor.setPendingContextPrompt(prompt);
  }

  /**
   * Get pending context prompt state.
   */
  getPendingContextPrompt(): PendingContextPrompt | null {
    return this.promptExecutor.getPendingContextPrompt();
  }

  /**
   * Check if there's a pending context prompt.
   */
  hasPendingContextPrompt(): boolean {
    return this.promptExecutor.hasPendingContextPrompt();
  }

  /**
   * Clear pending context prompt state.
   */
  clearPendingContextPrompt(): void {
    this.promptExecutor.clearPendingContextPrompt();
  }

  /**
   * Handle a context prompt response reaction.
   * Returns true if the reaction was handled, false otherwise.
   *
   * @param postId - The post ID the reaction was on
   * @param selection - The context selection (number of messages, 0 for skip, or 'timeout')
   * @param username - Username of the responder
   */
  async handleContextPromptResponse(
    postId: string,
    selection: ContextPromptSelection,
    username: string
  ): Promise<boolean> {
    return this.promptExecutor.handleContextPromptResponse(
      postId,
      selection,
      username,
      this.getExecutorContext()
    );
  }

  // ---------------------------------------------------------------------------
  // Existing worktree prompt delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending existing worktree prompt state.
   * Called when an existing worktree is found and user must decide to join or skip.
   */
  setPendingExistingWorktreePrompt(prompt: PendingExistingWorktreePrompt): void {
    this.promptExecutor.setPendingExistingWorktreePrompt(prompt);
  }

  /**
   * Get pending existing worktree prompt state.
   */
  getPendingExistingWorktreePrompt(): PendingExistingWorktreePrompt | null {
    return this.promptExecutor.getPendingExistingWorktreePrompt();
  }

  /**
   * Check if there's a pending existing worktree prompt.
   */
  hasPendingExistingWorktreePrompt(): boolean {
    return this.promptExecutor.hasPendingExistingWorktreePrompt();
  }

  /**
   * Clear pending existing worktree prompt state.
   */
  clearPendingExistingWorktreePrompt(): void {
    this.promptExecutor.clearPendingExistingWorktreePrompt();
  }

  // ---------------------------------------------------------------------------
  // Update prompt delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending update prompt state.
   * Called when prompting user about a version update.
   */
  setPendingUpdatePrompt(prompt: PendingUpdatePrompt): void {
    this.promptExecutor.setPendingUpdatePrompt(prompt);
  }

  /**
   * Get pending update prompt state.
   */
  getPendingUpdatePrompt(): PendingUpdatePrompt | null {
    return this.promptExecutor.getPendingUpdatePrompt();
  }

  /**
   * Check if there's a pending update prompt.
   */
  hasPendingUpdatePrompt(): boolean {
    return this.promptExecutor.hasPendingUpdatePrompt();
  }

  /**
   * Clear pending update prompt state.
   */
  clearPendingUpdatePrompt(): void {
    this.promptExecutor.clearPendingUpdatePrompt();
  }

  // ---------------------------------------------------------------------------
  // Routine-creation confirmation delegation
  // ---------------------------------------------------------------------------

  /** Set the pending routine-creation confirmation (one per session). */
  setPendingRoutinePrompt(prompt: PendingRoutinePrompt): void {
    this.promptExecutor.setPendingRoutinePrompt(prompt);
  }

  hasPendingRoutinePrompt(): boolean {
    return this.promptExecutor.hasPendingRoutinePrompt();
  }

  /** Set the pending watch-creation confirmation (one per session). */
  setPendingWatchPrompt(prompt: PendingWatchPrompt): void {
    this.promptExecutor.setPendingWatchPrompt(prompt);
  }

  hasPendingWatchPrompt(): boolean {
    return this.promptExecutor.hasPendingWatchPrompt();
  }

  // ---------------------------------------------------------------------------
  // Bug report delegation
  // ---------------------------------------------------------------------------

  /**
   * Set pending bug report state.
   * Called when a bug report is being reviewed before submission.
   */
  setPendingBugReport(report: PendingBugReport): void {
    this.bugReportExecutor.setPendingBugReport(report);
  }

  /**
   * Get pending bug report state.
   */
  getPendingBugReport(): PendingBugReport | null {
    return this.bugReportExecutor.getPendingBugReport();
  }

  /**
   * Check if there's a pending bug report.
   */
  hasPendingBugReport(): boolean {
    return this.bugReportExecutor.hasPendingBugReport();
  }

  /**
   * Clear pending bug report state.
   */
  clearPendingBugReport(): void {
    this.bugReportExecutor.clearPendingBugReport();
  }

  /**
   * Get the current post ID being updated
   */
  getCurrentPostId(): string | null {
    return this.contentExecutor.getState().currentPostId;
  }

  /**
   * Reset content post state to start next content in a new post.
   * Called after compaction or before sending follow-up messages.
   */
  /**
   * Close the current post, flushing any pending content first.
   * Subsequent content will go to a new post.
   * Called when user sends a message to ensure Claude's response appears below the user's message.
   */
  async closeCurrentPost(): Promise<void> {
    await this.flush();
    this.contentExecutor.closeCurrentPost(this.getExecutorContext());
  }

  /**
   * Get the current post content
   */
  getCurrentPostContent(): string {
    return this.contentExecutor.getState().currentPostContent;
  }

  /**
   * Bump task list to bottom
   */
  async bumpTaskList(): Promise<void> {
    await this.taskListExecutor.bumpToBottom(this.getExecutorContext());
  }

  /**
   * Task list snapshot. Used by callers that read task state outside the
   * persistence writer — sticky-message handler, lifecycle exit cleanup.
   * Persistence itself goes through `serialize()`.
   */
  getTaskListState(): {
    postId: string | null;
    content: string | null;
    isMinimized: boolean;
    isCompleted: boolean;
  } {
    return this.taskListExecutor.serialize();
  }

  /**
   * Aggregate every executor's persistable state into a single payload for
   * `SessionManager.persistSession`. Removes the need for persistSession
   * to reach into individual executors via named getters.
   *
   * Shape is stable: `taskList` always present, `contextPrompt` is `null`
   * when no prompt is pending. The keys are what `PersistedSession` expects,
   * so the writer can spread them straight into the persisted record.
   */
  serialize(): {
    taskList: ReturnType<TaskListExecutor['serialize']>;
    taskTracker: ReturnType<TaskTracker['serialize']>;
    contextPrompt: PendingContextPrompt | null;
  } {
    return {
      taskList: this.taskListExecutor.serialize(),
      taskTracker: this.taskTracker.serialize(),
      contextPrompt: this.promptExecutor.serialize(),
    };
  }

  /**
   * Restore the incremental task tracker from persisted state (session
   * resume). Without this, a resumed session's TaskUpdate calls hit an empty
   * tracker and render "Task #N" placeholder rows instead of real subjects.
   */
  restoreTaskTracker(state: PersistedTrackedTask[] | undefined): void {
    if (state && state.length > 0) {
      this.taskTracker.restore(state);
    }
  }

  /**
   * Hydrate task list state from persisted session data.
   * Called during session resume to restore task list state.
   * NOTE: For session resume, use restoreTaskListFromPersistence() instead,
   * which also bumps the task list to the bottom.
   */
  hydrateTaskListState(persisted: {
    tasksPostId?: string | null;
    lastTasksContent?: string | null;
    tasksCompleted?: boolean;
    tasksMinimized?: boolean;
  }): void {
    this.taskListExecutor.hydrateState(persisted);
  }

  /**
   * Restore task list from persisted session data during resume.
   * This hydrates the state AND bumps active task lists to the bottom.
   *
   * Why bump? Without this, the task list would stay at its old position
   * (above the resume message) which confuses users. Task list should
   * ALWAYS be at the bottom of the thread.
   */
  async restoreTaskListFromPersistence(persisted: {
    tasksPostId?: string | null;
    lastTasksContent?: string | null;
    tasksCompleted?: boolean;
    tasksMinimized?: boolean;
  }): Promise<void> {
    // If task list was completed, don't restore the postId - new tasks should
    // create a fresh post at the bottom, not update the old completed one
    if (persisted.tasksCompleted) {
      this.hydrateTaskListState({
        ...persisted,
        tasksPostId: null,  // Clear so new tasks create fresh post
      });
      return;
    }

    // Hydrate the state for active task lists
    this.hydrateTaskListState(persisted);

    // Bump to bottom if there's an active task list
    if (persisted.tasksPostId && persisted.lastTasksContent) {
      await this.bumpTaskList();
    }
  }

  /**
   * Hydrate interactive state from persisted session data.
   * Called during session resume to restore pending questions/approvals.
   */
  hydrateInteractiveState(persisted: {
    pendingQuestionSet?: {
      toolUseId: string;
      currentIndex: number;
      currentPostId: string | null;
      questions: Array<{
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        answer: string | null;
      }>;
    } | null;
    pendingApproval?: {
      postId: string;
      type: 'plan' | 'action';
      toolUseId: string;
    } | null;
    pendingMessageApproval?: PendingMessageApproval | null;
    pendingContextPrompt?: PendingContextPrompt | null;
    pendingExistingWorktreePrompt?: PendingExistingWorktreePrompt | null;
    pendingUpdatePrompt?: PendingUpdatePrompt | null;
    pendingBugReport?: PendingBugReport | null;
  }): void {
    // Hydrate each executor with its relevant state
    this.questionApprovalExecutor.hydrateState({
      pendingQuestionSet: persisted.pendingQuestionSet,
      pendingApproval: persisted.pendingApproval,
    });

    this.messageApprovalExecutor.hydrateState({
      pendingMessageApproval: persisted.pendingMessageApproval,
    });

    this.promptExecutor.hydrateState({
      pendingContextPrompt: persisted.pendingContextPrompt,
      pendingExistingWorktreePrompt: persisted.pendingExistingWorktreePrompt,
      pendingUpdatePrompt: persisted.pendingUpdatePrompt,
    });

    this.bugReportExecutor.hydrateState({
      pendingBugReport: persisted.pendingBugReport,
    });
  }

  /**
   * Post an info message
   */
  async postInfo(message: string): Promise<PlatformPost | undefined> {
    return this.systemExecutor.postInfo(message, this.getExecutorContext());
  }

  /**
   * Post a warning message
   */
  async postWarning(message: string): Promise<PlatformPost | undefined> {
    return this.systemExecutor.postWarning(message, this.getExecutorContext());
  }

  /**
   * Post an error message with bug reaction for quick error reporting.
   * Matches the behavior of post-helpers/postError().
   */
  async postError(message: string, addBugReaction = true): Promise<PlatformPost | undefined> {
    const post = await this.systemExecutor.postError(message, this.getExecutorContext());

    // Add bug reaction for quick error reporting (matches post-helpers behavior)
    if (post && addBugReaction) {
      try {
        const { BUG_REPORT_EMOJI } = await import('../utils/emoji.js');
        await this.platform.addReaction(post.id, BUG_REPORT_EMOJI);
        // Store error context for potential bug report
        this.session.lastError = {
          postId: post.id,
          message,
          timestamp: new Date(),
        };
      } catch {
        // Ignore if reaction fails - not critical
      }
    }

    return post;
  }

  /**
   * Post a success message
   */
  async postSuccess(message: string): Promise<PlatformPost | undefined> {
    return this.systemExecutor.postSuccess(message, this.getExecutorContext());
  }

  // ---------------------------------------------------------------------------
  // User message handling
  // ---------------------------------------------------------------------------

  /**
   * Prepare the message manager for a new user message.
   * This flushes any pending content, resets the content post state,
   * and bumps the task list to below the user's message.
   *
   * Call this before sending a follow-up message to Claude.
   */
  async prepareForUserMessage(): Promise<void> {
    const logger = log.forSession(this.sessionId);
    logger.debug('Preparing for new user message');

    // Close current post (flushes pending content) so Claude's response
    // starts in a new message below the user's message
    await this.closeCurrentPost();

    // Bump task list below the user's message
    await this.bumpTaskList();
  }

  /**
   * Handle a user message.
   * This is the main entry point for user messages in follow-up mode.
   *
   * The MessageManager handles:
   * - Logging the user message
   * - Preparing for the new message (flush, reset, bump tasks)
   * - Building the message content (with images if provided)
   * - Sending to Claude
   * - Starting typing indicator
   * - Updating activity time
   *
   * @param message - The user's message text
   * @param files - Optional attached files (images)
   * @param username - Username of the sender
   * @param displayName - Display name of the sender (optional)
   * @returns true if message was sent, false if Claude is not running
   */
  async handleUserMessage(
    message: string,
    files?: PlatformFile[],
    username?: string,
    displayName?: string
  ): Promise<boolean> {
    const logger = log.forSession(this.sessionId);

    // Check if Claude is running
    if (!this.session.claude.isRunning()) {
      logger.debug('Claude not running, ignoring user message');
      return false;
    }

    // Log the user message
    this.session.threadLogger?.logUserMessage(
      username || this.session.startedBy,
      message,
      displayName,
      files && files.length > 0
    );

    // Prepare for the new message (flush, reset, bump tasks)
    await this.prepareForUserMessage();

    // Attribute this user turn so Claude can tell who is speaking in a shared
    // thread. Wrap the raw message BEFORE buildMessageContent so any file-list
    // header it prepends stays OUTSIDE the [@user]: prefix. A system/control
    // follow-up carries no username → formatUserTurn returns it unchanged.
    const attributed = formatUserTurn(message, username, shouldAttribute(this.session.userAttribution, this.session.sessionAllowedUsers.size));

    // Prepend any pending side-conversation context OUTSIDE the [@user]: prefix,
    // by the same rule as the file-list header: the prefix must tag only the
    // sender's own turn. The side-conversation block is already self-attributed
    // (`@from to @to`) and explicitly marked "not instructions", so wrapping it
    // under [@sender]: would falsely credit other users' remarks to the sender.
    // These are ephemeral — cleared once composed in.
    let outgoing = attributed;
    if (this.session.pendingSideConversations && this.session.pendingSideConversations.length > 0) {
      outgoing = formatSideConversationsForClaude(this.session.pendingSideConversations) + attributed;
      this.session.pendingSideConversations = [];
    }

    // Build message content (with files if provided). buildMessageContent processes
    // files once and returns both content and any files it had to skip.
    let content: string = outgoing;
    let skippedFiles: SkippedFile[] = [];
    let transcripts: BuiltMessageContent['transcripts'];
    if (this.buildMessageContentCallback) {
      const built = await this.buildMessageContentCallback(outgoing, this.platform, files);
      content = built.content;
      skippedFiles = built.skipped;
      transcripts = built.transcripts;
    }

    // Send to Claude
    this.session.claude.sendMessage(content);

    // Post feedback for skipped files, then echo any voice-note transcripts
    await postSkippedFilesFeedback(this.platform, this.threadId, skippedFiles);
    await postTranscriptFeedback(this.platform, this.threadId, transcripts);

    // Update activity time
    this.session.lastActivityAt = new Date();

    // Mark as processing
    this.session.isProcessing = true;
    this.emitSessionUpdateCallback?.({ status: 'active', isTyping: true });

    // Start typing indicator
    this.startTypingCallback?.();

    logger.debug('User message sent to Claude');
    return true;
  }

  /**
   * Get the session reference (for advanced use cases).
   */
  getSession(): Session {
    return this.session;
  }

  // ---------------------------------------------------------------------------
  // Unified reaction routing
  // ---------------------------------------------------------------------------

  /**
   * Handle a reaction event on any post.
   * Routes to the appropriate executor based on what's pending.
   * This is the single entry point for all reaction handling.
   *
   * @param postId - The post ID the reaction was on
   * @param emoji - The emoji name that was used
   * @param user - Username of the user who reacted
   * @param action - Whether the reaction was 'added' or 'removed'
   * @returns true if the reaction was handled, false otherwise
   */
  /**
   * Executor dispatch order for `handleReaction`. Order matters — earlier
   * entries get the first shot at a reaction and return `true` to short-
   * circuit the rest. Previously this was an if/else chain; encoding it
   * as data makes it obvious when re-ordering and lets `serialize()`
   * iterate the same list for persistence payloads.
   *
   * Each entry includes a name for the dispatch log and the executor
   * instance. `as Executor[]` because TypeScript can't infer the union
   * of concrete classes — they all implement `Executor` but with different
   * state types.
   */
  private reactionDispatchList(): Array<{ name: string; executor: Executor }> {
    return [
      { name: 'QuestionApprovalExecutor', executor: this.questionApprovalExecutor as Executor },
      { name: 'MessageApprovalExecutor',  executor: this.messageApprovalExecutor as Executor },
      { name: 'PromptExecutor',           executor: this.promptExecutor as Executor },
      { name: 'BugReportExecutor',        executor: this.bugReportExecutor as Executor },
      { name: 'TaskListExecutor',         executor: this.taskListExecutor as Executor },
      { name: 'SubagentExecutor',         executor: this.subagentExecutor as Executor },
    ];
  }

  async handleReaction(
    postId: string,
    emoji: string,
    user: string,
    action: 'added' | 'removed'
  ): Promise<boolean> {
    const logger = log.forSession(this.sessionId);
    const ctx = this.getExecutorContext();

    logger.debug(`Routing reaction: postId=${postId}, emoji=${emoji}, user=${user}, action=${action}`);

    for (const { name, executor } of this.reactionDispatchList()) {
      if (!executor.handleReaction) continue;
      if (await executor.handleReaction(postId, emoji, user, action, ctx)) {
        logger.debug(`Reaction handled by ${name}`);
        return true;
      }
    }

    logger.debug('Reaction not handled by any executor');
    return false;
  }

  // ---------------------------------------------------------------------------
  // Decision bridge (see src/mcp/decision-bridge.ts)
  // ---------------------------------------------------------------------------

  /**
   * Handle a decision request forwarded by the MCP permission server. The
   * promise resolves when the user reacts on the corresponding UI (the plan
   * post's 👍/👎 or the question posts' option reactions) — via
   * `resolveBridgePlan` / `resolveBridgeQuestion` called from the lifecycle
   * completion listeners and the `!approve` command. The MCP client enforces the timeout; a session that
   * ends first denies any pending request via `denyPendingBridgeRequests`.
   */
  handleBridgeRequest(request: BridgeRequest, signal?: AbortSignal): Promise<BridgeResponse> {
    if (request.kind === 'plan_approval') {
      // A second plan request while one is pending means the first was
      // abandoned (interrupted turn); deny it so the MCP child isn't stranded.
      this.pendingBridgePlan?.resolve({ behavior: 'deny', message: 'Superseded by a newer plan' });
      return new Promise<BridgeResponse>((resolve) => {
        const pending = { resolve, input: request.input };
        this.pendingBridgePlan = pending;
        // The requesting side died (timeout, cancelled tool call, dead MCP
        // child): clear the pending WITHOUT consuming a future decision — a
        // stale pending would swallow the user's eventual reaction and
        // suppress the stdin fallback that should carry it instead.
        signal?.addEventListener('abort', () => {
          if (this.pendingBridgePlan === pending) this.pendingBridgePlan = null;
        });
      });
    }
    if (request.kind === 'question') {
      this.pendingBridgeQuestion?.resolve({ behavior: 'deny', message: 'Superseded by newer questions' });
      return new Promise<BridgeResponse>((resolve) => {
        const pending = { resolve, input: request.input };
        this.pendingBridgeQuestion = pending;
        signal?.addEventListener('abort', () => {
          if (this.pendingBridgeQuestion === pending) this.pendingBridgeQuestion = null;
        });
      });
    }
    return Promise.resolve({ behavior: 'deny', message: `Unknown bridge request kind` });
  }

  /**
   * Feed a plan approval decision to a waiting bridge request. Returns true
   * when a bridge request consumed it — the caller must then NOT also send
   * 'approved'/'denied' over stdin (the CLI already delivers the outcome to
   * Claude through the tool result; a stdin echo would arrive as a stray
   * user message).
   */
  resolveBridgePlan(approved: boolean): boolean {
    const pending = this.pendingBridgePlan;
    if (!pending) return false;
    this.pendingBridgePlan = null;
    pending.resolve(
      approved
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: 'The user rejected the plan.' }
    );
    return true;
  }

  /**
   * Feed collected question answers to a waiting bridge request. Answers are
   * keyed by question header in the bot's UI; the CLI expects
   * `updatedInput.answers` keyed by question TEXT (verified empirically on
   * 2.1.223: the tool then resolves as "Your questions have been answered").
   * Returns true when a bridge request consumed the answers.
   */
  resolveBridgeQuestion(answers: Array<{ header: string; answer: string }>): boolean {
    const pending = this.pendingBridgeQuestion;
    if (!pending) return false;
    this.pendingBridgeQuestion = null;

    const questions = Array.isArray(pending.input.questions)
      ? (pending.input.questions as Array<{ question?: string; header?: string }>)
      : [];
    const record: Record<string, string> = {};
    for (const a of answers) {
      const match = questions.find(q => q.header === a.header);
      record[match?.question ?? a.header] = a.answer;
    }
    pending.resolve({
      behavior: 'allow',
      updatedInput: { ...pending.input, answers: record },
    });
    return true;
  }

  /**
   * Deny any in-flight bridge requests. Called when the session ends or all
   * state is reset so the MCP child never waits on a decision that can no
   * longer arrive.
   */
  denyPendingBridgeRequests(reason: string): void {
    this.pendingBridgePlan?.resolve({ behavior: 'deny', message: reason });
    this.pendingBridgePlan = null;
    this.pendingBridgeQuestion?.resolve({ behavior: 'deny', message: reason });
    this.pendingBridgeQuestion = null;
  }

  /**
   * Clear per-CLI-session state (tool timings, accumulated task tracking)
   * without touching posted-message state. Must be called whenever Claude is
   * respawned as a FRESH session (`resume: false` — !cd, worktree switch):
   * the new CLI session numbers its tasks from #1 again, so stale tracker
   * entries would collide with the new ids and corrupt task updates. Resume
   * restarts (e.g. !permissions) must NOT call this — the resumed session
   * keeps its task numbering.
   */
  clearClaudeSessionState(): void {
    this.toolStartTimes.clear();
    this.taskTracker.clear();
    // A fresh CLI session also means a fresh MCP child — any decision request
    // still pending from the old one can never be answered usefully.
    this.denyPendingBridgeRequests('Claude was restarted before a decision was made');
  }

  /**
   * Reset all state (for session restart)
   */
  reset(): void {
    this.cancelScheduledFlush();
    this.toolStartTimes.clear();
    this.taskTracker.clear();
    this.contentExecutor.reset();
    this.toolActivityExecutor?.reset();
    this.taskListExecutor.reset();
    this.questionApprovalExecutor.reset();
    this.messageApprovalExecutor.reset();
    this.promptExecutor.reset();
    this.bugReportExecutor.reset();
    this.subagentExecutor.reset();
    this.systemExecutor.reset();
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.denyPendingBridgeRequests('Session ended before a decision was made');
    this.cancelScheduledFlush();
    this.postTracker.clearSession(this.sessionId);
    // Remove all listeners attached to this session's per-instance emitter.
    // Without this the closures held by listeners keep session state alive
    // after the session ends, leaking across many sessions.
    this.events.removeAllListeners();
    this.reset();
  }
}
