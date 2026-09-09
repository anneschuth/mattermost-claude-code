# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`bugReports: false` removes the `!bug` path entirely** (#574). A bug report leaves the operator's infrastructure — attached screenshots go to a public anonymous file host, and the body (session context plus recent daemon log lines) becomes an issue on this project's public repository, behind best-effort redaction. `claudeCanExecute` means the agent can trigger it unprompted. Regulated deployments need one switch that closes all of it: the typed command, Claude invoking it itself, the 🐛 error reaction, the approval that files the issue, and the `!help` listing. Defaults to `true`, so nothing changes unless you set it, and it **fails closed** — a malformed value, or a bare `bugReports:`, disables the feature rather than defaulting to on.

## [1.35.1] - 2026-09-08

### Fixed
- **A finished session no longer leaks its event listeners** (#569, thanks @R09722akaBennett). `TypedEventEmitter.removeAllListeners()` forwarded its optional argument as an explicit `undefined`, which Node's `EventEmitter` reads as "the event named undefined", so `MessageManager.dispose()` removed nothing and every session's closures stayed alive. Invisible in CI because Bun 1.3.3 behaves differently from Node there; Bun 1.4.2 agrees with Node and fails the existing tests on the old code.
- **The resume notice no longer promises that interrupted work continued** (#571, thanks @kaza; item 1 of #533). After a daemon restart or a platform re-enable, a thread whose turn was in flight was told "You can continue where you left off" while nothing continued: `isProcessing` starts false and nothing is sent to the CLI. The notice now says why the resume happened and, for the two daemon-initiated cases, that anything still running did not survive; only a resume a person asked for keeps the invitation. Attribution to the session owner is gone from the boot path, where nobody was there.

## [1.35.0] - 2026-09-07

### Changed
- **Sessions no longer get the account's claude.ai connectors** (#560, #563). A bot run under a personal account handed every session in the channel that account's Gmail, Google Drive and Calendar tools, and anyone on `allowedUsers` could use them. The CLI is now started with `disableClaudeAiConnectors` in its inline settings and `ENABLE_CLAUDEAI_MCP_SERVERS=false` in its environment, which removes exactly those (verified on CLI 2.1.112, 2.1.251 and 2.1.263: the connectors vanish, a plugin's MCP server stays). The bot's own haiku one-shots (watch confirms, distillation, parsers, title suggestions, the usage probe) run without them too. Everything else the machine provides still loads: user-level servers, servers bundled with plugins, the repo's `.mcp.json`. Set `claudeAiConnectors: true` on a platform to let them through. If your account has connectors, the bot says so at startup (one free `/usage` probe per account) and the channel sticky shows a `🔌 N claude.ai connectors off` chip, so nobody has to discover the change from a Claude that "has no Gmail tool". Also new: `mcpServers` (top-level or per platform, stdio or http/sse) to declare servers in `config.yaml`, `strictMcpConfig: true` as opt-in hardening that passes `--strict-mcp-config` so a session gets only the bot's own set, a per-session log line of the MCP servers the CLI reported (with a warning when one did not connect, and an in-thread warning when connectors are active on a CLI that ignores the switch), a session-header row when a platform deviates from the default posture, and a note on `!plugin install` when strict mode will keep the plugin's MCP servers from loading.

## [1.34.2] - 2026-09-06

### Fixed
- **Bundled dependencies are patched again** (#559). Four advisories (`qs`, `body-parser`, `ajv`, and dev-only `@humanfs/node`) had been fixed in `package-lock.json` by Dependabot but never reached `bun.lock`, which is what CI installs and what `bun build` inlines into `dist/`, so 1.34.1 shipped the vulnerable versions. The lockfile-sync workflow ran a plain `bun install` on Dependabot PRs, which keeps any old entry that still satisfies its range; it now regenerates `bun.lock` from `package-lock.json`. Direct dependencies move along to what the npm lockfile already had (`@modelcontextprotocol/sdk` 1.30, `ink` 6.8, `zod` 4.5). ink's optional peer `react-devtools-core`, which bun used to install implicitly, is now an explicit devDependency so the bundle builds the same as before.
- **Sessions survive a `systemctl restart` under the default `KillMode`** (#556, thanks @Jadefalkner). systemd's default `control-group` mode delivers SIGTERM to the Claude children at the same instant as to the bot, and their exit events arrived during the 50 ms the shutdown handler yields to let the terminal UI paint. The lifecycle flag that marks those exits as "shutdown, preserve for resume" was set only after that yield, so each exit counted as a resume failure and three restarts in a row dropped the session (`Exceeded 3 resume failures`). The flag is now set before the first `await`. Also: the test helper that sets SUID/SGID bits resolves `chmod` via `PATH` instead of `/bin/chmod`, so the unit tests pass on NixOS.

### Changed
- **Verified against Claude CLI 2.1.263** (#561). Every capture flow re-recorded and compared structurally with the 2.1.251 fixtures: no drift in any event shape the bot consumes; the decision-bridge e2e passes. The capture harness's subagent flow now names the `Agent` tool, since deferred tool schemas make the old "Task tool" wording land on `TaskCreate`.

## [1.34.1] - 2026-09-06

### Fixed
- **A long message no longer stalls message handling** (#551). The bot-to-bot status-post guard runs on every inbound message, on the event loop, before routing — and its authorization-refusal pattern used a greedy `\S+`, so any message that was *not* a refusal made the engine retry the split at every position before failing. Measured quadratic: ~150 ms at Mattermost's 16k post limit, 3.7 s at 80k, triggerable by any channel member with one long token. The quantifier is now lazy, which matches exactly the same strings (the addressee is a single whitespace-free token) in well under a millisecond. Measured under JSC, the engine Bun uses; V8 optimizes the greedy form away, so the fault is invisible when re-measured under Node.

## [1.34.0] - 2026-09-05

### Added
- **Slack sessions show a working status instead of nothing** (#525, thanks @kaza). `sendTyping()` was a no-op on Slack, so a Slack session showed no sign of life between the ack reaction and the first output while Mattermost had a typing indicator all along. `assistant.threads.setStatus` fills it in, needs no new scope and no manifest change, and is torn down when the turn ends — a status persists until something replaces it, unlike a self-expiring websocket frame, so `clearTyping()` joins the platform contract. Slack documents the method as AI-assistant-threads-only; it works in ordinary channels, and the degradation path is silent if that ever changes.

### Fixed
- **Idle Slack connections are no longer killed once a minute** (#532, thanks @kaza). The 60-second heartbeat counted only text frames, and an idle Socket Mode connection carries nothing but protocol-level pings — so the heartbeat concluded every healthy idle connection was dead, tore it down and reconnected, forever. Each teardown is a window in which a message can be missed. Fixed on Bun and Node 20; Node 22+/undici exposes no frame-level ping visibility at all and remains open in #498.
- **A session that stalls mid-turn is no longer reported as idle** (#548, found by @kaza while reviewing #533). The idle reaper decides from `lastActivityAt` alone, with no check on whether a turn is open. That clock is fed by every Claude event, so a streaming turn keeps it warm — but a turn that goes silent (a wedged CLI, a dropped API connection, one long-running tool call) was reaped with *"Session timed out after N minutes of inactivity"*, which is false and sends the user looking in the wrong place. The timeout and pre-timeout warning now distinguish three cases: a turn blocked on a plan approval or question says the bot is waiting on *you*, a turn that went silent reports lost output, and a genuinely idle session reads exactly as before. All variants are registered with the #491 bot-to-bot loop guard, so one bot's status post still can never read as a request to another.

## [1.33.1] - 2026-09-05

### Fixed
- **A `!stop` in a direct-channel-mode channel no longer makes it permanently deaf** (#538, thanks @kaza). The paused-session gate and the resume sink disagreed about soft-deleted sessions, so a tombstoned record claimed every message and dropped it. Tombstones now carry an end reason: a user-stopped session stays ended (the next message starts a fresh session), while a stale-swept one is revived — honoring the "send a new message to continue" promise — with the tombstone cleared only after the resume authorization gate. Also closes the reaction-resume door on stopped sessions, and `!help` now answers in a paused thread instead of vanishing. Fixes #537.
- **Direct-channel-mode sessions are no longer tombstoned by the boot-time stale sweep** (#530, thanks @kaza). One quiet hour used to brick the channel silently. Fixes #499.
- **Pooled accounts selected by `home` now clear inherited `CLAUDE_CONFIG_DIR`** (#540, thanks @kaza), which outranks the `HOME` override — a daemon started under its own profile silently billed every pooled session to its own seat and probed its own quota per pool entry. Also clears `CLAUDE_SECURESTORAGE_CONFIG_DIR` and inherited bearer credentials; API-key and single-account modes unaffected. Fixes both session spawning and the usage probe. Fixes #539.

## [1.33.0] - 2026-09-02

### Security
- **fast-uri floored at 4.1.4** (transitive via `ajv`), clearing four fresh high-severity advisories (host confusion and SSRF classes, GHSA-5jgf-p345-68v8 and siblings). Override floor raised from `>=4.1.2`; no direct dependency changes.

### Added
- **Slack: posts made through the app's own user token count as the person's message** (#527, thanks @kaza). Tooling that posts into the channel via the app's user token (same `app_id` + team, acting user set) previously looked bot-authored and was ignored; such posts now command the bot as the acting user. Authorship is decided only from server-authoritative envelope identity (`app_id` learned from the `hello` frame and per-envelope `api_app_id`) — content-based spoofing cannot trigger it, and events that don't match fail closed to today's behavior. Closes #526.

## [1.32.1] - 2026-09-02

### Changed
- **Dependency updates.** Production: hono 4.13.5, zod 4.5.4, js-yaml 4.3.2, express-rate-limit 8.7.0 (#522); dev-dependency group refreshed (#521). Validated with the full unit and Slack integration suites.

## [1.32.0] - 2026-09-01

### Added
- **Slack: shared event source — one Socket Mode connection per app** (#502, thanks @kaza). Slack round-robins Socket Mode envelopes across all of an app's open connections, so a second `SlackClient` on the same app token silently steals events from the first. Now exactly one client (the parent) owns the socket; other clients register as secondaries and receive their channels' events injected by the parent — Web API calls stay independent per instance. The parent mirrors connection state onto secondaries (idempotently re-armed across disconnects), and on reconnect, missed-message recovery runs for the parent and every registered secondary. Zero behavior change for existing single-channel configs; this is the mechanism that unblocks DM auto-discovery on Slack and other multi-channel consumers.

## [1.31.2] - 2026-08-30

### Added
- **The approval posture of a routine or watch is now visible and changeable after creation.** `!routines` / `!watches` listings show each item's posture inline (👍 approvals · ✅ autonomous), and a new owner-gated `!routines approval <n> on|off` / `!watches approval <n> on|off` flips it — `off` makes an item run autonomously, `on` restores per-action approval. Turning a watch autonomous is the same sensitive choice the creation card gates behind the owner and an explicit ✅, so the flip command is owner-gated too; the safe approvals-required posture stays the default for older data.

### Security
- **Active-session thread-id lookups are now scoped by `platformId`**, completing the cross-platform privacy boundary that 1.31.0/1.31.1 established for the persisted store. `SessionRegistry.findByThreadId` takes an optional `platformId` and resolves O(1) against the composite key when given; the message router (`handleMessage`) and the in-session authorization check (`isUserAllowedInSession`) now pass it, so a thread id that collides across platforms can no longer resolve to — or authorize a user against — another platform's *active* session, and the router and auth check always agree on which session a message belongs to. Defense-in-depth: real Mattermost (26-char) and Slack (dotted-ts) ids don't collide today.

## [1.31.1] - 2026-08-29

### Security
- **Regression guard for the cross-platform resume scoping (1.31.0).** The `resumePausedSession` sink is now covered by a test that fails if the `platformId` scope is removed — a message on one platform must never resume a session persisted under another platform whose thread id collides. The fix shipped correct in 1.31.0 but without this guard.

### Fixed
- **A rejected branch name can no longer break its own error message.** An invalid `!worktree <name>` whose name contains a backtick or newline is sanitized for display, so it stays inside its markdown code span in the error post.
- **A downgraded "✅ Invite to session" reaction is no longer silent.** When a non-owner participant's ✅ is downgraded to a one-shot allow (only the owner may grant standing membership), the bot now says so, instead of leaving the reactor to assume the invite succeeded.

## [1.31.0] - 2026-08-29

### Added
- **Watches and routines now carry an explicit approval posture, chosen at creation.** The confirmation card offers 👍 *save* (each fired run asks for in-thread approval before every tool action) or ✅ *save + run autonomously* (no approval prompts) alongside 👎 *discard*. The choice is persisted per item (`requireApproval`) and enforced at fire time: an approval-required fire runs with interactive permissions even on a `skipPermissions` platform, so a watch triggered by attacker-influenceable channel content cannot silently execute tools with no human in the loop. The safe posture is the default — existing watches/routines and agent-proposed items always require approval (the autonomous option is never offered for agent proposals). Choosing the autonomous posture is owner-gated: a non-owner participant's ✅ is downgraded to approvals-required.

### Security
- **End-of-session distillation now skips unattended (routine/watch-fired) sessions**, matching the existing `remember_fact` guard. A prompt-injected fire could otherwise persist attacker-derived "facts" from its (attacker-seeded) thread into channel memory, which is injected into every future session's system prompt.
- **The "✅ Invite to session" reaction is now owner-gated**, closing an asymmetry with the owner-gated `!invite` command: a temporarily-`!invite`d guest could previously grant *standing* session membership to an unauthorized third party by reacting on their message-approval card. A non-owner's ✅ is now downgraded to a one-shot allow (the message still passes once; no membership is granted).
- **Worktree branch names are validated at the `createAndSwitchToWorktree` chokepoint**, not only on the interactive prompt path — the in-session `!worktree <name>` command reached `git worktree add` with an unvalidated name. `isValidBranchName` now also rejects shell metacharacters (`& | ; $ \` ( ) < > ! ' " # %`), which git permits in ref names but which become a command-injection vector on Windows (where the spawn wrapper runs git with `shell:true`); `git worktree add` calls gained a `--` separator as defense-in-depth against flag injection.
- **Session-store threadId lookups no longer cross the platform boundary.** Every resume/lookup path — the plain-reply resume (`resumePausedSession`), `isUserAllowedInSession`, `hasPausedSession`/`getPersistedSession`/`cancelPausedSession` and `getSessionStartPostId` — now scopes by the message's `platformId`, so a thread id that collides across platforms can no longer resume another platform's session (its allowlist, working dir, worktree and Claude account) or authorize a user against another platform's allowlist.
- **The author identity in watch confirm/fire prompts is collapsed to a single line** before interpolation, so a future platform's free-form display name cannot smuggle newlines or fake delimiters outside the quoted message block.
- **`update-state.json` is written owner-only (0600)** via the shared atomic writer, matching every other on-disk store (it previously defaulted to 0644).
- **Persisted free-text fields (`firstPrompt`, `queuedPrompt`, `lastTasksContent`) are capped** before entering `sessions.json`, so a single pathological message can no longer inflate the whole file (rewritten on every mutation). The cap is far above any real prompt.

## [1.30.2] - 2026-08-29

### Changed
- **Latest verified Claude CLI: 2.1.251** (from 2.1.226). The full verification battery ran against it: all 17 reference event streams re-captured (`tests/integration/fixtures/real-cli-captures/`), structural dialect diff against the 2.1.226 captures, and the decision-bridge e2e. Dialect drift found and verified benign: a new top-level `autocompact_state` event and a new `system/task_summary` subtype (both ignored by the bot), and the post-compact `user` echo events are no longer emitted (the bot never consumed them). Deployments on current CLIs no longer show the "⚠️ untested" warning.

## [1.30.1] - 2026-08-28

### Security
- **The card-injection guard now also covers the haiku-parsed `!watch`/`!routine` paths and the store-level gates.** 1.30.0 collapsed watch *keywords*; model-authored names, conditions and prompts from the natural-language parsers — and the stores' own name/condition normalization, the gate no caller can bypass — now go through the same shared `singleLine` helper (`utils/format.ts`), which replaces the two inline copies of the whitespace-collapse regex.

## [1.30.0] - 2026-08-28

### Added
- **Agent tools — Claude can now use the bot's own features from inside a session.** Six new MCP tools, executed in the bot process over the session's decision bridge:
  - `remember_fact` saves one durable team fact to channel memory with a new `agent` provenance label. No approval prompt (the end-of-session distiller already writes ungated) — instead every save is **announced in the thread**, audit-logged, capped at 5 per session, and can never displace a user-written entry (supersede/dedupe/eviction rank agent entries with distilled ones). `list_memory` lists what's stored.
  - `propose_routine` / `propose_watch` post the **existing confirmation card** (badged "Claude proposes…") and save **nothing** — only a human 👍 persists the routine/watch, which is then owned by the session owner like a hand-typed one. `list_routines` / `list_watches` are read-only.
  - **Loop prevention:** sessions started by routine/watch fires are marked `unattended` (persisted across restarts); such sessions cannot propose new routines or watches **or write channel memory** — the tools aren't offered there, and the bot refuses regardless (a prompt-injected fire must not seed future sessions' context).
  - **Approval is owner-gated for agent proposals:** an `!invite`d guest can react on the card, but only the session owner or a platform-allowlisted user may decide it — an unauthorized reaction is refused *without consuming the proposal* (and warned about once, not per toggle), so a guest can neither approve nor veto. Card text Claude authors is collapsed to a single line so it cannot restyle the approval card, and a proposal never displaces a pending human confirmation.
  - Tool availability follows the platform's `memory`/`routines`/`watches` config (advisory env gates on the MCP child; authoritative re-checks in the bot). Destructive operations (forget, pause, delete, manual run) are never exposed to Claude.

### Fixed
- **Bot-to-bot loops are broken at every link (#491).** Two claude-threads bots on one server could lock into an unbounded refusal loop (observed in the wild: 1,941 messages in 37 minutes) because the "not authorized to resume" refusal @-mentioned the bot it was refusing. Three independent fixes, any one of which stops that incident: refusals render the refused user as inline code instead of an @-mention (reads the same, notifies nobody); refusals are rate-limited to once per (thread, user) per 5 minutes instead of once per message; and claude-threads now recognizes another instance's own status posts (refusals, timeout/idle notices, cancellations, emergency shutdowns, resume announcements) and never treats them as a request — even when they carry a mention. A human message that merely starts with one of the status emojis still gets through. Thanks to @theprsi for the excellent incident analysis.
- A signal death of the Claude process (exit code `null`) can no longer be labeled `exit:null` on the registry-removal path — it's a clean end like code 0, matching every sibling teardown site. (Independently found by @Jadefalkner.)

### Security
- **Watch prefilter keywords are collapsed to single-line** before rendering into the human-approval card — an embedded newline could otherwise smuggle multi-line markdown past the card's single-line guard (second-pass review follow-up to the agent tools).
- **The decision bridge drops connections that stream more than 1MB without a newline** instead of buffering indefinitely — closes the cheapest local memory-exhaustion path against the bot process.
- The single-line sanitizers (memory entries, agent card text, watch keywords) now also collapse U+0085 (NEL), which JS `\s` does not cover.

## [1.29.3] - 2026-08-28

Re-release of 1.29.2 — no code changes. The 1.29.2 npm publish failed the same
way as 1.29.1 (npm masked-auth E404): the NPM_TOKEN repository secret had
expired. The token has been rotated and this version ships what 1.29.2 was
meant to ship, plus the release.yml retry fix (#496).

## [1.29.2] - 2026-08-24

Re-release of 1.29.1 — no code changes. The 1.29.1 npm publish step failed
(the registry rejected the publish with npm's masked-auth E404); the v1.29.1
tag and GitHub release exist, but the package never reached npm. This version
re-runs the publish.

## [1.29.1] - 2026-08-24

### Fixed
- **DCM: a channel message addressed to another user no longer starts a session.** With no session running, `@bob did you deploy?` in a direct-channel-mode channel used to start a full Claude session in a human-to-human exchange — the side-conversation guard the active/paused paths already had now covers the new-session path too.
- **The side-conversation guard now works on Slack.** Slack delivers mentions as raw `<@U0…>` tokens (labeled `<@U0…|name>` included), never `@name`, so the guard (active sessions, paused sessions, and the new DCM path) silently never matched there — every human-to-human aside in a session thread was fed to Claude as a follow-up. A message that *also* @mentions the bot still reaches Claude (it explicitly asks the bot), and on Mattermost a literal `<@…>` token stays ordinary text.
- **DCM: non-allowlisted members no longer trigger an unauthorized-warning post per message.** The warning now only fires on an explicit @mention — previously every message from a non-allowlisted member produced channel spam, and two bots could warn at each other in a loop on Mattermost.
- **`!watches` works in direct channel mode again** — only *creation* is refused there; watches that predate a switch to DCM stay listable/pausable/deletable (matches routines).
- **Slack thread history keeps the newest messages for arbitrarily long threads** — the pagination walk now retains a sliding window instead of stopping after 10 pages with the oldest content, and the truncation warning is honest about what was dropped.
- **Audit trail: routine/watch creation confirmations now record the user whose reaction decided them** (the requester is carried in the detail) — matching how plan approvals are attributed.
- **sessions.json and the GitHub-emails store can no longer be wiped by a transient read failure.** Every mutation is a read-modify-write; when the existing file cannot be read faithfully (corruption, EMFILE), reads degrade to empty but writes now refuse — previously the next persist atomically replaced the file with the degraded empty view, destroying every paused session across all platforms. A parseable file that merely lacks the collection key (e.g. a bare `{}`) provably holds nothing and stays writable — as does a zero-length or whitespace-only file, so a crashed first write can never leave a store permanently read-only.
- Mattermost thread history resolves usernames only for the messages the limit keeps (matches the Slack client).
- **Slack MCP tools now normalize literal Unicode emoji to shortcodes** for `react_to_post` and interactive-post reactions — `reactions.add` rejects raw 👍; the client path already normalized, the MCP path was the odd one out.
- **Worktree commands honor `approvals: owner`.** `!worktree` create/switch/remove/cleanup and worktree-prompt disabling now go through the same owner gate as every other owner-gated command: under owner-scoped approvals a platform-allowlisted non-participant could previously switch the session's working directory.
- **All haiku one-shots (routine/watch parses, watch confirms, memory distillation) now resolve the claude binary like sessions do** — `quickQuery` used a bare `claude` from PATH while sessions fall back to common install locations, so on some hosts sessions worked while every one-shot silently failed.

### Changed
- Internal restructuring after three feature waves: the user-commands module splits by domain (guards/memory/automation), lifecycle sheds the out-of-band metadata-suggestions domain into its own module, and the last two stores (sessions, GitHub emails) migrate onto the shared atomic-write primitives.
- A wide DRY + dead-code sweep (net −800 lines): shared WebSocket close/permalink formatting/post-list rendering/limit clamping across the platform and MCP layers, one canonical legacy-allowlist helper for the six hand-copied authorization fallbacks, nine MCP tool registrations collapsed into one helper, ~380 lines of dead test helpers deleted, and the client test files adopt the shared fetch harness.

## [1.29.0] - 2026-08-24

### Added
- **Watches — event triggers, the proactive counterpart to routines.** `!watch when someone reports a production incident, triage it and post a checklist` creates a watch in natural language: one haiku pass extracts the matching condition, the task, and a set of prefilter keywords (synonyms and both languages for non-English requests), the bot shows all three, and **nothing is saved until someone reacts 👍**. When a matching message appears in the channel, the bot starts a full Claude session **in the triggering message's own thread**, running as the watch's creator with the thread's recent messages auto-included as context.
  - **Two-stage matching keeps chatty channels free:** a zero-cost local keyword prefilter screens every message; only prefilter hits get one haiku call that semantically confirms the match. A keyword hit alone never fires, and a failed confirmation never fires (fail-closed).
  - **Managing:** `!watches` lists numbered with condition/creator/last-fire; `!watches pause|resume|delete <n>` (owner-gated). No manual run — watches are event-driven.
  - **Guardrails:** per-watch cooldown (`limits.watchCooldownMinutes`, default 5) and daily fire cap (`limits.watchDailyCap`, default 20); per-platform cap (`limits.maxWatches`, default 10); at most one watch fires per message; 3 consecutive failed fires auto-disable with a notice; a deauthorized creator disables the watch; session threads and bot posts can never re-trigger (loop prevention); fires count against `MAX_SESSIONS`. Per-platform `watches: false` disables the feature; storage at `~/.config/claude-threads/watches.yaml` (0600, per-platform scoped like memory; override `CLAUDE_THREADS_WATCHES_PATH`).
  - **Platform note:** on Mattermost, other bots' messages (CI alerts, webhooks) can trigger watches; Slack's event filtering means only human messages trigger there.
  - Shared-infrastructure cleanup along the way: the per-platform YAML list store machinery behind routines and watches is now one `PlatformListStore` base (with a shared add/fire-outcome/manage-command core), the strict-JSON extraction all haiku one-shots use lives in one shared helper, and the channel-memory store now uses the shared mutex/atomic-write primitives.

### Fixed
- **DM auto-discovery instances now honor the parent platform's `memory`, `routines`, and `watches` settings.** Derived DM instances previously fell back to the fully-enabled defaults — a parent with `memory: false` (privacy) still got end-of-session distillation persisted from private DM conversations.
- **Routines and watches refuse creation in direct-channel-mode channels.** A fired session there would be keyed on a thread that no typed message can reach (`!stop` and follow-ups route to the channel session). Existing DCM routines stay listable/pausable/deletable and their write-only runs keep working.
- **Slack thread history now follows cursor pagination.** Threads longer than one API page (1000 messages) previously returned the oldest page's tail as "recent context" for context prompts, work summaries, and memory distillation.
- **Reconfiguring a platform via the wizard no longer drops settings the prompts don't ask about** (`memory`, `routines`, `watches`, `skipPermissions`, `auditLog`, `ackReaction`, and any future field) — the edit now merges over the existing entry instead of replacing it.
- **Store hardening:** a failed write can no longer leave a phantom item in the in-memory cache; writes refuse to proceed over an existing-but-unreadable store file instead of destroying it; store reads hand out copies, never live cache references; hand-edited watch keywords are normalized to lowercase (uppercase keywords could never match).
- **Watch confirm hardening:** the haiku confirm quotes every message line so a spoofed end-delimiter cannot smuggle instructions out of the data block; the confirm budget covers slow hosts (20s) and failures log at warn instead of debug.

## [1.28.0] - 2026-08-21

### Added
- **Audit trail (`auditLog`)** - Opt-in per platform: an append-only JSONL stream per platform (`~/.claude-threads/audit/`, files `0600` enforced even on pre-existing artifacts, symlink-refusing writer, never deleted by the bot) recording what the bot did — every tool call Claude issued incl. `server_tool_use` and subagent sidechains (with Bash command line / file path / pattern as detail), session lifecycle incl. failure paths with the triggering user, security-relevant `!commands` (`!kill` and paused-session `!stop` included), routine creation, worktree/plugin mutations, and plan approvals with decider. Built for SIEM file ingestion; rotation/retention is the operator's call. Tool-permission allow/deny decisions stay out of scope (they resolve inside the MCP permission server subprocess; the issued request is still recorded).

### Fixed
- **`ackReaction` accepts a literal Unicode emoji on both platforms.** `ackReaction: "👀"` used to work on Slack but silently no-op on Mattermost (its reaction API needs the shortcode name). Literal emoji are now normalized to their shortcode at config time; anything that is not a plain shortcode name after mapping (unmapped emoji, flags, keycaps, ZWJ sequences) warns and disables the feature instead of never reacting. Follow-up to #487.

### Changed
- Documented that messages accepted through the message-approval flow (an authorized user approving a non-participant's message) intentionally get no read receipt — the approval reaction is already the visible signal. Also adds the missing red-verified no-ack test for the follow-up path's session-membership gate.

## [1.27.0] - 2026-08-20

### Added
- **Read-receipt reaction (`ackReaction`)** - Opt-in per platform: the bot reacts to every message it accepts for processing (session start, follow-up, resume) the moment it is accepted — before any Claude output. `true` uses 👀, a string names a custom emoji. Unlike the transient typing indicator the reaction is persistent and survives reconnects, so users in busy channels (and messages queued behind an in-flight session start) get an immediate, lasting "your message landed" signal.
- **Direct channel mode (DCM)** - Opt-in per platform via `directChannelMode: true`: the whole configured channel behaves as one session. Messages reach the bot without an `@mention`, and the bot replies with top-level channel posts instead of thread replies, so the channel reads like a plain conversation (#315). Internally the session is keyed by a synthetic thread id (`dcm:<platform id>`) that the platform clients resolve to a channel-root post, which keeps persistence, resume, reaction-based permission prompts, and `!commands` working unchanged. Messages posted inside any thread of the channel route to the same session; the thread-context prompt is skipped (there is no thread history behind the synthetic id). Default off — thread-per-session behavior is unchanged. The long form configures shared-channel behavior: `respondTo: all_messages | mention` (does the bot react to everything or only to @mentions; backed by the per-session quiet-mode flag so `!mentions` toggles it live). On Mattermost, a DM is just a private channel, so pointing a DCM platform entry at a DM channel id covers bot direct messages with no extra feature (#315); Slack is excluded — Socket Mode distributes envelopes across an app's connections, so a second entry on the same credentials could swallow the first one's events.
- **Platform-level `approvals` option** - `owner | all_users` controls who may answer tool-permission prompts and the other reaction gates (plan approvals, question answers, resume): the session participants (starter + `!invite`d), or everyone on the platform's `allowedUsers` list. Unset keeps the historical default per mode — `all_users` for thread sessions (unchanged upstream behavior), `owner` for direct channel mode — so the option is purely opt-in for existing setups; `approvals: owner` on a thread channel is an opt-in hardening.
- **DM auto-discovery (Mattermost)** - `directMessages: true` on a platform entry lets anyone on its `allowedUsers` start a bot DM "out of the cold": the first message spawns a derived direct-channel-mode instance for that DM channel (sticky hidden, scoped to the DM partner incl. tool-permission approvals), and persisted DM sessions are reconstructed after a restart. Mattermost only — Slack's Socket Mode envelope distribution makes per-DM connections unsafe there.

### Changed
- **Unit-test infrastructure hardening.** `handler.test.ts` no longer probes the real environment (git child processes, battery readouts are mocked, with a correct pre-mock value-snapshot restore — Bun module namespaces are live bindings, so restoring the namespace would restore the mocks; the same hazard is fixed in the plugin suite's `crossSpawn` restore). The per-test budget on all unit-test entry points is raised to 15s: the 5s default was routinely blown by event-loop contention when several processes compete for the machine, killing millisecond-fast tests at exactly the budget.

### Fixed
- **Permission prompts show the full Bash command.** The approval prompt used to hard-truncate commands at 100 characters, so anything past the first pipe or `&&` was invisible at the exact moment the user was asked to approve it — the gate could only be rubber-stamped. The prompt now shows the command up to a generous 1500-character cap (a pathological command is still cut so it cannot blow up the prompt post). The 50-character display truncation in the streaming view is unchanged; only the permission prompt is affected.
- **Resuming a legacy persisted session no longer drops the owner from `sessionAllowedUsers`.** (#483) A session persisted before the collaboration list existed restored as an empty set, silently removing the owner from their own session — the one restore site without the defensive `[startedBy]` fallback its siblings already had.

## [1.26.0] - 2026-08-20

### Added
- **Routines — scheduled recurring work, Claude Tag-style.** `!routine every weekday at 9am, summarize the open review threads` creates a routine in natural language: one haiku pass parses the request into a structured schedule (presets hourly/daily/weekdays/weekly — hourly is the floor; timezone from the request or the bot host's zone, stated explicitly), the bot posts the parsed result, and **nothing is saved until someone reacts 👍**. Each run fires as a **bot-initiated session thread** in the channel — a completely normal session (platform permission mode, account-pool balancing, channel memory, end-of-session distillation) started as the routine's creator, with the creator re-authorized on every fire (a deauthorized creator disables the routine with a channel notice, mirroring Claude Tag).
  - **Managing:** `!routines` lists numbered with schedule/creator/last-run; `!routines pause|resume|delete <n>` (owner-gated); `!routines run <n>` fires now without consuming the period's scheduled run (platform-allowed users only — a temporarily `!invite`d guest cannot spawn unattended sessions under the creator's identity).
  - **Scheduling correctness:** due-ness is evaluated on the wall clock in the routine's own timezone (DST-safe, unit-tested across both switches), anchored to one fire per period; windows missed while the bot is down are skipped, not back-filled.
  - **Guardrails:** per-platform cap (`limits.maxRoutines`, default 10); 3 consecutive failed runs auto-disable with a notice (manual `!routines run` outcomes never count toward — or reset — that streak); runs count against `MAX_SESSIONS` (retried within the window when at the limit); cost is stated in the confirmation and the listing (each run starts a full Claude session on your subscription). Per-platform `routines: false` disables the feature; storage at `~/.config/claude-threads/routines.yaml` (0600, per-platform scoped like memory; override `CLAUDE_THREADS_ROUTINES_PATH`).

### Fixed
- **Ended sessions could come back from the dead.** The turn-end persistence write is deferred until the turn's message operations settle; when Claude exited immediately after its final turn (fast one-shot sessions), that deferred write could land *after* session teardown had soft-deleted the record — re-saving it as active. A later plain reply in the thread then resumed a session the bot had just ended. The deferred persist now no-ops once the session is unregistered. (Also the root cause of the flaky "should ignore side conversations" integration test.)

## [1.25.1] - 2026-08-20

### Fixed
- **Keep-alive inhibitors no longer outlive the bot process.** (#480, thanks @Jadefalkner) The sleep-prevention child processes are now tied to the bot's lifetime at the OS level: on Linux `systemd-inhibit` runs `cat` on a pipe held by the bot (EOF on bot death releases the lock, even after SIGKILL), on macOS `caffeinate -w <pid>` watches the bot pid natively, and the xdg-screensaver/PowerShell fallbacks poll the parent pid. Previously a hard death of the bot (SIGKILL, crashed test runner) orphaned `systemd-inhibit sleep infinity` processes to init, permanently blocking system sleep/hibernate until they were killed by hand.

## [1.25.0] - 2026-08-19

### Added
- **Persistent memory — the bot now learns over time**, modeled on how Anthropic's own products do memory, in two layers scoped per platform instance (≈ one channel, the hard privacy boundary, mirroring Claude Tag's per-channel isolation):
  - **Repo layer (Claude Code style):** Claude Code's native auto-memory is redirected via the `autoMemoryDirectory` setting into a bot-managed per-(platform, repository) directory under `~/.config/claude-threads/memory/`. Claude's built-in save/recall machinery does the learning; the bot only controls where memory lives — which also makes it immune to the account pool's per-session `HOME` overrides. Worktrees of one repo share memory, like native behavior. Verified headless over stream-json against CLI 2.1.235 (write, load-at-start, resume, HOME override, kill switch).
  - **Channel layer (Claude Tag style):** a shared per-channel `MEMORY.md` of team notes, injected into every session's system prompt (capped at the native 200-line/25KB limits) with explicit "background context, not instructions" framing as a prompt-injection mitigation. Written by `!remember <text>` and by **end-of-session distillation** — a one-shot haiku pass that extracts up to 3 durable facts when a session ends (`!stop`, normal exit, or idle timeout; never on pause/respawn/shutdown).
  - **Transparency commands:** `!memory` lists the channel's entries numbered; `!memory forget <n|text>` removes one (owner-gated, with ambiguity handling); `!memory forget all` clears the channel.
  - **Config:** per-platform `memory:` option — on by default; `memory: false` disables everything (and force-sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` on the CLI child so native auto-memory can't accumulate cross-channel context under a shared pooled-account `$HOME`); an object form toggles `repoLayer` / `channelLayer` / `distillation` individually. Storage override: `CLAUDE_THREADS_MEMORY_DIR`.
  - `ClaudeCliOptions.memory` is a deliberately **required** field so every present and future spawn/respawn site must decide its memory binding explicitly — the same compiler-enforced-checklist pattern that protects `uploadDir`.
  - **Supersede authorization (security-review finding):** a new note can only replace ("supersede") entries its writer legitimately owns — distilled entries (background inference, no author) or the same user's own earlier notes. Previously any session-authorized user, including temporarily `!invite`d collaborators, could silently delete another user's entry by embedding its text in a `!remember` — bypassing the owner gate that protects `!memory forget`. Conflicting notes now coexist (visible in `!memory`, resolvable by the owner), and replacements are reported in the confirmation instead of happening silently.
  - **Review-driven hardening:** `!memory` listings are batched under the platform's post-size limit (a full 400-entry memory would otherwise exceed Mattermost's 16K cap exactly when inspection matters most); ambiguous `!memory forget` previews cap at 10 matches; distillation prompts carry only the newest 50 existing entries instead of the whole file; repo-memory keys follow a linked worktree back to its main repository via `git rev-parse --git-common-dir`, so `!cd` into a worktree (or a legacy resumed session without recorded worktree info) keeps the shared repo memory; hand-written `#` headings in the channel `MEMORY.md` survive rewrites; the truncation warning for `!remember` measures the collapsed text (newline collapsing can lengthen it); and an explicit user `!remember` whose text is a fragment of an existing entry now lands instead of being reported "Already known" — a fragment may be a correction, and only distilled candidates are deduped by containment.

### Fixed
- **Repo memory stays correctly keyed after leaving a worktree.** `!cd` does not clear `session.worktreeInfo`, and the `!permissions`/plugin-restart/resume paths passed its recorded `repoRoot` as the repo-memory key override — so a session that left its worktree for another repository kept reading and writing the old repository's memory. A new `activeWorktreeRepoRoot` helper honors the recorded root only while the working directory is still inside the worktree (preserving the deleted-worktree resume fast path); otherwise the key derives from the working directory itself.
- **Slack threads now distill their most recent messages, not their oldest.** The Slack client forwarded `getThreadHistory`'s limit straight to `conversations.replies`, which paginates oldest-first — a long thread's distillation (and the pre-existing context-prompt and work-summary features) saw the opening of the conversation and missed the decisions at the end. The client now fetches a full page and keeps the most recent N, matching the Mattermost client's contract.
- **`quickQuery` prompts travel over stdin instead of argv.** Distillation prompts (existing memory + thread tail, up to ~40KB) exceeded Windows command-line limits as a single argv argument via the npm shim, silently killing the spawn — distillation (and long work-summary prompts) never worked on Windows. Verified against CLI 2.1.235 that `claude -p` reads the prompt from stdin.
- **Chained worktree switches no longer split repo memory.** Creating a worktree *from inside* another worktree keyed the new session's auto-memory (and the persisted `worktreeInfo.repoRoot` that resume/`!permissions`/plugin restarts reuse) to the intermediate worktree's own path instead of the main repository — worktree creation now resolves the main root via `git rev-parse --git-common-dir` (`getMainRepositoryRoot`, also reused by `detectWorktreeInfo`, replacing its weaker suffix-stripping copy).
- **`!memory` no longer pings entry authors.** The listing rendered authors as live @-mentions, notifying every author each time anyone viewed the read-only list; authors now render as inline code.
- **Malformed per-field `memory` config values warn at startup** (e.g. `channelLayer: "off"` silently stayed enabled before) instead of falling back silently.
- **Plugin install/uninstall respawns no longer drop session wiring.** The `!plugin install`/`uninstall` restart paths built `ClaudeCliOptions` by hand, omitting the session's pooled Claude account (so `--resume` under a multi-account pool ran against the wrong `$HOME` and failed with "No conversation found"), the `send_file` upload directory, the decision-bridge socket (breaking plan approvals after a plugin change), and the append-system-prompt (stripping platform context, co-author rules, attribution, and channel memory — `--append-system-prompt` is per-invocation and not re-applied by `--resume`). Both paths now share a builder on `buildRestartCliOptions` and rebuild the prompt like the `!cd`/`!permissions` restarts.

## [1.24.3] - 2026-08-19

### Changed
- **Dependency updates** (#473, #474). Production: `@hono/node-server` 2.1.0 → 2.1.1, `hono` 4.13.1 → 4.13.2. Dev: `knip` 6.32.0 → 6.32.2, pulling `oxc-parser` 0.142.0 → 0.143.0 and `unbash` 4.0.6 → 4.0.10. `typescript-eslint` 8.67.0 landed in `package-lock.json` only — it is a caret-ranged dev dependency, so `bun install` left `bun.lock` (what CI actually installs from) on 8.65.0. Full typecheck/lint/knip/test/build battery green on the combined result.

## [1.24.2] - 2026-08-13

### Changed
- **Dependency updates** (#469, #470). Production: `@hono/node-server` 2.0.12 → 2.1.0, `hono` 4.13.0 → 4.13.1, `express-rate-limit` 8.6.1 → 8.6.2, `ws` 8.21.1 → 8.21.3. Dev: `knip` 6.31.0 → 6.32.0 plus lockfile-only bumps within existing ranges. Both lockfiles regenerated and verified in lockstep; full typecheck/lint/test/build battery green on the combined result.

## [1.24.1] - 2026-08-08

### Fixed
- **Task lists no longer degrade to "Task #N" placeholders after a bot restart.** Modern CLIs stream tasks incrementally (`TaskCreate`/`TaskUpdate` with ids), and the bot accumulates them in a per-session `TaskTracker` — but that tracker lived only in memory. After a restart + resume, the first `TaskUpdate` of the next turn hit an empty tracker and rendered a placeholder ("Task #1") instead of the real subject, losing every task name for the rest of the session. The tracker's resolved tasks (id → subject/status) are now persisted to `sessions.json` at each turn end and restored on resume. In-flight creates (id not yet resolved from result text) are deliberately dropped at serialize time; pre-1.24.1 persisted sessions simply start with an empty tracker as before. Covered by a red-green integration test that restarts the bot mid-task-list and asserts the post-resume re-render still shows real subjects on both platform paths.

## [1.24.0] - 2026-08-08

### Added
- **`!model` and `!effort` — switch model or reasoning effort mid-session.** Verified against the real CLI (2.1.226): `/model` and `/effort` work over stream-json (`/model` with no args lists the options; `/model sonnet` switches "for this session only"; `/effort low|medium|high|xhigh|max|auto`), and both are listed in the CLI's `init.slash_commands` — so the bot's dynamic slash-command passthrough forwards `!model sonnet` / `!effort high` as-is and the CLI's confirmation posts to the thread. Both are now first-class registered commands with unconditional forwarding handlers (like `!context`/`!cost`/`!compact` — they work even before the CLI's init event arrives, and forward their argument: `!model sonnet` → `/model sonnet`), and `!help` gained a line pointing out that Claude Code slash commands work with `!`.
- **The session header now shows the model the session actually runs on.** Previously the header picked the "primary model" by highest cumulative cost — after a `!model` switch the old model keeps the larger spend, so the header kept naming the old model indefinitely. The per-turn `init.model` (re-emitted every turn, per the reference captures) is now authoritative. Model display names also cover the Claude 5 family via generic id parsing (`claude-sonnet-5` → "Sonnet 5", `claude-fable-5` → "Fable 5", dated ids still render as before).

### Changed
- **Latest verified Claude CLI: 2.1.226** (from 2.1.223). The full verification battery ran against it this cycle: the decision-bridge e2e (4/4), all 17 reference captures re-recorded on 2.1.225/2.1.226, and both integration matrices. Install hints updated. Also verified while probing: `/cd` and `/add-dir` report "isn't available in this environment" over stream-json on 2.1.226 — a native in-session directory switch isn't possible, so `!cd` keeps its restart-based implementation.

## [1.23.0] - 2026-08-08

### Fixed
- **A failed compaction no longer leaves a stale "🗜️ Compacting context..." post forever.** Captured against the real CLI (2.1.226, `real-cli-captures/compact-failed.jsonl`): a failed compact emits **no** `compact_boundary` — only a `status` event with `compact_result: "failed"` and a `compact_error` — so the in-progress post was never resolved. It now updates to "⚠️ Compaction failed (reason)". Long-lived bot threads auto-compact in production, so this state was reachable by simply keeping a session busy.

### Added
- **Compaction completion shows real token counts.** The completion post now renders `pre → post` ("Context compacted (manual, 31k → 3k tokens)") using the `post_tokens` field verified in a new reference capture (`real-cli-captures/compact.jsonl`, recorded via a manual `/compact` driven through stream-json).
- **`auth_status` events are handled.** An auth error from the CLI mid-session (expired OAuth, revoked key) now posts a warning to the thread instead of vanishing; progress-only auth updates are logged. Shape taken from the Agent SDK's published types (`SDKAuthStatusMessage`, `@anthropic-ai/claude-agent-sdk` 0.3.226) — deliberately not capture-backed, since provoking a real auth failure requires a broken environment.
- **The mock's `persistent-session` scenario now carries the telemetry noise real streams have** (`thinking_tokens`, `post_turn_summary`, `active_goal`), pinning deliberately that the bot tolerates unconsumed event types — previously that tolerance was only proven incidentally. New `compaction`/`compaction-failed` scenarios and an integration suite cover the compaction lifecycle end to end on both platforms.

## [1.22.1] - 2026-08-08

### Fixed
- **Permission prompts work in source/dev mode (`bun run dev`).** The per-session MCP config pointed at `mcp/mcp-server.js`, which only exists in a dist build — running the bot from source gave every session an MCP server path that could never spawn, silently breaking interactive permissions, `send_file`, and the decision bridge in dev mode. The path resolution now falls back to the TypeScript source and runs it under the current runtime (bun) instead of node. Built installs are unaffected.

### Changed
- **The integration-test mock Claude CLI now speaks the modern CLI dialect, verified against verbatim real-CLI captures.** The old mock emitted an event protocol modern CLIs no longer use (top-level `tool_result` events, `TodoWrite` task lists, plan/question tools that never touched the permission system, a process that died after every turn) — so ~120 integration tests were exercising a dialect the real CLI abandoned, and the last three releases' bugs lived exactly in that blind spot. The mock was rewritten against 15 captured reference flows from the real CLI (2.1.225), committed under `tests/integration/fixtures/real-cli-captures/` with a re-capture harness (`tests/e2e-real-cli/capture-events.ts`): `system/init` and `rate_limit_event` at startup, tool results as `tool_result` blocks in `user` events, TaskCreate/TaskUpdate task tracking with result-text id resolution, one `result` per turn with the process staying alive, and SIGINT aborting in-flight tools before exiting — all shapes taken from the captures. **Interactive scenarios now spawn the real MCP permission server and block ExitPlanMode/AskUserQuestion on `permission_prompt`, so the integration suite exercises the production permission-prompt → decision-bridge → reaction-UI path end to end** — including new regression tests pinning that no duplicate generic permission prompt appears next to the plan/question UI (the 1.21.2 bug class). Captures also documented that bypass mode exposes neither ExitPlanMode nor AskUserQuestion on modern CLIs, so the plan/question suites now run with interactive permissions like production. All 21 integration suites pass against the new mock.

## [1.22.0] - 2026-08-08

### Changed
- **A newer Claude CLI no longer takes the bot down — the version check is now a three-tier policy.** Previously the single hard range `>=2.0.74 <2.2.0` meant that the day Anthropic ships CLI 2.2.0, every bot whose CLI auto-updates would refuse to start until a claude-threads release widened the range — the worst failure mode for a bot people depend on. Now: below the floor (`2.0.74`) or on a new major (3.x+) the bot still exits with an error (those genuinely can't work / are a different contract); but a **newer 2.x above the verified range starts normally with a visible warning** — at startup, in the terminal header, and as an "⚠️ untested" marker next to the CLI version in the sticky channel message and session headers. `--skip-version-check` still bypasses the hard exits, and a bypassed hard exit is no longer silent either: the bot warns at startup and marks the version "⚠️ unsupported" in the same places. Onboarding speaks the same policy (warn-and-continue on untested, tier-specific messages on the hard tiers). The verified range (latest verified: 2.1.223) is unchanged; when a new CLI minor ships, it gets verified and the range bumped in a patch release — the warning is the prompt to do that, not a permanent state.

## [1.21.2] - 2026-08-07

### Added
- **Decision bridge: plan approvals and question answers now flow through one surface.** On modern Claude CLIs (verified 2.1.223), `ExitPlanMode` and `AskUserQuestion` block on the MCP permission prompt — making it the authoritative gate — while the rich UI (plan post with 👍/👎, question posts with option reactions) lives in the main bot. Users saw two competing prompts, and reacting only on the bot's UI let the MCP prompt time out into a plan denial. The bot now opens a per-session local socket (a named pipe on Windows); the MCP server forwards plan/question permission requests over it and waits (default 1h, `DECISION_BRIDGE_TIMEOUT_MS`), and the user's reaction on the bot's existing UI resolves them: plans as allow/deny, question answers riding back in the permission response's `updatedInput.answers` — the CLI then tells Claude "Your questions have been answered" / "User has approved your plan" itself (both verified against the real CLI end-to-end, including through the real built `mcp-server.js`). The stdin sends (`'approved'`/answer JSON) are suppressed when a bridge request consumed the decision, and remain as the fallback for older CLIs that don't route these tools through the permission prompt. The bridge degrades gracefully everywhere: creation failure, connect failure, or timeout falls back to the previous behavior (generic prompt for plans, auto-allow for questions). The bridge is session-scoped — it survives `!cd`/`!permissions` respawns and closes with the session; pending decisions are denied on session end or fresh-CLI restart so the MCP child is never stranded. A manual real-CLI verification script ships in `tests/e2e-real-cli/decision-bridge-e2e.ts` (not run in CI — needs live credentials).
- **Decision-bridge hardening (from two adversarial review rounds over this change).** `!approve`/`!yes` resolves a pending bridge request instead of sending a stdin message that would queue behind the blocked permission call (previously it converted an approval into an hour-long hang). The bridge server aborts the bot-side pending when the requesting MCP client disconnects (timeout, cancelled tool call, dead child), so a stale pending can never swallow the user's later reaction — it falls back to stdin instead. Claude respawns deny pending decisions unconditionally (the MCP child always dies, resume or not; previously only fresh-session respawns did). The bridge socket lives in a fresh `0700` directory (other local users can't connect regardless of umask) with a short path (safe against macOS's 104-byte `sun_path` truncation), and is closed on every teardown path including start/resume failures. multiSelect questions bypass the bridge (single-select answer format is the only one verified against the real CLI) and take the legacy path. Operator knob `DECISION_BRIDGE_TIMEOUT_MS` is now actually forwarded to the MCP child.
- **The CLI is spawned with `MCP_TOOL_TIMEOUT=3600000` when a decision bridge is configured.** Delayed-decision testing against the real CLI (2.1.223) showed it abandons a pending MCP permission call after ~2 minutes — one retry, then an error — silently capping how long a plan approval or question answer could wait, regardless of the bridge's 1-hour window. With the flag set, decisions held for 150 seconds complete end-to-end (verified empirically); 1 hour matches the bridge's `DECISION_BRIDGE_TIMEOUT_MS` default, and setting `MCP_TOOL_TIMEOUT` in the bot's own env overrides it, like the other forwarded tuning flags. Should the CLI still give up (older CLI, operator override), the bridge's disconnect-abort clears the bot-side pending state so the user's late reaction falls back to the stdin flow instead of being swallowed.

## [1.21.1] - 2026-08-07

### Fixed
- **A respawning session can no longer be torn down by its own dying Claude process.** Two stacked races made `!cd` / `!permissions` / worktree respawns flaky (seen as the recurring `!cd should restart Claude CLI` failure on main's Integration Tests): a last event flushed by the dying process ran `resetSessionActivity`, which unconditionally flipped the session's `restarting` state back to `active` — so when the old process's exit landed, `handleExit` mistook it for the current process dying and did a full session teardown mid-restart. `resetSessionActivity` now leaves `restarting`/`cancelling` states alone, `handleExit` ignores exits from a CLI instance that is no longer the session's current one (the exit event can be delivered after the respawn already swapped in the new instance), and a successful respawn transitions to `active` explicitly instead of relying on the old exit's side effect. `ClaudeCli.kill()` gained an integration-test caller trace, mirroring the existing `sendMessage` one — attributing kills is the key question when debugging these races in CI logs.
- **`checkGitHubCli` unit tests no longer spawn the real `gh` CLI.** The two subprocess probes each carry a 5s timeout, overrunning bun's 5s per-test budget on a slow runner (the flaky `checkGitHubCli` timeout on main's CI). The exec call is now injectable and the tests cover all three outcomes (installed+authenticated, not installed, not authenticated) deterministically.
- **Integration: the `!cd` confirmation wait no longer matches the user's own message.** The loose `/changed|directory|\/tmp/i` pattern matched the `!cd /tmp` command itself, ending the test while the respawn was still in flight — `afterEach`'s `killAllSessions` then raced the restart and leaked an orphaned mock CLI into the next test.

## [1.21.0] - 2026-08-07

### Fixed
- **Task list display works again on modern Claude CLIs.** Claude Code moved task tracking from `TodoWrite` (whole list per call) to the incremental `TaskCreate`/`TaskUpdate` tools; verified against CLI 2.1.223, `TodoWrite` is never emitted anymore, so the bot's live task list in the thread had silently gone dark. A new per-session `TaskTracker` accumulates the incremental calls (a task's real id is only revealed by its tool result, which arrives later inside a `user` event) and feeds the existing task-list pipeline. `TaskUpdate` on an unknown id (tasks created before a resume, or by a subagent) shows a placeholder rather than nothing; `status: "deleted"` removes the task. `TodoWrite` still works for older CLIs. `TaskGet`/`TaskList` (read-only queries) are hidden from chat.
- **Tool completion indicators (`↳ ✓` / `↳ ❌ Error`) fire again.** The real CLI delivers tool results as `tool_result` blocks inside `user` events; the bot only handled a legacy top-level `tool_result` event shape that modern CLIs never emit — so per-tool completion/error indicators, elapsed times, and the tool-completion flush never triggered. The transformer now processes `user` events. Indicators are only emitted for tools that were actually displayed (hidden tools like `TaskCreate` no longer risk orphaned indicators), and elapsed time works on the real event flow (start times were previously only recorded on the legacy shape). Bug-report context tracking (tool uses/errors) was extended to the real event shapes; the legacy shapes remain handled for old captures and test fixtures.
- **Questions no longer trigger a duplicate permission prompt.** On modern CLIs `AskUserQuestion` routes through the `--permission-prompt-tool`, so next to the bot's proper question UI a generic "Permission requested: AskUserQuestion 👍✅👎" post appeared — and approving it just resolved the tool as unanswered. The MCP permission server now auto-allows `AskUserQuestion`; the question UI and reaction-answer flow are unchanged. Known limitation, verified on 2.1.223: with `--dangerously-skip-permissions` (bypass mode) the CLI does not expose `AskUserQuestion` at all, so bypass sessions cannot receive interactive questions — that is CLI behavior, not a bot regression. Also relevant: since CLI 2.1.200 an unanswered question no longer auto-continues after an idle timeout, which suits chat (users react late) — the previous auto-continue could race a slow reaction.

### Added
- **Structured rate-limit detection.** Modern CLIs emit a `rate_limit_event` with `rate_limit_info: {status, resetsAt, rateLimitType}` on every turn. The bot now feeds **`status: "rejected"`** events into the existing account-cooldown path (`resetsAt` epoch-seconds, sanity-bounded to at most 8 days out; slightly-past values from clock skew clamp to a brief cooldown), complementing the stderr phrase-scraping which remains for older CLIs. The predicate is strict equality on `rejected` — the SDK's status union is `allowed | allowed_warning | rejected`, and `allowed_warning` (~70%+ utilization, request went through) must not bench a healthy account: cooldowns only ever extend, so one warning would have parked the account until its weekly reset.
- **The MCP plan-approval prompt now shows the plan.** On modern CLIs `ExitPlanMode` routes through the permission prompt; it used to render as a bare "Permission requested: ExitPlanMode" with no plan content. The prompt now carries the plan text (truncated at 1500 code points, with an unclosed code fence re-balanced so the reaction legend stays outside it; untruncated plans render exactly as authored). Known remaining conflict, left as follow-up work: the MCP prompt and the bot's plan-approval UI are two competing approval surfaces — reacting on the bot's UI alone lets the MCP prompt time out and deny the plan.

### Hardening
Three adversarial review rounds ran over this change; everything they confirmed is fixed here, with red-green tests.

- **A resumed session can no longer lose its restored task list.** Task state is in-memory, so after a bot restart the resumed CLI session references task ids the fresh tracker has never seen. A single post-resume `TaskUpdate(completed)` created one completed placeholder, `allCompleted` fired on it, and the executor deleted the correctly-restored task-list post while reporting full completion. `allCompleted` now requires at least one task the tracker actually saw created, and a failed-create refresh on an empty tracker emits `update` (never `complete`) for the same reason. (Persisting tracker state across restarts, which would also restore full names instead of `Task #N` placeholders, is left as follow-up work.)
- **Fresh-CLI restarts clear accumulated task state — safely.** `!cd` and worktree switches respawn Claude as a fresh session whose task numbering restarts at #1; stale `TaskTracker` entries would collide with the new ids and corrupt updates. `MessageManager.clearClaudeSessionState()` now runs on every `resume: false` respawn (resume restarts like `!permissions` keep their state). The respawn sites await the old process before clearing, and `kill()` was reworked to resolve on stdio close (late-buffered stream-json can arrive after `exit`) with an escalation to SIGKILL and a bounded timeout — previously a failed spawn or a SIGTERM-immune process could leave `kill()` pending forever, freezing the session in `restarting`.
- **Failed `TaskCreate` calls no longer leave ghost tasks.** A create whose tool result is an error (or doesn't carry the expected "Task #N created" text — e.g. a future CLI rewording) removes the task and refreshes the display; previously it stayed forever as an un-updatable pending row that also pinned `allCompleted` at false. A non-error result with unexpected wording additionally logs a warning — that wording is the one CLI dependency whose drift would silently darken the task display again.
- **Sidechain events are filtered everywhere.** Events carrying `parent_tool_use_id` (subagent activity forwarded by some CLI versions) no longer reach the transformer — a subagent's `TaskCreate`/`TaskUpdate` calls would otherwise permanently pollute the main thread's task list with colliding ids — and the event handlers apply the same filter: subagent text no longer executes `!cd`-style Claude commands against the main session, and subagent tool uses/errors no longer pollute bug-report context. PR-URL detection intentionally still sees subagent text.
- **Task-list updates are coalesced per event.** A parallel burst of N `TaskCreate` calls in one assistant event — or N of their results failing in one `user` event — now yields one task-post update (the final snapshot) instead of N back-to-back `updatePost` calls that could trip platform rate limits.
- **Rate-limit cooldown precision.** A reset-less hit (the 1-hour default guess) is ignored while a cooldown from an explicit reset time is running, so the guess can't stretch a known-shorter deadline — but reset-less repeats during a guess-based cooldown still extend it (the documented behavior), and an explicit reset that arrives too late to re-emit still records its explicitness so later guesses defer to it regardless of arrival order.
- **Placeholder merge on late id resolution.** If a `TaskUpdate` for id N arrives before the corresponding create's result resolves that id, the placeholder and the real task are merged into one row (adopting the update's status and any rename) and the display refreshes immediately.
- **Tracker robustness.** Numeric `taskId` values are coerced instead of silently freezing the displayed list; multi-MB tool results are no longer copied when no `TaskCreate` is pending; and a session mixing both task dialects no longer flip-flops — the full-list `TodoWrite` clears the incremental tracker.

### Changed
- **Verified against Claude CLI 2.1.223** (previously 2.1.116); suggested install version in error messages and onboarding updated. The compatible range is unchanged (`>=2.0.74 <2.2.0`).

## [1.20.1] - 2026-08-06

### Added
- **"How it compares" section on the website and README** - A short, respectful comparison with the other ways to drive a coding agent from chat: Anthropic's own Claude Code in Slack / Claude Tag, OpenAI's Codex in Slack, Cursor in Slack, Cognition's Devin, and community Slack bots. The framing is a single axis — where the session runs (vendor cloud vs. your machine) — with claude-threads positioned as the local, self-hosted option that also speaks Mattermost. A closing note names the strongest differentiators beyond that: in-thread permission approvals, multiplayer sessions, the multi-account pool, and no GitHub assumption. The website's "Why I built this" note about Anthropic's integration was updated to match (it is no longer Enterprise-gated: Pro/Max plans have Claude Code in Slack, Team/Enterprise have Claude Tag).

## [1.20.0] - 2026-08-06

### Added
- **GitHub Sponsors support ♥** - The project now accepts voluntary support via [GitHub Sponsors](https://github.com/sponsors/axolotl-systems): a `.github/FUNDING.yml` enables the Sponsor button on the repository, the `funding` field in `package.json` surfaces the link in npm's post-install funding notice, and the README gained a "Support the Project" section aimed at both individual users and organizations. The sponsor link appears only at moments of delivered value or explicit pull: a dim note in the CLI startup header, a one-line farewell after interactive shutdown, a footer on the on-demand `!help` and `!release-notes` replies, and a 24-hour celebration line in the sticky message when an instance crosses a session-count milestone (#100, #250, #500, ...). The milestone counter persists in `sessions.json` (`stats` block, backward compatible). `release.yml` appends a sponsor footer to each release's generated notes, and the GitHub new-issue chooser links to the sponsor page. Sponsorship is branded under [Axolotl Systems](https://axolotl.systems), credited on the website, README, and docs.

## [1.19.4] - 2026-08-05

### Changed
- **Dependency updates.** Production: `js-yaml` 4.3.0 → 4.3.1 (#457). Dev: `@types/react` 19.2.17 → 19.2.18, `knip` 6.29.0 → 6.31.0, `lint-staged` 17.2.0 → 17.3.0 (#456). The js-yaml bump additionally needed a manual `bun.lock` sync: the lockfile-sync workflow's `bun install` no-ops when the locked version still satisfies the manifest range (`^4.3.0` covers 4.3.0), so `bun.lock` — the lockfile CI actually installs from — had kept 4.3.0. Both manifests now pin `^4.3.1` and both lockfiles lock 4.3.1.

## [1.19.3] - 2026-08-04

### Changed
- **Dependency update: `hono` 4.12.32 → 4.13.0.** Performance-focused release (up to 1.25x faster on common routes), first-class HTTP QUERY method support, and a new Method Not Allowed middleware. Supersedes Dependabot PR #454, whose CI runs could not be approved from this environment; landing the same bump here lets Dependabot auto-close it. Both lockfiles regenerated. (#455)

## [1.19.2] - 2026-08-03

### Fixed
- **The T in the logo now reaches the baseline.** The C in the CT mark is drawn with its bottom stroke centered on the baseline, so its visible edge extends half a stroke-width below it — while the T's stem (butt cap) stopped exactly on the centerline, making the T look too short. The stem now extends to the C's outer bottom edge in both `logo.svg` and `favicon.svg`. (#452)

### Security
- **Cleared three new high advisories flagged by `bun audit`**, all in transitive dependencies, by raising version overrides: `fast-uri` to `>=4.1.2` (GHSA-7p8r-x3mc-p8w7, host confusion via backslash authority introducer), `brace-expansion` to `>=5.0.9` (GHSA-rgw5-rvv9-x895, DoS via unbounded intermediate arrays), and a new `ip-address` `>=10.3.1` override (GHSA-mwp4-54f8-5fhr, SSRF via leading-zero octet confusion). (#452)

## [1.19.1] - 2026-07-28

### Changed
- **Dependency updates.** Production: `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0, `hono` 4.12.31 → 4.12.32, `@hono/node-server` 2.0.11 → 2.0.12, `express-rate-limit` 8.6.0 → 8.6.1. Dev: `@types/node` 26.1.1 → 26.1.2. Dependabot maintains `package-lock.json` only, so `bun.lock` was regenerated alongside it — CI installs with Bun, and without that sync the bumps would not actually reach CI. (#447, #448)

## [1.19.0] - 2026-07-27

### Added
- **Per-message user attribution (`userAttribution`, default on for shared threads).** When enabled, every genuine user turn in NEW sessions is prefixed with `[@username]:` (the platform login) right before it is handed to Claude, so Claude can distinguish speakers in a multi-participant session. The flag defaults to `true`, but the prefix is only actually applied once a session has **more than one participant** (after `!invite`, or another user reviving a paused session) — a solo thread is left untouched, because there the prefix would name the only person who could have spoken. Set `userAttribution: false` in `config.yaml` (also offered as an onboarding question) to disable the feature outright. The prefix is composed only at the send boundary — the sender identity is carried separately and never baked into the stored prompt — so it never leaks into thread titles, git branch-name suggestions, or persisted session state. Attribution covers every real send path: in-thread follow-ups, resumed turns, the initial mid-thread prompt, post-`!cd` re-sends, the thread-context-prompt paths, and worktree re-sends. System/control sends (slash-command passthrough, plan approval, question/approval completion) are deliberately left unattributed. When the flag is on, a system-prompt note tells Claude to treat the prefix as speaker metadata and not to echo it in replies or commit messages; when off, the note is omitted too, so Claude is never taught a prefix that doesn't arrive. The flag is persisted per session (a session keeps its behavior across bot restarts); persisted sessions from before the flag existed stay unattributed. (#437, #446)

## [1.18.4] - 2026-07-27

> Version 1.18.3 was bumped but never tagged or published — releasing it needed a
> local machine with the `gh` CLI, which is the very gap `release.yml` (below)
> closes. Its contents ship here instead; no 1.18.3 artifact ever existed.

### Fixed
- **CI is green again on `main`.** Two jobs had been failing on the daily scheduled run without any code change, both because an unpinned tool pulled a newer release. (#441)
  - **Knip (`lint` job).** A knip release started flagging every barrel-file re-export as an unused export (86 findings) plus the `eslint`/`husky`/`lint-staged`/`tsc` tooling. Knip is now pinned to an exact version as a devDependency (matching how Bun and the Claude CLI are pinned so a release can't silently break CI), run via `bun run knip`. `knip.json` treats `src/**/index.ts` as entry points so public barrel exports are no longer false positives, and the tooling deps/binaries are ignored the same way `prettier` already is. One genuinely dead re-export (`clearAllTimers` from `session/types.ts`) was removed.
  - **Trivy + `bun audit` (`security` job).** Cleared HIGH advisories by bumping `js-yaml` to `^4.3.0` (CVE-2026-59869) and raising the `fast-uri` override to `>=3.1.4` (CVE-2026-13676, CVE-2026-16221). With Trivy passing, the previously-skipped `bun audit` step now runs; its newly-surfaced advisories are cleared by raising the `shell-quote` override to `>=1.10.0` (GHSA-395f-4hp3-45gv) and adding a `brace-expansion` `>=5.0.7` override (GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg).

### Added
- **Releases can be cut without a local machine.** A new `release.yml` workflow fires when a version change lands on `main` (or on demand via `workflow_dispatch`), re-runs typecheck/lint/knip/tests/build, then creates the tag, creates the GitHub release, and publishes to npm. Previously a release needed someone at a terminal with the `gh` CLI to run `gh release create`. The job publishes in-process rather than handing off to `publish.yml`, because a release created with `GITHUB_TOKEN` does not emit a `release: published` event that can start another workflow — the alternative would be storing a long-lived PAT. It exits before tagging when the current version's tag already exists, so re-runs and unrelated `package.json` edits are no-ops. `publish.yml` is unchanged and still handles releases a human creates by hand.

### Changed
- **Dependency updates.** `hono` 4.12.30 → 4.12.31 and `@hono/node-server` 2.0.9 → 2.0.11, the latter carrying a fix for an unauthenticated memory-leak DoS via aborted WebSocket handshake (GHSA-9mqv-5hh9-4cgg). (#434)
- **`body-parser` 2.2.2 → 2.3.0.** (#436)
- **Dev tooling updates.** `eslint` 10.7.0 → 10.8.0, `lint-staged` 17.0.8 → 17.2.0, `prettier` 3.9.5 → 3.9.6, `typescript-eslint` 8.64.0 → 8.65.0. Dependabot maintains `package-lock.json` only, so `bun.lock` was regenerated alongside it — CI installs with Bun, and without that sync the bumps would not actually reach CI. (#442)

## [1.18.2] - 2026-07-17

### Changed
- **New visual identity: the thread-spine mark.** The ✴-star ASCII logo (a leftover of the Claude Code Christmas logo) is replaced everywhere by a mark of our own: heavy box-drawing CT letters with a light thread gutter showing a root node, a reply branch, and a closing arc. Applied consistently to the terminal header, the favicon, a rebuilt pure-vector `logo.svg` with no font dependency, the README, and the website. (#431)
- **README overhaul.** Screenshots for both platforms directly under the pitch, a How it works section, a table of all nine MCP tools with their guardrails (seven were previously undocumented), and a command table synced with the registry. Corrected copy along the way: multi-account selection is usage-balanced since 1.18.0 (the README still said round-robin), the resume reaction is 🔄 (the documented ↩️ was never accepted), and the `send_dm` guardrail is approved from the session thread, not by the recipient. Cross-file links are now absolute so they no longer break on the npm package page, and the configuration link points at `docs/CONFIGURATION.md` instead of the internal `CLAUDE.md`. (#431)
- **Docs sync.** `docs/CONFIGURATION.md` audited against the real config schema: the `limits` block, `threadLogs`, sticky text customization, permission modes, `outboundFiles`, usage-balanced accounts, and the env var list. New `docs/MCP-TOOLS.md` documents every MCP tool with inputs and guardrails. `SETUP_GUIDE.md` drops stale version pins and deprecated permission vocabulary; `CONTRIBUTING.md` gains dev commands and a pointer to the platform implementation guide. (#431)
- **Website redesign: the page is a thread.** claude-threads.run rebuilt on the same terminal identity with the thread as its structure: a rail runs down the content and every section attaches to it as a reply, the last one closing the arc. Content synced with 1.18 (MCP tools table, full command list, a Mattermost showcase section), OpenGraph/Twitter cards with a generated social image, and the Node prerequisite corrected from 18+ to 20+. (#432)
- **npm metadata.** The package description finally mentions Slack, keywords gain `slack`, `chatops`, `pair-programming`, and `collaboration`, and the homepage points at claude-threads.run. Takes effect with this release. (#431)

## [1.18.1] - 2026-07-17

### Changed
- **`react_to_post` resolves the triggering message server-side instead of via a per-message permalink.** v1.18.0 fixed `react_to_post` always landing on the thread root by prepending a `[message permalink: ...]` line to every follow-up message's content — correct, but paid for on every single message in every thread even though reactions are occasional. `url` is now optional: when omitted, the MCP server resolves it to the most recent message in the session's own thread via the same `readThread` call `list_thread` already uses, so no per-message metadata needs to ride along in message content at all. (Mattermost and Slack `readThread` apply `limit` differently — Mattermost takes the newest N, Slack's `conversations.replies` paginates from the thread root forward — so the resolver fetches the default page and takes the last element on both platforms rather than relying on `limit: 1`.)

## [1.18.0] - 2026-07-17

### Added
- **Multi-account pool balances new sessions by real subscription usage.** When a Claude account pool is configured, new sessions used to be spread by round-robin / sticky-by-thread, which ignores how much of each account's rate limit has actually been consumed — a nearly-capped account was as likely to be picked as a fresh one. The pool now routes each new session to the account with the most headroom: at session start the bot probes every account's live limits with `claude -p "/usage" --output-format json` (runs zero turns, costs $0) under that account's `HOME`, parses the reported percentages, and selects the lowest `max(session%, week%)` non-cooling account. Probing is on-demand and synchronous — an idle bot probes nothing — with a short hot-path deadline, in-flight coalescing, and a brief result cache so a burst of concurrent starts triggers a single set of probes rather than one per start. In-flight sessions add a small provisional load penalty so a burst spreads across accounts instead of piling onto the single lowest one, and a rotating cursor breaks exact ties. A failed/timed-out/unparseable probe marks that account "usage unknown" so it sorts last (routing around a logged-out OAuth account, whose auth error never triggers rate-limit cooldown); if every account is unknown, selection degrades gracefully to round-robin. Resume is unaffected — it still re-binds to the persisted `claudeAccountId` so a session resumes under the `HOME` its history lives in. Targets OAuth (subscription) accounts; API-key accounts have no `/usage` limits and sort as unknown. The channel sticky message now shows the pool's `min–max % used` range. (#419)

### Fixed
- **`react_to_post` now targets the message that triggered it, not the thread root.** The only permalink ever exposed to the model was the thread-root URL injected once into the system prompt, so any reaction the bot placed to acknowledge a specific user message — e.g. the "👀 acknowledge task" convention — always landed on the first post of the thread instead of the message that prompted it. Each incoming follow-up message now carries its own permalink (`PlatformClient.getPostPermalink()`, added for both Mattermost and Slack), so `react_to_post` can target the exact message. (#422, #429)

## [1.17.3] - 2026-07-01

### Dependencies
- **Production:** `@hono/node-server` 2.0.5 → 2.0.6, `hono` 4.12.26 → 4.12.27, `semver` 7.8.4 → 7.8.5. (#417)
- **Dev:** `@types/node` 25 → 26, `typescript-eslint` 8.61.1 → 8.62.1. (#416)

### Changed
- **Held `js-yaml` on 4.x and added a dependabot ignore for `js-yaml >=5.0.0`.** Dependabot grouped a `js-yaml` 4.x → 5.x major into the production bump, but 5.x is ESM-only and dropped the CommonJS `default` export, breaking our `import yaml from 'js-yaml'` call sites with `Missing 'default' export`. The bump now stays on 4.x until the code migrates to named ESM imports. (#417)
- **CI:** `actions/checkout` 6 → 7. (#413)

### Security
- **`@hono/node-server` 2.0.4 → 2.0.5** to resolve GHSA-frvp-7c67-39w9: on Windows, prefix-mounted Serve Static middleware could be bypassed. Only affects Windows deployments using Serve Static. (#408)

### Dependencies
- **Production:** `hono` 4.12.25 → 4.12.26, `semver` 7.8.1 → 7.8.4. (#408)
- **Dev:** `@types/node` 25.9.1 → 25.9.3, `@types/react` 19.2.16 → 19.2.17, `eslint` 10.4.1 → 10.5.0, `prettier` 3.8.3 → 3.8.4, `typescript-eslint` 8.60.1 → 8.61.1. (#409)

## [1.17.1] - 2026-06-19

### Fixed
- **Quiet mode (`!mentions on`) now survives an idle pause.** A session with "respond only when mentioned" enabled would still resume on the first non-mention reply once it had been paused for inactivity, defeating the whole point of quiet mode. The active-session path honored the gate but the paused-session resume path did not check the persisted `respondOnlyWhenMentioned` flag, so any plain message woke the session up. The resume path now applies the same gate: while quiet mode is on, a reply that doesn't @mention the bot no longer resumes a paused session. Commands (including `!stop`) still bypass the gate as before. (#410)

### Security
- **`hono` 4.12.23 → 4.12.25** to resolve CVE-2026-54290 (HIGH): the CORS middleware reflected any `Origin` with credentials when `origin` defaulted to `*`.
- **Pinned transitive `ws` ≥ 8.21.0 and `shell-quote` ≥ 1.8.4** (both pulled in via `ink`) to clear GHSA-96hv-2xvq-fx4p (HIGH, `ws` memory-exhaustion DoS) and GHSA-w7jw-789q-3m8p (CRITICAL, `shell-quote` newline escaping). Added to the existing `overrides`/`resolutions` blocks; runtime behavior is unchanged.

## [1.17.0] - 2026-06-05

### Added
- **`!mentions` quiet mode: respond only when @mentioned.** New per-session toggle for holding side conversations inside a bot thread without the bot replying to every message. `!mentions on` makes the bot ignore thread replies that don't explicitly @mention it; `!mentions off` (or a bare `!mentions` to flip the current value) turns it back off. Commands and pending worktree-branch-name prompts always bypass the gate, so `!mentions off` (and answering a worktree prompt) works even while quiet mode is on. When quiet mode is on, the session header shows a row noting it, so a returning user can see why the bot is staying quiet. The setting is owned by the session owner or a globally allowed user and persists across a bot restart. A global `respondOnlyWhenMentioned: true` in `config.yaml` (also offered in the onboarding wizard) seeds quiet mode on every new thread, so users who mostly want quiet threads don't have to run `!mentions on` each time; each session still keeps its own value and can override per-thread. The default everywhere is unchanged (the bot treats every approved-user reply as input), so existing threads and configs are unaffected. (#402)

### Dependencies
- **Production:** `js-yaml` 4.1.1 → 4.2.0, `react` 19.2.6 → 19.2.7. (#404)
- **Dev:** `typescript-eslint` 8.60.0 → 8.60.1. (#403)

## [1.16.3] - 2026-05-31

### Changed
- **Fixed the flaky Mattermost integration suite (two independent root causes).** These tests failed intermittently in CI, including on `main`, so this was a pre-existing infra flake rather than a regression. (1) *Channel contention:* every pooled test bot posted into one shared channel, each maintaining its own sticky message; run together the suites flooded that channel and tripped the Mattermost threads write race (`threads_pkey` 500s), surfacing as flaky task-list / context-prompt failures. Each suite now provisions a fresh channel via `initIsolatedTestContext`, routes its bot there, and removes it in `afterAll`, which eliminated the 500 storms. (2) *Leaked bot state across suites:* the bot/session/sticky layer keeps module-level global state (`stickyPostIds`, the session registry, the pool cursor) and live WebSockets, and Bun runs all suite files in one process. A bot whose socket wasn't fully torn down kept processing events into the next suite (posting "Bot Offline" stickies, resuming stale sessions), which broke the sticky suite. CI now runs each suite file in its own process, so process exit clears all shared state by construction. A follow-up also corrected the `should show status indicators` assertion, which required keep-alive indicators that a bypass-mode session-less bot never shows (it only passed before via the leaked state that process isolation removed). Test/CI-only; no runtime behavior changed. (#396, #398, #399)

### Dependencies
- **Production:** `@hono/node-server` 2.0.3 → 2.0.4, `hono` 4.12.21 → 4.12.23, `semver` 7.8.0 → 7.8.1, `ws` 8.20.1 → 8.21.0. `commander` 14 → 15 was deliberately held back: v15 requires Node ≥ 22.12 (the runtime floor is Node 20) and changes the default behavior of paired `--no-*` options the CLI relies on. (#401)
- **Dev:** `eslint` 10.4.0 → 10.4.1, `lint-staged`, `typescript-eslint` 8.59.4 → 8.60.0. Lockfile-only. (#400)

## [1.16.2] - 2026-05-31

### Fixed
- **Sturdier retry budget for the Mattermost post-save race.** Under load Mattermost can return a burst of 500s on `POST /posts` (the threads write race: duplicate key on `threads_pkey` / `app.post.save.app_error`) when several posts stream to the same thread. The retry budget was 3 attempts with plain exponential backoff; a heavy burst exhausted it and dropped a post, which surfaced as flaky task-list / sticky / context-prompt behavior. The budget is now 6 attempts with a capped (2s), equal-jittered backoff. The cap keeps the total wait bounded so a long retry chain can't itself stall things, and the jitter decorrelates concurrent posts that would otherwise re-collide on the same row lock every round. (#394)
- **Two remaining memory leaks after #351.** First, `MessageManager.dispose()` cleared the post tracker but never called `this.events.removeAllListeners()` on the per-session emitter. Each session attaches a handful of listeners (`question:complete`, `task:update`, `approval:complete`, and the rest), and their closures kept session state reachable after the session ended, so the heap grew with every session. `dispose()` now removes the listeners before resetting. Second, React 19 enables user timing when both `console.timeStamp` and `performance.measure` exist (the case on Node.js 25+), so every component re-render calls `performance.measure()` with a structured-clone'd prop-diff detail that Node buffers indefinitely (~50-205 KB per entry, ~2 GB after a long uptime). Nothing in the bot reads those entries, so a guarded `setInterval` clears them every 60 seconds with `.unref()` so it never blocks a clean exit. (#394)

## [1.16.1] - 2026-05-22

### Security
- **Fail-closed authorization on the user-driven paths that invoke Claude.** A confirmed bypass let an unauthorized Slack user (not in `allowedUsers`, non-empty allowlist) reach Claude: the bot posted both the "not authorized" warning and a real answer in the same thread. Rather than chase the one leaking caller, authorization is now deny-by-default at the functions that spawn or message Claude on a user's behalf: `startSession`, `sendFollowUp`, and `resumePausedSession`, plus the resume-from-reaction path. A single helper, `isAuthorizedForSession`, encodes every tier (global allowlist, empty-allowlist allow-all, per-session owner and invited users) and refuses a missing, empty, or `unknown` username. Every user-facing path now routes through that one helper instead of duplicating the check. The biggest gap was message-driven resume, which ran purely from persisted state with no identity check; it now takes a `username` and verifies it against the persisted session allowlist before resuming. The two system-triggered resume paths (bulk restore after a bot restart) stay ungated by design, since they carry no user identity. Legitimate username-less follow-ups (passthrough slash commands like `/context`, already authorized upstream) pass an explicit `system` flag so they are not caught. The mid-session approval flow is untouched: it still adds approved users to the session allowlist, so the check passes once approval is granted. (#388)
- **hono 4.12.18 → 4.12.21** picks up four upstream security fixes: GHSA-2gcr-mfcq-wcc3 (`app.mount()` stripped the mount prefix from the raw, undecoded pathname, so percent-encoded paths could be cut at the wrong offset and reach a sub-app with the wrong path), GHSA-xrhx-7g5j-rcj5 (`hono/ip-restriction` compared IPs by string equality, so non-canonical IPv6 forms such as compressed or hex IPv4-mapped addresses slipped past static deny rules), GHSA-3hrh-pfw6-9m5x (the cookie helper didn't sanitize `sameSite`/`priority`, allowing Set-Cookie injection via `;`, `\r`, `\n`), and GHSA-f577-qrjj-4474 (`hono/jwt` accepted any two-part Authorization header regardless of scheme, not just `Bearer`). claude-threads reaches hono through `@hono/node-server` on the inbound webhook surface, so the mount-prefix and Set-Cookie fixes are the relevant ones. (#386)

### Changed
- **Production deps** bumped: `@hono/node-server` 2.0.2 → 2.0.3 (preserves headers mutated after raw Response construction), `express-rate-limit` 8.5.1 → 8.5.2 (simplified IPv6 key generation). Lockfile-only. (#386)
- **Dev deps** bumped: `@types/bun` 1.3.13 → 1.3.14, `@types/node` 25.7.0 → 25.9.1, `@types/react` 19.2.14 → 19.2.15, `eslint` 10.3.0 → 10.4.0 (adds `includeIgnoreFile()` and a `for-direction` sequence-expression check, both additive), `lint-staged` 17.0.4 → 17.0.5, `typescript-eslint` 8.59.3 → 8.59.4 (fixes a `no-floating-promises` stack overflow on recursive types). Lockfile-only. (#385)

### Fixed
- **Multiple pasted screenshots no longer silently vanish.** When you paste several clipboard images into one chat message, the platforms hand them all the same filename (`image.png`). The save path wrote each one with the `wx` (`O_EXCL`) flag, so the second and later files hit `EEXIST`, got caught, and were reported as a download failure, so they never reached Claude. Saves now dedupe filenames within a single message, inserting a numeric suffix before the extension (`image.png`, `image_1.png`, `image_2.png`); files without an extension get `report`, `report_1`, and so on. The unique name is resolved before the write, so the `wx` flag still does its job against symlink races. (#387)
- **Inbound attachments are no longer capped at 100 MB.** A hard 100 MB ceiling on incoming files meant anything larger was skipped with a "too large" warning, which surprised people sharing big assets. The cap is gone; an attachment of any reported size is downloaded and written to disk. One tradeoff worth knowing: `downloadFile` still buffers the whole file in memory via `arrayBuffer()`, so a very large attachment is held in RAM while it's written. Streaming that download is a separate change. (#387)

## [1.16.0] - 2026-05-14

### Added
- **Per-platform channel-verbosity controls.** New `sessionHeader` and `stickyMessage` settings, both `full` (default) / `minimal` (one-line status bar) / `hidden` (no post). Reachable three ways: setup wizard ("How verbose should the bot be in this channel?"), CLI flags (`--session-header`, `--sticky-message`, applied to every platform), or per-platform YAML for split values. `hidden` for the header means Claude's reply is the first message in the thread; `hidden` for the sticky stops the `channel_post` bump entirely. Update notices still ride along in `minimal`. Session-header mode persists per session — resume preserves the user's choice. Old `sessions.json` defaults to `full`. The pre-existing top-level `stickyMessage: { description, footer }` block is unchanged. (#384, closes #383)

### Security
- **`ws` 8.20.0 → 8.20.1** picks up a fix for an uninitialized memory disclosure in `websocket.close()`. Triggered when a `TypedArray` (e.g. `Float32Array`) is passed as the `reason` argument instead of a string or `Buffer` — uninitialized memory was leaked to the remote peer. claude-threads doesn't pass typed arrays to `close()` anywhere we control, but the Mattermost client and inbound webhook surface use `ws` as a transitive dependency. (#382)

### Changed
- **Production deps** bumped: `@hono/node-server` 2.0.1 → 2.0.2 (serve-static fixes), `react` 19.2.5 → 19.2.6 (RSC type hardening), `semver` 7.7.4 → 7.8.0 (new `truncate` function), `ink-scroll-view` 0.3.6 → 0.3.7. Lockfile-only. (#382)
- **Dev deps** bumped: `@types/node` 25.6.0 → 25.7.0, `lint-staged` 16.4.0 → 17.0.4, `typescript-eslint` 8.59.2 → 8.59.3. lint-staged 17 drops Node 20 support, but it's a dev dep — the bot's runtime floor is unchanged. Lockfile-only. (#381)

## [1.15.2] - 2026-05-06

### Security
- **hono 4.12.15 → 4.12.17** picks up two upstream security fixes — GHSA-69xw-7hcm-h432 (unvalidated JSX tag names in `hono/jsx` could allow HTML injection) and GHSA-9vqf-7f2p-gf9v (`bodyLimit()` could be bypassed for chunked / unknown-length requests). claude-threads doesn't render JSX from untrusted input today, but the bodyLimit fix is load-bearing for the inbound webhook surface. (#377)

### Changed
- **Production deps** bumped: `@hono/node-server` 2.0.0 → 2.0.1 (forwards Hono response headers during WebSocket upgrade), `express-rate-limit` 8.4.1 → 8.5.0 (async store init), `zod` 4.3.6 → 4.4.3 (correctness fixes for `preprocess`, `catch`, and discriminated unions on absent object keys). Lockfile-only. (#377)
- **Dev deps** bumped: `eslint` 10.2.1 → 10.3.0, `typescript-eslint` 8.59.1 → 8.59.2. Lockfile-only. (#376)

## [1.15.1] - 2026-05-05

### Fixed
- **Numeric tool args no longer fail at the MCP boundary when the runtime sends them as strings.** Surfaced live during dogfooding of v1.15.0: calling `search_messages` with `max_results: 5` returned `Invalid input: expected number, received string` from the MCP framework, because the Claude MCP runtime sometimes serializes integer tool arguments as JSON strings before they reach the server, and the receiving `z.number().int()` schema rejected them at parse time. Switched the four affected fields to `z.coerce.number().int()` — `read_post.max_messages`, `list_thread.max_messages`, `read_channel_history.max_messages`, `search_messages.max_results` — so either form parses. Downstream `clamp*` helpers already defend against non-finite / non-positive values, so coercion can't widen the contract beyond the documented caps; non-integer strings like `"1.5"` still fail because `.int()` runs after coercion. Schemas exported so a contract test can verify the coercion without spinning up the full MCP transport. (#375)

## [1.15.0] - 2026-05-05

### Added
- **Claude can DM channel members directly via the new `send_dm` MCP tool.** When the user asks for a private ping ("DM me when this finishes," "send the report to alice as a DM"), Claude can now call `send_dm(recipient, message)` instead of asking the user to forward the result themselves. The recipient is a Mattermost username (`@anne` or `anne`) or a Slack user id (`U…`/`<@U…>`) — the asymmetry exists because Slack bot tokens can't reverse-look usernames cheaply, and paginating `users.list` per call is wasteful. Six gates run in order: shape (recipient and message non-empty, message under 4000-char cap), recipient resolution (platform API turns the input into a user id + canonical username), self-DM guard, channel membership (recipient must be a current member of the bot channel, fetched once and cached for 60s), rate limit (3 DMs per recipient per session, optimistic counter increment with rollback on deny / timeout / send-error), and a per-recipient interactive permission prompt the first time the session DMs each user. ✅ promotes that recipient — and only that recipient — to no-prompt for the rest of the session; the rate limit still applies. An in-flight set blocks parallel `send_dm` calls to the same recipient from posting duplicate prompts when Claude fans out tool_use blocks in a single turn. Every DM is prefixed with an attribution line — `_(automated message via claude-threads, on behalf of @anne from #channel)_` — so recipients can trace it back to the session that sent it; the channel name is fetched lazily via the platform's channel-info endpoint, the session-owner username is plumbed in from `session.startedBy` through a new `SESSION_OWNER_USERNAME` env var that threads `lifecycle.ts` → `restart-options.ts` → `ClaudeCliOptions` → `buildPermissionArgs` → MCP child (covers all five `new ClaudeCli` sites). New optional `McpPlatformApi` methods `getChannelMembers`, `resolveRecipient`, `sendDirectMessage`; `getChannelInfo` gained a `name?` field. RED-GREEN tests on every load-bearing guard — self-DM check, membership, rate limit, attribution prefix, allow-all-is-per-recipient, counter rollback on deny / timeout, in-flight-prompt deduplication. (#374)

## [1.14.1] - 2026-05-05

### Fixed
- **`!update` no longer leaves an interactive bot dead.** The auto-restart path silently broke for users running in a terminal. PR #333 (April) skipped the bash daemon when stdout was a TTY, because the daemon's bash background-job pattern strips the TTY and forces headless mode, but the bot's `!update` flow assumed the daemon was always there to catch exit code 42 and re-exec. Without the daemon, `process.exit(42)` just exited. Install succeeded, sessions persisted, then nothing came back. The fix introduces a `decideRespawn()` step before the exit. When a known supervisor is present (`CLAUDE_THREADS_BIN` from the bash daemon, `pm_id` + `PM2_HOME` from pm2, `INVOCATION_ID` from systemd, `CLAUDE_THREADS_INTERACTIVE` from a TTY-managing wrapper) the bot still exits 42 and lets the supervisor handle the restart so its restart-counters and rate-limits keep working. Otherwise, when there is a TTY, the bot self-respawns. It synchronously resolves `claude-threads` on PATH (with a fallback to `~/.bun/bin` because cron / systemd / launchd `PATH=` is often missing it), then `spawn(binPath, argv, { detached: true, stdio: 'inherit', shell: process.platform === 'win32' })` followed by `unref()` and `exit(0)`. The Node docs cover this combination explicitly: when stdio is inherited, the detached child stays attached to the parent's controlling terminal, so the new process inherits the TUI cleanly. Several footguns are handled. `spawn()` does not throw on ENOENT, it returns a child with `pid === undefined` and fires the `error` event asynchronously, so we check `pid` synchronously instead of trusting a try/catch that never triggers. Bun passes `env: { X: undefined }` as the literal string `"undefined"` (Node correctly omits it), so the auto-restart hand-off vars are removed via `delete` rather than overwrite. Windows `.cmd` shims need `shell: true` since Node 20.12.2 (CVE-2024-27980). Ink's raw mode is reset before the spawn so the new child starts with a clean stdin. If self-respawn cannot launch (no `claude-threads` on PATH at all), the bot broadcasts a clear "could not auto-restart, please run `claude-threads`" message before exiting, so the user is not left wondering what happened. Four prior PRs (#287, #300, #317, #333) chased this in the daemon path. This one fixes the bot side instead. (#372)

## [1.14.0] - 2026-05-05

### Changed
- **`read_post` allows cross-channel reads on public Mattermost channels.** The cross-channel guard kept rejecting permalinks that pointed outside the bot's session channel — appropriate for private/DM/group channels (real privacy concern: a thread participant without access to the source channel sees content they shouldn't), but overzealous for public channels where anyone with an account can already navigate to the post. `McpPost` now carries a `channelType?: 'public' | 'private'` field, populated for Mattermost via `/channels/{id}` (type `O` = public; `P`/`D`/`G` = private) with a per-process cache so chatty threads don't trigger N redundant lookups. The resolver skips the wrong-channel check when `channelType === 'public'`; missing `channelType` is treated as private (fail-safe). Slack is unchanged: its MCP-side `readPost` is hard-scoped to the bot's configured channel via `conversations.history`, so cross-channel reads aren't possible there regardless of channel visibility. (#369)

## [1.13.1] - 2026-05-05

### Fixed
- **`read_post` works on Mattermost subpath installs.** `parseMattermostPermalink` matched only on origin and ignored the configured baseUrl path, so on a Mattermost install at `/chat` (e.g. `digilab.overheid.nl/chat`) every permalink had a leading `/chat` segment that pushed the path to four segments and got rejected with "not a Mattermost permalink for ..." even though the link was on the bot's own instance. The parser now strips the configured subpath as a path-segment prefix before validating the `{team}/pl/{id}` or `_redirect/pl/{id}` shape; segment-level comparison so `/chat` doesn't accidentally match `/chatter`. Regression from #366. (#368)

## [1.13.0] - 2026-05-05

### Added
- **Claude can follow chat permalinks via the new `read_post` MCP tool.** When the user shares a Mattermost or Slack permalink in the thread, Claude can call `read_post(url, include_thread?, max_messages?)` to resolve it to the post body (and optional thread context) instead of asking the user to copy-paste. Auto-approved like `send_file`: the URL host check (Mattermost) or workspace `*.slack.com` + channel-id match (Slack) inside the handler are the real gate, since the bot's token is already scoped to what it can see. Defaults: 20 thread messages per call (hard cap 50), 2000-char body truncation per message, returned content marked as untrusted user input in the tool description (prompt-injection note). (#366)
- **Session collaborators surface as `Co-Authored-By:` trailers on commits Claude makes.** When the session owner runs `!invite @user`, that user's name + email is added to the system-prompt attribution block; the owner is the implicit author and is excluded, and the bot account plus AI assistants are excluded explicitly. Mid-session updates work without restart: `!invite` and `!kick` post a "Collaborators updated" notice in the thread, and Claude reads the current list from there on its next turn. Solo sessions still get a one-line standby instruction so a later `!invite` is honored without a respawn. All four Claude (re)spawn sites — `startSession`, `resumeSession`, `!cd`, worktree create/join — now compose the system prompt through one helper so the attribution rule cannot silently drop on respawn. Collaborators without a resolvable email are skipped silently rather than producing a malformed trailer. (#367)

### Changed
- **MCP package renamed `claude-threads-permissions` → `claude-threads-mcp`** to match the broader MCP-server scope (permission prompts, file uploads, post reads — no longer permission-only). Tool names exposed to Claude follow: `mcp__claude-threads-permissions__send_file` → `mcp__claude-threads-mcp__send_file`, etc. **Breaking for in-flight sessions across upgrade**: a Claude run that started under the old name will see the new tool names after restart, so any auto-approve rules tied to the old prefix need updating. The bot itself rewires automatically. (#366)
- **`src/mcp/permission-server.ts` renamed to `src/mcp/mcp-server.ts`.** Same content, accurate name. The npm `bin` entry `claude-threads-mcp` already pointed at the dist artifact, so no change for downstream installs apart from the bundled-file path inside the dist tarball. (#366)

### Internals
- **`PermissionApi` interface renamed to `McpPlatformApi`.** The interface now covers permission prompts, file uploads, and post reads, so the old name no longer fits. Includes file renames (`src/platform/permission-api*.ts` → `src/platform/mcp-platform-api*.ts`) and the matching impl files under `src/platform/{mattermost,slack}/`. (#366)
- **Shared permalink utilities at `src/platform/permalink-shared.ts`.** Caps (`DEFAULT_THREAD_LIMIT`, `MAX_THREAD_LIMIT`, `MAX_MESSAGE_BODY_CHARS`) and helpers (`clampThreadLimit`, `truncateBody`, `quoteBlock`) used by both Mattermost and Slack permalink modules — prevents drift on rendering rules. (#366)
- **Shared `fetch` test harness at `src/platform/test-helpers/fetch-harness.ts`.** Consolidates the recorder + responder pattern that lived in three platform-API test files. (#366)
- **`buildAppendSystemPrompt` helper in `src/commands/system-prompt-generator.ts`.** Single composition point for the four Claude (re)spawn sites; covers solo-standby and full-collaborator forms with shared exclusion guidance for owner / bot / AI. (#367)
- **`GitHubEmailsStore` (`src/persistence/github-emails-store.ts`).** Persists collaborator email lookups so the attribution block can be rebuilt after a restart without re-querying the platform. (#367)

## [1.12.0] - 2026-05-05

### Added
- **Claude can send files inline via the new `send_file` MCP tool.** Closes #360. When Claude produces an artifact during a session — Playwright screenshot, generated TTS MP3, plot, document — it can now post the file directly into the chat thread by calling `send_file(path, caption?)` instead of asking the user to fetch it from a URL. The tool runs inside the per-session `claude-threads-permissions` MCP child (no second MCP server needed), validates the path against the session working directory and per-session upload directory, then drives the Mattermost two-step `/api/v4/files` + `/api/v4/posts file_ids` flow or Slack's three-step v2 flow (`files.getUploadURLExternal` + presigned PUT + `files.completeUploadExternal`). Returns `{ ok: true, postId }` on success or `{ ok: false, reason }` on failure so Claude can retry or apologize to the user. Auto-approved by the permission gate (path validator is the real gate; making the user 👍 every screenshot would defeat the feature). Available in all three permission modes (`default`, `auto`, `bypass`) — bypass-mode now spawns the MCP server too so the tool stays available in the build-anything-on-demand setups that motivated the issue. Optional `outboundFiles: { enabled?, maxBytes? }` block on each platform config — defaults to enabled with a 100 MB cap. Reuses the per-thread upload directory and `MAX_UPLOAD_SIZE` ceiling already established by inbound attachments (PR #359). The system prompt now leads with "You are RIGHT NOW running inside a chat thread" and explicitly tells the model not to claim the tool is unavailable, after a manual test caught the model improvising an apology even though the tool was wired up. (#361)

### Security
- **Path validator hardens `send_file` against traversal and tricks.** New `src/mcp/path-validator.ts`. Rejects: non-absolute paths, anything that resolves (via `realpath`) outside the session working directory or per-session upload directory (path-prefix containment, so `/srv/sessions-evil` does not match `/srv/sessions`), non-regular files (FIFOs, sockets, devices, directories), SUID/SGID files, oversize files, zero-byte files (which Slack's upload endpoint rejects anyway), and dangerously wide allowed roots like `/`, `/home`, `/etc`, `/var`, `/tmp` (so a misconfigured `SESSION_WORKING_DIR` fails loudly instead of widening the trust boundary). The uploader receives the realpath-resolved path so it can't be re-pointed by a symlink between validation and read. Every reject branch has a unit test verified RED-GREEN against the live function. Follow-ups for TOCTOU between validate and read, per-session rate-limiting, and caption-length truncation tracked in #362-#365. (#361)

### Internals
- **`buildRestartCliOptions` helper.** Five places in the codebase construct a `ClaudeCli` (start, resume, `!cd`, `!permissions interactive`, `!worktree create`/`switch`). Each must thread `uploadDir` and `outboundFiles` through, or `send_file` silently breaks for that path. Two of the five (worktree paths) were skipped in the original PR and only caught by manual testing. Extracted to `src/claude/restart-options.ts` so all sites share one source of truth. (#361)
- **Env-var contract test pins names across the bot↔MCP-child boundary.** `OUTBOUND_ENV` constants in `src/mcp/outbound-env.ts` are referenced by both `buildPermissionArgs` (emit side) and `permission-server.ts` (consume side); a contract test asserts the names match and no bare string literal is used on either side. Caught a class of silent rename-drift bugs that would otherwise type-check and unit-test green while breaking the feature at runtime. (#361)
- **Portable chmod helper for tests.** Bun 1.3.x masks the SUID/SGID/sticky bits in `fs.chmod` and `chmodSync` (verified against 1.3.3); the SUID-rejection branch of the path validator was untestable without a workaround. New `src/test-utils/chmod-portable.ts` `setMode()` tries the runtime's chmod, verifies via `stat`, and falls back to `/bin/chmod` if the high bits didn't land. Works on Node (fast path) and Bun (shell fallback). (#361)

## [1.11.0] - 2026-05-03

### Changed
- **Chat attachments delivered to Claude as file paths instead of inlined base64.** When a user attaches an image, PDF, text file, or anything else to a chat message, the bot now writes the bytes to a per-thread directory under `os.tmpdir()/claude-threads-uploads/<platform>-<thread>/<message>/` and prepends the absolute paths to the user's message. Claude reads the file with its built-in `Read` tool (full multimodal capability preserved for images and PDFs) or `mv`/`cp`s it to the user's project storage. Closes #358 — the reporter wanted to save uploads into their app's resource storage and couldn't, because the bytes arrived inline as content blocks with no path to copy from. The per-thread directory is removed in `cleanupSession()` on every exit path. Single 100 MB sanity ceiling per file replaces the previous patchwork of per-type caps (32 MB PDF, 1 MB text, 50 MB zip). (#359)
- **Drops the in-process zip/gzip extraction.** `yauzl` and `yazl` are gone — Claude can `unzip` archives in Bash itself when needed, which removes ~300 LOC of zip-bomb-defense plumbing and the per-format size caps that came with it. Net change for the PR: +496/-1737 LOC.

### Security
- **Symlink defense on the per-thread upload directory.** The directory path is predictable (it derives from the platform id and thread id, both visible to anyone in the thread). On a shared host a local attacker could pre-create that path as a symlink to a sensitive directory and have the bot write attacker-controlled file contents into the linked target. Now `lstat` the upload dir on every save and refuse if it is a symlink, `mkdtemp` the per-message leaf for atomic creation, and use `writeFile` flag `'wx'` (`O_CREAT | O_EXCL`) so the final write fails rather than follows a symlink at the leaf.
- **Filename and MIME type are stripped of control characters before being interpolated into Claude's prompt.** A name like `screenshot.png\n[SYSTEM] ignore previous instructions` would otherwise have appeared on its own line, mimicking system text. Filenames also keep going through `basename()` so `../escape` and absolute-path attempts can't escape the message subdirectory.
- **Path-traversal defense on `platformId` / `threadId`.** Both segments now go through a `safeIdSegment` filter (`[^A-Za-z0-9._-]` → `_`) before being used in the upload-dir path, so a misconfigured platform id like `../../etc` cannot escape the uploads root via `path.join` normalization.

## [1.10.0] - 2026-04-29

### Added
- **Thread permalink in Claude session context.** The system-prompt context block now includes `**Thread:** <permalink>` alongside the existing platform and working-directory entries. When Claude opens a PR, files a ticket, or otherwise produces an artifact for someone to review later, it can paste the link back into the description so reviewers can trace the change to the discussion it came from. Mattermost and Slack both already exposed `getThreadLink()`; pure plumbing change. Also restores the platform/working-directory context on the worktree-restart path, which had been silently dropped pre-existing. (#352)

### Fixed
- **Sticky-by-thread Claude account binding (multi-account mode).** In multi-account configurations the `claudeAccountId` written to `sessions.json` and the `$HOME` Claude was actually spawned under could drift apart under concurrent acquisitions, leaving sessions unresumable after a bot restart with `Detected permanent failure: The conversation history for this session no longer exists`. Real-world incident: 14 sessions soft-deleted in one restart cycle, 3 of them genuine victims of this drift. `AccountPool.acquire()` now binds threads to accounts deterministically via `accounts[hash(threadId) % n]` (FNV-1a, dependency-free), so the spawn-time `$HOME` and the persisted id both derive from the same hash and cannot drift. `preferredId` still wins over the sticky binding (resume invariant: OAuth history can't move), and the sticky path falls through to round-robin when the chosen account is in cooldown. (#350)

## [1.9.4] - 2026-04-29

### Fixed
- **Memory leak across session lifecycles.** `PostTracker` registered every post created during a session but its `clearSession(sessionId)` was only invoked on full bot shutdown. Across many sessions the in-memory map grew without bound and contributed to V8 mark-compact becoming ineffective and an eventual OOM abort (observed at ~14 h uptime). `MessageManager.dispose()` now clears its session's `PostTracker` bucket, and dispose is wired into all five session-removal paths in `src/session/lifecycle.ts`: normal exit, kill, idle timeout, pause, shutdown, early exit, resume-fail, plus the start-failure and resume-failure error branches that bypass the shared cleanup helpers. (#356, fixes #351)

## [1.9.3] - 2026-04-24

### Internals

- **Extracted `ReactionRouter` from `SessionManager`** into `src/session/reaction-router.ts`. The reaction dispatch logic (allowlist gate, audit log, resume-from-reaction, session-level reactions, MessageManager fallthrough) previously inlined as three private methods on `SessionManager` now lives in its own module behind an explicit `ReactionRouterDeps` interface. Pure extraction — no behavior change, no persisted-schema change. `manager.ts` dropped from 1767 to 1633 LOC. (#348)
- **Lifecycle FSM** (`src/session/lifecycle-fsm.ts`). `transitionTo()` now validates each `from → to` change against an allowed-transition table. Warn-only by default — illegal transitions log at `warn` with a structured `fsm.illegal_transition` payload and the state assignment proceeds. Set `CLAUDE_THREADS_FSM_STRICT=1` to throw instead. The transition table is derived from observed transitions in the codebase, not an idealised graph; wiring it up surfaced five legitimate transitions (`starting→paused`, `starting→interrupted`, `starting→restarting`, `paused→restarting`, `interrupted→paused`) that the original comment block didn't mention. (#349)
- **Removed `CLAUDE_THREADS_SERIALIZE_V2` rollback flag** from PR 3. `persistSession` now unconditionally goes through `MessageManager.serialize()`. One release of bake time with the parity test as guard; snapshot tests remain. (#349)
- **Removed `CLAUDE_THREADS_MCP_CONFIG_INLINE` rollback flag** from PR 2. Production always writes the MCP config to an owner-only tempfile (mode 0600); the `inline` opt on `materializeMcpConfig` stays as a test-only shortcut. (#349)

## [1.9.2] - 2026-04-24

### Fixed
- **Unreadable `[object ErrorEvent]` in WebSocket error logs.** Recent Node / undici deliver a browser-style `ErrorEvent` (not a plain `Error`) to `ws.onerror`, and `` `${event}` `` stringifies that wrapper to `[object ErrorEvent]` — the original failure cause was being dropped. New `formatWebSocketError(err)` helper in `src/platform/utils.ts` pulls the first usable signal (`.message` → `.error.message` → `.type (code: .code)` → `String(err)`), wired into all five WebSocket error sites across Slack + Mattermost main clients, both MCP permission-server clients, and the UI re-emit. The Slack client's rejection and re-emitted `Error` now carry the underlying message too, instead of the opaque `"Socket Mode WebSocket error"`. (#347)
- **Worktree creation under a parent branch gave a generic "Failed to create worktree" message.** When a flat branch `test` already exists and the user requests `test/add-unit-coverage`, git refuses with `fatal: 'refs/heads/test' exists; cannot create 'refs/heads/test/add-unit-coverage'`. `parseWorktreeError` now matches this specific shape and reports `Branch <parent> already exists and blocks <nested>` with the suggestion to pick a non-nested name or delete the parent branch first. (#347)

## [1.9.1] - 2026-04-24

### Internals
- **Unified `Executor<TState>` contract.** New interface in `src/operations/executors/types.ts` formalizes what `MessageManager` actually relies on: `getState` / `reset` required, `handleReaction` / `serialize` optional. `BaseExecutor<T>` implements it. A new `contract.test.ts` iterates every executor and asserts the shape — catches drift when someone adds an executor without the required members. (#346)
- **Uniform `handleReaction` signature across all seven reaction executors** — `(postId, emoji, user, action, ctx) => Promise<boolean>`. Previously `TaskList`, `Subagent`, and `WorktreePrompt` had slightly different shapes. `MessageManager.handleReaction` now dispatches via a `reactionDispatchList()` table instead of an if/else chain. (#346)
- **`MessageManager.serialize()` aggregates executor state** for `SessionManager.persistSession`. The writer no longer reaches into individual executors via named getters (`getTaskListState()`, `getPendingContextPrompt()`). Legacy getters kept as `@deprecated` shims — they still have non-persistence consumers. (#346)
- **Byte-identical `sessions.json` guarantee.** New snapshot tests in `manager.test.ts` pin the full payload's field set and run the new and legacy (`CLAUDE_THREADS_SERIALIZE_V2=0`) paths through a parity assertion. No persisted-schema change on disk. (#346)
- **Rollback hatch:** `CLAUDE_THREADS_SERIALIZE_V2=0` falls back to the pre-refactor per-getter writer for one release. Removed in the next minor. (#346)

## [1.9.0] - 2026-04-24

### Added
- **Three-way permission modes** — `default` | `auto` | `bypass`. Claude CLI 2.1.x introduced a classifier-based `auto` permission mode; claude-threads now exposes it alongside the historical `default` (MCP-prompt-everything) and `bypass` (`--dangerously-skip-permissions`) modes. Set via `permissionMode` in `config.yaml`, the `--permission-mode` CLI flag, or the `!permissions default|auto|bypass` in-session command (legacy `interactive`/`skip` aliases still work). Onboarding wizard now picks `auto` as the recommended default. UI toggle key `[p]` cycles through the three modes. (#343)
- **Security hardening: MCP config via owner-only tempfile** — the Claude subprocess's MCP permission config contains the bot's platform token. It used to be passed inline on `--mcp-config` argv, exposing the token in `ps`. Now written to a mode-`0600` tempfile and passed by path; cleaned up on Claude exit. Gated by `CLAUDE_THREADS_MCP_CONFIG_INLINE=1` rollback flag for one release. (#342)
- **Audit log for rejected reactions** — `SessionManager.handleReaction` now emits a structured `reaction.rejected` event when the allowlist check drops a reaction. Observable signal for probing attempts without changing enforcement behavior. (#342)
- **Bounded aggregate stderr cap across `ClaudeCli` instances** — per-instance 10KB cap stays; under aggregate pressure (>10MB) instances trim to 1KB so a runaway fleet cannot dominate the bot's heap. (#342)
- **Tunable `flushDelayMs`** — streaming cadence (default 500ms) is now configurable via `limits.flushDelayMs` in `config.yaml`. (#342)

### Changed
- **Onboarding and UI speak the three-mode language.** The wizard question changed from `Require approval for Claude actions? (Y/n)` to a three-way picker, defaulting to `auto`. The keyboard `[p]erms` indicator in the footer cycles default → auto → bypass with color-coded severity (green/yellow/red) instead of a green/gray on/off chip.
- **`!permissions` command accepts all three modes** plus legacy aliases. `!permissions interactive` → `default`; `!permissions skip` → `bypass`. The confirmation post shows the canonical mode name and a one-sentence description of what it does.
- **Sticky message and session header** show the three-mode chip (`🔐 Default`, `⚡ Auto`, `⚠️ Bypass`) consistently. Previously the sticky used `⚡ Auto` to mean bypass.

### Deprecated
- **`skipPermissions: boolean` in platform config** — keeps working as an alias. `permissionMode: 'default'|'auto'|'bypass'` is the new canonical field. Precedence: `permissionMode` wins when both are set. (#343)
- **`--skip-permissions` / `--no-skip-permissions` CLI flags** — kept as aliases for `--permission-mode bypass` / `--permission-mode default`. (#343)

### Fixed
- **`content.ts` thread log lost exception text on updatePost failure** — the refactor that collapsed five try/catch blocks into a `tryUpdatePost` helper in #342 dropped the `error: String(err)` field from the flush-path thread log. Restored. (#342)
- **`!permissions <mode>` right after session start aborted Claude** with `No conversation found with session ID`. The respawn paths hardcoded `--resume`, but pre-first-turn sessions have no conversation to resume. Now gated on `session.lifecycle.hasClaudeResponded`. Same fix applied to plugin install/uninstall respawn. (#345)
- **`!help` showed stale `!permissions interactive\|skip`** with a pipe that rendered as the literal `\|` inside a Mattermost markdown table. Registry updated to `default / auto / bypass` (no table-breaking pipe) with a three-mode description. (#345)
- **Session header kept showing the bot-wide mode after `!permissions auto`** — Claude respawned with the correct flag but the session object didn't track the override, so the header read bot-wide. Added `Session.permissionModeOverride` and a single `effectivePermissionMode` helper that all call sites (header, `isSessionInteractive`, respawn on `!cd`/plugin/worktree) now route through. (#345)

### Removed
- **`src/mattermost/api.ts`** — the standalone REST helpers folded into `src/platform/mattermost/permission-api.ts` (only consumer). Net removal: 194 lines of code + 459 lines of redundant tests; equivalent HTTP-level coverage now lives in `src/platform/mattermost/client.test.ts`. (#342)
- **`src/config.ts`** — 37 lines of re-exports. `src/config/migration.ts` renamed to `src/config/index.ts` so the config module's entry point reflects what it actually is. (#342)
- **Internal `skipPermissions` shadow fields** — removed from `SessionConfig`, `ClaudeCliOptions`, `StickyMessageConfig`, and a private `SessionManager` getter once the new `permissionMode` was plumbed end-to-end. (#343)

### Internals
- **Test coverage floor raised** before the structural refactors above. New test files for MCP permission server, plugin handler, Mattermost client, and permission-API helpers. Existing `lifecycle.test.ts` and `manager.test.ts` expanded for branch coverage. Totals: 1970 → 2101 tests (+131). Coverage on `src/mcp/permission-server.ts`: 0% → 80% lines; `src/operations/plugin/handler.ts`: 0% → 100% funcs; `src/session/lifecycle.ts`: 21% → 31% lines. (#341)
- **Small testability refactor in `src/mcp/permission-server.ts`** — extracted `handlePermissionWith()` so the permission flow is unit-testable without spinning up the real `PermissionApi` or reading `process.env` at module load. No behavior change. (#341)
- **5 try/catch blocks in `src/operations/executors/content.ts`** collapsed into a `tryUpdatePost` helper with `onSuccess`/`onFailure` callbacks — keeps the three distinct failure-state reset variants explicit via callbacks rather than hiding them. (#342)
- **DRY permission-mode helpers**: `permissionModeDisplay`, `permissionModeDescription`, and `effectivePermissionMode` live in `src/config/types.ts` as single sources of truth. A `MODE_INFO: Record<PermissionMode, …>` table backs the display + description helpers. The original `permissionModeForRestart` helper was introduced in #343 and then collapsed into `effectivePermissionMode` in #345 once the precedence logic for "respawn mode" and "current effective mode" had converged. (#343, #345)

## [1.8.3] - 2026-04-24

### Fixed
- **Duplicate `claude.sendMessage()` on every session start** — `lifecycle.startSession()` was misreading `offerContextPrompt`'s return contract: the helper returns `false` after sending the message itself in the auto-include / no-context branches, but `lifecycle.ts` interpreted that as "didn't send, please send" and fired a duplicate. Every session start was sending the user's prompt to Claude twice. Net effect on production: ~2× the API turns at session start. Fix: trust the helper's return contract and don't double-send. (#340)
- **Listener leak on `disconnect()`** — `disconnect()` was synchronous: it called `ws.close()` and returned, but EventEmitter listeners stayed attached. Any in-flight `'message'` event the WebSocket queued just before close still fired the bot's `startSession`. Mostly invisible in production (shutdown paths don't reconnect immediately) but caused integration test bots to receive duplicate session-start events during back-to-back test transitions. `disconnect()` now removes all event listeners before closing, and returns `Promise<void>` resolving when the close handshake completes (1s safety timeout). Production callers in shutdown paths can fire-and-forget; tests can `await`. (#340)
- **Integration test flake (~30-40% pass-rate gap)** — multiple root causes addressed:
  - Each integration-test bot now uses its own Mattermost user account from a 4-bot pool. Previously all test bots shared one token, so transient overlapping `disconnect()` / `connect()` windows delivered the same WebSocket events to multiple bots, producing duplicate session starts.
  - Each pool bot uses a unique `platformId`. Module-level state in `src/operations/sticky-message/handler.ts` (a `Map<platformId, postId>`) was conflating bots when they all shared `platformId='test-mattermost'`, causing 403 permission errors on cross-bot post operations.
  - Test helper `MattermostTestApi` now retries 500s with exponential backoff (mirroring the production client). Mattermost throws transient 500s on `/posts` due to a residual `pq: duplicate key` race even on 10.11.15; the test fixture used to throw on the first one.
  - `bot.stop()` now awaits the WebSocket close handshake instead of a fixed sleep.
  - CI workflow `--timeout` aligned with `package.json` script (`120000`); the previous hardcoded `60000` silently overrode test-level timeouts. (#340)

### Changed
- **`PlatformClient.disconnect()` is now `Promise<void>`** instead of `void`. Existing callers in `src/index.ts` and `src/message-handler.ts` are shutdown paths that fire-and-forget; the change is source-compatible (the returned Promise can be ignored). (#340)

## [1.8.2] - 2026-04-22

### Breaking
- **Minimum Node.js bumped from 18 to 20.** Required by `@hono/node-server@2`. Node 18 has been past end-of-life since April 2025, so most installs are already on 20+. (#335)

### Fixed
- **Plain reply could no longer resume a paused session after bot restart** — when the bot restarted more than 2× `sessionTimeoutMinutes` after a session's last activity, `cleanStale()` soft-deleted the paused record. The reply-resume path used `load()` (which hides soft-deleted sessions), so a user reply in the thread promised by the timeout message (`send a new message to continue`) fell through to the `Mention me with your request` branch and a subsequent @mention started a fresh session, losing thread context. The 🔄 reaction path never had this problem because it reads raw data via `findByPostId`. The two resume paths now share the same visibility into the 3-day history window. (#336, thanks @shaders)
- **Flaky `MAX_SESSIONS Limit` integration test** — the Mattermost docker container in CI throws transient 500s on `/posts` that trigger ~1.5s of retry backoff per call. Six sequential session starts under that overhead pushed at least one `waitForSessionActive` past its 10s deadline ~30-50% of runs. The test now uses a 20s per-step budget under `CI`. The race the test guards (`maxSessions` cap, fixed in v1.7.1 / #331) is unchanged. (#337)

### Changed
- **Dependencies** — `@hono/node-server` 1.19.14 → 2.0.0 (#335), `eslint` 10.2.0 → 10.2.1, `prettier` 3.8.2 → 3.8.3, `typescript` 6.0.2 → 6.0.3, `typescript-eslint` 8.58.2 → 8.59.0 (#334).

## [1.8.1] - 2026-04-21

### Fixed
- **Interactive users silently demoted to headless when `autoUpdate` was enabled** — the auto-restart daemon runs the child as a bash background job (`&`), which leaves stdout piped and stdin detached. Ink can't render there, so the TUI dropped out without any error. Three prior patches (#287, #300, #317) each fixed the active crash mode inside the daemon path; none questioned whether interactive users should be routed through the daemon at all. The daemon is now skipped when `process.stdout.isTTY` and `--headless` isn't set. Unattended paths (explicit `--auto-restart`, `--headless`, or no TTY) still go through the daemon. (#333)

## [1.8.0] - 2026-04-21

### Added
- **Pass `MCP_CONNECTION_NONBLOCKING=true` to the Claude child** — caps `--mcp-config` connects at 5s so a slow MCP server never delays session startup. Requires Claude CLI 2.1.89+. Set it explicitly in the bot's own env to override.
- **Pass `ENABLE_PROMPT_CACHING_1H=true` to the Claude child** — opts into the 1-hour prompt cache TTL, meaningfully reducing re-caching cost on long-lived threads that idle past the default 5-minute window. Requires Claude CLI 2.1.108+. Set it explicitly in the bot's own env to override.
- **Documented `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`** as an opt-in hardening flag. When set on the bot's env it passes through to Claude, which strips the specific credential env vars `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, and `GOOGLE_APPLICATION_CREDENTIALS` from any Bash, hook, or stdio MCP subprocess it spawns (empirically verified on CLI 2.1.116). Bot-specific vars like `PLATFORM_TOKEN` / `MATTERMOST_TOKEN` / `SLACK_BOT_TOKEN` pass through untouched. **Side effect:** the flag also forces Claude's permission mode to `default` and rejects `--dangerously-skip-permissions`; the bot now warns at startup if the flag is set alongside any platform configured with `skipPermissions: true`. Requires Claude CLI 2.1.83+.

### Fixed
- **Stale Claude CLI version range in `CLAUDE.md`** — the docs said `>=2.0.74 <=2.0.76`, but the actual pin in `version-check.ts` has been `>=2.0.74 <2.2.0` since v1.x. Also bumped the "install a compatible version" hint in the runtime error from `@2.1.1` to `@2.1.116`.

## [1.7.1] - 2026-04-21

### Fixed
- **`maxSessions` cap could be exceeded under concurrent session starts** — `startSession()` passed the cap check synchronously but then awaited `createPost()` before committing the session to the map, so concurrent starts all read the same stale count and over-admitted. The integration test `"should reject new session when at capacity"` flaked at ~40% for weeks because of this. Pending starts are now tracked alongside committed sessions in the cap check. (#331)
- **Reject Claude accounts with both `home` and `apiKey` set** — the two are documented as mutually exclusive, but `AccountPool` silently preferred `home` when both were configured. Now the account is dropped with a warning so misconfiguration surfaces. (#330, thanks @shaders)
- **Tighten `reset_at` epoch regex in rate-limit detection** — the old pattern matched `"preset": N` and (more importantly) `reset_after=N`, a *relative* retry-after hint that would have been misread as an absolute epoch and pushed cooldown decades into the future. Added word-boundary anchors and regression tests. (#330)
- **Rate-limit emit guard now allows deadline extensions** — the boolean latch in `ClaudeCli` fired at most once per process, so a second rate-limit hit with a longer reset time couldn't widen `AccountPool.markCooling`'s extend-only window. Replaced with a numeric last-deadline tracker: repeat hits at the same severity still dedupe, but a later deadline re-emits. (#330)

## [1.7.0] - 2026-04-21

### Added
- **Multi-account Claude support (opt-in)** — configure a pool of Claude accounts in `config.yaml` so sessions round-robin across multiple subscriptions / API keys and stop sharing one token budget. Each Claude CLI spawn runs with an overridden `HOME` (for OAuth Pro/Max accounts) or `ANTHROPIC_API_KEY`. Persisted sessions remember which account they were started on and resume under the same one. Omitting `claudeAccounts` leaves the bot in single-account mode — zero change for existing installs. (#328, thanks @shaders)
- **Rate-limit detection & auto-reassignment** — the bot parses Claude's stderr and result events for rate-limit signals (`usage limit reached`, `rate_limit_error`, `429 ... rate limit`, `quota exceeded`) and puts the offending account into cooldown until the extracted reset time (with a 1-hour fallback). A heads-up is posted in the session thread so the user knows which account is cooling. (#328)
- **Session header & sticky-message account indicators** — the per-session header shows `🔑 Claude account` when multi-account mode is active, and the channel sticky summarizes the pool: `🔑 N accounts` or `🔑 A/N accounts (K cooling)`. (#328)

## [1.6.3] - 2026-04-21

### Fixed
- **Skipped file attachments are now surfaced on session start** - When a user starts a session with an unsupported file (e.g. `.xlsx`), the bot posts the `⚠️ Some files could not be processed` warning instead of silently dropping it. The same warning now fires on the mid-thread context-prompt and worktree paths. (#325, thanks @shaders)
- **Recognize `.har` and `.log` as text** - Both extensions come through as `application/octet-stream` via Mattermost/Slack and were previously dropped as unsupported. (#325)

## [1.6.2] - 2026-04-20

### Fixed
- **MCP server path resolution in bundled builds** - Fixes `__dirname` resolution when the project is bundled with `bun build` into a single `dist/index.js` (#316)
- **CLAUDE_THREADS_INTERACTIVE forwarding to daemon subprocess** - Parent no longer falsely advertises a TTY to the piped-stdio child in daemon mode (#312, #317)
- **Sticky message test regex** - Updated to match the actual header format (#319)
- **Flaky permissions integration test** - Uses pattern-based waits instead of fixed post counts to tolerate intermittent CI 500s (#320)

### Security
- **Override path-to-regexp to >=8.4.0** - Fixes CVE-2026-4926 (HIGH severity DoS) pulled in transitively via @modelcontextprotocol/sdk → express → router (#318)
- **Bump hono to 4.12.14** - Fixes GHSA-458j-xx4x-4375 (improper JSX attribute name handling in hono/jsx SSR) (#324)

### Dependencies
- **Bump production dependencies** - @hono/node-server, hono, @redactpii/node, react (#311, #326)
- **Bump dev dependencies** - @types/yazl, @types/bun, @types/node, prettier, typescript-eslint (#310, #322)
- **Bump CI actions** - actions/upload-pages-artifact 4 to 5 (#321)

## [1.6.1] - 2026-04-07

### Security
- **Bump path-to-regexp to 8.4.0** - Fixes CVE-2026-4926 (DoS via malicious route patterns) (#303)

### Dependencies
- **Bump production dependencies** - @hono/node-server, @modelcontextprotocol/sdk, express-rate-limit, yauzl (#308)
- **Bump dev dependencies** - TypeScript 5.9 to 6.0, @types/bun, @types/node, @types/react, lint-staged, typescript-eslint (#309)
- **Bump CI actions** - actions/configure-pages 5 to 6, actions/deploy-pages 4 to 5, schneegans/dynamic-badges-action 1.7 to 1.8 (#304, #305, #306)

## [1.6.0] - 2026-03-27

### Added
- **Windows compatibility** - Process spawning now works on Windows via Git Bash or WSL (#295)

### Fixed
- **False headless detection via daemon** - Bot no longer incorrectly activates headless mode when spawned by the auto-restart daemon. The daemon runs the child as a background job which stripped TTY assignment; now the parent's TTY status is forwarded via environment variable (#299, #300)

### Security
- **Override picomatch to >=2.3.2** - Fixes GHSA-c2c7-rcm5-vvqj (ReDoS via extglob quantifiers) in transitive dependencies (#302)
- **Override flatted to >=3.4.0** - Fixes GHSA-25h7-pfq9-p65f

### Dependencies
- **Bump production dependencies** - hono, @hono/node-server, picomatch, and others (#289, #292, #297, #298)
- **Bump dev dependencies** - eslint 9→10, typescript 5.7→5.9, typescript-eslint 8.50→8.57 (#301)
- **Bump CI actions** - aquasecurity/trivy-action 0.35.0 (#288)

## [1.5.1] - 2026-03-09

### Fixed
- **Crash when stdin is not a TTY** - Bot now falls back to headless mode when stdin is not a TTY (e.g., when run via daemon in a non-interactive shell) (#287)

## [1.5.0] - 2026-03-08

### Added
- **Customizable sticky message** - New `stickyMessage` config with `description` and `footer` fields to personalize the pinned channel message (#262, #286)

## [1.4.8] - 2026-03-08

### Fixed
- **WebSocket not defined on Node.js** - Added compatibility layer for `--target node` builds; bot now works on Node.js <22 and all Bun versions (#263, #283)
- **Orphaned daemon processes** - Daemon wrapper now traps SIGTERM/SIGINT/SIGHUP, kills child process cleanly, and forwards the actual signal (#258, #282)
- **Session store crash on malformed file** - `sessions.json` containing `{}` or missing fields no longer crashes; `loadRaw()` validates structure defensively (#258, #284)
- **!stop ignored in paused sessions** - `!stop`/`!cancel` commands now work in paused sessions instead of being passed as prompts (#258, #285)

## [1.4.7] - 2026-03-08

### Security
- **Bump hono to 4.12.5** - Fixes CVE-2026-29045 (arbitrary file access via serveStatic)
- **Bump @hono/node-server to 1.19.11** - Fixes CVE-2026-29087 (authorization bypass via encoded slashes)
- **Bump express-rate-limit to 8.3.0** - Fixes CVE-2026-30827 (IPv4-mapped IPv6 rate limiting bypass)
- **Bump @modelcontextprotocol/sdk to 1.26.0** - Fixes CVE-2026-25536
- **Bump hono to 4.12.3** - Fixes CVE-2026-27700

### Dependencies
- **Bump production dependencies** - hono 4.12.5, @hono/node-server 1.19.11, express-rate-limit 8.3.0, @modelcontextprotocol/sdk 1.26.0 (#281, #276, #271, #270)
- **Bump dev dependencies** - ajv 6.14.0 (#264)
- **Bump CI actions** - actions/upload-artifact v6→v7 (#273), aquasecurity/trivy-action 0.34.2 (#274, #265, #257)
- **Add overrides/resolutions** for @hono/node-server and express-rate-limit to pin transitive deps
- **Ignore transitive minimatch ReDoS advisories** in bun audit

## [1.4.6] - 2026-01-29

### Security
- **Bump hono to 4.11.7** - Resolves 4 moderate audit vulnerabilities (GHSA-9r54, GHSA-w332, GHSA-6wqw, GHSA-r354)

### Dependencies
- **Bump production dependencies** - commander 14.0.2, diff 8.0.3, hono 4.11.7, semver 7.7.3, zod 3.25.76 (#248)
- **Bump dev dependencies** - @types/bun, @types/node 25.0.3, @types/react 19.2.7, eslint 9.39.2 (#247)
- **Bump trivy-action** - aquasecurity/trivy-action from 0.31.0 to 0.33.1 (#243)

## [1.4.5] - 2026-01-18

### Fixed
- **Worktree switch with prompt** - `!worktree switch branch prompt text` now switches to existing worktree and starts session with the prompt (#242)

## [1.4.4] - 2026-01-18

### Fixed
- **Worktree commands in root messages** - `!worktree list` now works without a session, `!worktree branch-name` now starts session without requiring additional prompt (#241)

## [1.4.3] - 2026-01-18

### Added
- **Typing indicator on thread start** - Show typing indicator immediately when a new thread starts (#239)

### Fixed
- **Worktree subcommands in root messages** - Commands like `!worktree list` and `!worktree clean` now work in the first message when @mentioning the bot (#240)

## [1.4.2] - 2026-01-18

### Fixed
- **Todo checkbox alignment** - Replace ⬜ with 🔲 for pending tasks to fix irregular spacing (#238)

## [1.4.1] - 2026-01-18

### Fixed
- **npm publish failure** - Fixed override conflict for hono dependency that caused npm publish to fail

## [1.4.0] - 2026-01-18

### Added
- **Tool formatters for additional MCP tools** - New formatters for shell, notebook, playwright, figma, and context7 tools (#237)
  - `TaskOutput`, `KillShell`, `BashOutput` for shell operations
  - `NotebookEdit` for Jupyter notebook operations
  - Playwright browser automation tools (navigate, screenshot, wait, etc.)
  - Figma design tools (screenshot, metadata, design context)
  - Context7 documentation tools (resolve-library-id, query-docs)
- **Commands in first message** - `!commands` now work in the initial session message (#236)
  - Supports `!permissions`, `!cd`, `!worktree`, `!invite`, `!context`
  - Example: `@bot !permissions skip` starts session without permission prompts
- **Skill tool formatter** - Display for `/skill` commands showing skill name and arguments (#234)

### Security
- **Security audit fixes and Trivy CI integration** - Added npm audit and Trivy scanning to CI workflow (#235)
  - Fixed path traversal vulnerability in thread logger
  - Fixed prototype pollution in thread logger
  - Sanitized worktree branch names to prevent git command injection
  - Sanitized session IDs to prevent directory traversal

## [1.3.2] - 2026-01-17

### Changed
- **Clearer version display** - Status bars now show `CT v1.3.2 · CC v2.1.12` instead of `v1.3.2 · CLI 2.1.12` (#232)
  - CT = claude-threads (this bot)
  - CC = Claude Code (the CLI)

### Fixed
- **Resolve ESLint warnings** - Fix 5 `no-non-null-assertion` lint warnings (#233)

## [1.3.1] - 2026-01-17

### Fixed
- **WebSocket reconnection restored** - Fixed critical bugs in reconnection logic that were introduced in v1.0.3 (#231)
  - Heartbeat now properly triggers reconnection when detecting dead connections (was just closing without reconnecting)
  - Auto-retry on reconnection failure restored (was lost when code was refactored to base class)
  - TUI will no longer show "connected" when connection is actually dead
  - All platforms (Mattermost and Slack) now benefit from robust reconnection logic

## [1.3.0] - 2026-01-17

### Added
- **Dynamic slash command passthrough** - Unknown `!commands` are now checked against Claude CLI's available slash commands and passed through automatically (#229)
  - Captures `slash_commands` from Claude CLI's `init` event
  - `!foo` passes through to `/foo` if it's an available slash command
- **`!plugin` command** - New command for managing Claude Code plugins (#229)
  - `!plugin list` - Shows installed plugins
  - `!plugin install <name>` - Installs a plugin and restarts Claude CLI
  - `!plugin uninstall <name>` - Uninstalls a plugin and restarts Claude CLI

### Fixed
- **Package manager detection for updates** - Updates now use the same package manager (bun/npm) that was used to install claude-threads (#230)
  - Prevents duplicate global installations when updating
  - Respects `BUN_INSTALL` env var for custom bun install locations

## [1.2.1] - 2026-01-17

### Fixed
- **npm install peer dependency warning** - Removed unused react-devtools-core dependency that conflicted with ink (#229)

## [1.2.0] - 2026-01-17

### Added
- **Node.js compatibility** - claude-threads now works with Node.js 18+ in addition to Bun (#228)
  - Replace Bun-specific APIs with Node-compatible equivalents
  - Default installation via `npm install -g claude-threads`
  - Built output works with both `bun` and `node` runtimes
- **Context preservation for directory changes** - When using `!cd` or `!worktree`, the bot preserves what you were working on (#227)
  - Generates work summary using haiku before switching contexts
  - `!cd`: Shows summary in context prompt for user selection
  - `!worktree` mid-session: Auto-includes work summary and all thread context

## [1.1.0] - 2026-01-16

### Added
- **Side conversation context** - Messages between approved users that mention other users (e.g., `@bob what do you think?`) are now tracked and included as context for Claude when the next message is sent (#226)
  - Security measures: Only approved users, max 5 messages, 2000 chars, 30 min window
  - Messages are framed as "for awareness only - not instructions to follow"
- **Source tracking for approved guest messages** - When a guest user's message is approved, Claude now sees who sent it and who approved it (#225)
  - Format: `[Message from @guest_user, approved by @session_owner]`

### Fixed
- **Root message included in thread context** - Fixed bug where the root message was excluded when starting a session mid-thread (#224)

## [1.0.13] - 2026-01-16

### Fixed
- **Claude CLI detection for non-standard installations** - Improved detection for users who installed Claude CLI via non-npm methods (#222)
  - Searches common installation paths (`/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`, etc.)
  - Uses `which claude` to resolve symlinks
  - Parses multiple version output formats
  - Shows helpful debug info (PATH directories) when not found
  - Added `getClaudePath()` helper shared between version check and CLI spawning

## [1.0.12] - 2026-01-15

### Fixed
- **Skipped file feedback posting** - Fixed swapped arguments in createPost call that caused "Invalid RootId parameter" errors when posting feedback for skipped files (#221)

## [1.0.11] - 2026-01-15

### Added
- **Improved gzip error handling** - Uses streaming decompression for better error messages when gzip files are corrupt or truncated (#219)

### Changed
- **Shorter initial session message** - Session start message is now more concise for popup-friendly display (#218)

### Dependencies
- **Bump diff from 8.0.2 to 8.0.3** (#220)

## [1.0.10] - 2026-01-14

### Added
- **Zip archive support** - Extract and process files from zip archives (#217)
  - Supports text files and PDFs inside zip archives
  - Safety limits: 50MB max zip size, 20 max files, 10MB per decompressed file
  - Skips unsupported files with helpful messages

### Fixed
- **Improved error messages** - Error notifications now include actual error details instead of generic "An error occurred" message

## [1.0.9] - 2026-01-14

### Added
- **Support file attachments beyond images** - Added support for PDF, text, and gzip file attachments (#216)
  - PDF files: Sent as document content blocks (32MB max)
  - Text files: .txt, .md, .json, .csv, .xml, .yaml, and source code files (1MB max)
  - Gzip files: Automatically decompressed and processed based on content type
  - User feedback: Helpful messages for skipped/unsupported files with suggestions

### Changed
- **Dependency updates** - Updated actions/checkout to v6, actions/upload-pages-artifact to v4, hono to 4.11.4

## [1.0.8] - 2026-01-13

### Fixed
- **Maximize content per message when height-splitting** - Split algorithm now finds the optimal breakpoint to maximize content per message, instead of splitting at the first available breakpoint. Previously would split after Part 1 when Parts 1-4 could fit together.

## [1.0.7] - 2026-01-13

### Fixed
- **Check combined content height for streaming split decisions** - Fixed bug where height check only evaluated new content instead of combined content (existing + new), causing "Show More" collapse when total exceeded threshold but new content alone didn't (#212)

## [1.0.6] - 2026-01-13

### Fixed
- **Pre-split tall content for new posts** - Height-aware splitting now also applies when creating new posts, not just when updating existing ones (#211)

## [1.0.5] - 2026-01-13

### Added
- **Height-aware message breaking** - Mattermost messages now split based on estimated rendered height (~500px threshold) instead of character count, reducing "Read more" collapsed messages (#210)
  - Code blocks: 18px/line + 32px padding
  - Headers: 32px, Lists/Blockquotes: 24px, Tables: 28px/row
  - Text wrapping estimated at ~90 chars/line
  - Code blocks are never broken mid-block

## [1.0.4] - 2026-01-13

### Changed
- **Disable session header pinning** - Session headers are no longer pinned to avoid clutter (#208)

### Fixed
- **Sticky message link validation** - Fixed bug where invalid `lastMessageId` could cause malformed links in sticky messages (#209)

### Refactored
- **Extract BasePlatformClient** - Consolidated common code between Mattermost and Slack clients into a shared base class, reducing duplication (#205)

## [1.0.3] - 2026-01-13

### Fixed
- **WebSocket reconnection after long idle** - Improved reconnection reliability with forceful cleanup of stale connections, automatic retry on failure, and more compact UI (#206)
- **Metadata suggestion retry logic** - Added retry logic for title/description/tags fetching on session start with up to 2 retries (#207)

## [1.0.2] - 2026-01-13

### Fixed
- **Session header posts deleted by sticky cleanup** - Fixed bug where session header and task list posts were incorrectly deleted by the sticky message cleanup function (#204)
- **Table rendering regression** - Fixed pipe escaping in `formatKeyValueList` and missing blank line before tables (#203)

## [1.0.1] - 2026-01-13

### Changed
- **Cleaner session header** - Simplified session start message, moved detailed info to help menu (#202)

### Fixed
- **Worktree prompt skipped when branch specified** - When starting a session with a branch name in the initial message (e.g., `@bot on branch fix/bug do X`), worktree prompt is now correctly skipped (#201)
- **Pipe characters in markdown tables** - Fixed escaping of `|` characters in help menu table rows (#200)

## [1.0.0] - 2026-01-13

### Changed
- **Major architecture refactor** - Consolidated operations module with specialized executors (#199)
  - `MessageManager` now orchestrates all message operations via 9 specialized executors
  - Each executor owns its state: Content, TaskList, QuestionApproval, MessageApproval, Prompt, BugReport, Subagent, System, WorktreePrompt
  - Session is now a thin container; all business logic lives in `src/operations/`
  - Unified reaction routing through MessageManager

### Added
- **Security documentation** - Enhanced `SECURITY.md` with comprehensive authorization matrix
  - Documented multi-layer authorization model (platform → session → role)
  - Added key security files with line numbers for audit
- **DRY improvements**
  - Moved `escapeRegExp` to `platform/utils.ts` (eliminated Slack/Mattermost duplication)
  - Added `logSilentError` utility for debugging empty catch blocks
- **Observability** - Added content executor logging for tracing content operations

### Fixed
- **Task list integration test** - Test was looking for deleted post; now checks completion message
- **Task list cleanup** - Posts are properly deleted when all tasks complete

## [0.62.2] - 2026-01-11

### Fixed
- **Message content lost on update** - Fixed race condition where first assistant message content was being overwritten by subsequent content (#197)
  - Root cause: When `result` event triggered `flush()`, it was clearing `currentPostId` synchronously before the async flush completed
  - This caused subsequent flushes to UPDATE the same post with only new content, overwriting the original
  - Fix: Track what content has been posted in `currentPostContent` and combine with new content when updating
  - Now properly defers clearing `currentPostId`, `currentPostContent`, and `pendingContent` until after flush completes

## [0.62.1] - 2026-01-11

### Fixed
- **Slack/Mattermost message accumulation** - Fixed bug where `pendingContent` was not cleared after flushing, causing messages to accumulate all previous content (#196)
  - Introduced `clearFlushedContent()` helper to safely remove only flushed content while preserving content added during async operations
  - Added race condition protection: content appended during `createPost`/`updatePost` is no longer lost
  - Added comprehensive regression tests for the accumulation bug and race condition scenarios

## [0.62.0] - 2026-01-11

### Fixed
- **Worktree aggressive pruning** - Fix multiple bugs causing worktrees to be deleted shortly after creation (#194)
  - `isBranchMerged()` no longer detects new branches as merged (main cause of immediate deletion)
  - Only check for merged branches on worktrees older than 24 hours
  - Added race condition protection for worktrees with session IDs
  - Call `updateWorktreeActivity()` on session activity to prevent long-running sessions from having their worktrees pruned

### Added
- **Unified command registry** - Single source of truth for all commands and reactions (#195)
  - `src/commands/registry.ts` - Central command definitions with categories, audiences, and Claude execution permissions
  - `src/commands/help-generator.ts` - Generates `!help` message from registry
  - `src/commands/system-prompt-generator.ts` - Generates Claude's system prompt from registry
  - `claudeCanExecute` and `returnsResultToClaude` flags to identify which commands Claude can use
  - Help message and system prompt are now always in sync

## [0.61.0] - 2026-01-11

### Added
- **Configurable limits via config.yaml** - Session limits, timeouts, and cleanup intervals can now be configured in the `limits` section (#193)
  - `maxSessions`, `sessionTimeoutMinutes`, `sessionWarningMinutes`
  - `cleanupIntervalMinutes`, `maxWorktreeAgeHours`, `cleanupWorktrees`
  - `permissionTimeoutSeconds` - now properly wired to MCP server (was broken)
- **Advanced settings wizard** - `--setup` now includes "Advanced settings" option with grouped questions (#193)
  - Session Limits: max sessions, timeouts, permission timeout, keepAlive toggle
  - Cleanup Settings: intervals, worktree cleanup, thread log settings
  - Conditional questions skip irrelevant settings (e.g., worktree age when cleanup disabled)
- **keepAlive in advanced settings** - Prevent system sleep setting now configurable via wizard (#193)

### Fixed
- **Permission timeout bug** - `permissionTimeoutSeconds` was in config but not passed to MCP server (#193)
- **Readable YAML config** - Config files now use proper block-style YAML instead of JSON-like flow style (#193)
- **Config summary shows advanced settings** - Preview before saving now displays non-default advanced settings (#193)
- **Aligned log output** - Shortened logger component names to prevent column misalignment (#192)
  - `auto-update` → `updater`, `git-worktree` → `git-wt`, `post-helpers` → `post`, etc.

## [0.60.0] - 2026-01-11

### Added
- **Background cleanup scheduler** - Log cleanup and orphan worktree cleanup now run in the background (every hour) instead of blocking startup (#191)
- **Session monitor class** - Idle session timeout check and sticky refresh now use a proper class with start/stop interface (#191)

### Improved
- **Faster bot startup** - Cleanup tasks run fire-and-forget instead of blocking initialization (#191)
- **Consistent background task interface** - Both `SessionMonitor` and `CleanupScheduler` have matching `start()`/`stop()` methods (#191)
- **Better naming** - Renamed `cleanupTimer` to `sessionMonitor` for clarity (#191)

## [0.59.0] - 2026-01-11

### Added
- **Comprehensive setup guide** - New consolidated SETUP_GUIDE.md with step-by-step instructions for Mattermost and Slack bot creation (#190)
- **Slack app manifest in onboarding** - Option to copy Slack app manifest to clipboard for quick setup (#190)
- **Smart display name defaults** - Automatically derive display names from Mattermost server URLs (e.g., "acme-corp.mattermost.com" → "Acme Corp") (#190)
- **Claude CLI validation** - Onboarding now checks for Claude CLI installation and compatible version before continuing (#190)
- **Credential validation** - Real-time validation of Mattermost and Slack credentials with helpful error messages (#190)
- **Secure config file permissions** - Config file now saved with 0o600 permissions (owner-only) since it contains API tokens (#190)

### Improved
- **Dramatically improved onboarding UX** - Complete rewrite of the setup wizard with better prompts, contextual hints, and retry loops (#190)
- **Reconfigure flow** - New smart reconfigure mode that shows existing config and lets you edit specific sections (#190)
- **Security warnings** - Warning when allowing anyone in the channel to use the bot (#190)
- **Platform instructions shown inline** - Setup instructions for each platform shown after selecting it, reducing need to consult external docs (#190)

### Removed
- **Legacy setup docs** - Removed docs/MATTERMOST_SETUP.md and docs/SLACK_SETUP.md in favor of consolidated SETUP_GUIDE.md (#190)

## [0.58.0] - 2026-01-10

### Improved
- **More stable session titles** - Titles now stay consistent throughout the session by anchoring on the original task rather than constantly changing based on recent messages (#189)
  - Original task is used as the PRIMARY anchor for title generation
  - Recent context only matters if the session focus fundamentally changed
  - Existing title is preserved unless there's a major direction shift

### Removed
- **Dead code cleanup** - Removed obsolete marker-based metadata extraction from events.ts (title/description now generated out-of-band via quickQuery)

## [0.57.0] - 2026-01-10

### Added
- **Enhanced audit logging** - Comprehensive logging for user messages, commands, reactions, and permissions (#184)
- **Audit logs in bug reports** - Last 50 log entries are now included in `!bug` GitHub issues for better debugging (#184)
- **Username anonymization** - Usernames in bug reports are replaced with User1, User2, etc. to protect privacy (#184)
- **PII/secret redaction** - Added `@redactpii/node` library for comprehensive redaction of emails, phone numbers, SSNs, credit cards, API keys, tokens, and more (#184)
- **Log file path in session header** - Session header now shows the path to the JSONL log file (#184)

## [0.56.0] - 2026-01-10

### Added
- **Persist Claude threads to disk** - Conversation history is now saved to JSONL files for debugging and auditing purposes (#183)

### Fixed
- **Truncate long titles/descriptions** - Long auto-generated titles and descriptions are now truncated instead of being rejected (#182)
- **!update now consistency** - The `!update now` command now checks for updates consistently with `!update` (#181)

## [0.55.0] - 2026-01-10

### Added
- **Enhanced subagent display with live elapsed time** - Subagent boxes now show live elapsed time during execution, and can be toggled between expanded/collapsed views with reaction emojis (#177)
- **Preserve runtime settings across daemon auto-restarts** - Permission mode, working directory, and session number are now preserved when the daemon auto-restarts after updates (#180)

### Fixed
- **Title and tag suggestions timing out** - Increased timeout to 15s and improved error handling to prevent silent failures when generating session titles and tags (#178)
- **Stale questions after plan approval/rejection** - Questions are now automatically cleared when a plan is approved or rejected to prevent stale state (#179)

## [0.54.0] - 2026-01-10

### Added
- **Auto-generated session titles and descriptions** - Sessions now automatically get meaningful titles and descriptions generated by Claude Haiku at startup (#175)
- **Session tags** - Sessions are automatically classified with tags like `bug-fix`, `feature`, `refactor`, etc. Tags are re-evaluated every 5 messages as the session focus shifts (#175)

### Fixed
- **`!update` emoji reactions not working** - Fixed missing post registration causing update confirmation reactions to be silently ignored (#173)
- **Reconnecting mode display** - Fixed misaligned UI display when a platform is reconnecting (#174)
- **Task list 404 errors** - Fixed errors when bumping task list to bottom of thread when posts were already deleted (#176)

## [0.53.1] - 2026-01-09

### Fixed
- **Branch suggestions timing out** - Increased timeout from 5s to 15s for Claude-powered branch name suggestions, which were timing out due to Claude CLI startup time

## [0.53.0] - 2026-01-09

### Added
- **Claude-powered branch suggestions** - When creating a worktree, Claude (Haiku) now suggests 2-3 branch names based on your task. React with number emojis to select, type your own, or skip (#170)
- **!kill confirmation message** - The `!kill` command now posts a confirmation showing how many sessions are being killed (#167)

### Changed
- **!kill preserves sessions** - Sessions are now preserved on `!kill` so they can resume after manual restart. Uses exit code 0 to prevent daemon auto-restart (#169)

### Fixed
- **Worktree creation failure handling** - Instead of silently falling back to main repo, now shows an interactive prompt with user-friendly error messages and retry option (#168)
- **Bug report images** - Fixed images not appearing in GitHub issues created via `!bug` (#171)

## [0.52.1] - 2026-01-09

### Fixed
- **Bug report image upload error** - Fixed `downloadFile` method losing `this` context when passed as callback, causing "undefined is not an object" error (#163)

## [0.52.0] - 2026-01-09

### Fixed
- **Image attachments in bug reports** - Fixed image attachments not appearing in bug reports by uploading to Catbox before generating the report (#158)
- **Sticky message install command** - Fixed npm/bun string issue in sticky message and added website link (#159)
- **Paused sessions auto-resuming** - Fixed paused sessions incorrectly auto-resuming on bot restart by persisting paused state (#160)
- **403 permission errors** - Fixed 403 errors when unpinning/updating stale task posts by handling channel post deletion gracefully (#161)

## [0.51.0] - 2026-01-09

### Added
- **Image upload for bug reports** - Bug reports can now include screenshots uploaded to Catbox.moe. Use `!bug <description>` with an attached image or paste a screenshot (#153)

### Fixed
- **Duplicate task lists** - Fixed issue where multiple task lists would appear in threads due to race conditions (#152, #151)
- **Code block rendering** - Fixed issues with code blocks not rendering correctly, including improved handling of language tags and empty blocks (#154)
- **Website logo rendering** - Improved SVG logo rendering on the project website (#155)

## [0.50.0] - 2026-01-09

### Added
- **Bug reporting feature** - Users can now report bugs with `!bug <description>` command. The bot collects recent conversation context, session state, and system info into a markdown report posted as a file attachment (#150)

## [0.49.0] - 2026-01-09

### Added
- **Tabbed session interface** - Sessions now display as tabs with status indicators (●/○/◌), replacing the collapsible list. Press `1-9` to switch between session tabs (#149)
- **Split-screen layout** - New layout with platforms and logs side-by-side in the top section, session tabs and content in the bottom section
- **Stylized platform icons** - New distinctive icons: `𝓜` for Mattermost, `🆂` for Slack
- **Headless mode support** - Bot can now run without a TTY (e.g., in Docker, systemd) with automatic detection and graceful fallback
- **Panel system** - New layout components with priority-based space distribution
- **Modal overlay system** - Update status modal with proper overlay rendering

### Changed
- **Session selection** - Changed from expand/collapse (`expandedSessions: Set`) to tab selection (`selectedSessionId: string`)
- **Typing indicator position** - Moved from floating at bottom to inline in session header title line
- **Panel hints** - Logs panel hints now appear inline with title (e.g., `Logs (19) · up/down scroll...`)

### Fixed
- **Layout spacing** - Fixed duplicate height allocation and adjusted proportions (35% top, 65% bottom)
- **Platform name wrapping** - Increased panel width to prevent "Mattermost" from wrapping

## [0.48.17] - 2026-01-09

### Fixed
- **Typing indicator overflow** - Fixed text wrapping issue showing "eTyping..." on separate line, moved spinner after label (#147)
- **Excessive Slack logging** - Reduced API logging from sticky message cleanup with throttling (max once per 5 min) and time-based filtering (#148)

## [0.48.16] - 2026-01-09

### Added
- **Scrollable logs panel** - Logs are now scrollable with keyboard navigation (↑↓ arrows, g/G for top/bottom). Press `[l]` to focus logs panel for scrolling (#146)
- **Section headings** - Added clear section headings (Platforms, Logs, Threads) with counts
- **Numbered platforms and threads** - Each platform and thread now shows its number for quick reference
- **Clear screen at startup** - Terminal clears at startup for a clean UI

### Changed
- **StatusLine pinned to bottom** - Status bar now stays at the bottom of the terminal
- **Dynamic log height** - Logs section uses available terminal space

## [0.48.15] - 2026-01-09

### Fixed
- **Clean screen on normal shutdown** - Screen now clears on Ctrl+C / quit, not just on update restart (#145)

## [0.48.14] - 2026-01-09

### Fixed
- **Clean screen before update restart** - Screen now clears and cursor is restored before the daemon restarts, so the new UI appears cleanly at the top instead of below the old UI remnants (#144)

## [0.48.13] - 2026-01-09

### Fixed
- **Don't crash when no platforms connect** - Improved 0.48.12 fix to log error instead of throwing when all platforms fail to connect, allowing the bot to stay running so users can fix configuration

## [0.48.12] - 2026-01-09

### Fixed
- **Graceful platform connection failures** - Bot no longer crashes when one platform fails to connect. Failed platforms are automatically disabled and the bot continues with remaining platforms

## [0.48.11] - 2026-01-09

### Reverted
- **Sticky plan approval message** - Reverted #142 due to plan mode issues

## [0.48.10] - 2026-01-09

### Changed
- **Support Claude CLI 2.1.x** - Updated version compatibility range from `>=2.0.74 <=2.1.1` to `>=2.0.74 <2.2.0` to support all 2.1.x releases

## [0.48.9] - 2026-01-08

### Added
- **Sticky plan approval message** - Plan approval messages now stay at the bottom of the thread while pending (similar to task list), with a horizontal rule for visual separation. This improves UX by keeping the approval prompt visible below the plan content (#142)

## [0.48.8] - 2026-01-08

### Fixed
- **Sessions now persist before update restart** - When `!update now` was triggered, sessions were lost because the bot exited without persisting them. Now sessions are properly saved before restart and resume automatically after the update (#141)

## [0.48.7] - 2026-01-08

### Fixed
- **Emoji rendering on Mattermost** - Removed Unicode-to-shortcode conversion that was causing broken emoji display (`:stopwatch:`, `:pause:` etc. showing as text). Modern Mattermost clients (7.x+) render Unicode emoji natively (#140)

## [0.48.6] - 2026-01-08

### Added
- **Claude can execute !worktree list** - Claude can now run `!worktree list` command and receive the results in the conversation, enabling better worktree management (#137)

### Fixed
- **Orphaned pinned sticky messages cleaned up** - Sticky messages from previous bot instances are now properly unpinned and deleted on startup (#138)
- **Stopwatch emoji compatibility** - Changed from Unicode ⏱️ to standard `:stopwatch:` shortcode for better cross-platform compatibility (#139)

## [0.48.5] - 2026-01-08

### Fixed
- **Slack msg_too_long errors fixed** - Messages are now safely truncated before sending to Slack API, preventing 4000+ character errors (#136)
- **Emoji conversion for Slack reactions** - Emoji names like `thumbsup` are now correctly converted to unicode for Slack reactions and Mattermost messages (#135)

## [0.48.4] - 2026-01-08

### Fixed
- **Code blocks no longer split incorrectly** - Messages are now split at line boundaries and never inside code blocks, removing ugly continuation markers (#134)
- **Disabled platforms show dim indicator** - Changed disabled platform status from red (error) to dim (inactive) for clearer visual feedback (#132)

### Added
- **CI smoke test** - Added startup verification to CI pipeline to catch binary launch issues early (#133)

## [0.48.3] - 2026-01-08

### Changed
- **Support Claude CLI 2.1.1** - Updated version compatibility range from `>=2.0.74 <=2.0.76` to `>=2.0.74 <=2.1.1` (#131)

## [0.48.2] - 2026-01-08

### Fixed
- **CI knip checks now pass** - Added `--no-config-hints` flag to knip in CI and pre-commit to handle environment differences (dist/ exists locally but not in CI)

## [0.48.1] - 2026-01-08

### Fixed
- **Pre-commit hooks work with non-JS files** - Added `--allow-empty` to lint-staged so commits with only markdown/config files don't fail
- **Knip no longer flags prettier** - Added prettier to ignoreDependencies and ignoreBinaries in knip config

### Changed
- **Updated release documentation** - Added PR check verification step and removed `--no-verify` flags from release instructions

## [0.48.0] - 2026-01-08

### Added
- **Claude can execute !cd command** - Claude can now output `!cd /path` in responses to change the session's working directory, with visibility messages posted to the thread (#125)

### Fixed
- **Update reactions now work** - Fixed bug where 👍/👎 reactions on auto-update messages were silently ignored due to missing `pendingUpdatePrompt` state (#124)
- **Duplicate task lists prevented** - Replaced promise-lock with atomic lock acquisition pattern to fix race condition causing duplicate task list posts (#126)
- **Worktree paths shortened in Bash** - Bash commands now show `[branch]/path` instead of full worktree paths, matching other tools (#127)

### Removed
- **Removed .env.example** - Configuration is done via YAML config only

## [0.47.0] - 2026-01-07

### Added
- **Session context in system prompt** - Claude now receives metadata about the session including version, current working directory, git status, and platform info (#119)

### Fixed
- **Task list duplication fixed** - Resolved race condition causing duplicate task lists by extending promise lock scope (#122)
- **Code blocks now render correctly** - Added trailing newline to code blocks for proper markdown rendering (#123)
- **Worktree paths shortened in UI** - Paths now show as `[branch]/path` instead of full worktree paths for better readability (#121)
- **Worktree metadata centralized** - Moved `.claude-threads-meta.json` to central config directory to avoid polluting project directories (#120)

### Changed
- **Bump @modelcontextprotocol/sdk** - Updated from 1.25.1 to 1.25.2 (#118)

## [0.46.0] - 2026-01-07

### Added
- **Emoji reactions for `!update` command** - React with 👍 to update immediately or 👎 to defer for 1 hour, easier than typing commands on mobile

### Fixed
- **Auto-update uses bun instead of npm** - Fixed updates to use `bun install -g` matching the actual install location
- **ESLint warnings resolved** - Fixed 8 non-null assertion warnings with proper null checks
- **Dead code removed** - Removed unused Discord formatter/types and other dead code via Knip

### Changed
- **Knip added to CI and pre-commit** - Dead code detection now runs automatically

## [0.45.0] - 2026-01-07

### Added
- **Update modal in CLI UI** - Press `u` to open a modal showing update status, changelog, and options to apply or defer updates
- **Worktree path shortening** - Tool output shows shortened worktree paths as `[branch]/path` instead of full paths for readability

### Fixed
- **Duplicate task list posts in Slack** - Fixed race condition that caused double task list messages
- **Worktree prompt cleanup** - Remove ❌ reaction from worktree prompts after user responds
- **Streaming message failures** - Handle `updatePost` failures gracefully with automatic recovery

### Changed
- **`.claude-threads-meta.json` added to .gitignore** - Session metadata files are no longer tracked

## [0.44.0] - 2026-01-07

### Added
- **Persist platform enabled state** - Platform enabled/disabled toggles (Shift+1-9) now persist across restarts. When you disable a platform, it stays disabled after bot restart.

## [0.43.0] - 2026-01-07

### Added
- **Auto-restart on updates** - Bot automatically restarts after installing updates when running with daemon wrapper
- **`!update` command family** - Check update status, force immediate update (`!update now`), or defer (`!update defer`)
- **`--auto-restart` / `--no-auto-restart` CLI flags** - Control auto-restart behavior (enabled by default when `autoUpdate.enabled`)

### Changed
- **Platform-specific formatting for update messages** - Update notifications now use proper bold/italic formatting per platform (Mattermost vs Slack)
- **Improved daemon wrapper** - Now correctly uses local binary instead of global installation

## [0.42.0] - 2026-01-07

### Fixed
- **Slack message visibility for long sessions** - Add platform-specific message size limits (Slack: 12K, Mattermost: 16K) with error recovery when `updatePost` fails - automatically creates new message instead of silently losing content
- **ExitPlanMode approval on Slack** - Fix emoji reaction handling by normalizing `thumbsup` → `+1` across platforms

### Added
- **`!approve` / `!yes` commands** - Text-based alternative to 👍 reaction for plan approval
- **Plan mode status in session header** - Shows 📋 Plan pending or 🔨 Implementing status

### Changed
- **User follow-up message handling** - Reset `currentPostId` on user follow-up messages so Claude's responses start in fresh messages with proper code block closure

## [0.41.0] - 2026-01-07

### Changed
- **Test coverage threshold increased to 80%** - CI now enforces minimum 80% line coverage (previously 75%)
- **Comprehensive test suite expansion** - Added 400+ new tests bringing total to 942 tests:
  - `src/changelog.test.ts` - Changelog parsing and "What's New" extraction
  - `src/logo.test.ts` - ASCII art logo generation
  - `src/version.test.ts` - Package version resolution
  - `src/session/types.test.ts` - Session type definitions
  - `src/test-utils/mock-formatter.test.ts` - Mock formatter utilities
  - `src/update-notifier.test.ts` - Update notification system
  - Enhanced tests for message-handler, mattermost/api, platform/utils, and session modules

### Added
- **Coverage badge** - README now displays live test coverage percentage via shields.io endpoint

## [0.40.1] - 2026-01-07

### Changed
- **Dependency updates** - Updated ink (5.2.1 → 6.6.0) and react (18.3.1 → 19.2.3)

## [0.40.0] - 2026-01-07

### Added
- **Centralized worktree location** - All worktrees now created in `~/.claude-threads/worktrees/` for easy management
- **`!worktree cleanup` command** - Manually delete current worktree and switch back to repo root
- **Merged branch detection** - Worktrees are automatically cleaned on startup if their branch was merged into main/master
- **Worktree ownership tracking** - Only sessions that created a worktree can trigger cleanup (not sessions that joined)
- **Worktree reference counting** - Prevents deletion while other sessions are using the same worktree

### Changed
- **Worktrees preserved on session exit** - No automatic cleanup when sessions end normally; use `!worktree cleanup` for manual cleanup or wait for orphan cleanup on startup (>24h old)

## [0.39.0] - 2026-01-06

### Added
- **Test coverage enforcement** - CI now enforces minimum 55% code coverage with new unit tests for:
  - `src/claude/cli.test.ts` - Claude CLI spawning and MCP config
  - `src/message-handler.test.ts` - Message routing logic
  - `src/session/manager.test.ts` - Session manager orchestration
  - `src/session/reactions.test.ts` - Emoji reaction handling
- **Slack app manifest** - Added `docs/slack-app-manifest.yaml` for easier Slack app setup
- **Session title/description logging** - Debug logging for extracting session metadata from Claude responses

### Fixed
- **Slack strikethrough formatting** - Escape tildes in strikethrough text to prevent formatting breakage
- **Image files preserved during prompts** - Image files are no longer lost when context/worktree prompts are shown
- **Double newlines between content blocks** - Proper formatting with double newlines for better readability
- **Documentation** - Added `files:read` scope to Slack setup docs

## [0.38.0] - 2026-01-06

### Added
- **Documentation reorganization** - Moved detailed setup guides to `docs/` folder:
  - `docs/CONFIGURATION.md` - Multi-platform configuration reference
  - `docs/MATTERMOST_SETUP.md` - Mattermost setup guide
  - `docs/SLACK_SETUP.md` - Slack setup guide

### Fixed
- **Slack link previews disabled** - Sticky messages and task posts no longer show link unfurls on Slack
- **Jump-to-bottom links include bot posts** - Links now correctly scroll to the latest message including bot's own posts
- **Flaky integration tests** - Fixed timing issues in multi-user and session limit tests

## [0.37.0] - 2026-01-06

### Added
- **Jump to bottom of thread** - Sticky message links now include `?scrollTo=bottom` parameter to jump directly to the latest messages in threads
- **Pause/shutdown status in pinned message** - Channel sticky message now shows when platforms are paused or shutting down with visual indicators (⏸️ paused, 🛑 shutting down)

### Changed
- **Improved spinner animations** - Different spinner styles for different contexts:
  - Braille spinner for typing indicator
  - Dots spinner for session starting
  - Arc spinner for general loading states

### Fixed
- **Code block rendering when messages are split** - Continuation markers (`*... (continued below)*`) now use platform-specific formatting, fixing broken code blocks on Slack
- **Worktree creation failures** - Better error handling when worktree already exists or creation fails:
  - Inline `on branch X` syntax now detects existing worktrees and offers to join them
  - Creation failures now show helpful error messages instead of crashing

## [0.36.0] - 2026-01-06

### Added
- **Platform toggle from UI** - Use `Shift+1-9` to toggle platforms on/off from the terminal UI:
  - When disabled: active sessions are paused, platform disconnects, UI shows gray state
  - When re-enabled: platform reconnects, paused sessions auto-resume
  - Visual feedback in StatusLine with colors (green=connected, gray=disabled, yellow=reconnecting, red=error)
- **Pin active task post** - Task posts are now pinned to the channel for easy access:
  - Pin when task post is created
  - Unpin when all tasks complete or session ends
  - Handles task post "bumping" by unpinning old and pinning new
- **Slack file attachment support** - Fixed bug where Slack messages with image attachments were silently ignored:
  - Now handles `file_share` message subtype correctly
  - Added comprehensive integration tests for Slack file uploads

### Changed
- **Universal markdown formatting** - Added `formatMarkdown()` method to `PlatformFormatter` interface:
  - Claude's responses now render properly on all platforms
  - MattermostFormatter: pass-through (standard markdown)
  - SlackFormatter: converts `**bold**` → `*bold*`, `## headers` → bold, links → Slack format
  - DiscordFormatter: pass-through (standard markdown)

## [0.35.0] - 2026-01-06

### Added
- **Slack platform support** - Full Slack integration using Socket Mode for real-time events:
  - Socket Mode WebSocket connection with automatic reconnection
  - All session features work identically to Mattermost (commands, reactions, permissions, etc.)
  - Slack mrkdwn formatting (single `*bold*`, `~strikethrough~`, unicode horizontal rules)
  - User mention translation (`<@U123>` format)
  - File attachment support with authenticated downloads
  - Rate limiting with exponential backoff
  - Message recovery after disconnection
- **Slack integration tests** - Platform-agnostic test framework that runs the same 116 tests against both Mattermost and Slack mock servers
- **Slack mock server** - Full mock implementation of Slack's Socket Mode and Web API for testing
- **Platform initialization logging** - Better diagnostics showing which platforms are connecting

### Changed
- **Platform-agnostic formatters** - All markdown formatting now goes through `PlatformFormatter` interface for cross-platform compatibility
- **Cross-platform regex patterns** - Task list parsing now handles both `**bold**` (Mattermost) and `*bold*` (Slack) formats

### Fixed
- **Slack WebSocket reliability** - Added 30-second connection timeout and proper promise rejection if WebSocket closes before hello event
- **Expected API errors** - `already_pinned` and `no_pin` Slack errors no longer spam logs

## [0.34.1] - 2026-01-05

### Added
- **Integration test suite** - Comprehensive end-to-end tests that spawn the actual bot against a real Mattermost instance with a mock Claude CLI. 111 tests covering:
  - Session lifecycle (start, response, end, timeout)
  - Commands (!stop, !escape, !help, !cd, !kill, !permissions)
  - Reaction-based controls (❌ cancel, ⏸️ interrupt)
  - Multi-user collaboration (!invite, !kick, message approval)
  - Session persistence and resume after restart
  - Plan approval and question flows
  - Context prompts for mid-thread starts
  - Git worktree integration
  - Error handling and recovery
  - MAX_SESSIONS limits
  - Task list display
- **CI workflow** - GitHub Actions workflow (`integration.yml`) that:
  - Spins up Mattermost in Docker
  - Creates test users, channels, and bot
  - Runs full integration test suite
  - Collects logs on failure for debugging

### Changed
- **Cleaner production code** - Removed test-specific `triggerReactionHandler()` method from SessionManager. Tests now access private methods via TypeScript cast when needed as a WebSocket fallback.

## [0.34.0] - 2026-01-05

### Added
- **Ink/React CLI UI** - Complete rewrite of the terminal interface using Ink (React for CLI). Features include:
  - Collapsible session panels with real-time log streaming
  - Header with logo, version, and working directory
  - Platform status indicators (connected/reconnecting)
  - Per-session and global log panels with color-coded levels
  - Spinner animations for typing/starting states
- **Keyboard toggles** - Runtime settings can be changed without restart:
  - `[d]` Debug mode - toggle verbose logging
  - `[p]` Permissions - toggle interactive/auto mode for new sessions
  - `[c]` Chrome - toggle Chrome integration for new sessions
  - `[k]` Keep-alive - toggle system sleep prevention
  - `[1-9]` Toggle session panel expansion
  - `[q]` Quit
- **Comprehensive logging** - Added debug logging throughout the codebase for better observability:
  - Platform layer (API calls, WebSocket events, user lookups)
  - Session layer (streaming, reactions, commands, lifecycle)
  - CLI layer (process spawn, kill, interrupt)
  - Git worktree operations

### Changed
- **Session status tracking** - New `isProcessing` and `hasClaudeResponded` flags for accurate status display (starting → active → idle)
- **Pre-commit hooks** - Added `typecheck` to lint-staged to match CI checks

### Fixed
- **Duplicate log entries** - Removed redundant logging that caused duplicate entries in UI
- **Pre-UI logging** - Version check no longer logs before UI starts (was cluttering terminal)

## [0.33.8] - 2026-01-04

### Fixed
- **Session resume broken after v0.33.7** - Fixed migration issue where sessions persisted with the old `timeoutPostId` field name couldn't be resumed after upgrading to v0.33.7. The `timeoutPostId` → `lifecyclePostId` rename now includes a proper migration that converts existing sessions on first load.
- **Defensive defaults for persisted session fields** - Session resume now uses safe defaults for all optional fields, preventing crashes when loading sessions from older versions that may have missing fields. Fields like `sessionAllowedUsers`, `planApproved`, `forceInteractivePermissions`, etc. now gracefully default instead of potentially causing undefined errors.
- **Validate required fields before resume** - Sessions with missing critical fields (`threadId`, `platformId`, `claudeSessionId`, `workingDir`) are now skipped gracefully with a warning instead of crashing.

## [0.33.7] - 2026-01-04

### Changed
- **Unified lifecycle post tracking** - Shutdown now uses the same post as timeout/warning, so "Bot shutting down" → "Session resumed" updates a single post instead of creating multiple.
- **Renamed `timeoutPostId` to `lifecyclePostId`** - Better reflects its use across the full session lifecycle (warning → timeout → shutdown → resume).

## [0.33.6] - 2026-01-04

### Changed
- **Duo post repurposing** - Reduced thread noise by updating posts instead of creating new ones for paired events:
  - Compaction: "🗜️ Compacting..." updates to "✅ Context compacted" (single post)
  - Timeout lifecycle: Warning → Timeout → Resume all update the same post
- **DRY refactor** - Added `resetSessionActivity()` helper to clear duo-post IDs on activity, preventing stale post updates in long threads.

## [0.33.5] - 2026-01-04

### Fixed
- **Task toggle emoji disappearing on uncollapse** - Fixed issue where the task toggle emoji (📋) would disappear when uncollapsing the task list. Added re-add of toggle emoji after expanding tasks.
- **Status bar cleanup** - Removed redundant session count from status bars, added keep-alive indicator to show connection health.

## [0.33.4] - 2026-01-04

### Fixed
- **Graceful shutdown now actually waits** - Fixed issue where Ctrl-C would exit immediately instead of waiting for Claude CLI processes to exit gracefully. The `kill()` method now returns a Promise that resolves when the process exits, and shutdown waits for all sessions to complete (up to 2 seconds per session).
- **Signal handlers now work correctly** - Fixed conflict with `when-exit` package (transitive dependency via `update-notifier`) that was intercepting SIGINT before our handlers could run. Now removes conflicting handlers before registering our own.
- **No more reconnection attempts during shutdown** - WebSocket client now tracks intentional disconnects and skips reconnection attempts when shutting down gracefully.

## [0.33.3] - 2026-01-04

### Fixed
- **Graceful shutdown sends two SIGINTs** - Claude CLI requires two Ctrl+C presses to exit in interactive mode. Updated kill() to send two SIGINTs (100ms apart) before falling back to SIGTERM after 2 seconds.

## [0.33.2] - 2026-01-04

### Fixed
- **Session resume "No conversation found" errors** - Fixed issue where cancelled sessions would fail to resume with "No conversation found with session ID" error. Root cause: sessions were persisted before Claude had a chance to save the conversation.
- **Graceful session termination** - When killing a session (cancel, !stop, etc.), Claude now gets 2 seconds to save the conversation (SIGINT then SIGTERM) instead of being killed immediately.
- **Detect invalid session IDs immediately** - Sessions with "No conversation found" errors are now recognized as permanent failures and removed from persistence immediately, instead of retrying 3 times.
- **User notification for early exits** - When a session ends before Claude responds, the user is now notified: "Session ended before Claude could respond. Please start a new session."

### Changed
- **Delayed session persistence** - Sessions are only persisted after Claude has actually responded (first `assistant` or `tool_use` event), preventing dangling session records that can't be resumed.

## [0.33.1] - 2026-01-04

### Fixed
- **Recent threads timestamp** - Fixed "just now" showing incorrectly for recent threads. Now displays when the user last worked on the session (`lastActivityAt`) instead of the internal cleanup timestamp (`cleanedAt`).

### Changed
- **Consolidated time formatting** - Unified duplicate `formatRelativeTime` functions into `utils/format.ts`. Added compact `formatRelativeTimeShort()` for sticky message display (e.g., "5m ago", "2h ago").

## [0.33.0] - 2026-01-03

### Added
- **Compaction status display** - Shows when Claude CLI is compacting context (🗜️ **Compacting context...**) and when it completes (✅ **Context compacted**). Handles `compact_boundary` events with metadata including trigger type and pre-compaction token count.
- **Message recovery after reconnection** - Recovers missed messages after WebSocket disconnections (e.g., machine sleep, network issues). Tracks last processed post ID and fetches missed posts via REST API on reconnect.

### Fixed
- **Timed-out sessions in Recent section** - Fixed bug where timed-out sessions weren't appearing in the "Recent" section of the sticky channel message. Timed-out sessions now show with ⏸️ indicator and a hint to resume via 🔄 reaction.
- **Task toggle emoji behavior** - Changed from flip behavior to state-based: emoji present = expanded, emoji absent = minimized. Added `reaction_removed` event to platform layer.
- **Accurate context token calculation** - Fixed incorrect context token calculation by using `total_input_tokens` from the status line instead of per-request tokens.

## [0.32.0] - 2026-01-03

### Added
- **Claude CLI version check** - Validates Claude CLI version at startup and exits if incompatible (bypass with `--skip-version-check`). Compatible versions: `>=2.0.74 <=2.0.76`. Version is displayed in terminal startup output, sticky channel message, and session headers.

## [0.31.3] - 2026-01-03

### Fixed
- **Clean up stale browser bridge sockets** - Removes stale `claude-mcp-browser-bridge-*` socket files from temp directory before starting Claude CLI. This works around a Claude CLI bug where it tries to `fs.watch()` existing socket files, which fails with `EOPNOTSUPP`. The socket files are left over from previous Chrome integration sessions.

## [0.31.2] - 2026-01-03

### Fixed
- **Detect permanent resume failures immediately** - When resuming a session fails due to Claude CLI's browser bridge temp file issue (EOPNOTSUPP/ENOENT on `claude-mcp-browser-bridge`), the session is now immediately removed from persistence instead of retrying 3 times. This prevents unnecessary retry loops for failures that will never succeed.

## [0.31.1] - 2026-01-03

### Fixed
- **Prevent infinite resume retry loop** - Sessions that crash immediately after resume (e.g., due to Claude CLI Chrome MCP issues) now track failure count and are permanently removed after 3 failed attempts, preventing infinite retry loops on bot restart.

### Changed
- **Updated README** - Comprehensive documentation update covering features from v0.8.0 to v0.31.0, including worktree support, context prompts, session history, and more.

## [0.31.0] - 2026-01-03

### Added
- **Session history retention** - Sessions are now soft-deleted instead of permanently removed when they complete. Session history is kept for display in the sticky message (up to 5 recent sessions). Old history is permanently cleaned up after 3 days.
- **Git branch in session header** - Display the current git branch in the session header table when working in a git repository, providing visibility into which branch the session is operating on.

### Fixed
- **Accurate context usage via status line** - Uses Claude Code's status line feature to get accurate context window usage percentage instead of cumulative billing tokens. Adds a status line writer script that receives accurate per-request token data.

## [0.30.0] - 2026-01-03

### Added
- **Pull request link detection** - When a session is working in a git worktree with an associated PR, the session header and sticky message now display a clickable link to the PR. Automatically detects PRs from GitHub URLs in branch names or upstream tracking.
- **User existence validation for invite/kick** - The `!invite` and `!kick` commands now validate that the user exists on the platform before attempting the action, providing helpful error messages for non-existent users.

### Fixed
- **Accurate context window usage** - Now uses per-request usage data from Claude's result events instead of cumulative billing tokens, providing accurate context window percentage display.
- **Cancelled sessions no longer resume** - Fixed bug where cancelled sessions (killed by user) would incorrectly resume on bot restart by using the correct composite session key for unpersisting.

## [0.29.0] - 2026-01-03

### Changed
- **Unified SessionContext** - Replaced 4 separate context interfaces (LifecycleContext, EventContext, ReactionContext, CommandContext) with a single unified SessionContext for cleaner module dependencies
- **Centralized error handling** - Added `error-handler.ts` with consistent error patterns across all session modules
- **DRY post helpers** - New `post-helpers.ts` with `postInfo`, `postError`, `postWarning` utilities to reduce code duplication
- **Component-based logging** - Migrated from console.log to `createLogger` utility with component prefixes (`[lifecycle]`, `[events]`, `[commands]`, etc.)
- **Platform-agnostic comments** - Updated code comments to be generic rather than Mattermost-specific

### Added
- **Integration tests** - New integration tests for lifecycle and platform modules
- **Format utilities** - New `src/utils/format.ts` with ID formatting and time/number helpers

## [0.28.1] - 2026-01-02

### Fixed
- **Worktree prompts now show in thread list** - Fixed bug where pending worktree prompts (e.g., "Another session is already using this repo...") weren't displayed in the active threads list. The sticky message now updates immediately when these prompts appear.

## [0.28.0] - 2026-01-02

### Added
- **Pending prompts in thread list** - The sticky channel message now shows when sessions are waiting for user input. Pending prompts are displayed with visual indicators:
  - 📋 Plan approval - waiting for plan approval reaction
  - ❓ Question X/Y - multi-step questions with progress
  - 💬 Message approval - unauthorized user message pending
  - 🌿 Branch name - waiting for worktree branch input
  - 🌿 Join worktree - asking to join existing worktree
  - 📝 Context selection - choosing thread context to include
- **Reusable pending prompts API** - New `getPendingPrompts()` and `formatPendingPrompts()` functions exported from session module for displaying pending states anywhere

## [0.27.1] - 2026-01-02

### Fixed
- **Context bar crash when tokens exceed context window** - Fixed crash when usage tokens exceeded the context window limit, causing negative remaining tokens and percentage values over 100%
- **Wait for shutdown message before exiting** - Bot now waits for the "session ended" message to be posted before shutting down, ensuring users see the final status

## [0.27.0] - 2026-01-02

### Added
- **Version in system prompt** - Claude Code now knows which version of Claude Threads it's running under, enabling version-specific behavior and self-reporting

### Fixed
- **Sticky message status bar layout** - Moved status bar above the "Active Claude Threads" header for better visual hierarchy
- **Shorter status bar** - Removed hostname from status bar to reduce clutter

## [0.26.0] - 2026-01-02

### Added
- **Show active task in sticky message** - When Claude is working on tasks, the currently active (in-progress) task is now displayed in the sticky session message. This gives visibility into what Claude is currently working on without scrolling through the thread.

## [0.25.0] - 2026-01-02

### Added
- **Enhanced system prompt with chat platform context** - Claude Code now receives better context about its environment:
  - Understands it's running as a bot via "Claude Threads" in a chat platform
  - Knows how permissions work (emoji reactions 👍/👎)
  - Aware of available user commands (`!stop`, `!escape`, `!invite`, `!kick`, `!cd`, `!permissions`)
  - Understands multiple users can participate in a session
  - This helps Claude provide better UX by understanding its environment and guiding users about available controls

### Fixed
- **Session title/description markers visible in chat** - Fixed issue where `[SESSION_TITLE: ...]` and `[SESSION_DESCRIPTION: ...]` markers would appear in chat messages when validation failed. Markers are now always stripped from displayed text regardless of validation outcome.
- **Session title/description length validation** - Added maximum length limits (title: 50 chars, description: 100 chars) to prevent overly long metadata from cluttering the session header and sticky message.

## [0.24.1] - 2026-01-02

### Fixed
- **Auto-include single-message thread context** - When starting a session in a thread that has only one prior message (the thread starter), it now auto-includes that message as context without prompting. Previously, this would trigger an unnecessary "Include 1 message as context?" prompt with reaction options. Now, single-message context is silently included, while multi-message threads still prompt for confirmation.
- **Worktree branch response excluded from context count** - When a user responds to a worktree branch prompt (e.g., typing "fix/my-branch"), that response is now excluded from the thread context count and messages. Previously, this response was incorrectly counted as conversation context, leading to misleading "Include 2 messages?" prompts when only the original thread starter was meaningful context.
- **Persist sessions before killing on graceful shutdown** - Sessions are now properly persisted before being killed during graceful shutdown (Ctrl+C).

## [0.24.0] - 2026-01-02

### Added
- **Enhanced session status bar with model and context info** - The session header now displays real-time usage information similar to Claude Code's status line:
  - Model name (`🤖 Opus 4.5`, `🤖 Sonnet 4`, etc.)
  - Context usage with visual progress bar (`🟢▓▓░░░░░░░░ 23%`)
  - Session cost (`💰 $0.07`)
  - Color-coded context indicator:
    - 🟢 Green: < 50% (plenty of context)
    - 🟡 Yellow: 50-75% (moderate usage)
    - 🟠 Orange: 75-90% (getting full)
    - 🔴 Red: 90%+ (almost full)
- **Periodic status bar updates** - Status bar now refreshes every 30 seconds automatically to keep uptime and usage stats current
- **Usage stats tracking** - Session now tracks token usage, cost, and model information extracted from Claude CLI result events

### Improved
- **Existing worktree handling** - When a worktree already exists for a branch, the bot now offers to join it with a reaction prompt (👍 to join, ❌ to skip) instead of just showing a warning message that required manually typing `!worktree switch`

### Fixed
- **Task list 🔽 emoji not preserved when bumped** - Fixed issues where the collapse/expand toggle emoji would disappear or get stuck on the wrong post:
  - When a task list is bumped to the bottom, the new post now gets the 🔽 emoji via `createInteractivePost`
  - When a task post is repurposed for other content, the emoji is removed from the old post before reuse
  - Added `removeReaction` method to platform client interface for proper emoji cleanup
- **WorktreeMode type inconsistency** - Aligned the WorktreeMode type definition across the codebase to include 'off' mode

## [0.23.0] - 2026-01-02

### Added
- **Sticky message status bar** - Added a compact status line to the channel sticky message showing system-level info:
  - Bot version (`v0.22.0`)
  - Active sessions count (`3/5 sessions`)
  - Permission mode (`🔐 Interactive` or `⚡ Auto`)
  - Worktree mode (`🌿 Worktree: always/never`) - only shown if not default 'prompt'
  - Chrome status (`🌐 Chrome`) - only when enabled
  - Debug mode (`🐛 Debug`) - only when enabled
  - Battery level (`🔋 85%` or `🔌 AC`) - macOS and Linux
  - Bot uptime (`⏱️ 2h15m`) - how long the bot has been running
  - Working directory (`📂 ~/projects`)
  - Hostname (`💻 hostname`) - machine name for identification

## [0.22.1] - 2026-01-01

### Fixed
- **Missing `diff` dependency** - Added missing `diff` package that was used in tool-formatter but not in package.json
- **Test console output pollution** - Suppressed expected console output in tests (error handling, keep-alive messages)
- **Lint warning in sticky-message** - Removed non-null assertion in favor of proper undefined check

## [0.22.0] - 2026-01-01

### Added
- **Session status bar** - Compact status line between logo and table showing at-a-glance info:
  - Session slots (`1/5`)
  - Permission mode (`🔐 Interactive` or `⚡ Auto`)
  - Chrome status (`🌐 Chrome`) - only when enabled
  - Keep-alive status (`💓 Keep-alive`) - only when active
  - Battery level (`🔋 85%` or `🔌 AC`) - macOS and Linux
  - Session uptime (`⏱️ 5m`, `1h23m`, etc.)

### Changed
- **Slimmer session header table** - Moved session slots, permissions, and Chrome status to the status bar, keeping only contextual info (topic, directory, participants, etc.) in the table

### Fixed
- **Task list collapse toggle not working** - Fixed a bug where clicking the 🔽 emoji to collapse/expand the task list had no effect. The task post ID was not being registered in the reaction routing index, causing all toggle reactions to be silently ignored. Now the task post is properly registered in all scenarios: initial creation, session resume, and after being bumped to the bottom of the thread.

## [0.21.1] - 2026-01-01

### Fixed
- **Subagent layout issue** - Fixed a bug where starting a subagent could create an empty or near-empty message above the task list, causing a broken layout. The fix ensures pending content is flushed before posting subagent status messages.
- **Session title/description not generated after worktree creation** - When a session started with a worktree prompt, the system prompt instructing Claude to generate session metadata was not passed to the restarted Claude CLI in the new worktree directory
- **Code block continuations now preserve formatting** - When a message needs to split mid-way through a code block (diff, typescript, etc.), the code block is now properly closed in the first part and reopened in the continuation
  - Prevents broken markdown when long diffs or code blocks exceed message length limits
  - Adds `getCodeBlockState()` helper to detect when we're inside an unclosed code block
  - `findLogicalBreakpoint()` now avoids breaking inside code blocks when possible
  - When a break inside a code block is unavoidable, properly closes with ``` and reopens with ```language

## [0.21.0] - 2026-01-01

### Added
- **Session title/description in thread header** - The session header table now displays the topic and summary at the top, providing immediate context within the thread itself
- **Periodic metadata reminders** - Every 5 user messages, Claude receives a reminder to update the session title/description if the topic has evolved, ensuring metadata stays current as conversations progress

### Changed
- **Dynamic header updates** - Session header now updates automatically when Claude generates or changes the title/description

### Fixed
- **Session title/description validation** - Reject placeholder values like "..." that Claude sometimes generates instead of real titles/descriptions

## [0.20.0] - 2026-01-01

### Added
- **Sticky message improvements** - Enhanced the channel sticky message with active sessions
  - Shows display name in bold (e.g., **Anne**) instead of username
  - Added session description below the title (generated by Claude)
  - Added install hint: `npm i -g claude-threads` in footer
  - Periodic refresh every 60 seconds to keep relative times current
  - Auto-cleanup of old sticky messages from failed runs at startup

### Fixed
- **Sticky message updates on session end** - Message now updates when sessions are:
  - Canceled via `!stop` or ❌ reaction
  - Paused/interrupted via `!escape` or ⏸️ reaction
  - Killed due to timeout
  - Failed to start or resume
- **Race condition in sticky updates** - Added mutex to prevent duplicate sticky posts when multiple updates happen concurrently

## [0.19.2] - 2026-01-01

### Added
- **Smart message breaking** - Breaks long responses into multiple messages at logical points
  - Reduces "Show More" toggles in Mattermost by breaking messages before they get too long
  - Breaks at logical points: after tool completions, before headings, after code blocks, at paragraph breaks
  - Soft threshold at 2000 chars / 15 lines triggers search for breakpoints
  - Hard threshold at 14K chars ensures messages stay within platform limits
  - Adds `*... (continued below)*` marker when breaking messages

### Fixed
- **Task list stays below subagent messages** - Task list now bumps to bottom when subagents start
  - Previously, subagent status messages would appear below the task list
  - Now the task list correctly repositions itself below subagent posts

## [0.19.1] - 2026-01-01

### Fixed
- **Task list collapse emoji now pre-added** - The 🔽 toggle emoji is now automatically added as a reaction when the task list is created, making it easy to click and collapse/expand the list (previously users had to manually add the emoji)
- **Improved thinking trace display** - Better formatting for extended thinking blocks
  - Use blockquote format (`> 💭 *...*`) for cleaner visual separation
  - Increased preview length from 100 to 200 characters
  - Cut at word boundaries instead of mid-word for cleaner truncation

## [0.19.0] - 2026-01-01

### Added
- **Minimize/expand task list** - Toggle task list visibility with emoji reactions
  - React with 🔽 (`arrow_down_small`) or 🔻 (`small_red_triangle_down`) on the task list to toggle
  - Minimized view shows: `📋 **Tasks** (2/5 · 40%) · 🔄 Current task 🔽`
  - Expanded view shows full task list with all items
  - State persists across session restarts
  - Similar to Ctrl-T in Claude Code CLI

### Changed
- **Unified CLI output styling** - Consistent 2-space indented output with emoji prefixes
  - Created centralized `src/utils/output.ts` module with shared color helpers
  - Keep-alive messages now use `☕ Sleep prevention active (caffeinate)` format instead of `[keep-alive]` prefix
  - All files now import colors from the shared module instead of defining locally

## [0.18.0] - 2026-01-01

### Added
- **Keep-alive support** - Prevents system sleep while Claude sessions are active
  - Automatically starts when first session begins, stops when all sessions end
  - Cross-platform: macOS (`caffeinate`), Linux (`systemd-inhibit`), Windows (`SetThreadExecutionState`)
  - Enabled by default, disable with `--no-keep-alive` CLI flag or `keepAlive: false` in config
  - Shows `☕ Keep-alive enabled` in startup output
- **Resume timed-out sessions via emoji reaction** - React with 🔄 to the timeout message or session header to resume a timed-out session
  - Timeout message now shows resume hint: "💡 React with 🔄 to resume, or send a new message to continue."
  - Resume also works by sending a new message in the thread (existing behavior)
  - Session header now displays truncated session ID for reference
  - Supports multiple resume emojis: 🔄 (arrows_counterclockwise), ▶️ (arrow_forward), 🔁 (repeat)

### Fixed
- **Sticky task list**: Task list now correctly stops being sticky when all tasks are completed
  - Previously, the task list stayed at the bottom even after all tasks had `status: 'completed'`
  - Now properly detects when all tasks are done using `todos.every(t => t.status === 'completed')`

## [0.17.1] - 2025-12-31

### Fixed
- **Sticky task list optimization**: Completed task lists no longer move to the bottom
  - Once all tasks are done, the "~~Tasks~~ *(completed)*" message stays in place
  - Reduces unnecessary message deletions and recreations
  - Added `tasksCompleted` flag to session state for explicit tracking

### Changed
- **Task list visual separator**: Added horizontal rule (`---`) above task list for better visibility

## [0.17.0] - 2025-12-31

### Added
- **Sticky task list** - Task list now stays at the bottom of the thread
  - When Claude posts new content, the task list moves below it
  - When you send a follow-up message, the task list moves below your message
  - Task list updates in place without visual noise
  - Mirrors Claude Code CLI behavior where tasks are always at the bottom

### Fixed
- **Context prompt after restart**: Context prompt now appears after session restarts (worktree creation, `!cd`)
  - Previously, after worktree creation or directory change, the context prompt was skipped
  - Now users can include thread history when Claude restarts in a new directory
  - Added `needsContextPromptOnNextMessage` flag for deferred context prompt (after `!cd`)

## [0.16.8] - 2025-12-31

### Fixed
- **Context prompt**: Fixed context prompt appearing when starting a session with the first message in a thread
  - The triggering message was incorrectly included in the count, making it show "1 message before this point" when there were none

## [0.16.7] - 2025-12-31

### Fixed
- **Session resume**: Validate working directory exists before resuming sessions after restart
  - Prevents crashes when a worktree or directory has been deleted

## [0.16.6] - 2025-12-31

### Added
- **Worktree context**: Replay first user prompt after mid-session worktree creation (`!worktree create`)
- **Thread context prompt**: When starting a session mid-thread (replying to an existing thread), offers to include previous conversation context
  - Shows options for last 3, 5, or 10 messages (only options that make sense for available message count)
  - "All X messages" option when message count doesn't match standard options
  - 30-second timeout defaults to no context
  - Context is prepended to the initial prompt so Claude understands the conversation history

### Fixed
- **Plan mode approval**: Fixed API error "unexpected tool_use_id found in tool_result blocks" when approving plans
  - Claude Code CLI handles ExitPlanMode internally; changed to send user message instead of duplicate tool_result
- **Question reactions**: Fixed 2nd+ questions not responding to emoji reactions
  - Follow-up question posts weren't registered for reaction routing
- **Question answering**: Fixed duplicate tool_result when answering AskUserQuestion
  - Claude Code CLI handles AskUserQuestion internally; changed to send user message
- Session timeout warning showing negative minutes (e.g., "-24min")
- Warning now fires 5 minutes before timeout instead of after 5 minutes idle
- Stale sessions are now cleaned from persistence on startup

## [0.16.3] - 2025-12-31

### Fixed
- Build with `--target node` for Node.js compatibility (fixes "__require is not a function" error)
- Fixed package.json path resolution for bundled builds

## [0.16.2] - 2025-12-31

### Fixed
- CI: Use npm publish for reliable registry authentication (bun publish auth issues)

## [0.16.1] - 2025-12-31

### Fixed
- CI: Skip lifecycle scripts during `bun publish` to avoid husky error

## [0.16.0] - 2025-12-31

### Changed
- **Runtime**: Migrated from Node.js to Bun runtime for 5-8x faster startup
- **WebSocket**: Replaced `ws` package with native Bun WebSocket (browser-style API)
- **YAML**: Replaced `yaml` package with native `Bun.YAML`
- **Testing**: Replaced Vitest with native `bun test`
- **CI/CD**: Updated GitHub Actions to use Bun

### Removed
- Node.js dependency - **Bun 1.2.21+ is now required**
- Dependencies: `ws`, `yaml`, `tsx`, `vitest`, `@vitest/coverage-v8`

### Developer Experience
- ~2x faster test execution with `bun test`
- ~7-10x faster CI package installs
- Native TypeScript execution without transpilation

## [0.15.0] - 2025-12-30

### Changed
- **License**: Changed from MIT to Apache 2.0 (adds patent protection)

### Added
- **Community standards**: CODE_OF_CONDUCT.md, CONTRIBUTING.md, SECURITY.md
- **GitHub templates**: Issue templates (bug report, feature request), PR template
- **Dependabot**: Automated dependency updates for npm and GitHub Actions
- **README badges**: Added npm downloads, Node.js version, TypeScript, PRs welcome

### Security
- Updated dependencies via Dependabot

## [0.14.1] - 2025-12-30

### Fixed
- Don't show "update available" notice when running a newer version than npm (fixes stale cache edge case)

## [0.14.0] - 2025-12-30

### Added
- **Multi-platform architecture** - Foundation for supporting multiple chat platforms
  - New `PlatformClient` interface abstracts platform differences
  - Normalized types: `PlatformPost`, `PlatformUser`, `PlatformReaction`, `PlatformFile`
  - Mattermost implementation moved to `src/platform/mattermost/`
  - Slack support architecture ready (implementation pending)
- **YAML-based configuration** - New config format
  - Config file: `~/.config/claude-threads/config.yaml`
  - Support for multiple platform instances simultaneously
  - Interactive onboarding wizard creates YAML config

### Changed
- **Modular session management** - Broke 2,500-line monolith into focused modules
  - `session/manager.ts` (~635 lines) - Thin orchestrator
  - `session/lifecycle.ts` (~590 lines) - Session start/resume/exit
  - `session/events.ts` (~480 lines) - Claude CLI event handling
  - `session/commands.ts` (~510 lines) - User commands
  - `session/reactions.ts` (~210 lines) - Emoji reaction handling
  - `session/worktree.ts` (~520 lines) - Git worktree management
  - `session/streaming.ts` (~180 lines) - Message batching
  - Uses dependency injection for testability
- **Platform-agnostic utilities** - Moved emoji helpers to `src/utils/emoji.ts`
- **Cleaner logo exports** - Renamed to generic `getLogo()`, `LOGO`, `LOGO_INLINE`

### Removed
- **Legacy `.env` configuration** - Now uses YAML only (`config.yaml`)
- **`dotenv` dependency** - No longer needed
- Deprecated Mattermost-specific exports (`getMattermostLogo`, `MATTERMOST_LOGO`)
- Internal documentation files (moved to CLAUDE.md)

## [0.13.0] - 2025-12-29

### Added
- **`--setup` flag** - Re-run interactive setup wizard to reconfigure settings
  - Existing .env values are used as defaults (press Enter to keep)
  - Token field allows keeping existing token without re-entering
  - New settings added since initial setup are presented with built-in defaults
  - Config saved back to original location
- **Chrome and worktree settings in onboarding** - New setup prompts for:
  - Chrome integration (yes/no)
  - Git worktree mode (prompt/off/require)

### Changed
- **Improved README** - New tagline and improved intro section
- **Worktree documentation** - Added comprehensive Git Worktrees section to README
- **Updated CLI options** - Added `--chrome`, `--no-chrome`, `--worktree-mode`, `--setup` to README

### Fixed
- **Warning icon alignment** - Fixed spacing of ⚠️ icon in CLI startup output
- **WORKTREE_MODE documentation** - Fixed incorrect values in README (was `always`/`never`, now correctly `off`/`prompt`/`require`)

## [0.12.1] - 2025-12-29

### Fixed
- **Fix logo star positioning** - Right bottom star shifted left as intended
- **Update README** - Title changed to "Claude Threads" and logo added

## [0.12.0] - 2025-12-29

### Changed
- **Renamed project to `claude-threads`** - Complete rebrand from `mm-claude`
  - npm package: `mattermost-claude-code` → `claude-threads`
  - CLI command: `mm-claude` → `claude-threads`
  - Config directory: `~/.config/mm-claude/` → `~/.config/claude-threads/`
  - MCP server: `mm-claude-permissions` → `claude-threads-permissions`
  - GitHub repository: `mattermost-claude-code` → `claude-threads`
- **New CT logo** - Stylized "CT" block characters replace the old "M" logo
  - Fresh visual identity matching the new name

## [0.11.2] - 2025-12-28

### Fixed
- **Fix worktree skip emoji** - Use emoji name `x` instead of Unicode `❌`
  - Mattermost API expects emoji names for reactions, not Unicode characters
  - Was causing "Custom emoji have been disabled" error

## [0.11.1] - 2025-12-28

### Fixed
- **Fix worktree and `!cd` crash** - Claude CLI sessions are tied to working directory
  - Can't use `--resume` when switching directories (session ID is directory-specific)
  - Now generates fresh session ID when changing to worktree or new directory
  - Previously caused "[Exited: 1]" with "No conversation found with session ID"

## [0.11.0] - 2025-12-28

### Added
- **Git worktree support** - Isolate file changes between concurrent sessions
  - Smart detection prompts for a branch when uncommitted changes or concurrent sessions exist
  - Reply with a branch name to create a worktree, or react with ❌ to skip
  - Inline syntax: `@bot on branch feature/x help me implement...`
  - `!worktree <branch>` - Create and switch to a git worktree
  - `!worktree list` - List all worktrees for the repo
  - `!worktree switch <branch>` - Switch to an existing worktree
  - `!worktree remove <branch>` - Remove a worktree
  - `!worktree off` - Disable worktree prompts for this session
  - Configure via `WORKTREE_MODE=off|prompt|require` (default: `prompt`)
  - Worktrees persist after session ends (manual cleanup)
  - Session header shows worktree info when active

## [0.10.11] - 2025-12-28

### Fixed
- **Permission prompts now update after approval/denial** - Shows result inline
  - "⚠️ Permission requested" → "✅ Allowed by @user" or "❌ Denied by @user"
  - Consistent with plan approval and message approval behavior

## [0.10.10] - 2025-12-28

### Fixed
- **Fixed `!permissions interactive` command** - Now actually enables interactive permissions
  - Previously, the command set a flag but didn't restart Claude CLI, so permissions didn't change
  - Now properly restarts Claude CLI with the MCP permission server enabled
  - Permission prompts (👍 Allow | ✅ Allow all | 👎 Deny) now appear as expected
  - Conversation context is preserved via `--resume` flag

## [0.10.9] - 2025-12-28

### Changed
- **Code quality refactoring** - Extracted shared utilities and added comprehensive test suite
  - New `src/mattermost/api.ts` - Shared REST API layer for bot and MCP server
  - New `src/utils/logger.ts` - Standardized logging with `mcpLogger` and `wsLogger`
  - New `createInteractivePost()` helper for posts with reaction options
  - Extracted emoji constants and helpers to `src/mattermost/emoji.ts`
  - Extracted tool formatting to `src/utils/tool-formatter.ts`

### Added
- **125 unit tests** - Comprehensive test coverage for refactored modules
  - API layer tests (21 tests)
  - Emoji helper tests (31 tests)
  - Tool formatter tests (58 tests)
  - Logger tests (15 tests)

## [0.10.8] - 2025-12-28

### Changed
- **Improved Claude in Chrome tool display** - Chrome automation tools now display like the native CLI
  - `🌐 **Chrome**[computer] \`screenshot\`` instead of `🔌 **computer** *(claude-in-chrome)*`
  - Shows action details: `left_click at (608, 51)`, `type "search query"`, `scroll down`
  - Consistent formatting across all Chrome tools (navigate, tabs, read_page, etc.)

## [0.10.7] - 2025-12-28

### Fixed
- **Fixed `!context` and `!cost` commands** - These commands now properly display output
  - Claude Code slash commands (`/context`, `/cost`) output via `user` events with `<local-command-stdout>` tags
  - Added handling for these events so the output is displayed in Mattermost

## [0.10.6] - 2025-12-28

### Fixed
- **Fixed diff display** - Removed misleading line numbers and noise from diffs
  - No more fake `@@ -1,1 +1,1 @@` headers (we don't have real line numbers)
  - No more `\ No newline at end of file` noise
  - Uses `diffLines()` for proper line-by-line change detection
  - Shows context lines (unchanged parts) naturally

## [0.10.5] - 2025-12-28

### Changed
- **Improved diff display** - Edit operations now show unified diffs with context
  - Uses standard unified diff format (like `git diff`)
  - Shows 3 lines of context around changes
  - More compact: changed lines shown once, not duplicated
  - Line numbers in `@@ -X,Y +X,Y @@` format

## [0.10.4] - 2025-12-28

### Added
- **`--chrome` flag** - Enable Claude in Chrome integration
  - Pass `--chrome` CLI flag or set `CLAUDE_CHROME=true` environment variable
  - Allows Claude to control your Chrome browser for web automation
  - Use `--no-chrome` to explicitly disable
- **Claude Code commands** - New session commands for context and cost management
  - `!context` - Show context usage (tokens used/remaining)
  - `!cost` - Show token usage and cost for this session
  - `!compact` - Compress context to free up space (useful when running low on context)
  - Commands are translated to Claude Code's `/context`, `/cost`, `/compact` slash commands

## [0.10.3] - 2025-12-28

### Changed
- **Improved task list UX**
  - Progress indicator: `📋 **Tasks** (2/5 · 40%)`
  - Elapsed time for in-progress tasks: `🔄 **Running tests...** (45s)`
  - Better pending icon: `○` instead of `⬜` (no longer overlaps)
- **Tool output now shows elapsed time**
  - Long-running tools (≥3s) show completion time: `↳ ✓ (12s)`
  - Errors also show timing: `↳ ❌ Error (5s)`

### Fixed
- **Paused sessions now resume on new message** - messages to paused sessions were being ignored
  - After ⏸️ interrupt, sending a new message in the thread now resumes the session
  - Previously messages without @mention were ignored because the session was removed from memory
  - Added `hasPausedSession()`, `resumePausedSession()`, and `getPersistedSession()` methods

## [0.10.2] - 2025-12-28

### Changed
- Version number now displays directly after "claude-threads" in the logo instead of on a separate line

### Fixed
- **Interrupt (⏸️) no longer kills session** - sessions now pause and can be resumed
  - Previously SIGINT caused Claude CLI to exit and the session was lost
  - Now session is preserved and user can send a new message to continue
  - Works with both ⏸️ reaction and `!escape`/`!interrupt` commands
- **Filter `<thinking>` tags from output** - Claude's internal thinking is no longer shown to users
  - Previously `<thinking>...</thinking>` tags would appear literally in Mattermost messages

## [0.10.1] - 2025-12-28

### Fixed
- **`!kill` now works from any message** - previously only worked within active session threads
  - Can now send `!kill` or `@bot !kill` as the very first message to emergency shutdown
  - Useful when bot is misbehaving and you need to stop it immediately

## [0.10.0] - 2025-12-28

### Added
- **ASCII art logo** - Stylized "M" in Claude Code's block character style
  - Shows on CLI startup with Mattermost blue and Claude orange colors
  - Shows at the top of every Mattermost session thread
  - Festive stars (✴) surround the logo
- **`!kill` command** - Emergency shutdown that kills ALL sessions and exits the bot
  - Only available to globally authorized users (ALLOWED_USERS)
  - Unpersists all sessions (they won't resume on restart)
  - Posts notification to all active session threads before exiting
- **`!escape` / `!interrupt` commands** - Soft interrupt like pressing Escape in CLI
  - Sends SIGINT to Claude CLI, stopping current task
  - Session stays alive and user can continue the conversation
  - Also available via ⏸️ reaction on any message in the session

### Fixed
- **Fix plan mode getting stuck after approval** - tool calls now get proper responses
  - `ExitPlanMode` and `AskUserQuestion` now receive `tool_result` instead of user messages
  - Claude was waiting for tool results that never came, causing sessions to hang
  - Added `toolUseId` tracking to `PendingApproval` interface

## [0.9.3] - 2025-12-28

### Fixed
- **Major fix for session persistence** - completely rewrote session lifecycle management
  - Sessions now correctly survive bot restarts (was broken in 0.9.0-0.9.2)
  - `killAllSessions()` now explicitly preserves persistence instead of relying on exit event timing
  - `killSession()` now takes an `unpersist` parameter to control persistence behavior
  - `handleExit()` now only unpersists on graceful exits (code 0), not on errors
  - Resumed sessions that fail are preserved for retry instead of being removed
  - Added comprehensive debug logging to trace session lifecycle
  - Race condition between shutdown and exit events eliminated

## [0.9.2] - 2025-12-28

### Fixed
- **Fix session persistence** - sessions were being incorrectly cleaned as "stale" on startup
  - The `cleanStale()` call was removing sessions older than 30 minutes before attempting to resume
  - Now sessions survive bot restarts regardless of how long the bot was down
  - Added debug logging (`DEBUG=1`) to trace persistence operations
- **Fix crash on Mattermost API errors** - bot no longer crashes when posts fail
  - Added try-catch around message handler to prevent unhandled exceptions
  - Added try-catch around reaction handler
  - Graceful error handling when session start post fails (e.g., deleted thread)

## [0.9.1] - 2025-12-28

### Changed
- Resume message now shows version: "Session resumed after bot restart (v0.9.1)"
- Session header is updated with new version after resume

### Fixed
- Fix duplicate "Bot shutting down" messages when stopping bot
- Fix "[Exited: null]" message appearing during graceful shutdown

## [0.9.0] - 2025-12-28

### Added
- **Session persistence** - Sessions now survive bot restarts!
  - Active sessions are saved to `~/.config/claude-threads/sessions.json`
  - On bot restart, sessions are automatically resumed using Claude's `--resume` flag
  - Users see "Bot shutting down - session will resume" when bot stops
  - Users see "Session resumed after bot restart" when session resumes
  - Session state (participants, working dir, permissions) is preserved
  - Stale sessions (older than SESSION_TIMEOUT_MS) are cleaned up on startup
  - Thread existence is verified before resuming (deleted threads are skipped)

### Fixed
- Truncate messages longer than 16K chars to avoid Mattermost API errors

## [0.8.1] - 2025-12-28

### Added
- **`!release-notes` command** - Show release notes for the current version
- **"What's new" in session header** - Shows a brief summary of new features when starting a session

## [0.8.0] - 2025-12-28

### Added
- **Image attachment support** - Attach images to your messages and Claude Code will analyze them
- Supports JPEG, PNG, GIF, and WebP formats
- Images are downloaded from Mattermost and sent to Claude as base64-encoded content blocks
- Works for both new sessions and follow-up messages
- Debug logging shows attached image details (name, type, size)

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
- Update notice includes install command: `npm install -g claude-threads`

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
- Connections no longer go "zombie" after laptop sleep - claude-threads now detects and reconnects

## [0.3.2] - 2025-12-27

### Fixed
- Session card now correctly shows "claude-threads" instead of "Claude Code"

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
