# Claude Code Instructions for claude-threads

## What This Project Does

This is a multi-platform bot that lets users interact with Claude Code through chat platforms. When someone @mentions the bot in a channel, it spawns a Claude Code CLI session in a configured working directory and streams all output to a thread. The user can continue the conversation by replying in the thread.

**Currently Supported Platforms:**
- Mattermost (full support)
- Slack (architecture ready, implementation pending)

**Key Features:**
- Real-time streaming of Claude responses to chat platforms
- **Multi-platform support** - connect to multiple Mattermost/Slack instances simultaneously
- **Multiple concurrent sessions** - one per thread, across all platforms
- **Session persistence** - sessions resume automatically after bot restart
- **Session collaboration** - `!invite @user` to temporarily allow users in a session
- **Message approval** - unauthorized users can request approval for their messages
- Interactive permission approval via emoji reactions
- Plan approval and question answering via reactions
- Task list display with live updates
- Code diffs and file previews
- Multi-user access control
- Automatic idle session cleanup

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Chat Platform                               │
│  ┌──────────────┐                    ┌──────────────────────┐   │
│  │ User message │ ───WebSocket───▶  │   PlatformClient     │   │
│  │ + reactions  │ ◀───────────────  │   (Mattermost/Slack) │   │
│  └──────────────┘                    └──────────┬───────────┘   │
└─────────────────────────────────────────────────┼───────────────┘
                                                  │
                      ┌───────────────────────────┴────────────────┐
                      │              SessionManager                 │
                      │  - Orchestrates session lifecycle           │
                      │  - Delegates to specialized modules         │
                      │  - sessions: Map<sessionId, Session>        │
                      │  - postIndex: Map<postId, threadId>         │
                      └───────────────────────────┬────────────────┘
                                                  │
                              ┌───────────────────┼───────────────────┐
                              │                   │                   │
                              ▼                   ▼                   ▼
                      ┌───────────┐       ┌───────────┐       ┌───────────┐
                      │  Session  │       │  Session  │       │  Session  │
                      │ (thread1) │       │ (thread2) │       │ (thread3) │
                      └─────┬─────┘       └─────┬─────┘       └─────┬─────┘
                            │                   │                   │
                            ▼                   ▼                   ▼
                      ┌───────────┐       ┌───────────┐       ┌───────────┐
                      │ ClaudeCli │       │ ClaudeCli │       │ ClaudeCli │
                      │ + MCP srv │       │ + MCP srv │       │ + MCP srv │
                      └───────────┘       └───────────┘       └───────────┘
```

**Session contains:**
- `claude: ClaudeCli` - the Claude CLI process
- `claudeSessionId: string` - UUID for session persistence/resume
- `pendingApproval`, `pendingQuestionSet`, `pendingMessageApproval` - interactive state
- `sessionAllowedUsers: Set<string>` - per-session allowlist (includes session owner)
- `updateTimer`, `typingTimer` - per-session timers
- `activeSubagents: Map<toolUseId, postId>` - subagent tracking
- `isResumed: boolean` - whether session was resumed after restart

**MCP Permission Server:**
- Spawned via `--mcp-config` per Claude CLI instance
- Each has its own WebSocket/connection to the platform
- Posts permission requests to the session's thread
- Returns allow/deny based on user reaction

## Multi-Platform Support

**Architecture**: claude-threads supports connecting to multiple chat platforms simultaneously through a platform abstraction layer.

**Currently Supported**:
- ✅ Mattermost (fully implemented)
- 🔄 Slack (architecture ready, awaiting implementation)

**Key Concepts**:

1. **Platform Abstraction**: `PlatformClient` interface normalizes differences between platforms
2. **Composite Session IDs**: Sessions are identified by `"platformId:threadId"` to ensure uniqueness across platforms
3. **Independent Credentials**: Each platform instance has its own URL, token, and channel configuration
4. **Per-Platform MCP Servers**: Each session's MCP permission server connects to the correct platform

**Configuration**:

Multi-platform mode uses YAML config (`~/.config/claude-threads/config.yaml`):

```yaml
version: 1
workingDir: /home/user/repos/myproject
chrome: false
worktreeMode: prompt

platforms:
  - id: mattermost-main
    type: mattermost
    displayName: Main Team
    url: https://chat.example.com
    token: your-bot-token-here
    channelId: abc123
    botName: claude-code
    allowedUsers: [alice, bob]
    skipPermissions: false
```

Configuration is stored in YAML only - no `.env` file support.

## Source Files

### Core
| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point. CLI parsing, bot startup, message routing |
| `src/config.ts` | Type exports for config (re-exports from migration.ts) |
| `src/config/migration.ts` | YAML config loading (`config.yaml`) |
| `src/onboarding.ts` | Interactive setup wizard for multi-platform config |

### Session Management (Modular Architecture)

The session management is split into focused modules for maintainability:

| File | Lines | Purpose |
|------|-------|---------|
| `src/session/manager.ts` | ~635 | **Orchestrator** - thin wrapper that delegates to modules |
| `src/session/lifecycle.ts` | ~590 | Session start, resume, exit, cleanup |
| `src/session/events.ts` | ~480 | Claude CLI event handling (assistant, tool_use, etc.) |
| `src/session/commands.ts` | ~510 | User commands (!cd, !invite, !kick, !permissions) |
| `src/session/reactions.ts` | ~210 | Emoji reaction handling (approvals, questions) |
| `src/session/worktree.ts` | ~520 | Git worktree management |
| `src/session/streaming.ts` | ~180 | Message batching and flushing to chat |
| `src/session/types.ts` | ~130 | TypeScript types (Session, PendingApproval, etc.) |
| `src/session/index.ts` | ~15 | Public exports |

**Design Pattern**: SessionManager uses dependency injection via context objects to delegate to modules while maintaining a clean public API.

### Claude CLI
| File | Purpose |
|------|---------|
| `src/claude/cli.ts` | Spawns Claude CLI with platform-specific MCP config |
| `src/claude/types.ts` | TypeScript types for Claude stream-json events |

### Platform Layer
| File | Purpose |
|------|---------|
| `src/platform/client.ts` | PlatformClient interface (abstraction for all platforms) |
| `src/platform/types.ts` | Normalized types (PlatformPost, PlatformUser, PlatformReaction, etc.) |
| `src/platform/formatter.ts` | PlatformFormatter interface (markdown dialects) |
| `src/platform/index.ts` | Public exports |
| `src/platform/mattermost/client.ts` | Mattermost implementation of PlatformClient |
| `src/platform/mattermost/types.ts` | Mattermost-specific types |
| `src/platform/mattermost/formatter.ts` | Mattermost markdown formatter |

### Utilities
| File | Purpose |
|------|---------|
| `src/utils/emoji.ts` | Emoji constants and validators (platform-agnostic) |
| `src/utils/tool-formatter.ts` | Format tool use for display |
| `src/utils/logger.ts` | MCP-compatible logging |
| `src/mcp/permission-server.ts` | MCP server for permission prompts (platform-agnostic) |
| `src/platform/permission-api-factory.ts` | Factory for platform-specific permission APIs |
| `src/platform/permission-api.ts` | PermissionApi interface |
| `src/mattermost/api.ts` | Standalone Mattermost API helpers |
| `src/persistence/session-store.ts` | Multi-platform session persistence |
| `src/logo.ts` | ASCII art logo |

## How the Permission System Works

1. **Claude CLI is started with:**
   ```
   claude --input-format stream-json --output-format stream-json --verbose \
     --mcp-config '{"mcpServers":{"claude-threads-permissions":{...}}}' \
     --permission-prompt-tool mcp__claude-threads-permissions__permission_prompt
   ```

2. **When Claude needs permission** (e.g., to write a file), it calls the MCP tool

3. **The MCP server** (running as a subprocess):
   - Receives the permission request via stdio
   - Posts a message to the chat thread: "⚠️ Permission requested: Write `file.txt`"
   - Adds reaction options (👍 ✅ 👎) to the message
   - Opens a WebSocket to the platform and waits for a reaction

4. **User reacts** with an emoji

5. **MCP server**:
   - Validates the user is in ALLOWED_USERS
   - Ignores bot's own reactions (the reaction options)
   - Returns `{behavior: "allow"}` or `{behavior: "deny"}` to Claude CLI

6. **Claude CLI** proceeds or aborts based on the response

## Configuration

Configuration is stored in YAML at `~/.config/claude-threads/config.yaml`.

**First run:** If no config exists, interactive onboarding guides you through setup.

### Environment Variables (Optional)

| Variable | Description |
|----------|-------------|
| `MAX_SESSIONS` | Max concurrent sessions (default: `5`) |
| `SESSION_TIMEOUT_MS` | Idle session timeout in ms (default: `1800000` = 30 min) |
| `DEBUG` | Set `1` for debug logging |
| `CLAUDE_PATH` | Custom path to claude binary (default: `claude`) |

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run dev          # Run from source with tsx watch
npm start            # Run compiled version
npm test             # Run tests (125 tests)
npm run lint         # Run ESLint
```

## Testing Locally

1. Create config: `~/.config/claude-threads/config.yaml` (or run `claude-threads` for interactive setup)
2. Build: `npm run build`
3. Run: `npm start` (or `DEBUG=1 npm start` for verbose output)
4. In Mattermost, @mention the bot: `@botname write "hello" to test.txt`
5. Watch the permission prompt appear, react with 👍
6. Verify file was created

## Publishing a New Version

Releases are automated via GitHub Actions. When you create a GitHub release, it automatically publishes to npm.

**IMPORTANT: Always test locally before pushing!**
```bash
# 0. Build and run locally to test
npm run build && npm start
# Test in Mattermost: https://digilab.overheid.nl/chat/digilab/channels/annes-claude-code-sessies
# Kill the server when done testing (Ctrl+C)
```

```bash
# 1. Update CHANGELOG.md with the new version

# 2. Commit the changelog
git add CHANGELOG.md && git commit -m "Update CHANGELOG for vX.Y.Z"

# 3. Bump version (this commits and creates a git tag)
npm version patch   # 0.2.1 → 0.2.2
npm version minor   # 0.2.1 → 0.3.0
npm version major   # 0.2.1 → 1.0.0

# 4. Push to GitHub with tags
git push && git push --tags

# 5. Create GitHub release (this triggers automatic npm publish)
gh release create v0.x.x --title "v0.x.x" --generate-notes
```

**GitHub Actions Workflow:** `.github/workflows/publish.yml`
- Triggered on: GitHub release published
- Builds TypeScript and publishes to npm
- Requires `NPM_TOKEN` secret in repository settings

**⚠️ IMPORTANT: NEVER modify the workflow trigger!**
- The workflow MUST trigger on `release: types: [published]`
- NEVER change it to trigger on tag pushes
- The user creates releases manually via `gh release create`
- This is the preferred release workflow - do not change it

**npm Token Setup (already configured):**
- Classic Automation token stored in GitHub repository secrets as `NPM_TOKEN`
- To update: https://github.com/anneschuth/claude-threads/settings/secrets/actions

## Testing Deployed Versions in Mattermost

After deploying a new version, test it in the Mattermost channel:
https://digilab.overheid.nl/chat/digilab/channels/annes-claude-code-sessies

### Basic Verification
1. **Check version**: `@minion-of-anne what version are you running?`
   - Bot should respond with version number and summary of recent changes
   - Verify the session header shows correct version

### Testing Permission System
1. **Start a new session** (existing sessions keep their original permission mode)
2. **Enable interactive permissions**: `!permissions interactive`
   - Should see: "🔐 **Interactive permissions enabled** ... *Claude Code restarted with permission prompts*"
   - Session header should update to show "Permissions: Interactive"
3. **Test permission prompt**: `@minion-of-anne write "test" to /tmp/perm-test.txt`
   - Should see a permission prompt with reaction options: 👍 ✅ 👎
   - React with 👍 to approve
   - File should be written after approval

### Testing Other Features
- **Session collaboration**: `!invite @username` / `!kick @username`
- **Directory change**: `!cd /some/path` (restarts Claude CLI)
- **Interrupt**: `!escape` or ⏸️ reaction (interrupts without killing)
- **Cancel**: `!stop` or ❌/🛑 reaction (kills the session)
- **Plan approval**: When Claude presents a plan, react with 👍/👎
- **Question answering**: When Claude asks questions, react with number emojis

### Verifying Specific Bug Fixes
When testing a specific fix:
1. Reproduce the original bug scenario
2. Verify the fix works as expected
3. Check for regressions in related functionality

## Common Issues & Solutions

### "Permission server not responding"
- Check that `MATTERMOST_URL` and `MATTERMOST_TOKEN` are passed to MCP server
- Look for `[MCP]` prefixed logs in stderr
- Enable `DEBUG=1` for verbose MCP logging

### "Reaction not detected"
- The MCP server has its own WebSocket connection (separate from main bot)
- Check that the reacting user is in `ALLOWED_USERS`
- Bot's own reactions (adding the 👍 ✅ 👎 options) are filtered out

### "Claude CLI not found"
- Ensure `claude` is in PATH, or set `CLAUDE_PATH` environment variable
- The CLI must support `--permission-prompt-tool` (recent versions)

### "MCP config schema error"
- The config must be wrapped: `{"mcpServers": {"name": {"type": "stdio", ...}}}`
- Check `src/claude/cli.ts` for the exact format

### "TypeScript build errors"
- Run `npm install` to ensure dependencies are up to date
- Check for type mismatches in event handling

## Debugging with Claude Code History

Claude Code stores all conversation history on disk, which is invaluable for debugging:

```
~/.claude/
├── history.jsonl          # Index of all sessions (metadata only)
├── projects/              # Full conversation transcripts
│   └── -Users-username-project/   # Encoded path (/ → -)
│       ├── session-id-1.jsonl     # Full conversation
│       └── session-id-2.jsonl
├── todos/                 # Todo lists per session
└── settings.json          # User settings
```

**Useful debugging commands:**
```bash
# List recent sessions
tail -20 ~/.claude/history.jsonl | jq -r '.cwd + " " + .name'

# Find sessions for this project
ls ~/.claude/projects/-Users-anneschuth-mattermost-claude-code/

# View a specific session's conversation
cat ~/.claude/projects/-Users-anneschuth-mattermost-claude-code/SESSION_ID.jsonl | jq .
```

**Key points:**
- Directory names are encoded: `/path/to/project/` → `-path-to-project`
- Each session gets a JSONL file with full conversation history
- Consider backing up `~/.claude/` regularly

## Key Implementation Details

### Event Flow (src/session/events.ts)
Claude CLI emits JSON events. Key event types:
- `assistant` → Claude's text response (streamed in chunks)
- `tool_use` → Claude wants to use a tool (Read, Write, Bash, etc.)
- `tool_result` → Result of tool execution
- `result` → Final result with cost info

### Message Streaming (src/session/streaming.ts)
- Messages are batched and flushed periodically
- Long content is split across multiple posts (16K limit)
- Diffs and code blocks use syntax highlighting

### Reaction Handling (src/session/reactions.ts + MCP server)
- Main bot handles: plan approval, question answers, message approval
- MCP server handles: permission prompts
- Both filter to only process allowed users' reactions

## Future Improvements to Consider

- [ ] Implement Slack platform support
- [ ] Add rate limiting for API calls
- [x] Support file uploads via chat attachments - **Done**
- [x] Support multiple concurrent sessions (different threads) - **Done in v0.3.0**
- [x] Add `!stop` command to abort running session - **Done in v0.3.4** (also ❌/🛑 reactions)
- [x] CLI arguments and interactive onboarding - **Done in v0.4.0**
- [x] Session collaboration (`!invite`, `!kick`, message approval) - **Done in v0.5.0**
- [x] Persist session state for recovery after restart - **Done in v0.9.0**
- [x] Add `!escape` command to interrupt without killing session - **Done in v0.10.0** (also ⏸️ reaction)
- [x] Add `!kill` command to emergency shutdown all sessions and exit - **Done in v0.10.0**
- [x] Multi-platform architecture - **Done in v0.14.0**
- [x] Modular session management - **Done in v0.14.0**
- [ ] Add rate limiting for API calls
- [ ] Support file uploads via Mattermost attachments
- [ ] Keep task list at the bottommost message (always update to latest position)
- [ ] Session restart improvements: verify all important state is preserved (cwd ✓, permissions ✓, worktree ✓)
