# Phase A — Flutter client (Ava Copilot) — build report

**Date:** 2026-07-09 · **Agent:** CLI (Phase A client) · **Plan:** `Specs/AVA-COPILOT-FINAL-PLAN-2026-07-08.md` (§5 D3, §6, §7, D29, D30)

## What was added, where

### NEW `app/lib/features/ava/ava_lane.dart`
- `AvaLaneBubble` — renders private-lane Ava rows (`kind:"ava"` + `lane:"private"`):
  soft orchid fill `#E6D7F5`, accents `#8E4EC6` (D3), "Ava ✨" author label, small
  info (ⓘ) affordance → `showAvaLaneInfo` bottom sheet with the D3 copy verbatim:
  "I'm Ava, your AI assistant. Only you can see this conversation."
- Guardian variant: when `body.guardian` is present, same bubble + safety accent
  (coral `#D64545` warning icon, "SAFETY" tag, slim category strip). Uses
  `PhosphorIcons.warning` (an icon already proven elsewhere in the repo).
- Self-contained (only imports `core/ui/zine.dart`); gestures are the caller's.

### NEW `app/lib/features/ava/ava_doc_actions.dart`
- `AvaDocActions.menuItems(...)` — returns the three §7 sheet items in order
  (**Summarize ✨ · Translate ✨ · Auto-translate file ✨**), each with subtitle
  "only you will see this". Returns `[]` when `show` is false (Ava-off-chat, D29)
  or there is no conv/media_ref — so hiding is a caller-side boolean.
- Handlers (all via `ApiAuth.postJson`, 45 s timeout):
  - `summarize` → `POST /api/ava/doc/summarize {conv, media_ref, name?}`
  - `translate` → language picker (reuses `ComposerAi.languages`) →
    `POST /api/ava/doc/translate {conv, media_ref, lang, name?}` → inline result dialog
  - `translateFile` → language picker → `POST /api/ava/doc/translate-file {…}` →
    snackbar (file arrives later in the private lane)
- Graceful failures (quiet snackbars, never dialogs): `403 {reason:"ava_off_chat"}`
  → "Ava is turned off for this chat."; `503 {flag}` → "This Ava feature is switched
  off right now."; network/other → generic retry line. 200 **and 202** are success.
- PostHog: `ava_doc_action_tap {action, conv, lang?}` on every tap and
  `ava_doc_action_failed {action, status}` on failure (email/phone ride on
  Analytics.identify person props, as everywhere else).
- `AvaChatToggle` — client for the D29 switch: `fetch(conv)` (GET
  `/api/ava/chat-toggle?conv=…`, defaults ON on any failure) and `set(conv, on)`
  (POST `{conv, on}`; captures `ava_chat_toggle_set`).

### NEW `app/lib/features/ava/ava_unread.dart`
- `AvaUnread` — per-conv `ava_unread` counter (plan §6): `count / increment / clear`
  plus a `revision` ValueNotifier for badge repaints. Storage is per-account by
  construction: every key goes through `scopedKey` / `readScoped`
  (`app/lib/core/account_storage.dart`) on FlutterSecureStorage. All failures
  degrade to 0 (best-effort UI state).

### EDITED `app/lib/features/avatok/chat_thread.dart` (minimal, additive)
1. **Imports** — 3 lines after the existing `../ava/ava_invoke.dart` import.
2. **State** — `bool _avaInChatOn = true;` (D29 default ON), next to `_aiBrainOff`.
3. **Init** — `_initAvaChatState();` added after both `onSummonAva = …` lines
   (DM + group init paths): clears `AvaUnread` for the conv and fetches the
   toggle state (best-effort).
4. **Rendering** — in the bubble builder, just before `final hasMedia = …`:
   private-lane Ava rows (`_isAvaBubble` + `extra.lane == 'private'` or
   `extra.guardian is Map`, and NOT a2ui/media/image rows) return
   `AvaLaneBubble` wrapped in the standard long-press GestureDetector. Ava's
   ordinary @ava turn replies keep the existing lilac path untouched (D30).
5. **Context menu** — in `_onBubbleLongPress`, `...AvaDocActions.menuItems(…)`
   spliced in immediately BEFORE the Forward/Share/Save-to-Drive rows (§7 order),
   gated on `_avaInChatOn && media != null && kind ∈ {file, image}`.
6. **Header ⋮ menu** — `_overflow()` gained a `SwitchListTile` "Ava in this chat"
   (StatefulBuilder so it flips live inside the sheet) → `_setAvaInChat(on)`:
   optimistic local state, `AvaChatToggle.set`, revert + quiet snackbar on
   failure ("Only group admins can change Ava for this group." in groups).
   PostHog `ava_chat_toggle {on, conv, conv_kind}`.

## Parallel-agent toggle check (D29 note)
Searched the whole `app/lib` tree for `avatoggle`, "Ava in this chat", `avaInChat`,
`chat-toggle`, `chat_toggle` — **no parallel implementation existed**, so the
switch was added fresh per the task's fallback instruction (SwitchListTile wired
to GET/POST `/api/ava/chat-toggle` with optimistic state). If the parallel agent
lands their own version later, merge into this one — the UI entry point is
`_overflow()` and the state field is `_avaInChatOn`.

## Server dependency (not yet in the worker at time of writing)
`worker/src` has **no** `/api/ava/doc/*` or `/api/ava/chat-toggle` handlers yet —
the client is coded to the plan's contracts and degrades gracefully until the
Phase-A server agent lands them:
- toggle fetch failure → stays ON (D29 default), doc actions → quiet error snackbar.
- Expected contracts: `doc/summarize|translate|translate-file` accept
  `{conv, media_ref, lang?, name?}`, reply `200/202` with optional `{text}` for the
  inline dialog; errors `403 {reason:"ava_off_chat"}` and `503 {flag}`.
- Private-lane rows must arrive as envelope `t:"ava"|"ava_private"` with
  `lane:"private"`, `text`, optional `guardian:{severity,category}` — the renderer
  keys off `extra['lane']` / `extra['guardian']`.

## TODOs / open items
- `AvaUnread.increment` is not yet called anywhere: the natural call site is the
  inbox/sync layer (SyncHub) when a private Ava row lands for a conv that is NOT
  open — that file is owned by another stream; wire it there (one line) plus a
  badge on the chat-list row via `AvaUnread.revision`.
- Video/audio media are excluded from the doc actions (server pipelines are
  unpdf + image OCR only, §7); revisit in Phase B with E2EE on-device extraction.
- When the server starts enforcing D29 OFF (hiding entry points), consider also
  hiding the composer's Ava-mode chip when `_avaInChatOn == false` (left alone
  now to keep the chat_thread diff minimal).
- Group-admin gating is server-side only; the client shows the switch to all
  members and reverts on 403.
