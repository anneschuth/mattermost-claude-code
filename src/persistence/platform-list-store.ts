/**
 * PlatformListStore — shared base for the small per-platform YAML list
 * stores (routines, watches): a versioned file holding
 * `Record<platformId, T[]>`, 0600 atomic writes, and an in-process write
 * mutex. platformId is the hard privacy boundary (≈ one channel), mirroring
 * the memory store.
 *
 * Subclasses own their domain: the `add` validation, the narrowed `update`
 * patch type, and any defensive per-item defaults (`applyItemDefaults`).
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { stateHome } from '../utils/state-home.js';
import { join } from 'path';
import yaml from 'js-yaml';
import { SerialQueue, writeFileAtomic } from './atomic-file.js';

export const STORES_CONFIG_DIR = join(stateHome(), '.config', 'claude-threads');

const STORE_VERSION = 1;

interface FileShape<T> {
  version: number;
  items: Record<string, T[]>;
}

export abstract class PlatformListStore<T extends { id: string }> {
  protected readonly file: string;
  private readonly configDir: string;
  /** In-process write mutex (single bot process owns the file). */
  private readonly queue = new SerialQueue();
  /** Top-level YAML key the platform map lives under (e.g. "routines"). */
  private readonly collectionKey: string;
  /**
   * mtime-keyed read cache: list() sits on hot paths (every channel message
   * for watches, every scheduler tick for routines), and re-parsing YAML per
   * call would put blocking parse work on the event loop. A stat() per read
   * still detects out-of-band writes (another store instance, hand edits).
   */
  private cache: { mtimeMs: number; size: number; data: FileShape<T> } | null = null;

  protected constructor(collectionKey: string, defaultFile: string, filePath?: string) {
    this.collectionKey = collectionKey;
    if (filePath) {
      this.file = filePath;
      this.configDir = join(filePath, '..');
    } else {
      this.file = defaultFile;
      this.configDir = STORES_CONFIG_DIR;
    }
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
  }

  /** Defensive defaults applied to every loaded item (forward/backward compat). */
  protected abstract applyItemDefaults(item: T): void;

  /** Read-failure log hook (subclasses own their logger/component name). */
  protected abstract warn(message: string): void;

  /**
   * List a platform's items. Returns a deep copy — the cached graph is the
   * store's source of truth between writes, so handing out live references
   * would let callers corrupt it (a mutation would stick in memory without
   * ever being persisted) and would let a concurrent remove() splice an
   * array out from under an iterating caller.
   */
  list(platformId: string): T[] {
    return structuredClone(this.loadRaw().items[platformId] ?? []);
  }

  get(platformId: string, id: string): T | undefined {
    // Same no-live-reference invariant as list(), but clone only the hit.
    const item = (this.loadRaw().items[platformId] ?? []).find((i) => i.id === id);
    return item === undefined ? undefined : structuredClone(item);
  }

  /**
   * Shared skeleton for subclass `add` implementations: validation (via
   * `build`, which returns the fully-validated item or an error string),
   * cap check, insert, atomic write, and a no-live-reference return — all
   * inside the write mutex.
   */
  protected addItem(
    platformId: string,
    max: number,
    capNoun: string,
    build: () => T | string,
  ): Promise<{ ok: true; item: T } | { ok: false; error: string }> {
    return this.runExclusive(() => {
      const built = build();
      if (typeof built === 'string') return { ok: false as const, error: built };
      const data = this.loadRaw(true);
      const existing = data.items[platformId] ?? [];
      if (existing.length >= max) {
        return { ok: false as const, error: `${capNoun} limit reached (${max}); delete one first` };
      }
      data.items[platformId] = [...existing, built];
      this.writeAtomic(data);
      // Copy: `built` is now part of the cached graph.
      return { ok: true as const, item: structuredClone(built) };
    });
  }

  /** Merge a partial update into one item. Returns a copy of the updated item or undefined. */
  update(platformId: string, id: string, patch: Partial<T>): Promise<T | undefined> {
    return this.runExclusive(() => {
      const data = this.loadRaw(true);
      const items = data.items[platformId] ?? [];
      const idx = items.findIndex((item) => item.id === id);
      if (idx < 0) return undefined;
      items[idx] = { ...items[idx], ...patch };
      this.writeAtomic(data);
      return structuredClone(items[idx]);
    });
  }

  /** Remove an item. Returns the removed item or undefined. */
  remove(platformId: string, id: string): Promise<T | undefined> {
    return this.runExclusive(() => {
      const data = this.loadRaw(true);
      const items = data.items[platformId] ?? [];
      const idx = items.findIndex((item) => item.id === id);
      if (idx < 0) return undefined;
      const [removed] = items.splice(idx, 1);
      if (items.length === 0) delete data.items[platformId];
      this.writeAtomic(data);
      this.onRemoved(platformId, removed);
      return removed;
    });
  }

  /** Post-remove log hook. */
  protected onRemoved(_platformId: string, _item: T): void {}

  // -- protected plumbing for subclass `add` implementations ------------------

  protected runExclusive<R>(fn: () => R): Promise<R> {
    return this.queue.run(fn);
  }

  /**
   * Load the file. A missing file is an empty store. A file that EXISTS but
   * cannot be read (corruption, transient EMFILE/EACCES) reads as empty too
   * — but with `forWrite` the failure throws instead: a mutating op that
   * proceeded on that emptiness would persist it, silently destroying every
   * platform's items. Refusing the write keeps the unreadable file on disk
   * for recovery.
   */
  protected loadRaw(forWrite = false): FileShape<T> {
    if (!existsSync(this.file)) {
      this.cache = null;
      return { version: STORE_VERSION, items: {} };
    }
    try {
      const stat = statSync(this.file);
      if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
        return this.cache.data;
      }
      const raw = readFileSync(this.file, 'utf-8');
      if (raw.trim() === '') {
        // Empty/whitespace file: provably nothing to lose — a writable empty
        // store, never the write-refusing "unreadable" case below (which
        // would leave the store permanently read-only).
        const data = { version: STORE_VERSION, items: {} as Record<string, T[]> };
        this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
        return data;
      }
      const parsed = yaml.load(raw) as Record<string, unknown> | undefined;
      const rawItems = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed[this.collectionKey]
        : undefined;
      // A file that parses but has the wrong shape (scalar where the map
      // should be, renamed/missing top-level key, truncated to nothing) is
      // as unreadable as a parse error: reads degrade to empty, but a WRITE
      // proceeding on that emptiness would atomically replace the file and
      // destroy whatever the malformed content still holds — same refusal
      // as the catch below. A null value for the key (hand-emptied
      // `watches:`) is a legitimate empty map, not malformation.
      if (rawItems !== null && (rawItems === undefined || typeof rawItems !== 'object' || Array.isArray(rawItems))) {
        this.cache = null;
        const problem = `unexpected shape (missing or non-map '${this.collectionKey}' key)`;
        if (forWrite) {
          throw new Error(`refusing to write over unreadable ${this.file}: ${problem}`);
        }
        this.warn(`Failed to read ${this.file}: ${problem} — starting empty`);
        return { version: STORE_VERSION, items: {} };
      }
      const items = (rawItems ?? {}) as Record<string, T[]>;
      for (const list of Object.values(items)) {
        for (const item of list) this.applyItemDefaults(item);
      }
      const data = { version: (parsed?.version as number | undefined) ?? STORE_VERSION, items };
      this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
      return data;
    } catch (err) {
      this.cache = null;
      if (forWrite) {
        throw new Error(`refusing to write over unreadable ${this.file}: ${(err as Error).message}`, { cause: err });
      }
      this.warn(`Failed to read ${this.file}: ${(err as Error).message} — starting empty`);
      return { version: STORE_VERSION, items: {} };
    }
  }

  protected writeAtomic(data: FileShape<T>): void {
    try {
      this.persistFile(yaml.dump({ version: data.version, [this.collectionKey]: data.items }, { sortKeys: true, lineWidth: -1 }));
    } catch (err) {
      // `data` IS the cached object graph, already mutated by the caller,
      // while the file still holds the old state (atomic write: the target
      // is untouched on failure) — so its mtime/size still match the cache
      // key. Without invalidation every later read would serve the phantom
      // mutation until restart, diverging from what the user was told
      // (e.g. "could not save watch" — yet the watch lists and fires).
      this.cache = null;
      throw err;
    }
    // The written object graph is what loadRaw would parse back; caching it
    // directly avoids an immediate re-read. mtime/size from the fresh stat.
    try {
      const stat = statSync(this.file);
      this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    } catch {
      this.cache = null;
    }
  }

  /** The actual disk write, separated so tests can inject write failures. */
  protected persistFile(content: string): void {
    writeFileAtomic(this.file, content);
  }
}
