/**
 * Pull Request URL detection utility
 *
 * Detects PR/MR URLs from various Git hosting platforms:
 * - GitHub (github.com)
 * - GitLab (gitlab.com and self-hosted)
 * - Bitbucket (bitbucket.org)
 * - Azure DevOps (dev.azure.com)
 */

/**
 * Information about a detected pull request
 */
export interface PullRequestInfo {
  url: string;        // Full URL to the PR
  platform: string;   // Platform name (github, gitlab, bitbucket, azure)
  number: string;     // PR/MR number
  repo?: string;      // Repository path (owner/repo)
}

/**
 * Regex patterns for different Git hosting platforms
 *
 * Each pattern captures:
 * - Group 1: Repository path (owner/repo)
 * - Group 2: PR/MR number
 */
const PR_PATTERNS: Array<{ platform: string; pattern: RegExp }> = [
  // GitHub: https://github.com/owner/repo/pull/123
  {
    platform: 'github',
    pattern: /https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/gi,
  },
  // GitLab: https://gitlab.com/owner/repo/-/merge_requests/123
  // Also handles self-hosted: https://gitlab.example.com/owner/repo/-/merge_requests/123
  {
    platform: 'gitlab',
    pattern: /https?:\/\/[^/]*gitlab[^/]*\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)/gi,
  },
  // Bitbucket: https://bitbucket.org/owner/repo/pull-requests/123
  {
    platform: 'bitbucket',
    pattern: /https?:\/\/bitbucket\.org\/([^/]+\/[^/]+)\/pull-requests\/(\d+)/gi,
  },
  // Azure DevOps: https://dev.azure.com/org/project/_git/repo/pullrequest/123
  {
    platform: 'azure',
    pattern: /https?:\/\/dev\.azure\.com\/([^/]+\/[^/]+\/_git\/[^/]+)\/pullrequest\/(\d+)/gi,
  },
  // Azure DevOps (old format): https://org.visualstudio.com/project/_git/repo/pullrequest/123
  {
    platform: 'azure',
    pattern: /https?:\/\/[^/]+\.visualstudio\.com\/([^/]+\/_git\/[^/]+)\/pullrequest\/(\d+)/gi,
  },
];

/**
 * Detect pull request URLs in text.
 * Returns all detected PR URLs with metadata.
 *
 * @param text - Text to search for PR URLs
 * @returns Array of detected PRs (empty if none found)
 */
export function detectPullRequests(text: string): PullRequestInfo[] {
  const results: PullRequestInfo[] = [];
  const seenUrls = new Set<string>();

  for (const { platform, pattern } of PR_PATTERNS) {
    // Reset regex state for each search
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[0];

      // Skip duplicates
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      results.push({
        url,
        platform,
        repo: match[1],
        number: match[2],
      });
    }
  }

  return results;
}

/**
 * Extract the first pull request URL from text.
 * Returns null if no PR URL is found.
 *
 * @param text - Text to search for PR URLs
 * @returns First detected PR URL or null
 */
export function extractPullRequestUrl(text: string): string | null {
  const prs = detectPullRequests(text);
  return prs.length > 0 ? prs[0].url : null;
}

/**
 * Format a PR URL for display.
 * Returns a compact representation like "🔗 PR #123" or "🔗 MR !45"
 *
 * @param url - Full PR URL
 * @returns Formatted string for display
 */
export function formatPullRequestLink(url: string): string {
  const prs = detectPullRequests(url);
  if (prs.length === 0) return url;

  const pr = prs[0];

  // GitLab uses "MR" (Merge Request) terminology
  if (pr.platform === 'gitlab') {
    return `[🔗 MR !${pr.number}](${url})`;
  }

  // GitHub, Bitbucket, Azure use "PR" terminology
  return `[🔗 PR #${pr.number}](${url})`;
}

/**
 * Get platform icon for a PR URL
 */
export function getPlatformIcon(url: string): string {
  if (url.includes('github.com')) return '🐙';
  if (url.includes('gitlab')) return '🦊';
  if (url.includes('bitbucket')) return '🪣';
  if (url.includes('azure') || url.includes('visualstudio')) return '🔷';
  return '🔗';
}
