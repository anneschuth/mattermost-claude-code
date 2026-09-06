/**
 * Session lifecycle management module
 *
 * Handles session start, resume, exit, cleanup, and shutdown.
 */

import type { Session, InitialSessionOptions } from './types.js';
import {
  createSessionTimers,
  createSessionLifecycle,
  createResumedLifecycle,
  transitionTo,
  isSessionRestarting,
  isSessionCancelled,
} from './types.js';
import type { OverheadVisibility, PermissionMode } from '../config/index.js';
import { DEFAULT_OVERHEAD_VISIBILITY } from '../config/index.js';
import { clearAllTimers } from './timer-manager.js';
import { isDcmThreadId, resolveApprovals } from '../platform/utils.js';
import { isAuthorizedForSession, sessionAllowedUserSet } from './authorization.js';
import type { PlatformClient, PlatformFile } from '../platform/index.js';
import type { ClaudeCliOptions, ClaudeEvent, RateLimitHit } from '../claude/cli.js';
import { DecisionBridgeServer, BridgeUnavailableError } from '../mcp/decision-bridge.js';
import { ClaudeCli } from '../claude/cli.js';
import { cooldownDeadline } from '../claude/rate-limit-detector.js';
import { isRevivable } from '../persistence/session-store.js';
import type { PersistedSession } from '../persistence/session-store.js';
import { createThreadLogger } from '../persistence/thread-logger.js';
import { VERSION } from '../version.js';
import {
  generateChatPlatformPrompt,
  buildAppendSystemPrompt,
} from '../commands/index.js';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { keepAlive } from '../utils/keep-alive.js';
import { logAndNotify, withErrorHandling } from '../utils/error-handler/index.js';
import { createLogger } from '../utils/logger.js';
import { createSessionLog } from '../utils/session-log.js';
import { post, postError, updateLastMessage } from '../operations/post-helpers/index.js';
import { postResumeCoAuthorOnboarding } from '../operations/commands/handler.js';
import type { SessionContext } from '../operations/session-context/index.js';
import { fireMetadataSuggestions, maybeInjectMetadataReminder } from './metadata-suggestions.js';
import { MessageManager, PostTracker } from '../operations/index.js';
import {
  getThreadMessagesForContext,
  formatContextForClaude,
} from '../operations/context-prompt/index.js';
import { formatUserTurn, shouldAttribute } from '../operations/user-attribution/index.js';
import {
  cleanupSessionUploads,
  getSessionUploadDir,
  postSkippedFilesFeedback,
  postTranscriptFeedback,
} from '../operations/streaming/handler.js';
import { takeContextPromptFiles } from '../operations/context-prompt/handler.js';
import { detectWorktreeInfo } from '../git/worktree.js';
import { resolveSessionMemory, activeWorktreeRepoRoot } from '../memory/store.js';
import { scheduleDistillation } from '../memory/distiller.js';
import { auditLog } from '../persistence/audit-log.js';
import { compositeSessionId } from './registry.js';
import { sessionAgentFeatures } from '../claude/restart-options.js';
import { handleAgentAction } from '../operations/agent-actions/handler.js';

const log = createLogger('lifecycle');
const sessionLog = createSessionLog(log);

// ---------------------------------------------------------------------------
// Internal helpers for DRY code
// ---------------------------------------------------------------------------

/**
 * Get sessions map with correct mutable type.
 * Reduces type casting noise throughout the module.
 */
function mutableSessions(ctx: SessionContext): Map<string, Session> {
  return ctx.state.sessions as Map<string, Session>;
}

/**
 * Count of startSession() calls that have passed the maxSessions cap check but
 * haven't yet committed themselves to the sessions map. Every await between
 * the check and the commit is a window where a concurrent startSession can
 * also pass the check, so we count reservations synchronously alongside the
 * map's size. Every exit path in startSession decrements via releasePendingStart().
 */
let pendingStartsCount = 0;

function releasePendingStart(): void {
  if (pendingStartsCount > 0) pendingStartsCount--;
}

/**
 * In-flight session starts/resumes keyed by composite session id
 * (`platformId:threadId`). Two messages arriving during an asynchronous start
 * must not spawn two Claude processes for the same key — likely in direct
 * channel mode, where every channel message maps to the same synthetic key,
 * but the window also exists for two quick replies in a brand-new thread.
 * Exported with an underscore for tests only.
 */
export const _inFlightSessionStarts = new Map<string, Promise<void>>();

/**
 * True while a start/resume for this composite session id is in flight but
 * not yet registered in `ctx.state.sessions`. Unattended callers (watch
 * fires) must treat an in-flight start like an existing session: calling
 * startSession during the window would deliver their synthetic prompt into
 * the other start's session as a follow-up.
 */
export function isSessionStartInFlight(sessionId: string): boolean {
  return _inFlightSessionStarts.has(sessionId);
}

/**
 * Shared body of the routine/watch creation-confirmation listeners: audit,
 * thread-log, and — on approval — a crash-guarded store write followed by a
 * confirmation-card update. EventEmitter never awaits listeners, so the
 * store write is try/caught into the visible-failure path: an fs error at
 * 👍-time must not become a process-killing unhandled rejection.
 */
/**
 * Effective unattended flag for a resumed session. The flag is
 * security-load-bearing (it gates the agent memory-write and propose_*
 * tools), and sessions persisted by a pre-agent-tools bot have no
 * `unattended` field — failing OPEN there would re-arm exactly the
 * sessions the gate targets during an upgrade. Fall back to the
 * unattended prompt prefix both runners stamp on their synthetic first
 * prompt (stable since the features shipped).
 */
export function _resumedUnattended(state: PersistedSession): boolean {
  if (state.unattended !== undefined) return state.unattended;
  return /^\[(Scheduled routine|Watch) "/.test(state.firstPrompt ?? '');
}

// Exported for tests (underscore convention, cf. _inFlightSessionStarts):
// the agent-proposal approval gate below is a security boundary and needs
// direct red-green coverage.
export async function _handleCreationConfirmation(
  session: Session,
  payload: { approved: boolean; parsed: { name: string }; requestedBy: string; decidedBy: string; postId: string; proposedByAgent?: boolean; requireApproval?: boolean },
  flavor: {
    /** Audit tool name and user-facing noun ('routine' | 'watch'). */
    tool: string;
    /** Log prefix incl. emoji (e.g. '🕘 Routine'). */
    logPrefix: string;
    /** Store file noun for the write-failure message ('routines' | 'watches'). */
    fileNoun: string;
    /** Perform the store write; returns the saved name and list position. */
    save(): Promise<{ ok: true; name: string; position: number } | { ok: false; error: string }>;
    /** Confirmation-card text for a successful save. */
    savedText(formatter: ReturnType<Session['platform']['getFormatter']>, position: number, name: string): string;
  },
): Promise<void> {
  const { approved, parsed, requestedBy, decidedBy, postId, proposedByAgent } = payload;
  // Agent proposals skip the owner gate the `!routine`/`!watch` commands
  // apply at REQUEST time (Claude has no requesting user to gate), so the
  // equivalent gate applies at APPROVAL time: only the session owner or a
  // platform-allowlisted user may approve — a temporarily `!invite`d guest
  // passes the reaction-router's participant check but must not be able to
  // stand up unattended work running as the owner.
  if (proposedByAgent && approved &&
      decidedBy !== session.startedBy && !session.platform.isUserAllowed(decidedBy)) {
    auditLog(session.platformId, {
      threadId: session.threadId,
      sessionId: session.sessionId,
      actor: decidedBy,
      kind: 'command',
      tool: flavor.tool,
      detail: `unauthorized-approval: ${parsed.name} (proposed by Claude in @${requestedBy}'s session)`,
    });
    const fmt = session.platform.getFormatter();
    await withErrorHandling(
      () => session.platform.updatePost(
        postId,
        `⚠️ Only ${fmt.formatUserMention(session.startedBy)} or allowed users can approve a ${flavor.tool} Claude proposed — nothing was saved.`,
      ),
      { action: `Update ${flavor.tool} confirmation post`, session },
    );
    sessionLog(session).warn(`${flavor.logPrefix} agent proposal "${parsed.name}": unauthorized approval by @${decidedBy} refused`);
    return;
  }
  // The actor is the user whose REACTION decided the confirmation — the
  // requester is carried in the detail. Matches plan approvals, which audit
  // the reacting user; an auditor asking "who approved this unattended
  // trigger" must get the decider.
  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: decidedBy,
    kind: 'command',
    tool: flavor.tool,
    detail: `${approved ? 'created' : 'discarded'}: ${parsed.name} (${proposedByAgent ? `proposed by Claude in @${requestedBy}'s session` : `requested by @${requestedBy}`})`,
  });
  session.threadLogger?.logCommand(flavor.tool, approved ? 'created' : 'discarded', decidedBy);
  if (!approved) {
    sessionLog(session).info(`${flavor.logPrefix} "${parsed.name}" discarded before saving`);
    return;
  }
  let result: { ok: true; name: string; position: number } | { ok: false; error: string };
  try {
    result = await flavor.save();
  } catch (err) {
    result = { ok: false, error: `could not write the ${flavor.fileNoun} file (${(err as Error).message})` };
  }
  const formatter = session.platform.getFormatter();
  if (result.ok) {
    const { position, name } = result;
    await withErrorHandling(
      () => session.platform.updatePost(postId, flavor.savedText(formatter, position, name)),
      { action: `Update ${flavor.tool} confirmation post`, session },
    );
    sessionLog(session).info(`${flavor.logPrefix} "${name}" saved by @${requestedBy}`);
  } else {
    const { error } = result;
    await withErrorHandling(
      () => session.platform.updatePost(postId, `⚠️ Could not save ${flavor.tool}: ${error}`),
      { action: `Update ${flavor.tool} confirmation post`, session },
    );
    sessionLog(session).warn(`${flavor.logPrefix} save failed: ${error}`);
  }
}

/**
 * Get postIndex map with correct mutable type.
 * Reduces type casting noise throughout the module.
 */
function mutablePostIndex(ctx: SessionContext): Map<string, string> {
  return ctx.state.postIndex as Map<string, string>;
}

/**
 * Clean up session timers (updateTimer, typingTimer, statusBarTimer).
 * Call this before removing a session from the map.
 */
function cleanupSessionTimers(session: Session): void {
  clearAllTimers(session.timers);
}

/**
 * Close the thread logger for a session.
 * Call this before removing a session from the map.
 */
/**
 * Record the session's end in the audit trail exactly once, no matter which
 * cleanup path(s) run (cleanupSession, removeFromRegistry, inline failure
 * cleanups can overlap).
 */
function auditSessionEnd(session: Session, reason: string): void {
  if (session.auditEndRecorded) return;
  session.auditEndRecorded = true;
  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: session.lastActorUsername ?? session.startedBy,
    kind: 'session_end',
    detail: reason,
  });
}

async function closeThreadLogger(session: Session, action?: string, details?: Record<string, unknown>, auditReason?: string): Promise<void> {
  // The audit reason can be more specific than the logger action (e.g. action
  // 'kill' with reason 'timeout') — without the override, the exactly-once
  // guard makes this first write win and the precise cause is lost.
  if (auditReason ?? action) {
    auditSessionEnd(session, (auditReason ?? action) as string);
  }
  if (session.threadLogger) {
    // Log the lifecycle event before closing
    if (action) {
      session.threadLogger.logLifecycle(action as 'exit' | 'timeout' | 'interrupt' | 'kill', details);
    }
    await session.threadLogger.close();
  }
}

/**
 * Remove all postIndex entries for a given threadId.
 * Call this when cleaning up a session.
 */
function cleanupPostIndex(ctx: SessionContext, threadId: string): void {
  const postIndex = mutablePostIndex(ctx);
  for (const [postId, tid] of postIndex.entries()) {
    if (tid === threadId) {
      postIndex.delete(postId);
    }
  }
}

/**
 * Format an approved message with source attribution.
 * Similar to context message formatting, this tells Claude who sent the message
 * and who approved it, so Claude knows it came from a different user.
 *
 * @param originalMessage - The original message content
 * @param fromUser - The user who sent the message
 * @param approvedBy - The user who approved the message
 * @returns Formatted message with source attribution
 */
function formatApprovedMessage(originalMessage: string, fromUser: string, approvedBy: string): string {
  return `[Message from @${fromUser}, approved by @${approvedBy}]\n${originalMessage}`;
}

/**
 * Options for cleanupSession helper.
 */
interface CleanupSessionOptions {
  /** Lifecycle action for thread logger (e.g., 'exit', 'interrupt', 'kill') */
  action?: 'exit' | 'timeout' | 'interrupt' | 'kill';
  /** Additional details for thread logger */
  details?: Record<string, unknown>;
  /** Whether to close thread logger (default: true) */
  closeLogger?: boolean;
  /** Whether to clean up post index entries (default: true) */
  cleanupPostIndex?: boolean;
  /** Audit-trail cause when it is more specific than `action` (e.g. 'shutdown') */
  auditReason?: string;
}

/**
 * Clean up a session completely - stop timers, close logger, remove from registry.
 *
 * This consolidates the cleanup sequence that was previously duplicated across
 * multiple exit paths in the file.
 *
 * @param session - The session to clean up
 * @param ctx - Session context for state access
 * @param options - Cleanup options (action for logger, whether to clean post index)
 */
async function cleanupSession(
  session: Session,
  ctx: SessionContext,
  options: CleanupSessionOptions = {}
): Promise<void> {
  const {
    action,
    details,
    closeLogger: doCloseLogger = true,
    cleanupPostIndex: doCleanupPostIndex = true,
    auditReason,
  } = options;

  ctx.ops.stopTyping(session);
  cleanupSessionTimers(session);
  if (doCloseLogger) {
    await closeThreadLogger(session, action, details, auditReason);
  } else if (auditReason ?? action) {
    auditSessionEnd(session, (auditReason ?? action) as string);
  }
  session.messageManager?.dispose();
  void session.decisionBridge?.close();
  session.decisionBridge = undefined;
  ctx.ops.emitSessionRemove(session.sessionId);
  mutableSessions(ctx).delete(session.sessionId);
  if (doCleanupPostIndex) {
    cleanupPostIndex(ctx, session.threadId);
  }
  keepAlive.sessionEnded();
  releaseAccountIfHeld(session, ctx);
  // One-place rule, like releaseAccountIfHeld: every exit path must drop the
  // worktree reference or early exits leak it and block cleanup until restart.
  // unregisterWorktreeUser is set-based, so paths that already unregistered
  // are unaffected.
  if (session.worktreeInfo) {
    ctx.ops.unregisterWorktreeUser(session.worktreeInfo.worktreePath, session.sessionId);
  }
  await cleanupSessionUploads(session.platformId, session.threadId);
}

/**
 * Release the session's Claude account slot, if one was acquired. Safe to call
 * on every exit path — no-op in single-account mode or if the session never
 * held an account. This is the one-place rule that keeps pool accounting
 * honest across the many early-exit / failure branches.
 */
function releaseAccountIfHeld(session: Session, ctx: SessionContext): void {
  if (session.claudeAccountId) {
    ctx.ops.releaseClaudeAccount(session.claudeAccountId);
    // Guard against double-release: once released, stop tracking the id on
    // the session so a later cleanup path can't decrement again.
    session.claudeAccountId = undefined;
  }
}

/**
 * Remove a session from the registry (maps) and notify keep-alive.
 *
 * This is a lightweight cleanup helper for cases where timers and logger
 * are already handled separately (e.g., interrupted sessions that need
 * to post messages between cleanup steps).
 *
 * @param session - The session to remove from registry
 * @param ctx - Session context for state access
 */
function removeFromRegistry(session: Session, ctx: SessionContext, auditReason?: string): void {
  if (auditReason) auditSessionEnd(session, auditReason);
  session.messageManager?.dispose();
  void session.decisionBridge?.close();
  session.decisionBridge = undefined;
  ctx.ops.emitSessionRemove(session.sessionId);
  mutableSessions(ctx).delete(session.sessionId);
  cleanupPostIndex(ctx, session.threadId);
  keepAlive.sessionEnded();
  releaseAccountIfHeld(session, ctx);
}

/**
 * React to a rate-limit signal from Claude CLI.
 *
 * Puts the current account into cooldown so future `acquire()` calls route new
 * sessions to other accounts. Posts a heads-up in the session thread. The
 * session itself is not killed here — Claude CLI will surface the error in its
 * own output and the user can decide (wait, use another session, etc.).
 *
 * Exported so that all code paths that rebind Claude listeners (startSession,
 * resumeSession, and the `restartClaudeSession` helper used by !cd /
 * !permissions) share the same handler and can't accidentally drop it.
 */
export function handleRateLimit(session: Session, hit: RateLimitHit, ctx: SessionContext): void {
  if (!session.claudeAccountId) {
    sessionLog(session).warn(`Rate limit hit in single-account mode — cannot reroute`);
    return;
  }
  const deadline = cooldownDeadline(hit);
  ctx.ops.markClaudeAccountCooling(session.claudeAccountId, deadline);
  const minutes = Math.max(1, Math.ceil((deadline - Date.now()) / 60_000));
  sessionLog(session).warn(
    `Rate limit on account "${session.claudeAccountId}" — cooling for ~${minutes}min`
  );
  void post(
    session,
    'warning',
    `⚠️ Claude account \`${session.claudeAccountId}\` hit a rate limit. ` +
      `New sessions will use another account until it resets (~${minutes}min).`
  );
}

/**
 * Create the per-session decision bridge (plan approvals and question answers
 * flowing back through the MCP permission server — see
 * src/mcp/decision-bridge.ts). Returns null when the socket can't be created;
 * the MCP server then falls back to its legacy prompts, so a bridge failure
 * degrades rather than breaks.
 *
 * The handler dereferences the session through a ref box because the bridge
 * must exist BEFORE the ClaudeCli options are built (its path travels in the
 * MCP child's env) while the Session/MessageManager are created after.
 */
async function createSessionDecisionBridge(
  ref: { current?: Session },
  ctx: SessionContext
): Promise<DecisionBridgeServer | null> {
  try {
    return await DecisionBridgeServer.create(async (request, signal) => {
      const session = ref.current;
      // Agent-initiated feature actions (remember_fact, propose_routine, …)
      // execute bot-side where the stores and their gates live — they never
      // go through the MessageManager's decision plumbing.
      if (request.kind === 'agent_action') {
        if (!session) {
          return { ok: false, reason: 'session is not ready yet' };
        }
        return handleAgentAction(session, ctx, request, signal);
      }
      const messageManager = session?.messageManager;
      if (!messageManager) {
        // Drop the connection instead of denying: a deny would be final,
        // while a dropped connection makes the MCP server fall back to its
        // legacy prompts. (Unreachable in practice — the CLI only starts
        // after the MessageManager exists — but degrade safely regardless.)
        throw new BridgeUnavailableError('Session is not ready for decisions yet');
      }
      return messageManager.handleBridgeRequest(request, signal);
    });
  } catch (err) {
    log.warn(`Decision bridge unavailable — falling back to legacy MCP prompts: ${err}`);
    return null;
  }
}

/**
 * Create a MessageManager for a session.
 * Handles all content, task list, question, and subagent operations.
 *
 * Uses event subscriptions to handle callbacks from MessageManager.
 * This replaces the old callback-based approach for cleaner code.
 */
function createMessageManager(
  session: Session,
  ctx: SessionContext
): MessageManager {
  const postTracker = new PostTracker();

  // Create the MessageManager with session reference and callbacks
  const messageManager = new MessageManager({
    session, // Direct session access for Claude CLI, logger, etc.
    platform: session.platform,
    postTracker,
    threadId: session.threadId,
    sessionId: session.sessionId,
    worktreePath: session.worktreeInfo?.worktreePath,
    worktreeBranch: session.worktreeInfo?.branch,
    turnMarker: ctx.ops.getPlatformOverhead(session.platformId).turnMarker,
    registerPost: (postId, options) => {
      ctx.ops.registerPost(postId, session.threadId);
      postTracker.register(postId, session.threadId, session.sessionId, options);
    },
    updateLastMessage: (post) => {
      updateLastMessage(session, post);
    },
    // Callback to build message content (saves attachments to per-session
    // upload dir, gives Claude their absolute paths).
    buildMessageContent: (text, platform, files) => {
      const uploadDir = getSessionUploadDir(session.platformId, session.threadId);
      return ctx.ops.buildMessageContent(text, platform, uploadDir, files);
    },
    // Callback to start typing indicator
    startTyping: () => {
      ctx.ops.startTyping(session);
    },
    // Callback to emit session update events
    emitSessionUpdate: (updates) => {
      ctx.ops.emitSessionUpdate(session.sessionId, updates);
    },
    // Tunable streaming cadence (ResolvedLimits.flushDelayMs → SessionConfig).
    flushDelayMs: ctx.config.flushDelayMs,
  });

  // Subscribe to events from MessageManager
  // These replace the callback-based approach for cleaner separation of concerns

  messageManager.events.on('question:complete', ({ toolUseId: _toolUseId, answers }) => {
    // On modern CLIs AskUserQuestion blocks on the MCP permission prompt; the
    // decision bridge delivers the answers through the permission response's
    // updatedInput, and a stdin send would arrive as a stray extra user
    // message. Older CLIs (no bridge request pending) keep the stdin path.
    if (messageManager.resolveBridgeQuestion(answers)) {
      sessionLog(session).info('Question answered via decision bridge');
      ctx.ops.startTyping(session);
      return;
    }
    const answerJson = JSON.stringify(answers);
    session.claude.sendMessage(answerJson);
  });

  messageManager.events.on('approval:complete', ({ toolUseId: _toolUseId, approved }) => {
    // Same split as questions: on modern CLIs the plan approval resolves the
    // blocked ExitPlanMode permission request via the bridge — the CLI then
    // tells Claude "User has approved your plan" itself.
    if (messageManager.resolveBridgePlan(approved)) {
      sessionLog(session).info(`Plan ${approved ? 'approved' : 'denied'} via decision bridge`);
      ctx.ops.startTyping(session);
      return;
    }
    const response = approved ? 'approved' : 'denied';
    session.claude.sendMessage(response);
  });

  messageManager.events.on('message-approval:complete', async ({ decision, fromUser, originalMessage, approvedBy }) => {
    if (decision === 'allow') {
      // Allow this single message - format with source attribution
      const formattedMessage = formatApprovedMessage(originalMessage, fromUser, approvedBy);
      session.claude.sendMessage(formattedMessage);
      session.lastActivityAt = new Date();
      ctx.ops.startTyping(session);
      sessionLog(session).info(`Message from @${fromUser} approved by @${approvedBy}`);
    } else if (decision === 'invite') {
      // Invite user to session and send their message - format with source attribution
      session.sessionAllowedUsers.add(fromUser);
      await ctx.ops.updateSessionHeader(session);
      const formattedMessage = formatApprovedMessage(originalMessage, fromUser, approvedBy);
      session.claude.sendMessage(formattedMessage);
      session.lastActivityAt = new Date();
      ctx.ops.startTyping(session);
      sessionLog(session).info(`@${fromUser} invited to session by @${approvedBy}`);
    }
    // 'deny' - nothing extra to do, post already updated by MessageManager
  });

  messageManager.events.on('routine-prompt:complete', (payload) =>
    _handleCreationConfirmation(session, payload, {
      tool: 'routine',
      logPrefix: '🕘 Routine',
      fileNoun: 'routines',
      save: async () => {
        const result = await ctx.state.routinesStore.add(
          session.platformId,
          { name: payload.parsed.name, prompt: payload.parsed.prompt, schedule: payload.parsed.schedule, createdBy: payload.requestedBy, requireApproval: payload.requireApproval ?? true },
          ctx.config.maxRoutines,
        );
        if (!result.ok) return result;
        return { ok: true, name: result.routine.name, position: ctx.state.routinesStore.list(session.platformId).length };
      },
      savedText: (formatter, position, name) =>
        `✅ ${formatter.formatBold(`Routine ${position}: ${name}`)} saved — it will post its runs as new threads in this channel. ` +
        `${formatter.formatItalic(`Manage with ${'`!routines`'}. Each run starts a full Claude session.`)}`,
    }));

  messageManager.events.on('watch-prompt:complete', (payload) =>
    _handleCreationConfirmation(session, payload, {
      tool: 'watch',
      logPrefix: '👁️ Watch',
      fileNoun: 'watches',
      save: async () => {
        const result = await ctx.state.watchesStore.add(
          session.platformId,
          { name: payload.parsed.name, condition: payload.parsed.condition, prompt: payload.parsed.prompt, keywords: payload.parsed.keywords, createdBy: payload.requestedBy, requireApproval: payload.requireApproval ?? true },
          ctx.config.maxWatches,
        );
        if (!result.ok) return result;
        return { ok: true, name: result.watch.name, position: ctx.state.watchesStore.list(session.platformId).length };
      },
      savedText: (formatter, position, name) =>
        `✅ ${formatter.formatBold(`Watch ${position}: ${name}`)} saved — it fires a session in the triggering thread when a matching message appears. ` +
        `${formatter.formatItalic(`Manage with ${'`!watches`'}. Each fire starts a full Claude session.`)}`,
    }));

  messageManager.events.on('context-prompt:complete', async ({ selection, queuedPrompt, queuedByUsername, queuedFiles: _queuedFiles, threadMessageCount: _threadMessageCount }) => {
    // Build message with or without context
    const userTurn = formatUserTurn(queuedPrompt, queuedByUsername, shouldAttribute(session.userAttribution, session.sessionAllowedUsers.size));
    let messageToSend = userTurn;

    // Get any previous work summary (from directory change)
    const previousWorkSummary = session.previousWorkSummary;
    // Clear it after use - it's a one-time context transfer
    session.previousWorkSummary = undefined;

    if (typeof selection === 'number' && selection > 0) {
      // User selected to include context - fetch and format messages
      const messages = await getThreadMessagesForContext(session, selection);
      if (messages.length > 0 || previousWorkSummary) {
        const contextPrefix = formatContextForClaude(messages, previousWorkSummary);
        messageToSend = contextPrefix + userTurn;
      }
      sessionLog(session).debug(`🧵 Including ${selection} messages as context${previousWorkSummary ? ' + work summary' : ''}`);
    } else if (previousWorkSummary) {
      // No thread context selected, but we have a work summary from directory change
      const contextPrefix = formatContextForClaude([], previousWorkSummary);
      messageToSend = contextPrefix + userTurn;
      sessionLog(session).debug(`🧵 Including work summary (no thread context)`);
    } else {
      // No context (selection is 0 for skip, or 'timeout')
      const reason = selection === 'timeout' ? 'timed out' : 'skipped';
      sessionLog(session).debug(`🧵 Context ${reason}, continuing without`);
    }

    // Increment message counter
    session.messageCount++;

    // Inject metadata reminder periodically
    messageToSend = maybeInjectMetadataReminder(messageToSend, session, ctx, session);

    // Build content with the files that were queued behind the prompt. The
    // event only carries simplified refs (id, name) from MessageManager; the
    // original PlatformFile[] were parked in the context-prompt module when
    // the prompt was posted. Before this, attachments on a mid-thread start
    // survived only because the pre-built file header rode along in
    // queuedPrompt — startSession now queues the raw prompt, so the files
    // have to travel here explicitly.
    const queuedFiles = takeContextPromptFiles(session);
    const uploadDir = getSessionUploadDir(session.platformId, session.threadId);

    // This listener runs on a plain EventEmitter: a rejection here is nobody's
    // to await and would surface as an unhandled rejection after the prompt
    // state and the parked files are already consumed. Report it in the
    // thread instead — the failure stays visible, the daemon stays up.
    try {
      const { content, skipped, transcripts } = await ctx.ops.buildMessageContent(messageToSend, session.platform, uploadDir, queuedFiles);

      // Send the message to Claude
      if (session.claude.isRunning()) {
        session.claude.sendMessage(content);
        ctx.ops.startTyping(session);
      }
      await postSkippedFilesFeedback(session.platform, session.threadId, skipped);
      await postTranscriptFeedback(session.platform, session.threadId, transcripts);
    } catch (err) {
      await logAndNotify(err, { action: 'Send queued message after context prompt', session });
    }

    // Update activity and persist
    session.lastActivityAt = new Date();
    ctx.ops.persistSession(session);
  });

  messageManager.events.on('worktree-prompt:complete', async ({ decision, branch, worktreePath, username }) => {
    if (decision === 'join') {
      // Switch to the existing worktree
      await ctx.ops.switchToWorktree(session.threadId, worktreePath, username);
      sessionLog(session).info(`🌿 @${username} joined existing worktree ${branch}`);
    } else {
      sessionLog(session).info(`❌ @${username} skipped joining existing worktree ${branch}`);
    }
    ctx.ops.persistSession(session);
  });

  messageManager.events.on('update-prompt:complete', async ({ decision }) => {
    if (decision === 'update_now') {
      sessionLog(session).info('🔄 User triggered immediate update');
      await ctx.ops.forceUpdate();
    } else {
      sessionLog(session).info('⏸️ User deferred update for 1 hour');
      ctx.ops.deferUpdate(60);
    }
    ctx.ops.persistSession(session);
  });

  messageManager.events.on('bug-report:complete', async ({ decision, report: _report }) => {
    await ctx.ops.handleBugReportApproval(session, decision === 'approve', session.startedBy);
  });

  // Task updates - refresh sticky message to show updated progress and active task
  messageManager.events.on('task:update', async () => {
    await ctx.ops.updateStickyMessage();
  });

  // Status and lifecycle events (these are typically for session header updates)
  // Note: These are handled differently - they update session state directly
  // For now, these remain as part of the session management layer

  return messageManager;
}

/**
 * System prompt that gives Claude context about running in a chat platform.
 * This is appended to Claude's system prompt via --append-system-prompt.
 *
 * GENERATED from the unified command registry in src/commands/registry.ts.
 * Edit the registry to update this prompt - do not edit this constant directly.
 */
export const CHAT_PLATFORM_PROMPT = generateChatPlatformPrompt();

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/**
 * Resolve the effective per-thread session-header mode for a *resumed*
 * session.
 *
 * Precedence (highest first):
 *   1. `persisted` — the mode the session ran under before the bot restart.
 *      Important: if the user explicitly set `hidden` on the original
 *      session, we honor it on resume even if the platform config has since
 *      flipped back to `full`.
 *   2. `platformConfigured` — current platform-level setting. Used when
 *      `persisted` is absent (old `sessions.json` predating the field).
 *   3. DEFAULT (`'full'`).
 *
 * No `hidden`-needs-`replyToPostId` check here: resumed sessions already
 * have a `threadId`, so the constraint that motivates the downgrade in
 * `resolveSessionHeaderMode` does not apply.
 */
export function resumeSessionHeaderMode(
  persisted: OverheadVisibility | undefined,
  platformConfigured: OverheadVisibility | undefined,
): OverheadVisibility {
  return persisted ?? platformConfigured ?? DEFAULT_OVERHEAD_VISIBILITY;
}

/**
 * Resolve the effective per-thread session-header mode at session start.
 *
 * Rules:
 *  - `undefined` (platform never registered overhead) → DEFAULT (`'full'`).
 *  - `'hidden'` requires `replyToPostId`. If absent we degrade to `'minimal'`
 *    and log an error: better than silently posting the big header the user
 *    asked to hide. The bot's own message router (`message-handler.ts:59`,
 *    `post.rootId || post.id`) always supplies one, so this branch is
 *    defensive — but if it fires, the user gets a one-liner, not a table.
 *  - All other values pass through unchanged.
 *
 * Pure function — extracted from `startSession` so it can be tested without
 * the heavy harness around session start (ClaudeCli, MessageManager, etc.).
 */
export function resolveSessionHeaderMode(
  configured: OverheadVisibility | undefined,
  replyToPostId: string | undefined,
  platformId: string,
): OverheadVisibility {
  const mode = configured ?? DEFAULT_OVERHEAD_VISIBILITY;
  if (mode === 'hidden' && !replyToPostId) {
    log.error(
      `sessionHeader: hidden requires a replyToPostId for ${platformId}; ` +
      `downgrading this session to 'minimal' so the header post is still short.`
    );
    return 'minimal';
  }
  return mode;
}

/**
 * Create a new session for a thread.
 *
 * @param options - Session options including the initial prompt
 * @param username - Username of the person starting the session
 * @param displayName - Display name of the person starting the session
 * @param replyToPostId - Thread root ID (for posting replies to the correct thread)
 * @param platformId - Platform identifier
 * @param ctx - Session context
 * @param triggeringPostId - The actual post ID that triggered the session (for excluding from context).
 *                           When starting mid-thread, this is the @mention message, not the thread root.
 */
export async function startSession(
  options: { prompt: string; files?: PlatformFile[]; skipWorktreePrompt?: boolean; autoIncludeContext?: boolean; unattended?: boolean },
  username: string,
  displayName: string | undefined,
  replyToPostId: string | undefined,
  platformId: string,
  ctx: SessionContext,
  triggeringPostId?: string,
  initialOptions?: InitialSessionOptions
): Promise<void> {
  const sessionKey = compositeSessionId(platformId, replyToPostId || '');

  // A start for this exact session key is already in flight: wait for it and
  // deliver this message as a follow-up instead of spawning a second Claude.
  // Loop: after a failed start, one waiter begins a retry and registers it
  // synchronously — the other waiters must wait for THAT attempt too, not
  // fan out into parallel retries of their own.
  for (;;) {
    const inFlight = _inFlightSessionStarts.get(sessionKey);
    if (!inFlight) break;
    await inFlight.catch(() => {});
    const started = (ctx.state?.sessions as Map<string, Session> | undefined)?.get(sessionKey);
    if (started && started.claude.isRunning()) {
      await sendFollowUp(started, options.prompt, options.files, ctx, username, displayName);
      return;
    }
    // The awaited attempt failed — re-check the map: if another waiter
    // already started a retry, wait for it; otherwise it is our turn.
  }

  const attempt = startSessionImpl(options, username, displayName, replyToPostId, platformId, ctx, triggeringPostId, initialOptions);
  _inFlightSessionStarts.set(sessionKey, attempt);
  try {
    await attempt;
  } finally {
    _inFlightSessionStarts.delete(sessionKey);
  }
}

async function startSessionImpl(
  options: { prompt: string; files?: PlatformFile[]; skipWorktreePrompt?: boolean; autoIncludeContext?: boolean; unattended?: boolean },
  username: string,
  displayName: string | undefined,
  replyToPostId: string | undefined,
  platformId: string,
  ctx: SessionContext,
  triggeringPostId?: string,
  initialOptions?: InitialSessionOptions
): Promise<void> {
  const threadId = replyToPostId || '';

  // Check if session already exists for this thread
  const existingSessionId = ctx.ops.getSessionId(platformId, threadId);
  const existingSession = mutableSessions(ctx).get(existingSessionId);
  if (existingSession && existingSession.claude.isRunning()) {
    // Send as follow-up instead
    await sendFollowUp(existingSession, options.prompt, options.files, ctx, username, displayName);
    return;
  }

  const platforms = ctx.state.platforms as Map<string, PlatformClient>;
  const platform = platforms.get(platformId);
  if (!platform) {
    throw new Error(`Platform '${platformId}' not found. Call addPlatform() first.`);
  }

  // Fail-closed authorization gate (#388). A brand-new session has no
  // session allowlist yet, so only the platform's global allowlist applies.
  // The message-handler's new-session branch already posts "not authorized",
  // so we just refuse to start here without re-posting. (When a running
  // session already exists, the early-return above forwards to sendFollowUp,
  // which runs its own gate; this one covers the fresh-start path.)
  if (!isAuthorizedForSession({ username, platform, sessionAllowedUsers: undefined })) {
    log.warn(`auth.denied.startSession: @${username || 'unknown'} not authorized to start session in ${threadId.substring(0, 8)}...`);
    return;
  }

  // Check max sessions limit. Count pending starts alongside committed sessions
  // — without this, concurrent startSession() calls all see the same stale size
  // across the awaits below and over-admit above the configured cap.
  const activeOrPending = ctx.state.sessions.size + pendingStartsCount;
  if (activeOrPending >= ctx.config.maxSessions) {
    const formatter = platform.getFormatter();
    // Create a temporary pseudo-session just for posting the message
    // (we don't have a real session yet since we're at capacity)
    const tempSession = {
      platform,
      threadId: replyToPostId || '',
      sessionId: 'temp',
    } as Session;
    await post(tempSession, 'warning', `${formatter.formatBold('Too busy')} - ${activeOrPending} sessions active. Please try again later.`);
    return;
  }

  // Reserve a slot synchronously so concurrent starts see the correct count
  // at their own cap check. Every early-exit below must release; the success
  // path releases after the session is committed to the sessions map.
  pendingStartsCount++;

  // Resolve per-platform header visibility once. See `resolveSessionHeaderMode`
  // for the rules — extracted so it's testable without spinning up a full
  // `startSession` (which would require mocking ClaudeCli, MessageManager, etc.).
  const sessionHeaderMode = resolveSessionHeaderMode(
    ctx.ops.getPlatformOverhead(platformId).sessionHeader,
    replyToPostId,
    platformId,
  );

  // Post initial session message (kept short to minimize popup notification size).
  // The full session info is shown when updateSessionHeader() is called shortly after.
  // For `hidden` we skip this — Claude's first response will be the first reply
  // in the thread, anchored at `replyToPostId`.
  const startFormatter = platform.getFormatter();
  const skipHeaderPost = sessionHeaderMode === 'hidden';
  let startPost: { id: string } | undefined;
  if (!skipHeaderPost) {
    startPost = await withErrorHandling(
      () => platform.createPost(
        startFormatter.formatItalic('Claude Threads session starting...'),
        replyToPostId
      ),
      { action: 'Create session post' }
    );
    if (!startPost) {
      releasePendingStart();
      return;
    }
  }
  const actualThreadId = replyToPostId || (startPost ? startPost.id : '');
  const sessionId = ctx.ops.getSessionId(platformId, actualThreadId);

  // Start typing indicator early so user sees activity during session setup
  // We'll set up a proper interval-based typing indicator once the session is created
  platform.sendTyping(actualThreadId);

  // Generate a unique session ID for this Claude session
  const claudeSessionId = randomUUID();

  // ---------------------------------------------------------------------------
  // Apply initial options from first-message commands (!cd, !permissions)
  // ---------------------------------------------------------------------------
  let workingDir = ctx.config.workingDir;
  // Start from the bot-wide default. The legacy `skipPermissions` boolean is
  // still consumed by some callers, but the effective mode is what drives
  // Claude CLI spawn below.
  let permissionMode = ctx.config.permissionMode;
  let forceInteractivePermissions = false;
  // Per-session override tracked on the Session object so the header + any
  // subsequent `effectivePermissionMode` call sees the mode the user chose
  // in the first message (not just the bot-wide default).
  let sessionPermissionModeOverride: PermissionMode | undefined;
  const formatter = platform.getFormatter();

  if (initialOptions?.workingDir) {
    // Resolve and validate the directory from !cd command
    const { resolve } = await import('path');
    const requestedDir = initialOptions.workingDir.startsWith('~')
      ? initialOptions.workingDir.replace('~', process.env.HOME || '')
      : initialOptions.workingDir;
    const resolvedDir = resolve(requestedDir);

    if (!existsSync(resolvedDir)) {
      const msg = `❌ Directory does not exist: ${formatter.formatCode(initialOptions.workingDir)}`;
      if (startPost) {
        await platform.updatePost(startPost.id, msg);
      } else {
        await platform.createPost(msg, replyToPostId);
      }
      releasePendingStart();
      return;
    }

    const { statSync } = await import('fs');
    if (!statSync(resolvedDir).isDirectory()) {
      const msg = `❌ Not a directory: ${formatter.formatCode(initialOptions.workingDir)}`;
      if (startPost) {
        await platform.updatePost(startPost.id, msg);
      } else {
        await platform.createPost(msg, replyToPostId);
      }
      releasePendingStart();
      return;
    }

    workingDir = resolvedDir;
    log.info(`Starting session in directory: ${workingDir} (from !cd command)`);
  }

  // First-message `!permissions <mode>` — honor the explicit mode.
  // `forceInteractivePermissions` is the only mode that's sticky across
  // bot restarts (matches legacy behavior); `auto` and `bypass` revert to
  // the bot-wide default on resume.
  if (initialOptions?.permissionMode) {
    permissionMode = initialOptions.permissionMode;
    forceInteractivePermissions = permissionMode === 'default';
    // Record the explicit override so the session header reflects it. Only
    // needed for 'auto' and 'bypass' — 'default' is covered by
    // forceInteractivePermissions, but we set the override uniformly for
    // clarity.
    sessionPermissionModeOverride = permissionMode;
    log.info(`Starting session with permission mode "${permissionMode}" (from !permissions command)`);
  } else if (initialOptions?.forceInteractivePermissions) {
    // Legacy alias: forceInteractivePermissions === 'default'.
    forceInteractivePermissions = true;
    permissionMode = 'default';
    log.info(`Starting session with interactive permissions (from !permissions command)`);
  }

  // Per-message [@username]: attribution — resolved once so the session seed
  // and the system-prompt note (see buildAppendSystemPrompt) can never disagree.
  const userAttribution = ctx.config.userAttribution ?? true;

  // Build system prompt with session context. New sessions only have the
  // owner in `sessionAllowedUsers`, so the collaborator section is the
  // standby one-liner. The full list is published into the thread later
  // (by `postCollaboratorUpdatedNotice` on each !invite/!kick), and Claude
  // reads it from there on the next turn — the static prompt is not rewritten.
  const memoryConfig = ctx.ops.getPlatformMemoryConfig(platformId);
  const systemPrompt = await buildAppendSystemPrompt(
    platform,
    platformId,
    workingDir,
    actualThreadId,
    username,
    [username],
    CHAT_PLATFORM_PROMPT,
    ctx.state.githubEmailsStore,
    memoryConfig.enabled && memoryConfig.channelLayer ? ctx.state.memoryStore : null,
    { userAttribution },
  );

  // Create Claude CLI with options
  const platformMcpConfig = platform.getMcpConfig();
  // Approvals scoping: with the effective mode `owner` only the session
  // participants may answer tool-permission prompts (`all_users` = platform
  // allowlist; unset defaults to all_users for threads and owner for DCM —
  // see resolveApprovals). The list is fixed at spawn time; a later `!invite`
  // extends message access but not the approval set until the CLI is
  // respawned (e.g. via `!cd` or `!permissions`).
  if (resolveApprovals(platform.approvals, isDcmThreadId(threadId)) === 'owner') {
    platformMcpConfig.allowedUsers = [username];
  }

  // Reserve a Claude account from the pool (null = single-account mode). New
  // sessions balance by real subscription headroom (`/usage`), routing to
  // whichever account is least loaded and skipping any in rate-limit cooldown.
  // Probe usage synchronously right here (no background polling) so the pick is
  // made on fresh data; the probe no-ops for pools with <2 accounts. The chosen
  // account id is persisted to sessions.json so resume re-binds to the same
  // $HOME the conversation history lives under. threadId is still passed as the
  // resume-compat sticky fallback for pre-account-pool sessions.
  await ctx.ops.refreshClaudeAccountUsage();
  const claudeAccount = ctx.ops.acquireClaudeAccount(undefined, actualThreadId, {
    balanceByUsage: true,
  });
  if (claudeAccount) {
    log.info(`Session ${sessionId.substring(0, 20)} reserved Claude account "${claudeAccount.id}"`);
  }

  // Decision bridge: created before the CLI so its socket path can travel to
  // the MCP child's env. Requests only arrive once Claude runs, by which time
  // the session's MessageManager exists — the handler dereferences it lazily
  // through the ref box (the Session object itself is created further down).
  const bridgeSessionRef: { current?: Session } = {};
  const decisionBridge = await createSessionDecisionBridge(bridgeSessionRef, ctx);

  const cliOptions: ClaudeCliOptions = {
    workingDir,
    threadId: actualThreadId,
    permissionMode,
    sessionId: claudeSessionId,
    resume: false,
    chrome: ctx.config.chromeEnabled,
    platformConfig: platformMcpConfig,
    appendSystemPrompt: systemPrompt,
    logSessionId: sessionId,  // Route logs to session panel
    permissionTimeoutMs: ctx.config.permissionTimeoutMs,
    account: claudeAccount
      ? { id: claudeAccount.id, home: claudeAccount.home, apiKey: claudeAccount.apiKey }
      : undefined,
    uploadDir: getSessionUploadDir(platformId, actualThreadId),
    outboundFiles: platformMcpConfig.outboundFiles,
    sessionOwnerUsername: username,
    decisionBridgePath: decisionBridge?.path,
    // Repo memory layer: redirect Claude's native auto-memory into the
    // bot-managed per-(platform, repo) directory. Null disables it entirely.
    memory: await resolveSessionMemory(
      ctx.state.memoryStore, memoryConfig, platformId, workingDir,
    ),
    agentFeatures: sessionAgentFeatures(
      { platformId, threadId: actualThreadId, unattended: options.unattended },
      ctx.ops,
    ),
  };
  let claude: ClaudeCli;
  try {
    claude = new ClaudeCli(cliOptions);
  } catch (err) {
    // The bridge has no owner yet — close it here or it leaks its socket dir
    void decisionBridge?.close();
    throw err;
  }

  // Create the session object
  const session: Session = {
    platformId,
    threadId: actualThreadId,
    sessionId,
    platform,
    claudeSessionId,
    claudeAccountId: claudeAccount?.id,
    unattended: options.unattended || undefined,
    startedBy: username,
    startedByDisplayName: displayName,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: ctx.state.sessions.size + 1,
    workingDir,
    claude,
    planApproved: false,
    sessionAllowedUsers: new Set([username]),
    forceInteractivePermissions,
    // Seed from the config default (#402); users can still flip it per-session
    // with `!mentions`. Resumed sessions keep their own persisted value.
    // In direct channel mode the global default is NOT inherited (it would
    // silently disable DCM's whole point); instead the seed comes from the
    // platform's `directChannelMode.respondTo` option, and `!mentions` still
    // toggles it at runtime.
    respondOnlyWhenMentioned: isDcmThreadId(threadId)
      ? platform.directChannelMode?.respondTo === 'mention'
      : (ctx.config.respondOnlyWhenMentioned ?? false),
    userAttribution,
    permissionModeOverride: sessionPermissionModeOverride,
    sessionStartPostId: startPost ? startPost.id : null,
    sessionHeaderMode,
    // NOTE: Task state (tasksPostId, lastTasksContent, etc.) is now managed by MessageManager.
    // These fields are intentionally NOT initialized here - MessageManager is the source of truth.
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    timeoutWarningPosted: false,
    firstPrompt: options.prompt,  // Set early so sticky message can use it
    messageCount: 0,  // Will be incremented when first message is sent
    isProcessing: true,  // Starts as true since we're sending initial prompt
    recentEvents: [],  // Bug report context: recent tool uses/errors
    // Thread logger for persisting events to disk
    threadLogger: createThreadLogger(platformId, actualThreadId, claudeSessionId, {
      enabled: ctx.config.threadLogsEnabled ?? true,
    }),
  };
  session.decisionBridge = decisionBridge ?? undefined;

  // Create MessageManager for this session
  session.messageManager = createMessageManager(session, ctx);
  // The bridge handler can now reach the MessageManager
  bridgeSessionRef.current = session;

  // Log session start
  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: session.startedBy,
    kind: 'session_start',
  });
  session.threadLogger?.logLifecycle('start', {
    username,
    workingDir: ctx.config.workingDir,
  });

  // Register session — the reservation can now be released since the real
  // entry is now in the map and counted by .size.
  mutableSessions(ctx).set(sessionId, session);
  releasePendingStart();
  if (startPost) {
    ctx.ops.registerPost(startPost.id, actualThreadId);
  }
  ctx.ops.emitSessionAdd(session);
  ctx.ops.recordSessionStarted();
  sessionLog(session).info(`▶ Session started by @${username}`);

  // Fire out-of-band title/tag suggestions (don't block session startup)
  fireMetadataSuggestions(session, options.prompt, ctx);

  // Notify keep-alive that a session started
  keepAlive.sessionStarted();

  // Update the header with full session info
  await ctx.ops.updateSessionHeader(session);

  // Update sticky channel message with new session
  await ctx.ops.updateStickyMessage();

  // Start typing indicator
  ctx.ops.startTyping(session);

  // Bind event handlers (use sessionId which is the composite key)
  claude.on('event', (e: ClaudeEvent) => ctx.ops.handleEvent(sessionId, e));
  claude.on('exit', (code: number) => ctx.ops.handleExit(sessionId, code, claude));
  claude.on('rate-limit', (hit: RateLimitHit) => handleRateLimit(session, hit, ctx));

  try {
    claude.start();
  } catch (err) {
    await logAndNotify(err, { action: 'Start Claude', session });
    auditSessionEnd(session, 'start-failed');
    ctx.ops.stopTyping(session);
    session.messageManager?.dispose();
    void session.decisionBridge?.close();
    session.decisionBridge = undefined;
    ctx.ops.emitSessionRemove(session.sessionId);
    mutableSessions(ctx).delete(session.sessionId);
    releaseAccountIfHeld(session, ctx);
    await ctx.ops.updateStickyMessage();
    return;
  }

  // Check if we should prompt for worktree
  // Skip if explicitly disabled (e.g., when branch was specified in initial message via !worktree)
  // Always run the check — it also detects (and records) an existing worktree
  // around workingDir. skipWorktreePrompt suppresses only the prompt itself,
  // otherwise unattended starts inside a worktree would miss worktreeInfo and
  // its reference-count protection.
  const worktreePromptReason = await ctx.ops.shouldPromptForWorktree(session);
  const shouldPrompt = options.skipWorktreePrompt ? null : worktreePromptReason;
  if (shouldPrompt) {
    session.queuedPrompt = options.prompt;
    session.queuedByUsername = username;   // owner — used when the worktree prompt later re-sends
    session.queuedFiles = options.files;
    session.pendingWorktreePrompt = true;
    await ctx.ops.postWorktreePrompt(session, shouldPrompt);
    ctx.ops.persistSession(session);
    await ctx.ops.updateStickyMessage();
    return;
  }

  // shouldPromptForWorktree may have detected that workingDir already IS a
  // worktree and recorded it on the session; register it for reference
  // counting like every other path that sets worktreeInfo, or another
  // session's cleanup can remove the directory under this live session.
  if (session.worktreeInfo) {
    ctx.ops.registerWorktreeUser(session.worktreeInfo.worktreePath, session.sessionId);
  }

  // Check if this is a mid-thread start (replyToPostId means we're replying in an existing thread)
  // Offer context prompt if there are previous messages in the thread.
  // Use triggeringPostId (the actual @mention message) to exclude from
  // context, not replyToPostId (thread root).
  //
  // offerContextPrompt's return value contract:
  // - returns true:  it posted a prompt (queued the message) — the message
  //   will be sent later when the user responds.
  // - returns false: it ALREADY sent the message itself (auto-include or
  //   no-context branches). Caller must not send again.
  //
  // The previous version of this code interpreted false as "didn't send,
  // please send", causing a duplicate send to Claude — visible in CI as
  // mock-claude receiving each user message twice and emitting all events
  // twice. Caught by stack-trace diagnostic in PR #340.
  // In direct channel mode the "thread root" is a synthetic id, not a real
  // post — there is no thread history to offer, so skip the context prompt
  // and take the plain send path below.
  if (replyToPostId && !isDcmThreadId(replyToPostId)) {
    // Human starts exclude the @mention message (its content already IS the
    // prompt). Unattended autoIncludeContext starts (watch fires) exclude
    // nothing: their prompt is synthetic and the triggering message is the
    // event the session must see — excluding the thread root here previously
    // fired "triage the incident" sessions that never saw the incident.
    const excludePostId = options.autoIncludeContext ? undefined : (triggeringPostId || replyToPostId);
    // Hand over the RAW prompt and files: every send path inside
    // offerContextPrompt builds the message content itself (sendWithContext →
    // buildMessageContent) and posts its own skipped-file / transcript
    // feedback. Building here as well used to download every attachment
    // twice and prepend the file-list header twice — and would transcribe a
    // voice note twice. Either path inside offerContextPrompt sends or
    // queues, so return: the fallback claude.sendMessage() below would be a
    // duplicate.
    await ctx.ops.offerContextPrompt(session, options.prompt, options.files, excludePostId, username, options.autoIncludeContext);
    return;
  }

  // Build message content (once — see the note above)
  const uploadDir = getSessionUploadDir(session.platformId, session.threadId);
  const { content, skipped, transcripts } = await ctx.ops.buildMessageContent(options.prompt, session.platform, uploadDir, options.files);

  // No replyToPostId — defensive path for callers that don't pass a thread
  // root. In practice handleMessage always supplies one (post.rootId ||
  // post.id), so this branch is unreachable through the bot's WebSocket
  // pipeline; kept because SessionManager.startSession's signature allows
  // omitting replyToPostId.
  session.messageCount++;
  claude.sendMessage(formatUserTurn(content, username, shouldAttribute(session.userAttribution, session.sessionAllowedUsers.size)));

  // Surface any skipped attachments to the user, then echo voice-note transcripts
  await postSkippedFilesFeedback(session.platform, actualThreadId, skipped);
  await postTranscriptFeedback(session.platform, actualThreadId, transcripts);

  // NOTE: We don't persist here. We wait for Claude to actually respond before persisting.
  // This prevents persisting sessions where Claude dies before saving its conversation,
  // which would result in "No conversation found" errors on resume.
  // Persistence happens in events.ts when we receive the first response from Claude.
}

/**
 * Resume a session from persisted state.
 */
export async function resumeSession(
  state: PersistedSession,
  ctx: SessionContext,
  resumedBy?: string
): Promise<void> {
  // Idempotency guard: a resume can be triggered from two sides at once
  // (startup resume-all and an incoming message via resumePausedSession).
  // If this key is already registered or a start/resume is in flight, there
  // is nothing to do — resumePausedSession delivers its message through the
  // registered session afterwards.
  if (state.threadId && state.platformId) {
    const sessionKey = compositeSessionId(state.platformId, state.threadId);
    // Defensive: some callers (and tests) construct minimal contexts — the
    // guard is an optimization, resumeSessionImpl revalidates everything.
    const sessions = ctx.state?.sessions as Map<string, Session> | undefined;
    if (sessions?.has(sessionKey)) {
      log.debug(`Session ${state.threadId.substring(0, 8)}... already active, skipping resume`);
      return;
    }
    const inFlight = _inFlightSessionStarts.get(sessionKey);
    if (inFlight) {
      await inFlight.catch(() => {});
      return;
    }
    const attempt = resumeSessionImpl(state, ctx, resumedBy);
    _inFlightSessionStarts.set(sessionKey, attempt);
    try {
      await attempt;
    } finally {
      _inFlightSessionStarts.delete(sessionKey);
    }
    return;
  }
  await resumeSessionImpl(state, ctx, resumedBy);
}

async function resumeSessionImpl(
  state: PersistedSession,
  ctx: SessionContext,
  resumedBy?: string
): Promise<void> {
  // Validate required fields - skip gracefully if critical data is missing
  if (!state.threadId || !state.platformId || !state.claudeSessionId || !state.workingDir) {
    const missing = [
      !state.threadId && 'threadId',
      !state.platformId && 'platformId',
      !state.claudeSessionId && 'claudeSessionId',
      !state.workingDir && 'workingDir',
    ].filter(Boolean).join(', ');
    log.warn(`Skipping session with missing required fields: ${missing}`);
    return;
  }

  const shortId = state.threadId.substring(0, 8);

  // Get platform for this session
  const platforms = ctx.state.platforms as Map<string, PlatformClient>;
  const platform = platforms.get(state.platformId);
  if (!platform) {
    log.warn(`Platform ${state.platformId} not registered, skipping resume for ${shortId}...`);
    return;
  }

  // A persisted DCM session must not resume when the platform no longer runs
  // in direct channel mode — it would keep posting channel-root messages into
  // a channel that has gone back to thread-per-session.
  if (isDcmThreadId(state.threadId) && !platform.directChannelMode?.enabled) {
    log.warn(`Direct channel mode disabled for ${state.platformId}, dropping persisted DCM session`);
    ctx.state.sessionStore.remove(`${state.platformId}:${state.threadId}`);
    return;
  }

  // Verify thread still exists. A synthetic DCM id is not a real post — the
  // "thread" is the channel itself, which always exists — so skip the check.
  if (!isDcmThreadId(state.threadId)) {
    const threadPost = await platform.getPost(state.threadId);
    if (!threadPost) {
      log.warn(`Thread ${shortId}... deleted, skipping resume`);
      ctx.state.sessionStore.remove(`${state.platformId}:${state.threadId}`);
      return;
    }
  }

  // Check max sessions limit
  if (ctx.state.sessions.size >= ctx.config.maxSessions) {
    log.warn(`Max sessions reached, skipping resume for ${shortId}...`);
    return;
  }

  // Verify working directory exists
  if (!existsSync(state.workingDir)) {
    log.warn(`Working directory ${state.workingDir} no longer exists, skipping resume for ${shortId}...`);
    ctx.state.sessionStore.remove(`${state.platformId}:${state.threadId}`);
    const resumeFormatter = platform.getFormatter();
    // Create a temporary pseudo-session just for posting the message
    const tempSession = {
      platform,
      threadId: state.threadId,
      sessionId: `${state.platformId}:${state.threadId}`,
    } as Session;
    await withErrorHandling(
      () => post(tempSession, 'warning', `${resumeFormatter.formatBold('Cannot resume session')} - working directory no longer exists:\n${resumeFormatter.formatCode(state.workingDir)}\n\nPlease start a new session.`),
      { action: 'Post resume failure notification' }
    );
    return;
  }

  const platformId = state.platformId;
  const sessionId = ctx.ops.getSessionId(platformId, state.threadId);

  // Resume: honor the bot's current permissionMode, with one asymmetry:
  // - A session that opted into `default` via `!permissions default|interactive`
  //   keeps `default` across bot restart (stickiness persists via
  //   `state.forceInteractivePermissions`). Safer-than-default overrides win.
  // - `auto` and `bypass` per-session overrides are NOT persisted — resumed
  //   sessions inherit whatever the bot-wide mode is at resume time. If a
  //   user had run `!permissions auto` before a crash, they pick up the
  //   bot-wide default on resume and would need to rerun the command.
  const resumePermissionMode: PermissionMode =
    state.forceInteractivePermissions ? 'default' : ctx.config.permissionMode;
  const userAttribution = state.userAttribution ?? false;
  const platformMcpConfig = platform.getMcpConfig();
  // Approvals scoping on resume mirrors the fresh-start path: session
  // participants (owner + invited) instead of the whole platform allowlist.
  if (resolveApprovals(platform.approvals, isDcmThreadId(state.threadId)) === 'owner') {
    platformMcpConfig.allowedUsers = Array.from(
      sessionAllowedUserSet(state)
    ) as string[];
  }

  // Include system prompt for resumed sessions (platform context, command info,
  // and collaborator co-author tags carried over from before the restart).
  const memoryConfig = ctx.ops.getPlatformMemoryConfig(state.platformId);
  const appendSystemPrompt = await buildAppendSystemPrompt(
    platform,
    state.platformId,
    state.workingDir,
    state.threadId,
    state.startedBy,
    [...sessionAllowedUserSet(state)],
    CHAT_PLATFORM_PROMPT,
    ctx.state.githubEmailsStore,
    memoryConfig.enabled && memoryConfig.channelLayer ? ctx.state.memoryStore : null,
    { userAttribution },
  );

  // Resume MUST re-use the same Claude account the session started on —
  // for OAuth accounts the conversation history lives under that HOME.
  // acquireClaudeAccount honors preferredId even if it is currently cooling.
  // threadId is passed as a fallback for legacy sessions persisted before
  // sticky-by-thread binding existed: when state.claudeAccountId is missing,
  // the pool can re-derive the same sticky account from the thread.
  const claudeAccount = ctx.ops.acquireClaudeAccount(state.claudeAccountId, state.threadId);
  if (state.claudeAccountId && !claudeAccount) {
    log.warn(
      `Persisted session referenced Claude account "${state.claudeAccountId}" ` +
      `which is no longer configured — resuming under default env`
    );
  }

  // Decision bridge for the resumed session (see startSession for rationale)
  const resumeBridgeRef: { current?: Session } = {};
  const resumeBridge = await createSessionDecisionBridge(resumeBridgeRef, ctx);

  const cliOptions: ClaudeCliOptions = {
    workingDir: state.workingDir,
    threadId: state.threadId,
    permissionMode: resumePermissionMode,
    sessionId: state.claudeSessionId,
    resume: true,
    chrome: ctx.config.chromeEnabled,
    platformConfig: platformMcpConfig,
    appendSystemPrompt,
    logSessionId: sessionId,  // Route logs to session panel
    permissionTimeoutMs: ctx.config.permissionTimeoutMs,
    account: claudeAccount
      ? { id: claudeAccount.id, home: claudeAccount.home, apiKey: claudeAccount.apiKey }
      : undefined,
    uploadDir: getSessionUploadDir(platformId, state.threadId),
    outboundFiles: platformMcpConfig.outboundFiles,
    sessionOwnerUsername: state.startedBy,
    decisionBridgePath: resumeBridge?.path,
    // Same repo-memory binding as startSession — recomputed, not persisted,
    // so a moved/deleted repo can't strand the session.
    memory: await resolveSessionMemory(
      ctx.state.memoryStore, memoryConfig, state.platformId, state.workingDir,
      activeWorktreeRepoRoot(state.workingDir, state.worktreeInfo),
    ),
    agentFeatures: sessionAgentFeatures(
      { platformId: state.platformId, threadId: state.threadId, unattended: _resumedUnattended(state) },
      ctx.ops,
    ),
  };
  let claude: ClaudeCli;
  try {
    claude = new ClaudeCli(cliOptions);
  } catch (err) {
    // The bridge has no owner yet — close it here or it leaks its socket dir
    void resumeBridge?.close();
    throw err;
  }

  // Rebuild Session object from persisted state
  const session: Session = {
    platformId,
    threadId: state.threadId,
    sessionId,
    platform,
    claudeSessionId: state.claudeSessionId,
    claudeAccountId: claudeAccount?.id,
    unattended: _resumedUnattended(state) || undefined,
    startedBy: state.startedBy,
    startedByDisplayName: state.startedByDisplayName,
    startedAt: new Date(state.startedAt),
    lastActivityAt: new Date(),
    sessionNumber: state.sessionNumber ?? 1,
    workingDir: state.workingDir,
    claude,
    planApproved: state.planApproved ?? false,
    sessionAllowedUsers: sessionAllowedUserSet(state),
    forceInteractivePermissions: state.forceInteractivePermissions ?? false,
    respondOnlyWhenMentioned: state.respondOnlyWhenMentioned ?? false,
    userAttribution,
    sessionStartPostId: state.sessionStartPostId ?? null,
    sessionHeaderMode: resumeSessionHeaderMode(
      state.sessionHeaderMode,
      ctx.ops.getPlatformOverhead(platformId).sessionHeader,
    ),
    // NOTE: Task state (tasksPostId, lastTasksContent, etc.) is now managed by MessageManager.
    // These fields are NOT set here - MessageManager is hydrated with them below.
    timers: createSessionTimers(),
    lifecycle: createResumedLifecycle(state.resumeFailCount ?? 0),
    timeoutWarningPosted: false,
    worktreeInfo: state.worktreeInfo,
    isWorktreeOwner: state.isWorktreeOwner,
    pendingWorktreePrompt: state.pendingWorktreePrompt,
    worktreePromptDisabled: state.worktreePromptDisabled,
    queuedPrompt: state.queuedPrompt,
    queuedByUsername: state.queuedByUsername,
    queuedFiles: state.queuedFiles,
    firstPrompt: state.firstPrompt,
    needsContextPromptOnNextMessage: state.needsContextPromptOnNextMessage,
    sessionTitle: state.sessionTitle,
    sessionDescription: state.sessionDescription,
    sessionTags: state.sessionTags || [],
    pullRequestUrl: state.pullRequestUrl,
    messageCount: state.messageCount ?? 0,
    isProcessing: false,  // Resumed sessions are idle until user sends a message
    lifecyclePostId: state.lifecyclePostId,  // Pass through for resume message handling
    recentEvents: [],  // Bug report context: recent tool uses/errors (cleared on resume)
    // Thread logger for persisting events to disk (appends to existing log)
    threadLogger: createThreadLogger(platformId, state.threadId, state.claudeSessionId, {
      enabled: ctx.config.threadLogsEnabled ?? true,
    }),
  };
  // Assign the bridge to the session IMMEDIATELY: the awaits below
  // (worktree detection, task-list restore) can throw, and the failure
  // catch closes session.decisionBridge — which must be set by then.
  session.decisionBridge = resumeBridge ?? undefined;

  // Auto-detect worktree info if workingDir is a worktree but worktreeInfo is not set
  // This handles sessions that were created before worktreeInfo tracking was added,
  // or sessions that were started directly in a worktree directory
  if (!session.worktreeInfo) {
    const detected = await detectWorktreeInfo(session.workingDir);
    if (detected) {
      session.worktreeInfo = {
        repoRoot: detected.repoRoot,
        worktreePath: detected.worktreePath,
        branch: detected.branch,
      };
      log.info(`Auto-detected worktree info for resumed session: branch=${detected.branch}`);
    }
  }

  // Create MessageManager for this session
  session.messageManager = createMessageManager(session, ctx);
  // The bridge handler can now reach the MessageManager
  resumeBridgeRef.current = session;

  // Restore task list from persisted state (hydrates + bumps to bottom)
  await session.messageManager.restoreTaskListFromPersistence({
    tasksPostId: state.tasksPostId,
    lastTasksContent: state.lastTasksContent,
    tasksCompleted: state.tasksCompleted,
    tasksMinimized: state.tasksMinimized,
  });

  // Restore the incremental task tracker: without it, post-resume TaskUpdate
  // calls hit an empty tracker and render "Task #N" placeholders instead of
  // real subjects (absent on pre-1.24.1 persisted data → starts empty).
  session.messageManager.restoreTaskTracker(state.taskTrackerState);

  // Hydrate MessageManager with persisted interactive state (if any)
  // Note: These fields may not exist in older persisted sessions
  const persistedWithInteractive = state as PersistedSession & {
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
  };
  if (persistedWithInteractive.pendingQuestionSet || persistedWithInteractive.pendingApproval) {
    session.messageManager.hydrateInteractiveState({
      pendingQuestionSet: persistedWithInteractive.pendingQuestionSet,
      pendingApproval: persistedWithInteractive.pendingApproval,
    });
  }

  // Log session resume
  if (resumedBy) session.lastActorUsername = resumedBy;
  auditLog(session.platformId, {
    threadId: session.threadId,
    sessionId: session.sessionId,
    actor: resumedBy ?? session.startedBy,
    kind: 'session_resume',
  });
  session.threadLogger?.logLifecycle('resume', {
    username: state.startedBy,
    workingDir: state.workingDir,
  });

  // Register session
  mutableSessions(ctx).set(sessionId, session);

  // Register worktree user for reference counting (if session has a worktree)
  if (session.worktreeInfo) {
    ctx.ops.registerWorktreeUser(session.worktreeInfo.worktreePath, sessionId);
  }
  if (state.sessionStartPostId) {
    ctx.ops.registerPost(state.sessionStartPostId, state.threadId);
  }
  // Register task post for reaction routing (task collapse toggle)
  if (state.tasksPostId) {
    ctx.ops.registerPost(state.tasksPostId, state.threadId);
  }
  ctx.ops.emitSessionAdd(session);

  // Notify keep-alive that a session started
  keepAlive.sessionStarted();

  // Bind event handlers (use sessionId which is the composite key)
  claude.on('event', (e: ClaudeEvent) => ctx.ops.handleEvent(sessionId, e));
  claude.on('exit', (code: number) => ctx.ops.handleExit(sessionId, code, claude));
  claude.on('rate-limit', (hit: RateLimitHit) => handleRateLimit(session, hit, ctx));

  try {
    claude.start();
    sessionLog(session).info(`🔄 Session resumed (@${state.startedBy})`);

    // Post or update resume message
    // If we have a lifecyclePostId, this was a timeout/shutdown - update that post
    // Otherwise create a new post (normal for old persisted sessions without lifecyclePostId)
    const sessionFormatter = session.platform.getFormatter();
    if (session.lifecyclePostId) {
      const postId = session.lifecyclePostId;
      const resumeMsg = `🔄 ${sessionFormatter.formatBold('Session resumed')} by ${sessionFormatter.formatUserMention(session.startedBy)}\n${sessionFormatter.formatItalic('Reconnected to Claude session. You can continue where you left off.')}`;
      await withErrorHandling(
        () => session.platform.updatePost(postId, resumeMsg),
        { action: 'Update timeout/shutdown post for resume', session }
      );
      // Clear the paused state since we're now active again
      session.lifecyclePostId = undefined;
      transitionTo(session, 'active');
    } else {
      // Fallback: create new post if no lifecyclePostId (e.g., old persisted sessions)
      const restartMsg = `${sessionFormatter.formatBold('Session resumed')} after bot restart (v${VERSION})\n${sessionFormatter.formatItalic('Reconnected to Claude session. You can continue where you left off.')}`;
      await post(session, 'resume', restartMsg);
    }

    // Update session header
    await ctx.ops.updateSessionHeader(session);

    // Update sticky channel message with resumed session
    await ctx.ops.updateStickyMessage();

    // Co-author onboarding: if collaborators in this session haven't yet
    // registered a GitHub noreply email, remind them once on resume so
    // they get the chance to fix it before the next commit. Quiet for solo
    // sessions and for sessions where everyone has already registered.
    await postResumeCoAuthorOnboarding(session, ctx);

    // Update persistence with new activity time
    ctx.ops.persistSession(session);
  } catch (err) {
    log.error(`Failed to resume session ${shortId}`, err instanceof Error ? err : undefined);
    auditSessionEnd(session, 'resume-failed');
    session.messageManager?.dispose();
    void session.decisionBridge?.close();
    session.decisionBridge = undefined;
    ctx.ops.emitSessionRemove(sessionId);
    mutableSessions(ctx).delete(sessionId);
    ctx.state.sessionStore.remove(sessionId);
    releaseAccountIfHeld(session, ctx);

    // Try to notify user
    const failFormatter = session.platform.getFormatter();
    await withErrorHandling(
      () => post(session, 'warning', `${failFormatter.formatBold('Could not resume previous session.')} Starting fresh.\n${failFormatter.formatItalic('Your previous conversation context is preserved, but Claude needs to re-read it.')}`),
      { action: 'Post resume failure notification', session }
    );

    // Update sticky message after session removal
    await ctx.ops.updateStickyMessage();
  }
}

// ---------------------------------------------------------------------------
// Session messaging
// ---------------------------------------------------------------------------

/**
 * Send a follow-up message to an existing session.
 *
 * This function handles:
 * - Context prompt flow (offering to include thread history)
 * - Delegating to MessageManager.handleUserMessage() for the normal flow
 */
export async function sendFollowUp(
  session: Session,
  message: string,
  files: PlatformFile[] | undefined,
  ctx: SessionContext,
  username?: string,
  displayName?: string,
  options?: { system?: boolean }
): Promise<void> {
  // The session is registered before its Claude process finishes starting.
  // A message landing in that window must not be dropped — but only wait
  // when a start for this exact key is actually in flight; a genuinely dead
  // session still returns immediately.
  if (!session.claude.isRunning()) {
    if (!_inFlightSessionStarts.has(session.sessionId)) return;
    const deadline = Date.now() + 10_000;
    while (!session.claude.isRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!session.claude.isRunning()) {
      sessionLog(session).warn('sendFollowUp: Claude did not come up in time — message dropped');
      return;
    }
  }

  // Fail-closed authorization gate (#388). Internal/system follow-ups (e.g.
  // passthrough slash commands like /context, already gated upstream by the
  // command executor's isAllowed check) pass `system: true` and skip the
  // identity check. Every user-driven follow-up must carry a username that
  // clears the global allowlist or the session's own allowlist.
  if (!options?.system) {
    if (!isAuthorizedForSession({ username, platform: session.platform, sessionAllowedUsers: session.sessionAllowedUsers })) {
      sessionLog(session).warn(`auth.denied.sendFollowUp: @${username || 'unknown'} not authorized`);
      return;
    }
  }

  // Audit-actor attribution only AFTER the gate — a rejected follow-up must
  // not poison the attribution of subsequent tool calls.
  if (username && !options?.system) session.lastActorUsername = username;

  // Check if we need to offer context prompt (e.g., after !cd)
  // This must happen BEFORE MessageManager handles the message
  if (session.needsContextPromptOnNextMessage) {
    session.needsContextPromptOnNextMessage = false;

    // Prepare for message (flush, reset) but don't send yet
    await session.messageManager?.prepareForUserMessage();

    // offerContextPrompt processes files itself and surfaces skipped-file warnings.
    // We pass the raw text — file content is attached downstream when Claude is sent to.
    const contextOffered = await ctx.ops.offerContextPrompt(session, message, files, undefined, username);
    if (contextOffered) {
      // Context prompt was posted, message is queued - don't send directly
      session.lastActivityAt = new Date();
      return;
    }
    // No thread history or context prompt declined, fall through to send directly
  }

  // Delegate to MessageManager for the normal message flow
  // MessageManager handles: logging, flush/reset/bump, send to Claude, typing indicator
  if (!session.messageManager) {
    sessionLog(session).error('MessageManager not initialized - this should never happen');
    return;
  }

  // Increment message counter
  session.messageCount++;

  await session.messageManager.handleUserMessage(message, files, username, displayName);
}

/**
 * Resume a paused session and send a message to it.
 */
export async function resumePausedSession(
  threadId: string,
  message: string,
  files: PlatformFile[] | undefined,
  ctx: SessionContext,
  username: string,
  platformId: string
): Promise<void> {
  // Find persisted session by raw threadId, scoped to the message's platform.
  //
  // This MUST use the same any-state lookup the paused-session gate in
  // message-handler uses (`registry.getPersistedByThreadId`), not `load()`.
  // `load()` skips soft-deleted records; the gate does not. When the two
  // disagreed, a soft-deleted record routed every message into the paused
  // branch and then died here on "No persisted session found" — and because
  // the paused branch owns the message, the new-session path never ran
  // either. The thread was unreachable in both directions.
  //
  // In direct channel mode, where the channel IS the session, that made the
  // whole channel permanently deaf the moment `!stop` soft-deleted its record.
  const state = ctx.state.sessionStore.findByThreadIdAnyState(threadId, platformId);
  if (!state) {
    log.debug(`No persisted session found for ${threadId.substring(0, 8)}...`);
    return;
  }

  // The gate upstream already hides stopped records, but this is a public sink
  // and the rule belongs where the resurrection actually happens. Any-state
  // means any state — including one whose conversation is over.
  if (!isRevivable(state)) {
    log.debug(`Not resuming stopped session ${threadId.substring(0, 8)}... — it ended`);
    return;
  }

  const shortId = threadId.substring(0, 8);

  // Fail-closed authorization gate (#388). Resume previously ran purely from
  // persisted state with no identity check at the sink — the core gap that let
  // an unauthorized user reach Claude. Rebuild the session allowlist from the
  // persisted state (defensive default to the original owner if the array is
  // missing) and check it alongside the platform's global allowlist.
  const platform = (ctx.state.platforms as Map<string, PlatformClient>).get(state.platformId);
  if (!platform) {
    log.warn(`auth.denied.resume: platform '${state.platformId}' not found for ${shortId}...`);
    return;
  }
  const sessionAllowedUsers = sessionAllowedUserSet(state);
  if (!isAuthorizedForSession({ username, platform, sessionAllowedUsers })) {
    log.warn(`auth.denied.resume: @${username || 'unknown'} not authorized to resume ${shortId}...`);
    return;
  }
  // A record we are about to revive must stop being a tombstone, or `load()`
  // hides it again and the thread is trapped on the next lookup that uses it.
  // Clearing it here — after the authorization gate, so a refused resume
  // cannot launder a soft-deleted session back into the visible set — makes
  // the revival stick.
  if (state.cleanedAt) {
    log.info(`🪦 Reviving soft-deleted session ${shortId}... (resumed by @${username})`);
    delete state.cleanedAt;
    // Both fields, or the record carries a reason for an ending that no longer
    // happened. `resolveEndReason` reads it as undefined without `cleanedAt`,
    // so this is hygiene rather than a bug — but the pair is written together
    // and has to be cleared together, or the next reader has to know that.
    delete state.endReason;
    // Written back here rather than left to the resume's own persistence: the
    // tombstone has to be off DISK, not just off this object, or a restart
    // before the next save puts the thread straight back in the trap.
    ctx.state.sessionStore.save(compositeSessionId(state.platformId, state.threadId), state);
  }

  log.info(`🔄 Resuming paused session ${shortId}... for new message`);

  // Resume the session
  await resumeSession(state, ctx, username);

  // Wait a moment for the session to be ready, then send the message.
  //
  // Resolved by COMPOSITE key, not by raw thread id. `findSessionByThreadId`
  // scans every platform and returns the first match, so if another platform
  // already had a live session under the same raw thread id, this message and
  // its attachments would be handed to that session's messageManager —
  // straight past its authorization gate. platformId is the store's hard
  // privacy boundary; the lookup that delivers the message has to honour it
  // too, not just the one that finds the record.
  const session = (ctx.state.sessions as Map<string, Session>).get(
    compositeSessionId(state.platformId, state.threadId)
  );
  if (session && session.claude.isRunning() && session.messageManager) {
    // Increment message counter and delegate to MessageManager
    session.messageCount++;
    await session.messageManager.handleUserMessage(message, files, username);
  } else {
    log.warn(`Failed to resume session ${shortId}..., could not send message`);
  }
}

// ---------------------------------------------------------------------------
// Session termination
// ---------------------------------------------------------------------------

/**
 * Handle Claude CLI exit event.
 */
export async function handleExit(
  sessionId: string,
  code: number,
  ctx: SessionContext,
  source?: ClaudeCli
): Promise<void> {
  const session = mutableSessions(ctx).get(sessionId);
  const shortId = sessionId.substring(0, 8);

  sessionLog(session).debug(`handleExit called code=${code} isShuttingDown=${ctx.state.isShuttingDown}`);

  if (!session) {
    log.debug(`Session ${shortId}... not found (already cleaned up)`);
    return;
  }

  // A respawn (!cd, !permissions, worktree switch) replaces session.claude
  // and kills the old process. kill() can resolve before the old process's
  // 'exit' event is delivered, so that exit may arrive after the restart
  // already completed — by which point the 'restarting' state guard below
  // has been reset to 'active' by the confirmation post. Treating the stale
  // exit as the current process dying would tear down the freshly restarted
  // session. Only the session's current CLI may drive exit handling.
  if (source && session.claude !== source) {
    sessionLog(session).debug(`Ignoring exit from replaced Claude process`);
    return;
  }

  // If we're intentionally restarting (e.g., !cd), don't clean up
  if (isSessionRestarting(session)) {
    sessionLog(session).debug(`Restarting, skipping cleanup`);
    transitionTo(session, 'active');
    return;
  }

  // If session was cancelled (via !stop or ❌), don't clean up or re-persist
  // The killSession function handles all cleanup - we just exit early here
  if (isSessionCancelled(session)) {
    sessionLog(session).debug(`Cancelled, skipping cleanup (handled by killSession)`);
    return;
  }

  // If bot is shutting down, preserve persistence
  if (ctx.state.isShuttingDown) {
    sessionLog(session).debug(`Bot shutting down, preserving persistence`);
    await cleanupSession(session, ctx, {
      action: 'exit',
      details: { reason: 'shutdown', exitCode: code },
      cleanupPostIndex: false,  // Preserve for faster shutdown
      auditReason: 'shutdown',
    });
    return;
  }

  // If session was interrupted, preserve for resume (only if Claude has responded)
  if (session.lifecycle.state === 'interrupted') {
    sessionLog(session).debug(`Exited after interrupt, preserving for resume`);
    ctx.ops.stopTyping(session);
    cleanupSessionTimers(session);
    await closeThreadLogger(session, 'interrupt', { exitCode: code }, 'pause');

    // Notify user first, then persist with the lifecyclePostId
    // This ensures the session won't auto-resume on bot restart
    const message = session.lifecycle.hasClaudeResponded
      ? `ℹ️ Session paused. Send a new message to continue.`
      : `ℹ️ Session ended before Claude could respond. Send a new message to start fresh.`;
    const pausePost = await withErrorHandling(
      () => post(session, 'info', message),
      { action: 'Post session pause notification', session }
    );

    // Only persist if Claude actually responded (otherwise there's nothing to resume)
    if (session.lifecycle.hasClaudeResponded) {
      // Mark as paused so it won't auto-resume on bot restart
      transitionTo(session, 'paused');
      if (pausePost) {
        session.lifecyclePostId = pausePost.id;
        ctx.ops.registerPost(pausePost.id, session.threadId);
      }
      ctx.ops.persistSession(session);
    }
    removeFromRegistry(session, ctx, 'pause');
    sessionLog(session).info(`⏸ Session paused`);
    // Update sticky channel message after session pause
    await ctx.ops.updateStickyMessage();
    return;
  }

  // If session exits before Claude responded, notify user (no point trying to resume)
  const wasResumed = session.lifecycle.resumeFailCount > 0 || session.lifecycle.state !== 'starting';
  if (!session.lifecycle.hasClaudeResponded && !wasResumed) {
    sessionLog(session).debug(`Exited before Claude responded, not persisting`);
    await cleanupSession(session, ctx, {
      action: 'exit',
      details: { reason: 'early_exit', exitCode: code },
      auditReason: 'early-exit',
    });
    // Notify user (session object still valid, just removed from map)
    const earlyExitFormatter = session.platform.getFormatter();
    await withErrorHandling(
      () => post(session, 'warning', `${earlyExitFormatter.formatBold('Session ended')} before Claude could respond (exit code ${code}). Please start a new session.`),
      { action: 'Post early exit notification', session }
    );
    sessionLog(session).info(`⚠ Session ended early (exit code ${code})`);
    await ctx.ops.updateStickyMessage();
    return;
  }

  // For resumed sessions that exit with error, track failures and give up after too many
  if (wasResumed && code !== 0) {
    const MAX_RESUME_FAILURES = 3;
    session.lifecycle.resumeFailCount = (session.lifecycle.resumeFailCount || 0) + 1;

    // Check if this is a permanent failure that shouldn't be retried
    const isPermanent = session.claude.isPermanentFailure();
    const permanentReason = session.claude.getPermanentFailureReason();

    sessionLog(session).debug(`Resumed session failed with code ${code}, attempt ${session.lifecycle.resumeFailCount}/${MAX_RESUME_FAILURES}, permanent=${isPermanent}`);
    // Skip closeLogger (session is already persisted, logger may be closed)
    // Skip cleanupPostIndex (was already cleaned on original session end)
    // Every non-starting session lands here on a non-zero exit ('wasResumed'
    // is a proxy, not a real resume marker), so the audit trail records the
    // plain fact — exit with this code — not a guessed resume history. A
    // signal death (code null) matches the normal-exit path's plain 'exit'.
    auditSessionEnd(session, code === null ? 'exit' : `exit:${code}`);
    await cleanupSession(session, ctx, {
      closeLogger: false,
      cleanupPostIndex: false,
    });

    // Immediately give up on permanent failures
    const resumeFailFormatter = session.platform.getFormatter();
    if (isPermanent) {
      sessionLog(session).warn(`Detected permanent failure, removing from persistence: ${permanentReason}`);
      // Unregister from worktree but don't cleanup - user may want to recover work
      // Orphan cleanup will handle it after 24h
      if (session.worktreeInfo) {
        ctx.ops.unregisterWorktreeUser(session.worktreeInfo.worktreePath, session.sessionId);
      }
      ctx.ops.unpersistSession(session.sessionId);
      await withErrorHandling(
        () => postError(session, `${resumeFailFormatter.formatBold('Session cannot be resumed')} — ${permanentReason}\n\nPlease start a new session.`),
        { action: 'Post session permanent failure', session }
      );
      await ctx.ops.updateStickyMessage();
      return;
    }

    if (session.lifecycle.resumeFailCount >= MAX_RESUME_FAILURES) {
      // Too many failures - give up and delete from persistence
      sessionLog(session).warn(`Exceeded ${MAX_RESUME_FAILURES} resume failures, removing from persistence`);
      // Unregister from worktree but don't cleanup - user may want to recover work
      // Orphan cleanup will handle it after 24h
      if (session.worktreeInfo) {
        ctx.ops.unregisterWorktreeUser(session.worktreeInfo.worktreePath, session.sessionId);
      }
      ctx.ops.unpersistSession(session.sessionId);
      await withErrorHandling(
        () => postError(session, `${resumeFailFormatter.formatBold('Session permanently failed')} after ${MAX_RESUME_FAILURES} resume attempts (exit code ${code}). Session data has been removed. Please start a new session.`),
        { action: 'Post session permanent failure', session }
      );
    } else {
      // Still have retries left - persist with updated fail count
      ctx.ops.persistSession(session);
      await withErrorHandling(
        () => post(session, 'warning', `${resumeFailFormatter.formatBold('Session resume failed')} (exit code ${code}, attempt ${session.lifecycle.resumeFailCount}/${MAX_RESUME_FAILURES}). Will retry on next bot restart.`),
        { action: 'Post session resume failure', session }
      );
    }

    // Update sticky channel message after session failure
    await ctx.ops.updateStickyMessage();
    return;
  }

  // Normal exit cleanup
  sessionLog(session).debug(`Normal exit, cleaning up`);

  // Distill the thread into channel memory (fire-and-forget; never blocks teardown)
  scheduleDistillation(session, ctx, 'exit');

  ctx.ops.stopTyping(session);
  cleanupSessionTimers(session);
  await closeThreadLogger(session, 'exit', { exitCode: code }, code === 0 || code === null ? 'exit' : `exit:${code}`);

  // Unpin task post on session exit (get from MessageManager, source of truth)
  const exitTaskState = session.messageManager?.getTaskListState();
  if (exitTaskState?.postId) {
    await session.platform.unpinPost(exitTaskState.postId).catch(() => {});
  }

  await ctx.ops.flush(session);

  if (code !== 0 && code !== null) {
    const exitFormatter = session.platform.getFormatter();
    await post(session, 'info', exitFormatter.formatBold(`[Exited: ${code}]`));
  }

  // Unregister from worktree reference counting, but DON'T cleanup automatically
  // Worktrees are preserved for potential reuse - cleanup happens via:
  // - !worktree cleanup command (manual)
  // - Orphan cleanup on startup (worktrees > 24h old with no session)
  if (session.worktreeInfo) {
    ctx.ops.unregisterWorktreeUser(session.worktreeInfo.worktreePath, session.sessionId);
  }

  // Clean up session from maps and notify keep-alive. A signal death
  // (code null) is a clean end like code 0 — matching closeThreadLogger and
  // the unpersist branch below, so no path can label it 'exit:null'.
  removeFromRegistry(session, ctx, code === 0 || code === null ? 'exit' : `exit:${code}`);

  // Only unpersist for normal exits
  if (code === 0 || code === null) {
    ctx.ops.unpersistSession(session.sessionId);
  } else {
    sessionLog(session).debug(`Non-zero exit, preserving for potential retry`);
  }

  sessionLog(session).info(`■ Session ended`);

  // Update sticky channel message after session end
  await ctx.ops.updateStickyMessage();
}

/**
 * Kill a specific session.
 */
export async function killSession(
  session: Session,
  unpersist: boolean,
  ctx: SessionContext,
  auditCause: string = 'kill'
): Promise<void> {
  // Set restarting state to prevent handleExit from also unpersisting
  if (!unpersist) {
    transitionTo(session, 'restarting');
  }

  // A real kill (not a pause/respawn) ends the conversation — distill it into
  // channel memory. Fire-and-forget; snapshots state before teardown.
  if (unpersist) {
    scheduleDistillation(session, ctx, 'stop');
  }

  ctx.ops.stopTyping(session);
  await closeThreadLogger(session, 'kill', { unpersist }, auditCause);
  session.claude.kill();

  // Unpin task post on session kill (get from MessageManager, source of truth)
  const killTaskState = session.messageManager?.getTaskListState();
  if (killTaskState?.postId) {
    await session.platform.unpinPost(killTaskState.postId).catch(() => {});
  }

  // Unregister from worktree reference counting, but DON'T cleanup automatically
  // Worktrees are preserved for potential reuse - cleanup via !worktree cleanup or orphan cleanup
  if (unpersist && session.worktreeInfo) {
    ctx.ops.unregisterWorktreeUser(session.worktreeInfo.worktreePath, session.sessionId);
  }

  // Clean up session from maps and notify keep-alive
  removeFromRegistry(session, ctx, auditCause);

  // Explicitly unpersist if requested
  if (unpersist) {
    ctx.ops.unpersistSession(session.sessionId);
  }

  sessionLog(session).info(`✖ Session killed`);

  // Update sticky channel message after session kill
  await ctx.ops.updateStickyMessage();
}

/**
 * Kill all active sessions.
 * If isShuttingDown is true, persists sessions before killing so they can resume on restart.
 * Returns a Promise that resolves when all processes have exited.
 */
export async function killAllSessions(ctx: SessionContext): Promise<void> {
  const killPromises: Promise<void>[] = [];

  for (const session of ctx.state.sessions.values()) {
    ctx.ops.stopTyping(session);
    // Persist session state before killing if we're shutting down gracefully
    if (ctx.state.isShuttingDown) {
      ctx.ops.persistSession(session);
    }
    // Record the cause before the raw kill: the per-session exit handlers
    // only see a generic exit and may even be skipped when the registry is
    // cleared below first — the exactly-once guard makes their write a no-op.
    auditSessionEnd(session, ctx.state.isShuttingDown ? 'shutdown' : 'kill');
    killPromises.push(session.claude.kill());
  }

  // Wait for all processes to exit
  await Promise.all(killPromises);

  mutableSessions(ctx).clear();
  mutablePostIndex(ctx).clear();

  // Force stop keep-alive
  keepAlive.forceStop();
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up idle sessions that have timed out.
 */
export async function cleanupIdleSessions(
  timeoutMs: number,
  warningMs: number,
  ctx: SessionContext
): Promise<void> {
  const now = Date.now();

  for (const [_sessionId, session] of ctx.state.sessions) {
    const idleMs = now - session.lastActivityAt.getTime();

    // Check for timeout
    if (idleMs > timeoutMs) {
      const waitingOnHuman =
        session.isProcessing &&
        (session.messageManager?.hasPendingApproval() === true ||
          session.messageManager?.hasPendingQuestions() === true);
      sessionLog(session).info(
        waitingOnHuman
          ? `⏰ Session stopped after ${Math.round(idleMs / 60000)}min waiting on a human decision`
          : session.isProcessing
            ? `⏰ Session stopped responding - no events for ${Math.round(idleMs / 60000)}min with a turn open`
            : `⏰ Session timed out after ${Math.round(idleMs / 60000)}min idle`
      );

      const timeoutFormatter = session.platform.getFormatter();
      // A session reaped while `isProcessing` was never idle: it had an open
      // turn. Claiming inactivity there is false and sends the user looking in
      // the wrong place, so the cases get different text (#548). Three of them:
      // the turn is blocked on a human decision (the bot is waiting on *them*),
      // the turn went silent on its own (wedged CLI, dropped API connection, one
      // long-running tool), or the session was genuinely idle between turns.
      //
      // The pending check covers plan approvals and questions, which the bot
      // holds in-process. An ordinary MCP permission prompt is owned by the MCP
      // child and is not visible here, so that case still reads as silence —
      // see #533 for the bridge line that would close the gap.
      const timeoutMessage = waitingOnHuman
        ? `${timeoutFormatter.formatBold('Session still waiting')} for a reply - no answer for ${Math.round(idleMs / 60000)} minutes, so the turn was stopped\n\n💡 React with 🔄 to resume, or send a new message to continue.`
        : session.isProcessing
          ? `${timeoutFormatter.formatBold('Session stopped responding')} - no output for ${Math.round(idleMs / 60000)} minutes while a turn was still running\n\n💡 React with 🔄 to resume, or send a new message to continue.`
          : `${timeoutFormatter.formatBold('Session timed out')} after ${Math.round(idleMs / 60000)} minutes of inactivity\n\n💡 React with 🔄 to resume, or send a new message to continue.`;

      // Update existing warning post or create a new one
      if (session.lifecyclePostId) {
        // Update the existing warning post to show timeout
        const postId = session.lifecyclePostId;
        await withErrorHandling(
          () => session.platform.updatePost(postId, `⏱️ ${timeoutMessage}`),
          { action: 'Update timeout post', session }
        );
      } else {
        // Create new timeout post (no warning was posted)
        const timeoutPost = await withErrorHandling(
          () => post(session, 'timeout', timeoutMessage),
          { action: 'Post session timeout', session }
        );
        if (timeoutPost) {
          session.lifecyclePostId = timeoutPost.id;
          ctx.ops.registerPost(timeoutPost.id, session.threadId);
        }
      }
      // Mark as paused so it won't auto-resume on bot restart
      transitionTo(session, 'paused');
      ctx.ops.persistSession(session);

      // A timed-out thread is usually done — distill it into channel memory.
      // If it resumes and ends again later, the dedupe pass absorbs the second
      // distillation. (killSession(unpersist=false) itself does not distill.)
      scheduleDistillation(session, ctx, 'timeout');

      // Kill without unpersisting to allow resume
      await killSession(session, false, ctx, 'timeout');
      continue;
    }

    // Check for warning threshold (warn when X minutes before timeout)
    // warningMs = how long before timeout to warn (e.g., 5 min = 300000)
    // So warn when: idleMs > (timeoutMs - warningMs)
    const warningThresholdMs = timeoutMs - warningMs;
    if (idleMs > warningThresholdMs && !session.timeoutWarningPosted) {
      const remainingMins = Math.max(0, Math.round((timeoutMs - idleMs) / 60000));
      const warningFormatter = session.platform.getFormatter();
      // Same distinction as the timeout branch (#548): with a turn open this
      // is not idleness, it is silence from a turn that should be producing
      // events. Naming it that way is the difference between "you forgot
      // about me" and "something may be wrong".
      const warnWaiting =
        session.isProcessing &&
        (session.messageManager?.hasPendingApproval() === true ||
          session.messageManager?.hasPendingQuestions() === true);
      const warningMessage = warnWaiting
        ? `${warningFormatter.formatBold('Session still waiting')} for a reply - will stop in ~${remainingMins} minutes without one`
        : session.isProcessing
          ? `${warningFormatter.formatBold('No output for a while')} - a turn is still running; will stop in ~${remainingMins} minutes if nothing arrives`
          : `${warningFormatter.formatBold('Session idle')} - will timeout in ~${remainingMins} minutes without activity`;

      // Create the warning post and store its ID for later updates
      const warningPost = await withErrorHandling(
        () => post(session, 'timeout', warningMessage),
        { action: 'Post timeout warning', session }
      );
      if (warningPost) {
        session.lifecyclePostId = warningPost.id;
        ctx.ops.registerPost(warningPost.id, session.threadId);
      }
      session.timeoutWarningPosted = true;
      sessionLog(session).debug(`⏰ Idle warning posted`);
    }
  }
}
