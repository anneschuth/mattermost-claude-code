import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ReleaseNotes {
  version: string;
  date: string;
  sections: { [key: string]: string[] };  // e.g., { "Added": ["feature1", "feature2"], "Fixed": ["bug1"] }
}

/**
 * Parse CHANGELOG.md and extract release notes for a specific version.
 */
export function getReleaseNotes(version?: string): ReleaseNotes | null {
  // Try to find CHANGELOG.md in various locations
  const possiblePaths = [
    resolve(__dirname, '..', 'CHANGELOG.md'),      // dist/../CHANGELOG.md (installed)
    resolve(__dirname, '..', '..', 'CHANGELOG.md'), // src/../CHANGELOG.md (dev)
  ];

  let changelogPath: string | null = null;
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      changelogPath = p;
      break;
    }
  }

  if (!changelogPath) {
    return null;
  }

  try {
    const content = readFileSync(changelogPath, 'utf-8');
    return parseChangelog(content, version);
  } catch {
    return null;
  }
}

/**
 * Parse changelog content and extract notes for a version.
 * If no version specified, returns the latest (first) version.
 */
function parseChangelog(content: string, targetVersion?: string): ReleaseNotes | null {
  const lines = content.split('\n');

  let currentVersion: string | null = null;
  let currentDate: string | null = null;
  let currentSection: string | null = null;
  let sections: { [key: string]: string[] } = {};
  let foundTarget = false;

  for (const line of lines) {
    // Match version header: ## [0.8.0] - 2025-12-28
    const versionMatch = line.match(/^## \[(\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?/);
    if (versionMatch) {
      // If we already found our target, we're done
      if (foundTarget) {
        break;
      }

      currentVersion = versionMatch[1];
      currentDate = versionMatch[2] || '';
      sections = {};
      currentSection = null;

      // Check if this is the version we want
      if (!targetVersion || currentVersion === targetVersion) {
        foundTarget = true;
      }
      continue;
    }

    // Only process if we're in the target version
    if (!foundTarget) continue;

    // Match section header: ### Added, ### Fixed, ### Changed
    const sectionMatch = line.match(/^### (\w+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      sections[currentSection] = [];
      continue;
    }

    // Match list item: - Item text
    const itemMatch = line.match(/^- (.+)/);
    if (itemMatch && currentSection) {
      sections[currentSection].push(itemMatch[1]);
    }
  }

  if (!foundTarget || !currentVersion) {
    return null;
  }

  return {
    version: currentVersion,
    date: currentDate || '',
    sections,
  };
}

/**
 * Format release notes as a chat message with markdown.
 */
export function formatReleaseNotes(notes: ReleaseNotes): string {
  let msg = `### 📋 Release Notes - v${notes.version}`;
  if (notes.date) {
    msg += ` (${notes.date})`;
  }
  msg += '\n\n';

  for (const [section, items] of Object.entries(notes.sections)) {
    if (items.length === 0) continue;

    const emoji = section === 'Added' ? '✨' :
                  section === 'Fixed' ? '🐛' :
                  section === 'Changed' ? '🔄' :
                  section === 'Removed' ? '🗑️' : '•';

    msg += `**${emoji} ${section}**\n`;
    for (const item of items) {
      msg += `- ${item}\n`;
    }
    msg += '\n';
  }

  return msg.trim();
}

/**
 * Get a short summary of what's new (for session header).
 */
export function getWhatsNewSummary(notes: ReleaseNotes): string {
  const items: string[] = [];

  // Prioritize: Added > Fixed > Changed
  for (const section of ['Added', 'Fixed', 'Changed']) {
    const sectionItems = notes.sections[section] || [];
    for (const item of sectionItems) {
      // Extract just the first part (before any dash or detail)
      const short = item.split(' - ')[0].replace(/\*\*/g, '');
      if (short.length <= 50) {
        items.push(short);
      } else {
        items.push(short.substring(0, 47) + '...');
      }
      if (items.length >= 2) break;
    }
    if (items.length >= 2) break;
  }

  return items.join(', ');
}
