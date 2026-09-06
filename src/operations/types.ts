/**
 * Operation Types - Intermediate representation for message operations
 *
 * These types represent the operations that need to be performed on
 * chat platforms, separated from the Claude CLI event format.
 * This separation allows:
 * - Clean testing of event transformation
 * - Platform-agnostic operation definitions
 * - Potential operation batching and optimization
 */

// ---------------------------------------------------------------------------
// Base Operation
// ---------------------------------------------------------------------------

/**
 * Base interface for all operations.
 */
export interface BaseOperation {
  /** Operation type discriminator */
  readonly type: string;
  /** Session ID this operation belongs to */
  readonly sessionId: string;
  /** Timestamp when the operation was created */
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Content Operations
// ---------------------------------------------------------------------------

/**
 * Append content to the current streaming message.
 */
export interface AppendContentOp extends BaseOperation {
  readonly type: 'append_content';
  /** Content to append (raw markdown) */
  readonly content: string;
  /** Whether this content includes tool use formatting */
  readonly isToolOutput?: boolean;
}

/**
 * Flush pending content to the platform.
 */
export interface FlushOp extends BaseOperation {
  readonly type: 'flush';
  /** Reason for the flush */
  readonly reason:
    | 'soft_threshold'     // Content exceeded soft threshold
    | 'hard_threshold'     // Content hit hard limit
    | 'logical_break'      // Natural breakpoint found
    | 'result'             // Claude finished (result event)
    | 'tool_complete'      // Tool execution completed
    | 'explicit';          // Explicit flush request
  /** With reason `result` only: whether the turn ended without an error. */
  readonly resultOk?: boolean;
}

// ---------------------------------------------------------------------------
// Task List Operations
// ---------------------------------------------------------------------------

/**
 * Task definition from TodoWrite events.
 */
export interface TaskItem {
  /** Task description */
  content: string;
  /** Current status */
  status: 'pending' | 'in_progress' | 'completed';
  /** Active form (present continuous) for display while in progress */
  activeForm: string;
}

/**
 * Update the task list display.
 */
export interface TaskListOp extends BaseOperation {
  readonly type: 'task_list';
  /** Action to perform */
  readonly action:
    | 'update'           // Update task list content
    | 'bump_to_bottom'   // Move task list to bottom of thread
    | 'toggle_minimize'  // Toggle minimized state
    | 'complete';        // All tasks completed
  /** Current tasks */
  readonly tasks: TaskItem[];
  /** Tool use ID for the TodoWrite call */
  readonly toolUseId?: string;
}

// ---------------------------------------------------------------------------
// Interactive Operations
// ---------------------------------------------------------------------------

/**
 * Question option for AskUserQuestion.
 */
export interface QuestionOption {
  /** Display label */
  label: string;
  /** Description shown under the label */
  description: string;
}

/**
 * Single question in a question set.
 */
export interface Question {
  /** Short header/category */
  header: string;
  /** Full question text */
  question: string;
  /** Available options */
  options: QuestionOption[];
  /** Whether multiple selections are allowed */
  multiSelect: boolean;
}

/**
 * Post a question for user response.
 */
export interface QuestionOp extends BaseOperation {
  readonly type: 'question';
  /** Tool use ID for sending the response */
  readonly toolUseId: string;
  /** Questions to ask */
  readonly questions: Question[];
  /** Current question index (0-based) */
  readonly currentIndex: number;
}

/**
 * Request approval for an action or plan.
 */
export interface ApprovalOp extends BaseOperation {
  readonly type: 'approval';
  /** Tool use ID for sending the response */
  readonly toolUseId: string;
  /** Type of approval needed */
  readonly approvalType: 'plan' | 'action';
  /** Content being approved (plan content, action description) */
  readonly content?: string;
}

// ---------------------------------------------------------------------------
// System Message Operations
// ---------------------------------------------------------------------------

/**
 * Severity level for system messages.
 */
export type SystemMessageLevel = 'info' | 'warning' | 'error' | 'success';

/**
 * Post a system message (not from Claude).
 */
export interface SystemMessageOp extends BaseOperation {
  readonly type: 'system_message';
  /** Message content */
  readonly message: string;
  /** Severity level */
  readonly level: SystemMessageLevel;
  /** Whether this is an ephemeral message (may be deleted later) */
  readonly ephemeral?: boolean;
}

// ---------------------------------------------------------------------------
// Subagent Operations
// ---------------------------------------------------------------------------

/**
 * Subagent status update.
 */
export interface SubagentOp extends BaseOperation {
  readonly type: 'subagent';
  /** Tool use ID for the subagent */
  readonly toolUseId: string;
  /** Action to perform */
  readonly action:
    | 'start'            // Subagent started
    | 'update'           // Update description/status
    | 'complete'         // Subagent completed
    | 'toggle_minimize'; // Toggle minimized state
  /** Subagent description/prompt */
  readonly description: string;
  /** Subagent type (e.g., 'Explore', 'general-purpose') */
  readonly subagentType: string;
  /** Whether currently minimized */
  readonly isMinimized?: boolean;
  /** Result content (on complete) */
  readonly result?: string;
}

// ---------------------------------------------------------------------------
// Status Operations
// ---------------------------------------------------------------------------

/**
 * Update session status (context usage, model info, etc.).
 */
export interface StatusUpdateOp extends BaseOperation {
  readonly type: 'status_update';
  /** Primary model ID */
  readonly modelId?: string;
  /** Model display name */
  readonly modelDisplayName?: string;
  /** Context window size */
  readonly contextWindowSize?: number;
  /** Current context tokens used */
  readonly contextTokens?: number;
  /** Total cost in USD */
  readonly totalCostUSD?: number;
}

// ---------------------------------------------------------------------------
// Lifecycle Operations
// ---------------------------------------------------------------------------

/**
 * Session lifecycle events.
 */
export interface LifecycleOp extends BaseOperation {
  readonly type: 'lifecycle';
  /** Lifecycle event */
  readonly event:
    | 'started'          // Session started
    | 'processing'       // Claude is processing
    | 'idle'             // Claude finished, waiting for input
    | 'paused'           // Session paused (timeout warning)
    | 'resumed'          // Session resumed
    | 'ending';          // Session about to end
}

// ---------------------------------------------------------------------------
// Union Type
// ---------------------------------------------------------------------------

/**
 * All message operations.
 */
export type MessageOperation =
  | AppendContentOp
  | FlushOp
  | TaskListOp
  | QuestionOp
  | ApprovalOp
  | SystemMessageOp
  | SubagentOp
  | StatusUpdateOp
  | LifecycleOp;

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Check if an operation is a content operation.
 */
export function isContentOp(op: MessageOperation): op is AppendContentOp {
  return op.type === 'append_content';
}

/**
 * Check if an operation is a flush operation.
 */
export function isFlushOp(op: MessageOperation): op is FlushOp {
  return op.type === 'flush';
}

/**
 * Check if an operation is a task list operation.
 */
export function isTaskListOp(op: MessageOperation): op is TaskListOp {
  return op.type === 'task_list';
}

/**
 * Check if an operation is a question operation.
 */
export function isQuestionOp(op: MessageOperation): op is QuestionOp {
  return op.type === 'question';
}

/**
 * Check if an operation is an approval operation.
 */
export function isApprovalOp(op: MessageOperation): op is ApprovalOp {
  return op.type === 'approval';
}

/**
 * Check if an operation is a system message operation.
 */
export function isSystemMessageOp(op: MessageOperation): op is SystemMessageOp {
  return op.type === 'system_message';
}

/**
 * Check if an operation is a subagent operation.
 */
export function isSubagentOp(op: MessageOperation): op is SubagentOp {
  return op.type === 'subagent';
}

/**
 * Check if an operation is a status update operation.
 */
export function isStatusUpdateOp(op: MessageOperation): op is StatusUpdateOp {
  return op.type === 'status_update';
}

/**
 * Check if an operation is a lifecycle operation.
 */
export function isLifecycleOp(op: MessageOperation): op is LifecycleOp {
  return op.type === 'lifecycle';
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create an append content operation.
 */
export function createAppendContentOp(
  sessionId: string,
  content: string,
  isToolOutput?: boolean
): AppendContentOp {
  return {
    type: 'append_content',
    sessionId,
    timestamp: Date.now(),
    content,
    isToolOutput,
  };
}

/**
 * Create a flush operation.
 */
export function createFlushOp(
  sessionId: string,
  reason: FlushOp['reason'],
  resultOk?: boolean
): FlushOp {
  return {
    type: 'flush',
    sessionId,
    timestamp: Date.now(),
    reason,
    ...(resultOk === undefined ? {} : { resultOk }),
  };
}

/**
 * Create a task list operation.
 */
export function createTaskListOp(
  sessionId: string,
  action: TaskListOp['action'],
  tasks: TaskItem[],
  toolUseId?: string
): TaskListOp {
  return {
    type: 'task_list',
    sessionId,
    timestamp: Date.now(),
    action,
    tasks,
    toolUseId,
  };
}

/**
 * Create a question operation.
 */
export function createQuestionOp(
  sessionId: string,
  toolUseId: string,
  questions: Question[],
  currentIndex: number = 0
): QuestionOp {
  return {
    type: 'question',
    sessionId,
    timestamp: Date.now(),
    toolUseId,
    questions,
    currentIndex,
  };
}

/**
 * Create an approval operation.
 */
export function createApprovalOp(
  sessionId: string,
  toolUseId: string,
  approvalType: ApprovalOp['approvalType'],
  content?: string
): ApprovalOp {
  return {
    type: 'approval',
    sessionId,
    timestamp: Date.now(),
    toolUseId,
    approvalType,
    content,
  };
}

/**
 * Create a subagent operation.
 */
export function createSubagentOp(
  sessionId: string,
  toolUseId: string,
  action: SubagentOp['action'],
  description: string,
  subagentType: string,
  options?: { isMinimized?: boolean; result?: string }
): SubagentOp {
  return {
    type: 'subagent',
    sessionId,
    timestamp: Date.now(),
    toolUseId,
    action,
    description,
    subagentType,
    isMinimized: options?.isMinimized,
    result: options?.result,
  };
}

/**
 * Create a status update operation.
 */
export function createStatusUpdateOp(
  sessionId: string,
  options: Partial<Omit<StatusUpdateOp, 'type' | 'sessionId' | 'timestamp'>>
): StatusUpdateOp {
  return {
    type: 'status_update',
    sessionId,
    timestamp: Date.now(),
    ...options,
  };
}

