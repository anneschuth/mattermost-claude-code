# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2025-12-28

### Added
- **Session collaboration** - invite users to specific sessions without global access
- **`/invite @username`** - Temporarily allow a user to participate in the current session
- **`/kick @username`** - Remove an invited user from the current session
- **Message approval flow** - When unauthorized users send messages in a session thread, the session owner/allowed users can approve via reactions:
  - 👍 Allow this single message
  - ✅ Invite them to the session
  - 👎 Deny the message
- Per-session allowlist tracked via `sessionAllowedUsers` in each session
- **Side conversation support** - Messages starting with `@someone-else` are ignored, allowing users to chat without triggering the bot
- **Dynamic session header** - The session start message updates to show current participants when users are invited or kicked

### Changed
- Session owner is automatically added to session allowlist
- Authorization checks now use `isUserAllowedInSession()` for follow-ups
- Globally allowed users can still access all sessions

## [0.4.0] - 2025-12-28

### Added
- **CLI arguments** to override all config options (`--url`, `--token`, `--channel`, etc.)
- **Interactive onboarding** when no `.env` file exists - guided setup with help text
- Full `--help` output with all available options
- `--debug` flag to enable verbose logging

### Changed
- Switched from manual arg parsing to `commander` for better CLI experience
- Config now supports: CLI args > environment variables > defaults

## [0.3.4] - 2025-12-27

### Added
- Cancel sessions with `/stop`, `/cancel`, `stop`, or `cancel` commands in thread
- Cancel sessions by reacting with ❌ or 🛑 to any post in the thread

## [0.3.3] - 2025-12-27

### Added
- WebSocket heartbeat to detect dead connections after laptop sleep/idle
- Automatic reconnection when connection goes silent for 60+ seconds
- Ping every 30 seconds to keep connection alive

### Fixed
- Connections no longer go "zombie" after laptop sleep - mm-claude now detects and reconnects

## [0.3.2] - 2025-12-27

### Fixed
- Session card now correctly shows "mm-claude" instead of "Claude Code"

## [0.3.1] - 2025-12-27

### Changed
- Cleaner console output with colors (verbose logs only shown with `DEBUG=1`)
- Pimped session start card in Mattermost with version, directory, user, session count, permissions mode, and prompt preview
- Typing indicator starts immediately when session begins
- Shortened thread IDs in logs for readability

## [0.3.0] - 2025-12-27

### Added
- **Multiple concurrent sessions** - each Mattermost thread gets its own Claude CLI process
- Sessions tracked via `sessions: Map<threadId, Session>` and `postIndex: Map<postId, threadId>`
- Configurable session limits via `MAX_SESSIONS` env var (default: 5)
- Automatic idle session cleanup via `SESSION_TIMEOUT_MS` env var (default: 30 min)
- `killAllSessions()` for graceful shutdown of all sessions
- Session count logging for monitoring

### Changed
- `SessionManager` now manages multiple sessions instead of single session
- `sendFollowUp(threadId, message)` takes threadId parameter
- `isInSessionThread(threadId)` replaces `isInCurrentSessionThread()`
- `killSession(threadId)` takes threadId parameter

### Fixed
- Reaction routing now uses post index lookup for correct session targeting

## [0.2.3] - 2025-12-27

### Added
- GitHub Actions workflow for automated npm publishing on release

## [0.2.2] - 2025-12-27

### Added
- Comprehensive `CLAUDE.md` with project documentation for AI assistants

## [0.2.1] - 2025-12-27

### Added
- `--version` / `-v` flag to display version
- Version number shown in `--help` output

### Changed
- Lazy config loading (no .env file needed for --version/--help)

## [0.2.0] - 2025-12-27

### Added
- Interactive permission approval via Mattermost reactions
- Permission prompts forwarded to Mattermost thread
- React with 👍 to allow, ✅ to allow all, or 👎 to deny
- Only authorized users (ALLOWED_USERS) can approve permissions
- MCP-based permission server using Claude Code's `--permission-prompt-tool`
- `SKIP_PERMISSIONS` env var to control permission behavior

### Changed
- Permissions are now interactive by default (previously skipped)
- Use `SKIP_PERMISSIONS=true` or `--dangerously-skip-permissions` to skip

## [0.1.0] - 2024-12-27

### Added
- Initial release
- Connect Claude Code CLI to Mattermost channels
- Real-time streaming of Claude responses
- Interactive plan approval with emoji reactions
- Sequential question flow with emoji answers
- Task list display with live updates
- Code diffs for Edit operations
- Content preview for Write operations
- Subagent status tracking
- Typing indicator while Claude is processing
- User allowlist for access control
- Bot mention detection for triggering sessions
