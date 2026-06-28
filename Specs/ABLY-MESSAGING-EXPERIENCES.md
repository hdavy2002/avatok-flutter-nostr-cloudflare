# AvaTOK — Ably-Powered Messaging Experiences & Tools

**Status:** Proposal / backlog · **Created:** 2026-06-28 · **Owner:** Davy
**Context:** We have migrated realtime chat onto Ably (see `AVAVERSE-ABLY-MIGRATION-PLAN.md`
and `HANDOVER-2026-06-27-ably-migration.md`). Send still routes through the Worker
(`/api/msg/send` — moderation/AvaBrain/blocks/FCM intact); live receive, typing, presence
and receipts run over Ably. This doc catalogues the **full set of experiences Ably can
power** and turns them into a prioritised build list for our 1:1 and group (≤25) chats.

All capabilities below come from the **Ably Chat SDK** (`@ably/chat`, `ably_flutter`)
plus underlying Pub/Sub features. Researched via Context7 against the live Ably docs.

---

## 1. The Ably toolbox (what the platform gives us)

Ably Chat is a purpose-built layer over Ably Pub/Sub. A **Room** exposes these primitives:

| Primitive | What it does |
|---|---|
| `room.messages` | send · **edit/update** · **delete** · subscribe (Created/Updated/Deleted) · **history with continuity** |
| `room.messages` reactions | **per-message reactions** with 3 counting modes + live **reaction summaries** |
| `room.reactions` | **ephemeral room-level reactions** (floating 🎉 / 👏, not persisted) |
| `room.typing` | typing indicators via `keystroke()` / `stop()`, throttled heartbeat, `currentlyTyping` set |
| `room.presence` | enter/leave/update with **custom data** (status text, mood, "last seen") |
| `room.occupancy` | live counts of **connections** and **present members** |
| `room.status` + `connection` | reliable lifecycle/connection state, auto-reconnect, resume |
| message `metadata` / `headers` | arbitrary payload for replies, mentions, link previews, etc. |
| **Moderation rules** | before/after-publish content moderation & profanity filtering |
| **Push notifications** | native push from message payloads; server-side batching & conflation |
| **History / rewind** | backfill the last N messages so joiners catch up instantly |
| **React UI Kit** | drop-in `ChatWindow`, `Sidebar`, `ParticipantList`, presence/typing widgets (web) |

Counting modes for per-message reactions: **`unique`** (one per user), **`distinct`**
(one of each emoji per user), **`multiple`** (incrementable tallies, e.g. claps).

---

## 2. Build list — experiences for the chat session

Legend — **Have**: already shipped · **Enhance**: exists, upgrade onto Ably · **New**: net-new.

### Tier 1 — Core "feels alive" upgrades (highest impact, low effort)

1. **Live typing indicators ("Sophie is typing…")** — *Enhance.*
   `room.typing.keystroke()/stop()`; render the `currentlyTyping` set as names/avatars.
   Show "X and Y are typing" in groups. Already wired via Ably transport — polish the UI.

2. **Real online / away / last-seen presence** — *Enhance.*
   `room.presence` with custom data `{status, lastSeen, mood}`. Green dot, "Active now",
   "last seen 5m ago". Replaces the flaky InboxDO presence.

3. **Per-message emoji reactions + live counts** — *New.*
   `sendReaction(serial, {name:'👍', type:Distinct})` + `reactionsListener` for summaries.
   Long-press a bubble → reaction bar; show stacked emoji + counts that update in realtime.

4. **Edit & delete messages (synced everywhere)** — *Enhance.*
   `messages.update(serial,…)` / `messages.delete(serial)`; render "edited" tag and
   "message deleted" tombstone live for all participants. (We already hide deleted —
   move it onto Ably's authoritative Updated/Deleted events.)

5. **Delivery & read receipts** — *Enhance.*
   Sent → Delivered (Ably ack) → Read (presence/metadata signal per reader). Single/double
   ticks in 1:1; "Seen by N" in groups.

6. **Instant history / catch-up on open** — *Enhance.*
   `messages.history()` + subscribe continuity so a chat opens already populated and a
   joiner mid-conversation gets the recent backlog with no gap.

### Tier 2 — Richer conversation (medium effort)

7. **Replies & quoted messages** — *New.*
   Store `replyTo` serial in message `metadata`; render the quoted snippet above the reply.

8. **@mentions with notifications** — *New.*
   Parse mentions, store in `metadata`, trigger a push only to mentioned users (ties into
   the push tool below). Highlight the mention in-bubble.

9. **Group reaction bursts (livestream vibe)** — *New.*
   `room.reactions.send('🎉')` — ephemeral floating emoji that everyone sees animate, not
   saved to history. Great for AvaTOK group chats / events / watch-alongs.

10. **Live occupancy badges** — *New.*
    `room.occupancy` → "12 online", "5 viewing" on group threads and live sessions. Pairs
    naturally with the ≤25 group / conference rule.

11. **Reaction strategies per context** — *New.*
    Use `distinct` for normal chats, `multiple` (claps/tally) for live/creator broadcasts —
    a creator-marketplace fit.

12. **Connection-state UX** — *Enhance.*
    Use `room.status` / `connection` to show "Reconnecting…", queue outbound messages
    offline, and auto-resend on resume instead of failing silently.

### Tier 3 — Differentiators & moderation (higher effort / strategic)

13. **Server-side + AI content moderation** — *Enhance.*
    Ably moderation rules (before-publish) as a second gate alongside our AvaBrain/Worker
    moderation, plus profanity filtering. Keep send routed through the Worker.

14. **Smart push notifications** — *Enhance.*
    Ably push with **server-side batching** and **message conflation** so a burst of group
    messages collapses into one digest push instead of spamming — lowers cost and noise.
    Mentions/DMs always push; muted threads conflate.

15. **Pinned messages** — *New.*
    Flag a message via `metadata`/annotation; render a pinned banner at the top of the room.

16. **Scheduled / disappearing messages** — *New.*
    TTL in `metadata`; client hides + server purges after expiry (privacy feature).

17. **Web parity via Ably React UI Kit** — *New (web only).*
    Note: `ably_flutter` is **iOS/Android only**; the React UI Kit (`@ably/chat-react-ui-kit`:
    `ChatWindow`, `Sidebar`, `ParticipantList`) can accelerate a **web** chat client if/when
    we build one. Desktop currently stays on legacy InboxDO.

18. **Polls / structured messages** — *Enhance.*
    We already have polls; carry vote tallies as message reactions/annotations so results
    update live without re-sending the message.

---

## 3. Suggested sequencing

- **Sprint A (quick wins):** #1 typing, #2 presence, #3 reactions, #4 edit/delete, #6 history.
- **Sprint B:** #5 receipts, #7 replies, #8 mentions, #12 connection UX.
- **Sprint C:** #9 group reactions, #10 occupancy, #13 moderation, #14 smart push.
- **Later / strategic:** #11, #15, #16, #17 (web), #18.

## 4. Constraints to respect (from project rulebook)

- **Send stays server-routed** through `/api/msg/send` — never bypass moderation/AvaBrain/blocks/FCM.
- **Per-account scoping** for every new local store (reactions cache, draft replies, read state)
  via `scopedKey()` / `AccountScope.id` — a parent + each child share one phone.
- **Mobile only** for Ably (`ably_flutter`); desktop/web fall back to InboxDO behind
  `useAblyTransport()`. Plan any web work around the React UI Kit separately.
- **Flag-gated & dark** until rolled out (`kMessagingProvider` / `AVATOK_MSG_PROVIDER`).
- **Groups ≤25**, 1:1 calls stay P2P — occupancy/reaction features must honour these caps.

---

*Primitives verified against Ably Chat docs (rooms, messages, message-reactions,
room-reactions, typing, presence, occupancy, React hooks & UI Kit) via Context7, 2026-06-28.*
