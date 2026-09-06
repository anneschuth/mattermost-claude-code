import { WebSocket } from '../../utils/websocket.js';
import type { MattermostPlatformConfig } from '../../config/index.js';
import { wsLogger, createLogger } from '../../utils/logger.js';
import { formatShortId } from '../../utils/format.js';
import { escapeRegExp, formatWebSocketError, resolvePostThreadId, isDcmThreadId, normalizeAckReaction, resolveDirectChannelMode, type ResolvedDirectChannelMode, type ApprovalsMode } from '../utils.js';
import { BasePlatformClient } from '../base-client.js';
import { sanitizeFilename } from '../../utils/safe-filename.js';
import { uploadFileMattermost } from './upload.js';

const log = createLogger('mattermost');
import type {
  MattermostWebSocketEvent,
  MattermostPost,
  MattermostUser,
  MattermostReaction,
  PostedEventData,
  ReactionAddedEventData,
  CreatePostRequest,
  UpdatePostRequest,
  MattermostFile,
} from './types.js';
import type {
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
  ThreadMessage,
  PostWriteOptions,
} from '../index.js';
import type { PlatformFormatter } from '../formatter.js';
import { MattermostFormatter } from './formatter.js';

export class MattermostClient extends BasePlatformClient {
  // Platform identity (required by PlatformClient)
  readonly platformId: string;
  readonly platformType = 'mattermost' as const;
  readonly displayName: string;
  readonly directChannelMode: ResolvedDirectChannelMode;
  readonly approvals?: ApprovalsMode;
  readonly ackReaction?: boolean | string;

  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private channelId: string;
  private directMessages: boolean;
  private outboundFiles?: { enabled?: boolean; maxBytes?: number };
  private userCache: Map<string, MattermostUser> = new Map();
  private botUserId: string | null = null;
  private readonly formatter = new MattermostFormatter();

  // Track last processed post for message recovery after disconnection
  private lastProcessedPostId: string | null = null;

  constructor(platformConfig: MattermostPlatformConfig) {
    super();
    this.platformId = platformConfig.id;
    this.displayName = platformConfig.displayName;
    this.url = platformConfig.url;
    this.token = platformConfig.token;
    this.channelId = platformConfig.channelId;
    this.directMessages = platformConfig.directMessages ?? false;
    this.botName = platformConfig.botName;
    this.allowedUsers = platformConfig.allowedUsers;
    this.outboundFiles = platformConfig.outboundFiles;
    this.directChannelMode = resolveDirectChannelMode(platformConfig.directChannelMode);
    this.approvals = platformConfig.approvals;
    this.ackReaction = normalizeAckReaction(platformConfig.ackReaction, `platforms[${platformConfig.id}].ackReaction`);
  }

  // ============================================================================
  // Type Normalization (Mattermost → Platform)
  // ============================================================================

  private normalizePlatformUser(mattermostUser: MattermostUser): PlatformUser {
    // Build display name from first_name, nickname, or username
    const displayName = mattermostUser.first_name
      || mattermostUser.nickname
      || mattermostUser.username;

    return {
      id: mattermostUser.id,
      username: mattermostUser.username,
      displayName,
      email: mattermostUser.email,
    };
  }

  private normalizePlatformPost(mattermostPost: MattermostPost): PlatformPost {
    // Normalize metadata.files if present
    const metadata: { files?: PlatformFile[]; [key: string]: unknown } | undefined =
      mattermostPost.metadata
        ? {
            ...mattermostPost.metadata,
            files: mattermostPost.metadata.files?.map((f: MattermostFile) => this.normalizePlatformFile(f)),
          }
        : undefined;

    return {
      id: mattermostPost.id,
      platformId: this.platformId,
      channelId: mattermostPost.channel_id,
      userId: mattermostPost.user_id,
      message: mattermostPost.message,
      rootId: mattermostPost.root_id,
      createAt: mattermostPost.create_at,
      metadata,
    };
  }

  private normalizePlatformReaction(mattermostReaction: MattermostReaction): PlatformReaction {
    return {
      userId: mattermostReaction.user_id,
      postId: mattermostReaction.post_id,
      emojiName: mattermostReaction.emoji_name,
      createAt: mattermostReaction.create_at,
    };
  }

  private normalizePlatformFile(mattermostFile: MattermostFile): PlatformFile {
    return {
      id: mattermostFile.id,
      name: mattermostFile.name,
      size: mattermostFile.size,
      mimeType: mattermostFile.mime_type,
      extension: mattermostFile.extension,
    };
  }

  /**
   * Process a post from WebSocket and emit it as an event.
   * If the post has file_ids but no metadata.files, fetches file info from API.
   * This is needed because WebSocket events may not include full file metadata.
   */
  private async processAndEmitPost(post: MattermostPost): Promise<void> {
    await this.enrichFileMetadata(post);

    // Get user info and emit
    const user = await this.getUser(post.user_id);
    const normalizedPost = this.normalizePlatformPost(post);
    this.emit('message', normalizedPost, user);

    // Also emit channel_post for top-level posts (not thread replies)
    if (!post.root_id) {
      this.emit('channel_post', normalizedPost, user);
    }
  }

  /**
   * Fetch file metadata for a post when the WebSocket event carried only
   * file_ids (shared by regular posts and DM-discovery posts).
   */
  private async enrichFileMetadata(post: MattermostPost): Promise<void> {
    const fileIds = post.file_ids;
    const hasFileIds = fileIds && fileIds.length > 0;
    const hasFileMetadata = post.metadata?.files && post.metadata.files.length > 0;

    if (hasFileIds && !hasFileMetadata) {
      log.debug(`Post ${formatShortId(post.id)} has ${fileIds.length} file(s), fetching metadata`);
      try {
        // Fetch file info for each file_id
        const files: MattermostFile[] = [];
        for (const fileId of fileIds) {
          try {
            const file = await this.api<MattermostFile>('GET', `/files/${fileId}/info`);
            files.push(file);
          } catch (err) {
            log.warn(`Failed to fetch file info for ${fileId}: ${err}`);
          }
        }

        // Add the file metadata to the post
        if (files.length > 0) {
          post.metadata = {
            ...post.metadata,
            files,
          };
          log.debug(`Enriched post ${formatShortId(post.id)} with ${files.length} file(s)`);
        }
      } catch (err) {
        log.warn(`Failed to fetch file metadata for post ${formatShortId(post.id)}: ${err}`);
      }
    }
  }

  /** Resolve the sender and emit a 'direct_message' event (DM discovery). */
  private async emitDirectMessage(post: MattermostPost): Promise<void> {
    try {
      await this.enrichFileMetadata(post);
      const user = await this.getUser(post.user_id);
      this.emit('direct_message', this.normalizePlatformPost(post), user);
    } catch (err) {
      log.warn(`Failed to emit direct message: ${err}`);
    }
  }

  // Retry budget for transient 500s. The dominant case is the Mattermost
  // threads write race (duplicate key on threads_pkey / app.post.save.app_error)
  // that fires when several posts stream to the same thread under load. With
  // only 3 retries a heavy burst exhausts the budget and a post is dropped; we
  // saw integration runs draw 14-17 such 500s and break, while lighter bursts
  // recovered. More attempts plus a capped, jittered backoff ride out the
  // burst. The cap keeps total wait bounded (so retries never themselves cause
  // a test timeout), and the jitter de-correlates concurrent posts retrying in
  // lockstep — without it they re-collide on the same row lock every round.
  private readonly MAX_RETRIES = 6;
  private readonly RETRY_DELAY_MS = 500;
  private readonly RETRY_DELAY_CAP_MS = 2000;

  // REST API helper with retry logic for transient errors
  // Options:
  //   silent: array of status codes to not log warnings for (for expected failures)
  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
    retryCount = 0,
    options?: { silent?: number[] }
  ): Promise<T> {
    const url = `${this.url}/api/v4${path}`;
    log.debug(`API ${method} ${path}`);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();

      // Retry on 500 errors (transient server issues like app.post.save.app_error)
      // These can occur due to database contention under load
      if (response.status === 500 && retryCount < this.MAX_RETRIES) {
        const delay = this.retryDelayMs(retryCount);
        log.warn(`API ${method} ${path} failed with 500, retrying in ${delay}ms (attempt ${retryCount + 1}/${this.MAX_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.api<T>(method, path, body, retryCount + 1, options);
      }

      // Log at debug level for expected failures, warn for unexpected ones
      const isSilent = options?.silent?.includes(response.status);
      if (isSilent) {
        log.debug(`API ${method} ${path} failed: ${response.status} (expected)`);
      } else {
        log.warn(`API ${method} ${path} failed: ${response.status} ${text.substring(0, 100)}`);
      }
      throw new Error(`Mattermost API error ${response.status}: ${text}`);
    }

    log.debug(`API ${method} ${path} → ${response.status}`);
    return response.json() as Promise<T>;
  }

  /**
   * Backoff for the Nth retry (0-indexed): exponential growth, capped, with
   * equal jitter. Exposed for testing. Returns a value in
   * [ceil/2, ceil] where ceil = min(RETRY_DELAY_MS * 2^retryCount,
   * RETRY_DELAY_CAP_MS).
   *
   * Equal (not full) jitter keeps a guaranteed minimum spacing — a full-jitter
   * delay can land near 0 and immediately re-collide under a write storm — while
   * still decorrelating concurrent retries (several posts streaming to the same
   * thread) so they stop hitting the same row lock in lockstep each round. The
   * cap bounds total wait so a long retry chain can't itself trip a test
   * timeout.
   */
  retryDelayMs(retryCount: number): number {
    const ceil = Math.min(
      this.RETRY_DELAY_MS * Math.pow(2, retryCount),
      this.RETRY_DELAY_CAP_MS
    );
    const half = ceil / 2;
    return Math.floor(half + Math.random() * half);
  }

  // Get current bot user info
  async getBotUser(): Promise<PlatformUser> {
    const user = await this.api<MattermostUser>('GET', '/users/me');
    this.botUserId = user.id;
    return this.normalizePlatformUser(user);
  }

  // Get user by ID (cached)
  async getUser(userId: string): Promise<PlatformUser | null> {
    const cached = this.userCache.get(userId);
    if (cached) {
      log.debug(`User ${userId} found in cache: @${cached.username}`);
      return this.normalizePlatformUser(cached);
    }
    try {
      const user = await this.api<MattermostUser>('GET', `/users/${userId}`);
      this.userCache.set(userId, user);
      log.debug(`User ${userId} fetched: @${user.username}`);
      return this.normalizePlatformUser(user);
    } catch (err) {
      log.warn(`Failed to get user ${userId}: ${err}`);
      return null;
    }
  }

  // Get user by username
  async getUserByUsername(username: string): Promise<PlatformUser | null> {
    try {
      log.debug(`Looking up user by username: @${username}`);
      const user = await this.api<MattermostUser>('GET', `/users/username/${username}`);
      this.userCache.set(user.id, user);
      log.debug(`User @${username} found: ${user.id}`);
      return this.normalizePlatformUser(user);
    } catch (err) {
      log.warn(`User @${username} not found: ${err}`);
      return null;
    }
  }

  // Post a message
  // Note: Modern Mattermost clients (7.x+) render Unicode emoji natively.
  // We no longer convert to :shortcode: format as many shortcodes aren't
  // recognized by all Mattermost instances (e.g., :stopwatch:, :pause:).
  async createPost(
    message: string,
    threadId?: string
  ): Promise<PlatformPost> {
    const request: CreatePostRequest = {
      channel_id: this.channelId,
      message,
      // Only include root_id if it's a non-empty string (Mattermost rejects
      // empty string). A synthetic DCM thread id resolves to undefined — in
      // direct channel mode replies are top-level channel posts.
      root_id: resolvePostThreadId(threadId) || undefined,
    };
    const post = await this.api<MattermostPost>('POST', '/posts', request);
    return this.normalizePlatformPost(post);
  }

  // Update a message (for streaming updates)
  // Post metadata is a Slack concept; accepted here and dropped.
  async updatePost(postId: string, message: string, _options?: PostWriteOptions): Promise<PlatformPost> {
    const request: UpdatePostRequest = {
      id: postId,
      message,
    };
    const post = await this.api<MattermostPost>('PUT', `/posts/${postId}`, request);
    return this.normalizePlatformPost(post);
  }

  // Add a reaction to a post
  async addReaction(postId: string, emojiName: string): Promise<void> {
    log.debug(`Adding reaction :${emojiName}: to post ${postId.substring(0, 8)}`);
    await this.api('POST', '/reactions', {
      user_id: this.botUserId,
      post_id: postId,
      emoji_name: emojiName,
    });
  }

  // Remove a reaction from a post
  async removeReaction(postId: string, emojiName: string): Promise<void> {
    log.debug(`Removing reaction :${emojiName}: from post ${postId.substring(0, 8)}`);
    await this.api('DELETE', `/users/${this.botUserId}/posts/${postId}/reactions/${emojiName}`);
  }

  // Download a file attachment
  async downloadFile(fileId: string): Promise<Buffer> {
    log.debug(`Downloading file ${fileId}`);
    const url = `${this.url}/api/v4/files/${fileId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      log.warn(`Failed to download file ${fileId}: ${response.status}`);
      throw new Error(`Failed to download file ${fileId}: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    log.debug(`Downloaded file ${fileId}: ${arrayBuffer.byteLength} bytes`);
    return Buffer.from(arrayBuffer);
  }

  // Get file info (metadata)
  async getFileInfo(fileId: string): Promise<PlatformFile> {
    const file = await this.api<MattermostFile>('GET', `/files/${fileId}/info`);
    return this.normalizePlatformFile(file);
  }

  // Upload a file from disk and post it into a thread.
  async uploadFile(
    filePath: string,
    threadId: string,
    options?: { caption?: string; filename?: string },
  ): Promise<{ postId: string; fileId: string }> {
    const filename = sanitizeFilename(options?.filename ?? filePath);
    const result = await uploadFileMattermost({
      url: this.url,
      token: this.token,
      channelId: this.channelId,
      threadId,
      filePath,
      filename,
      caption: options?.caption,
    });
    return { postId: result.postId, fileId: result.fileId };
  }

  // Get a post by ID (used to verify thread still exists on resume)
  async getPost(postId: string): Promise<PlatformPost | null> {
    try {
      log.debug(`Fetching post ${postId.substring(0, 8)}`);
      const post = await this.api<MattermostPost>('GET', `/posts/${postId}`);
      return this.normalizePlatformPost(post);
    } catch (err) {
      log.debug(`Post ${postId.substring(0, 8)} not found: ${err}`);
      return null; // Post doesn't exist or was deleted
    }
  }

  // Delete a post
  async deletePost(postId: string): Promise<void> {
    log.debug(`Deleting post ${postId.substring(0, 8)}`);
    await this.api('DELETE', `/posts/${postId}`);
  }

  // Pin a post to the channel
  async pinPost(postId: string): Promise<void> {
    log.debug(`Pinning post ${postId.substring(0, 8)}`);
    await this.api('POST', `/posts/${postId}/pin`);
  }

  // Unpin a post from the channel
  // Silently handles 403/404 errors - these are expected when the bot
  // doesn't have permission to unpin posts, the post was never pinned, or the post is deleted
  async unpinPost(postId: string): Promise<void> {
    log.debug(`Unpinning post ${postId.substring(0, 8)}`);
    try {
      // Use silent option to suppress warning logs for expected failures
      await this.api('POST', `/posts/${postId}/unpin`, undefined, 0, { silent: [403, 404] });
    } catch (err) {
      // Swallow 403/404 errors - these are expected when:
      // - Bot doesn't have unpin permission
      // - Post was never pinned
      // - Post was deleted
      if (err instanceof Error && (err.message.includes('403') || err.message.includes('404'))) {
        return;
      }
      throw err;
    }
  }

  // Get all pinned posts in the channel
  async getPinnedPosts(): Promise<string[]> {
    const response = await this.api<{ order: string[]; posts: Record<string, unknown> }>(
      'GET',
      `/channels/${this.channelId}/pinned`
    );
    return response.order || [];
  }

  // Get platform-specific message size limits
  getMessageLimits(): { maxLength: number; hardThreshold: number } {
    return { maxLength: 16000, hardThreshold: 14000 };
  }

  // Get thread history for context retrieval
  async getThreadHistory(
    threadId: string,
    options?: { limit?: number; excludeBotMessages?: boolean }
  ): Promise<ThreadMessage[]> {
    try {
      // Mattermost API: GET /posts/{post_id}/thread
      const response = await this.api<{
        order: string[];
        posts: Record<string, MattermostPost>;
      }>('GET', `/posts/${threadId}/thread`);

      // Filter + sort + trim BEFORE resolving usernames: no user lookups
      // (potential API calls) for messages the limit drops anyway.
      const posts = response.order
        .map((postId) => response.posts[postId])
        .filter((post): post is MattermostPost => !!post)
        .filter((post) => !(options?.excludeBotMessages && post.user_id === this.botUserId))
        .sort((a, b) => a.create_at - b.create_at);
      const kept = options?.limit && posts.length > options.limit
        ? posts.slice(-options.limit)
        : posts;

      const messages: ThreadMessage[] = [];
      for (const post of kept) {
        const user = await this.getUser(post.user_id);
        messages.push({
          id: post.id,
          userId: post.user_id,
          username: user?.username || 'unknown',
          message: post.message,
          createAt: post.create_at,
        });
      }
      return messages;
    } catch (err) {
      log.warn(`Failed to get thread history for ${threadId}: ${err}`);
      return [];
    }
  }

  /**
   * Get channel posts created after a specific post ID.
   * Used for recovering missed messages after a disconnection.
   *
   * Note: Uses 'after' parameter instead of 'since' timestamp because
   * the 'since' parameter has known issues with missing posts.
   * See: https://github.com/mattermost/mattermost/issues/13846
   */
  async getChannelPostsAfter(afterPostId: string): Promise<PlatformPost[]> {
    try {
      const response = await this.api<{
        order: string[];
        posts: Record<string, MattermostPost>;
      }>('GET', `/channels/${this.channelId}/posts?after=${afterPostId}&per_page=100`);

      const posts: PlatformPost[] = [];
      for (const postId of response.order) {
        const post = response.posts[postId];
        if (!post) continue;

        // Skip bot's own messages
        if (post.user_id === this.botUserId) continue;

        posts.push(this.normalizePlatformPost(post));
      }

      // Sort by createAt (oldest first) so they're processed in order
      posts.sort((a, b) => (a.createAt ?? 0) - (b.createAt ?? 0));

      return posts;
    } catch (err) {
      log.warn(`Failed to get channel posts after ${afterPostId}: ${err}`);
      return [];
    }
  }

  // Connect to WebSocket
  async connect(): Promise<void> {
    // Get bot user first
    await this.getBotUser();
    // A disconnect() issued while we awaited must win: without this check a
    // torn-down client would resume here and open a websocket nobody owns.
    if (this.isIntentionalDisconnect) {
      wsLogger.debug('connect() aborted: client was disconnected while connecting');
      return;
    }
    wsLogger.debug(`Bot user ID: ${this.botUserId}`);

    const wsUrl = this.url
      .replace(/^http/, 'ws')
      .concat('/api/v4/websocket');

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        wsLogger.info('WebSocket connected, sending auth challenge');
        // Authenticate
        if (this.ws) {
          this.ws.send(
            JSON.stringify({
              seq: 1,
              action: 'authentication_challenge',
              data: { token: this.token },
            })
          );
          wsLogger.debug('Auth challenge sent');
        }
      };

      this.ws.onmessage = (event) => {
        this.updateLastMessageTime(); // Track activity for heartbeat
        try {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          const wsEvent = JSON.parse(data) as MattermostWebSocketEvent;
          this.handleEvent(wsEvent);

          // Authentication success
          if (wsEvent.event === 'hello') {
            this.onConnectionEstablished();
            resolve();
          }
        } catch (err) {
          wsLogger.warn(`Failed to parse message: ${err}`);
        }
      };

      this.ws.onclose = (event) => {
        wsLogger.info(`WebSocket disconnected (code: ${event.code}, reason: ${event.reason || 'none'}, clean: ${event.wasClean})`);
        this.onConnectionClosed();
      };

      this.ws.onerror = (event) => {
        const msg = formatWebSocketError(event);
        wsLogger.warn(`WebSocket error: ${msg}`);
        this.emit('error', new Error(`WebSocket error: ${msg}`));
        reject(new Error(`WebSocket error: ${msg}`));
      };
    });
  }

  private handleEvent(event: MattermostWebSocketEvent): void {
    // Handle posted events
    if (event.event === 'posted') {
      const data = event.data as unknown as PostedEventData;
      if (!data.post) return;

      try {
        const post = JSON.parse(data.post) as MattermostPost;

        // Ignore messages from ourselves
        if (post.user_id === this.botUserId) return;

        // Only handle messages in our channel — except direct messages when
        // DM auto-discovery is on: those are surfaced as 'direct_message'
        // events so the bot can spawn a derived instance for the DM channel.
        if (post.channel_id !== this.channelId) {
          if (this.directMessages && data.channel_type === 'D') {
            void this.emitDirectMessage(post);
          }
          return;
        }

        // Track last processed post for message recovery after disconnection
        this.lastProcessedPostId = post.id;

        // Process the post (potentially enriching with file metadata)
        this.processAndEmitPost(post);
      } catch (err) {
        wsLogger.warn(`Failed to parse post: ${err}`);
      }
      return;
    }

    // Handle reaction_added events
    if (event.event === 'reaction_added') {
      const data = event.data as unknown as ReactionAddedEventData;
      if (!data.reaction) return;

      try {
        const reaction = JSON.parse(data.reaction) as MattermostReaction;

        // Ignore reactions from ourselves
        if (reaction.user_id === this.botUserId) return;

        // Get user info and emit (with normalized types)
        this.getUser(reaction.user_id).then((user) => {
          this.emit('reaction', this.normalizePlatformReaction(reaction), user);
        });
      } catch (err) {
        wsLogger.warn(`Failed to parse reaction: ${err}`);
      }
    }

    // Handle reaction_removed events
    if (event.event === 'reaction_removed') {
      const data = event.data as unknown as ReactionAddedEventData;
      if (!data.reaction) return;

      try {
        const reaction = JSON.parse(data.reaction) as MattermostReaction;

        // Ignore reactions from ourselves
        if (reaction.user_id === this.botUserId) return;

        // Get user info and emit (with normalized types)
        this.getUser(reaction.user_id).then((user) => {
          this.emit('reaction_removed', this.normalizePlatformReaction(reaction), user);
        });
      } catch (err) {
        wsLogger.warn(`Failed to parse reaction: ${err}`);
      }
    }
  }

  /**
   * Force close the WebSocket connection.
   * Cleans up listeners and ensures we start fresh on reconnection.
   * This is critical for recovery after long idle periods where the socket may be stale.
   *
   * Returns a Promise that resolves when the underlying socket has actually
   * closed (or after a 1s safety timeout). Production callers can fire-and-
   * forget; integration tests await it to avoid racing the next connect()
   * against a half-closed socket Mattermost still has bound to the same token.
   */
  protected forceCloseConnection(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    return this.closeSocket(ws);
  }

  /**
   * Recover messages that were posted while disconnected.
   * Fetches posts after the last processed post and re-emits them as events.
   */
  protected async recoverMissedMessages(): Promise<void> {
    if (!this.lastProcessedPostId) {
      return;
    }

    log.info(`Recovering missed messages after post ${this.lastProcessedPostId}...`);

    const missedPosts = await this.getChannelPostsAfter(this.lastProcessedPostId);

    if (missedPosts.length === 0) {
      log.info('No missed messages to recover');
      return;
    }

    log.info(`Recovered ${missedPosts.length} missed message(s)`);

    // Re-emit each missed post as if it just arrived
    for (const post of missedPosts) {
      // Update lastProcessedPostId as we process each post
      this.lastProcessedPostId = post.id;

      const user = await this.getUser(post.userId);
      this.emit('message', post, user);

      // Also emit channel_post for top-level posts (not thread replies)
      if (!post.rootId) {
        this.emit('channel_post', post, user);
      }
    }
  }

  // Check if message mentions the bot
  isBotMentioned(message: string): boolean {
    const botName = escapeRegExp(this.botName);
    // Match @botname at start or with space before
    const mentionPattern = new RegExp(`(^|\\s)@${botName}\\b`, 'i');
    return mentionPattern.test(message);
  }

  // Extract prompt from message (remove bot mention)
  extractPrompt(message: string): string {
    const botName = escapeRegExp(this.botName);
    return message
      .replace(new RegExp(`(^|\\s)@${botName}\\b`, 'gi'), ' ')
      .trim();
  }

  // Get MCP config for permission server
  getMcpConfig() {
    return {
      type: 'mattermost',
      url: this.url,
      token: this.token,
      channelId: this.channelId,
      allowedUsers: this.allowedUsers,
      outboundFiles: this.outboundFiles,
    };
  }

  // Get platform-specific markdown formatter
  getFormatter(): PlatformFormatter {
    return this.formatter;
  }

  // Get a clickable link to a thread (full URL for cross-platform compatibility)
  // If lastMessageId is provided, links to that specific message (jump to bottom)
  getThreadLink(threadId: string, lastMessageId?: string, _lastMessageTs?: string): string {
    // Direct channel mode: the synthetic id is not a post id — link to the
    // last real message if known, otherwise to the channel.
    if (isDcmThreadId(threadId) && !lastMessageId) {
      return `${this.url}/channels/${this.channelId}`;
    }
    const targetId = lastMessageId || threadId;
    return `${this.url}/_redirect/pl/${targetId}`;
  }

  // Send typing indicator via WebSocket
  sendTyping(parentId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      wsLogger.debug('Cannot send typing: WebSocket not open');
      return;
    }

    this.ws.send(JSON.stringify({
      action: 'user_typing',
      seq: Date.now(),
      data: {
        channel_id: this.channelId,
        // A synthetic DCM thread id must not leak into the protocol — typing
        // in direct channel mode targets the channel root.
        parent_id: resolvePostThreadId(parentId) || '',
      },
    }));
  }

}
