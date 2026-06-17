# Phase 4 — Two-Lane Memory

**Read `00-MASTER-PLAN.md` first. 🚫 No commit/push — leave the tree for Phase 11.**

## Depends on
P0 (`AvaMemory` interface, deps for vector store, AvaBootstrap hook).

## OWNED FILES
- NEW dir `app/lib/core/ava_memory/` — `local_index.dart` (SQLite FTS5 + on-device
  vector via the dep P0 added), `embedder.dart` (on-device model **download-on-first-
  use** + embed), `ava_memory.dart` (implements P0's `AvaMemory`; routes private/
  on-device vs server lane).
- NEW: `worker/src/routes/ava_memory.ts` (or extend brain via a NEW file) — server
  lane `brain.search` over Vectorize for the premium/server-readable lane.

## DO NOT TOUCH
`user_brain.ts`, `brain.ts` (existing) unless additive in a NEW file; prefer a new
route module. `inbox.ts`, `api.ts` (P0).

## Tasks
1. **Free on-device lane:** FTS5 keyword first; ZVEC/ObjectBox vector on miss;
   embedder downloaded on demand (bge-small default ~40 MB; EmbeddingGemma opt-in).
   Store vectors at 256-D. Index lazily/selectively (skip trivia).
2. **Premium server lane:** `brain.search` over Vectorize (uid-scoped).
3. Expose `brain.search` as an **AvaTool** (register via ToolRegistry) so P3/P5 use it.
4. Respect private/on-device-only chats: never ship their content to the server lane.

## Acceptance
- "Find that message/file" works offline via FTS5/vector; embedder downloads once.
- `brain.search` tool registered and callable by the spine.
- Only OWNED FILES changed. No git ops. Note appended to INTEGRATION-NOTES.md.
