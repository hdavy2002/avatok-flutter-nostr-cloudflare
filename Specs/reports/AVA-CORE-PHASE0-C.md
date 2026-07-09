# AVA CORE Phase 0 — Agent C report (consumers package)

**Issues:** AVA-CORE-4..5. **Date:** 2026-07-09 (completed by the verifying session;
the original Agent C left `consumers/src/ava_reason.ts` on disk uncommitted and the
migrations undone — this report covers the finished state).

## AVA-CORE-4 — `consumers/src/ava_reason.ts` + config

- Helper as designed: wraps `env.AI.run`; `req.model` (the existing per-call env
  overrides) WINS over `AVA_REASONER` default — behavior preserving. OpenRouter ALT
  fallback only when a key is present AND the request is chat-shaped AND
  `fallback !== false`; otherwise retry-primary-once-then-throw (call sites keep
  their fail-open try/catch, so queue ack/retry semantics are unchanged). Returns
  the RAW provider output so `aiText()` / `usage` / `parseClassifier()` keep working.
  Telemetry via Analytics Engine + Q_ANALYTICS (`ava_reason_call`). Optional
  `gen:<cacheKey>` KV cache (dormant — no call site uses it yet). `raw` bodies and
  `aiOptions` passthrough for the package's non-plain-chat shapes.
- `consumers/wrangler.toml`: `AVA_REASONER` + `AVA_REASONER_ALT` in `[vars]` and
  `[env.staging.vars]`. `consumers/src/types.ts`: matching optional fields.

## AVA-CORE-5 — migrations

- `brain.ts`: `extract()` → `{role:"brain", capability:"fact_extract",
  trigger:"event_ingest"}`; `captionImage()` → `{capability:"vision",
  trigger:"file_ingest", fallback:false}` (multimodal stays on Workers AI).
  `BRAIN_EXTRACT_MODEL` / `BRAIN_VISION_MODEL` overrides still win. Whisper STT and
  bge embeddings remain DIRECT — senses, exempt (file stays on the allowlist).
- `auto_reply.ts`: `aiReply()` → `{role:"copilot", capability:"auto_reply",
  trigger:"away_message"}`; `classifyUrgent()` → `trigger:"urgency_check"`.
  Canned-message fallbacks unchanged.
- `moderation.ts`: `classifyGemma()` both paths (raw classifier body + vision chat
  with `chat_template_kwargs.enable_thinking:false` + `max_completion_tokens:32` via
  `aiOptions`, `fallback:false`) and `moderateText()` (Llama Guard pin via `model`,
  `fallback:false`) → `{role:"moderation", capability:"content_check"}`. Fail-open
  postures and response parsing unchanged. File removed from the allowlist.
- Existing `bumpAiSpend` + Analytics Engine calls left at the call sites (no
  double-count via `bumpSpend`).

## Verification

Fresh `tsc --noEmit`: only one pre-existing error (brain.ts:163 Vectorize metadata
null, present in committed code under newer workers-types) — nothing in the changed
lines. `scripts/check_ava_reason.sh`: OK.
