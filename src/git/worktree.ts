import { crossSpawn } from '../utils/spawn.js';
import { stateHome } from '../utils/state-home.js';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '../utils/logger.js';

const log = createLogger('git-wt');

/** Centralized worktree location for easy cleanup */
const WORKTREES_DIR = path.join(stateHome(), '.claude-threads', 'worktrees');

/**
 * Metadata stored alongside each worktree for cleanup tracking
 */
export interface WorktreeMetadata {
  repoRoot: string;           // Original repo path
  branch: string;             // Branch name
  createdAt: string;          // ISO date
  lastActivityAt: string;     // ISO date - updated on session activity
  sessionId?: string;         // Current session using this worktree (if any)
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
  isBare: boolean;
}

/**
 * Execute a git command and return stdout
 */
async function execGit(args: string[], cwd: string): Promise<string> {
  const cmd = `git ${args.join(' ')}`;
  log.debug(`Executing: ${cmd}`);

  return new Promise((resolve, reject) => {
    const proc = crossSpawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        log.debug(`${cmd} → success`);
        resolve(stdout.trim());
      } else {
        log.debug(`${cmd} → failed (code=${code}): ${stderr.substring(0, 100) || stdout.substring(0, 100)}`);
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      log.warn(`${cmd} → error: ${err}`);
      reject(err);
    });
  });
}

/**
 * Check if a directory is inside a git repository
 */
export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--git-dir'], dir);
    return true;
  } catch (err) {
    log.debug(`Not a git repository: ${dir} (${err})`);
    return false;
  }
}

/**
 * Get the root directory of the git repository
 */
export async function getRepositoryRoot(dir: string): Promise<string> {
  return execGit(['rev-parse', '--show-toplevel'], dir);
}

/**
 * Get the MAIN repository root for a directory, following a linked worktree
 * back to the repository it was created from. For a plain checkout this
 * equals `getRepositoryRoot`; inside a `git worktree` checkout,
 * `--git-common-dir` points at the main repository's `.git` directory.
 * Returns null when the directory is not inside a git repository.
 */
export async function getMainRepositoryRoot(dir: string): Promise<string | null> {
  try {
    const toplevel = await getRepositoryRoot(dir);
    const commonOut = (await execGit(['rev-parse', '--git-common-dir'], dir)).trim();
    if (commonOut) {
      // May be relative to the cwd the command ran in (e.g. `.git`).
      const commonDir = path.isAbsolute(commonOut) ? commonOut : path.resolve(dir, commonOut);
      // Standard layout: <main-root>/.git — anything else (bare repos,
      // GIT_DIR overrides) falls back to the worktree's own toplevel.
      if (path.basename(commonDir) === '.git') {
        return path.dirname(commonDir);
      }
    }
    return toplevel;
  } catch {
    return null;
  }
}

/**
 * Get the current branch name for a directory
 * Returns null if not on a branch (detached HEAD) or not in a git repo
 */
export async function getCurrentBranch(dir: string): Promise<string | null> {
  try {
    const branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    // If HEAD is detached, git returns "HEAD"
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Get the default branch name (main or master)
 */
export async function getDefaultBranch(repoRoot: string): Promise<string> {
  try {
    // First try to get from origin/HEAD
    const remoteHead = await execGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot);
    return remoteHead.replace('origin/', '');
  } catch {
    // Fall back to checking for main or master
    try {
      await execGit(['rev-parse', '--verify', 'main'], repoRoot);
      return 'main';
    } catch {
      try {
        await execGit(['rev-parse', '--verify', 'master'], repoRoot);
        return 'master';
      } catch {
        return 'main'; // Default fallback
      }
    }
  }
}

/**
 * Check if a branch has been merged into the default branch (main/master)
 * Returns true if:
 * 1. The branch has commits that were merged into the default branch, AND
 * 2. The branch is not at the same commit as the default branch (i.e., it's not a fresh branch)
 *
 * This prevents accidentally deleting new branches that were just created from main
 * but haven't had any commits yet.
 */
export async function isBranchMerged(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    const defaultBranch = await getDefaultBranch(repoRoot);

    // Skip if checking the default branch itself
    if (branchName === defaultBranch) {
      return false;
    }

    // Fetch to ensure we have latest refs (ignore errors - might be offline)
    await execGit(['fetch', 'origin', defaultBranch], repoRoot).catch(() => {});

    // Get the commit hashes for both branches
    const branchCommit = await execGit(['rev-parse', branchName], repoRoot);
    const defaultCommit = await execGit(['rev-parse', `origin/${defaultBranch}`], repoRoot);

    // If branch is at the same commit as default, it's a fresh branch - NOT merged
    // This prevents deleting branches that were just created from main
    if (branchCommit === defaultCommit) {
      return false;
    }

    // Check if branch commit is ancestor of default branch
    // merge-base --is-ancestor exits 0 if ancestor, 1 if not
    await execGit(['merge-base', '--is-ancestor', branchName, `origin/${defaultBranch}`], repoRoot);
    return true;
  } catch {
    // Not merged or error checking
    return false;
  }
}

/**
 * Check if there are uncommitted changes (staged or unstaged)
 */
export async function hasUncommittedChanges(dir: string): Promise<boolean> {
  try {
    // Check for staged changes
    const staged = await execGit(['diff', '--cached', '--quiet'], dir).catch(() => 'changes');
    if (staged === 'changes') return true;

    // Check for unstaged changes
    const unstaged = await execGit(['diff', '--quiet'], dir).catch(() => 'changes');
    if (unstaged === 'changes') return true;

    // Check for untracked files
    const untracked = await execGit(['ls-files', '--others', '--exclude-standard'], dir);
    return untracked.length > 0;
  } catch {
    return false;
  }
}

/**
 * List all worktrees for a repository
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const output = await execGit(['worktree', 'list', '--porcelain'], repoRoot);
  const worktrees: WorktreeInfo[] = [];

  if (!output) return worktrees;

  // Parse porcelain output
  // Format:
  // worktree /path/to/worktree
  // HEAD <commit>
  // branch refs/heads/branch-name
  // <blank line>
  const blocks = output.split('\n\n').filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    const worktree: Partial<WorktreeInfo> = {};

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktree.path = line.slice(9);
      } else if (line.startsWith('HEAD ')) {
        worktree.commit = line.slice(5);
      } else if (line.startsWith('branch ')) {
        // refs/heads/branch-name -> branch-name
        worktree.branch = line.slice(7).replace('refs/heads/', '');
      } else if (line === 'bare') {
        worktree.isBare = true;
      } else if (line === 'detached') {
        worktree.branch = '(detached)';
      }
    }

    if (worktree.path) {
      worktrees.push({
        path: worktree.path,
        branch: worktree.branch || '(unknown)',
        commit: worktree.commit || '',
        isMain: worktrees.length === 0, // First worktree is the main one
        isBare: worktree.isBare || false,
      });
    }
  }

  return worktrees;
}

/**
 * Check if a branch exists (local or remote)
 */
async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    // Check local branches
    await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    try {
      // Check remote branches
      await execGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], repoRoot);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Generate the worktree directory path.
 * Creates worktrees in centralized location: ~/.claude-threads/worktrees/{encoded-repo}--{branch}-{uuid}
 * This makes it easy to find and clean up orphaned worktrees.
 */
export function getWorktreeDir(repoRoot: string, branch: string): string {
  // Sanitize repo path for use in directory name
  // /Users/anne/myproject -> -Users-anne-myproject
  const repoName = repoRoot.replace(/\//g, '-').replace(/^-/, '');

  // Sanitize branch name for filesystem
  const sanitizedBranch = branch
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '');

  const shortUuid = randomUUID().slice(0, 8);
  return path.join(WORKTREES_DIR, `${repoName}--${sanitizedBranch}-${shortUuid}`);
}

/**
 * Check if a worktree path is in the centralized worktrees directory.
 * Used to prevent accidentally deleting worktrees outside our control.
 */
export function isValidWorktreePath(worktreePath: string): boolean {
  // Must be inside ~/.claude-threads/worktrees/
  return worktreePath.startsWith(WORKTREES_DIR + path.sep);
}

/**
 * Get the centralized worktrees directory path.
 */
export function getWorktreesDir(): string {
  return WORKTREES_DIR;
}

/**
 * Detect worktree info from a path if it's inside the centralized worktrees directory.
 * Uses git to get the actual branch name.
 *
 * @param workingDir - Path to check
 * @returns WorktreeInfo-like object with path and branch, or null if not a worktree
 */
export async function detectWorktreeInfo(
  workingDir: string
): Promise<{ worktreePath: string; branch: string; repoRoot: string } | null> {
  // Must be inside ~/.claude-threads/worktrees/
  if (!isValidWorktreePath(workingDir)) {
    return null;
  }

  try {
    // Get the branch name from git
    const branchOutput = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], workingDir);
    const branch = branchOutput?.trim();
    // A detached HEAD reports the literal string "HEAD" — not a branch name;
    // downstream (findWorktreeByBranch, list markers) would treat it as one.
    if (!branch || branch === 'HEAD') {
      log.debug(`Could not detect branch for worktree at ${workingDir}`);
      return null;
    }

    // The worktree root, not workingDir: a session may start in a nested
    // subdirectory, and reference counting / `git worktree remove` must see
    // the actual worktree path.
    const toplevel = (await execGit(['rev-parse', '--show-toplevel'], workingDir))?.trim();
    if (!toplevel || !isValidWorktreePath(toplevel)) {
      return null;
    }

    // Get the main repository root (the one this worktree is linked to) —
    // shared derivation with getMainRepositoryRoot (git-common-dir).
    const repoRoot = await getMainRepositoryRoot(workingDir);

    log.debug(`Detected worktree: path=${workingDir}, branch=${branch}, repoRoot=${repoRoot}`);

    return {
      worktreePath: toplevel,
      branch,
      repoRoot: repoRoot || toplevel,
    };
  } catch (err) {
    log.debug(`Failed to detect worktree info for ${workingDir}: ${err}`);
    return null;
  }
}

/**
 * Create a new worktree for a branch
 * If the branch doesn't exist, creates it from the current HEAD
 */
export async function createWorktree(
  repoRoot: string,
  branch: string,
  targetDir: string
): Promise<string> {
  log.info(`Creating worktree for branch '${branch}' at ${targetDir}`);

  // Ensure the parent directory exists
  const parentDir = path.dirname(targetDir);
  log.debug(`Creating parent directory: ${parentDir}`);
  await fs.mkdir(parentDir, { recursive: true });

  // Check if branch exists
  const exists = await branchExists(repoRoot, branch);

  if (exists) {
    // Use existing branch. The `--` separator stops git from parsing a
    // leading-dash branch/path as an option (defense-in-depth alongside
    // isValidBranchName).
    log.debug(`Branch '${branch}' exists, adding worktree`);
    await execGit(['worktree', 'add', '--', targetDir, branch], repoRoot);
  } else {
    // Create new branch from HEAD. `-b <branch>` must precede `--`; the
    // separator then guards the positional path argument.
    log.debug(`Branch '${branch}' does not exist, creating with worktree`);
    await execGit(['worktree', 'add', '-b', branch, '--', targetDir], repoRoot);
  }

  log.info(`Worktree created successfully: ${targetDir}`);
  return targetDir;
}

/**
 * Remove a worktree
 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  log.info(`Removing worktree: ${worktreePath}`);

  // First try to remove cleanly
  try {
    await execGit(['worktree', 'remove', worktreePath], repoRoot);
    log.debug('Worktree removed cleanly');
  } catch (err) {
    // If that fails, try force remove
    log.debug(`Clean remove failed (${err}), trying force remove`);
    await execGit(['worktree', 'remove', '--force', worktreePath], repoRoot);
  }

  // Prune any stale worktree references
  log.debug('Pruning stale worktree references');
  await execGit(['worktree', 'prune'], repoRoot);
  log.info('Worktree removed and pruned successfully');
}

/**
 * Find a worktree by branch name
 */
export async function findWorktreeByBranch(
  repoRoot: string,
  branch: string
): Promise<WorktreeInfo | null> {
  const worktrees = await listWorktrees(repoRoot);
  return worktrees.find((wt) => wt.branch === branch) || null;
}

/**
 * Validate a git branch name
 * Based on git-check-ref-format rules
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length === 0) return false;

  // Cannot start or end with /
  if (name.startsWith('/') || name.endsWith('/')) return false;

  // Cannot contain ..
  if (name.includes('..')) return false;

  // Cannot contain characters git forbids in ref names
  if (/[\s~^:?*[\]\\]/.test(name)) return false;

  // SECURITY: reject shell metacharacters. Git itself permits these in ref
  // names, but on Windows the spawn wrapper runs git with `shell:true`, where
  // Node does not escape argv — an unescaped `&`, `|`, backtick, `$()`, etc.
  // in a branch name becomes a cmd.exe command-injection vector. Blocking them
  // here (rather than only quoting at the spawn site) is defense-in-depth and
  // costs only exotic-but-legal branch names that nobody uses in practice.
  if (/[&|;$`(){}<>!'"#%]/.test(name)) return false;

  // Cannot start with - (would be parsed as a git flag)
  if (name.startsWith('-')) return false;

  // Cannot end with .lock
  if (name.endsWith('.lock')) return false;

  // Cannot contain @{
  if (name.includes('@{')) return false;

  // Cannot be @
  if (name === '@') return false;

  // Cannot contain consecutive dots
  if (/\.\./.test(name)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Worktree Metadata Management (Centralized)
// ---------------------------------------------------------------------------

/**
 * Centralized metadata store for all worktrees.
 * Stored in ~/.claude-threads/worktree-metadata.json to avoid polluting project directories.
 */
interface WorktreeMetadataStore {
  [worktreePath: string]: WorktreeMetadata;
}

const METADATA_STORE_PATH = path.join(stateHome(), '.claude-threads', 'worktree-metadata.json');

/**
 * Read the entire metadata store from disk.
 */
async function readMetadataStore(): Promise<WorktreeMetadataStore> {
  try {
    const content = await fs.readFile(METADATA_STORE_PATH, 'utf-8');
    return JSON.parse(content) as WorktreeMetadataStore;
  } catch {
    return {};
  }
}

/**
 * Write the entire metadata store to disk.
 * Sets restrictive permissions (0600) to protect session metadata.
 */
async function writeMetadataStore(store: WorktreeMetadataStore): Promise<void> {
  try {
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(METADATA_STORE_PATH), { recursive: true });
    await fs.writeFile(METADATA_STORE_PATH, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
    // Ensure permissions are set correctly (writeFile mode may be affected by umask)
    await fs.chmod(METADATA_STORE_PATH, 0o600);
  } catch (err) {
    log.warn(`Failed to write worktree metadata store: ${err}`);
  }
}

/**
 * Write metadata for a worktree.
 * Called when creating a new worktree.
 */
export async function writeWorktreeMetadata(
  worktreePath: string,
  metadata: WorktreeMetadata
): Promise<void> {
  const store = await readMetadataStore();
  store[worktreePath] = metadata;
  await writeMetadataStore(store);
  log.debug(`Wrote worktree metadata for: ${worktreePath}`);
}

/**
 * Read metadata for a worktree.
 * Returns null if metadata doesn't exist.
 */
export async function readWorktreeMetadata(worktreePath: string): Promise<WorktreeMetadata | null> {
  const store = await readMetadataStore();
  return store[worktreePath] || null;
}

/**
 * Update the lastActivityAt timestamp in worktree metadata.
 * Called periodically to track worktree usage for age-based cleanup.
 */
export async function updateWorktreeActivity(
  worktreePath: string,
  sessionId?: string
): Promise<void> {
  const store = await readMetadataStore();
  const existing = store[worktreePath];
  if (!existing) return;

  existing.lastActivityAt = new Date().toISOString();
  if (sessionId !== undefined) {
    existing.sessionId = sessionId;
  }

  store[worktreePath] = existing;
  await writeMetadataStore(store);
}

/**
 * Remove metadata for a worktree.
 * Called when cleaning up a worktree.
 */
export async function removeWorktreeMetadata(worktreePath: string): Promise<void> {
  const store = await readMetadataStore();
  if (store[worktreePath]) {
    delete store[worktreePath];
    await writeMetadataStore(store);
    log.debug(`Removed worktree metadata for: ${worktreePath}`);
  }
}
