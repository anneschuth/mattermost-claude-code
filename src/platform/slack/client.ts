import { WebSocket, countPingsAsActivity } from '../../utils/websocket.js';
import type { McpServerConfig } from '../../config/types.js';
import type { SlackPlatformConfig } from '../../config/index.js';
import { resolveReconnectPolicy } from '../../config/index.js';
import { wsLogger, createLogger } from '../../utils/logger.js';
import { truncateMessageSafely, escapeRegExp, getEmojiName, formatWebSocketError, resolvePostThreadId, isDcmThreadId, normalizeAckReaction, resolveDirectChannelMode, type ResolvedDirectChannelMode, type ApprovalsMode } from '../utils.js';
import { BasePlatformClient } from '../base-client.js';
import { sanitizeFilename } from '../../utils/safe-filename.js';
import { uploadFileSlack } from './upload.js';
import { statusAnchor, dueForRefresh, STATUS_REFRESH_MS } from './status.js';

const log = createLogger('slack');

/** Rendered as "<App name> is working…" beneath the app name in Slack. */
const STATUS_TEXT = 'is working…';
/** Slack rotates these while the status is up; max 10. */
const STATUS_LOADING_MESSAGES = ['is working…', 'still working…', 'thinking it through…'];
/** Cap on remembered throttle anchors before stale ones are pruned. */
const MAX_STATUS_ANCHORS = 64;

import type {
  SlackSocketModeEvent,
  SlackMessage,
  SlackUser,
  SlackFile,
  AuthTestResponse,
  AppsConnectionsOpenResponse,
  PostMessageResponse,
  UpdateMessageResponse,
  ConversationsRepliesResponse,
  ConversationsHistoryResponse,
  UsersInfoResponse,
  UsersListResponse,
  PinsListResponse,
  FilesInfoResponse,
  SlackApiResponse,
} from './types.js';
import type {
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
  ThreadMessage,
} from '../index.js';
import type { PlatformFormatter } from '../formatter.js';
import { SlackFormatter } from './formatter.js';

/**
 * Slack platform client implementation using Socket Mode.
 *
 * Socket Mode uses WebSocket for real-time events and Web API for REST calls.
 * This requires:
 * - App-level token (xapp-...) for Socket Mode WebSocket connection
 * - Bot token (xoxb-...) for Web API calls
 */
export class SlackClient extends BasePlatformClient {
  // Platform identity (required by PlatformClient)
  readonly platformId: string;
  readonly platformType = 'slack' as const;
  readonly displayName: string;
  readonly directChannelMode: ResolvedDirectChannelMode;
  readonly approvals?: ApprovalsMode;
  readonly ackReaction?: boolean | string;

  private ws: WebSocket | null = null;
  private botToken: string;
  private appToken: string;
  private channelId: string;
  private apiUrl: string;


  // User caching
  private userCache: Map<string, SlackUser> = new Map();
  private usernameToIdCache: Map<string, string> = new Map();
  private botUserId: string | null = null;
  /** This app's id, learned from the socket (`hello`, then every events_api envelope). */
  private appId: string | null = null;
  /** This installation's workspace, from auth.test. */
  private teamId: string | null = null;
  private botUser: SlackUser | null = null;
  private teamUrl: string | null = null;

  // Track last processed message for recovery after disconnection
  private lastProcessedTs: string | null = null;

  // Message deduplication: track recently processed message timestamps
  // This prevents duplicate session starts when the mock server sends the same
  // event to multiple WebSocket connections (during test cleanup race conditions)
  private readonly processedMessages = new Set<string>();
  private readonly MAX_PROCESSED_MESSAGES = 1000;

  // Rate limiting with exponential backoff
  private rateLimitDelay = 0;
  private rateLimitRetryAfter = 0;

  private outboundFiles?: { enabled?: boolean; maxBytes?: number };
  private mcpServers?: Record<string, McpServerConfig>;
  private strictMcpConfig?: boolean;
  private claudeAiConnectors?: boolean;

  /** When a working-status was last asserted, per anchoring message ts. */
  private readonly statusSentAt = new Map<string, number>();

  private readonly formatter = new SlackFormatter();

  // Shared event source: when several SlackClient instances serve one Slack
  // app, Slack round-robins Socket Mode envelopes across their connections.
  // Instead, exactly one client (the parent) holds the socket and routes
  // events for other channels into registered secondary clients.
  private readonly channelClients = new Map<string, SlackClient>();
  private sharedEventSource?: SlackClient;
  private socketConnected = false;

  constructor(platformConfig: SlackPlatformConfig, sharedEventSource?: SlackClient) {
    super();
    this.sharedEventSource = sharedEventSource;
    this.installStateMirror();
    this.platformId = platformConfig.id;
    this.displayName = platformConfig.displayName;
    this.botToken = platformConfig.botToken;
    this.appToken = platformConfig.appToken;
    this.channelId = platformConfig.channelId;
    this.botName = platformConfig.botName;
    this.allowedUsers = platformConfig.allowedUsers;
    this.apiUrl = platformConfig.apiUrl || 'https://slack.com/api';
    this.outboundFiles = platformConfig.outboundFiles;
    this.mcpServers = platformConfig.mcpServers;
    this.strictMcpConfig = platformConfig.strictMcpConfig;
    this.claudeAiConnectors = platformConfig.claudeAiConnectors;
    this.directChannelMode = resolveDirectChannelMode(platformConfig.directChannelMode);
    this.approvals = platformConfig.approvals;
    this.ackReaction = normalizeAckReaction(platformConfig.ackReaction, `platforms[${platformConfig.id}].ackReaction`);
    this.setReconnectPolicy(resolveReconnectPolicy(platformConfig.reconnectPolicy, `platforms[${platformConfig.id}]`));
  }

  // ============================================================================
  // Shared event source plumbing
  // ============================================================================

  /**
   * A secondary's only event feed is the parent's socket, so the parent's
   * connection state IS the secondary's connection state — mirror it.
   *
   * Stable handler identities, so re-arming is idempotent: overlapping
   * `disconnect()` calls each clear the listeners and each re-arm, and a
   * fresh closure per install would leave the mirror stacked and every
   * later event duplicated into the secondaries.
   */
  private readonly stateMirrors = (['connected', 'disconnected', 'reconnecting'] as const).map(
    (state) => ({
      state,
      handler: (...args: unknown[]) => {
        for (const secondary of this.channelClients.values()) {
          secondary.emit(state, ...args);
        }
      },
    })
  );

  private installStateMirror(): void {
    for (const { state, handler } of this.stateMirrors) {
      this.off(state, handler);
      this.on(state, handler);
    }
  }

  /**
   * The parent's socket is every secondary's feed too, so a reconnect means
   * each of them missed messages as well. `super` clears `isReconnecting`
   * (after recovering this client's own), so capture it first.
   */
  protected override onConnectionEstablished(): void {
    const wasReconnecting = this.isReconnecting;
    super.onConnectionEstablished();
    if (!wasReconnecting) return;

    for (const secondary of this.channelClients.values()) {
      secondary.recoverMissedMessages().catch((err) => {
        log.warn(`Failed to recover missed messages for ${secondary.platformId}: ${err}`);
      });
    }
  }

  /**
   * Parent-side: route events for `channelId` into a secondary client.
   *
   * Register secondaries (or call their `connect()`) BEFORE connecting the
   * parent: events arriving between the parent's socket going live and a
   * secondary's registration hit the unregistered-channel drop path.
   */
  registerChannelClient(channelId: string, client: SlackClient): void {
    if (channelId === this.channelId) {
      // Routing requires eventChannel !== this.channelId, so a same-channel
      // secondary would register fine and then never receive anything.
      throw new Error(
        `registerChannelClient: ${channelId} is the parent's own channel — a secondary there can never receive events`
      );
    }
    this.channelClients.set(channelId, client);
  }

  /**
   * Parent-side: stop routing events for `channelId`. When `client` is given,
   * the registration is removed only if it still belongs to that instance —
   * an old secondary's teardown must not evict its replacement.
   */
  unregisterChannelClient(channelId: string, client?: SlackClient): void {
    if (client && this.channelClients.get(channelId) !== client) return;
    this.channelClients.delete(channelId);
  }

  /** Secondary-side: receive an event injected by the parent's socket. */
  _injectSlackEvent(event: Parameters<SlackClient['handleSlackEvent']>[0], appId?: string | null): void {
    if (appId) this.appId = appId;
    this.handleSlackEvent(event);
  }

  override disconnect(): Promise<void> {
    // A secondary must stop receiving injected events when it goes away;
    // the base teardown is still safe to run (it has no socket to close).
    if (this.sharedEventSource) {
      this.sharedEventSource.unregisterChannelClient(this.channelId, this);
    }
    // Base teardown calls removeAllListeners() synchronously and then returns
    // the socket-close promise, which can stay pending. Re-arm before that
    // promise settles: without the mirror, a parent that reconnects while the
    // close is still in flight emits 'connected' into nothing and its
    // secondaries miss it permanently.
    //
    // Synchronous try/finally, not async: the base promise is returned
    // unchanged (a synchronous throw stays synchronous) and the mirror is
    // re-armed on the throwing path too — a failed close must not also leave
    // the parent permanently mute.
    try {
      return super.disconnect();
    } finally {
      this.installStateMirror();
    }
  }

  // ============================================================================
  // Type Normalization (Slack -> Platform)
  // ============================================================================

  private normalizePlatformUser(slackUser: SlackUser): PlatformUser {
    const displayName =
      slackUser.profile?.display_name ||
      slackUser.profile?.real_name ||
      slackUser.real_name ||
      slackUser.name;

    return {
      id: slackUser.id,
      username: slackUser.name,
      displayName,
      email: slackUser.profile?.email,
    };
  }

  private normalizePlatformPost(
    slackMessage: SlackMessage,
    channelId: string
  ): PlatformPost {
    // Normalize files if present
    const files = slackMessage.files?.map((f) => this.normalizePlatformFile(f));

    return {
      id: slackMessage.ts,
      platformId: this.platformId,
      channelId,
      userId: slackMessage.user || slackMessage.bot_id || '',
      message: slackMessage.text,
      rootId: slackMessage.thread_ts !== slackMessage.ts ? slackMessage.thread_ts : undefined,
      createAt: Math.floor(parseFloat(slackMessage.ts) * 1000),
      metadata: files ? { files } : undefined,
    };
  }

  private normalizePlatformFile(slackFile: SlackFile): PlatformFile {
    // Extract extension from filename or filetype
    const extension = slackFile.name?.split('.').pop() || slackFile.filetype;

    return {
      id: slackFile.id,
      name: slackFile.name,
      size: slackFile.size,
      mimeType: slackFile.mimetype,
      extension,
    };
  }

  // ============================================================================
  // Slack Web API Helpers
  // ============================================================================

  // Maximum number of rate limit retries before giving up
  private readonly MAX_RATE_LIMIT_RETRIES = 5;

  /**
   * Make a Slack Web API request with rate limiting and error handling.
   * @param expectedErrors - Array of error codes that are expected and shouldn't be logged as warnings
   */
  private async api<T extends SlackApiResponse>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>,
    retryCount = 0,
    expectedErrors: string[] = []
  ): Promise<T> {
    // Apply rate limit delay if needed
    if (this.rateLimitDelay > 0) {
      const now = Date.now();
      if (now < this.rateLimitRetryAfter) {
        const waitTime = this.rateLimitRetryAfter - now;
        log.debug(`Rate limited, waiting ${waitTime}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      this.rateLimitDelay = 0;
    }

    const url = `${this.apiUrl}/${endpoint}`;
    log.debug(`API ${method} ${endpoint}`);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // Handle rate limiting with max retries
    if (response.status === 429) {
      if (retryCount >= this.MAX_RATE_LIMIT_RETRIES) {
        log.error(`Rate limit max retries (${this.MAX_RATE_LIMIT_RETRIES}) exceeded for ${endpoint}`);
        throw new Error(`Slack API rate limit exceeded after ${this.MAX_RATE_LIMIT_RETRIES} retries`);
      }

      const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
      this.rateLimitDelay = retryAfter * 1000;
      this.rateLimitRetryAfter = Date.now() + this.rateLimitDelay;
      log.warn(`Rate limited by Slack, retrying after ${retryAfter}s (attempt ${retryCount + 1}/${this.MAX_RATE_LIMIT_RETRIES})`);

      // Retry after delay
      await new Promise((resolve) => setTimeout(resolve, this.rateLimitDelay));
      return this.api<T>(method, endpoint, body, retryCount + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      log.warn(`API ${method} ${endpoint} failed: ${response.status} ${text.substring(0, 100)}`);
      throw new Error(`Slack API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as T;

    if (!data.ok) {
      // Only log warning for unexpected errors
      if (!expectedErrors.includes(data.error || '')) {
        log.warn(`API ${method} ${endpoint} error: ${data.error}`);
      }
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  /**
   * Make a request using the app token (for apps.connections.open).
   */
  private async appApi<T extends SlackApiResponse>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.apiUrl}/${endpoint}`;
    log.debug(`App API ${method} ${endpoint}`);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.appToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Slack App API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as T;

    if (!data.ok) {
      throw new Error(`Slack App API error: ${data.error}`);
    }

    return data;
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Connect to Slack using Socket Mode.
   *
   * Socket Mode flow:
   * 1. Call apps.connections.open with app token to get WebSocket URL
   * 2. Connect to WebSocket URL
   * 3. Receive 'hello' event to confirm connection
   * 4. Receive events and ACK within 3 seconds
   */
  async connect(): Promise<void> {
    // Secondary instance on a shared event source: NEVER open a second Socket
    // Mode connection — Slack round-robins envelopes across an app's
    // connections, so a second socket steals events from the parent. The
    // parent injects events via _injectSlackEvent; Web API calls (which are
    // plain HTTPS) work independently.
    if (this.sharedEventSource) {
      await this.fetchBotUser();
      // disconnect() may have run while fetchBotUser was in flight — a stale
      // continuation must not resurrect the registration.
      if (this.isIntentionalDisconnect) return;
      this.sharedEventSource.registerChannelClient(this.channelId, this);
      // Only claim connected while the parent's socket actually is; otherwise
      // the state mirror emits 'connected' when the parent's hello arrives.
      if (this.sharedEventSource.socketConnected) {
        this.emit('connected');
      }
      return;
    }

    // First, get bot user info
    await this.fetchBotUser();
    wsLogger.debug(`Slack bot user ID: ${this.botUserId}`);

    // Get WebSocket URL from apps.connections.open
    const response = await this.appApi<AppsConnectionsOpenResponse>(
      'POST',
      'apps.connections.open'
    );

    const wsUrl = response.url;
    wsLogger.info('Socket Mode: Got WebSocket URL, connecting...');

    return new Promise((resolve, reject) => {
      // Track whether promise has been settled to avoid double-resolve/reject
      let settled = false;

      const doResolve = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const doReject = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      // Connection timeout - if we don't get 'hello' within 30 seconds, fail
      const connectionTimeout = setTimeout(() => {
        const err = new Error('Socket Mode connection timeout: no hello received within 30 seconds');
        wsLogger.warn(`${err.message}`);
        doReject(err);
        if (this.ws) {
          this.ws.close();
        }
      }, 30000);

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        wsLogger.info('Socket Mode: WebSocket connected, waiting for hello...');
      };

      // Slack keeps idle Socket Mode connections alive with protocol-level ping
      // frames (~10s cadence) — they never reach onmessage. Without counting
      // them the 60s heartbeat executes every healthy idle connection
      // (observed 2026-08-25). Covers Bun and Node 20; see the helper for why
      // Node 22+/undici cannot be covered here (#498).
      countPingsAsActivity(this.ws, () => this.updateLastMessageTime());

      this.ws.onmessage = (event) => {
        this.updateLastMessageTime();

        try {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          const envelope = JSON.parse(data) as SlackSocketModeEvent;

          // Handle different envelope types
          this.handleSocketModeEvent(envelope);

          // Connection established on 'hello'
          if (envelope.type === 'hello') {
            clearTimeout(connectionTimeout);
            this.socketConnected = true;
            // Recovery for this channel and for every secondary happens in
            // onConnectionEstablished — a block here would run after the base
            // has already cleared isReconnecting, i.e. never.
            this.onConnectionEstablished();

            doResolve();
          }
        } catch (err) {
          wsLogger.warn(`Failed to parse Socket Mode message: ${err}`);
        }
      };

      this.ws.onclose = (event) => {
        this.socketConnected = false;
        clearTimeout(connectionTimeout);
        wsLogger.info(
          `Socket Mode: WebSocket disconnected (code: ${event.code}, reason: ${event.reason || 'none'}, clean: ${event.wasClean})`
        );

        // If we haven't received 'hello' yet, reject the promise
        // This handles cases where the WebSocket closes before authentication completes
        if (!settled) {
          wsLogger.warn(`WebSocket closed before hello event (code: ${event.code}, reason: ${event.reason || 'none'})`);
        }
        doReject(new Error(`Socket Mode WebSocket closed before connection established (code: ${event.code})`));

        // Only reconnect if not intentional and server didn't shut down
        // When the server shuts down (e.g., test mock server), we should not reconnect
        // Also don't reconnect when connection was replaced by a new one (test cleanup race condition)
        const serverShutdown = event.reason?.toLowerCase().includes('server shutting down');
        const connectionReplaced = event.reason?.toLowerCase().includes('new connection replacing');
        if (!this.isIntentionalDisconnect && !serverShutdown && !connectionReplaced) {
          this.onConnectionClosed();
        } else {
          this.stopHeartbeat();
          this.emit('disconnected');
          if (serverShutdown) {
            wsLogger.debug('Server shutdown detected, not reconnecting');
          } else if (connectionReplaced) {
            wsLogger.debug('Connection replaced by new one, not reconnecting');
          } else {
            wsLogger.debug('Intentional disconnect, not reconnecting');
          }
        }
      };

      this.ws.onerror = (event) => {
        clearTimeout(connectionTimeout);
        const msg = formatWebSocketError(event);
        wsLogger.warn(`Socket Mode: WebSocket error: ${msg}`);
        // Only emit error event if this is not an intentional disconnect and not a reconnection attempt.
        // During reconnection, errors are already handled by the .catch() in scheduleReconnect().
        // This avoids unhandled error events during test cleanup when mock server is shut down.
        if (!this.isIntentionalDisconnect && !this.isReconnecting) {
          this.emit('error', new Error(`Socket Mode WebSocket error: ${msg}`));
        }
        doReject(new Error(`Socket Mode WebSocket error: ${msg}`));
      };
    });
  }

  /**
   * Handle Socket Mode events.
   * Must ACK events within 3 seconds.
   */
  private handleSocketModeEvent(envelope: SlackSocketModeEvent): void {
    // ACK the envelope immediately (required within 3 seconds)
    if (envelope.envelope_id && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      wsLogger.debug(`ACKed envelope ${envelope.envelope_id}`);
    }

    // Handle disconnect request from Slack
    if (envelope.type === 'disconnect') {
      wsLogger.info('Socket Mode: Received disconnect request, reconnecting...');
      this.isReconnecting = true;
      if (this.ws) {
        this.ws.close();
      }
      return;
    }

    if (envelope.type === 'hello' && envelope.connection_info?.app_id) {
      this.appId = envelope.connection_info.app_id;
    }

    // Handle events_api envelopes
    if (envelope.type === 'events_api' && envelope.payload?.event) {
      if (envelope.payload.api_app_id) this.appId = envelope.payload.api_app_id;
      this.handleSlackEvent(envelope.payload.event);
    }
  }

  /**
   * Slack stamps every API-posted message with the posting app's `bot_id` and
   * `app_id`, including one posted with a *person's* user token of this app
   * (an integration relaying what the person said). That message is the
   * person's: `user` is set, `app_id` is ours, `team` is ours. Everything
   * else with a `bot_id` — our own replies, other apps, classic bots without
   * a user, and a bot copy of this same app in another workspace sharing a
   * Slack Connect channel — is bot-authored and ignored. Until app and team
   * ids are known, the old rule holds.
   */
  private isBotAuthored(message: { user?: string; bot_id?: string; app_id?: string; team?: string }): boolean {
    if (message.user === this.botUserId) return true;
    if (!message.bot_id) return false;
    const isOurUserTokenPost = Boolean(
      this.appId && message.app_id === this.appId && this.teamId && message.team === this.teamId && message.user
    );
    if (isOurUserTokenPost) {
      wsLogger.debug(`Accepting post by ${message.user} made through this app's user token`);
    }
    return !isOurUserTokenPost;
  }

  /**
   * Handle Slack events (messages, reactions, etc.)
   */
  private handleSlackEvent(event: {
    type: string;
    subtype?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    text?: string;
    reaction?: string;
    item?: { type: string; channel: string; ts: string };
    item_user?: string;
    bot_id?: string;
    app_id?: string;
    team?: string;
    files?: SlackFile[];
  }): void {
    // Shared event source: this socket may carry events for channels owned by
    // registered secondary clients — hand those over before any own-channel
    // filtering. Events for unregistered foreign channels keep the existing
    // behavior (dropped below by the own-channel checks).
    const eventChannel = event.channel || event.item?.channel;
    if (eventChannel && eventChannel !== this.channelId) {
      const secondary = this.channelClients.get(eventChannel);
      if (secondary) {
        secondary._injectSlackEvent(event, this.appId);
        return;
      }
    }

    // Handle message events
    // Note: file_share subtype is used when a user uploads a file with a message
    if (event.type === 'message' && (!event.subtype || event.subtype === 'file_share')) {
      // Ignore messages from ourselves and other bots
      if (this.isBotAuthored(event)) {
        return;
      }

      // Only handle messages in our channel
      if (event.channel !== this.channelId) {
        return;
      }

      // Deduplicate messages by timestamp
      // This prevents duplicate session starts when the mock server sends the same
      // event to multiple WebSocket connections (during test cleanup race conditions)
      if (event.ts && this.processedMessages.has(event.ts)) {
        wsLogger.debug(`Ignoring duplicate message: ${event.ts}`);
        return;
      }

      // Track this message as processed
      if (event.ts) {
        this.processedMessages.add(event.ts);
        // Prevent unbounded growth by clearing old entries
        if (this.processedMessages.size > this.MAX_PROCESSED_MESSAGES) {
          const iterator = this.processedMessages.values();
          const first = iterator.next().value;
          if (first) this.processedMessages.delete(first);
        }
        this.lastProcessedTs = event.ts;
      }

      // Build a SlackMessage-like object
      const message: SlackMessage = {
        type: 'message',
        ts: event.ts || '',
        user: event.user,
        text: event.text || '',
        thread_ts: event.thread_ts,
        files: event.files,
      };

      const post = this.normalizePlatformPost(message, event.channel || this.channelId);

      // Get user info and emit
      this.getUser(event.user || '')
        .then((user) => {
          this.emit('message', post, user);

          // Also emit channel_post for top-level posts (not thread replies)
          if (!event.thread_ts || event.thread_ts === event.ts) {
            this.emit('channel_post', post, user);
          }
        })
        .catch((err) => {
          log.warn(`Failed to get user for message event: ${err}`);
          // Emit anyway with null user
          this.emit('message', post, null);
        });
    }

    // Handle reaction_added events
    if (event.type === 'reaction_added' && event.item?.type === 'message') {
      // Ignore reactions from ourselves
      if (event.user === this.botUserId) {
        return;
      }

      // Only handle reactions on messages in our channel
      if (event.item.channel !== this.channelId) {
        return;
      }

      const reaction: PlatformReaction = {
        userId: event.user || '',
        postId: event.item.ts,
        emojiName: event.reaction || '',
        createAt: Date.now(),
      };

      this.getUser(event.user || '')
        .then((user) => {
          this.emit('reaction', reaction, user);
        })
        .catch((err) => {
          log.warn(`Failed to get user for reaction event: ${err}`);
          this.emit('reaction', reaction, null);
        });
    }

    // Handle reaction_removed events
    if (event.type === 'reaction_removed' && event.item?.type === 'message') {
      // Ignore reactions from ourselves
      if (event.user === this.botUserId) {
        return;
      }

      // Only handle reactions on messages in our channel
      if (event.item.channel !== this.channelId) {
        return;
      }

      const reaction: PlatformReaction = {
        userId: event.user || '',
        postId: event.item.ts,
        emojiName: event.reaction || '',
        createAt: Date.now(),
      };

      this.getUser(event.user || '')
        .then((user) => {
          this.emit('reaction_removed', reaction, user);
        })
        .catch((err) => {
          log.warn(`Failed to get user for reaction_removed event: ${err}`);
          this.emit('reaction_removed', reaction, null);
        });
    }
  }

  /**
   * Force close the WebSocket connection.
   * Cleans up listeners and ensures we start fresh on reconnection.
   *
   * Returns a Promise that resolves when the underlying socket has actually
   * closed (or after a 1s safety timeout). See MattermostClient for the
   * rationale — same pattern.
   */
  protected forceCloseConnection(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    return this.closeSocket(ws);
  }

  /**
   * Recover messages that were posted while disconnected.
   */
  protected async recoverMissedMessages(): Promise<void> {
    if (!this.lastProcessedTs) {
      return;
    }

    log.info(`Recovering missed messages after ts ${this.lastProcessedTs}...`);

    try {
      const response = await this.api<ConversationsHistoryResponse>(
        'GET',
        `conversations.history?channel=${this.channelId}&oldest=${this.lastProcessedTs}&inclusive=false&limit=100`
      );

      const messages = response.messages || [];

      if (messages.length === 0) {
        log.info('No missed messages to recover');
        return;
      }

      log.info(`Recovered ${messages.length} missed message(s)`);

      // Process in chronological order (oldest first)
      const sortedMessages = messages.sort(
        (a, b) => parseFloat(a.ts) - parseFloat(b.ts)
      );

      for (const message of sortedMessages) {
        // Skip bot messages
        if (this.isBotAuthored(message)) {
          continue;
        }

        this.lastProcessedTs = message.ts;

        const post = this.normalizePlatformPost(message, this.channelId);
        const user = await this.getUser(message.user || '');

        this.emit('message', post, user);

        // Also emit channel_post for top-level posts
        if (!message.thread_ts || message.thread_ts === message.ts) {
          this.emit('channel_post', post, user);
        }
      }
    } catch (err) {
      log.warn(`Failed to recover missed messages: ${err}`);
    }
  }

  // ============================================================================
  // User Management
  // ============================================================================

  /**
   * Fetch and cache the bot's own user info.
   */
  private async fetchBotUser(): Promise<void> {
    const response = await this.api<AuthTestResponse>('POST', 'auth.test');
    this.botUserId = response.user_id;
    this.teamId = response.team_id ?? null;
    this.teamUrl = response.url.replace(/\/$/, ''); // Remove trailing slash

    // Also fetch full user info
    const userResponse = await this.api<UsersInfoResponse>(
      'GET',
      `users.info?user=${response.user_id}`
    );
    this.botUser = userResponse.user;
    this.userCache.set(this.botUserId, this.botUser);
  }

  /**
   * Get the bot's own user info.
   */
  async getBotUser(): Promise<PlatformUser> {
    if (!this.botUser) {
      await this.fetchBotUser();
    }
    // After fetchBotUser(), botUser is guaranteed to be set
    const user = this.botUser as SlackUser;
    return this.normalizePlatformUser(user);
  }

  /**
   * Get a user by ID (cached).
   */
  async getUser(userId: string): Promise<PlatformUser | null> {
    if (!userId) {
      return null;
    }

    const cached = this.userCache.get(userId);
    if (cached) {
      log.debug(`User ${userId} found in cache: @${cached.name}`);
      return this.normalizePlatformUser(cached);
    }

    try {
      const response = await this.api<UsersInfoResponse>('GET', `users.info?user=${userId}`);
      this.userCache.set(userId, response.user);
      this.usernameToIdCache.set(response.user.name, userId);
      log.debug(`User ${userId} fetched: @${response.user.name}`);
      return this.normalizePlatformUser(response.user);
    } catch (err) {
      log.warn(`Failed to get user ${userId}: ${err}`);
      return null;
    }
  }

  /**
   * Get a user by username.
   */
  async getUserByUsername(username: string): Promise<PlatformUser | null> {
    // Check cache first
    const cachedId = this.usernameToIdCache.get(username);
    if (cachedId) {
      return this.getUser(cachedId);
    }

    try {
      log.debug(`Looking up user by username: @${username}`);

      // Slack doesn't have a direct username lookup API
      // We need to list users and find the matching one
      // For efficiency, we'll paginate through the user list
      let cursor: string | undefined;

      do {
        const params = cursor ? `cursor=${cursor}&limit=200` : 'limit=200';
        const response = await this.api<UsersListResponse>('GET', `users.list?${params}`);

        for (const user of response.members || []) {
          // Cache all users we see
          this.userCache.set(user.id, user);
          this.usernameToIdCache.set(user.name, user.id);

          if (user.name === username) {
            log.debug(`User @${username} found: ${user.id}`);
            return this.normalizePlatformUser(user);
          }
        }

        cursor = response.response_metadata?.next_cursor;
      } while (cursor);

      log.warn(`User @${username} not found`);
      return null;
    } catch (err) {
      log.warn(`Failed to lookup user @${username}: ${err}`);
      return null;
    }
  }

  /**
   * Get MCP config for permission server.
   */
  getMcpConfig() {
    return {
      type: 'slack',
      url: 'https://slack.com', // Not really used for Slack
      token: this.botToken,
      channelId: this.channelId,
      allowedUsers: this.allowedUsers,
      appToken: this.appToken, // Required for Socket Mode in permission server
      outboundFiles: this.outboundFiles,
      mcpServers: this.mcpServers,
      strictMcpConfig: this.strictMcpConfig,
      claudeAiConnectors: this.claudeAiConnectors,
    };
  }

  /**
   * Get the platform-specific markdown formatter.
   */
  getFormatter(): PlatformFormatter {
    return this.formatter;
  }

  /**
   * Get a clickable link to a thread.
   * Slack permalink format: {team_url}/archives/{channel_id}/p{timestamp_without_dot}
   * If lastMessageTs is provided, links to that specific message (jump to bottom)
   */
  getThreadLink(threadId: string, _lastMessageId?: string, lastMessageTs?: string): string {
    // Direct channel mode: the synthetic id is not a message ts. Link to the
    // last real message if known, otherwise to the channel itself.
    if (isDcmThreadId(threadId)) {
      if (!this.teamUrl) return '';
      if (lastMessageTs) {
        return `${this.teamUrl}/archives/${this.channelId}/p${lastMessageTs.replace('.', '')}`;
      }
      return `${this.teamUrl}/archives/${this.channelId}`;
    }
    // Use lastMessageTs if provided for jump-to-bottom, otherwise use threadId (root message)
    const targetTs = lastMessageTs || threadId;
    // Convert "1767690059.430179" to "1767690059430179"
    const permalinkTs = targetTs.replace('.', '');
    if (this.teamUrl) {
      // For thread replies, we need to include thread_ts parameter
      if (lastMessageTs && lastMessageTs !== threadId) {
        return `${this.teamUrl}/archives/${this.channelId}/p${permalinkTs}?thread_ts=${threadId}&cid=${this.channelId}`;
      }
      return `${this.teamUrl}/archives/${this.channelId}/p${permalinkTs}`;
    }
    // Fallback - won't be a proper link but won't break
    return `#${targetTs}`;
  }

  /**
   * Permalink to one specific post. Slack permalinks are ts-based, so route the
   * post id (which IS the message ts) through getThreadLink's `lastMessageTs`
   * slot (the base default would use the id-slot, which Slack ignores → it would
   * fall back to the thread root).
   */
  getPostPermalink(post: PlatformPost): string {
    return this.getThreadLink(post.rootId || post.id, undefined, post.id);
  }

  // ============================================================================
  // Messaging
  // ============================================================================

  /**
   * Create a new post/message.
   * @param message - Message text
   * @param threadId - Optional thread parent ID
   * @param options - Optional settings (e.g., unfurl control)
   */
  async createPost(
    message: string,
    threadId?: string,
    options?: { unfurl?: boolean }
  ): Promise<PlatformPost> {
    // A synthetic DCM thread id is not a real message ts — resolve it to a
    // top-level channel post (direct channel mode).
    const resolvedThreadId = resolvePostThreadId(threadId);

    // Disable unfurling for channel-level posts (sticky message) by default
    // Thread messages can have previews unless explicitly disabled
    const shouldUnfurl = options?.unfurl ?? (resolvedThreadId !== undefined);

    // Truncate message if it exceeds Slack's limit to prevent msg_too_long errors
    const truncatedMessage = this.truncateMessageIfNeeded(message);

    const body: Record<string, unknown> = {
      channel: this.channelId,
      text: truncatedMessage,
      unfurl_links: shouldUnfurl,
      unfurl_media: shouldUnfurl,
    };

    if (resolvedThreadId) {
      body.thread_ts = resolvedThreadId;
    }

    const response = await this.api<PostMessageResponse>('POST', 'chat.postMessage', body);

    return {
      id: response.ts,
      platformId: this.platformId,
      channelId: response.channel,
      userId: this.botUserId || '',
      message: response.message.text,
      rootId: threadId,
      createAt: Math.floor(parseFloat(response.ts) * 1000),
    };
  }

  /**
   * Update an existing post/message.
   */
  async updatePost(postId: string, message: string): Promise<PlatformPost> {
    // Truncate message if it exceeds Slack's limit to prevent msg_too_long errors
    const truncatedMessage = this.truncateMessageIfNeeded(message);

    const response = await this.api<UpdateMessageResponse>('POST', 'chat.update', {
      channel: this.channelId,
      ts: postId,
      text: truncatedMessage,
    });

    return {
      id: response.ts,
      platformId: this.platformId,
      channelId: response.channel,
      userId: this.botUserId || '',
      message: response.text,
      createAt: Math.floor(parseFloat(response.ts) * 1000),
    };
  }

  /**
   * Get a post by ID.
   * Note: This makes an API call per post. For bulk operations, prefer getPinnedPosts
   * which returns all pinned post IDs in a single call.
   */
  async getPost(postId: string): Promise<PlatformPost | null> {
    try {
      // Use conversations.history with latest/oldest to get a specific message
      const response = await this.api<ConversationsHistoryResponse>(
        'GET',
        `conversations.history?channel=${this.channelId}&latest=${postId}&oldest=${postId}&inclusive=true&limit=1`
      );

      if (response.messages && response.messages.length > 0) {
        return this.normalizePlatformPost(response.messages[0], this.channelId);
      }

      return null;
    } catch (err) {
      log.debug(`Post ${postId.substring(0, 12)} not found: ${err}`);
      return null;
    }
  }

  /**
   * Delete a post.
   */
  async deletePost(postId: string): Promise<void> {
    log.debug(`Deleting post ${postId.substring(0, 12)}`);
    await this.api('POST', 'chat.delete', {
      channel: this.channelId,
      ts: postId,
    });
  }

  /**
   * Pin a post to the channel.
   */
  async pinPost(postId: string): Promise<void> {
    log.debug(`Pinning post ${postId.substring(0, 12)}`);
    try {
      await this.api('POST', 'pins.add', {
        channel: this.channelId,
        timestamp: postId,
      }, 0, ['already_pinned']);
    } catch (err) {
      // Ignore "already_pinned" - this is expected when re-pinning
      if (err instanceof Error && err.message.includes('already_pinned')) {
        log.debug(`Post ${postId.substring(0, 12)} already pinned`);
        return;
      }
      throw err;
    }
  }

  /**
   * Unpin a post from the channel.
   */
  async unpinPost(postId: string): Promise<void> {
    log.debug(`Unpinning post ${postId.substring(0, 12)}`);
    try {
      await this.api('POST', 'pins.remove', {
        channel: this.channelId,
        timestamp: postId,
      }, 0, ['no_pin']);
    } catch (err) {
      // Ignore "no_pin" - post wasn't pinned
      if (err instanceof Error && err.message.includes('no_pin')) {
        log.debug(`Post ${postId.substring(0, 12)} was not pinned`);
        return;
      }
      throw err;
    }
  }

  /**
   * Get all pinned posts in the channel.
   */
  async getPinnedPosts(): Promise<string[]> {
    const response = await this.api<PinsListResponse>('GET', `pins.list?channel=${this.channelId}`);

    return (response.items || [])
      .filter((item): item is typeof item & { message: NonNullable<typeof item.message> } => !!item.message)
      .map((item) => item.message.ts);
  }

  /**
   * Get platform-specific message size limits.
   * Slack markdown blocks fail at ~13K chars, so we use stricter limits.
   */
  getMessageLimits(): { maxLength: number; hardThreshold: number } {
    return { maxLength: 12000, hardThreshold: 10000 };
  }

  /**
   * Truncate a message if it exceeds Slack's message length limit.
   * Adds an ellipsis indicator when truncation occurs.
   * Properly closes any open code blocks to prevent malformed markdown.
   * This is a safety net to prevent msg_too_long errors from the API.
   */
  private truncateMessageIfNeeded(message: string): string {
    const { maxLength } = this.getMessageLimits();
    if (message.length <= maxLength) {
      return message;
    }
    log.warn(`Truncating message from ${message.length} to ~${maxLength} chars`);
    return truncateMessageSafely(message, maxLength, '_... (truncated)_');
  }

  /**
   * Get thread history (messages in a thread).
   */
  async getThreadHistory(
    threadId: string,
    options?: { limit?: number; excludeBotMessages?: boolean }
  ): Promise<ThreadMessage[]> {
    try {
      // conversations.replies paginates oldest-first, so passing the caller's
      // limit straight to the API would return the OLDEST N messages of a long
      // thread. Callers (context prompt, work summary, memory distillation)
      // want the most RECENT N — walk ALL pages via cursor pagination and
      // keep a sliding window: trimming to the limit after each page means a
      // long thread costs API calls but bounded memory, and the walk always
      // ends at the thread's newest messages. The page cap only bounds a
      // pathological thread's API cost; hitting it means the END of the
      // thread was not reached, so the newest messages are missing — say so
      // honestly instead of claiming the most recent were kept.
      //
      // WITHOUT a limit there is no window to slide — the walk would
      // accumulate every message (and a getUser call each) unbounded. A
      // no-limit caller (getThreadContextCount) gets exactly one 1000-message
      // page, the pre-walk behavior.
      const MAX_PAGES = options?.limit ? 100 : 1; // 100k messages — API-cost bound, not a memory bound
      let filtered: SlackMessage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const response = await this.api<ConversationsRepliesResponse>(
          'GET',
          `conversations.replies?channel=${this.channelId}&ts=${threadId}&limit=1000${cursorParam}`
        );
        for (const msg of response.messages || []) {
          if (options?.excludeBotMessages && this.isBotAuthored(msg)) continue;
          filtered.push(msg);
        }
        // Sliding window: each page arrives oldest-first, so after sorting,
        // trimming from the front keeps the newest seen so far.
        filtered.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
        if (options?.limit && filtered.length > options.limit) {
          filtered = filtered.slice(-options.limit);
        }
        cursor = response.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
        if (page === MAX_PAGES - 1 && options?.limit) {
          // Only the limited walk promises "the newest N" — stopping short
          // there is real context loss. The no-limit single page is the
          // documented intent, not an early stop worth alarming about.
          log.warn(`Thread ${threadId} exceeds ${MAX_PAGES * 1000} messages — walk stopped early, the NEWEST messages are missing from context`);
        }
      }

      const kept = filtered;

      const messages: ThreadMessage[] = [];
      for (const msg of kept) {
        const user = await this.getUser(msg.user || '');
        messages.push({
          id: msg.ts,
          userId: msg.user || '',
          username: user?.username || 'unknown',
          message: msg.text,
          createAt: Math.floor(parseFloat(msg.ts) * 1000),
        });
      }
      return messages;
    } catch (err) {
      log.warn(`Failed to get thread history for ${threadId}: ${err}`);
      return [];
    }
  }

  // ============================================================================
  // Reactions
  // ============================================================================

  /**
   * Add a reaction to a post.
   * Converts Unicode emoji (e.g., '👍') to Slack emoji names (e.g., '+1').
   */
  async addReaction(postId: string, emojiName: string): Promise<void> {
    // Convert Unicode emoji to name if necessary (e.g., '👍' → '+1')
    const name = getEmojiName(emojiName);
    log.debug(`Adding reaction :${name}: to post ${postId.substring(0, 12)}`);
    await this.api('POST', 'reactions.add', {
      channel: this.channelId,
      timestamp: postId,
      name,
    });
  }

  /**
   * Remove a reaction from a post.
   * Converts Unicode emoji (e.g., '👍') to Slack emoji names (e.g., '+1').
   */
  async removeReaction(postId: string, emojiName: string): Promise<void> {
    // Convert Unicode emoji to name if necessary (e.g., '👍' → '+1')
    const name = getEmojiName(emojiName);
    log.debug(`Removing reaction :${name}: from post ${postId.substring(0, 12)}`);
    await this.api('POST', 'reactions.remove', {
      channel: this.channelId,
      timestamp: postId,
      name,
    });
  }

  // ============================================================================
  // Bot Mentions
  // ============================================================================

  /**
   * Check if a message mentions the bot.
   *
   * In Slack, mentions look like <@U12345> where U12345 is the user ID.
   * We also check for @botname for convenience.
   */
  isBotMentioned(message: string): boolean {
    // Check for user ID mention format: <@U12345>
    if (this.botUserId && message.includes(`<@${this.botUserId}>`)) {
      return true;
    }

    // Also check for @botname (case-insensitive)
    const botName = escapeRegExp(this.botName);
    const mentionPattern = new RegExp(`(^|\\s)@${botName}\\b`, 'i');
    return mentionPattern.test(message);
  }

  /**
   * Extract the prompt from a message (remove bot mention).
   */
  extractPrompt(message: string): string {
    let prompt = message;

    // Remove user ID mention format: <@U12345>
    if (this.botUserId) {
      prompt = prompt.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
    }

    // Remove @botname mentions
    const botName = escapeRegExp(this.botName);
    prompt = prompt.replace(new RegExp(`(^|\\s)@${botName}\\b`, 'gi'), ' ').trim();

    return prompt;
  }

  // ============================================================================
  // Typing Indicator
  // ============================================================================

  /**
   * Show that the bot is working.
   *
   * Slack has no typing indicator for bots — the closest equivalent is
   * `assistant.threads.setStatus`, which renders a live "<App> is …" line
   * under the app name and needs only `chat:write`. It replaces itself and
   * clears when the bot posts, so there is nothing to tear down.
   *
   * Fire-and-forget: a status is a nicety, and failing to show one must never
   * interfere with the work it is describing.
   */
  /**
   * Slack error codes that mean "this workspace or channel does not offer the
   * status method", not "something went wrong". `assistant.threads.setStatus`
   * is documented as AI-assistant-threads-only and works in ordinary channels
   * today; if Slack ever tightens that, every active session would otherwise
   * warn-log roughly every 20 seconds, indefinitely. Degrading silently is the
   * whole point of the fire-and-forget shape.
   */
  private static readonly STATUS_EXPECTED_ERRORS = [
    'method_not_supported_for_channel_type',
    'missing_scope',
    'invalid_thread_ts',
    'channel_not_found',
  ];

  sendTyping(threadId?: string): void {
    const anchor = statusAnchor(threadId, this.lastProcessedTs);
    if (!anchor) return;

    const now = Date.now();
    if (!dueForRefresh(this.statusSentAt.get(anchor), now)) return;
    this.statusSentAt.set(anchor, now);
    this.pruneStatusAnchors(now);

    this.api(
      'POST',
      'assistant.threads.setStatus',
      {
        channel_id: this.channelId,
        thread_ts: anchor,
        status: STATUS_TEXT,
        loading_messages: STATUS_LOADING_MESSAGES,
      },
      0,
      SlackClient.STATUS_EXPECTED_ERRORS
    ).catch((err) => {
      // Includes workspaces where the method is unavailable. Log once at debug
      // and carry on rather than retrying a cosmetic call.
      log.debug(`setStatus failed for ${anchor}: ${err}`);
    });
  }

  /**
   * Take the working status down. Slack's status persists until something
   * replaces it, so a finished session would otherwise keep claiming to work.
   * An empty status is the documented way to clear one.
   */
  clearTyping(threadId?: string): void {
    const anchor = statusAnchor(threadId, this.lastProcessedTs);
    if (!anchor) return;

    // Forget the throttle too, so the next turn shows a status immediately
    // rather than waiting out the heartbeat window.
    this.statusSentAt.delete(anchor);

    this.api(
      'POST',
      'assistant.threads.setStatus',
      {
        channel_id: this.channelId,
        thread_ts: anchor,
        status: '',
      },
      0,
      SlackClient.STATUS_EXPECTED_ERRORS
    ).catch((err) => {
      log.debug(`clearing status failed for ${anchor}: ${err}`);
    });
  }

  /** Keep the throttle map from growing with every thread the bot ever saw. */
  private pruneStatusAnchors(now: number): void {
    if (this.statusSentAt.size <= MAX_STATUS_ANCHORS) return;
    for (const [anchor, sentAt] of this.statusSentAt) {
      if (now - sentAt > STATUS_REFRESH_MS * 10) this.statusSentAt.delete(anchor);
    }
  }

  // ============================================================================
  // Files
  // ============================================================================

  /**
   * Download a file attachment.
   */
  async downloadFile(fileId: string): Promise<Buffer> {
    log.debug(`Downloading file ${fileId}`);

    // First, get file info to get the download URL
    const fileInfo = await this.api<FilesInfoResponse>('GET', `files.info?file=${fileId}`);
    const downloadUrl = fileInfo.file.url_private_download || fileInfo.file.url_private;

    if (!downloadUrl) {
      throw new Error(`No download URL available for file ${fileId}`);
    }

    // Download with bot token authorization
    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${this.botToken}`,
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

  /**
   * Get file metadata.
   */
  async getFileInfo(fileId: string): Promise<PlatformFile> {
    const response = await this.api<FilesInfoResponse>('GET', `files.info?file=${fileId}`);
    return this.normalizePlatformFile(response.file);
  }

  /**
   * Upload a file from disk and post it into a thread via the v2 flow.
   *
   * Slack's `files.completeUploadExternal` does not always return the
   * resulting message ts; the helper logs a warning and falls back to the
   * file id in that case. The narrow `{ postId, fileId }` return shape
   * deliberately avoids a synthesized PlatformPost that could be passed to
   * updatePost/addReaction with surprising results.
   */
  async uploadFile(
    filePath: string,
    threadId: string,
    options?: { caption?: string; filename?: string },
  ): Promise<{ postId: string; fileId: string }> {
    const filename = sanitizeFilename(options?.filename ?? filePath);
    const result = await uploadFileSlack({
      botToken: this.botToken,
      channelId: this.channelId,
      threadTs: threadId,
      filePath,
      filename,
      caption: options?.caption,
      apiUrl: this.apiUrl,
    });
    return { postId: result.postId, fileId: result.fileId };
  }
}
