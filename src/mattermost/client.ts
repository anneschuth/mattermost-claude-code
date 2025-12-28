import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Config } from '../config.js';
import { wsLogger } from '../utils/logger.js';
import type {
  MattermostWebSocketEvent,
  MattermostPost,
  MattermostUser,
  MattermostReaction,
  PostedEventData,
  ReactionAddedEventData,
  CreatePostRequest,
  UpdatePostRequest,
} from './types.js';

export interface MattermostClientEvents {
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
  message: (post: MattermostPost, user: MattermostUser | null) => void;
  reaction: (reaction: MattermostReaction, user: MattermostUser | null) => void;
}

// Escape special regex characters to prevent regex injection
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class MattermostClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Config;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private userCache: Map<string, MattermostUser> = new Map();
  private botUserId: string | null = null;

  // Heartbeat to detect dead connections
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = Date.now();
  private readonly PING_INTERVAL_MS = 30000; // Send ping every 30s
  private readonly PING_TIMEOUT_MS = 60000; // Reconnect if no message for 60s

  constructor(config: Config) {
    super();
    this.config = config;
  }

  // REST API helper
  private async api<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.config.mattermost.url}/api/v4${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.mattermost.token}`,
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
  async getBotUser(): Promise<MattermostUser> {
    const user = await this.api<MattermostUser>('GET', '/users/me');
    this.botUserId = user.id;
    return user;
  }

  // Get user by ID (cached)
  async getUser(userId: string): Promise<MattermostUser | null> {
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId)!;
    }
    try {
      const user = await this.api<MattermostUser>('GET', `/users/${userId}`);
      this.userCache.set(userId, user);
      return user;
    } catch {
      return null;
    }
  }

  // Post a message
  async createPost(
    message: string,
    threadId?: string
  ): Promise<MattermostPost> {
    const request: CreatePostRequest = {
      channel_id: this.config.mattermost.channelId,
      message,
      root_id: threadId,
    };
    return this.api<MattermostPost>('POST', '/posts', request);
  }

  // Update a message (for streaming updates)
  async updatePost(postId: string, message: string): Promise<MattermostPost> {
    const request: UpdatePostRequest = {
      id: postId,
      message,
    };
    return this.api<MattermostPost>('PUT', `/posts/${postId}`, request);
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
  ): Promise<MattermostPost> {
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
    const url = `${this.config.mattermost.url}/api/v4/files/${fileId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.mattermost.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download file ${fileId}: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // Get file info (metadata)
  async getFileInfo(fileId: string): Promise<import('./types.js').MattermostFile> {
    return this.api<import('./types.js').MattermostFile>('GET', `/files/${fileId}/info`);
  }

  // Get a post by ID (used to verify thread still exists on resume)
  async getPost(postId: string): Promise<MattermostPost | null> {
    try {
      return await this.api<MattermostPost>('GET', `/posts/${postId}`);
    } catch {
      return null; // Post doesn't exist or was deleted
    }
  }

  // Connect to WebSocket
  async connect(): Promise<void> {
    // Get bot user first
    await this.getBotUser();
    wsLogger.debug(`Bot user ID: ${this.botUserId}`);

    const wsUrl = this.config.mattermost.url
      .replace(/^http/, 'ws')
      .concat('/api/v4/websocket');

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        wsLogger.debug('WebSocket connected');
        // Authenticate
        this.ws!.send(
          JSON.stringify({
            seq: 1,
            action: 'authentication_challenge',
            data: { token: this.config.mattermost.token },
          })
        );
      });

      this.ws.on('message', (data) => {
        this.lastMessageAt = Date.now(); // Track activity for heartbeat
        try {
          const event = JSON.parse(data.toString()) as MattermostWebSocketEvent;
          this.handleEvent(event);

          // Authentication success
          if (event.event === 'hello') {
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            this.emit('connected');
            resolve();
          }
        } catch (err) {
          wsLogger.debug(`Failed to parse message: ${err}`);
        }
      });

      this.ws.on('close', () => {
        wsLogger.debug('WebSocket disconnected');
        this.stopHeartbeat();
        this.emit('disconnected');
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        wsLogger.debug(`WebSocket error: ${err}`);
        this.emit('error', err);
        reject(err);
      });

      this.ws.on('pong', () => {
        this.lastMessageAt = Date.now(); // Pong received, connection is alive
        wsLogger.debug('Pong received');
      });
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
        if (post.channel_id !== this.config.mattermost.channelId) return;

        // Get user info and emit
        this.getUser(post.user_id).then((user) => {
          this.emit('message', post, user);
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

        // Get user info and emit
        this.getUser(reaction.user_id).then((user) => {
          this.emit('reaction', reaction, user);
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

    this.pingInterval = setInterval(() => {
      const silentFor = Date.now() - this.lastMessageAt;

      // If no message received for too long, connection is dead
      if (silentFor > this.PING_TIMEOUT_MS) {
        console.log(`  💔 Connection dead (no activity for ${Math.round(silentFor / 1000)}s), reconnecting...`);
        this.stopHeartbeat();
        if (this.ws) {
          this.ws.terminate(); // Force close (triggers reconnect via 'close' event)
        }
        return;
      }

      // Send ping to keep connection alive and verify it's working
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        wsLogger.debug(`Ping sent (last activity ${Math.round(silentFor / 1000)}s ago)`);
      }
    }, this.PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // Check if user is allowed to use the bot
  isUserAllowed(username: string): boolean {
    if (this.config.allowedUsers.length === 0) {
      // If no allowlist configured, allow all
      return true;
    }
    return this.config.allowedUsers.includes(username);
  }

  // Check if message mentions the bot
  isBotMentioned(message: string): boolean {
    const botName = escapeRegExp(this.config.mattermost.botName);
    // Match @botname at start or with space before
    const mentionPattern = new RegExp(`(^|\\s)@${botName}\\b`, 'i');
    return mentionPattern.test(message);
  }

  // Extract prompt from message (remove bot mention)
  extractPrompt(message: string): string {
    const botName = escapeRegExp(this.config.mattermost.botName);
    return message
      .replace(new RegExp(`(^|\\s)@${botName}\\b`, 'gi'), ' ')
      .trim();
  }

  // Get the bot name
  getBotName(): string {
    return this.config.mattermost.botName;
  }

  // Send typing indicator via WebSocket
  sendTyping(parentId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      action: 'user_typing',
      seq: Date.now(),
      data: {
        channel_id: this.config.mattermost.channelId,
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
