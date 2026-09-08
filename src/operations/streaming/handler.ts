/**
 * Message streaming utilities
 *
 * Handles typing indicators and file attachments. File attachments are written
 * to a per-session directory under os.tmpdir(); Claude is given the absolute
 * path so it can Read or move/copy the file as needed.
 *
 * Content flushing is handled by MessageManager/ContentExecutor.
 */

import { createHash } from 'crypto';
import { hasStateHomeOverride, stateHome } from '../../utils/state-home.js';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { PlatformClient, PlatformFile } from '../../platform/index.js';
import type { Session } from '../../session/types.js';
import { isTranscribable, type Transcriber, type Transcript } from '../../transcription/index.js';
import { createLogger } from '../../utils/logger.js';
import { sanitizeFilename, dedupeFilename, formatBytes } from '../../utils/safe-filename.js';

const log = createLogger('streaming');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPLOAD_ROOT_DIR = 'claude-threads-uploads';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A file we successfully wrote to disk. */
export interface SavedFile {
  /** The original filename as the user uploaded it. */
  originalName: string;
  /** Absolute path on disk where the file was written. */
  absolutePath: string;
  /** Reported MIME type from the platform. */
  mimeType: string;
  /** Size in bytes. */
  size: number;
}

/** A file we couldn't process; surfaced to the user. */
export interface SkippedFile {
  name: string;
  reason: string;
  suggestion?: string;
}

/** Result of building message content for Claude. */
export interface BuiltMessageContent {
  /** Text payload to send to Claude (may include a header listing saved files). */
  content: string;
  /** Files that could not be saved — callers should surface these to the user. */
  skipped: SkippedFile[];
  /**
   * Transcripts of audio attachments (docs/audio-transcription-spec.md).
   * Present only when a transcriber ran; callers echo these into the thread
   * via postTranscriptFeedback() so everyone sees what Claude heard.
   */
  transcripts?: Transcript[];
}

// ---------------------------------------------------------------------------
// Per-session upload directory
// ---------------------------------------------------------------------------

/** Reduce an id to a single path-safe segment so it can't escape uploadDir. */
function safeIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Returns the per-thread upload directory path. The directory is keyed by the
 * composite (platformId, threadId) so it survives session resume — a resumed
 * session writes new uploads to the same place its previous incarnation did.
 */
export function getSessionUploadDir(platformId: string, threadId: string): string {
  return join(tmpdir(), UPLOAD_ROOT_DIR, `${instancePrefix()}${safeIdSegment(platformId)}-${safeIdSegment(threadId)}`);
}

/**
 * Two bot instances (CLAUDE_THREADS_HOME) may share platform and thread ids
 * — DCM sessions use the platform id as thread id — so an overriding
 * instance also keys its uploads by the state home, or one bot's cleanup
 * would delete the other's files. The default instance keeps the historical
 * path, so sessions persisted before this change still find their uploads.
 * The hash is a prefix of the leaf name, not a directory of its own, so the
 * result stays a single segment under the uploads root.
 */
function instancePrefix(): string {
  if (!hasStateHomeOverride()) return '';
  return createHash('sha1').update(stateHome()).digest('hex').slice(0, 12) + '-';
}

/**
 * Best-effort removal of the per-thread upload directory and its contents.
 * Called from session cleanup; never throws. Tolerant of partial Session
 * objects (test fixtures, early-failure paths) where ids may be missing.
 */
export async function cleanupSessionUploads(platformId: string, threadId: string): Promise<void> {
  if (!platformId || !threadId) return;
  const dir = getSessionUploadDir(platformId, threadId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    log.debug(`Upload cleanup for ${platformId}:${threadId} failed (ignored): ${err}`);
  }
}

// ---------------------------------------------------------------------------
// File saving
// ---------------------------------------------------------------------------

/** Strip control chars from a value we'll interpolate into Claude's prompt. */
function sanitizeForPrompt(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]/g, '');
}

/**
 * Download each file and write it to a fresh subdirectory under uploadDir.
 * Each call gets its own subdirectory so two messages uploading the same
 * filename don't collide.
 *
 * Inbound attachments are intentionally not size-capped (per issue #387):
 * a user pasting a large screenshot or sharing a big asset should never have
 * it silently dropped. Tradeoff: platform.downloadFile() buffers the whole
 * file in memory via arrayBuffer(), so a very large attachment is held in RAM
 * for the duration of the write. Left as-is here; streaming the download is a
 * separate change.
 */
export async function saveFilesToUploadDir(
  platform: PlatformClient,
  uploadDir: string,
  files: PlatformFile[],
  debug: boolean = false,
): Promise<{ saved: SavedFile[]; skipped: SkippedFile[] }> {
  const saved: SavedFile[] = [];
  const skipped: SkippedFile[] = [];

  if (!platform.downloadFile) {
    for (const file of files) {
      skipped.push({ name: file.name, reason: 'Platform does not support file downloads' });
    }
    return { saved, skipped };
  }

  // Refuse to write into a symlinked upload dir — a local attacker on a
  // shared host could otherwise pre-create the (predictable) per-thread path
  // as a symlink to a sensitive directory and have the bot write attacker-
  // controlled bytes into it. mkdtemp + 'wx' close most of the race window;
  // the lstat check closes the rest.
  await mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(uploadDir);
  if (stat.isSymbolicLink()) {
    for (const file of files) {
      skipped.push({ name: file.name, reason: 'Refusing to write under symlinked upload directory' });
    }
    log.error(`Upload dir is a symlink, refusing all writes: ${uploadDir}`);
    return { saved, skipped };
  }

  // mkdtemp gives us an atomically-created leaf with a random suffix —
  // collisions between concurrent messages are impossible.
  const messageDir = await mkdtemp(join(uploadDir, `${Date.now().toString(36)}-`));

  // Filenames used within this single call, so multiple identically-named
  // attachments (e.g. several clipboard pastes that all arrive as `image.png`)
  // get distinct on-disk names instead of colliding on the 'wx' write below.
  const usedNames = new Set<string>();

  for (const file of files) {
    try {
      const buffer = await platform.downloadFile(file.id);
      // Resolve a unique name BEFORE writing so the 'wx' flag stays meaningful
      // for symlink-race protection rather than tripping on our own dupes.
      const safeName = dedupeFilename(sanitizeFilename(file.name), usedNames);
      const absolutePath = join(messageDir, safeName);
      // 'wx' = O_CREAT | O_EXCL: fail rather than follow a pre-existing
      // symlink at the target. Together with the per-message mkdtemp this
      // closes the symlink race even if uploadDir was racy before lstat.
      await writeFile(absolutePath, buffer, { mode: 0o600, flag: 'wx' });
      saved.push({
        originalName: file.name,
        absolutePath,
        mimeType: file.mimeType,
        size: buffer.length,
      });
      if (debug) {
        log.debug(`Saved ${file.name} → ${absolutePath} (${formatBytes(buffer.length)})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to save uploaded file ${file.name}: ${message}`);
      skipped.push({
        name: file.name,
        reason: `Download failed: ${message}`,
      });
    }
  }

  return { saved, skipped };
}

// ---------------------------------------------------------------------------
// Message content building
// ---------------------------------------------------------------------------

const FILE_LIST_HEADER = '[Attached files from chat — saved to disk, use Read or move/copy as needed:]';

/**
 * Build the content string for a user message, writing any attachments to
 * the per-session upload directory and prepending a list of their absolute
 * paths so Claude can find them.
 *
 * Returns the content plus any files that were skipped, so callers can
 * surface a warning via postSkippedFilesFeedback().
 */
export async function buildMessageContent(
  text: string,
  platform: PlatformClient,
  uploadDir: string,
  files?: PlatformFile[],
  debug: boolean = false,
  transcriber?: Transcriber,
): Promise<BuiltMessageContent> {
  if (!files || files.length === 0) {
    return { content: text, skipped: [] };
  }

  const { saved, skipped } = await saveFilesToUploadDir(platform, uploadDir, files, debug);

  if (saved.length === 0) {
    return { content: text, skipped };
  }

  const fileLines = saved.map(
    f => `- ${f.absolutePath} (${sanitizeForPrompt(f.mimeType) || 'application/octet-stream'}, ${formatBytes(f.size)})`,
  );
  const header = `${FILE_LIST_HEADER}\n${fileLines.join('\n')}`;

  const transcripts = transcriber ? await transcribeAudio(transcriber, saved, skipped) : [];
  const transcriptBlocks = transcripts.map(
    t => `[Transcript of ${sanitizeForPrompt(t.name)} (${t.provider}):]\n${sanitizeTranscript(t.text)}`,
  );

  const parts = [header, ...transcriptBlocks];
  if (text.trim().length > 0) parts.push(text);

  return { content: parts.join('\n\n'), skipped, transcripts };
}

/**
 * Transcribe a post's audio attachments WITHOUT building a prompt.
 *
 * The watch evaluator runs on the one path where the bot has decided to
 * ignore a message, so `buildMessageContent` never sees it — and a voice note
 * would reach the evaluator as an empty string with a file beside it. A
 * channel watching for "deploy" would not fire on someone saying "deploy" out
 * loud, which is precisely the difference between a transcript being a real
 * input and being a courtesy for the human reader.
 *
 * No duplicate vendor call, for two separate reasons — the second matters
 * because the first is easy to misread:
 *
 * 1. This runs only where the bot ignores the message, so
 *    `buildMessageContent` is never reached for that post.
 * 2. If a watch then FIRES, the session it starts is not a replay of the
 *    post: `src/watches/runner.ts` builds its own prompt and passes no files
 *    at all, so `buildMessageContent` returns at its empty-files guard. The
 *    audio is sent to the vendor exactly once even on the path where the
 *    transcript did something.
 */
export async function transcribeForEvaluation(
  transcriber: Transcriber,
  platform: PlatformClient,
  uploadDir: string,
  files: PlatformFile[],
): Promise<string> {
  const audio = files.filter((f) => isTranscribable(f.mimeType ?? '', f.name ?? ''));
  if (audio.length === 0) return '';

  const { saved, skipped } = await saveFilesToUploadDir(platform, uploadDir, audio, false);
  if (saved.length === 0) return '';

  try {
    const transcripts = await transcribeAudio(transcriber, saved, skipped);
    return transcripts.map((t) => t.text).join('\n');
  } finally {
    // ⚠️ Delete what we downloaded, always. Uploads are normally reaped when
    // the session that owns them ends — but this path runs where the bot
    // IGNORES the message, so most of the time no session is ever created and
    // nothing would ever reap them. Every ignored voice note in a busy channel
    // would otherwise stay on disk forever.
    await Promise.all(
      saved.map((f) =>
        rm(f.absolutePath, { force: true }).catch((err: unknown) =>
          log.debug(`Could not remove evaluation upload ${f.absolutePath}: ${String(err)}`),
        ),
      ),
    );
  }
}

/**
 * Run the transcriber over every saved audio file, in order. A failure is
 * appended to `skipped` (so the user sees it) and does not stop the message —
 * the file itself is still listed in the prompt.
 */
async function transcribeAudio(
  transcriber: Transcriber,
  saved: SavedFile[],
  skipped: SkippedFile[],
): Promise<Transcript[]> {
  const transcripts: Transcript[] = [];
  for (const file of saved) {
    if (!isTranscribable(file.mimeType, file.originalName)) continue;
    try {
      const text = await transcriber.transcribe({
        path: file.absolutePath,
        mimeType: file.mimeType,
        name: file.originalName,
      });
      transcripts.push({ name: file.originalName, provider: transcriber.provider, text });
      log.info(`Transcribed ${file.originalName} via ${transcriber.provider} (${text.length} chars)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Transcription of ${file.originalName} failed: ${message}`);
      skipped.push({
        name: file.originalName,
        reason: `Transcription failed: ${message}`,
        suggestion: 'The audio file itself was still handed to Claude',
      });
    }
  }
  return transcripts;
}

/** Keep newlines (speech has pauses) but drop other control characters. */
function sanitizeTranscript(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
}

/**
 * Echo each transcript into the thread as a quote so teammates (and the
 * audit trail) see what Claude heard. No-op for an empty list.
 */
export async function postTranscriptFeedback(
  platform: PlatformClient,
  threadId: string,
  transcripts: Transcript[] | undefined,
): Promise<void> {
  if (!transcripts || transcripts.length === 0) return;
  const formatter = platform.getFormatter();
  for (const t of transcripts) {
    const quoted = t.text.split('\n').map(line => formatter.formatBlockquote(line)).join('\n');
    await platform.createPost(`🎙️ ${formatter.formatBold(`Transcript of ${t.name}:`)}\n${quoted}`, threadId);
  }
}

/**
 * Post a skipped-files warning to the thread, if any.
 * No-op when skipped is empty, so callers can invoke unconditionally.
 */
export async function postSkippedFilesFeedback(
  platform: PlatformClient,
  threadId: string,
  skipped: SkippedFile[],
): Promise<void> {
  if (skipped.length === 0) return;
  await platform.createPost(formatSkippedFilesFeedback(skipped), threadId);
}

/**
 * Format a user-facing feedback message for skipped files.
 */
export function formatSkippedFilesFeedback(skippedFiles: SkippedFile[]): string {
  const lines = ['⚠️ **Some files could not be processed:**'];
  for (const file of skippedFiles) {
    let line = `- **${file.name}**: ${file.reason}`;
    if (file.suggestion) {
      line += ` _(${file.suggestion})_`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Typing indicators
// ---------------------------------------------------------------------------

/**
 * Start sending typing indicators to the platform.
 * Sends immediately, then every 3 seconds until stopped.
 */
export function startTyping(session: Session): void {
  if (session.timers.typingTimer) return;
  session.platform.sendTyping(session.threadId);
  session.timers.typingTimer = setInterval(() => {
    session.platform.sendTyping(session.threadId);
  }, 3000);
}

/**
 * Stop sending typing indicators.
 */
export function stopTyping(session: Session): void {
  if (!session.timers.typingTimer) return;

  clearInterval(session.timers.typingTimer);
  session.timers.typingTimer = null;
  // The timer was only ever half of it: an indicator that persists until
  // replaced has to be taken down explicitly.
  session.platform.clearTyping(session.threadId);
}
