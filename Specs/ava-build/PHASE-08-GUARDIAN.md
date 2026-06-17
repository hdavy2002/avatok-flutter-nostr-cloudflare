# Phase 8 — Guardian (Safety)

**Read `00-MASTER-PLAN.md` first. 🚫 No commit/push — leave the tree for Phase 11.**

## Depends on
P0, P2 (gate/llama-guard), P3 (private `ava_private` posting).

## OWNED FILES
- NEW: `worker/src/routes/ava_guardian.ts` — `POST /api/ava/guardian/scan`:
  scam/spam flag (free), grooming/luring detection, deepfake/AI-image check on
  incoming media, parent digest builder.
- NEW dir `app/lib/features/ava_guardian/` — secure-chat-mode toggle, the private
  warning UI (uses `ava_private` so the other party never sees it).
- NEW: `app/lib/features/settings/sections/guardian_section.dart` (registered).

## DO NOT TOUCH
P0 hot files, spine files (P3 — post warnings via its private API).

## Tasks
1. **Classifier gate first** (cost): cheap scan; escalate only on signals.
2. Free: basic scam/spam flag. Premium: always-on deep monitoring (PaidFeature).
3. Grooming/luring → **private warning to the at-risk person only** (`ava_private`),
   airtight; verify it never routes to the other participant.
4. Deepfake/AI-image detection on incoming media; weekly **parent digest** for child
   accounts (ties to existing parent role + per-account scoping).

## Acceptance
- A staged grooming/scam message triggers a private warning the other side can't see.
- Free vs premium split honored; child-account digest generated.
- Only OWNED FILES changed. No git ops. Note appended to INTEGRATION-NOTES.md.
