import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';

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
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd });
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
        resolve(stdout.trim());
      } else {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
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
  } catch {
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
 * Generate the worktree directory path
 * Creates path like: /path/to/repo-worktrees/branch-name-abc123
 */
export function getWorktreeDir(repoRoot: string, branch: string): string {
  const repoName = path.basename(repoRoot);
  const parentDir = path.dirname(repoRoot);
  const worktreesDir = path.join(parentDir, `${repoName}-worktrees`);

  // Sanitize branch name for filesystem
  const sanitizedBranch = branch
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '');

  const shortUuid = randomUUID().slice(0, 8);
  return path.join(worktreesDir, `${sanitizedBranch}-${shortUuid}`);
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
  // Ensure the parent directory exists
  const parentDir = path.dirname(targetDir);
  await fs.mkdir(parentDir, { recursive: true });

  // Check if branch exists
  const exists = await branchExists(repoRoot, branch);

  if (exists) {
    // Use existing branch
    await execGit(['worktree', 'add', targetDir, branch], repoRoot);
  } else {
    // Create new branch from HEAD
    await execGit(['worktree', 'add', '-b', branch, targetDir], repoRoot);
  }

  return targetDir;
}

/**
 * Remove a worktree
 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  // First try to remove cleanly
  try {
    await execGit(['worktree', 'remove', worktreePath], repoRoot);
  } catch {
    // If that fails, try force remove
    await execGit(['worktree', 'remove', '--force', worktreePath], repoRoot);
  }

  // Prune any stale worktree references
  await execGit(['worktree', 'prune'], repoRoot);
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

  // Cannot contain special characters
  if (/[\s~^:?*[\]\\]/.test(name)) return false;

  // Cannot start with -
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
