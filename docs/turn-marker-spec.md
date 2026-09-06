# Turn marker: the daemon says when a turn is over

Upstream discussion: anneschuth/claude-threads#528 (the maintainer proposed
this shape on 2026-09-03).

## What it does

A per-platform setting:

```yaml
platforms:
  - id: slack-main
    type: slack
    turnMarker: metadata        # reaction | metadata | off (default)
    turnMarkerEmoji: checkered_flag   # reaction only; default checkered_flag
```

When Claude's turn ends (the CLI's `result` event) the daemon marks **the
turn's last reply post**:

| `turnMarker` | What happens | Who can see it |
|---|---|---|
| `metadata` | the final edit of that post carries Slack message metadata: `event_type: claude_threads_turn_complete`, `event_payload: { session, turn, ok }` | integrations reading history with `include_all_metadata`; invisible in the UI. Slack only |
| `reaction` | the bot adds `turnMarkerEmoji` to that post | everyone, and any integration reading reactions. Slack and Mattermost |
| `off` | nothing; today's behaviour | |

`ok` is false when the result event reports an error. `turn` counts the
session's turns from 1. A turn that produced no reply post (only a task
list, a question, an approval) has nothing to mark and marks nothing.

Untouched: prompts, questions and approvals (a blocked turn has no `result`
and is not marked; a `turn_waiting` marker for those is a possible follow-up,
asked in #528), the streaming itself, every other post.

## Why

Any integration that reads the channel has to know when the answer is
complete. The daemon streams by editing one post, so "the text stopped
changing" is the only signal today, and every integration reinvents the same
guess (voice-desk: identical on three polls, ~8–12 s late, wrong when a tool
pauses the turn). The daemon knows the truth to the millisecond.

## How

- **Config** (`src/config/types.ts`): `turnMarker?: 'reaction' | 'metadata' | 'off'`,
  `turnMarkerEmoji?: string` on `PlatformInstanceConfig`; resolved with the
  other per-platform dials into `PlatformOverhead.turnMarker: { mode, emoji }`
  (`resolveTurnMarker(mode, emoji, platformType, path)`; `metadata` on a
  non-Slack platform is a startup config error with the field path, because
  silently marking nothing would be worse; an emoji with another mode is
  simply ignored — Gemini plan review: YAML anchors and commented-out modes
  make that a common, harmless state). Wired like `sessionHeader` through
  `index.ts` → `SessionManager` → `MessageManager` options.
- **The result event carries its outcome**: `transformResult` sets
  `resultOk` on the `flush` op it emits (`FlushOp.resultOk?: boolean`, only
  with `reason: 'result'`). No new op.
- **One marker write after the final flush** (`MessageManager`, in the
  `result` flush branch, after `executeFlush`): the content executor's
  `currentPostId` / `currentPostContent` name the turn's last reply post and
  its exact text (both plan reviews: piggybacking on "the final write" is
  fragile because splits, task-post reuse, empty flushes and failed writes
  all move that write; a dedicated write after the flush is not).
  - `metadata`: `platform.updatePost(postId, currentPostContent, { metadata })`
    — Slack's `chat.update` needs text, so the text is re-sent unchanged.
    The platform's `createPost` / `updatePost` gain an optional
    `{ metadata }` (Mattermost accepts and drops it).
  - `reaction`: `platform.addReaction(postId, emoji)`; Slack's
    `already_reacted` is not an error.
  - No post (the turn produced only a task list, a question, an approval):
    nothing to mark. A marker failure is logged and never touches the reply.
- **The turn counter** lives in the `MessageManager` (`turn` increments on
  each `result`), reset with the manager.

## Reading it (what voice-desk does, for the record)

`conversations.history` with `include_all_metadata=true`; a bot post whose
`metadata.event_type` is `claude_threads_turn_complete` is delivered at once.
In reaction mode: a bot post carrying the marker emoji from the bot user.
Without either, the old quiet rule. No configuration on the reader's side.

## Tests (first)

- config: defaults, `metadata` on Mattermost rejected, emoji with `off`
  ignored, a malformed emoji rejected, custom emoji accepted.
- transformer: the result flush op carries `resultOk` true/false.
- message manager: `metadata` re-sends the last post's text with the
  payload after the result flush, once, and only then; `reaction` adds the
  emoji; `off` does nothing; a turn with no post marks nothing; a marker
  failure leaves the reply alone; the turn counter increments; `ok` false
  on an error result; a split turn marks the continuation (the current
  post), not the first part; a soft flush still writing is awaited before
  the result flush (Codex code review: otherwise the marker can land on a
  post that a slower earlier write then supersedes).
- slack client: `chat.update` / `chat.postMessage` body carries `metadata`
  when given, not otherwise.

## Decisions

| Decision | Why |
|---|---|
| One dedicated marker write after the final flush, not piggybacked on it (both plan reviews) | the "final write" moves with splits, task-post reuse, empty flushes and failed writes; one extra `chat.update` per turn is the price of never marking the wrong post |
| `(session, turn)` is not a cross-restart unique key | the counter is per manager and resets with it; readers dedupe by post id, which is what voice-desk does |
| `reaction` default emoji 🏁 `checkered_flag` | rare in real conversations, reads as "finished" without words |
| `metadata` refused on Mattermost at config time | rather than silently marking nothing |
| Payload is small and flat: session, turn, ok | Slack caps metadata size; readers need identity and outcome, not the answer |
| Emoji names validated lowercase only (Gemini code review suggested allowing uppercase) | Slack and Mattermost create custom emoji names lowercase; an uppercase name in config can only be a typo |
| One extra `chat.update` per turn is accepted (Gemini code review called it redundant) | see the plan-review decision above: the alternative marks the wrong post under splits and reuse |
| `ok` from the result event, not from the text | the daemon has the fact; parsing "error" from the reply would be the guess this replaces |

## Lessons learned

(none yet)
