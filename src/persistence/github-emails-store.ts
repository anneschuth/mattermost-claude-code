/**
 * GitHubEmailsStore — persistence for users' GitHub noreply email addresses.
 *
 * Each collaborator self-registers via `!github-email <addr>` so we never
 * read their platform email (privacy: it would otherwise leak into the chat
 * thread and into Claude's local conversation history). The noreply form
 * `<id>+<username>@users.noreply.github.com` is intentionally publishable —
 * GitHub designed it to keep the real email private while still letting
 * commits be matched to the account.
 *
 * Storage: YAML at ~/.config/claude-threads/github-emails.yaml, 0600.
 * Shape: `{ <platformId>: { <username>: <noreplyEmail> } }`.
 *
 * Per-platform scope: a username on `mattermost-main` and the same string on
 * `slack-workspace` may be different humans, so they keep separate entries.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { stateHome } from '../utils/state-home.js';
import { writeFileAtomic } from './atomic-file.js';
import { join } from 'path';
import yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';

const log = createLogger('gh-emails');

const DEFAULT_CONFIG_DIR = join(stateHome(), '.config', 'claude-threads');
const DEFAULT_FILE = join(DEFAULT_CONFIG_DIR, 'github-emails.yaml');

/**
 * GitHub noreply email format we accept. Required ID-prefix form
 * (`<id>+<username>@users.noreply.github.com`) — the legacy username-only
 * form silently fails to match for accounts created after July 2017, and
 * we don't want to debug that on a user's behalf.
 */
const NOREPLY_REGEX = /^\d+\+[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})@users\.noreply\.github\.com$/;

interface FileShape {
  version: number;
  /** platformId -> username -> noreply email */
  emails: Record<string, Record<string, string>>;
}

const STORE_VERSION = 1;

/**
 * Returns true if the string is a valid GitHub noreply email in ID-prefix form.
 */
export function isValidGitHubNoreplyEmail(s: string): boolean {
  return NOREPLY_REGEX.test(s);
}

export class GitHubEmailsStore {
  private readonly file: string;
  private readonly configDir: string;

  constructor(filePath?: string) {
    const envPath = process.env.CLAUDE_THREADS_GITHUB_EMAILS_PATH;
    const effective = filePath ?? envPath;

    if (effective) {
      this.file = effective;
      this.configDir = join(effective, '..');
    } else {
      this.file = DEFAULT_FILE;
      this.configDir = DEFAULT_CONFIG_DIR;
    }

    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Look up the registered noreply email for a (platform, user) pair.
   * Returns undefined when the user has not registered.
   */
  get(platformId: string, username: string): string | undefined {
    const data = this.loadRaw();
    return data.emails[platformId]?.[username];
  }

  /**
   * Register or replace the noreply email for a (platform, user) pair.
   * Throws if the input is not a valid noreply address.
   */
  set(platformId: string, username: string, email: string): void {
    if (!isValidGitHubNoreplyEmail(email)) {
      throw new Error(
        `Not a valid GitHub noreply email (expected <id>+<username>@users.noreply.github.com): ${email}`
      );
    }
    const data = this.loadRaw();
    if (!data.emails[platformId]) {
      data.emails[platformId] = {};
    }
    data.emails[platformId][username] = email;
    this.writeAtomic(data);
    log.debug(`Stored GitHub email for ${platformId}/${username}`);
  }

  /**
   * Remove the registration for a (platform, user) pair.
   * Returns true if there was something to remove.
   */
  delete(platformId: string, username: string): boolean {
    const data = this.loadRaw();
    if (!data.emails[platformId] || !(username in data.emails[platformId])) {
      return false;
    }
    delete data.emails[platformId][username];
    if (Object.keys(data.emails[platformId]).length === 0) {
      delete data.emails[platformId];
    }
    this.writeAtomic(data);
    log.debug(`Removed GitHub email for ${platformId}/${username}`);
    return true;
  }

  /** See SessionStore.lastReadDegraded — same read-then-write-wipe guard. */
  private lastReadDegraded = false;

  private loadRaw(): FileShape {
    if (!existsSync(this.file)) {
      this.lastReadDegraded = false;
      return { version: STORE_VERSION, emails: {} };
    }
    try {
      const raw = readFileSync(this.file, 'utf-8');
      if (raw.trim() === '') {
        // Empty/whitespace file: provably nothing to lose — writable empty
        // store, NOT a degraded read (which would block writes forever).
        this.lastReadDegraded = false;
        return { version: STORE_VERSION, emails: {} };
      }
      const parsed = yaml.load(raw) as Partial<FileShape> | undefined;
      if (!parsed || typeof parsed !== 'object') {
        this.lastReadDegraded = true;
        return { version: STORE_VERSION, emails: {} };
      }
      // Missing/null emails key: provably nothing to lose — writable empty
      // store. A wrong-typed value degrades reads AND refuses writes.
      const missing = parsed.emails === undefined || parsed.emails === null;
      const valid = !missing && typeof parsed.emails === 'object';
      this.lastReadDegraded = !missing && !valid;
      const emails = valid
        ? parsed.emails as Record<string, Record<string, string>>
        : {};
      return { version: parsed.version ?? STORE_VERSION, emails };
    } catch (err) {
      log.warn(`Failed to read ${this.file}: ${(err as Error).message} — reads degrade to empty`);
      this.lastReadDegraded = true;
      return { version: STORE_VERSION, emails: {} };
    }
  }

  /**
   * Refuses (logs, no throw) when the data descends from a degraded read of
   * an existing file — writing the degraded empty view would destroy every
   * platform's stored emails. Mirrors SessionStore.writeAtomic.
   */
  private writeAtomic(data: FileShape): void {
    if (this.lastReadDegraded) {
      log.error(`Refusing to write ${this.file}: the last read of the existing file was degraded — writing would destroy stored emails`);
      return;
    }
    writeFileAtomic(this.file, yaml.dump(data, { sortKeys: true, lineWidth: -1 }));
  }
}
