/**
 * Shared Mattermost REST API layer
 *
 * Provides standalone API functions that can be used by both:
 * - src/mattermost/client.ts (main bot with WebSocket)
 * - src/mcp/permission-server.ts (MCP subprocess)
 *
 * These functions take config as parameters (not from global state)
 * to support the MCP server running as a separate process.
 */

export interface MattermostApiConfig {
  url: string;
  token: string;
}

export interface MattermostApiPost {
  id: string;
  channel_id: string;
  message: string;
  root_id?: string;
  user_id?: string;
  create_at?: number;
}

export interface MattermostApiUser {
  id: string;
  username: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

/**
 * Make a request to the Mattermost REST API
 *
 * @param config - API configuration (url and token)
 * @param method - HTTP method
 * @param path - API path (starting with /)
 * @param body - Optional request body
 * @returns Promise with the response data
 */
export async function mattermostApi<T>(
  config: MattermostApiConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${config.url}/api/v4${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
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

/**
 * Get the current authenticated user (bot user)
 */
export async function getMe(config: MattermostApiConfig): Promise<MattermostApiUser> {
  return mattermostApi<MattermostApiUser>(config, 'GET', '/users/me');
}

/**
 * Get a user by ID
 */
export async function getUser(
  config: MattermostApiConfig,
  userId: string
): Promise<MattermostApiUser | null> {
  try {
    return await mattermostApi<MattermostApiUser>(config, 'GET', `/users/${userId}`);
  } catch {
    return null;
  }
}

/**
 * Create a new post in a channel
 */
export async function createPost(
  config: MattermostApiConfig,
  channelId: string,
  message: string,
  rootId?: string
): Promise<MattermostApiPost> {
  return mattermostApi<MattermostApiPost>(config, 'POST', '/posts', {
    channel_id: channelId,
    message,
    root_id: rootId,
  });
}

/**
 * Update an existing post
 */
export async function updatePost(
  config: MattermostApiConfig,
  postId: string,
  message: string
): Promise<MattermostApiPost> {
  return mattermostApi<MattermostApiPost>(config, 'PUT', `/posts/${postId}`, {
    id: postId,
    message,
  });
}

/**
 * Add a reaction to a post
 */
export async function addReaction(
  config: MattermostApiConfig,
  postId: string,
  userId: string,
  emojiName: string
): Promise<void> {
  await mattermostApi(config, 'POST', '/reactions', {
    user_id: userId,
    post_id: postId,
    emoji_name: emojiName,
  });
}

/**
 * Check if a user is allowed based on an allowlist
 *
 * @param username - Username to check
 * @param allowList - List of allowed usernames (empty = all allowed)
 * @returns true if user is allowed
 */
export function isUserAllowed(username: string, allowList: string[]): boolean {
  if (allowList.length === 0) return true;
  return allowList.includes(username);
}

/**
 * Create a post with reaction options for user interaction
 *
 * This is a common pattern used for:
 * - Permission prompts (approve/deny/allow-all)
 * - Plan approval (approve/deny)
 * - Question answering (numbered options)
 * - Message approval (approve/allow-all/deny)
 *
 * @param config - API configuration
 * @param channelId - Channel to post in
 * @param message - Post message content
 * @param reactions - Array of emoji names to add as reaction options
 * @param rootId - Optional thread root ID
 * @param botUserId - Bot user ID (required for adding reactions)
 * @returns The created post
 */
export async function createInteractivePost(
  config: MattermostApiConfig,
  channelId: string,
  message: string,
  reactions: string[],
  rootId: string | undefined,
  botUserId: string
): Promise<MattermostApiPost> {
  const post = await createPost(config, channelId, message, rootId);

  // Add each reaction option, continuing even if some fail
  for (const emoji of reactions) {
    try {
      await addReaction(config, post.id, botUserId, emoji);
    } catch (err) {
      // Log error but continue - the post was created successfully
      console.error(`  ⚠️ Failed to add reaction ${emoji}:`, err);
    }
  }

  return post;
}

/**
 * Pin a post to a channel.
 *
 * @param config - API configuration
 * @param postId - ID of the post to pin
 */
export async function pinPost(
  config: MattermostApiConfig,
  postId: string
): Promise<void> {
  await mattermostApi<void>(config, 'POST', `/posts/${postId}/pin`);
}

/**
 * Unpin a post from a channel.
 *
 * @param config - API configuration
 * @param postId - ID of the post to unpin
 */
export async function unpinPost(
  config: MattermostApiConfig,
  postId: string
): Promise<void> {
  await mattermostApi<void>(config, 'POST', `/posts/${postId}/unpin`);
}

/**
 * Get all pinned posts in a channel.
 *
 * @param config - API configuration
 * @param channelId - Channel ID
 * @returns Array of pinned post IDs
 */
export async function getPinnedPosts(
  config: MattermostApiConfig,
  channelId: string
): Promise<string[]> {
  const response = await mattermostApi<{ order: string[]; posts: Record<string, MattermostApiPost> }>(
    config,
    'GET',
    `/channels/${channelId}/pinned`
  );
  return response.order || [];
}
