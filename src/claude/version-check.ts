import { execSync } from 'child_process';
import { satisfies, coerce } from 'semver';

/**
 * Known compatible Claude CLI version range.
 *
 * Update this when testing with new Claude CLI versions.
 * - MIN: Oldest version known to work
 * - MAX: Newest version known to work
 */
export const CLAUDE_CLI_VERSION_RANGE = '>=2.0.74 <=2.0.76';

/**
 * Get the installed Claude CLI version.
 * Returns null if claude is not installed or version can't be determined.
 */
export function getClaudeCliVersion(): string | null {
  const claudePath = process.env.CLAUDE_PATH || 'claude';

  try {
    const output = execSync(`${claudePath} --version`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Output format: "2.0.76 (Claude Code)" or just "2.0.76"
    const match = output.match(/^([\d.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Check if a version is compatible with claude-threads.
 */
export function isVersionCompatible(version: string): boolean {
  const semverVersion = coerce(version);
  if (!semverVersion) return false;

  return satisfies(semverVersion, CLAUDE_CLI_VERSION_RANGE);
}

/**
 * Validate Claude CLI installation and version.
 * Returns an object with status and details.
 */
export function validateClaudeCli(): {
  installed: boolean;
  version: string | null;
  compatible: boolean;
  message: string;
} {
  const version = getClaudeCliVersion();

  if (!version) {
    return {
      installed: false,
      version: null,
      compatible: false,
      message: 'Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code',
    };
  }

  const compatible = isVersionCompatible(version);

  if (!compatible) {
    return {
      installed: true,
      version,
      compatible: false,
      message: `Claude CLI version ${version} is not compatible. Required: ${CLAUDE_CLI_VERSION_RANGE}\n` +
        `Install a compatible version: npm install -g @anthropic-ai/claude-code@2.0.76`,
    };
  }

  return {
    installed: true,
    version,
    compatible: true,
    message: `Claude CLI ${version} ✓`,
  };
}
