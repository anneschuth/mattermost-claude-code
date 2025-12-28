# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.3] - 2025-12-28

### Fixed
- Actually fix `!cd` showing "[Exited: null]" - reset flag in async exit handler, not synchronously

## [0.7.2] - 2025-12-28

### Fixed
- Fix `!cd` command showing "[Exited: null]" message - now properly suppresses exit message during intentional restart

## [0.7.1] - 2025-12-28

### Fixed
- Fix infinite loop when plan is approved - no longer sends "Continue" message on subsequent ExitPlanMode calls

## [0.7.0] - 2025-12-28

### Added
- **`!cd <path>` command** - Change working directory mid-session
- Restarts Claude Code in the new directory with fresh context
- Session header updates to show current working directory
- Validates directory exists before switching

## [0.6.1] - 2025-12-28

### Changed
- Cleaner console output: removed verbose `[Session]` prefixes from logs
- Debug-only logging for internal session state changes (plan approval, question handling)
- Consistent emoji formatting for all log messages

## [0.6.0] - 2025-12-28

### Added
- **Auto-update notifications** - shows banner in session header when new version is available
- Checks npm registry on startup for latest version
- Update notice includes install command: `npm install -g mattermost-claude-code`

## [0.5.9] - 2025-12-28

### Fixed
- Security fix: sanitize bot username in regex to prevent injection

## [0.5.8] - 2025-12-28

### Changed
- Commands now use `!` prefix instead of `/` to avoid Mattermost slash command conflicts
- `!help`, `!invite`, `!kick`, `!permissions`, `!stop` replace `/` versions
- Commands without prefix (`help`, `stop`, `cancel`) still work

## [0.5.7] - 2025-12-28

### Fixed
- Bot now recognizes mentions with hyphens in username (e.g., `@annes-minion`)
- Side conversation detection regex updated to handle full Mattermost usernames

## [0.5.6] - 2025-12-28

### Added
- Timeout warning 5 minutes before session expires
- Warning message tells user to send a message to keep session alive
- Warning resets if activity resumes

## [0.5.5] - 2025-12-28

### Added
- `/help` command to show available session commands

### Changed
- Replace ASCII diagram with Mermaid flowchart in README

## [0.5.4] - 2025-12-28 (not released)

### Added
- `/help` command to show available session commands

## [0.5.3] - 2025-12-28

### Added
- `/permissions interactive` command to enable interactive permissions for a session
- Can only downgrade permissions (auto → interactive), not upgrade
- Session header updates to show current permission mode

## [0.5.2] - 2025-12-28

### Changed
- Complete README rewrite with full documentation of all features

## [0.5.1] - 2025-12-28

### Added
- `--no-skip-permissions` flag to enable interactive permissions even when `SKIP_PERMISSIONS=true` is set in env

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
