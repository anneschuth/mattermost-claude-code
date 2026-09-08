/**
 * Audit Log
 *
 * Append-only, per-platform JSONL record of what the bot actually executed:
 * tool calls, session lifecycle, security-relevant commands, plan approvals.
 *
 * Distinct from thread logs (per-thread debug artifacts with retention): the
 * audit trail is one flat stream per platform, spans sessions, and is NEVER
 * deleted by the bot — rotation/retention is the operator's call (logrotate,
 * SIEM ingestion). Files are 0600 in a 0700 directory; entries may contain
 * command lines verbatim, which is the point of an audit trail and the same
 * confidentiality level as thread logs.
 *
 * Opt-in per platform via `auditLog: true`. Disabled platforms pay one map
 * lookup per call.
 */

import { chmodSync, closeSync, constants as fsConstants, fchmodSync, lstatSync, mkdirSync, openSync, writeSync } from 'fs';
import { stateHome } from '../utils/state-home.js';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('audit');

export type AuditKind =
  | 'tool_use'
  | 'session_start'
  | 'session_resume'
  | 'session_end'
  | 'command'
  | 'plan_approval';

export interface AuditEntry {
  ts: string;
  platformId: string;
  threadId: string;
  sessionId?: string;
  /** Username that triggered the audited action (best effort; see docs). */
  actor?: string;
  kind: AuditKind;
  /** Tool name for kind 'tool_use'. */
  tool?: string;
  /** Compact human-relevant detail: command line, file path, pattern, ... */
  detail?: string;
  /** True when the tool call ran inside a subagent sidechain. */
  subagent?: boolean;
  /** For 'plan_approval': whether the plan was approved. */
  approved?: boolean;
}

/** Cap per-entry detail so a pathological command can't bloat the trail. */
const DETAIL_MAX = 500;

const enabledPlatforms = new Set<string>();
const preparedDirs = new Set<string>();
// One long-lived fd per platform file: avoids per-write open/close and lets
// us enforce modes once, including on pre-existing files.
const openFds = new Map<string, number>();

function auditDir(): string {
  return process.env.CLAUDE_THREADS_AUDIT_DIR || join(stateHome(), '.claude-threads', 'audit');
}

/** Enable/disable the audit trail for a platform (called at registration). */
export function configureAuditLog(platformId: string, enabled: boolean): void {
  if (enabled) enabledPlatforms.add(platformId);
  else enabledPlatforms.delete(platformId);
}

export function isAuditEnabled(platformId: string): boolean {
  return enabledPlatforms.has(platformId);
}

/** Test hook: clear all configured platforms and close cached files. */
export function _resetAuditLog(): void {
  enabledPlatforms.clear();
  preparedDirs.clear();
  for (const fd of openFds.values()) {
    try { closeSync(fd); } catch { /* already closed */ }
  }
  openFds.clear();
}

/**
 * Open (once) the platform's audit file with hardening that also covers
 * PRE-EXISTING artifacts: refuse symlinks and non-regular files, open with
 * O_NOFOLLOW where the platform supports it, and enforce 0600 via fchmod —
 * `mkdir`/`open` modes only apply at creation and would silently reuse a
 * world-readable leftover otherwise.
 */
function openAuditFd(platformId: string): number {
  const cached = openFds.get(platformId);
  if (cached !== undefined) return cached;

  const dir = auditDir();
  if (!preparedDirs.has(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    preparedDirs.add(dir);
  }
  // encodeURIComponent is filename-safe and collision-free (unlike lossy
  // separator replacement); platform ids are operator-controlled config.
  const file = join(dir, `${encodeURIComponent(platformId)}.jsonl`);
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`audit path exists but is not a regular file: ${file}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow, 0o600);
  try {
    fchmodSync(fd, 0o600);
  } catch {
    // Windows: fchmod is a no-op territory; POSIX platforms enforce.
  }
  openFds.set(platformId, fd);
  return fd;
}

/**
 * Append one entry to the platform's audit file. Failures are logged and
 * swallowed: auditing must never take message handling down. Writes are
 * synchronous appends on a cached fd — a write is one `write(2)` on an
 * already-open descriptor (microseconds), and a buffered trail that loses
 * its tail on crash defeats the purpose of an audit log.
 */
export function auditLog(
  platformId: string,
  entry: Omit<AuditEntry, 'ts' | 'platformId'>
): void {
  if (!enabledPlatforms.has(platformId)) return;
  try {
    const full: AuditEntry = {
      ts: new Date().toISOString(),
      platformId,
      ...entry,
      ...(entry.detail !== undefined ? { detail: entry.detail.slice(0, DETAIL_MAX) } : {}),
    };
    writeSync(openAuditFd(platformId), JSON.stringify(full) + '\n');
  } catch (err) {
    // Drop the cached fd so the next write retries a fresh open (the file may
    // have been rotated away underneath us).
    const fd = openFds.get(platformId);
    if (fd !== undefined) {
      openFds.delete(platformId);
      try { closeSync(fd); } catch { /* already closed */ }
    }
    log.warn(`audit write failed for ${platformId}: ${err}`);
  }
}

/**
 * Compact, audit-relevant detail for a tool call. Mirrors what a reviewer
 * actually asks: which command, which file, which pattern.
 */
export function auditDetailForTool(tool: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  switch (tool) {
    case 'Bash':
      return str(input.command);
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return str(input.file_path);
    case 'Grep':
    case 'Glob':
      return str(input.pattern);
    case 'WebFetch':
    case 'WebSearch':
      return str(input.url) ?? str(input.query);
    default: {
      try {
        return JSON.stringify(input);
      } catch {
        return undefined;
      }
    }
  }
}
