import updateNotifier, { type UpdateInfo } from 'update-notifier';
import semver from 'semver';
import { PKG } from './version.js';

let cachedUpdateInfo: UpdateInfo | undefined;

export function checkForUpdates(): void {
  if (process.env.NO_UPDATE_NOTIFIER) return;

  try {
    const notifier = updateNotifier({
      pkg: PKG,
      updateCheckInterval: 1000 * 60 * 30, // Check every 30 minutes
    });

    // Cache for chat platform notifications
    cachedUpdateInfo = notifier.update;

    // Show CLI notification
    notifier.notify({
      message: `Update available: {currentVersion} → {latestVersion}
Run: npm install -g claude-threads`,
    });
  } catch {
    // Silently fail - update checking is not critical
  }
}

// Returns update info if available, for posting to chat platforms
// Only returns if latest > current (handles stale cache edge case)
export function getUpdateInfo(): UpdateInfo | undefined {
  if (!cachedUpdateInfo) return undefined;

  // Sanity check: only show update if latest is actually newer
  const current = cachedUpdateInfo.current;
  const latest = cachedUpdateInfo.latest;
  if (current && latest && semver.gte(current, latest)) {
    return undefined; // Current is same or newer, no update needed
  }

  return cachedUpdateInfo;
}
