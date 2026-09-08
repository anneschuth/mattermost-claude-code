import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { stateHome } from './state-home.js';
import { createLogger } from './logger.js';

const log = createLogger('lock');

/** Exit status for "another instance holds this state directory": the daemon wrapper never restarts on it. */
export const LOCKED_EXIT_CODE = 3;

/**
 * One bot process per state directory. Two instances sharing
 * ~/.config/claude-threads would race on sessions.json and each other's
 * uploads; a stale lock (dead pid) is taken over.
 *
 * Node 20 has no flock(), so exclusivity is built from the two exclusive
 * filesystem primitives that exist: link() never overwrites (EEXIST means a
 * lock is held, and the lock never exists without content because the pid
 * is written to a private temp file first), and rename() moves a given
 * inode exactly once (of several claimants of the same stale lock, one gets
 * the rename, the rest see ENOENT). A claimant checks the inode it moved
 * against the one it inspected; if a fresh lock had landed in between, the
 * fresh lock is put back with link() and the claimant goes round again to
 * find its live holder. No process ever unlinks another's lock.
 * Returns a release function; throws when another live process holds the lock.
 */
export function acquireInstanceLock(): () => void {
  const path = join(stateHome(), '.config', 'claude-threads', 'instance.lock');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, String(process.pid));
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      let linked: boolean;
      try {
        linked = tryLink(tmp, path);
      } catch (err) {
        // No hard links on this filesystem (SMB/CIFS without unix extensions,
        // exFAT, FUSE mounts): the default install must keep starting. Only a
        // deliberate second instance loses protection here.
        log.warn(`instance lock unavailable on this filesystem (${(err as NodeJS.ErrnoException).code ?? String(err)}); running without it`);
        return () => {};
      }
      if (linked) return () => release(path);
      const seen = inspect(path);
      if (!seen) continue; // vanished between link and read (holder released): retry the link
      if (seen.pid === process.pid) return () => release(path);
      if (seen.pid && isAlive(seen.pid)) {
        // TODO: the interactive self-respawn spawns its replacement while the
        // old process is still alive; the replacement only lands here if it
        // beats the old process's exit handler, which is a wide margin today.
        // A short retry on a live holder would close it without touching the
        // respawn code.
        throw new Error(
          `another claude-threads instance (pid ${seen.pid}) already uses ${dirname(path)} — ` +
          `set CLAUDE_THREADS_HOME to run a second bot; if pid ${seen.pid} is not a claude-threads process, delete ${path}`,
        );
      }
      // Dead holder: move exactly that inode aside; rename() hands it to one claimant only.
      const aside = `${path}.stale.${process.pid}`;
      if (!tryRename(path, aside)) continue; // ENOENT: another claimant moved it first
      if (statSync(aside).ino !== seen.ino) {
        // We moved a lock that was linked after our inspection; its holder is
        // alive. link() never overwrites, so a lock that landed meanwhile stays.
        // TODO: if one did land in that gap, the displaced holder runs on
        // unlocked — the last window only flock() closes, and Node 20 has none.
        tryLink(aside, path);
        unlinkSync(aside);
        continue;
      }
      unlinkSync(aside); // the stale inode, and nothing else, is gone
    }
    throw new Error(`could not acquire ${path}: lost the race five times`);
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Read pid and inode from the same open file, so both describe one lock. */
function inspect(path: string): { pid: number | undefined; ino: number } | undefined {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return undefined; }
  try {
    return { pid: Number(readFileSync(fd, 'utf8').trim()) || undefined, ino: fstatSync(fd).ino };
  } finally { closeSync(fd); }
}

/** link() the temp file onto the lock path; false when a lock already exists. */
function tryLink(src: string, path: string): boolean {
  try {
    linkSync(src, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** rename(); false when the source is already gone. */
function tryRename(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Only remove the lock while it still carries our pid — never a successor's. */
function release(path: string): void {
  try {
    if (inspect(path)?.pid === process.pid) unlinkSync(path);
  } catch { /* already gone */ }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}
