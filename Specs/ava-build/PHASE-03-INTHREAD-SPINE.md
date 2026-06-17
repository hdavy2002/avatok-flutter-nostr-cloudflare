# Phase 3 — In-Thread Ava Spine

**Read `00-MASTER-PLAN.md` first. 🚫 No commit/push — leave the tree for Phase 11.**
This is the central runtime. P6–P9 build on it, so keep posting generic.

## Depends on
P0 (message kinds, visibility scope, chat_thread rendering, `@ava` composer hook).
Soft-depends P2 (gate) and P4 (brain.search) — stub if not ready.

## OWNED FILES
- NEW dir `app/lib/features/ava/` — `ava_turn_controller.dart` (invokes a turn,
  shows the working chip, posts results), `ava_invoke.dart` (`@ava` parse/handler
  wired to P0's composer hook).
- NEW: `worker/src/routes/ava_thread.ts` — `POST /api/ava/thread/turn`.
- NEW: `worker/src/do/ava_agent.ts` — the server-side agent loop (reads thread
  window + rolling summary, calls gate/model, posts `ava`/`ava_private`/`ava_status`
  into the SAME conversation via InboxDO scope).

## DO NOT TOUCH
`chat_thread.dart`, `inbox.ts`, `api.ts` (P0 — use the contracts). Don't add UI for
new kinds; P0 already renders them.

## Tasks
1. `@ava` in a 1:1: user invokes → post `ava_status` ("working…") → agent loop runs
   → post `ava` answer. Support **private** replies via `ava_private` scope.
2. Context budget: recent window + rolling summary (maintain summary cheaply), small
   top-k RAG via P4's `brain.search` when intent needs memory.
3. Untrusted-content discipline: wrap thread/tool text as quoted data (reuse the
   ConversationDO pattern).
4. Expose a clean internal API so P6–P9 can "post an Ava message into conversation X"
   without touching chat UI.

## Acceptance
- `@ava` works in 1:1; working chip shows; answer lands in the same thread.
- Private (`to:<uid>`) replies never reach the other participant.
- Other phases can post Ava messages through your internal API.
- Only OWNED FILES changed. No git ops. Note appended to INTEGRATION-NOTES.md.
