# Phase 6 — Companion / Blank Ava Chat + Voice

**Read `00-MASTER-PLAN.md` first. 🚫 No commit/push — leave the tree for Phase 11.**

## Depends on
P0, P3 (posts via the spine's internal API). Uses ElevenLabs MCP.

## OWNED FILES
- NEW dir `app/lib/features/ava_companion/` — "New chat with Ava" entry, persona
  picker, companion thread (reuses P3's posting API + P0's kinds).
- `app/lib/features/avatok/chat_list.dart` — add the "New Ava chat" affordance.
  (chat_list is assigned to P6 — no other phase edits it.)
- NEW: `app/lib/features/settings/sections/voice_section.dart` — ElevenLabs voice
  toggle (registered).
- NEW: `worker/src/routes/ava_companion.ts` (if a persona endpoint is needed) — else
  reuse AgentDO personas via a NEW thin module.

## DO NOT TOUCH
`chat_thread.dart`, spine files (P3), P0 hot files.

## Tasks
1. Blank Ava chat: brainstorm/roleplay/language practice on the companion persona.
2. Personas (reuse AgentDO persona system); **age-gate** roleplay to verified adults
   (L-tier identity) with llama-guard boundaries.
3. ElevenLabs voice toggle in settings → Ava can voice-reply (render on demand only).

## Acceptance
- A user can start a blank Ava chat and converse; voice works when toggled on.
- Roleplay gated to verified adults.
- Only OWNED FILES changed. No git ops. Note appended to INTEGRATION-NOTES.md.
