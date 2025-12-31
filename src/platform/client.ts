import { EventEmitter } from 'events';
import type {
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
  ThreadMessage,
} from './types.js';
import type { PlatformFormatter } from './formatter.js';

/**
 * Events emitted by PlatformClient
 */
export interface PlatformClientEvents {
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
  message: (post: PlatformPost, user: PlatformUser | null) => void;
  reaction: (reaction: PlatformReaction, user: PlatformUser | null) => void;
}

/**
 * Platform-agnostic client interface
 *
 * All platform implementations (Mattermost, Slack) must implement this interface.
 * This allows SessionManager and other code to work with any platform without
 * knowing the specific implementation details.
 */
export interface PlatformClient extends EventEmitter {
  // ============================================================================
  // Identity
  // ============================================================================

  /**
   * Unique identifier for this platform instance
   * e.g., 'mattermost-internal', 'slack-eng'
   */
  readonly platformId: string;

  /**
   * Platform type
   * e.g., 'mattermost', 'slack'
   */
  readonly platformType: string;

  /**
   * Human-readable display name
   * e.g., 'Internal Team', 'Engineering Slack'
   */
  readonly displayName: string;

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Connect to the platform (WebSocket, Socket Mode, etc.)
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the platform
   */
  disconnect(): void;

  // ============================================================================
  // User Management
  // ============================================================================

  /**
   * Get the bot's own user info
   */
  getBotUser(): Promise<PlatformUser>;

  /**
   * Get a user by their ID
   */
  getUser(userId: string): Promise<PlatformUser | null>;

  /**
   * Check if a username is in the allowed users list
   */
  isUserAllowed(username: string): boolean;

  /**
   * Get the bot's mention name (e.g., 'claude-code')
   */
  getBotName(): string;

  /**
   * Get platform config for MCP permission server
   */
  getMcpConfig(): { type: string; url: string; token: string; channelId: string; allowedUsers: string[] };

  /**
   * Get the platform-specific markdown formatter
   * Use this to format bold, code, etc. in a platform-appropriate way.
   */
  getFormatter(): PlatformFormatter;

  // ============================================================================
  // Messaging
  // ============================================================================

  /**
   * Create a new post/message
   * @param message - Message text
   * @param threadId - Optional thread parent ID
   * @returns The created post
   */
  createPost(message: string, threadId?: string): Promise<PlatformPost>;

  /**
   * Update an existing post/message
   * @param postId - Post ID to update
   * @param message - New message text
   * @returns The updated post
   */
  updatePost(postId: string, message: string): Promise<PlatformPost>;

  /**
   * Create a post with reaction options (for interactive prompts)
   * @param message - Message text
   * @param reactions - Array of emoji names to add as options
   * @param threadId - Optional thread parent ID
   * @returns The created post
   */
  createInteractivePost(
    message: string,
    reactions: string[],
    threadId?: string
  ): Promise<PlatformPost>;

  /**
   * Get a post by ID
   * @param postId - Post ID
   * @returns The post, or null if not found/deleted
   */
  getPost(postId: string): Promise<PlatformPost | null>;

  /**
   * Get thread history (messages in a thread)
   * @param threadId - Thread/root post ID
   * @param options - Optional filtering/limiting options
   * @returns Array of messages in chronological order (oldest first)
   */
  getThreadHistory(
    threadId: string,
    options?: { limit?: number; excludeBotMessages?: boolean }
  ): Promise<ThreadMessage[]>;

  // ============================================================================
  // Reactions
  // ============================================================================

  /**
   * Add a reaction to a post
   * @param postId - Post ID
   * @param emojiName - Emoji name (e.g., '+1', 'white_check_mark')
   */
  addReaction(postId: string, emojiName: string): Promise<void>;

  // ============================================================================
  // Bot Mentions
  // ============================================================================

  /**
   * Check if a message mentions the bot
   * @param message - Message text
   */
  isBotMentioned(message: string): boolean;

  /**
   * Extract the prompt from a message (remove bot mention)
   * @param message - Message text
   * @returns The message with bot mention removed
   */
  extractPrompt(message: string): string;

  // ============================================================================
  // Typing Indicator
  // ============================================================================

  /**
   * Send typing indicator to show bot is "thinking"
   * @param threadId - Optional thread ID
   */
  sendTyping(threadId?: string): void;

  // ============================================================================
  // Files (Optional - may not be supported by all platforms)
  // ============================================================================

  /**
   * Download a file attachment
   * @param fileId - File ID
   * @returns File contents as Buffer
   */
  downloadFile?(fileId: string): Promise<Buffer>;

  /**
   * Get file metadata
   * @param fileId - File ID
   * @returns File metadata
   */
  getFileInfo?(fileId: string): Promise<PlatformFile>;

  // ============================================================================
  // Event Emitter Methods (inherited from EventEmitter)
  // ============================================================================

  on<K extends keyof PlatformClientEvents>(
    event: K,
    listener: PlatformClientEvents[K]
  ): this;

  emit<K extends keyof PlatformClientEvents>(
    event: K,
    ...args: Parameters<PlatformClientEvents[K]>
  ): boolean;
}
