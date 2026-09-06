/**
 * PostTracker - Typed registry for tracking posts and their metadata
 *
 * This module provides a centralized registry for tracking posts created
 * during chat sessions, enabling proper routing of reactions and other
 * interactions back to the correct session.
 *
 * Key improvements over the simple Map<postId, threadId>:
 * - Typed post metadata (content, task_list, interactive, etc.)
 * - Query by session to find all posts for a session
 * - Interaction type tracking for approval and question posts
 * - Clear ownership and lifecycle management
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Type of post content.
 */
export type PostType =
  | 'content'          // Regular content post (Claude's response)
  | 'task_list'        // Task list post (TodoWrite)
  | 'session_header'   // Session start header
  | 'question'         // AskUserQuestion post
  | 'plan_approval'    // Plan approval post
  | 'message_approval' // Unauthorized user message approval
  | 'permission'       // Permission prompt (from MCP server)
  | 'worktree_prompt'  // Worktree creation prompt
  | 'context_prompt'   // Thread context selection prompt
  | 'update_prompt'    // Update version prompt
  | 'subagent'         // Subagent status post
  | 'lifecycle'        // Lifecycle message (timeout, pause)
  | 'tool_details'     // Tool stream posted apart from the reply (toolDetails: thread)
  | 'compaction'       // Context compaction status
  | 'system'           // System messages (errors, info)
  | 'bug_report';      // Bug report post

/**
 * Type of interactive content (for question/approval posts).
 */
export type InteractionType =
  | 'question'           // AskUserQuestion
  | 'plan_approval'      // ExitPlanMode - plan needs approval
  | 'action_approval'    // Generic action approval
  | 'message_approval'   // Unauthorized user message
  | 'worktree_existing'  // Prompt to join existing worktree
  | 'worktree_failure'   // Worktree creation failed, offer options
  | 'worktree_suggest'   // Worktree suggestions
  | 'context_selection'  // Select context from thread
  | 'update_now'         // Update now or defer
  | 'toggle_minimize'    // Task list minimize toggle
  | 'resume';            // Resume from timeout

/**
 * Metadata about a registered post.
 */
export interface PostInfo {
  /** Post ID */
  postId: string;
  /** Thread ID the post belongs to */
  threadId: string;
  /** Session ID (platformId:threadId) */
  sessionId: string;
  /** Type of post */
  type: PostType;
  /** For interactive posts, the specific interaction type */
  interactionType?: InteractionType;
  /** For interactive posts, the associated tool use ID */
  toolUseId?: string;
  /** Creation timestamp */
  createdAt: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for registering a post.
 */
export interface RegisterPostOptions {
  type?: PostType;
  interactionType?: InteractionType;
  toolUseId?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PostTracker Interface
// ---------------------------------------------------------------------------

/**
 * Interface for post tracking.
 * Allows for different implementations (e.g., in-memory, persistent).
 */
export interface PostTrackerInterface {
  /**
   * Register a post for tracking.
   *
   * @param postId - The post ID
   * @param threadId - The thread ID
   * @param sessionId - The session ID
   * @param options - Optional metadata
   */
  register(
    postId: string,
    threadId: string,
    sessionId: string,
    options?: RegisterPostOptions
  ): void;

  /**
   * Unregister a post.
   *
   * @param postId - The post ID to unregister
   * @returns true if the post was found and removed
   */
  unregister(postId: string): boolean;

  /**
   * Get post info by ID.
   *
   * @param postId - The post ID
   * @returns Post info or undefined if not found
   */
  get(postId: string): PostInfo | undefined;

  /**
   * Get the thread ID for a post.
   * Convenience method for backward compatibility.
   *
   * @param postId - The post ID
   * @returns Thread ID or undefined
   */
  getThreadId(postId: string): string | undefined;

  /**
   * Find the session ID for a post.
   *
   * @param postId - The post ID
   * @returns Session ID or undefined
   */
  findSessionForPost(postId: string): string | undefined;

  /**
   * Get all posts for a session.
   *
   * @param sessionId - The session ID
   * @returns Array of post info
   */
  getPostsForSession(sessionId: string): PostInfo[];

  /**
   * Get posts of a specific type for a session.
   *
   * @param sessionId - The session ID
   * @param type - The post type to filter by
   * @returns Array of post info
   */
  getPostsByType(sessionId: string, type: PostType): PostInfo[];

  /**
   * Clear all posts for a session.
   *
   * @param sessionId - The session ID
   * @returns Number of posts removed
   */
  clearSession(sessionId: string): number;

  /**
   * Clear all posts.
   */
  clear(): void;

  /**
   * Get total number of tracked posts.
   */
  size(): number;

  /**
   * Check if a post is registered.
   *
   * @param postId - The post ID
   */
  has(postId: string): boolean;
}

// ---------------------------------------------------------------------------
// Default Implementation
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of PostTracker.
 */
export class PostTracker implements PostTrackerInterface {
  /** Primary index: postId -> PostInfo */
  private posts = new Map<string, PostInfo>();

  /** Secondary index: sessionId -> Set of postIds */
  private sessionIndex = new Map<string, Set<string>>();

  register(
    postId: string,
    threadId: string,
    sessionId: string,
    options: RegisterPostOptions = {}
  ): void {
    const info: PostInfo = {
      postId,
      threadId,
      sessionId,
      type: options.type ?? 'content',
      interactionType: options.interactionType,
      toolUseId: options.toolUseId,
      createdAt: Date.now(),
      metadata: options.metadata,
    };

    this.posts.set(postId, info);

    // Update session index
    let sessionPosts = this.sessionIndex.get(sessionId);
    if (!sessionPosts) {
      sessionPosts = new Set();
      this.sessionIndex.set(sessionId, sessionPosts);
    }
    sessionPosts.add(postId);
  }

  unregister(postId: string): boolean {
    const info = this.posts.get(postId);
    if (!info) return false;

    this.posts.delete(postId);

    // Update session index
    const sessionPosts = this.sessionIndex.get(info.sessionId);
    if (sessionPosts) {
      sessionPosts.delete(postId);
      if (sessionPosts.size === 0) {
        this.sessionIndex.delete(info.sessionId);
      }
    }

    return true;
  }

  get(postId: string): PostInfo | undefined {
    return this.posts.get(postId);
  }

  getThreadId(postId: string): string | undefined {
    return this.posts.get(postId)?.threadId;
  }

  findSessionForPost(postId: string): string | undefined {
    return this.posts.get(postId)?.sessionId;
  }

  getPostsForSession(sessionId: string): PostInfo[] {
    const postIds = this.sessionIndex.get(sessionId);
    if (!postIds) return [];

    return Array.from(postIds)
      .map(id => this.posts.get(id))
      .filter((info): info is PostInfo => info !== undefined);
  }

  getPostsByType(sessionId: string, type: PostType): PostInfo[] {
    return this.getPostsForSession(sessionId).filter(info => info.type === type);
  }

  clearSession(sessionId: string): number {
    const postIds = this.sessionIndex.get(sessionId);
    if (!postIds) return 0;

    const count = postIds.size;
    for (const postId of postIds) {
      this.posts.delete(postId);
    }
    this.sessionIndex.delete(sessionId);

    return count;
  }

  clear(): void {
    this.posts.clear();
    this.sessionIndex.clear();
  }

  size(): number {
    return this.posts.size;
  }

  has(postId: string): boolean {
    return this.posts.has(postId);
  }
}

