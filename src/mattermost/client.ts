import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Config } from '../config.js';
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

export class MattermostClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Config;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private userCache: Map<string, MattermostUser> = new Map();
  private botUserId: string | null = null;

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

  // Connect to WebSocket
  async connect(): Promise<void> {
    // Get bot user first
    await this.getBotUser();
    console.log(`[MM] Bot user ID: ${this.botUserId}`);

    const wsUrl = this.config.mattermost.url
      .replace(/^http/, 'ws')
      .concat('/api/v4/websocket');

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[MM] WebSocket connected');
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
        try {
          const event = JSON.parse(data.toString()) as MattermostWebSocketEvent;
          this.handleEvent(event);

          // Authentication success
          if (event.event === 'hello') {
            this.reconnectAttempts = 0;
            this.emit('connected');
            resolve();
          }
        } catch (err) {
          console.error('[MM] Failed to parse WebSocket message:', err);
        }
      });

      this.ws.on('close', () => {
        console.log('[MM] WebSocket disconnected');
        this.emit('disconnected');
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error('[MM] WebSocket error:', err);
        this.emit('error', err);
        reject(err);
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
        console.error('[MM] Failed to parse post:', err);
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
        console.error('[MM] Failed to parse reaction:', err);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[MM] Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[MM] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((err) => {
        console.error('[MM] Reconnection failed:', err);
      });
    }, delay);
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
    const botName = this.config.mattermost.botName;
    // Match @botname at start or with space before
    const mentionPattern = new RegExp(`(^|\\s)@${botName}\\b`, 'i');
    return mentionPattern.test(message);
  }

  // Extract prompt from message (remove bot mention)
  extractPrompt(message: string): string {
    const botName = this.config.mattermost.botName;
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
