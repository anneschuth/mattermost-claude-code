# Claude Code Instructions for mattermost-claude-code

## What This Project Does

This is a Mattermost bot that lets users interact with Claude Code through Mattermost. When someone @mentions the bot in a channel, it spawns a Claude Code CLI session in a configured working directory and streams all output to a Mattermost thread. The user can continue the conversation by replying in the thread.

**Key Features:**
- Real-time streaming of Claude responses to Mattermost
- **Multiple concurrent sessions** - one per Mattermost thread
- **Session persistence** - sessions resume automatically after bot restart
- **Session collaboration** - `/invite @user` to temporarily allow users in a session
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
│                         Mattermost                               │
│  ┌──────────────┐                    ┌──────────────────────┐   │
│  │ User message │ ───WebSocket───▶  │   MattermostClient   │   │
│  │ + reactions  │ ◀───────────────  │   (main bot)         │   │
│  └──────────────┘                    └──────────┬───────────┘   │
└─────────────────────────────────────────────────┼───────────────┘
                                                  │
                      ┌───────────────────────────┴────────────────┐
                      │              SessionManager                 │
                      │  - Manages MULTIPLE concurrent sessions     │
                      │  - Each session tied to a Mattermost thread │
                      │  - sessions: Map<threadId, Session>         │
                      │  - postIndex: Map<postId, threadId>         │
                      │  - Periodic cleanup of idle sessions        │
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
- Each has its own WebSocket to Mattermost
- Posts permission requests to the session's thread
- Returns allow/deny based on user reaction

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point. CLI parsing with Commander, starts bot, handles shutdown |
| `src/config.ts` | Loads config from CLI args / .env files, exports Config type |
| `src/onboarding.ts` | Interactive setup wizard when no config exists |
| `src/claude/cli.ts` | Spawns Claude CLI with correct flags, configures MCP server |
| `src/claude/session.ts` | Core logic: handles Claude events, formats for Mattermost, manages state |
| `src/claude/types.ts` | TypeScript types for Claude stream-json events |
| `src/mattermost/client.ts` | WebSocket connection, API calls, event parsing |
| `src/mattermost/message-formatter.ts` | Converts Claude output (diffs, code, tasks) to Mattermost markdown |
| `src/mattermost/types.ts` | Mattermost API types |
| `src/mcp/permission-server.ts` | MCP server for handling permission prompts via Mattermost reactions |
| `src/persistence/session-store.ts` | Persists session state to JSON for resume after restart |
| `.github/workflows/publish.yml` | GitHub Actions workflow for automated npm publishing |

## How the Permission System Works

1. **Claude CLI is started with:**
   ```
   claude --input-format stream-json --output-format stream-json --verbose \
     --mcp-config '{"mcpServers":{"mm-claude-permissions":{...}}}' \
     --permission-prompt-tool mcp__mm-claude-permissions__permission_prompt
   ```

2. **When Claude needs permission** (e.g., to write a file), it calls the MCP tool

3. **The MCP server** (running as a subprocess):
   - Receives the permission request via stdio
   - Posts a message to the Mattermost thread: "⚠️ Permission requested: Write `file.txt`"
   - Adds reaction options (👍 ✅ 👎) to the message
   - Opens a WebSocket to Mattermost and waits for a reaction

4. **User reacts** with an emoji

5. **MCP server**:
   - Validates the user is in ALLOWED_USERS
   - Ignores bot's own reactions (the reaction options)
   - Returns `{behavior: "allow"}` or `{behavior: "deny"}` to Claude CLI

6. **Claude CLI** proceeds or aborts based on the response

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MATTERMOST_URL` | Yes | Mattermost server URL (e.g., `https://chat.example.com`) |
| `MATTERMOST_TOKEN` | Yes | Bot access token |
| `MATTERMOST_CHANNEL_ID` | Yes | Channel ID where bot listens |
| `MATTERMOST_BOT_NAME` | No | Bot username for @mentions (default: `claude-code`) |
| `ALLOWED_USERS` | No | Comma-separated usernames who can use the bot |
| `SKIP_PERMISSIONS` | No | Set `true` to skip permission prompts |
| `MAX_SESSIONS` | No | Max concurrent sessions (default: `5`) |
| `SESSION_TIMEOUT_MS` | No | Idle session timeout in ms (default: `1800000` = 30 min) |
| `DEBUG` | No | Set `1` for debug logging |
| `CLAUDE_PATH` | No | Custom path to claude binary (default: `claude`) |

**Config priority** (highest to lowest):
1. CLI arguments (`--url`, `--token`, `--channel`, etc.)
2. `./.env` (current directory)
3. `~/.config/mm-claude/.env`
4. `~/.mm-claude.env`

**First run:** If no config exists and no CLI args provided, interactive onboarding guides you through setup.

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run dev          # Run from source with tsx watch
npm start            # Run compiled version
npm test             # (no tests yet)
```

## Testing Locally

1. Create config: `~/.config/mm-claude/.env`
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
- To update: https://github.com/anneschuth/mattermost-claude-code/settings/secrets/actions

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

## Key Implementation Details

### Event Flow (session.ts)
Claude CLI emits JSON events. Key event types:
- `assistant` → Claude's text response (streamed in chunks)
- `tool_use` → Claude wants to use a tool (Read, Write, Bash, etc.)
- `tool_result` → Result of tool execution
- `result` → Final result with cost info

### Message Formatting (message-formatter.ts)
- Diffs are formatted with syntax highlighting
- Code blocks use language-specific fencing
- Long content is truncated with "..." indicators
- Task lists rendered as checkbox markdown

### Reaction Handling (session.ts + client.ts)
- Main bot handles: plan approval, question answers
- MCP server handles: permission prompts
- Both filter to only process allowed users' reactions

## Future Improvements to Consider

- [ ] Add unit tests
- [x] Support multiple concurrent sessions (different threads) - **Done in v0.3.0**
- [x] Add `/cancel` command to abort running session - **Done in v0.3.4** (also ❌/🛑 reactions)
- [x] CLI arguments and interactive onboarding - **Done in v0.4.0**
- [x] Session collaboration (`/invite`, `/kick`, message approval) - **Done in v0.5.0**
- [x] Persist session state for recovery after restart - **Done in v0.9.0**
- [x] Add `!escape` command to interrupt without killing session - **Done in v0.10.0** (also ⏸️ reaction)
- [x] Add `!kill` command to emergency shutdown all sessions and exit - **Done in v0.10.0**
- [ ] Add rate limiting for API calls
- [ ] Support file uploads via Mattermost attachments
