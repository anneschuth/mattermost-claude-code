/**
 * Update installer module
 *
 * Handles the actual bun/npm install and state persistence.
 */

import { spawn, spawnSync } from 'child_process';
import { stateHome } from '../utils/state-home.js';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';
import { writeFileAtomic } from '../persistence/atomic-file.js';
import { createLogger } from '../utils/logger.js';
import { VERSION } from '../version.js';
import type { PersistedUpdateState, RuntimeSettings, UpdateInfo } from './types.js';
import { UPDATE_STATE_FILENAME } from './types.js';

const log = createLogger('installer');

/**
 * Detect which package manager originally installed claude-threads.
 * This ensures updates use the same package manager to avoid duplicate installations.
 *
 * Detection order:
 * 1. Check if running binary is in bun's global bin (~/.bun/bin/)
 * 2. Check if running binary is in npm's global prefix
 * 3. Fall back to preferring bun if available
 *
 * Returns the command to use and whether it's bun or npm.
 */
export function detectPackageManager(): { cmd: string; isBun: boolean } | null {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // Try to detect the original installer by checking where the binary lives
  const originalInstaller = detectOriginalInstaller();
  if (originalInstaller) {
    log.debug(`Detected original installer: ${originalInstaller}`);
    if (originalInstaller === 'bun') {
      // Verify bun is still available
      const bunCheck = spawnSync('bun', ['--version'], { stdio: 'ignore' });
      if (bunCheck.status === 0) {
        return { cmd: 'bun', isBun: true };
      }
      log.warn('Originally installed with bun, but bun not found. Falling back to npm.');
    } else {
      // Verify npm is still available
      const npmCheck = spawnSync(npmCmd, ['--version'], { stdio: 'ignore' });
      if (npmCheck.status === 0) {
        return { cmd: npmCmd, isBun: false };
      }
      log.warn('Originally installed with npm, but npm not found. Falling back to bun.');
    }
  }

  // Fall back: prefer bun if available, otherwise npm
  const bunCheck = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  if (bunCheck.status === 0) {
    return { cmd: 'bun', isBun: true };
  }

  const npmCheck = spawnSync(npmCmd, ['--version'], { stdio: 'ignore' });
  if (npmCheck.status === 0) {
    return { cmd: npmCmd, isBun: false };
  }

  // Neither available
  return null;
}

/**
 * Normalize a path for comparison (handles Windows case-insensitivity).
 */
function normalizePath(p: string): string {
  // On Windows, paths are case-insensitive
  if (process.platform === 'win32') {
    return p.toLowerCase();
  }
  return p;
}

/**
 * Detect which package manager originally installed claude-threads
 * by checking the location of the running binary.
 */
export function detectOriginalInstaller(): 'bun' | 'npm' | null {
  try {
    // Get the path of the currently running script
    // In a globally installed package, this will be in the package manager's directory
    const scriptPath = normalizePath(process.argv[1] || '');

    // Bun global installs go to ~/.bun/bin/ or ~/.bun/install/global/
    // Respects BUN_INSTALL env var for custom install locations
    const bunGlobalDir = normalizePath(process.env.BUN_INSTALL || resolve(homedir(), '.bun'));
    if (scriptPath.startsWith(bunGlobalDir)) {
      return 'bun';
    }

    // Check npm's global prefix
    // Use npm.cmd on Windows
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npmPrefixResult = spawnSync(npmCmd, ['prefix', '-g'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (npmPrefixResult.status === 0 && npmPrefixResult.stdout) {
      const npmPrefix = normalizePath(npmPrefixResult.stdout.trim());
      // npm global binaries are in {prefix}/bin/ or {prefix}/lib/node_modules/.bin/
      if (scriptPath.startsWith(npmPrefix)) {
        return 'npm';
      }
    }

    // Could not determine - likely running from source (dev mode)
    return null;
  } catch {
    return null;
  }
}

// State file path
const STATE_PATH = resolve(stateHome(), '.config', 'claude-threads', UPDATE_STATE_FILENAME);

// Package name
const PACKAGE_NAME = 'claude-threads';

/**
 * Load persisted update state from disk.
 */
export function loadUpdateState(): PersistedUpdateState {
  try {
    if (existsSync(STATE_PATH)) {
      const content = readFileSync(STATE_PATH, 'utf-8');
      return JSON.parse(content) as PersistedUpdateState;
    }
  } catch (err) {
    log.warn(`Failed to load update state: ${err}`);
  }
  return {};
}

/**
 * Save update state to disk.
 */
export function saveUpdateState(state: PersistedUpdateState): void {
  try {
    const dir = dirname(STATE_PATH);
    if (!existsSync(dir)) {
      // Owner-only dir, matching the rest of the bot's on-disk stores.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // Owner-only (0600) atomic write. update-state.json holds runtime settings
    // (permission mode, feature flags) that a local unprivileged user should
    // not be able to read or tamper with; keep it in lockstep with the 0600
    // policy every other store follows.
    writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2));
    log.debug('Update state saved');
  } catch (err) {
    log.warn(`Failed to save update state: ${err}`);
  }
}

/**
 * Clear the update state (after successful restart or rollback).
 */
export function clearUpdateState(): void {
  try {
    if (existsSync(STATE_PATH)) {
      // Re-write owner-only so a pre-existing 0644 file is corrected to 0600.
      writeFileAtomic(STATE_PATH, '{}');
    }
  } catch (err) {
    log.warn(`Failed to clear update state: ${err}`);
  }
}

/**
 * Check if the bot just updated (for post-restart notification).
 */
export function checkJustUpdated(): { previousVersion: string; currentVersion: string } | null {
  const state = loadUpdateState();

  if (state.justUpdated && state.previousVersion) {
    // Clear the flag
    saveUpdateState({
      ...state,
      justUpdated: false,
    });

    return {
      previousVersion: state.previousVersion,
      currentVersion: VERSION,
    };
  }

  return null;
}

/**
 * Save runtime settings (to restore after daemon restart).
 */
export function saveRuntimeSettings(settings: RuntimeSettings): void {
  const state = loadUpdateState();
  saveUpdateState({ ...state, runtimeSettings: settings });
}

/**
 * Get saved runtime settings.
 */
export function getRuntimeSettings(): RuntimeSettings | undefined {
  return loadUpdateState().runtimeSettings;
}

/**
 * Clear runtime settings (after restoring them on daemon restart).
 */
export function clearRuntimeSettings(): void {
  const state = loadUpdateState();
  if (state.runtimeSettings) {
    delete state.runtimeSettings;
    saveUpdateState(state);
  }
}

/**
 * Install a specific version using bun (preferred) or npm as fallback.
 * Returns true on success, false on failure.
 */
export async function installVersion(version: string): Promise<{ success: boolean; error?: string }> {
  log.info(`📦 Installing ${PACKAGE_NAME}@${version}...`);

  // Detect available package manager
  const pm = detectPackageManager();
  if (!pm) {
    const error = 'Neither bun nor npm found in PATH. Cannot install update.';
    log.error(`❌ ${error}`);
    return { success: false, error };
  }

  // Save state before installing
  saveUpdateState({
    previousVersion: VERSION,
    targetVersion: version,
    startedAt: new Date().toISOString(),
    justUpdated: false,
  });

  return new Promise((resolve) => {
    const { cmd, isBun } = pm;
    const args = ['install', '-g', `${PACKAGE_NAME}@${version}`];

    log.debug(`Using ${isBun ? 'bun' : 'npm'} for installation`);

    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Disable npm progress bar for cleaner output (only affects npm)
        npm_config_progress: 'false',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        log.info(`✅ Successfully installed ${PACKAGE_NAME}@${version}`);

        // Mark as just updated for post-restart notification
        saveUpdateState({
          previousVersion: VERSION,
          targetVersion: version,
          startedAt: new Date().toISOString(),
          justUpdated: true,
        });

        resolve({ success: true });
      } else {
        const errorMsg = stderr || stdout || `Exit code: ${code}`;
        log.error(`❌ Installation failed: ${errorMsg}`);

        // Clear the state on failure
        clearUpdateState();

        resolve({ success: false, error: errorMsg });
      }
    });

    child.on('error', (err) => {
      log.error(`❌ Failed to spawn npm: ${err}`);
      clearUpdateState();
      resolve({ success: false, error: err.message });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill();
        log.error('❌ Installation timed out');
        clearUpdateState();
        resolve({ success: false, error: 'Installation timed out' });
      }
    }, 5 * 60 * 1000);
  });
}

/**
 * Get rollback instructions for the previous version.
 */
export function getRollbackInstructions(previousVersion: string): string {
  const pm = detectPackageManager();
  const cmd = pm?.isBun ? 'bun' : 'npm';
  return `To rollback to the previous version, run:\n  ${cmd} install -g ${PACKAGE_NAME}@${previousVersion}`;
}

/**
 * UpdateInstaller - Handles installation and state management
 */
export class UpdateInstaller {
  private isInstalling = false;

  /**
   * Install an update.
   */
  async install(updateInfo: UpdateInfo): Promise<{ success: boolean; error?: string }> {
    if (this.isInstalling) {
      return { success: false, error: 'Installation already in progress' };
    }

    this.isInstalling = true;

    try {
      return await installVersion(updateInfo.latestVersion);
    } finally {
      this.isInstalling = false;
    }
  }

  /**
   * Check if installation is in progress.
   */
  isInProgress(): boolean {
    return this.isInstalling;
  }

  /**
   * Check if the bot just updated and return version info.
   */
  checkJustUpdated(): { previousVersion: string; currentVersion: string } | null {
    return checkJustUpdated();
  }

  /**
   * Get the persisted state (for UI display).
   */
  getState(): PersistedUpdateState {
    return loadUpdateState();
  }

  /**
   * Clear the persisted state.
   */
  clearState(): void {
    clearUpdateState();
  }
}
