/**
 * Platform-agnostic types for multi-platform support
 *
 * These types normalize the differences between Mattermost, Slack, etc.
 * into a common interface that SessionManager can work with.
 */

/**
 * Normalized user representation across platforms
 */
export interface PlatformUser {
  id: string;           // Platform-specific user ID
  username: string;     // Display username (e.g., 'alice', 'bob')
  email?: string;       // Optional email
}

/**
 * Normalized post/message representation across platforms
 */
export interface PlatformPost {
  id: string;           // Platform-specific post ID
  platformId: string;   // Which platform instance this is from
  channelId: string;    // Channel/conversation ID
  userId: string;       // Author's user ID
  message: string;      // Message text content
  rootId?: string;      // Thread parent ID (if this is a reply)
  createAt?: number;    // Timestamp (ms since epoch)
  metadata?: {
    files?: PlatformFile[];  // Attached files
    [key: string]: unknown;  // Platform-specific metadata
  };
}

/**
 * Normalized reaction representation across platforms
 */
export interface PlatformReaction {
  userId: string;       // User who reacted
  postId: string;       // Post that was reacted to
  emojiName: string;    // Emoji name (e.g., '+1', 'white_check_mark')
  createAt?: number;    // When the reaction was added
}

/**
 * Normalized file attachment representation across platforms
 */
export interface PlatformFile {
  id: string;           // Platform-specific file ID
  name: string;         // Filename
  size: number;         // File size in bytes
  mimeType: string;     // MIME type (e.g., 'image/png')
  extension?: string;   // File extension
}

/**
 * Request to create a new post
 */
export interface CreatePostRequest {
  message: string;
  threadId?: string;    // Optional thread parent ID
}

/**
 * Request to update an existing post
 */
export interface UpdatePostRequest {
  postId: string;
  message: string;
}

/**
 * Request to add a reaction to a post
 */
export interface AddReactionRequest {
  postId: string;
  emojiName: string;
}

/**
 * Normalized thread message for context retrieval
 */
export interface ThreadMessage {
  id: string;           // Message/post ID
  userId: string;       // Author's user ID
  username: string;     // Author's username
  message: string;      // Message content
  createAt: number;     // Timestamp (ms since epoch)
}
