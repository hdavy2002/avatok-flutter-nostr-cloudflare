# AvaTOK — Ably Messaging: UI Changes & Current-Thread Comparison

**Created:** 2026-06-28 · **Companion to:** `ABLY-MESSAGING-EXPERIENCES.md`
**Code studied:** `app/lib/features/avatok/chat_thread.dart` (the live 1:1 + group thread,
~5.6k lines) and `chat_list.dart`. Line numbers below are anchors at time of writing.

This doc maps every proposed experience to **the exact UI surface it touches**, what's
**already on screen today**, and **where the new tool/enhancement slots in**.

---

## 0. Anatomy of the current chat thread (what's on screen now)

`build()` (L3780) lays the screen out top-to-bottom:

```
┌─ Header band, 58px (L3789–3858) ───────────────────────────────┐
│  ‹back   [avatar]  Name                         🛡 🔍 📞 🎥 ⋮   │
│                    subtitle: typing… / online / last seen /     │
│                              "N members · tap to manage"        │
├─ Pin banner  _pinBanner()        (L3859, shown if _pinned)      │
├─ Conf banner _confBanner()       (L3861, group LiveKit call)    │
├─ Message list  ListView → _bubble(m)   (L3900–3905)             │
│     each _bubble (L4943):                                       │
│       • reply-quote chip      (L5053)                           │
│       • sender label / forwarded / AVA tag (L5025–5052)         │
│       • text / media / special content                          │
│       • footer: ⭐  EDITED  time  ⏱  ✓✓ status  (L5091–5141)   │
│       • reaction sticker (single emoji, BELOW bubble) (L5146)   │
│       • side avatar                                             │
├─ Mention autocomplete bar  _mentionBar()   (L3909)             │
├─ Input bar  _inputBar() (L4002):                               │
│       • reply / edit banner   _replyBanner()  (L4023)          │
│       • listening banner (STT)                                  │
│       • quick-tools row  _composerTools()  (L4025)             │
│       • ＋attach   [ text field ]   ●send                       │
└────────────────────────────────────────────────────────────────┘
```

Long-press a bubble → bottom sheet `_onBubbleLongPress()` (L3041): a quick-reaction
row `❤️ 👍 😂 😮 😢 👏` (L3060) then Reply · Copy · Copy link · Copy image · Pin · Star ·
Edit · Forward · Share out · Save to Drive · Delete for me · Delete for everyone.

**Key finding:** a lot of the UI scaffolding already exists — but several features are
**local-only or running on the legacy presence WS**, not yet on Ably. The biggest gap is
reactions (see below). So most work is *upgrading existing widgets to Ably data*, plus a
few net-new surfaces.

---

## 1. Feature-by-feature UI changes

### A. Per-message reactions — **biggest change** 🔴
- **Today:** `_react()` (L3215) sets `m.reaction` to a *single* emoji **locally only** —
  no network send, no per-user attribution, no counts. Rendered as one sticker below the
  bubble (L5146–5157). The peer never sees your reaction.
- **Change:**
  - Reaction model `_Msg.reaction` (String?) → a **map of `{emoji: count}` + "did I react"**.
  - Bubble sticker (L5146) becomes a **reaction chip row**: stacked emoji + counts, with
    *my* reactions highlighted. Tap a chip to toggle; tap-and-hold → "reacted by" list.
  - Quick-reaction row in the long-press sheet (L3060) stays, but each tap calls Ably
    `sendReaction(serial, {name, type})` instead of local setState.
  - **New:** a small "+" on the reaction row opens the full emoji picker.
- **Where it goes:** `chat_thread.dart` bubble footer; new reaction sync in the transport
  layer (`app/lib/sync/transport/ably_transport.dart`). Use Ably `distinct` mode for
  normal chats, `multiple` (claps tally) for creator/live rooms.

### B. Typing indicators — **enhance**
- **Today:** header subtitle shows `typing…` (1:1) or `"<who> is typing…"` (group, single
  name) via legacy `PresenceChannel` (L3820, `_onTyping` L583). Clears after 5s.
- **Change:** drive from Ably `room.typing.currentlyTyping` (a *set*), so groups show
  "Ana, Sam +2 typing…". Optional: an in-list **typing bubble** (animated dots) at the
  bottom of the message list instead of only the header — matches the screenshot's
  "Sophie is typing…" pill.
- **Where:** header subtitle (L3819–3828) + optional new `_typingBubble()` above `_inputBar`.

### C. Online / presence / last-seen — **enhance**
- **Today:** header subtitle `online` / `_relLastSeen()` (L3823) via a 20s heartbeat over
  the Cloudflare room (`_startPresenceHeartbeat` L555). Flaky — noted false "online" bugs.
- **Change:** source from Ably `room.presence` (authoritative enter/leave). Add a **green
  presence dot on the header avatar** (L3801–3807) and on `chat_list.dart` rows. Carry
  custom presence data (status/mood) for a future "Away"/custom-status line.
- **Where:** header avatar + subtitle; `chat_list.dart` list tiles.

### D. Delivery & read receipts — **enhance**
- **Today:** bubble footer tick + label `_statusFor()` (L677, rendered L5110): waiting →
  delivered → read, 1:1 only, over the DM receipt channel.
- **Change:** back ticks with Ably delivery/ack + a per-reader read signal. **New for
  groups:** a "Seen by N" affordance — tap your last message → a **read-by sheet** listing
  members who've seen it (groups have no receipts UI today).
- **Where:** bubble footer (L5107–5135) + new `_seenBySheet()`.

### E. Edit & delete — **enhance (mostly wiring)**
- **Today:** Edit (L3093) and Delete for me / for everyone (L3101–3102) exist; `EDITED`
  tag (L5098) and deleted tombstone already render.
- **Change:** route through Ably `messages.update` / `messages.delete` so edits/deletes
  arrive live and authoritatively for all (today they ride the DM channel). UI unchanged —
  just the data source. Low effort.
- **Where:** `_startEdit`/`_deleteForEveryone` handlers → transport layer.

### F. Replies & quotes — **enhance (mostly wiring)**
- **Today:** reply banner above composer (L4023) + quote chip in bubble (L5053);
  `replyTo` stored in message metadata already.
- **Change:** keep UI; ensure `replyTo` rides Ably message `metadata` and that tapping a
  quote **scrolls to the original** (add scroll-to-serial). Low effort.
- **Where:** quote chip (L5053) gets an `onTap`; transport carries metadata.

### G. @mentions + notifications — **enhance**
- **Today:** mention **autocomplete bar** `_mentionBar()` (L3909, matches L216) exists for
  composing. No special render or targeted push on receipt.
- **Change:** highlight the mention token inside the bubble text; store mentions in
  metadata; trigger a **targeted push** only to mentioned users (ties to item J).
- **Where:** `_textContent` rendering + push payload in Worker `/api/msg/send`.

### H. Group reaction bursts (ephemeral) — **new** 🟢
- **Today:** none.
- **Change:** a **floating-emoji overlay** — tap a 🎉/👏/❤️ button and animated emoji float
  up the screen for everyone (not saved to history). Uses Ably `room.reactions.send()`.
  Great for group events / watch-alongs / creator rooms.
- **Where:** new overlay layer over the message list (Stack in `build`), + a small reaction
  button near the send control or in `_composerTools()`.

### I. Live occupancy badges — **new** 🟢
- **Today:** header shows static `"N members"` (L3822) from the roster, not who's live.
- **Change:** show **live counts** from Ably `room.occupancy` — e.g. "5 online" in the
  header subtitle for groups, and a "👁 N watching" chip during group conferences /
  live sessions. Honors the ≤25 cap.
- **Where:** header subtitle (group branch, L3822) + conf banner (L3861).

### J. Smart push notifications — **enhance (backend-led, light UI)**
- **Today:** FCM push on send via the Worker.
- **Change:** Ably push with **server-side batching + conflation** so a burst of group
  messages collapses into one digest push. UI: a **per-thread mute / "mentions only"**
  toggle in the ⋮ overflow (`_overflow` L3535) and the thread info screen.
- **Where:** `_overflow` menu + Worker push config; mostly server work.

### K. Connection-state UX — **enhance**
- **Today:** failed sends show a tappable retry on the bubble status (L5120–5134). No
  global "reconnecting" state.
- **Change:** a thin **"Reconnecting…"/"Offline"** banner under the header from Ably
  `room.status` / `connection`, and queue-and-auto-resend on resume.
- **Where:** new slim banner between header and message list (after L3858).

### L. Pinned messages — **already shipped; minor polish**
- **Today:** `_pinBanner()` (L3859) + Pin action (L3089). Good.
- **Change:** support **multiple pins** with a "1/3" pager, and sync the pinned state via
  Ably metadata so all members see the same pins.
- **Where:** `_pinBanner` + pin store.

### M. Disappearing / scheduled messages — **partly there**
- **Today:** `expireAt` + timer icon in footer (L5103) and expiry filtering (L3868). So
  disappearing messages already render.
- **Change:** add a **timer picker** in the composer/attach menu to *set* the TTL when
  sending (the set-side UI is missing), and surface a per-thread default.
- **Where:** `_attach` sheet / `_composerTools`.

---

## 2. Where each change lands (quick index)

| Surface in `chat_thread.dart` | Features touching it |
|---|---|
| Header avatar + subtitle (L3801–3828) | B typing, C presence/online, I occupancy |
| Slim banner under header (after L3858) | K reconnecting |
| Pin banner (L3859) / Conf banner (L3861) | L pins, I watching-count |
| Message list / Stack overlay (L3900) | H floating reactions, B in-list typing bubble |
| Bubble footer (L5091–5141) | D receipts, E edited tag |
| Reaction chip row (replaces L5146 sticker) | A per-message reactions |
| Bubble text render (`_textContent`) | G mention highlight |
| Quote chip (L5053) | F tap-to-scroll |
| Long-press sheet (L3041) | A reactions, E/F actions |
| Composer tools row (L4025) | H burst button, M TTL picker |
| ⋮ overflow (L3535) | J mute/mentions-only |
| `chat_list.dart` tiles | C presence dots, D unread/seen |

---

## 3. Effort vs impact (UI work only)

- **Mostly wiring (UI exists, swap to Ably data):** E edit/delete, F replies, B typing,
  C presence, D 1:1 receipts. → *fast wins.*
- **Real new UI:** A reaction chip row (the big one), H floating-emoji overlay, I occupancy
  badges, D "seen by" sheet (groups), K reconnecting banner, M TTL picker.
- **Backend-led, light UI:** G mentions push, J smart/batched push, L multi-pin sync.

---

## 4. Constraints (unchanged from rulebook)

- Send stays routed through `/api/msg/send`; reactions/typing/presence/occupancy go
  client↔Ably. New local stores (reaction state, read-by cache, mute prefs, draft TTL)
  must be **per-account scoped** (`scopedKey` / `AccountScope.id`).
- Ably is **mobile only**; desktop stays on InboxDO behind `useAblyTransport()`.
- Everything **flag-gated** until rollout; groups **≤25**.

*UI anchors verified against `chat_thread.dart` on 2026-06-28; line numbers will drift as
the file changes — search by the named method (`_bubble`, `_inputBar`, `_onBubbleLongPress`,
`_composerTools`, `_statusFor`) if they no longer match.*
