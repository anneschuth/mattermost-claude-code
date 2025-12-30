# Multi-Platform Architecture

## Overview

claude-threads now supports running with multiple platform instances simultaneously. You can connect to:
- Multiple Mattermost servers
- Multiple Slack workspaces (when Slack client is implemented)
- Mix of different platforms

Each platform instance maintains its own:
- WebSocket connection
- API credentials
- Channel/workspace context
- MCP permission server (for interactive permissions)

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Multiple Platforms                           │
│                                                                      │
│  ┌──────────────────┐        ┌──────────────────┐                  │
│  │ Mattermost #1    │        │ Mattermost #2    │                  │
│  │ (Internal Team)  │        │ (External Team)  │                  │
│  └────────┬─────────┘        └────────┬─────────┘                  │
│           │                           │                             │
└───────────┼───────────────────────────┼─────────────────────────────┘
            │                           │
            ▼                           ▼
    ┌───────────────┐           ┌───────────────┐
    │PlatformClient │           │PlatformClient │
    │  id='mm1'     │           │  id='mm2'     │
    └───────┬───────┘           └───────┬───────┘
            │                           │
            └───────────┬───────────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │   SessionManager      │
            │                       │
            │ platforms: Map<id,    │
            │   PlatformClient>     │
            │                       │
            │ sessions: Map<        │
            │   "id:threadId",      │
            │   Session>            │
            └───────────┬───────────┘
                        │
            ┌───────────┼───────────┐
            │           │           │
            ▼           ▼           ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │ Session  │ │ Session  │ │ Session  │
     │ mm1:t123 │ │ mm2:t456 │ │ mm1:t789 │
     │          │ │          │ │          │
     │ platform │ │ platform │ │ platform │
     │ (ref)    │ │ (ref)    │ │ (ref)    │
     └────┬─────┘ └────┬─────┘ └────┬─────┘
          │            │            │
          ▼            ▼            ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │ClaudeCli │ │ClaudeCli │ │ClaudeCli │
     │+ MCP srv │ │+ MCP srv │ │+ MCP srv │
     └──────────┘ └──────────┘ └──────────┘
```

## Key Components

### 1. PlatformClient Interface

All platform implementations must implement this interface:

```typescript
interface PlatformClient extends EventEmitter {
  // Identity
  readonly platformId: string;        // e.g., 'mattermost-internal'
  readonly platformType: string;      // e.g., 'mattermost', 'slack'
  readonly displayName: string;       // e.g., 'Internal Team'

  // Core methods
  connect(): Promise<void>;
  disconnect(): void;
  createPost(message: string, threadId?: string): Promise<PlatformPost>;
  addReaction(postId: string, emojiName: string): Promise<void>;
  getMcpConfig(): { url, token, channelId, allowedUsers };
  // ... more methods
}
```

Events emitted:
- `message` - New message received
- `reaction` - Reaction added to a post
- `connected` - Connected to platform
- `disconnected` - Disconnected from platform
- `error` - Error occurred

### 2. Normalized Types

Platform-specific types are normalized to common interfaces:

```typescript
interface PlatformPost {
  id: string;
  platformId: string;     // Which platform this is from
  channelId: string;
  userId: string;
  message: string;
  rootId?: string;
  metadata?: { files?: PlatformFile[] };
}

interface PlatformUser {
  id: string;
  username: string;
  email?: string;
}

interface PlatformReaction {
  userId: string;
  postId: string;
  emojiName: string;
  createAt?: number;
}
```

### 3. SessionManager

Manages sessions across all platforms:

```typescript
class SessionManager {
  private platforms: Map<string, PlatformClient>;
  private sessions: Map<string, Session>;  // sessionId -> Session
  private postIndex: Map<string, string>;  // "platformId:postId" -> sessionId

  addPlatform(client: PlatformClient): void;
  // Binds message/reaction handlers
}
```

**Composite Session IDs**: `"platformId:threadId"`
- Example: `"mattermost-main:a1b2c3d4"`
- Ensures uniqueness across platforms
- ThreadId alone is not unique (multiple platforms may have same thread ID)

**Post Index**: `"platformId:postId" -> sessionId`
- Routes reactions to correct session
- Handles case where multiple platforms may have same post ID

### 4. Session Structure

Each session contains:

```typescript
interface Session {
  platformId: string;        // Which platform instance
  threadId: string;          // Thread ID within that platform
  sessionId: string;         // Composite: "platformId:threadId"
  platform: PlatformClient;  // Reference to platform client

  claude: ClaudeCli;         // Claude process with MCP server
  claudeSessionId: string;   // UUID for Claude resume
  // ... state management fields
}
```

### 5. MCP Permission Server

Each Claude CLI process gets its own MCP server with platform-specific config:

```typescript
const cliOptions: ClaudeCliOptions = {
  workingDir: '/path/to/repo',
  threadId: 'abc123',
  platformConfig: {
    url: 'https://mattermost-internal.example.com',
    token: 'xoxb-...',
    channelId: 'channel123',
    allowedUsers: ['alice', 'bob']
  }
};
```

The MCP server uses this config to:
- Connect to the correct Mattermost/Slack instance
- Post permission requests to the correct channel
- Validate reactions from authorized users

## Configuration

### Multi-Platform YAML Config

```yaml
version: 1
workingDir: /home/user/repos/myproject
chrome: false
worktreeMode: prompt

platforms:
  - id: mattermost-internal
    type: mattermost
    displayName: Internal Team
    url: https://chat-internal.example.com
    token: ${MM_INTERNAL_TOKEN}
    channelId: abc123xyz
    botName: claude-code
    allowedUsers:
      - alice
      - bob
    skipPermissions: false

  - id: mattermost-external
    type: mattermost
    displayName: External Partners
    url: https://chat-partners.example.com
    token: ${MM_EXTERNAL_TOKEN}
    channelId: def456uvw
    botName: claude-helper
    allowedUsers:
      - carol
    skipPermissions: true
```

### Legacy Single-Platform Mode

Backward compatible with `.env` files:

```bash
MATTERMOST_URL=https://chat.example.com
MATTERMOST_TOKEN=xoxb-...
MATTERMOST_CHANNEL_ID=abc123
MATTERMOST_BOT_NAME=claude-code
ALLOWED_USERS=alice,bob
```

Auto-migrates to multi-platform config with `platformId='default'`.

## Data Flow

### 1. Message Reception

```
Mattermost WebSocket
  ↓ (raw event)
MattermostClient.handleEvent()
  ↓ (parse + normalize)
emit('message', PlatformPost, PlatformUser)
  ↓
SessionManager.handleMessage(platformId, post, user)
  ↓ (route to index.ts for now)
Process commands / Start session / Send follow-up
```

### 2. Reaction Handling

```
Mattermost WebSocket
  ↓ (reaction_added event)
MattermostClient.handleEvent()
  ↓ (parse + normalize)
emit('reaction', PlatformReaction, PlatformUser)
  ↓
SessionManager.handleReaction(platformId, postId, emoji, username)
  ↓ (lookup session by platformId:postId)
SessionManager.handleSessionReaction(session, postId, emoji, username)
  ↓
Handle plan approval / question answer / message approval / cancel
```

### 3. Session Creation

```
User sends message with @bot mention
  ↓
index.ts handles message
  ↓
SessionManager.startSession(options, username, threadId)
  ↓
Get platform by id='default'
  ↓
Create ClaudeCli with platform.getMcpConfig()
  ↓
Create Session with platformId, sessionId, platform ref
  ↓
Register in sessions Map with composite sessionId
  ↓
Start Claude CLI (spawns MCP server with platform config)
```

## Persistence

Session state is persisted with platform information:

```typescript
interface PersistedSession {
  platformId: string;     // NEW in v2
  threadId: string;
  claudeSessionId: string;
  startedBy: string;
  // ... other fields
}
```

**Store Version Migration**: v1 → v2
- Automatically adds `platformId='default'` to old sessions
- Maintains backward compatibility
- Seamless upgrade path

**Composite Keys**: Sessions stored with `"platformId:threadId"` as key
- Prevents collisions across platforms
- Enables multi-platform session resume

## Extending for New Platforms

To add support for Slack (or other platforms):

### 1. Implement PlatformClient

```typescript
export class SlackClient extends EventEmitter implements PlatformClient {
  readonly platformId: string;
  readonly platformType = 'slack' as const;
  readonly displayName: string;

  // Implement all required methods
  async connect(): Promise<void> { /* Socket Mode */ }
  async createPost(message, threadId): Promise<PlatformPost> { /* ... */ }
  // ... etc
}
```

### 2. Add Config Type

```typescript
export interface SlackPlatformConfig {
  id: string;
  type: 'slack';
  displayName: string;
  botToken: string;      // xoxb-...
  appToken: string;      // xapp-... (for Socket Mode)
  channelId: string;
  botName: string;
  allowedUsers: string[];
  skipPermissions: boolean;
}
```

### 3. Update Config Migration

Add Slack handling to `loadConfigWithMigration()`:

```typescript
if (platform.type === 'slack') {
  return /* parse Slack config */;
}
```

### 4. Register in index.ts

```typescript
const slackClient = new SlackClient(slackConfig);
session.addPlatform(slackClient);
await slackClient.connect();
```

That's it! The rest of the system (SessionManager, persistence, MCP servers) works automatically.

## Testing Multi-Platform

1. **Create config.yaml** with multiple platforms
2. **Set environment variables** for tokens
3. **Run** `npm start`
4. **Verify** each platform connects
5. **Test** starting sessions from different platforms
6. **Test** permissions work correctly per platform
7. **Test** session resume after restart

## Benefits

- **Isolation**: Each platform instance is independent
- **Scalability**: Add platforms without code changes
- **Security**: Separate credentials per platform
- **Flexibility**: Mix different platforms, different permissions
- **Maintainability**: Clean abstraction layers
