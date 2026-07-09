# AVA CORE Phase 0 — Agent W report (worker package)

**Issues:** AVA-CORE-1..3. **Date:** 2026-07-09 (completed by the verifying session;
the original Agent W left `worker/src/lib/ava_reason.ts` on disk uncommitted and the
migrations undone — this report covers the finished state).

## AVA-CORE-1 — `worker/src/lib/ava_reason.ts` + config

- Helper as designed: `avaReason(env, req)` with required `{role, capability, trigger}`
  tags (dev-throw / prod-warn), primary `AVA_REASONER` on Workers AI → `AVA_REASONER_ALT`
  on OpenRouter on error, optional KV cache `gen:<cacheKey>` on `env.TOKENS`, PostHog
  `ava_reason_call` telemetry per call, `legacyModel` pin (exact pre-Phase-0 OpenRouter
  model, no fallback → wire-identical behavior), and a `stream:true` OpenRouter SSE
  passthrough (returns the raw Response).
- `worker/wrangler.toml`: `AVA_REASONER` + `AVA_REASONER_ALT` added to `[vars]` AND
  `[env.staging.vars]` (named envs don't inherit vars).
- `worker/src/types.ts`: optional `AVA_REASONER`, `AVA_REASONER_ALT`, `GUARDIAN_DEEP_MODEL`.

## AVA-CORE-2 — `ai_chat.ts`

Internal `llm()` rewritten as a tagged wrapper over `avaReason()` with
`legacyModel: utilModel(env)` (`OPENROUTER_UTIL_MODEL` || flash-lite) — same model,
same OpenRouter call, same string-or-throw contract. All 8 call sites tagged:
catchup / smart_replies / translate / group_translate / safety_score (role `copilot`)
plus the later-added bio / gender_infer (app `profile`). All KV caching, guardrails,
response shapes unchanged.

## AVA-CORE-3 — guardian + ChatAVA

- `classifyThreat()` lives in `worker/src/lib/moderation.ts` (NOT ava_guardian.ts as
  the dispatch assumed) — migrated there. Tags `{role:"guardian", capability:"stay_safe",
  trigger:"watched_scan"}`, json+temp0+maxTokens200+timeout15s preserved, fail-open
  preserved. **Opus default REMOVED** (plan D21 / open item #7): default = reasoner
  ladder; `GUARDIAN_DEEP_MODEL` (new) or legacy `OPENROUTER_SECURITY_MODEL` force a
  pinned OpenRouter model. `SECURITY_MODEL` export kept (now empty) for compat.
  `ava_guardian.ts` telemetry `engine` → `"ava_reasoner"`.
- `ava_gemini.ts`: ChatAVA `generate()` + `streamGenerate()` migrated
  (`role:"chatava"`, `capability:"chat"`, `trigger:"user_message"`) with
  `legacyModel: openRouterModel(env)` (`OPENROUTER_CHAT_MODEL` || `z-ai/glm-5.2`) —
  wire-identical today; clearing the pin later flips ChatAVA to the reasoner.
  Gemini-Live / voice / BYO-key paths untouched.
- The Nemotron `moderate()` content-safety floor in lib/moderation.ts stays a direct
  call (a "sense" per the engineering law) — file remains on the ratchet allowlist.

## Verification

- Fresh `tsc --noEmit`: zero errors in all touched files (remaining repo errors are
  pre-existing in untouched files under newer workers-types).
- `scripts/check_ava_reason.sh`: OK (allowlist regenerated; ai_chat.ts + ava_gemini.ts
  removed).
