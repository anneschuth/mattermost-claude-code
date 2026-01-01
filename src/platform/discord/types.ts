// Discord-specific types for the platform abstraction layer
// These mirror the discord.js types we need for our implementation

/**
 * Discord message object (simplified from discord.js Message)
 */
export interface DiscordMessage {
  id: string;
  channelId: string;
  guildId?: string;
  author: DiscordUser;
  content: string;
  timestamp: string; // ISO 8601 timestamp
  editedTimestamp?: string | null;
  tts: boolean;
  mentionEveryone: boolean;
  mentions: DiscordUser[];
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  reactions?: DiscordReactionInfo[];
  reference?: {
    messageId?: string;
    channelId?: string;
    guildId?: string;
  };
}

/**
 * Discord user object
 */
export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  globalName?: string | null; // Display name
  bot?: boolean;
  avatar?: string | null;
}

/**
 * Discord attachment object
 */
export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxyUrl: string;
  contentType?: string;
  width?: number;
  height?: number;
}

/**
 * Discord embed object (simplified)
 */
export interface DiscordEmbed {
  title?: string;
  type?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: {
    text: string;
    iconUrl?: string;
  };
  image?: {
    url: string;
    width?: number;
    height?: number;
  };
  author?: {
    name: string;
    url?: string;
    iconUrl?: string;
  };
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
}

/**
 * Discord reaction info attached to a message
 */
export interface DiscordReactionInfo {
  count: number;
  me: boolean;
  emoji: DiscordEmoji;
}

/**
 * Discord emoji object
 */
export interface DiscordEmoji {
  id: string | null; // null for unicode emojis
  name: string | null; // The emoji character or custom emoji name
  animated?: boolean;
}

/**
 * Discord reaction event data (for MESSAGE_REACTION_ADD/REMOVE events)
 */
export interface DiscordReactionEvent {
  userId: string;
  channelId: string;
  messageId: string;
  guildId?: string;
  emoji: DiscordEmoji;
}

/**
 * Discord channel types we care about
 */
export enum DiscordChannelType {
  GuildText = 0,
  DM = 1,
  GuildVoice = 2,
  GroupDM = 3,
  GuildCategory = 4,
  GuildAnnouncement = 5,
  AnnouncementThread = 10,
  PublicThread = 11,
  PrivateThread = 12,
  GuildStageVoice = 13,
  GuildDirectory = 14,
  GuildForum = 15,
  GuildMedia = 16,
}

/**
 * Discord thread object (simplified)
 */
export interface DiscordThread {
  id: string;
  type: DiscordChannelType;
  guildId?: string;
  parentId?: string; // The channel this thread was created in
  name?: string;
  ownerId?: string;
  messageCount?: number;
  memberCount?: number;
}

/**
 * Gateway events we handle
 */
export type DiscordGatewayEvent =
  | 'MESSAGE_CREATE'
  | 'MESSAGE_UPDATE'
  | 'MESSAGE_DELETE'
  | 'MESSAGE_REACTION_ADD'
  | 'MESSAGE_REACTION_REMOVE'
  | 'THREAD_CREATE'
  | 'READY';

/**
 * API request to create a message
 */
export interface CreateMessageRequest {
  content: string;
  message_reference?: {
    message_id: string;
    channel_id?: string;
    guild_id?: string;
    fail_if_not_exists?: boolean;
  };
  allowed_mentions?: {
    parse?: ('roles' | 'users' | 'everyone')[];
    roles?: string[];
    users?: string[];
    replied_user?: boolean;
  };
}

/**
 * API request to edit a message
 */
export interface EditMessageRequest {
  content?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions?: {
    parse?: ('roles' | 'users' | 'everyone')[];
    roles?: string[];
    users?: string[];
    replied_user?: boolean;
  };
}
