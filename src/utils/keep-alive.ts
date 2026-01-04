/**
 * System Keep-Alive Module
 *
 * Prevents the system from going to sleep while Claude sessions are active.
 * Uses platform-specific methods:
 * - macOS: caffeinate command
 * - Linux: systemd-inhibit command
 * - Windows: stay-awake npm package (if available)
 */

import { spawn, ChildProcess } from 'child_process';
import { createLogger } from './logger.js';

const log = createLogger('keepalive');

/**
 * KeepAlive manager - singleton that tracks active sessions and manages
 * system sleep prevention.
 */
class KeepAliveManager {
  private activeSessionCount = 0;
  private keepAliveProcess: ChildProcess | null = null;
  private enabled = true;
  private platform: NodeJS.Platform;

  constructor() {
    this.platform = process.platform;
  }

  /**
   * Enable or disable keep-alive functionality.
   * When disabled, no system sleep prevention will occur.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.keepAliveProcess) {
      this.stopKeepAlive();
    }
    log.debug(`Keep-alive ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Check if keep-alive is currently enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Check if keep-alive is currently active (process running).
   */
  isActive(): boolean {
    return this.keepAliveProcess !== null;
  }

  /**
   * Called when a session starts. Increments the session count and
   * starts system sleep prevention if this is the first session.
   */
  sessionStarted(): void {
    this.activeSessionCount++;
    log.debug(`Session started (${this.activeSessionCount} active)`);

    if (this.activeSessionCount === 1) {
      this.startKeepAlive();
    }
  }

  /**
   * Called when a session ends. Decrements the session count and
   * stops system sleep prevention if there are no more sessions.
   */
  sessionEnded(): void {
    if (this.activeSessionCount > 0) {
      this.activeSessionCount--;
    }
    log.debug(`Session ended (${this.activeSessionCount} active)`);

    if (this.activeSessionCount === 0) {
      this.stopKeepAlive();
    }
  }

  /**
   * Force stop the keep-alive process (used during shutdown).
   */
  forceStop(): void {
    this.stopKeepAlive();
    this.activeSessionCount = 0;
  }

  /**
   * Get the current session count.
   */
  getSessionCount(): number {
    return this.activeSessionCount;
  }

  /**
   * Start the platform-specific keep-alive process.
   */
  private startKeepAlive(): void {
    if (!this.enabled) {
      log.debug('Keep-alive disabled, skipping');
      return;
    }

    if (this.keepAliveProcess) {
      log.debug('Keep-alive already running');
      return;
    }

    switch (this.platform) {
      case 'darwin':
        this.startMacOSKeepAlive();
        break;
      case 'linux':
        this.startLinuxKeepAlive();
        break;
      case 'win32':
        this.startWindowsKeepAlive();
        break;
      default:
        log.warn(`Keep-alive not supported on ${this.platform}`);
    }
  }

  /**
   * Stop the keep-alive process.
   */
  private stopKeepAlive(): void {
    if (this.keepAliveProcess) {
      log.debug('Stopping keep-alive');
      this.keepAliveProcess.kill();
      this.keepAliveProcess = null;
    }
  }

  /**
   * macOS: Use the built-in caffeinate command.
   * -s: Prevent system sleep
   * -i: Prevent idle sleep
   */
  private startMacOSKeepAlive(): void {
    try {
      // caffeinate -s prevents system sleep (but allows display sleep)
      // caffeinate -i prevents idle sleep
      this.keepAliveProcess = spawn('caffeinate', ['-s', '-i'], {
        stdio: 'ignore',
        detached: false,
      });

      this.keepAliveProcess.on('error', (err) => {
        log.error(`Failed to start caffeinate: ${err.message}`);
        this.keepAliveProcess = null;
      });

      this.keepAliveProcess.on('exit', (code) => {
        if (code !== null && code !== 0 && this.activeSessionCount > 0) {
          log.debug(`caffeinate exited with code ${code}`);
        }
        this.keepAliveProcess = null;
      });

      log.info('Sleep prevention active (caffeinate)');
    } catch (err) {
      log.error(`Failed to start caffeinate: ${err}`);
    }
  }

  /**
   * Linux: Use systemd-inhibit to prevent sleep.
   * Falls back to a simple loop if systemd-inhibit is not available.
   */
  private startLinuxKeepAlive(): void {
    try {
      // Try systemd-inhibit first (standard on modern Linux)
      // It runs a command while inhibiting sleep - we use 'sleep infinity'
      this.keepAliveProcess = spawn(
        'systemd-inhibit',
        [
          '--what=sleep:idle:handle-lid-switch',
          '--why=Claude Code session active',
          '--mode=block',
          'sleep',
          'infinity',
        ],
        {
          stdio: 'ignore',
          detached: false,
        }
      );

      this.keepAliveProcess.on('error', (err) => {
        log.debug(`systemd-inhibit not available: ${err.message}`);
        this.keepAliveProcess = null;
        // Try alternative method
        this.startLinuxKeepAliveFallback();
      });

      this.keepAliveProcess.on('exit', (code) => {
        if (code !== null && code !== 0 && this.activeSessionCount > 0) {
          log.debug(`systemd-inhibit exited with code ${code}`);
        }
        this.keepAliveProcess = null;
      });

      log.info('Sleep prevention active (systemd-inhibit)');
    } catch (err) {
      log.debug(`Failed to start systemd-inhibit: ${err}`);
      this.startLinuxKeepAliveFallback();
    }
  }

  /**
   * Linux fallback: Try using xdg-screensaver or dbus-send.
   * This is less reliable but works on more systems.
   */
  private startLinuxKeepAliveFallback(): void {
    // Try xdg-screensaver suspend (works on many desktop environments)
    try {
      // xdg-screensaver suspend suspends screensaver until the given window ID's process exits
      // We use the current PID as a reference
      this.keepAliveProcess = spawn(
        'bash',
        [
          '-c',
          `while true; do xdg-screensaver reset 2>/dev/null || true; sleep 60; done`,
        ],
        {
          stdio: 'ignore',
          detached: false,
        }
      );

      this.keepAliveProcess.on('error', (err) => {
        log.warn(`Linux keep-alive fallback not available: ${err.message}`);
        this.keepAliveProcess = null;
      });

      this.keepAliveProcess.on('exit', () => {
        this.keepAliveProcess = null;
      });

      log.info('Sleep prevention active (xdg-screensaver)');
    } catch (err) {
      log.warn(`Linux keep-alive not available: ${err}`);
    }
  }

  /**
   * Windows: Use PowerShell to call SetThreadExecutionState.
   * This is the most reliable method on Windows without requiring
   * additional npm packages.
   */
  private startWindowsKeepAlive(): void {
    try {
      // Use PowerShell to call SetThreadExecutionState API
      // ES_CONTINUOUS (0x80000000) + ES_SYSTEM_REQUIRED (0x00000001) = 0x80000001
      const script = `
        Add-Type -TypeDefinition @"
          using System;
          using System.Runtime.InteropServices;
          public class PowerState {
            [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
            public static extern uint SetThreadExecutionState(uint esFlags);
          }
"@
        # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        [PowerState]::SetThreadExecutionState(0x80000001) | Out-Null
        # Keep running until killed
        while ($true) { Start-Sleep -Seconds 60 }
      `;

      this.keepAliveProcess = spawn(
        'powershell',
        ['-NoProfile', '-Command', script],
        {
          stdio: 'ignore',
          detached: false,
          windowsHide: true,
        }
      );

      this.keepAliveProcess.on('error', (err) => {
        log.warn(`Windows keep-alive not available: ${err.message}`);
        this.keepAliveProcess = null;
      });

      this.keepAliveProcess.on('exit', (code) => {
        if (code !== null && code !== 0 && this.activeSessionCount > 0) {
          log.debug(`PowerShell keep-alive exited with code ${code}`);
        }
        this.keepAliveProcess = null;
      });

      log.info('Sleep prevention active (SetThreadExecutionState)');
    } catch (err) {
      log.warn(`Windows keep-alive not available: ${err}`);
    }
  }
}

// Singleton instance
const keepAlive = new KeepAliveManager();

export { keepAlive, KeepAliveManager };
