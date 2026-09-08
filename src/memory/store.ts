/**
 * MemoryStore — bot-managed persistent memory, layered like Anthropic's own
 * products do it:
 *
 * - **Channel layer** (Claude Tag style): one `MEMORY.md` per platform
 *   instance, shared by every thread in that channel. Written only by the bot
 *   process (`!remember`, end-of-session distillation); injected into each
 *   session's append-system-prompt.
 * - **Repo layer** (Claude Code style): a per-(platformId, repo) directory
 *   that Claude Code's native auto-memory is redirected into via the
 *   `autoMemoryDirectory` setting. The CLI owns reads/writes there; the bot
 *   only owns the location.
 *
 * `platformId` is the hard privacy boundary — a platform instance maps to one
 * channel, so this mirrors Claude Tag's per-channel memory isolation. No API
 * on this class reads across platform directories.
 *
 * Storage root: `~/.config/claude-threads/memory/` (0700 dirs, 0600 files),
 * overridable via `CLAUDE_THREADS_MEMORY_DIR`. The root is resolved from the
 * BOT process's homedir at construction — deliberately immune to the account
 * pool's per-session child `HOME` overrides (see buildClaudeChildEnv), which
 * must never move memory.
 *
 * Layout:
 *   <root>/<platformSeg>/channel/MEMORY.md   channel layer (bot-written)
 *   <root>/<platformSeg>/repos/<repoKey>/    repo layer (CLI-written)
 *
 * Both `<platformSeg>` and `<repoKey>` carry a short content hash so two ids
 * that sanitize to the same segment (`team:a` vs `team_a`) can never merge
 * privacy boundaries.
 *
 * The channel `MEMORY.md` is itself the store — human-inspectable markdown,
 * one entry per line. Lines that don't parse (hand edits) are preserved
 * verbatim on rewrite, count against caps, but are not addressable by
 * `!memory forget <n>`.
 */

import { createHash } from 'crypto';
import { stateHome } from '../utils/state-home.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'fs';
import { basename, dirname, join, sep } from 'path';
import { SerialQueue, writeFileAtomic } from '../persistence/atomic-file.js';
import { createLogger } from '../utils/logger.js';
import { getMainRepositoryRoot } from '../git/worktree.js';
import type { ResolvedMemoryConfig } from '../config/types.js';

const log = createLogger('memory');

const DEFAULT_ROOT = join(stateHome(), '.config', 'claude-threads', 'memory');

/**
 * Read-time caps for the system-prompt block. Mirror the native auto-memory
 * limits (Claude Code loads the first 200 lines / 25KB of MEMORY.md).
 */
export const CHANNEL_BLOCK_MAX_LINES = 200;
export const CHANNEL_BLOCK_MAX_BYTES = 25 * 1024;

/** Hard write-time cap so the channel file can't grow unboundedly. */
export const CHANNEL_FILE_MAX_ENTRIES = 400;

/** Max length of a single entry's text (single line, enforced on add). */
export const MAX_ENTRY_LENGTH = 500;

const FILE_HEADER = '# Channel memory — managed by claude-threads.';

/**
 * Entry line format: `- [YYYY-MM-DD] (@user) text`, `(distilled)`, or
 * `(agent)` — the last written by Claude itself via the `remember_fact` MCP
 * tool. Compat note: a pre-agent-source bot parses `(agent)` lines as raw
 * lines — preserved across rewrites, shown by `!memory`, but not
 * forgettable-by-number until upgraded.
 */
const ENTRY_RE = /^- \[(\d{4}-\d{2}-\d{2})\] \((@[^\s)]+|distilled|agent)\) (.+)$/;

export type ChannelMemorySource = 'user' | 'distilled' | 'agent';

export interface ChannelMemoryEntry {
  text: string;
  /** YYYY-MM-DD */
  addedAt: string;
  source: ChannelMemorySource;
  /** Username, only for `source: 'user'`. */
  addedBy?: string;
}

export interface NewChannelMemoryEntry {
  text: string;
  source: ChannelMemorySource;
  addedBy?: string;
}

export interface AddEntriesResult {
  added: ChannelMemoryEntry[];
  /** Candidate texts skipped because an equivalent entry already exists. */
  duplicates: string[];
  /**
   * Existing entries removed because a new entry contains them (longer, more
   * specific form wins). Only entries the writer may replace land here — see
   * the supersede rule in `addChannelEntries`. Surfaced so callers can report
   * replacements instead of removing entries silently.
   */
  superseded: ChannelMemoryEntry[];
}

export type ForgetResult =
  | { ok: true; removed: ChannelMemoryEntry }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'empty'; matches: ChannelMemoryEntry[] };

/** One physical line of the channel file: a parsed entry or a preserved raw line. */
interface FileLine {
  raw: string;
  entry?: ChannelMemoryEntry;
}

/** Reduce an id to a single path-safe segment. */
export function safeIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

function shortHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/**
 * Path segment for a platform id: sanitized + short hash so distinct raw ids
 * can never collide after sanitization.
 */
export function platformSegment(platformId: string): string {
  return `${safeIdSegment(platformId) || 'platform'}-${shortHash(platformId, 6)}`;
}

/**
 * Derive the repo key for the repo memory layer. Worktree-aware: worktrees of
 * the same repository share one key, mirroring native auto-memory which is
 * shared across worktrees. `worktreeRepoRoot` (from
 * `session.worktreeInfo.repoRoot`) is a fast path for bot-managed worktrees;
 * without it, `getMainRepositoryRoot` follows any linked worktree back to its
 * main repository via `--git-common-dir` — so paths that reach a worktree
 * some other way (e.g. `!cd` into one) still key to the shared root.
 * Outside a git repo, the working directory itself is the key. Symlinked
 * paths resolve to one key via realpath.
 */
export async function resolveRepoKey(
  workingDir: string,
  worktreeRepoRoot?: string,
): Promise<string> {
  // getMainRepositoryRoot never throws — it returns null when the directory
  // is not a git repo (or git is unavailable), so workingDir is the fallback.
  const root =
    worktreeRepoRoot ?? (await getMainRepositoryRoot(workingDir)) ?? workingDir;
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // Path may not exist yet (tests, races) — hash the literal path.
  }
  return `${safeIdSegment(basename(real)) || 'repo'}-${shortHash(real, 10)}`;
}

/**
 * The session's recorded worktree repoRoot, but ONLY while the session still
 * works inside that worktree. `session.worktreeInfo` is not cleared by `!cd`
 * (it only changes on `!worktree` operations), so a session that started in a
 * worktree of repo A and then `!cd`-ed into repo B still carries repo A's
 * repoRoot — blindly passing it to `resolveRepoKey` would key repo B's memory
 * to repo A. When the recorded worktree no longer contains the working
 * directory this returns undefined and `resolveRepoKey` derives the key from
 * the working directory itself (which is worktree-aware on its own via
 * `getMainRepositoryRoot`). The fast path still matters for a deleted
 * worktree on resume, where git derivation has nothing to inspect.
 */
export function activeWorktreeRepoRoot(
  workingDir: string,
  worktreeInfo: { worktreePath?: string; repoRoot?: string } | undefined,
): string | undefined {
  // Defensive optional fields: legacy persisted sessions may miss either one.
  if (!worktreeInfo?.repoRoot || !worktreeInfo.worktreePath) return undefined;
  const { worktreePath, repoRoot } = worktreeInfo;
  if (workingDir === worktreePath || workingDir.startsWith(worktreePath + sep)) {
    return repoRoot;
  }
  return undefined;
}

/** Normalize an entry text for dedupe comparison. */
function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?\s]+$/g, '').trim();
}

/** Collapse to a single line (newlines become `; `, whitespace runs collapse). */
function collapseEntryText(text: string): string {
  return text.replace(/\s*[\r\n\u0085]+\s*/g, '; ').replace(/[\s\u0085]+/g, ' ').trim();
}

/** Collapse to a single line and cap the length. */
export function sanitizeEntryText(text: string): string {
  return collapseEntryText(text).slice(0, MAX_ENTRY_LENGTH);
}

/**
 * Whether `sanitizeEntryText` would actually truncate this text. Checked on
 * the collapsed form — newline collapsing can lengthen the text (`\n` → `; `),
 * so the raw input length is not a reliable proxy.
 */
export function entryTextExceedsCap(text: string): boolean {
  return collapseEntryText(text).length > MAX_ENTRY_LENGTH;
}

/** Canonical provenance label: '@name' for user entries, the source name
 *  otherwise. Shared by the file format, `!memory`, and `list_memory`. */
export function entrySourceLabel(entry: ChannelMemoryEntry): string {
  return entry.source === 'user' ? `@${entry.addedBy ?? 'unknown'}` : entry.source;
}

function formatEntryLine(entry: ChannelMemoryEntry): string {
  return `- [${entry.addedAt}] (${entrySourceLabel(entry)}) ${entry.text}`;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export class MemoryStore {
  private readonly root: string;

  /**
   * Per-platform in-process mutex: mutating ops chain onto the tail promise so
   * concurrent writers (e.g. two sessions distilling at once) serialize. The
   * bot is a single process and the CLI never touches `channel/`, so an
   * in-process lock is sufficient.
   */
  private readonly locks: Map<string, SerialQueue> = new Map();

  constructor(rootDir?: string) {
    this.root = rootDir ?? process.env.CLAUDE_THREADS_MEMORY_DIR ?? DEFAULT_ROOT;
  }

  get rootDir(): string {
    return this.root;
  }

  /** Absolute path of a platform's channel memory file. */
  channelMemoryPath(platformId: string): string {
    return join(this.root, platformSegment(platformId), 'channel', 'MEMORY.md');
  }

  /**
   * Absolute path of the repo-layer auto-memory directory for a repo key.
   * Ensures the directory exists with owner-only permissions so the spawned
   * CLI can write into it immediately.
   */
  repoMemoryDir(platformId: string, repoKey: string): string {
    const dir = join(this.root, platformSegment(platformId), 'repos', repoKey);
    this.ensureDir(dir);
    return dir;
  }

  /** Parsed entries of a platform's channel memory, in file order. */
  listChannelEntries(platformId: string): ChannelMemoryEntry[] {
    return this.loadLines(platformId)
      .map((l) => l.entry)
      .filter((e): e is ChannelMemoryEntry => e !== undefined);
  }

  /**
   * Append entries to the channel memory, deduped against existing content.
   * Serialized per platform; enforces the hard file cap (oldest distilled
   * entries are dropped first on overflow).
   */
  addChannelEntries(
    platformId: string,
    entries: NewChannelMemoryEntry[],
  ): Promise<AddEntriesResult> {
    return this.runExclusive(platformId, () => {
      const lines = this.loadLines(platformId);
      const result: AddEntriesResult = { added: [], duplicates: [], superseded: [] };

      for (const candidate of entries) {
        const text = sanitizeEntryText(candidate.text);
        if (!text) continue;
        const normalized = normalizeForDedupe(text);
        const existing = lines
          .map((l) => l.entry)
          .filter((e): e is ChannelMemoryEntry => e !== undefined);
        const isDuplicate = existing.some((e) => {
          const en = normalizeForDedupe(e.text);
          if (en === normalized) return true;
          // Containment counts as a duplicate only for non-user candidates
          // (distilled, agent). An explicit user `!remember` that is a
          // fragment of an existing entry may be a correction or
          // contradiction ("use npm" vs a stored "never use npm") — it must
          // land, not be swallowed as known.
          return candidate.source !== 'user' && en.includes(normalized);
        });
        if (isDuplicate) {
          result.duplicates.push(text);
          continue;
        }
        // If the new entry supersedes (contains) an existing one, drop the
        // shorter old entry — keep the longer, more specific form. But ONLY
        // when the writer legitimately owns the old entry: removal is
        // otherwise an owner-gated operation (`!memory forget` requires
        // requireSessionOwner), and `!remember` is open to any
        // session-authorized user — including temporarily invited ones —
        // so an unrestricted supersede would let a non-owner silently
        // delete/rewrite another principal's entry by embedding its text.
        // Rule: non-user entries (distilled, agent) are fair game for anyone
        // (background inference / model output, no human author); a user
        // entry may only be superseded by the SAME user — in particular an
        // agent candidate can never displace a user's entry. Anything else
        // coexists — visible in `!memory`, and the owner can resolve the
        // contradiction with `forget`.
        const canSupersede = (e: ChannelMemoryEntry): boolean =>
          e.source !== 'user' ||
          (candidate.source === 'user' && e.source === 'user' && e.addedBy === candidate.addedBy);
        for (let i = lines.length - 1; i >= 0; i--) {
          const e = lines[i].entry;
          if (e && canSupersede(e) && normalized.includes(normalizeForDedupe(e.text))) {
            result.superseded.push(e);
            lines.splice(i, 1);
          }
        }
        const entry: ChannelMemoryEntry = {
          text,
          addedAt: todayStamp(),
          source: candidate.source,
          addedBy: candidate.source === 'user' ? candidate.addedBy : undefined,
        };
        lines.push({ raw: formatEntryLine(entry), entry });
        result.added.push(entry);
      }

      if (result.added.length > 0) {
        this.enforceFileCap(lines);
        this.writeLines(platformId, lines);
        log.debug(
          `Channel memory for ${platformId}: +${result.added.length} entries` +
          (result.duplicates.length ? ` (${result.duplicates.length} duplicates skipped)` : ''),
        );
      }
      return result;
    });
  }

  /**
   * Remove one entry, selected by 1-based index (into `listChannelEntries`
   * order) or by case-insensitive substring that must match exactly one entry.
   */
  forgetChannelEntry(platformId: string, selector: number | string): Promise<ForgetResult> {
    return this.runExclusive(platformId, () => {
      const lines = this.loadLines(platformId);
      const entryLines: Array<{ lineIndex: number; entry: ChannelMemoryEntry }> = [];
      lines.forEach((l, i) => {
        if (l.entry) entryLines.push({ lineIndex: i, entry: l.entry });
      });

      if (entryLines.length === 0) {
        return { ok: false as const, reason: 'empty' as const, matches: [] };
      }

      let target: { lineIndex: number; entry: ChannelMemoryEntry };
      if (typeof selector === 'number') {
        if (!Number.isInteger(selector) || selector < 1 || selector > entryLines.length) {
          return { ok: false as const, reason: 'not-found' as const, matches: [] };
        }
        target = entryLines[selector - 1];
      } else {
        const needle = selector.toLowerCase().trim();
        const matches = entryLines.filter((el) =>
          el.entry.text.toLowerCase().includes(needle),
        );
        if (matches.length === 0) {
          return { ok: false as const, reason: 'not-found' as const, matches: [] };
        }
        if (matches.length > 1) {
          return {
            ok: false as const,
            reason: 'ambiguous' as const,
            matches: matches.map((el) => el.entry),
          };
        }
        target = matches[0];
      }

      lines.splice(target.lineIndex, 1);
      this.writeLines(platformId, lines);
      log.debug(`Channel memory for ${platformId}: removed one entry`);
      return { ok: true as const, removed: target.entry };
    });
  }

  /** Clear the whole channel memory (for `!memory forget all`). */
  clearChannel(platformId: string): Promise<void> {
    return this.runExclusive(platformId, () => {
      this.writeLines(platformId, []);
      log.debug(`Channel memory for ${platformId}: cleared`);
    });
  }

  /**
   * Render the channel memory as a system-prompt block, capped at the native
   * limits (200 lines / 25KB). Retention on overflow is newest-first: oldest
   * `distilled` entries are dropped first, then oldest other lines. Returns
   * null when the channel has no memory.
   */
  buildChannelMemoryBlock(platformId: string): string | null {
    let lines: FileLine[];
    try {
      lines = this.loadLines(platformId);
    } catch (err) {
      log.warn(`Failed to read channel memory for ${platformId}: ${(err as Error).message}`);
      return null;
    }
    if (lines.length === 0) return null;

    let truncated = false;
    const overCap = (ls: FileLine[]): boolean => {
      if (ls.length > CHANNEL_BLOCK_MAX_LINES) return true;
      const bytes = Buffer.byteLength(ls.map((l) => l.raw).join('\n'), 'utf-8');
      return bytes > CHANNEL_BLOCK_MAX_BYTES;
    };
    while (lines.length > 1 && overCap(lines)) {
      truncated = true;
      // Oldest model-written (distilled/agent) entries go first; user
      // entries and hand edits survive longest.
      const modelIdx = lines.findIndex((l) => l.entry !== undefined && l.entry.source !== 'user');
      lines.splice(modelIdx >= 0 ? modelIdx : 0, 1);
    }

    const rendered = lines.map((l) => l.raw).join('\n');
    return truncated
      ? `${rendered}\n_(older entries omitted — \`!memory\` shows all)_`
      : rendered;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Serialize a mutating operation per platform id. */
  private runExclusive<T>(platformId: string, fn: () => T): Promise<T> {
    let queue = this.locks.get(platformId);
    if (!queue) {
      queue = new SerialQueue();
      this.locks.set(platformId, queue);
    }
    return queue.run(fn);
  }

  /**
   * Load the channel file as ordered lines. Unparseable non-header, non-blank
   * lines are kept as raw lines so hand edits survive rewrites.
   */
  private loadLines(platformId: string): FileLine[] {
    const file = this.channelMemoryPath(platformId);
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf-8');
    const lines: FileLine[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trimEnd();
      // Skip blanks and the managed header only — other `#` lines are hand
      // edits (e.g. section headings) and must survive rewrites like any
      // other unparseable line.
      if (!trimmed || trimmed === FILE_HEADER) continue;
      const m = trimmed.match(ENTRY_RE);
      if (m) {
        const source: ChannelMemorySource =
          m[2] === 'distilled' ? 'distilled' : m[2] === 'agent' ? 'agent' : 'user';
        lines.push({
          raw: trimmed,
          entry: {
            addedAt: m[1],
            source,
            addedBy: source === 'user' ? m[2].slice(1) : undefined,
            text: m[3],
          },
        });
      } else {
        lines.push({ raw: trimmed });
      }
    }
    return lines;
  }

  /** Enforce the hard write cap: drop oldest model-written (distilled/agent)
   *  entries first, then oldest lines. */
  private enforceFileCap(lines: FileLine[]): void {
    while (lines.length > CHANNEL_FILE_MAX_ENTRIES) {
      const modelIdx = lines.findIndex((l) => l.entry !== undefined && l.entry.source !== 'user');
      lines.splice(modelIdx >= 0 ? modelIdx : 0, 1);
    }
  }

  private writeLines(platformId: string, lines: FileLine[]): void {
    const file = this.channelMemoryPath(platformId);
    this.ensureDir(dirname(file));
    const content = [FILE_HEADER, ...lines.map((l) => l.raw)].join('\n') + '\n';
    writeFileAtomic(file, content);
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

/**
 * Compute the `ClaudeCliOptions.memory` value for a session spawn: the
 * redirected native auto-memory directory when the platform's repo layer is
 * enabled, or null (which disables native auto-memory entirely via the
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` kill switch — see buildClaudeChildEnv).
 */
export async function resolveSessionMemory(
  memoryStore: MemoryStore,
  memoryConfig: ResolvedMemoryConfig,
  platformId: string,
  workingDir: string,
  worktreeRepoRoot?: string,
): Promise<{ autoMemoryDir: string } | null> {
  if (!memoryConfig.enabled || !memoryConfig.repoLayer) return null;
  try {
    const repoKey = await resolveRepoKey(workingDir, worktreeRepoRoot);
    return { autoMemoryDir: memoryStore.repoMemoryDir(platformId, repoKey) };
  } catch (err) {
    log.warn(`Failed to resolve repo memory dir for ${platformId}: ${(err as Error).message}`);
    return null;
  }
}
