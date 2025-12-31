// Native WebSocket - no import needed in Bun
import { EventEmitter } from 'events';
import type { MattermostPlatformConfig } from '../../config/migration.js';
import { wsLogger } from '../../utils/logger.js';
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
  PlatformClient,
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
  ThreadMessage,
} from '../index.js';
import type { PlatformFormatter } from '../formatter.js';
import { MattermostFormatter } from './formatter.js';

// Escape special regex characters to prevent regex injection
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class MattermostClient extends EventEmitter implements PlatformClient {
  // Platform identity (required by PlatformClient)
  readonly platformId: string;
  readonly platformType = 'mattermost' as const;
  readonly displayName: string;

  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private channelId: string;
  private botName: string;
  private allowedUsers: string[];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private userCache: Map<string, MattermostUser> = new Map();
  private botUserId: string | null = null;
  private readonly formatter = new MattermostFormatter();

  // Heartbeat to detect dead connections (using regular messages since browser WebSocket has no ping/pong)
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = Date.now();
  private readonly HEARTBEAT_INTERVAL_MS = 30000; // Check every 30s
  private readonly HEARTBEAT_TIMEOUT_MS = 60000; // Reconnect if no message for 60s

  constructor(platformConfig: MattermostPlatformConfig) {
    super();
    this.platformId = platformConfig.id;
    this.displayName = platformConfig.displayName;
    this.url = platformConfig.url;
    this.token = platformConfig.token;
    this.channelId = platformConfig.channelId;
    this.botName = platformConfig.botName;
    this.allowedUsers = platformConfig.allowedUsers;
  }

  // ============================================================================
  // Type Normalization (Mattermost → Platform)
  // ============================================================================

  private normalizePlatformUser(mattermostUser: MattermostUser): PlatformUser {
    return {
      id: mattermostUser.id,
      username: mattermostUser.username,
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

  // REST API helper
  private async api<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.url}/api/v4${path}`;
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
      throw new Error(`Mattermost API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
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
      return this.normalizePlatformUser(cached);
    }
    try {
      const user = await this.api<MattermostUser>('GET', `/users/${userId}`);
      this.userCache.set(userId, user);
      return this.normalizePlatformUser(user);
    } catch {
      return null;
    }
  }

  // Post a message
  async createPost(
    message: string,
    threadId?: string
  ): Promise<PlatformPost> {
    const request: CreatePostRequest = {
      channel_id: this.channelId,
      message,
      root_id: threadId,
    };
    const post = await this.api<MattermostPost>('POST', '/posts', request);
    return this.normalizePlatformPost(post);
  }

  // Update a message (for streaming updates)
  async updatePost(postId: string, message: string): Promise<PlatformPost> {
    const request: UpdatePostRequest = {
      id: postId,
      message,
    };
    const post = await this.api<MattermostPost>('PUT', `/posts/${postId}`, request);
    return this.normalizePlatformPost(post);
  }

  // Add a reaction to a post
  async addReaction(postId: string, emojiName: string): Promise<void> {
    await this.api('POST', '/reactions', {
      user_id: this.botUserId,
      post_id: postId,
      emoji_name: emojiName,
    });
  }

  /**
   * Create a post with reaction options for user interaction
   *
   * This is a common pattern for interactive posts that need user response
   * via reactions (e.g., approval prompts, questions, permission requests).
   *
   * @param message - Post message content
   * @param reactions - Array of emoji names to add as reaction options
   * @param threadId - Optional thread root ID
   * @returns The created post
   */
  async createInteractivePost(
    message: string,
    reactions: string[],
    threadId?: string
  ): Promise<PlatformPost> {
    const post = await this.createPost(message, threadId);

    // Add each reaction option, continuing even if some fail
    for (const emoji of reactions) {
      try {
        await this.addReaction(post.id, emoji);
      } catch (err) {
        console.error(`  ⚠️ Failed to add reaction ${emoji}:`, err);
      }
    }

    return post;
  }

  // Download a file attachment
  async downloadFile(fileId: string): Promise<Buffer> {
    const url = `${this.url}/api/v4/files/${fileId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download file ${fileId}: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // Get file info (metadata)
  async getFileInfo(fileId: string): Promise<PlatformFile> {
    const file = await this.api<MattermostFile>('GET', `/files/${fileId}/info`);
    return this.normalizePlatformFile(file);
  }

  // Get a post by ID (used to verify thread still exists on resume)
  async getPost(postId: string): Promise<PlatformPost | null> {
    try {
      const post = await this.api<MattermostPost>('GET', `/posts/${postId}`);
      return this.normalizePlatformPost(post);
    } catch {
      return null; // Post doesn't exist or was deleted
    }
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

      // Convert posts map to sorted array (chronological order)
      const messages: ThreadMessage[] = [];
      for (const postId of response.order) {
        const post = response.posts[postId];
        if (!post) continue;

        // Skip bot messages if requested
        if (options?.excludeBotMessages && post.user_id === this.botUserId) {
          continue;
        }

        // Get username from cache or fetch
        const user = await this.getUser(post.user_id);
        const username = user?.username || 'unknown';

        messages.push({
          id: post.id,
          userId: post.user_id,
          username,
          message: post.message,
          createAt: post.create_at,
        });
      }

      // Sort by createAt (oldest first)
      messages.sort((a, b) => a.createAt - b.createAt);

      // Apply limit if specified (return most recent N messages)
      if (options?.limit && messages.length > options.limit) {
        return messages.slice(-options.limit);
      }

      return messages;
    } catch (err) {
      console.error(`  ⚠️ Failed to get thread history for ${threadId}:`, err);
      return [];
    }
  }

  // Connect to WebSocket
  async connect(): Promise<void> {
    // Get bot user first
    await this.getBotUser();
    wsLogger.debug(`Bot user ID: ${this.botUserId}`);

    const wsUrl = this.url
      .replace(/^http/, 'ws')
      .concat('/api/v4/websocket');

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        wsLogger.debug('WebSocket connected');
        // Authenticate
        if (this.ws) {
          this.ws.send(
            JSON.stringify({
              seq: 1,
              action: 'authentication_challenge',
              data: { token: this.token },
            })
          );
        }
      };

      this.ws.onmessage = (event) => {
        this.lastMessageAt = Date.now(); // Track activity for heartbeat
        try {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          const wsEvent = JSON.parse(data) as MattermostWebSocketEvent;
          this.handleEvent(wsEvent);

          // Authentication success
          if (wsEvent.event === 'hello') {
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            this.emit('connected');
            resolve();
          }
        } catch (err) {
          wsLogger.debug(`Failed to parse message: ${err}`);
        }
      };

      this.ws.onclose = () => {
        wsLogger.debug('WebSocket disconnected');
        this.stopHeartbeat();
        this.emit('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = (event) => {
        wsLogger.debug(`WebSocket error: ${event}`);
        this.emit('error', event);
        reject(event);
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

        // Only handle messages in our channel
        if (post.channel_id !== this.channelId) return;

        // Get user info and emit (with normalized types)
        this.getUser(post.user_id).then((user) => {
          this.emit('message', this.normalizePlatformPost(post), user);
        });
      } catch (err) {
        wsLogger.debug(`Failed to parse post: ${err}`);
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
        wsLogger.debug(`Failed to parse reaction: ${err}`);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('  ⚠️  Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`  🔄 Reconnecting... (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((err) => {
        console.error(`  ❌ Reconnection failed: ${err}`);
      });
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat(); // Clear any existing
    this.lastMessageAt = Date.now();

    this.heartbeatInterval = setInterval(() => {
      const silentFor = Date.now() - this.lastMessageAt;

      // If no message received for too long, connection is dead
      if (silentFor > this.HEARTBEAT_TIMEOUT_MS) {
        console.log(`  💔 Connection dead (no activity for ${Math.round(silentFor / 1000)}s), reconnecting...`);
        this.stopHeartbeat();
        if (this.ws) {
          this.ws.close(); // Force close (triggers reconnect via 'close' event)
        }
        return;
      }

      // Send a typing indicator as a keepalive (Mattermost will respond with activity)
      wsLogger.debug(`Heartbeat check (last activity ${Math.round(silentFor / 1000)}s ago)`);
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // Check if user is allowed to use the bot
  isUserAllowed(username: string): boolean {
    if (this.allowedUsers.length === 0) {
      // If no allowlist configured, allow all
      return true;
    }
    return this.allowedUsers.includes(username);
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

  // Get the bot name
  getBotName(): string {
    return this.botName;
  }

  // Get MCP config for permission server
  getMcpConfig(): { type: string; url: string; token: string; channelId: string; allowedUsers: string[] } {
    return {
      type: 'mattermost',
      url: this.url,
      token: this.token,
      channelId: this.channelId,
      allowedUsers: this.allowedUsers,
    };
  }

  // Get platform-specific markdown formatter
  getFormatter(): PlatformFormatter {
    return this.formatter;
  }

  // Send typing indicator via WebSocket
  sendTyping(parentId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      action: 'user_typing',
      seq: Date.now(),
      data: {
        channel_id: this.channelId,
        parent_id: parentId || '',
      },
    }));
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
