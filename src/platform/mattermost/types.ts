// Mattermost WebSocket event types
export interface MattermostWebSocketEvent {
  event: string;
  data: Record<string, unknown>;
  broadcast: {
    channel_id?: string;
    user_id?: string;
    team_id?: string;
  };
  seq: number;
}

export interface MattermostFile {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  extension: string;
  width?: number;
  height?: number;
}

export interface MattermostPost {
  id: string;
  create_at: number;
  update_at: number;
  delete_at: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  message: string;
  type: string;
  props: Record<string, unknown>;
  metadata?: {
    embeds?: unknown[];
    files?: MattermostFile[];
  };
}

export interface MattermostUser {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  nickname: string;
}

export interface PostedEventData {
  channel_display_name: string;
  channel_name: string;
  channel_type: string;
  post: string; // JSON string of MattermostPost
  sender_name: string;
  team_id: string;
}

export interface ReactionAddedEventData {
  reaction: string; // JSON string of reaction object
}

export interface MattermostReaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
  create_at: number;
}

// API response types
export interface CreatePostRequest {
  channel_id: string;
  message: string;
  root_id?: string; // For threading
  props?: Record<string, unknown>;
}

export interface UpdatePostRequest {
  id: string;
  message: string;
  props?: Record<string, unknown>;
}
