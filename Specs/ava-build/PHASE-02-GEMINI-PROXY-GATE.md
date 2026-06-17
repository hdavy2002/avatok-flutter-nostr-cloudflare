# Phase 2 — BYO-AI Worker Proxy + Moderation Gate

**Read `00-MASTER-PLAN.md` first. 🚫 No commit/push — leave the tree for Phase 11.**

## Depends on
P0 (route registered in api.ts, flags, AvaAiStore already exists client-side).

## OWNED FILES
- NEW: `worker/src/routes/ava_gemini.ts` — the proxy handler.
- NEW: `worker/src/lib/ai_gate.ts` — the cheap gate + daily-cap + moderation.
- NEW: `app/lib/core/ava_ai_client.dart` — client calls the worker (NOT Gemini direct).
- NEW: `worker/src/lib/ai_quota.ts` — per-uid daily-cap counters (KV/D1).

## DO NOT TOUCH
`api.ts`, `config.ts` (P0). `ava_ai_store.dart`, `ava_ai_setup.dart` are done — do
not change them; just read the key via the existing store from the client.

## Tasks
1. `POST /api/ava/gemini` accepts `{message, context, mode}` + the user's BYO key
   (sent securely / or stored encrypted server-side — see note). **Route ALL Gemini
   calls through here**, never client→Google direct, so moderation always applies.
2. `ai_gate.ts`: run llama-guard on input + output; intent gate (does this turn need
   the model/a tool at all?); enforce **daily cap** + `webSearchEnabled` /
   `fileAnalysisEnabled` flags for non-BYO users; BYO users bypass the cap.
3. Key handling: store BYO key **encrypted, per-uid, revocable** server-side (or
   accept per-request from the encrypted client store) — document which in
   INTEGRATION-NOTES.md.
4. Tier logic: our-keys (free, capped, cheap model) vs BYO (full) vs premium wallet.

## Acceptance
- Client never calls Google directly; all inference flows through the worker + gate.
- Moderation runs on BYO keys too. Daily cap enforced for non-BYO free users.
- Only OWNED FILES changed. No git ops. Note appended to INTEGRATION-NOTES.md.
