# avaTOK-2-Flutter

---

## ⚠️ ARCHITECTURE PIVOT — NOSTR IS DEPRECATED (2026-06-09)

**The Nostr/relay/E2E-gift-wrap messaging design is NULLED going forward.** AvaVerse
is now a Cloudflare-native, **server-readable** architecture (per-user `InboxDO` with
hibernatable WebSocket + DO-local SQLite; server is router; device stays local-first).
Canonical: **`Specs/AVAVERSE-CLOUDFLARE-NATIVE-ARCH.md`** and handover
**`Specs/HANDOVER-2026-06-09-cloudflare-native-pivot.md`**. Where the Nostr "Engineering
rulebook" below or `Specs/AVATALK-CLOUDFLARE-RULEBOOK.md` conflict with the new arch,
**the new arch wins** (those files are pending rewrite). Do NOT re-introduce Nostr
(NIP-17/44/59, gift-wrap, keypairs, NIP-42/98, the relay Worker). Do NOT make a single
central D1 the high-write message store — messages live in DO-local SQLite per user.
Still valid: per-account scoping. NOTE (2026-06-10): the old "1:1-only calls" rule
was CHANGED in Phase 10 — group conferences ≤25 via LiveKit are now allowed (see
the product rule below).

---

## Graphiti memory — CANONICAL group_id (READ THIS FIRST)

<!-- pre-push hook fallback marker — DO NOT REMOVE. The git pre-push hook greps
     CLAUDE.md for a quoted group id when ~/.graphiti-projects.tsv lacks an entry,
     so the auto-logged push episode lands in the right group. Keep the line below.
     group_id: "proj_avaflutterapp" -->

**This project's Graphiti group_id is `proj_avaflutterapp`. Always pass it explicitly on EVERY graphiti-memory call — both reads and writes. No exceptions.**

- Writes: `add_memory(..., group_id="proj_avaflutterapp")`
- Reads/searches: `search_memory_facts`, `search_nodes`, `get_episodes` → `group_ids: ["proj_avaflutterapp"]`

Rules:

- NEVER omit `group_id`. If you omit it, the Graphiti server falls back to its CLI
  default or **auto-generates a brand-new random group_id**, which silently scatters
  this project's data into a new empty partition. That is the root cause of "my
  graphiti is empty / new project name every session." Treat a missing group_id as a bug.
- NEVER use `personal` (or any other name) for this project. The account-wide preference
  "use group_id 'personal' if none specified" is OVERRIDDEN here — this project always
  uses `proj_avaflutterapp`.
- All existing project history (AvaTalk/AvaTok phases, backend, frontend, go-live items)
  already lives under `proj_avaflutterapp`. Do not create variant names like
  `avatok`, `avatok-2-flutter`, `avaflutterapp`, etc.

At the start of a task, pull context with `search_nodes`/`search_memory_facts` scoped to
`group_ids: ["proj_avaflutterapp"]`. When the user shares durable facts/decisions, save
them with `add_memory(group_id="proj_avaflutterapp")`.

---

## Code search (graphify-avatok-2-flutter)

This project has a graphify knowledge graph at `graphify-out/graph.json`. The
corresponding MCP server name is **`graphify-avatok-2-flutter`** — when answering structural
code questions about this project, call those tools
(`mcp__graphify-avatok-2-flutter__query_graph`, `mcp__graphify-avatok-2-flutter__get_neighbors`,
`mcp__graphify-avatok-2-flutter__get_node`, `mcp__graphify-avatok-2-flutter__shortest_path`).
Do NOT call any other `graphify-*` MCP — those belong to different projects.

Prefer graphify over grep for structural questions: "what calls X", "what imports Y",
architecture and call-flow questions, "find code related to Z". Stick with grep for
literal text / string search (TODOs, error messages, arbitrary tokens).

---

## Engineering rulebook (READ — applies to every app)

**AvaTOK product rule — RULE CHANGE 2026-06-10 (owner decision, Phase 10).**
Group conferences ARE allowed in AvaTalk groups, **≤25 participants, via LiveKit**
(`worker/src/routes/conference.ts` + `app/lib/features/conference/`). 1:1 calls
stay P2P (CallRoom DO, **2-peer cap unchanged** — group conferences never touch
it; do NOT raise the cap). Group/conference CONSULTING still lives in AvaConsult.
Enforcement: group-thread call icons active only when `memberCount <= 25`
(otherwise greyed + a notice popup), the Worker rejects start/join for >25-member
groups, and LiveKit `max_participants=25` is the server-side backstop. All gated
by the `conferenceEnabled` kill switch (`routes/config.ts`). Group chats keep FULL
messaging (text, media, voice notes, stickers, polls, location, contact cards).

The full rulebook is **`Specs/AVATALK-CLOUDFLARE-RULEBOOK.md`** — read it before
building. It governs ALL AvaVerse apps. The two client rules that bite hardest:

1. **Per-account scoping is MANDATORY.** One phone is shared by a parent + each
   child account, so ALL per-user local state (secure storage, prefs, file caches)
   MUST be namespaced with `scopedKey(...)` / `readScoped(...)`
   (`app/lib/core/account_storage.dart`) or a per-account subdir using
   `AccountScope.id`. A raw global key = data leaking across accounts. Only
   device-level values (e.g. the Clerk client token) stay global. When adding ANY
   new store, scope it from the start.

2. **Image/media caching pipeline.** Public images (avatars, posts): upload to
   `/upload/public`, serve via Cloudflare
   `/cdn-cgi/image/format=avif,quality=60,width=N,fit=cover/<path>`, and cache
   on-device (`app/lib/core/avatar_cache.dart`; `Avatar` widget). Private DM media:
   cache the DECRYPTED bytes on-device per account (`MediaService.downloadAndDecrypt`
   → `…/media/<AccountScope.id>/<hash>`). Never re-download on reopen; load local-first.

3. **Universal storage, dedup display & AvaBrain consent.** ONE per-account storage
   pool shared by all apps (AvaLibrary/AvaStorage): 5 GB free, then AvaCoins/GB/month
   (default 20) from the AvaWallet; empty wallet over quota = read-only, NEVER delete.
   Files are content-addressed → ONE real copy; "add to folder" is a shortcut counted
   once; cache on-device + Cloudflare. AvaBrain is ON by default (opt-out): a master
   switch in the main Settings + per-app guardrail toggles (all default ON), each
   registered into the main Settings and checked by the ingestion pipeline; private/
   E2E content is read on-device only regardless of toggle. Full detail in the rulebook.
