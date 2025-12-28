import updateNotifier, { type UpdateInfo } from 'update-notifier';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let cachedUpdateInfo: UpdateInfo | undefined;

export function checkForUpdates(): void {
  if (process.env.NO_UPDATE_NOTIFIER) return;

  try {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')
    );

    const notifier = updateNotifier({
      pkg,
      updateCheckInterval: 1000 * 60 * 30, // Check every 30 minutes
    });

    // Cache for Mattermost notifications
    cachedUpdateInfo = notifier.update;

    // Show CLI notification
    notifier.notify({
      message: `Update available: {currentVersion} → {latestVersion}
Run: npm install -g mattermost-claude-code`,
    });
  } catch {
    // Silently fail - update checking is not critical
  }
}

// Returns update info if available, for posting to Mattermost
export function getUpdateInfo(): UpdateInfo | undefined {
  return cachedUpdateInfo;
}
