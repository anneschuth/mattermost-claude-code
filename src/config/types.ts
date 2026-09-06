/**
 * Configuration type definitions for claude-threads
 */

import type { AutoUpdateConfig, AutoRestartMode, ScheduledWindow } from '../auto-update/types.js';
import type { TranscriptionConfig } from '../transcription/types.js';
import type { DirectChannelModeConfig, ApprovalsMode } from '../platform/utils.js';

// Re-export auto-update types for convenience
export type { AutoUpdateConfig, AutoRestartMode, ScheduledWindow };

// =============================================================================
// Types
// =============================================================================

export type WorktreeMode = 'off' | 'prompt' | 'require';

/**
 * Visibility for the bot's "overhead" posts (per-thread session header and
 * channel sticky). Per-platform — see `PlatformInstanceConfig.sessionHeader`
 * and `PlatformInstanceConfig.stickyMessage`.
 *
 * - `full` (default): full table / sessions list, today's behavior.
 * - `minimal`: one-line status bar only.
 * - `hidden`: don't post at all.
 */
export type OverheadVisibility = 'full' | 'minimal' | 'hidden';

export const OVERHEAD_VISIBILITY_VALUES: readonly OverheadVisibility[] = ['full', 'minimal', 'hidden'] as const;

export const DEFAULT_OVERHEAD_VISIBILITY: OverheadVisibility = 'full';

export function isOverheadVisibility(value: unknown): value is OverheadVisibility {
  return typeof value === 'string' && (OVERHEAD_VISIBILITY_VALUES as readonly string[]).includes(value);
}

/**
 * Normalize a per-platform overhead-visibility field. Undefined → default.
 * Throws on any other invalid value so config errors surface at startup
 * instead of silently falling back.
 */
export function resolveOverheadVisibility(
  value: unknown,
  fieldPath: string,
): OverheadVisibility {
  if (value === undefined || value === null) return DEFAULT_OVERHEAD_VISIBILITY;
  if (isOverheadVisibility(value)) return value;
  throw new Error(
    `Invalid ${fieldPath}: expected one of ${OVERHEAD_VISIBILITY_VALUES.join(', ')}, got ${JSON.stringify(value)}`,
  );
}

/**
 * Per-platform overhead visibility, captured at platform-registration time.
 * Both fields are required after normalization (defaults applied during
 * `addPlatform`). Used as the value-type for SessionManager's per-platform
 * map and the return type of `SessionOperations.getPlatformOverhead`.
 */
export interface PlatformOverhead {
  sessionHeader: OverheadVisibility;
  stickyMessage: OverheadVisibility;
  /** End-of-turn marker (docs/turn-marker-spec.md). Defaults to `off`. */
  turnMarker: TurnMarkerSettings;
}

// =============================================================================
// Turn marker (per-platform, default off)
// =============================================================================

export const TURN_MARKER_VALUES = ['reaction', 'metadata', 'off'] as const;
export type TurnMarkerMode = (typeof TURN_MARKER_VALUES)[number];

export interface TurnMarkerSettings {
  mode: TurnMarkerMode;
  /** `reaction` only. */
  emoji?: string;
}

export const DEFAULT_TURN_MARKER: TurnMarkerSettings = { mode: 'off' };
export const DEFAULT_TURN_MARKER_EMOJI = 'checkered_flag';
/** Slack message metadata `event_type` the daemon stamps on a turn's last reply post. */
export const TURN_COMPLETE_EVENT_TYPE = 'claude_threads_turn_complete';

/**
 * Normalize the per-platform `turnMarker` / `turnMarkerEmoji` pair. Undefined
 * → `off`. `metadata` exists only on Slack; an emoji only with `reaction`.
 * Throws with the field path, so a wrong block fails the boot.
 */
export function resolveTurnMarker(
  mode: unknown,
  emoji: unknown,
  platformType: string,
  fieldPath: string,
): TurnMarkerSettings {
  const m = mode === undefined || mode === null ? 'off' : mode;
  if (!(TURN_MARKER_VALUES as readonly unknown[]).includes(m)) {
    throw new Error(`Invalid ${fieldPath}.turnMarker: expected one of ${TURN_MARKER_VALUES.join(', ')}, got ${JSON.stringify(mode)}`);
  }
  if (m === 'metadata' && platformType !== 'slack') {
    throw new Error(`Invalid ${fieldPath}.turnMarker: metadata is a Slack feature; use reaction on ${platformType}`);
  }
  // An emoji with another mode is ignored (YAML anchors, a commented-out
  // mode); a malformed one is still an error, whatever the mode.
  if (emoji !== undefined && emoji !== null) {
    if (typeof emoji !== 'string' || !/^[a-z0-9_+-]+$/.test(emoji)) {
      throw new Error(`Invalid ${fieldPath}.turnMarkerEmoji: expected an emoji name like checkered_flag, got ${JSON.stringify(emoji)}`);
    }
  }
  if (m === 'reaction') return { mode: 'reaction', emoji: (emoji as string | undefined) ?? DEFAULT_TURN_MARKER_EMOJI };
  return { mode: m as TurnMarkerMode };
}

// =============================================================================
// Memory (per-platform, default on)
// =============================================================================

/**
 * Per-platform `memory` option as written in config.yaml.
 *
 * - omitted / `true` → fully enabled (the default)
 * - `false` → fully disabled
 * - object → per-layer toggles, all gated by `enabled`:
 *   - `repoLayer`: Claude Code native auto-memory, redirected into a
 *     bot-managed per-(platform, repo) directory
 *   - `channelLayer`: shared per-channel notes injected into every session's
 *     system prompt (Claude Tag style)
 *   - `distillation`: end-of-session haiku pass that distills the thread into
 *     channel-memory entries (only meaningful when `channelLayer` is on)
 */
export type MemoryOption =
  | boolean
  | {
      enabled?: boolean;
      repoLayer?: boolean;
      channelLayer?: boolean;
      distillation?: boolean;
    };

/** Fully-resolved memory settings for one platform instance. */
export interface ResolvedMemoryConfig {
  enabled: boolean;
  repoLayer: boolean;
  channelLayer: boolean;
  distillation: boolean;
}

export const DEFAULT_MEMORY_CONFIG: ResolvedMemoryConfig = {
  enabled: true,
  repoLayer: true,
  channelLayer: true,
  distillation: true,
};

export const MEMORY_DISABLED: ResolvedMemoryConfig = {
  enabled: false,
  repoLayer: false,
  channelLayer: false,
  distillation: false,
};

/**
 * Normalize a per-platform `memory` field. Undefined/`true` → all on (the
 * chosen default), `false` → all off, object → per-field `??` defaults gated
 * by `enabled`. Malformed values warn and fall back to the default rather
 * than failing startup — memory is an enhancement, not a prerequisite.
 */
export function resolveMemoryConfig(value: unknown, fieldPath?: string): ResolvedMemoryConfig {
  if (value === undefined || value === null || value === true) return DEFAULT_MEMORY_CONFIG;
  if (value === false) return MEMORY_DISABLED;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as { enabled?: unknown; repoLayer?: unknown; channelLayer?: unknown; distillation?: unknown };
    const bool = (v: unknown, name: string, dflt: boolean): boolean =>
      resolveBooleanFeature(v, `${fieldPath ?? 'memory'}.${name}`, { default: dflt, verb: `using default (${dflt})` });
    const enabled = bool(obj.enabled, 'enabled', true);
    if (!enabled) return MEMORY_DISABLED;
    return {
      enabled: true,
      repoLayer: bool(obj.repoLayer, 'repoLayer', true),
      channelLayer: bool(obj.channelLayer, 'channelLayer', true),
      distillation: bool(obj.distillation, 'distillation', true),
    };
  }
  console.warn(
    `Invalid ${fieldPath ?? 'memory'} config: expected boolean or {enabled, repoLayer, channelLayer, distillation}, got ${JSON.stringify(value)} — using defaults`,
  );
  return DEFAULT_MEMORY_CONFIG;
}

// =============================================================================
// Routines (per-platform, default on)
// =============================================================================

/**
 * Normalize the per-platform `routines` field: scheduled recurring work
 * (Claude Tag-style). Undefined/`true` → enabled (the default; there is no
 * idle cost until someone creates a routine), `false` → the scheduler skips
 * the platform and the !routine/!routines commands explain themselves.
 * Malformed values warn and fall back to enabled.
 */
export function resolveRoutinesEnabled(value: unknown, fieldPath?: string): boolean {
  return resolveBooleanFeature(value, fieldPath ?? 'routines', { default: true, verb: 'routines stay enabled' });
}

/**
 * Normalize the per-platform `transcription` field. Undefined → enabled, so a
 * configured provider applies everywhere by default; `false` opts one platform
 * out. Inert when no top-level `transcription:` block exists.
 *
 * ⚠️ Unlike the other feature flags, an UNREADABLE value fails closed. The
 * others govern whether the bot does something for you; this one governs
 * whether a channel's audio is uploaded to a third party. `transcription:
 * "false"` — a quoted boolean, the most likely way to get this wrong in YAML —
 * must not be read as consent. Undefined still means enabled: that is the
 * documented default and an operator who configured a provider chose it.
 */
export function resolveTranscriptionEnabled(value: unknown, fieldPath?: string): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  console.warn(
    `Invalid ${fieldPath ?? 'transcription'}: ${JSON.stringify(value)} — expected true or false. ` +
      `Transcription is DISABLED for this platform: a value we cannot read is not consent to upload its audio.`,
  );
  return false;
}

/**
 * Shared normalization for boolean feature flags: undefined/null and the
 * default pass through; the other boolean flips; anything else warns and
 * falls back to the default — features that are safe when idle default on,
 * an audit trail that half-works defaults off.
 */
function resolveBooleanFeature(
  value: unknown,
  fieldPath: string,
  opts: { default: boolean; verb: string },
): boolean {
  if (value === true || value === false) return value;
  if (value === undefined || value === null) return opts.default;
  console.warn(
    `Invalid ${fieldPath} config: expected boolean, got ${JSON.stringify(value)} — ${opts.verb}`,
  );
  return opts.default;
}

/**
 * Normalize the per-platform `watches` field: event triggers (Claude
 * Tag-style proactiveness). Undefined/`true` → enabled (no idle cost until
 * someone creates a watch), `false` → the evaluator skips the platform and
 * the !watch/!watches commands explain themselves. Malformed values warn and
 * fall back to enabled.
 */
export function resolveWatchesEnabled(value: unknown, fieldPath?: string): boolean {
  return resolveBooleanFeature(value, fieldPath ?? 'watches', { default: true, verb: 'watches stay enabled' });
}

/**
 * Normalize the per-platform `auditLog` field. Only `true` enables it;
 * malformed values warn and stay off — an audit trail that half-works is
 * worse than none, the operator should notice at startup.
 */
export function resolveAuditLogEnabled(value: unknown, fieldPath?: string): boolean {
  return resolveBooleanFeature(value, fieldPath ?? 'auditLog', { default: false, verb: 'audit log stays off' });
}

/**
 * Thread logging configuration
 */
export interface ThreadLogsConfig {
  enabled?: boolean;        // Default: true
  retentionDays?: number;   // Default: 30 - days to keep logs after session ends
}

/**
 * Resource limits and timeouts configuration
 * All fields are optional with sensible defaults. Additions here must stay
 * backward-compatible (optional + defaulted) — `config.yaml` files in the
 * wild predate most of these fields.
 */
export interface LimitsConfig {
  /** Maximum concurrent sessions (default: 5) */
  maxSessions?: number;
  /** Idle timeout before auto-terminate session, in minutes (default: 30) */
  sessionTimeoutMinutes?: number;
  /** Warn user N minutes before session timeout (default: 5) */
  sessionWarningMinutes?: number;
  /** Background cleanup run frequency, in minutes (default: 60) */
  cleanupIntervalMinutes?: number;
  /** Cleanup orphaned worktrees older than N hours (default: 24) */
  maxWorktreeAgeHours?: number;
  /** Enable automatic cleanup of orphaned worktrees (default: true) */
  cleanupWorktrees?: boolean;
  /** Timeout for permission approval reactions, in seconds (default: 120) */
  permissionTimeoutSeconds?: number;
  /**
   * Delay between the first streaming chunk and flushing the batched output
   * to the platform, in ms (default: 500). Lower = snappier updates +
   * more API calls. Higher = fewer posts + coarser visible streaming.
   */
  flushDelayMs?: number;
  /** Maximum routines per platform instance (default: 10). */
  maxRoutines?: number;
  /** Maximum watches (event triggers) per platform instance (default: 10). */
  maxWatches?: number;
  /** Minimum minutes between fires of one watch (default: 5). */
  watchCooldownMinutes?: number;
  /** Maximum fires per watch per day (default: 20). */
  watchDailyCap?: number;
}

/**
 * Resolved limits. Every field is non-optional so downstream code doesn't
 * defend itself.
 */
export interface ResolvedLimits {
  maxSessions: number;
  sessionTimeoutMinutes: number;
  sessionWarningMinutes: number;
  cleanupIntervalMinutes: number;
  maxWorktreeAgeHours: number;
  cleanupWorktrees: boolean;
  permissionTimeoutSeconds: number;
  flushDelayMs: number;
  maxRoutines: number;
  maxWatches: number;
  watchCooldownMinutes: number;
  watchDailyCap: number;
}

/**
 * Default values for LimitsConfig
 */
export const LIMITS_DEFAULTS: ResolvedLimits = {
  maxSessions: 5,
  sessionTimeoutMinutes: 30,
  sessionWarningMinutes: 5,
  cleanupIntervalMinutes: 60,
  maxWorktreeAgeHours: 24,
  cleanupWorktrees: true,
  permissionTimeoutSeconds: 120,
  flushDelayMs: 500,
  maxRoutines: 10,
  maxWatches: 10,
  watchCooldownMinutes: 5,
  watchDailyCap: 20,
};

/**
 * Resolve limits config with defaults, supporting env var fallback for backward compatibility
 */
export function resolveLimits(limits?: LimitsConfig): ResolvedLimits {
  // Support legacy env vars as fallback
  const envMaxSessions = process.env.MAX_SESSIONS ? parseInt(process.env.MAX_SESSIONS, 10) : undefined;
  const envSessionTimeout = process.env.SESSION_TIMEOUT_MS
    ? Math.round(parseInt(process.env.SESSION_TIMEOUT_MS, 10) / 60000) // Convert ms to minutes
    : undefined;

  return {
    maxSessions: limits?.maxSessions ?? envMaxSessions ?? LIMITS_DEFAULTS.maxSessions,
    sessionTimeoutMinutes: limits?.sessionTimeoutMinutes ?? envSessionTimeout ?? LIMITS_DEFAULTS.sessionTimeoutMinutes,
    sessionWarningMinutes: limits?.sessionWarningMinutes ?? LIMITS_DEFAULTS.sessionWarningMinutes,
    cleanupIntervalMinutes: limits?.cleanupIntervalMinutes ?? LIMITS_DEFAULTS.cleanupIntervalMinutes,
    maxWorktreeAgeHours: limits?.maxWorktreeAgeHours ?? LIMITS_DEFAULTS.maxWorktreeAgeHours,
    cleanupWorktrees: limits?.cleanupWorktrees ?? LIMITS_DEFAULTS.cleanupWorktrees,
    permissionTimeoutSeconds: limits?.permissionTimeoutSeconds ?? LIMITS_DEFAULTS.permissionTimeoutSeconds,
    flushDelayMs: limits?.flushDelayMs ?? LIMITS_DEFAULTS.flushDelayMs,
    maxRoutines: limits?.maxRoutines ?? LIMITS_DEFAULTS.maxRoutines,
    maxWatches: limits?.maxWatches ?? LIMITS_DEFAULTS.maxWatches,
    watchCooldownMinutes: limits?.watchCooldownMinutes ?? LIMITS_DEFAULTS.watchCooldownMinutes,
    watchDailyCap: limits?.watchDailyCap ?? LIMITS_DEFAULTS.watchDailyCap,
  };
}

/**
 * Sticky message customization
 */
export interface StickyMessageCustomization {
  /** Custom description shown below the title (e.g., what the bot does) */
  description?: string;
  /** Custom footer content shown before the default "Mention me to start a session" line */
  footer?: string;
}

/**
 * One Claude subscription/account the bot can spawn sessions under.
 *
 * Exactly one of `home` or `apiKey` should be set:
 * - `home`: path to an alternate $HOME that contains `.claude/.credentials.json`
 *   from a prior `HOME=<path> claude login`. Used for OAuth Pro/Max subscriptions.
 *   Claude's history (`~/.claude/projects/...`) also lives here, so a resumed
 *   session MUST pick the same account.
 * - `apiKey`: direct Anthropic API key. Billed against that key's account.
 *   History still persists under the bot's default HOME because Claude only
 *   uses `apiKey` for billing, not for state storage.
 *
 * Leaving `claudeAccounts` unset in config keeps the bot in single-account mode:
 * every session inherits `process.env` exactly as before.
 */
export interface ClaudeAccount {
  /** Stable identifier used in logs, UI, and persisted session state. */
  id: string;
  /** Alternate $HOME for OAuth-based accounts. Mutually exclusive with apiKey. */
  home?: string;
  /** Anthropic API key for API-billed accounts. Mutually exclusive with home. */
  apiKey?: string;
  /** Optional human-readable label shown in UI (defaults to `id`). */
  displayName?: string;
}

export interface Config {
  version: number;
  workingDir: string;
  chrome: boolean;
  worktreeMode: WorktreeMode;
  /**
   * Default for the per-session "respond only when @mentioned" toggle (#402).
   * When `true`, every NEW session starts in quiet mode (the bot only replies
   * to thread messages that @mention it); users can still flip it per-session
   * with `!mentions`. Omitted/`false` keeps the original behavior (the bot
   * responds to every approved-user reply). Does not affect already-running or
   * resumed sessions — each session persists its own value.
   */
  respondOnlyWhenMentioned?: boolean;
  /**
   * Prefix each user turn sent to Claude with the sender's `[@username]:` so
   * Claude can tell who is speaking in a shared thread. Default `true`.
   *
   * The prefix is only actually applied once a session has more than one
   * participant (after `!invite`, or another user reviving a paused session) —
   * in a solo thread there is only one person it could be, so attribution stays
   * silent. Set `false` to disable the feature outright.
   *
   * Applies to NEW sessions; resumed sessions keep the value they were started
   * with, and sessions persisted before this flag existed stay unattributed.
   */
  userAttribution?: boolean;
  keepAlive?: boolean; // Optional, defaults to true when undefined
  autoUpdate?: Partial<AutoUpdateConfig>; // Optional auto-update configuration
  threadLogs?: ThreadLogsConfig; // Optional thread logging configuration
  limits?: LimitsConfig; // Optional resource limits and timeouts
  stickyMessage?: StickyMessageCustomization; // Optional sticky message customization
  /** Optional Claude account pool. When omitted, bot runs in single-account mode. */
  claudeAccounts?: ClaudeAccount[];
  /**
   * Optional speech-to-text for inbound audio attachments (voice notes).
   * One provider per daemon, applied to every platform. Omitted = audio is
   * saved and listed like any other file. See docs/audio-transcription-spec.md.
   */
  transcription?: TranscriptionConfig;
  platforms: PlatformInstanceConfig[];
}

export interface PlatformInstanceConfig {
  id: string;
  type: 'mattermost' | 'slack';
  displayName: string;
  /**
   * Direct channel mode (DCM): treat the whole configured channel as one
   * session. The bot replies with top-level channel posts instead of thread
   * replies — the channel reads like a plain conversation. Only one session
   * runs per platform instance in this mode (the channel *is* the session).
   *
   * Shorthand `true` enables DCM with defaults; the long form configures it:
   *
   * ```yaml
   * directChannelMode:
   *   respondTo: all_messages   # or: mention
   * ```
   *
   * Who may approve tool use is the platform-level `approvals` option.
   *
   * Internally the session is keyed by a synthetic thread id
   * (`dcm:<platformId>`), so persistence, resume, reactions, and permission
   * prompts work exactly as they do for thread sessions.
   *
   * Default `false` (classic thread-per-session behavior).
   */
  directChannelMode?: DirectChannelModeConfig;
  /**
   * Who may answer tool-permission prompts and other reaction gates (plan
   * approvals, question answers, resume) for this platform's sessions:
   * `owner` (session participants — starter plus `!invite`d users) or
   * `all_users` (everyone on `allowedUsers`).
   *
   * Unset keeps the historical default per mode: `all_users` for thread
   * sessions (unchanged upstream behavior), `owner` for direct channel mode.
   * Setting it applies to both modes.
   */
  approvals?: ApprovalsMode;
  /**
   * Acknowledge accepted messages with an instant reaction (a read receipt).
   * The bot reacts on every message it actually accepts for processing —
   * session start, follow-up, resume — before Claude produces any output.
   * Unlike the typing indicator this is persistent and survives reconnects,
   * so users in busy channels can see at a glance that their message landed.
   * `true` uses 👀 (`eyes`); a string names a custom emoji. Default off.
   */
  ackReaction?: boolean | string;
  /**
   * Append-only audit trail of what the bot executed for this platform:
   * tool calls, session lifecycle, security-relevant commands, plan
   * approvals. One JSONL stream per platform under
   * `~/.claude-threads/audit/` (override: `CLAUDE_THREADS_AUDIT_DIR`),
   * never deleted by the bot. Default off.
   */
  auditLog?: boolean;
  /**
   * Per-thread session header visibility. Default `'full'`.
   * `'minimal'` keeps only the one-line status bar; `'hidden'` skips the
   * header post entirely so Claude's own response is the first message in
   * the thread.
   */
  sessionHeader?: OverheadVisibility;
  /**
   * Channel-level sticky message visibility for this platform. Default `'full'`.
   * `'minimal'` keeps only the one-line status bar (no active-sessions list);
   * `'hidden'` disables the sticky entirely (no post, no bumping). Distinct
   * from the top-level `Config.stickyMessage` block, which only customizes
   * the sticky's `description` / `footer` for platforms still rendering it.
   */
  stickyMessage?: OverheadVisibility;
  /**
   * End-of-turn marker on the reply's last post, for integrations that read
   * the channel: `reaction` (an emoji, any platform), `metadata` (Slack
   * message metadata, invisible), `off` (default). See docs/turn-marker-spec.md.
   */
  turnMarker?: TurnMarkerMode;
  /** `turnMarker: reaction` only: the emoji name; default `checkered_flag`. */
  turnMarkerEmoji?: string;
  /**
   * Persistent memory for this platform instance (default: fully enabled).
   * See `MemoryOption` for the accepted shapes and layer semantics.
   */
  memory?: MemoryOption;
  /**
   * Scheduled routines for this platform instance (default: enabled).
   * `false` disables the scheduler and the !routine/!routines commands.
   */
  routines?: boolean;
  /**
   * Event triggers (watches) for this platform instance (default: enabled).
   * `false` disables message evaluation and the !watch/!watches commands.
   */
  watches?: boolean;
  /**
   * Transcribe inbound audio attachments in this platform's channels
   * (default: enabled wherever the top-level `transcription:` block is
   * configured; a no-op without it).
   *
   * The provider and its key are a property of the DEPLOYMENT — one vendor
   * account per daemon — so they live at the top level. Whether a given
   * channel should have its voice notes sent to that vendor at all is a
   * property of the CHANNEL, which is what this opts out of: a channel whose
   * audio must not leave the box can say so without disabling transcription
   * for every other channel.
   */
  transcription?: boolean;
  // Platform-specific fields (TypeScript allows extra properties)
  [key: string]: unknown;
}

// =============================================================================
// Permission modes
// =============================================================================

/**
 * How tool-use permissions are enforced for Claude sessions.
 *
 * - `default`: Claude always asks before using a tool; the bot posts a permission
 *   prompt in the thread and the user reacts 👍 / ✅ / 👎 to allow/allow-all/deny.
 *   This is the safest option and the historical behavior when
 *   `skipPermissions: false`.
 *
 * - `auto`: Claude's built-in classifier decides per-tool-use. Low-risk tools
 *   (Read, Grep, Write within the working dir) are auto-approved; high-risk
 *   tools (shell with external effects, writes outside the working dir) still
 *   prompt via the MCP permission server. Introduced in Claude CLI 2.1.x.
 *   New in this config; no backward-compat shim needed.
 *
 * - `bypass`: No prompts, no classifier — every tool-use is allowed. Equivalent
 *   to passing `--dangerously-skip-permissions` to the Claude CLI. This is what
 *   the legacy `skipPermissions: true` maps to.
 */
export type PermissionMode = 'default' | 'auto' | 'bypass';

/**
 * Resolve the effective permission mode from new + legacy fields. New config
 * wins; legacy `skipPermissions` is honored when `permissionMode` is unset.
 *
 * Returns `'default'` when both are unset — the safe choice for ambiguous
 * configs (asks the user to decide rather than silently bypassing).
 */
export function resolvePermissionMode(opts: {
  permissionMode?: PermissionMode;
  /** @deprecated Use `permissionMode` instead. Kept for backward compat. */
  skipPermissions?: boolean;
}): PermissionMode {
  if (opts.permissionMode) return opts.permissionMode;
  if (opts.skipPermissions === true) return 'bypass';
  if (opts.skipPermissions === false) return 'default';
  return 'default';
}

/**
 * Single source of truth for user-facing metadata per permission mode.
 * Every consumer (sticky message, session header, `!permissions` post) reads
 * from this record — add a new field here and it's available everywhere.
 */
const MODE_INFO: Record<PermissionMode, {
  icon: string;
  label: string;
  description: string;
}> = {
  default: {
    icon: '🔐',
    label: 'Default',
    description: 'Every tool-use prompts for approval.',
  },
  auto: {
    icon: '⚡',
    label: 'Auto',
    description: 'Claude classifier auto-approves low-risk tools; high-risk still prompts.',
  },
  bypass: {
    icon: '⚠️',
    label: 'Bypass',
    description: 'No prompts — every tool-use is allowed.',
  },
};

/**
 * Display metadata for a permission mode. One source of truth for the
 * `{icon} {label}` chips used in the sticky message, session header, and the
 * `!permissions` confirmation post.
 */
export function permissionModeDisplay(
  mode: PermissionMode,
): { icon: string; label: string; /** "🔐 Default" */ chip: string } {
  const info = MODE_INFO[mode];
  return { icon: info.icon, label: info.label, chip: `${info.icon} ${info.label}` };
}

/**
 * Human-readable description of what a permission mode actually does.
 * Used in `!permissions` confirmation posts so users know what they opted into.
 */
export function permissionModeDescription(mode: PermissionMode): string {
  return MODE_INFO[mode].description;
}

/**
 * Compute a session's effective permission mode.
 *
 * Precedence (highest wins):
 *   1. `override` — explicit in-process override set by `!permissions <mode>`
 *      on this session. Not persisted.
 *   2. `sessionHasInteractiveOverride` — sticky `default` opt-in flag
 *      (persists across bot restart via `PersistedSession.forceInteractivePermissions`).
 *   3. `botWideMode` — the bot's current default mode.
 *
 * Used both for user-facing display (session header, `isSessionInteractive`)
 * and for choosing the mode when respawning Claude after `!cd` / plugin
 * install/uninstall / worktree switch. In both cases the semantic is the
 * same: "what mode should THIS session run under right now?"
 */
export function effectivePermissionMode(input: {
  override?: PermissionMode;
  sessionHasInteractiveOverride: boolean;
  botWideMode: PermissionMode;
}): PermissionMode {
  if (input.override) return input.override;
  if (input.sessionHasInteractiveOverride) return 'default';
  return input.botWideMode;
}

// =============================================================================
// Platform configs
// =============================================================================

/**
 * Outbound file (`send_file`) settings. When omitted, defaults to
 * `{ enabled: true, maxBytes: 100 MB }`.
 */
export interface OutboundFilesConfig {
  /** When false, the `send_file` MCP tool returns an error to Claude. */
  enabled?: boolean;
  /** Per-file size cap. Defaults to 100 MB. */
  maxBytes?: number;
}

export interface MattermostPlatformConfig extends PlatformInstanceConfig {
  type: 'mattermost';
  url: string;
  token: string;
  channelId: string;
  /**
   * DM auto-discovery: when `true`, a direct message to the bot from a user
   * on `allowedUsers` spawns a derived platform instance for that DM channel
   * (direct channel mode, sticky hidden, scoped to the DM partner) — no
   * per-DM config entry needed. Mattermost only; see
   * `src/platform/dm-discovery.ts` for why Slack is excluded.
   */
  directMessages?: boolean;
  botName: string;
  allowedUsers: string[];
  /**
   * @deprecated Use `permissionMode` instead. Kept for backward compatibility
   * with existing config.yaml files. When both are set, `permissionMode` wins.
   */
  skipPermissions?: boolean;
  /** Preferred way to configure permissions. See `PermissionMode`. */
  permissionMode?: PermissionMode;
  /** Outbound `send_file` settings. */
  outboundFiles?: OutboundFilesConfig;
}

export interface SlackPlatformConfig extends PlatformInstanceConfig {
  type: 'slack';
  botToken: string;
  appToken: string;
  channelId: string;
  botName: string;
  allowedUsers: string[];
  /**
   * @deprecated Use `permissionMode` instead. Kept for backward compatibility
   * with existing config.yaml files. When both are set, `permissionMode` wins.
   */
  skipPermissions?: boolean;
  /** Preferred way to configure permissions. See `PermissionMode`. */
  permissionMode?: PermissionMode;
  /** Optional API URL override for testing (defaults to https://slack.com/api) */
  apiUrl?: string;
  /** Outbound `send_file` settings. */
  outboundFiles?: OutboundFilesConfig;
}
