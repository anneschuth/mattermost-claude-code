#!/usr/bin/env node

import { program } from 'commander';
import { createDmDiscoveryRuntime, type DmDiscoveryRuntime } from './platform/dm-discovery-runtime.js';
import { DM_PLATFORM_SEP } from './platform/dm-discovery.js';
import type { DirectChannelModeConfig } from './platform/utils.js';
import {
  loadConfigWithMigration,
  configExists as checkConfigExists,
  resolvePermissionMode,
  resolveOverheadVisibility,
  resolveMemoryConfig,
  resolveAuditLogEnabled,
  resolveRoutinesEnabled,
  resolveWatchesEnabled,
  resolveTranscriptionEnabled,
  isOverheadVisibility,
  OVERHEAD_VISIBILITY_VALUES,
  type MattermostPlatformConfig,
  type SlackPlatformConfig,
  type PlatformInstanceConfig,
  type PermissionMode,
  type OverheadVisibility,
  resolveTurnMarker,
} from './config/index.js';
import type { CliArgs } from './config/index.js';
import { runOnboarding } from './onboarding.js';
import { MattermostClient, SlackClient, type PlatformClient, type PlatformPost, type PlatformUser } from './platform/index.js';
import { SessionManager } from './session/index.js';
import { createTranscriber } from './transcription/index.js';
import { SessionStore } from './persistence/session-store.js';
import { configureAuditLog } from './persistence/audit-log.js';
import { checkForUpdates } from './update-notifier.js';
import { VERSION } from './version.js';
import { keepAlive } from './utils/keep-alive.js';
import { startReactMeasureCleanup } from './utils/perf-cleanup.js';
import { dim, red, yellow } from './utils/colors.js';
import { validateClaudeCli } from './claude/version-check.js';
import { startUI, type UIProvider } from './ui/index.js';
import { setLogHandler } from './utils/logger.js';
import { handleMessage } from './message-handler.js';
import { AutoUpdateManager } from './auto-update/index.js';
import {
  loadUpdateState,
  saveRuntimeSettings,
  getRuntimeSettings,
  clearRuntimeSettings,
} from './auto-update/installer.js';

// =============================================================================
// Platform Factory and Event Wiring
// =============================================================================

/**
 * Create a platform client based on the config type.
 */
function createPlatformClient(config: PlatformInstanceConfig): PlatformClient {
  switch (config.type) {
    case 'mattermost':
      return new MattermostClient(config as MattermostPlatformConfig);
    case 'slack':
      return new SlackClient(config as SlackPlatformConfig);
    default:
      throw new Error(`Unsupported platform type: ${(config as PlatformInstanceConfig).type}`);
  }
}

/**
 * Wire up platform events to session manager and UI.
 */
/**
 * Active DM auto-discovery runtime (created during init). Module-level so the
 * session:remove handler and the message dedupe in wirePlatformEvents can
 * reach it; all state lives inside the runtime instance.
 */
let activeDmRuntime: DmDiscoveryRuntime | undefined;

function wirePlatformEvents(
  platformId: string,
  client: PlatformClient,
  session: SessionManager,
  ui: UIProvider,
  directChannelMode?: DirectChannelModeConfig
): void {
  // Handle incoming messages
  client.on('message', async (post: PlatformPost, user: PlatformUser | null) => {
    // Dedupe for the DM-discovery handover window: a post the parent already
    // routed must not be processed again when the derived instance's own
    // socket delivers it moments later.
    if (activeDmRuntime?.isRoutedPost(post.id)) return;
    await handleMessage(client, session, post, user, {
      platformId,
      directChannelMode,
      logger: {
        error: (msg) => ui.addLog({ level: 'error', component: '❌', message: msg }),
      },
      onKill: (username) => {
        ui.addLog({ level: 'error', component: '🔴', message: `EMERGENCY SHUTDOWN initiated by @${username}` });
        // Exit with code 0 so daemon doesn't restart us
        process.exit(0);
      },
    });
  });

  // Wire up connection status events to UI
  client.on('connected', () => {
    ui.setPlatformStatus(platformId, { connected: true, reconnecting: false, reconnectAttempts: 0 });
  });
  client.on('disconnected', () => {
    ui.setPlatformStatus(platformId, { connected: false, reconnecting: true });
  });
  client.on('reconnecting', (attempt: number) => {
    ui.setPlatformStatus(platformId, { reconnecting: true, reconnectAttempts: attempt });
  });
  client.on('error', (e) => {
    const message = e instanceof Error ? e.message : String(e);
    ui.addLog({ level: 'error', component: platformId, message });
  });
}

// =============================================================================
// CLI Options
// =============================================================================

// Define CLI options
program
  .name('claude-threads')
  .version(VERSION)
  .description('Share Claude Code sessions in Mattermost')
  .option('--url <url>', 'Mattermost server URL')
  .option('--token <token>', 'Mattermost bot token')
  .option('--channel <id>', 'Mattermost channel ID')
  .option('--bot-name <name>', 'Bot mention name (default: claude-code)')
  .option('--allowed-users <users>', 'Comma-separated allowed usernames')
  .option('--permission-mode <mode>', 'Permission mode: default | auto | bypass (default: from config)')
  .option('--skip-permissions', '[deprecated] Alias for --permission-mode bypass')
  .option('--no-skip-permissions', '[deprecated] Alias for --permission-mode default')
  .option('--chrome', 'Enable Claude in Chrome integration')
  .option('--no-chrome', 'Disable Claude in Chrome integration')
  .option('--worktree-mode <mode>', 'Git worktree mode: off, prompt, require (default: prompt)')
  .option('--session-header <mode>', 'Per-thread session header: full | minimal | hidden. Overrides per-platform config.')
  .option('--sticky-message <mode>', 'Channel sticky message: full | minimal | hidden. Overrides per-platform config.')
  .option('--keep-alive', 'Enable system sleep prevention (default: enabled)')
  .option('--no-keep-alive', 'Disable system sleep prevention')
  .option('--setup', 'Run interactive setup wizard (reconfigure existing settings)')
  .option('--debug', 'Enable debug logging')
  .option('--skip-version-check', 'Skip Claude CLI version compatibility check')
  .option('--auto-restart', 'Enable auto-restart on updates (default when autoUpdate enabled)')
  .option('--no-auto-restart', 'Disable auto-restart on updates')
  .option('--headless', 'Run without interactive UI (logs to stdout)')
  .parse();

const opts = program.opts();

// Determine headless mode: explicit flag or auto-detect when no TTY.
// CLAUDE_THREADS_INTERACTIVE is set by the daemon wrapper to override TTY detection,
// since background jobs (&) lose TTY assignment even when the parent terminal is interactive.
const forcedInteractive = !!process.env.CLAUDE_THREADS_INTERACTIVE;
const isHeadless = opts.headless || (!forcedInteractive && (!process.stdout.isTTY || !process.stdin.isTTY));

// Check if required args are provided via CLI
function hasRequiredCliArgs(args: typeof opts): boolean {
  return !!(args.url && args.token && args.channel);
}

async function main() {
  // Clear screen for a clean start (only in interactive mode)
  if (!isHeadless) {
    process.stdout.write('\x1b[2J\x1b[H');
  }

  // Determine if we should use auto-restart daemon wrapper
  // Priority: --no-auto-restart (off) > --auto-restart (on) > config.autoUpdate.enabled
  // Note: Commander.js converts --no-auto-restart to opts.autoRestart = false
  const shouldUseAutoRestart = async (): Promise<boolean> => {
    // Explicit CLI flags take precedence
    // opts.autoRestart is: true (--auto-restart), false (--no-auto-restart), or undefined (neither)
    if (opts.autoRestart === false) return false;
    if (opts.autoRestart === true) return true;

    // The daemon wrapper runs the child with piped stdio (bash `&`), so the
    // Ink TUI can't render. When the user has an interactive terminal and
    // hasn't explicitly asked for --headless, skip the daemon so they keep
    // the UI. They can opt in with --auto-restart or run --headless.
    if (!isHeadless && process.stdout.isTTY) return false;

    // Check config for autoUpdate.enabled (if config exists)
    // Default is enabled=true, so only disable if explicitly set to false
    if (await checkConfigExists()) {
      try {
        const config = loadConfigWithMigration();
        if (!config) return false;
        return config.autoUpdate?.enabled !== false;
      } catch {
        return false;
      }
    }
    return false;
  };

  if (await shouldUseAutoRestart()) {
    const { spawn } = await import('child_process');
    const { dirname, resolve } = await import('path');
    const { fileURLToPath } = await import('url');

    // Find the daemon wrapper script
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const daemonPath = resolve(__dirname, '..', 'bin', 'claude-threads-daemon');

    // Remove auto-restart flags and add --no-auto-restart to prevent infinite loop
    const args = process.argv.slice(2)
      .filter(arg => arg !== '--auto-restart' && arg !== '--no-auto-restart')
      .concat('--no-auto-restart');

    console.log('🔄 Starting with auto-restart enabled...');
    console.log('');

    // Spawn the daemon wrapper with the remaining args
    // Pass the path to this binary so daemon runs the local version, not global
    // The entry point is dist/index.js (where this code is running from)
    const binPath = __filename;

    // On Windows, the daemon is a bash script that can't be spawned directly.
    // Use bash (from Git for Windows / WSL) if available, otherwise skip daemon.
    let child;
    if (process.platform === 'win32') {
      child = spawn('bash', [daemonPath, '--restart-on-error', ...args], {
        stdio: 'inherit',
        env: {
          ...process.env,
          CLAUDE_THREADS_BIN: binPath,
          // Clear CLAUDE_THREADS_INTERACTIVE so the daemon subprocess detects
          // its own TTY state. The daemon runs with piped stdio (no TTY), so
          // forwarding the parent's TTY state would cause InkProvider to crash.
          CLAUDE_THREADS_INTERACTIVE: '',
        },
      });
    } else {
      child = spawn(daemonPath, ['--restart-on-error', ...args], {
        stdio: 'inherit',
        env: {
          ...process.env,
          CLAUDE_THREADS_BIN: binPath,
          CLAUDE_THREADS_INTERACTIVE: '',
        },
      });
    }

    child.on('error', (err) => {
      if (process.platform === 'win32') {
        console.error(`Failed to start daemon: ${err.message}`);
        console.error('Auto-restart requires bash (Git for Windows or WSL). Starting without auto-restart...');
        console.error('');
        // Continue normal startup without the daemon
        startWithoutDaemon();
        return;
      }
      console.error(`Failed to start daemon: ${err.message}`);
      process.exit(1);
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });

    return; // Don't continue with normal startup
  }

  // Start the bot without the auto-restart daemon wrapper
  await startWithoutDaemon();
}

/**
 * Start the bot directly (without daemon wrapper).
 * This is the normal startup path, also used as fallback when
 * the daemon can't be spawned (e.g., Windows without bash).
 */
async function startWithoutDaemon() {

  // Check for updates (non-blocking, shows notification if available)
  checkForUpdates();

  // Set debug mode from CLI flag
  if (opts.debug) {
    process.env.DEBUG = '1';
  }

  // Validate --permission-mode if provided. Commander passes it through
  // verbatim, so we need to check it's one of the three canonical values.
  if (
    opts.permissionMode !== undefined &&
    !['default', 'auto', 'bypass'].includes(opts.permissionMode)
  ) {
    console.error(red(`  ❌ Invalid --permission-mode: "${opts.permissionMode}". Must be one of: default, auto, bypass.`));
    process.exit(1);
  }

  // Validate the new overhead-visibility flags. Same shape as
  // --permission-mode: commander forwards the raw string, we accept only the
  // three canonical values.
  if (opts.sessionHeader !== undefined && !isOverheadVisibility(opts.sessionHeader)) {
    console.error(red(`  ❌ Invalid --session-header: "${opts.sessionHeader}". Must be one of: ${OVERHEAD_VISIBILITY_VALUES.join(', ')}.`));
    process.exit(1);
  }
  if (opts.stickyMessage !== undefined && !isOverheadVisibility(opts.stickyMessage)) {
    console.error(red(`  ❌ Invalid --sticky-message: "${opts.stickyMessage}". Must be one of: ${OVERHEAD_VISIBILITY_VALUES.join(', ')}.`));
    process.exit(1);
  }

  // Build CLI args object
  const cliArgs: CliArgs = {
    url: opts.url,
    token: opts.token,
    channel: opts.channel,
    botName: opts.botName,
    allowedUsers: opts.allowedUsers,
    skipPermissions: opts.skipPermissions,
    permissionMode: opts.permissionMode as PermissionMode | undefined,
    chrome: opts.chrome,
    worktreeMode: opts.worktreeMode,
    keepAlive: opts.keepAlive,
    sessionHeader: opts.sessionHeader as OverheadVisibility | undefined,
    stickyMessage: opts.stickyMessage as OverheadVisibility | undefined,
  };

  // Check if we need onboarding
  if (opts.setup) {
    await runOnboarding(true); // reconfigure mode
  } else if (!checkConfigExists() && !hasRequiredCliArgs(opts)) {
    await runOnboarding(false); // first-time mode
  }

  const workingDir = process.cwd();
  const newConfig = loadConfigWithMigration();

  if (!newConfig) {
    throw new Error('No configuration found. Run with --setup to configure.');
  }

  // CLI args can override global settings
  if (cliArgs.chrome !== undefined) {
    newConfig.chrome = cliArgs.chrome;
  }
  if (cliArgs.worktreeMode !== undefined) {
    newConfig.worktreeMode = cliArgs.worktreeMode;
  }
  if (cliArgs.keepAlive !== undefined) {
    newConfig.keepAlive = cliArgs.keepAlive;
  }
  // Apply overhead-visibility overrides to every platform. These flags are
  // global-scoped (one value, applied everywhere) — the per-platform YAML
  // is the right place when you want different values per platform.
  if (cliArgs.sessionHeader !== undefined) {
    for (const p of newConfig.platforms) {
      p.sessionHeader = cliArgs.sessionHeader;
    }
  }
  if (cliArgs.stickyMessage !== undefined) {
    for (const p of newConfig.platforms) {
      p.stickyMessage = cliArgs.stickyMessage;
    }
  }

  // Determine keep-alive setting (actual setup happens after UI is ready)
  const keepAliveEnabled = newConfig.keepAlive !== false;

  // Validate we have at least one platform configured
  if (!newConfig.platforms || newConfig.platforms.length === 0) {
    throw new Error('No platforms configured. Run with --setup to configure.');
  }

  const config = newConfig;

  // Get the first platform's effective permission mode as the default
  // (for backwards compatibility with single-platform setups). Precedence:
  // --permission-mode CLI flag > --skip-permissions / --no-skip-permissions
  // (legacy) > platform config's `permissionMode` > platform config's legacy
  // `skipPermissions` > 'default' (safe fallback).
  const firstPlatformConfig = config.platforms[0] as MattermostPlatformConfig | SlackPlatformConfig;
  const initialPermissionMode: PermissionMode = resolvePermissionMode({
    permissionMode:
      cliArgs.permissionMode
      ?? firstPlatformConfig.permissionMode,
    skipPermissions:
      cliArgs.skipPermissions
      ?? firstPlatformConfig.skipPermissions,
  });

  // Check Claude CLI version
  const claudeValidation = validateClaudeCli();

  // Fail on incompatible version unless --skip-version-check is set.
  // Incompatible = below the hard floor or a new major; an untested newer
  // minor of the supported major runs with a warning instead (see the
  // version policy in src/claude/version-check.ts).
  if (!claudeValidation.compatible && !opts.skipVersionCheck) {
    console.error(red(`  ❌ ${claudeValidation.message}`));
    console.error('');
    console.error(dim(`  Use --skip-version-check to bypass this check (not recommended)`));
    console.error('');
    process.exit(1);
  }
  if (claudeValidation.status === 'untested') {
    console.error(yellow(`  ⚠️  ${claudeValidation.message}`));
    console.error('');
  }
  // The bypassed hard exit must not be silent — an unsupported CLI is more
  // dangerous than an untested one, so it gets at least the same visibility.
  if (!claudeValidation.compatible && opts.skipVersionCheck) {
    const prefix = claudeValidation.installed
      ? 'running with an unsupported Claude CLI. '
      : '';
    console.error(yellow(`  ⚠️  --skip-version-check: ${prefix}${claudeValidation.message}`));
    console.error('');
  }

  // Warn on an incompatible env + config combo: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1
  // forces Claude CLI into permissionMode: default and rejects
  // --dangerously-skip-permissions (verified on CLI 2.1.116). If any platform is
  // configured with skipPermissions: true, the user will see repeated warnings
  // from Claude and their sessions won't behave as configured.
  if (process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1') {
    const hasSkipPermissionPlatform = config.platforms.some(
      (p) => (p as MattermostPlatformConfig | SlackPlatformConfig).skipPermissions === true
    );
    if (hasSkipPermissionPlatform) {
      console.error(
        red('  ⚠️  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 is set but a platform has skipPermissions: true.')
      );
      console.error(
        dim('     Claude CLI will force permissionMode: default and reject --dangerously-skip-permissions.')
      );
      console.error(
        dim('     Either unset the env var or set skipPermissions: false on all platforms.')
      );
      console.error('');
    }
  }

  // Mutable reference for shutdown - set after all components initialized
  let triggerShutdown: (() => void) | null = null;

  // React 19 buffers a PerformanceMeasure per re-render on Node.js 25+, which
  // leaks until OOM. Nothing reads these entries, so drop them on a timer.
  // See src/utils/perf-cleanup.ts for the full rationale and safety notes.
  startReactMeasureCleanup();

  // Check if this is a daemon restart after update - restore runtime settings if so
  const updateState = loadUpdateState();
  const restoredSettings = updateState.justUpdated ? updateState.runtimeSettings : undefined;
  if (restoredSettings) {
    // Clear settings after reading so next manual start uses config defaults
    clearRuntimeSettings();
    // Restore debug mode if it was enabled
    if (restoredSettings.debugEnabled) {
      process.env.DEBUG = '1';
    }
  }

  // Mutable runtime config (can be changed via keyboard toggles)
  // These affect new sessions and sticky message display.
  // On daemon restart, restore previous settings; otherwise use config
  // defaults. `permissionMode` is the source of truth; `skipPermissions` is
  // the derived boolean kept around for any legacy persisted-settings reader.
  const restoredPermissionMode: PermissionMode = restoredSettings?.permissionMode
    ?? (restoredSettings?.skipPermissions === true ? 'bypass'
      : restoredSettings?.skipPermissions === false ? 'default'
      : initialPermissionMode);
  const runtimeConfig = {
    permissionMode: restoredPermissionMode,
    skipPermissions: restoredPermissionMode === 'bypass',
    chromeEnabled: restoredSettings?.chromeEnabled ?? (config.chrome ?? false),
    keepAliveEnabled: restoredSettings?.keepAliveEnabled ?? keepAliveEnabled,
  };

  // Session manager reference (set after UI is ready)
  let sessionManager: SessionManager | null = null;

  // Auto-update manager reference
  let autoUpdateManager: AutoUpdateManager | null = null;

  // Session store for persistence (created early so toggle callbacks can use it)
  const sessionStore = new SessionStore();

  // Start the UI (Ink TUI or headless depending on mode)
  const ui: UIProvider = await startUI({
    config: {
      version: VERSION,
      workingDir,
      claudeVersion: claudeValidation.version || 'unknown',
      claudeStatus: claudeValidation.status,
      permissionMode: runtimeConfig.permissionMode,
      chromeEnabled: runtimeConfig.chromeEnabled,
      keepAliveEnabled: runtimeConfig.keepAliveEnabled,
    },
    headless: isHeadless,
    onQuit: () => {
      if (triggerShutdown) triggerShutdown();
    },
    toggleCallbacks: {
      onDebugToggle: (enabled) => {
        // process.env.DEBUG is already updated in App.tsx
        // Persist for daemon restart
        saveRuntimeSettings({ ...getRuntimeSettings(), debugEnabled: enabled });
        ui.addLog({ level: 'info', component: 'toggle', message: `Debug mode ${enabled ? 'enabled' : 'disabled'}` });
        // Trigger sticky message update to reflect debug state
        sessionManager?.updateAllStickyMessages();
      },
      onPermissionsToggle: (mode) => {
        runtimeConfig.permissionMode = mode;
        // Persist for daemon restart. We also write the legacy
        // `skipPermissions` boolean (derived) so older daemon-restart paths
        // that still read it keep working; precedence in resolvePermissionMode
        // keeps `permissionMode` authoritative on next startup.
        saveRuntimeSettings({
          ...getRuntimeSettings(),
          permissionMode: mode,
          skipPermissions: mode === 'bypass',
        });
        // Update ALL platform configs so new sessions use this setting.
        for (const platformConfig of config.platforms) {
          const pc = platformConfig as MattermostPlatformConfig | SlackPlatformConfig;
          pc.permissionMode = mode;
          pc.skipPermissions = mode === 'bypass';
        }
        // Update SessionManager's internal state for sticky message
        sessionManager?.setPermissionMode(mode);
        ui.addLog({ level: 'info', component: 'toggle', message: `Permission mode: ${mode}` });
        sessionManager?.updateAllStickyMessages();
      },
      onChromeToggle: (enabled) => {
        runtimeConfig.chromeEnabled = enabled;
        config.chrome = enabled;
        // Persist for daemon restart
        saveRuntimeSettings({ ...getRuntimeSettings(), chromeEnabled: enabled });
        // Update SessionManager's internal state for sticky message
        sessionManager?.setChromeEnabled(enabled);
        ui.addLog({ level: 'info', component: 'toggle', message: `Chrome integration ${enabled ? 'enabled' : 'disabled'} for new sessions` });
        sessionManager?.updateAllStickyMessages();
      },
      onKeepAliveToggle: (enabled) => {
        runtimeConfig.keepAliveEnabled = enabled;
        keepAlive.setEnabled(enabled);
        // Persist for daemon restart
        saveRuntimeSettings({ ...getRuntimeSettings(), keepAliveEnabled: enabled });
        ui.addLog({ level: 'info', component: 'toggle', message: `Keep-alive ${enabled ? 'enabled' : 'disabled'}` });
        sessionManager?.updateAllStickyMessages();
      },
      onPlatformToggle: async (platformId, enabled) => {
        const client = platforms.get(platformId);
        if (!client) {
          // A derived DM instance may legitimately have no live client (torn
          // down, or skipped at boot because it was disabled). Persist the
          // desired state anyway — enabling means the next incoming DM
          // re-discovers the channel.
          if (platformId.includes(DM_PLATFORM_SEP)) {
            sessionStore.setPlatformEnabled(platformId, enabled);
            platformEnabledState.set(platformId, enabled);
            ui.addLog({ level: 'info', component: 'toggle', message: `DM instance ${platformId} ${enabled ? 'enabled (re-discovered on next DM)' : 'disabled'}` });
            return;
          }
          ui.addLog({ level: 'error', component: 'toggle', message: `Platform ${platformId} not found` });
          return;
        }

        if (enabled) {
          // Re-enable platform: reconnect and resume sessions
          ui.addLog({ level: 'info', component: 'toggle', message: `Enabling platform ${platformId}...` });
          try {
            client.prepareForReconnect();
            await client.connect();
            // Persist enabled state after successful connect — including the
            // in-memory snapshot the DM discovery runtime consults.
            sessionStore.setPlatformEnabled(platformId, true);
            platformEnabledState.set(platformId, true);
            ui.addLog({ level: 'info', component: 'toggle', message: `✓ Platform ${platformId} reconnected` });
            // Resume paused sessions for this platform
            await sessionManager?.resumePausedSessionsForPlatform(platformId);
          } catch (err) {
            ui.addLog({ level: 'error', component: 'toggle', message: `Failed to reconnect ${platformId}: ${err}` });
            // Revert UI state since connect failed
            ui.setPlatformStatus(platformId, { enabled: false });
          }
        } else {
          // Disable platform: pause sessions and disconnect
          ui.addLog({ level: 'info', component: 'toggle', message: `Disabling platform ${platformId}...` });
          // Pause all active sessions for this platform first
          await sessionManager?.pauseSessionsForPlatform(platformId);
          client.disconnect();
          // Persist disabled state — including the in-memory snapshot the DM
          // discovery runtime consults, so the next incoming DM cannot
          // silently re-enable this instance.
          sessionStore.setPlatformEnabled(platformId, false);
          platformEnabledState.set(platformId, false);
          ui.setPlatformStatus(platformId, { connected: false, reconnecting: false });
          ui.addLog({ level: 'info', component: 'toggle', message: `✓ Platform ${platformId} disabled` });
        }
      },
      onForceUpdate: () => {
        if (autoUpdateManager?.hasUpdate()) {
          ui.addLog({ level: 'info', component: 'update', message: '🚀 Force updating via Shift+U...' });
          autoUpdateManager.forceUpdate().catch((err) => {
            ui.addLog({ level: 'error', component: 'update', message: `Force update failed: ${err}` });
          });
        } else {
          ui.addLog({ level: 'info', component: 'update', message: 'No update available to install' });
        }
      },
    },
  });

  // Route all logger output through the UI
  setLogHandler((level, component, message, sessionId) => {
    ui.addLog({ level, component, message, sessionId });
  });

  // Now that log handler is set, enable keep-alive (will route logs through UI)
  keepAlive.setEnabled(keepAliveEnabled);

  // Create session manager (shared across all platforms).
  // Pass the resolved permission mode string (not the legacy boolean) so the
  // manager tracks all three modes correctly.
  const threadLogsEnabled = config.threadLogs?.enabled ?? true;
  const threadLogsRetentionDays = config.threadLogs?.retentionDays ?? 30;
  const session = new SessionManager(
    workingDir,
    initialPermissionMode,
    config.chrome,
    config.worktreeMode,
    undefined,  // sessionsPath - use default
    threadLogsEnabled,
    threadLogsRetentionDays,
    config.limits,  // Resource limits (optional, has sensible defaults)
    config.claudeAccounts,  // Claude account pool (undefined = single-account mode)
    config.respondOnlyWhenMentioned,  // Quiet-mode default for new sessions (#402)
    config.userAttribution  // Per-message [@username]: attribution (default on; only applied once a thread has >1 participant)
  );

  // Set sticky message customization from config
  if (config.stickyMessage) {
    session.setStickyMessageCustomization(config.stickyMessage.description, config.stickyMessage.footer);
  }

  // Speech-to-text for inbound audio attachments. createTranscriber throws on
  // a bad block, so a misconfigured provider fails the boot, not the first
  // voice note. See docs/audio-transcription-spec.md.
  if (config.transcription) {
    session.setTranscriber(createTranscriber(config.transcription));
    ui.addLog({ level: 'info', component: 'transcription', message: `🎙️ Audio attachments are transcribed via ${config.transcription.provider}` });
  }

  // Set reference for toggle callbacks
  sessionManager = session;

  // Wire up session events to UI (shared across all platforms)
  session.on('session:add', (info) => {
    ui.addSession(info);
  });
  session.on('session:update', (sessionId, updates) => {
    ui.updateSession(sessionId, updates);
  });
  session.on('session:remove', (sessionId) => {
    ui.removeSession(sessionId);
    activeDmRuntime?.onSessionRemove(sessionId);
  });

  // Store all platform clients for shutdown
  const platforms = new Map<string, PlatformClient>();

  // Load persisted platform enabled states (sessionStore created earlier for toggle callbacks)
  const platformEnabledState = sessionStore.getPlatformEnabledState();

  // Initialize all configured platforms
  ui.addLog({ level: 'debug', component: 'init', message: `Initializing ${config.platforms.length} platform(s)` });
  for (const platformConfig of config.platforms) {
    const typedConfig = platformConfig as MattermostPlatformConfig | SlackPlatformConfig;
    const isEnabled = platformEnabledState.get(platformConfig.id) ?? true; // Default to enabled
    ui.addLog({ level: 'info', component: 'init', message: `Creating ${platformConfig.type} platform: ${platformConfig.id}${isEnabled ? '' : ' (disabled)'}` });

    // Register platform with UI (with persisted enabled state)
    ui.setPlatformStatus(platformConfig.id, {
      displayName: platformConfig.displayName || platformConfig.id,
      botName: typedConfig.botName,
      url: typedConfig.type === 'mattermost' ? (typedConfig as MattermostPlatformConfig).url : 'slack.com',
      platformType: typedConfig.type as 'mattermost' | 'slack',
      enabled: isEnabled,
    });

    // Create platform client using factory
    const client = createPlatformClient(platformConfig);
    platforms.set(platformConfig.id, client);
    configureAuditLog(platformConfig.id, resolveAuditLogEnabled(platformConfig.auditLog, `platforms[${platformConfig.id}].auditLog`));

    // Register with session manager (passes per-platform overhead visibility)
    session.addPlatform(platformConfig.id, client, {
      overhead: {
        sessionHeader: resolveOverheadVisibility(
          platformConfig.sessionHeader,
          `platforms[${platformConfig.id}].sessionHeader`,
        ),
        stickyMessage: resolveOverheadVisibility(
          platformConfig.stickyMessage,
          `platforms[${platformConfig.id}].stickyMessage`,
        ),
        turnMarker: resolveTurnMarker(
          platformConfig.turnMarker,
          platformConfig.turnMarkerEmoji,
          platformConfig.type,
          `platforms[${platformConfig.id}]`,
        ),
      },
      memory: resolveMemoryConfig(
        platformConfig.memory,
        `platforms[${platformConfig.id}].memory`,
      ),
      routinesEnabled: resolveRoutinesEnabled(
        platformConfig.routines,
        `platforms[${platformConfig.id}].routines`,
      ),
      watchesEnabled: resolveWatchesEnabled(
        platformConfig.watches,
        `platforms[${platformConfig.id}].watches`,
      ),
      transcriptionEnabled: resolveTranscriptionEnabled(
        platformConfig.transcription,
        `platforms[${platformConfig.id}].transcription`,
      ),
    });

    // Wire up platform events
    wirePlatformEvents(platformConfig.id, client, session, ui, platformConfig.directChannelMode);
  }

  // ---------------------------------------------------------------------------
  // DM auto-discovery (Mattermost only): derived platform instances for DM
  // channels — spawned live on first contact, reconstructed at boot from
  // persisted sessions so DM sessions survive restarts. The lifecycle logic
  // lives in the injectable runtime (src/platform/dm-discovery-runtime.ts).
  // ---------------------------------------------------------------------------
  const dmRuntime = createDmDiscoveryRuntime({
    platforms,
    session,
    log: (level, message) => ui.addLog({ level, component: 'dm', message }),
    registerPlatform: (dmConfig) => {
      const dmClient = createPlatformClient(dmConfig);
      platforms.set(dmConfig.id, dmClient);
      ui.setPlatformStatus(dmConfig.id, {
        displayName: dmConfig.displayName,
        botName: dmConfig.botName,
        url: dmConfig.url,
        platformType: 'mattermost',
        enabled: true,
      });
      configureAuditLog(dmConfig.id, resolveAuditLogEnabled(dmConfig.auditLog, `dm[${dmConfig.id}].auditLog`));
      // The derived config spreads the parent's fields, so memory/routines/
      // watches settings MUST travel too: omitting them made addPlatform
      // fall back to its fully-enabled defaults — a parent with
      // `memory: false` (privacy) would still get end-of-session
      // distillation on private DM conversations.
      session.addPlatform(dmConfig.id, dmClient, {
        overhead: {
          sessionHeader: resolveOverheadVisibility(dmConfig.sessionHeader, `dm[${dmConfig.id}].sessionHeader`),
          stickyMessage: 'hidden',
          // A derived DM config spreads its parent, so the parent's marker carries over.
          turnMarker: resolveTurnMarker(dmConfig.turnMarker, dmConfig.turnMarkerEmoji, dmConfig.type, `dm[${dmConfig.id}]`),
        },
        memory: resolveMemoryConfig(
          dmConfig.memory,
          `dm[${dmConfig.id}].memory`,
        ),
        routinesEnabled: resolveRoutinesEnabled(
          dmConfig.routines,
          `dm[${dmConfig.id}].routines`,
        ),
        watchesEnabled: resolveWatchesEnabled(
          dmConfig.watches,
          `dm[${dmConfig.id}].watches`,
        ),
        // A derived DM instance inherits the parent's setting: the consent
        // that matters was given when the parent channel was configured.
        transcriptionEnabled: resolveTranscriptionEnabled(
          dmConfig.transcription,
          `dm[${dmConfig.id}].transcription`,
        ),
      });
      wirePlatformEvents(dmConfig.id, dmClient, session, ui, dmConfig.directChannelMode);
      return dmClient;
    },
    deliverMessage: (client, post, user, dmPlatformIdArg) =>
      handleMessage(client, session, post, user, {
        platformId: dmPlatformIdArg,
        directChannelMode: true,
        logger: { error: (msg) => ui.addLog({ level: 'error', component: '❌', message: msg }) },
      }),
    loadPersistedSessions: () => sessionStore.load(),
    isEnabled: (id) => platformEnabledState.get(id) ?? true,
    removeUiRow: (id) => ui.removePlatformStatus(id),
  });
  activeDmRuntime = dmRuntime;

  for (const platformConfig of config.platforms) {
    if (platformConfig.type !== 'mattermost') continue;
    const mmConfig = platformConfig as MattermostPlatformConfig;
    if (!mmConfig.directMessages) continue;
    const parentClient = platforms.get(platformConfig.id);
    if (!parentClient) continue;
    dmRuntime.wireParent(mmConfig, parentClient);
  }

  // Boot reconstruction: rebuild derived instances for persisted DM sessions
  // before connecting, so session.initialize() can resume them. Disabled
  // instances get a UI row anyway — the toggle can only address platforms it
  // can see, and enabling one means re-discovery on the next DM.
  const skippedDisabledDm = dmRuntime.reconstructPersisted(config.platforms, (id) => platformEnabledState.get(id) ?? true);
  // Every disabled derived DM id needs a UI row to stay re-enablable. Two
  // sources: instances skipped during reconstruction (had a resumable
  // session), and the enabled-state store itself — a disabled DM that never
  // produced a Claude session (e.g. only ever received `!help`) has no
  // persisted session to iterate, but its disable was persisted here.
  const disabledDmIds = new Set<string>(skippedDisabledDm.map((d) => d.platformId));
  for (const [pid, enabled] of platformEnabledState) {
    if (!enabled && pid.includes(DM_PLATFORM_SEP) && !platforms.has(pid)) {
      disabledDmIds.add(pid);
    }
  }
  for (const dmPid of disabledDmIds) {
    ui.setPlatformStatus(dmPid, {
      displayName: `${dmPid} (disabled DM)`,
      botName: '',
      url: '',
      platformType: 'mattermost',
      enabled: false,
    });
  }

  // Connect only enabled platforms
  const enabledPlatforms = Array.from(platforms.entries()).filter(
    ([id]) => platformEnabledState.get(id) ?? true
  );
  const disabledCount = platforms.size - enabledPlatforms.length;
  ui.addLog({ level: 'info', component: 'init', message: `Connecting ${enabledPlatforms.length} platform(s)...${disabledCount > 0 ? ` (${disabledCount} disabled)` : ''}` });
  const connectionResults = await Promise.allSettled(
    enabledPlatforms.map(async ([id, client]) => {
      ui.addLog({ level: 'debug', component: 'init', message: `Connecting to ${id}...` });
      try {
        await client.connect();
        ui.addLog({ level: 'info', component: 'init', message: `✓ Connected to ${id}` });
        return { id, success: true, client };
      } catch (err) {
        ui.addLog({ level: 'error', component: 'init', message: `✗ Failed to connect to ${id}: ${err}` });
        // Mark the platform as disabled so we don't try to use it
        platformEnabledState.set(id, false);
        return { id, success: false, error: err, client };
      }
    })
  );

  // Settle reconstructed DM instances: a connected one leaves the forwarding
  // window; a failed one must not keep owning its channel (that would block
  // rediscovery forever) — tear it down so the next DM starts fresh.
  for (const result of connectionResults) {
    if (result.status !== 'fulfilled') continue;
    dmRuntime.settleBootResult(result.value.id, result.value.success, result.value.client);
  }

  // Check if at least one platform connected successfully
  const successfulConnections = connectionResults.filter(
    (r) => r.status === 'fulfilled' && r.value.success
  );
  if (successfulConnections.length === 0) {
    ui.addLog({ level: 'error', component: 'init', message: '⚠️ No platforms connected. Check your configuration and credentials.' });
  }

  // Resume any persisted sessions from before restart
  await session.initialize();

  // Shutdown flag - shared between shutdown() and prepareForRestart callback
  let isShuttingDown = false;

  // Initialize auto-update manager
  autoUpdateManager = new AutoUpdateManager(config.autoUpdate, {
    getSessionActivity: () => session.getActivityInfo(),
    getActiveThreadIds: () => session.getActiveThreadIds(),
    broadcastUpdate: (msg) => session.broadcastToAll(msg),
    postAskMessage: (ids, ver) => session.postUpdateAskMessage(ids, ver),
    refreshUI: () => session.updateAllStickyMessages(),
    prepareForRestart: async () => {
      // Reuse shutdown logic to persist sessions before update restart
      if (isShuttingDown) return;
      isShuttingDown = true;

      ui.setShuttingDown();
      session.setShuttingDown();
      await session.updateAllStickyMessages();
      await session.killAllSessions();
      autoUpdateManager?.stop();

      // Await disconnects so the new bot process can re-establish
      // websockets without racing the old process. Self-respawn (added
      // for !update on TTY-without-supervisor) tightens this timing
      // because the new child starts within tens of milliseconds of
      // the old process exiting.
      await Promise.all(
        Array.from(platforms.values()).map((client) =>
          client.disconnect().catch((err) => {
            ui.addLog({ level: 'warn', component: 'shutdown', message: `disconnect failed: ${err}` });
          })
        )
      );

      // Clear screen and restore cursor before daemon restarts us (only in interactive mode)
      if (!isHeadless) {
        process.stdout.write('\x1b[2J\x1b[H');  // Clear screen, cursor to home
        process.stdout.write('\x1b[?25h');       // Restore cursor visibility
      }
    },
  });

  // Connect auto-update manager to session manager for !update commands
  session.setAutoUpdateManager(autoUpdateManager);

  // Wire up auto-update events to UI
  autoUpdateManager.on('update:available', (info) => {
    ui.addLog({ level: 'info', component: 'update', message: `🆕 Update available: v${info.currentVersion} → v${info.latestVersion}` });
    ui.setUpdateState({
      status: 'available',
      currentVersion: info.currentVersion,
      latestVersion: info.latestVersion,
    });
  });

  autoUpdateManager.on('update:countdown', (seconds) => {
    if (seconds === 60 || seconds === 30 || seconds === 10 || seconds <= 5) {
      ui.addLog({ level: 'info', component: 'update', message: `🔄 Restarting in ${seconds} seconds...` });
    }
    // Update scheduled restart time
    const restartAt = autoUpdateManager?.getScheduledRestartAt();
    const updateInfo = autoUpdateManager?.getUpdateInfo();
    if (restartAt) {
      ui.setUpdateState({
        status: 'scheduled',
        currentVersion: VERSION,
        latestVersion: updateInfo?.latestVersion,
        scheduledRestartAt: restartAt,
      });
    }
  });

  autoUpdateManager.on('update:status', (status, message) => {
    if (message) {
      ui.addLog({ level: 'info', component: 'update', message: `🔄 ${status}: ${message}` });
    }
    // Map auto-update status to UI status
    const updateInfo = autoUpdateManager?.getUpdateInfo();
    const state = autoUpdateManager?.getState();
    ui.setUpdateState({
      status: status as 'idle' | 'available' | 'scheduled' | 'installing' | 'pending_restart' | 'failed' | 'deferred',
      currentVersion: VERSION,
      latestVersion: updateInfo?.latestVersion,
      scheduledRestartAt: autoUpdateManager?.getScheduledRestartAt() ?? undefined,
      errorMessage: state?.errorMessage,
    });
  });

  autoUpdateManager.on('update:failed', (error) => {
    ui.addLog({ level: 'error', component: 'update', message: `❌ Update failed: ${error}` });
    ui.setUpdateState({
      status: 'failed',
      currentVersion: VERSION,
      latestVersion: autoUpdateManager?.getUpdateInfo()?.latestVersion,
      errorMessage: error,
    });
  });

  // Initialize update state
  ui.setUpdateState({
    status: 'idle',
    currentVersion: VERSION,
  });

  // Start auto-update system
  autoUpdateManager.start();

  // Mark UI as ready
  ui.setReady();

  const shutdown = async (_signal: string) => {
    // Guard against multiple shutdown calls (SIGINT + SIGTERM)
    if (isShuttingDown) return;
    isShuttingDown = true;

    // Update status bar to show shutdown in progress
    ui.setShuttingDown();

    // Give React a moment to render the shutdown state
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Set shutdown flag FIRST to prevent race conditions with exit events
    session.setShuttingDown();

    // Update sticky messages to show shutdown state
    await session.updateAllStickyMessages();

    // Post shutdown message to active sessions (updates existing timeout posts or creates new ones)
    const activeCount = session.getActiveThreadIds().length;
    if (activeCount > 0) {
      ui.addLog({ level: 'info', component: '📤', message: `Notifying ${activeCount} active session(s)...` });
      await session.postShutdownMessages();
    }

    await session.killAllSessions();

    // Stop auto-update manager
    autoUpdateManager?.stop();

    // Disconnect all platforms
    for (const client of platforms.values()) {
      client.disconnect();
    }

    // Clear screen and restore cursor for clean exit (only in interactive mode)
    if (!isHeadless) {
      process.stdout.write('\x1b[2J\x1b[H');  // Clear screen, cursor to home
      process.stdout.write('\x1b[?25h');       // Restore cursor visibility
      process.stdout.write(`\nThanks for using claude-threads! ${dim('♥ Support the project: https://github.com/sponsors/axolotl-systems')}\n\n`);
    }
    // Don't call process.exit() here - let the signal handler do it after we resolve
  };

  // Wire up the Ctrl+C handler from UI to shutdown
  triggerShutdown = () => {
    shutdown('Ctrl+C').finally(() => process.exit(0));
  };

  // Remove any existing signal handlers (e.g., from 'when-exit' package)
  // and register our own to ensure graceful shutdown
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  process.on('SIGINT', () => {
    shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').finally(() => process.exit(0));
  });
}

main().catch(e => { console.error(e); process.exit(1); });
