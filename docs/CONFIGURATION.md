# Configuration Reference

Configuration is stored at `~/.config/claude-threads/config.yaml`.

## Full Example

```yaml
version: 1
workingDir: /home/user/repos/myproject
chrome: false
worktreeMode: prompt
respondOnlyWhenMentioned: false
userAttribution: true

platforms:
  # Mattermost
  - id: mattermost-main
    type: mattermost
    displayName: Main Team
    url: https://chat.example.com
    token: your-bot-token
    channelId: abc123
    botName: claude-code
    allowedUsers: [alice, bob]
    permissionMode: default
    memory: true                  # persistent memory (default on; see Memory below)

  # Slack
  - id: slack-eng
    type: slack
    displayName: Engineering
    botToken: xoxb-your-bot-token
    appToken: xapp-your-app-token
    channelId: C0123456789
    botName: claude
    allowedUsers: [alice, bob]
    permissionMode: default
```

## Global Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `version` | Config schema version | `1` |
| `workingDir` | Default working directory for Claude | Current directory |
| `chrome` | Enable Chrome integration | `false` |
| `worktreeMode` | Git worktree mode: `off`, `prompt`, or `require` | `prompt` |
| `respondOnlyWhenMentioned` | Start new threads in quiet mode, where the bot only replies to messages that @mention it. Users can still toggle per-thread with `!mentions`. | `false` |
| `userAttribution` | Prefix each user turn sent to Claude with the sender's `[@username]:` so Claude can tell who is speaking in multi-user threads. Only applied once a thread has more than one participant (after `!invite`); solo threads are left untouched. Set `false` to disable. Applies to new sessions. | `true` |
| `keepAlive` | Prevent system sleep while sessions are active | `true` |
| `limits` | Resource limits and timeouts (see below) | see below |
| `threadLogs` | Thread logging (see below) | enabled |
| `stickyMessage` | Sticky message text customization (see below) | none |
| `claudeAccounts` | Multi-account pool (see below) | single-account mode |

### Resource Limits (`limits`)

Every field is optional and falls back to the default. Older `config.yaml` files predate most of these, so leaving the block out is fine.

```yaml
limits:
  maxSessions: 5
  sessionTimeoutMinutes: 30
  sessionWarningMinutes: 5
  cleanupIntervalMinutes: 60
  maxWorktreeAgeHours: 24
  cleanupWorktrees: true
  permissionTimeoutSeconds: 120
  flushDelayMs: 500
```

| Setting | Description | Default |
|---------|-------------|---------|
| `maxSessions` | Maximum concurrent sessions | `5` |
| `sessionTimeoutMinutes` | Idle timeout before a session auto-terminates | `30` |
| `sessionWarningMinutes` | Warn the user this many minutes before timeout | `5` |
| `cleanupIntervalMinutes` | How often the background cleanup runs | `60` |
| `maxWorktreeAgeHours` | Clean up orphaned worktrees older than this | `24` |
| `cleanupWorktrees` | Enable automatic cleanup of orphaned worktrees | `true` |
| `permissionTimeoutSeconds` | How long a permission prompt waits for a reaction | `120` |
| `flushDelayMs` | Delay before flushing batched output to the platform. Lower is snappier with more API calls; higher posts less often with coarser streaming. | `500` |

The legacy env vars `MAX_SESSIONS` and `SESSION_TIMEOUT_MS` still work as fallbacks when `limits.maxSessions` / `limits.sessionTimeoutMinutes` are unset. See [Environment Variables](#environment-variables).

### Thread Logs (`threadLogs`)

```yaml
threadLogs:
  enabled: true
  retentionDays: 30
```

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Write per-thread session logs to disk | `true` |
| `retentionDays` | Delete logs this many days after a session ends | `30` |

### Sticky Message Text (`stickyMessage`)

Customize the text of the channel sticky message. This is distinct from the per-platform `stickyMessage: <mode>` visibility field documented under [Platform Settings](#platform-settings).

```yaml
stickyMessage:
  description: "Porygon — Mixpanel analytics bot"
  footer: "• !stop — End session\n• !help — Show help"
```

| Setting | Description | Default |
|---------|-------------|---------|
| `description` | Line shown below the sticky title | none |
| `footer` | Content shown before the default "Mention me to start a session" line | none |

### Transcription (`transcription`)

Speech-to-text for inbound audio attachments, so a voice note is a message and not just a `.webm` on disk. Applies to every platform. Without this block, audio files are saved and listed like any other attachment.

```yaml
transcription:
  provider: elevenlabs
  apiKey: your-elevenlabs-key
  model: scribe_v2
  languageCode: hrv
```

| Setting | Description | Default |
|---------|-------------|---------|
| `provider` | Speech-to-text provider. Only `elevenlabs` (Scribe) today; the field is the seam for others. | required |
| `apiKey` | Provider API key. Keep it in this `0600` file, never in a repo. | required |
| `model` | Provider model id | `scribe_v2` |
| `languageCode` | Language hint, passed through verbatim (ElevenLabs accepts ISO-639-1 and ISO-639-3). Omit to auto-detect. | auto-detect |

Per-platform opt-out:

```yaml
platforms:
  - id: legal
    transcription: false    # this channel's audio never leaves the box
```

The provider and its key are a property of the **deployment** — one vendor account per daemon — so they live at the top level. Whether a given channel's audio should be sent to that vendor is a property of the **channel**, which is what `transcription: false` answers. It gates every path that could reach the vendor, including watch evaluation.

⚠️ **A transcript is user input, not narration.** It reaches Claude as message text and is evaluated by watches exactly as a typed message is — deliberately, so a watch on "deploy" fires when somebody says "deploy" out loud rather than only when they type it. The usual prompt-injection caution therefore applies in full: a voice note can say "ignore your instructions" as easily as a typed message can, and anyone who can post audio in the channel can attempt it. Treat the audio surface as exactly as trusted as the text one, because it is.

What happens: every `audio/*` attachment (or a file with an audio extension when the platform only reported a generic type) is transcribed after it is saved. Claude receives the usual file list **and** a `[Transcript of voice.webm (elevenlabs):]` block, and the bot posts the transcript back into the thread as a quote so everyone can see what Claude heard. A transcription failure is reported like a skipped file — the audio file itself still reaches Claude. A bad `provider` or missing `apiKey` fails the boot. Details: [`docs/audio-transcription-spec.md`](audio-transcription-spec.md).

## Platform Settings

### Mattermost

| Setting | Required | Description |
|---------|----------|-------------|
| `id` | Yes | Unique identifier for this platform |
| `type` | Yes | Must be `mattermost` |
| `displayName` | No | Human-readable name |
| `url` | Yes | Mattermost server URL |
| `token` | Yes | Bot access token |
| `channelId` | Yes | Channel to listen in |
| `botName` | No | Mention name (default: `claude-code`) |
| `allowedUsers` | No | List of usernames who can use the bot |
| `permissionMode` | No | How tool-use is gated: `default` / `auto` / `bypass` (default: `default`). See [Permission Modes](#permission-modes). |
| `skipPermissions` | No | **Deprecated.** Use `permissionMode`. `true` maps to `bypass`, `false` to `default`. `permissionMode` wins when both are set. |
| `outboundFiles` | No | `send_file` settings: `{ enabled, maxBytes }` (defaults: enabled `true`, `maxBytes` 100 MB) |
| `sessionHeader` | No | Per-thread header visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no header post) |
| `stickyMessage` | No | Channel sticky visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no sticky, no bumping) |
| `directChannelMode` | No | Direct channel mode: the whole channel is one session, and the bot replies with top-level channel posts instead of thread replies. `true` for defaults, or an options object (`respondTo`). See [Direct Channel Mode](#direct-channel-mode). |
| `approvals` | No | Who may answer tool-permission prompts and other reaction gates: `owner` (session participants) or `all_users` (everyone on `allowedUsers`). Unset keeps the historical default per mode — `all_users` for thread sessions, `owner` for direct channel mode. See [Approvals](#approvals). |
| `ackReaction` | No | Read receipt: react to every accepted message (session start, follow-up, resume) the instant it is accepted, before Claude produces output. `true` uses 👀 (`eyes`), a string names a custom emoji. Persistent, unlike the typing indicator — useful in busy channels and for messages queued behind an in-flight session start. The receipt means *accepted*, not *delivered*: a later failure (capacity limit, Claude not coming up) is still reported by its own post. `!commands` are not acked — they have their own immediate feedback, and neither are messages accepted through the message-approval flow (an authorized user approving a non-participant's message) — there the approval reaction is already the visible signal. Note: in direct channel mode this is one reaction API call per accepted message. Default off. |
| `auditLog` | No | Append-only audit trail of what the bot executed for this platform — tool calls (incl. subagents), session lifecycle, security-relevant commands, plan approvals. One JSONL stream per platform under `~/.claude-threads/audit/` (override: `CLAUDE_THREADS_AUDIT_DIR`), files `0600`. The bot never deletes it — rotation/retention is the operator's job (logrotate, SIEM ingestion). See [Audit log](#audit-log). Default off. |
| `directMessages` | No | Mattermost only: DM auto-discovery. A direct message from a user on `allowedUsers` spawns a derived direct-channel-mode instance for that DM conversation — no per-DM entry needed. See [DM auto-discovery](#dm-auto-discovery). |

### Slack

| Setting | Required | Description |
|---------|----------|-------------|
| `id` | Yes | Unique identifier for this platform |
| `type` | Yes | Must be `slack` |
| `displayName` | No | Human-readable name |
| `botToken` | Yes | Bot User OAuth Token (`xoxb-...`) |
| `appToken` | Yes | App-Level Token for Socket Mode (`xapp-...`) |
| `channelId` | Yes | Channel ID (e.g., `C0123456789`) |
| `botName` | No | Mention name (default: `claude`) |
| `allowedUsers` | No | List of Slack usernames |
| `permissionMode` | No | How tool-use is gated: `default` / `auto` / `bypass` (default: `default`). See [Permission Modes](#permission-modes). |
| `skipPermissions` | No | **Deprecated.** Use `permissionMode`. `true` maps to `bypass`, `false` to `default`. `permissionMode` wins when both are set. |
| `outboundFiles` | No | `send_file` settings: `{ enabled, maxBytes }` (defaults: enabled `true`, `maxBytes` 100 MB) |
| `sessionHeader` | No | Per-thread header visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no header post) |
| `stickyMessage` | No | Channel sticky visibility: `full` (default) / `minimal` (status bar only) / `hidden` (no sticky, no bumping) |
| `directChannelMode` | No | Direct channel mode: the whole channel is one session, and the bot replies with top-level channel posts instead of thread replies. `true` for defaults, or an options object (`respondTo`). See [Direct Channel Mode](#direct-channel-mode). |
| `approvals` | No | Who may answer tool-permission prompts and other reaction gates: `owner` (session participants) or `all_users` (everyone on `allowedUsers`). Unset keeps the historical default per mode — `all_users` for thread sessions, `owner` for direct channel mode. See [Approvals](#approvals). |
| `ackReaction` | No | Read receipt: react to every accepted message (session start, follow-up, resume) the instant it is accepted, before Claude produces output. `true` uses 👀 (`eyes`), a string names a custom emoji. Persistent, unlike the typing indicator — useful in busy channels and for messages queued behind an in-flight session start. The receipt means *accepted*, not *delivered*: a later failure (capacity limit, Claude not coming up) is still reported by its own post. `!commands` are not acked — they have their own immediate feedback, and neither are messages accepted through the message-approval flow (an authorized user approving a non-participant's message) — there the approval reaction is already the visible signal. Note: in direct channel mode this is one reaction API call per accepted message. Default off. |
| `auditLog` | No | Append-only audit trail of what the bot executed for this platform — tool calls (incl. subagents), session lifecycle, security-relevant commands, plan approvals. One JSONL stream per platform under `~/.claude-threads/audit/` (override: `CLAUDE_THREADS_AUDIT_DIR`), files `0600`. The bot never deletes it — rotation/retention is the operator's job (logrotate, SIEM ingestion). See [Audit log](#audit-log). Default off. |

### Direct Channel Mode

`directChannelMode: true` turns the configured channel into a single, always-on conversation with the bot:

- Every message in the channel reaches the bot — no `@mention` required (messages starting with `@someone-else` are still treated as side conversations and ignored).
- The bot replies with **top-level channel posts** instead of thread replies, so the channel reads like a plain chat.
- Only **one session** exists per platform instance; internally it is keyed by the synthetic thread id `dcm:<platform id>`, so persistence, resume after bot restarts, emoji permission prompts, and `!commands` all work exactly as in thread sessions.
- Messages posted inside any thread of the channel are routed to the same session.

This is the mode to use for a dedicated channel with the bot (see issue #315). For shared channels where multiple parallel sessions are wanted, keep the default thread-per-session behavior.

The long form configures how the shared channel behaves:

```yaml
directChannelMode:
  respondTo: all_messages   # or: mention
```

| Option | Values | Default | Meaning |
|--------|--------|---------|---------|
| `respondTo` | `all_messages` / `mention` | `all_messages` | `all_messages`: every message from an allowed user reaches the bot. `mention`: the bot only reacts to messages that @mention it — useful when several people discuss in the channel and the bot should not join every exchange. Backed by the per-session quiet-mode flag, so `!mentions` toggles it at runtime. |

Who may approve tool use in the channel is controlled by the platform-level [`approvals`](#approvals) option (DCM defaults to `owner`).

### Approvals

The platform-level `approvals` option controls who may answer tool-permission prompts (👍/✅/👎) and the other reaction gates — plan approvals, question answers, and session resume:

- `owner` — the session participants: the starter plus explicitly `!invite`d users.
- `all_users` — everyone on the platform's `allowedUsers` list.

Unset keeps the historical default per mode, so existing setups are unaffected: thread sessions behave as before (`all_users`), direct channel mode defaults to the safer `owner`. Setting the option applies it to every session of that platform entry — including classic thread sessions, where `approvals: owner` is an opt-in hardening.

Under effective `owner` mode the scoping is enforced consistently across every path, so the boundary cannot be talked around: the text alternatives (`!approve`, message-based resume) apply the same participant check as their reaction counterparts, and the owner-gated session commands (`!invite`, `!kick`, `!cd`, `!permissions`, …) additionally require the caller to be a session participant — a platform-allowlisted non-participant can neither approve directly nor `!invite` themselves into the approval set.

The approval set is fixed when the Claude CLI is spawned; a later `!invite` extends message access immediately but reaches the approval set on the next CLI respawn (e.g. via `!cd` or `!permissions`).

### Audit log

`auditLog: true` writes an append-only JSONL stream per platform to `~/.claude-threads/audit/<platformId>.jsonl` (override the directory with `CLAUDE_THREADS_AUDIT_DIR`). One line per event:

- `tool_use` — every tool call Claude **issued** (including `server_tool_use` blocks), with the audit-relevant detail (Bash command line, file path, search pattern); subagent sidechain calls are included and marked `subagent: true`. Note the semantics: the audit records the *request* at the moment Claude emits it — an interactive permission denial can still stop the execution, and the denied attempt is exactly what an auditor wants to see.
- `session_start` / `session_resume` / `session_end` — lifecycle with the triggering user.
- `command` — security-relevant `!commands` with actor: `!cd`, `!invite`, `!kick`, `!permissions`, `!stop` (active and paused sessions), `!kill`, `!memory forget`, `!routines` management, routine creation, `!worktree remove`, `!plugin install`/`uninstall`.
- `plan_approval` — plan approved/denied, by whom, via reaction or `!approve`.

Notes for operators:

- **The bot never deletes audit files.** An audit trail that expires itself is not one — rotation and retention are yours (logrotate, or let your SIEM's file collector ingest and rotate). The writer holds the file descriptor open across writes, so use **`copytruncate`** (or restart the bot after rotating): a rename-based rotate never errors the cached fd, and the bot would keep appending to the rotated file until restart.
- **Entries contain command lines verbatim** (that is the point); files are `0600` in a `0700` directory — enforced on every start, including pre-existing files, and the writer refuses symlinked audit paths. Treat the directory with the same care as the thread logs.
- **Actor attribution is best effort**: the username whose (authorized) message triggered the current turn — resumes are attributed to the resuming user — falling back to the session starter. In fast multi-user threads a tool call can be attributed to the previous sender.
- **Tool-permission decisions (allow/deny of individual tool calls) are not recorded** — they are resolved inside the MCP permission server subprocess, which the bot process does not observe. Plan approvals and the audited commands cover the decisions that flow through the bot itself.

### Direct messages (DM)

**Mattermost only.** A Mattermost DM is just a private channel with its own id, so a bot DM conversation is direct channel mode pointed at that id — no separate feature needed. (This recipe does NOT work on Slack: Socket Mode distributes event envelopes across an app's active connections, so a second platform entry sharing the same app credentials can consume and discard events meant for the other entry. Slack DM support needs a single-connection, channel-aware implementation.)

```yaml
platforms:
  - id: mattermost-dm
    type: mattermost
    url: https://chat.example.com
    token: your-bot-token       # same bot token as the main entry
    channelId: <dm-channel-id>
    botName: claude-code
    directChannelMode: true
    stickyMessage: hidden       # a sticky makes little sense in a DM
    allowedUsers: [you]
```

Get the DM channel id with one API call: `POST /api/v4/channels/direct` with `["<bot-user-id>", "<your-user-id>"]` — the returned `id` is stable.

#### DM auto-discovery

Maintaining one static entry per DM conversation does not scale to a team. With `directMessages: true` on a Mattermost entry, anyone on that entry's `allowedUsers` can simply DM the bot "out of the cold":

```yaml
platforms:
  - id: mattermost-main
    type: mattermost
    # ... regular entry ...
    directMessages: true
```

On first contact the bot spawns a derived platform instance for that DM channel — a clone of the parent entry in direct channel mode, sticky hidden, `allowedUsers` scoped to the DM partner (which, with the DCM `approvals` default of `owner`, also scopes tool-permission prompts to that person). DM sessions persist and are reconstructed after a bot restart. Users not on the parent's `allowedUsers` are ignored.

Details and caveats:

- **Lifecycle**: when a DM session leaves the registry its derived instance and connection are torn down (after a short grace period). After an **idle timeout** the session is persisted — the next DM re-discovers the channel and resumes the conversation. After **`!stop`** the session is deliberately unpersisted — the next DM starts fresh. Instances that never produce a session are reaped after a TTL, so instances do not accumulate over uptime.
- **Multiple entries, one bot account**: the first entry to discover a DM channel owns it — other `directMessages: true` entries stay out, so the bot never double-replies.
- **Empty `allowedUsers`**: consistent with the rest of the bot, an empty list means *everyone* — combined with `directMessages: true` that is every user on the server who can DM the bot. Leave it empty only on servers you trust.
- **Renaming a platform entry** strands its persisted DM sessions (as it does any persisted session referencing the old id); they are skipped with a warning.
- Mattermost only — see the note above for why the multi-connection approach cannot work on Slack.

Limitations: the thread-context prompt ("include previous messages?") is skipped — there is no thread history to offer — and the `list_thread` MCP tool cannot resolve the synthetic session id (use `read_channel_history` instead).

### Permission Modes

The `permissionMode` field controls how the bot handles a session's tool-use requests.

| Mode | Behavior |
|------|----------|
| `default` | Every tool-use prompts for approval. The bot posts a permission request in the thread and the user reacts 👍 (allow once) / ✅ (allow all) / 👎 (deny). Safest option. |
| `auto` | Claude's built-in classifier decides per tool: low-risk actions are auto-approved, high-risk ones still prompt. Requires Claude CLI 2.1.x. |
| `bypass` | No prompts and no classifier. Every tool-use is allowed. Equivalent to `--dangerously-skip-permissions`. This is what the legacy `skipPermissions: true` maps to. |

A running session can switch mode at any time with `!permissions <mode>`; that override is not persisted across a bot restart.

### Quieting the bot's overhead messages

Both the per-thread session header and the channel sticky message default to `full` for backward compatibility. To strip them down on a noisy channel, set the per-platform fields in `config.yaml`:

```yaml
platforms:
  - id: mattermost-main
    type: mattermost
    # ... credentials ...
    sessionHeader: hidden    # no header post, Claude's reply is the first message in the thread
    stickyMessage: minimal   # one-line status bar at the channel bottom, no sessions list
```

Note: the per-platform `stickyMessage: <mode>` field is distinct from the top-level `Config.stickyMessage: { description, footer }` block, which still customizes the full sticky for platforms not in `hidden` mode.

#### End-of-turn marker

Integrations that read the channel (a voice front end, a phone bridge, a dashboard) need to know when Claude's answer is complete. The daemon streams by editing one post, so without help they can only guess from the text going quiet. With a marker, the daemon stamps the turn's last reply post the moment the turn ends:

```yaml
platforms:
  - id: slack-main
    type: slack
    turnMarker: metadata          # reaction | metadata | off (default)
    # turnMarkerEmoji: checkered_flag   # reaction only; this is the default
```

| `turnMarker` | What happens | Who sees it |
|---|---|---|
| `metadata` | the last reply post gets Slack message metadata `event_type: claude_threads_turn_complete`, `event_payload: { session, turn, ok }` | integrations reading `conversations.history` with `include_all_metadata=true`; invisible in the UI. Slack only |
| `reaction` | the bot reacts on the last reply post with `turnMarkerEmoji` | everyone. Slack and Mattermost |
| `off` | nothing | |

`ok` is false when the turn ended with an error. A turn with no reply post marks nothing. A marker failure never touches the reply.

### Memory (`memory`, default: fully enabled)

Each platform instance (≈ one channel) can carry persistent memory, modeled on
how Anthropic's own products do it:

- **Repo layer** (Claude Code style): Claude Code's native *auto-memory* is
  redirected into a bot-managed directory scoped per **(platform, repository)**.
  Claude saves and recalls project knowledge (build commands, conventions,
  gotchas) across sessions in the same repo, using its built-in memory
  machinery — worktrees of one repo share the same memory, mirroring native
  behavior. Requires Claude CLI 2.1.235+ (the `autoMemoryDirectory` setting).
- **Channel layer** (Claude Tag style): a shared per-channel `MEMORY.md` of
  team notes — decisions, conventions, stable facts — injected into every
  session's system prompt (capped at 200 lines / 25 KB, mirroring native
  limits). Written by users (`!remember`) and by end-of-session
  **distillation**: when a session ends, a one-shot haiku pass extracts up to
  3 durable facts from the thread.

```yaml
platforms:
  - id: mattermost-main
    type: mattermost
    # ... credentials ...
    memory: true                # default — everything on; `false` disables all layers
    # or per-layer:
    # memory:
    #   repoLayer: true         # native auto-memory redirect
    #   channelLayer: true      # shared channel notes in the system prompt
    #   distillation: false     # no end-of-session haiku pass
```

**Commands** (any session-authorized user; `forget` is owner-gated):

- `!remember <text>` — save a note to the channel's shared memory
- `!memory` — show the channel memory as a numbered list
- `!memory forget <n|text>` — remove one entry; `!memory forget all` clears it

**Storage & privacy:**

- Everything lives under `~/.config/claude-threads/memory/` (override with
  `CLAUDE_THREADS_MEMORY_DIR`), dirs `0700` / bot-written files `0600`.
- **The platform instance is a hard privacy boundary**: memory never crosses
  platform instances, even for the same repository — mirroring Claude Tag's
  per-channel isolation. The storage location is also independent of the
  Claude-account pool's per-session `HOME` overrides.
- When memory is disabled, the bot also sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
  on the Claude CLI child so native auto-memory can't silently accumulate
  cross-channel context under a shared pooled-account `$HOME`.
- `!memory forget` removes the entry atomically for all **future** sessions;
  sessions already running keep their injected copy until their next
  respawn/resume. Repo-layer files are owned by the Claude CLI — ask Claude
  in-session to update its memory, or delete the directory on disk.
- Channel memory is chat-derived content that persists into future sessions'
  prompts. The system-prompt framing tells Claude to treat it as background
  context — never as instructions or authorization — but memory is only as
  trusted as the channel's membership. Distillation currently reads the whole
  thread, including messages from non-allowed users that entered via the
  approval flow. There is no automatic expiry. Both are candidates for
  follow-up options.
- Distillation runs one `claude -p` haiku call per session end, billed to the
  bot's default account (not the session's pooled account). In an OAuth
  `claudeAccounts` pool where only the per-account HOMEs are logged in, the
  bot's own environment may have no credentials — distillation then fails
  silently (debug-logged) and the channel only learns via `!remember`. Give
  the bot process its own credentials (`claude login` under the bot's HOME,
  or `ANTHROPIC_API_KEY` in its env) if you want distillation in that setup.
- Note for exotic setups: the Claude CLI disables auto-memory when
  `CLAUDE_CODE_REMOTE` is set (unless `CLAUDE_CODE_REMOTE_MEMORY_DIR` is
  configured) — the repo layer will be inert in such environments.

### Routines (`routines`, default: enabled)

Scheduled recurring work, Claude Tag-style: a routine fires on its schedule
as a **bot-initiated session thread** in the channel — a completely normal
session (platform permission mode, account-pool balancing, channel memory,
distillation) whose task is the routine's prompt.

```yaml
platforms:
  - id: mattermost-main
    type: mattermost
    # ... credentials ...
    routines: true              # default; `false` disables the scheduler + commands

limits:
  maxRoutines: 10               # per-platform cap (default 10)
```

**Creating** (natural language, confirmed before saving):

```
!routine every weekday at 9am, summarize the open review threads
```

A haiku pass parses the request into a structured schedule (presets: hourly /
daily / weekdays / weekly — hourly is the floor), the bot posts the parsed
result, and **nothing is saved until someone reacts 👍**. Timezones: name one
explicitly ("9am Pacific"); otherwise the bot host's timezone is used and the
confirmation says so.

**Managing:**

- `!routines` — numbered list with schedule, creator, last-run status, and
  the approval posture (👍 approvals · ✅ autonomous)
- `!routines pause|resume|delete <n>` — owner-gated
- `!routines approval <n> on|off` — owner-gated; flip the approval posture
  after creation. `on` restores per-action approval, `off` makes each run
  autonomous (no approval prompts, even on a `skipPermissions` platform)
- `!routines run <n>` — fire now, outside the schedule (platform-allowed
  users only — not temporarily `!invite`d guests; does not consume the
  period's scheduled fire)

**Semantics & guardrails:**

- Runs fire **as their creator** and are re-authorized on every fire — a
  creator who loses platform authorization disables the routine (with a
  channel notice), mirroring Claude Tag.
- At most one fire per period (hour/day/week), evaluated on the wall clock in
  the routine's timezone (DST-safe). A window missed entirely (bot offline)
  is skipped, not back-filled.
- 3 consecutive failed runs auto-disable the routine with a channel notice;
  `!routines resume <n>` re-arms it.
- Runs count against `MAX_SESSIONS`; at the limit a fire is retried within
  its window and otherwise skipped.
- **Each run starts a full Claude session on your subscription** — the
  confirmation and `!routines` listing both say so.
- Routines are scoped per platform instance (same privacy boundary as
  memory) and stored at `~/.config/claude-threads/routines.yaml` (0600;
  override with `CLAUDE_THREADS_ROUTINES_PATH`).
- The natural-language parse uses one haiku `claude -p` call — the same
  bot-process-credentials caveat as memory distillation applies in OAuth
  account pools.

### Watches (`watches`, default: enabled)

Event triggers, Claude Tag-style proactiveness: a watch fires when a
**matching message appears in the channel** — the bot starts a session **in
the triggering message's own thread** (as the watch's creator) and works the
task right where the event happened. Other thread participants reach the
session through the normal message-approval flow.

```yaml
platforms:
  - id: mattermost-main
    type: mattermost
    # ... credentials ...
    watches: true               # default; `false` disables evaluation + commands

limits:
  maxWatches: 10                # per-platform cap (default 10)
  watchCooldownMinutes: 5       # min minutes between fires of one watch (default 5)
  watchDailyCap: 20             # max fires per watch per day (default 20)
```

**Creating** (natural language, confirmed before saving):

```
!watch when someone reports a production incident, triage it and post a checklist
```

A haiku pass splits the request into a matching **condition**, a **task**,
and a set of lowercase **prefilter keywords** (with synonyms and — for
non-English requests — terms in both languages). The confirmation card shows
all three, and **nothing is saved until someone reacts 👍**.

**Matching is two-stage** to keep chatty channels free:

1. Every channel message the bot would otherwise ignore is screened against
   the keywords locally (zero cost). No keyword hit → nothing happens.
2. A keyword hit gets **one haiku call** that semantically confirms the
   message against the condition ("a link to last year's incident postmortem"
   does not fire an incident watch). A keyword hit alone never fires;
   a failed or ambiguous confirmation never fires (fail-closed).

**Managing:**

- `!watches` — numbered list with condition, creator, last-fire status, and
  the approval posture (👍 approvals · ✅ autonomous)
- `!watches pause|resume|delete <n>` — owner-gated
- `!watches approval <n> on|off` — owner-gated; flip the approval posture
  after creation. `off` makes each fire autonomous — reserve it for triggers
  you fully trust, since a watch fires on channel content anyone can post
- (No manual `run` — watches are event-driven; use `!routines run` for
  on-demand work.)

**Semantics & guardrails:**

- Fires run **as their creator** and are re-authorized on every fire — a
  creator who loses platform authorization disables the watch (with a
  channel notice).
- Per-watch cooldown (default 5 min) and daily cap (default 20 fires/day);
  at most one watch fires per message; fires count against `MAX_SESSIONS`.
- 3 consecutive failed fires auto-disable the watch with a channel notice;
  `!watches resume <n>` re-arms it.
- Messages inside active or paused session threads never trigger watches
  (loop prevention), and the bot's own posts are filtered before evaluation.
- Platform note: on **Mattermost**, messages from *other* bots (CI alerts,
  webhook integrations) can trigger watches — useful for "watch the CI bot".
  On **Slack**, the client filters all bot events, so only human messages
  trigger.
- The fired session auto-includes the triggering thread's recent messages as
  context (it is the event being responded to) — no interactive context
  prompt to stall on.
- **Each fire starts a full Claude session on your subscription** — the
  confirmation and `!watches` listing both say so.
- Watches are scoped per platform instance (same privacy boundary as memory)
  and stored at `~/.config/claude-threads/watches.yaml` (0600; override with
  `CLAUDE_THREADS_WATCHES_PATH`).
- The parse and each match confirmation use one haiku `claude -p` call — the
  same bot-process-credentials caveat as memory distillation applies in
  OAuth account pools.
- Watches are not available in **direct channel mode** — a DCM channel routes
  every message to the one channel session, so there is no "otherwise
  ignored" traffic to evaluate; `!watch` refuses with an explanation.

**Security note — who can trigger a fire:** the *creator* must be authorized,
but the *triggering message* can come from **any channel member** (that is the
point: incident reporters and CI bots are usually not on `allowedUsers`). The
channel membership is the trust boundary. The triggering content is framed as
data — the confirm prompt classifies it without following instructions inside
it, and the fired session's prompt marks the thread as context, not
instructions — but framing is a mitigation, not authorization. Treat a watch
in a channel with untrusted members accordingly, and be especially deliberate
about combining watches with `skipPermissions: true`, which lets the fired
session act without human tool approval.

### Agent tools (memory / routines / watches from inside a session)

When a feature above is enabled, Claude's own tool list inside a session
gains matching MCP tools (see `docs/MCP-TOOLS.md` § Agent feature tools):

- `remember_fact` / `list_memory` — Claude can save one durable team fact to
  channel memory (announced in the thread, `agent`-labeled in `!memory`,
  capped at 5 per session, never displaces a user entry) and list what is
  stored. Follows the `memory` option's channel layer.
- `propose_routine` / `propose_watch` / `list_routines` / `list_watches` —
  Claude can **propose** a routine or watch: the same confirmation card as
  `!routine` / `!watch` is posted (badged "Claude proposes…"), and **nothing
  is saved without a human 👍**. Proposals are refused in unattended
  sessions (routine/watch fires) so automated runs can never schedule more
  automated runs. Follows the `routines` / `watches` options.

There is no separate toggle: disabling a feature removes its agent tools,
and every call is re-checked in the bot process regardless of what the
session's MCP server offers. Destructive operations (forget, pause, delete,
manual run) are never exposed to Claude.

## Claude Accounts (optional, multi-account mode)

By default every session spawns `claude` with the bot's own `process.env`, so they all share one subscription's token budget. Add a `claudeAccounts` block to spread load across multiple accounts. Omit the block entirely to stay in single-account mode (unchanged behavior).

Selection is usage-balanced (since v1.18.0). At each new-session start the bot probes every account's live limits with `claude -p "/usage" --output-format json` under that account's `HOME` (costs nothing, uses no turns) and routes the session to the account with the most subscription headroom, meaning the lowest `max(session%, week%)`. Round-robin is only the fallback when probing yields no usable numbers (for example an API-key account, which reports no percentages). Accounts in rate-limit cooldown are skipped until their reset time. A resumed session always re-binds to the account its history lives under, cooling or not.

```yaml
claudeAccounts:
  # OAuth accounts (prepare each HOME first with `HOME=<path> claude login`)
  - id: primary
    home: /home/bot/.claude-accounts/primary
  - id: backup
    displayName: Backup (Pro)
    home: /home/bot/.claude-accounts/backup

  # API-key billed
  - id: shared-api
    apiKey: sk-ant-api03-xxxxxxxx...
```

| Setting | Required | Description |
|---------|----------|-------------|
| `id` | Yes | Stable identifier used in logs, UI, and persisted session state |
| `home` | One of | Alternate `$HOME` containing `.claude/.credentials.json` from a prior `HOME=<path> claude login`. For OAuth Pro/Max subscriptions. Session history also lives here, so resumed sessions pick the same account. |
| `apiKey` | One of | Anthropic API key. Billed against that key; session history stays under the bot's default `HOME`. |
| `displayName` | No | Human-readable label in UI (defaults to `id`) |

⚠️ An account with `home` owns the **whole** Claude profile, not just its
credentials: user settings, hooks and global MCP configuration are read from
that home too. Anything the daemon inherited that could point elsewhere — an
API key, a bearer token, `CLAUDE_CONFIG_DIR` — is cleared for that child, or
the account you selected would be silently overridden by the one the daemon
runs as. Daemon-level hooks and settings therefore do **not** carry into a
pooled account; put them in the account's own home.

Exactly one of `home` or `apiKey` should be set per account. Persisted sessions record which account they ran under and resume on the same one.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_SESSIONS` | Max concurrent sessions. Legacy fallback for `limits.maxSessions`. | `5` |
| `SESSION_TIMEOUT_MS` | Idle timeout in milliseconds. Legacy fallback for `limits.sessionTimeoutMinutes`. | `1800000` (30 min) |
| `DEBUG` | Enable verbose logging | - |
| `CLAUDE_PATH` | Path to the `claude` binary. Overrides the PATH lookup and the common install locations. | `claude` (from PATH) |
| `DECISION_BRIDGE_TIMEOUT_MS` | How long the MCP permission server waits for a plan approval or question answer routed through the decision bridge (the bot's reaction UI) before falling back to the legacy behavior (generic prompt for plans, auto-allow for questions). | `3600000` (1 h) |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Strip `ANTHROPIC_*`, `AWS_*_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, and similar from Bash, hook, and stdio-MCP subprocesses Claude spawns. Bot-specific vars like `PLATFORM_TOKEN` pass through. **Also forces permission mode to `default`**; `--dangerously-skip-permissions` will be rejected. Requires Claude CLI 2.1.83+. | - |
| `CLAUDE_THREADS_SESSIONS_PATH` | Override the path to the persisted sessions file (default `~/.config/claude-threads/sessions.json`). | - |
| `CLAUDE_THREADS_GITHUB_EMAILS_PATH` | Override the path to the GitHub-emails store used for commit attribution. | - |
| `CLAUDE_THREADS_MEMORY_DIR` | Override the root of the persistent memory storage (default `~/.config/claude-threads/memory/`). | - |
| `NO_UPDATE_NOTIFIER` | Disable update checks | - |

### Forwarded to Claude CLI automatically

The bot sets these tuning flags on the Claude child process when they aren't
already present in the bot's environment:

| Variable | Effect | Requires |
|----------|--------|----------|
| `MCP_CONNECTION_NONBLOCKING=true` | Caps `--mcp-config` connects at 5s so a slow MCP server never delays startup | Claude CLI 2.1.89+ |
| `ENABLE_PROMPT_CACHING_1H=true` | Opts into 1-hour prompt cache TTL, cutting re-caching cost on long-lived threads | Claude CLI 2.1.108+ |
| `MCP_TOOL_TIMEOUT=3600000` | Only set when the session has a decision bridge. Without it the CLI abandons a pending MCP permission call after ~2 minutes — far too short for plan approvals and question answers that wait on a human reaction. One hour matches the bridge's own `DECISION_BRIDGE_TIMEOUT_MS` default. Verified against CLI 2.1.223. | — |

Export any of them with a different value in the bot's own env to override.

## CLI Options

CLI options override config file settings:

```bash
claude-threads [options]

Options:
  --url <url>              Mattermost server URL
  --token <token>          Bot token
  --channel <id>           Channel ID
  --bot-name <name>        Bot mention name (default: claude-code)
  --allowed-users <list>   Comma-separated allowed usernames
  --permission-mode <mode> Permission mode: default | auto | bypass
  --skip-permissions       [deprecated] Alias for --permission-mode bypass
  --no-skip-permissions    [deprecated] Alias for --permission-mode default
  --chrome                 Enable Chrome integration
  --no-chrome              Disable Chrome integration
  --worktree-mode <mode>   Git worktree mode: off, prompt, require
  --session-header <mode>  Per-thread header: full | minimal | hidden (overrides per-platform config)
  --sticky-message <mode>  Channel sticky: full | minimal | hidden (overrides per-platform config)
  --setup                  Re-run setup wizard
  --debug                  Enable debug logging
  --version                Show version
  --help                   Show help
```

## Session Persistence

Active sessions are saved to `~/.config/claude-threads/sessions.json` and automatically resume after bot restarts.

## Keep-Alive

The bot prevents system sleep while sessions are active (uses `caffeinate` on macOS, `systemd-inhibit` on Linux). Disable with `--no-keep-alive` or `keepAlive: false` in config.

---

_claude-threads is maintained by [Axolotl Systems](https://axolotl.systems). If it makes your team faster, consider [sponsoring the project](https://github.com/sponsors/axolotl-systems)._
