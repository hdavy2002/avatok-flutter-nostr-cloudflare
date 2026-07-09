# Ava Copilot — Phases A+B, SERVER side (Agent SRV, 2026-07-09)

Implements the server half of Phases A+B of `Specs/AVA-COPILOT-FINAL-PLAN-2026-07-08.md`
(Part II §5–§9): private Ava lane helper, doc context-menu actions, per-chat toggle,
flags, cache, telemetry. Every LLM call goes through `avaReason()` with
`{role, capability, trigger}` (sacred rule; `scripts/check_ava_reason.sh` stays green —
no direct model-call markers exist in the new files).

## Files

| File | Change |
|---|---|
| `worker/src/lib/ava_lane.ts` | NEW — `postAvaPrivate(env, {uid, conv, text, …})` |
| `worker/src/routes/ava_copilot.ts` | NEW — all four endpoints |
| `worker/src/routes/config.ts` | 3 new flags in `PlatformConfig` + `DEFAULTS` (all `false`) |
| `worker/src/index.ts` | import + 4 route registrations (after `/api/ava/delegate`) |
| `worker/src/do/inbox.ts` | UNTOUCHED — toggle lives in KV, no DO change needed |

## Private lane helper — `postAvaPrivate` (D2/D19)

Wraps (does NOT duplicate) the existing `postAvaMessage(..., private:true)` in
`routes/ava_thread.ts` — the same mechanism `ava_guardian.ts` (`warnPrivately`) and
`ava_image.ts` already use, which routes through the owner's AvaAgentDO `/post` op and
writes ONLY to that user's own InboxDO. The plan-§6 body extras (`moment`, `guardian`,
`sources`, `reply_to_copy`, `capability`) plus `lane:"private"` ride in `meta`. Emits
`ava_private_lane_posted {capability, conv, ok}` per post.

## Endpoints (all `requireUser`, all flag-gated, all respect the per-chat toggle)

| Route | Capability tags | Behaviour |
|---|---|---|
| `POST /api/ava/doc/summarize` `{conv, text?, media_ref?, name?}` | `copilot / doc_summarize / context_menu` | Summary → posted to requester's PRIVATE lane AND returned `{text, cached}` |
| `POST /api/ava/doc/translate` `{conv, text, to}` | `copilot / doc_translate / context_menu` | Inline only (no lane post) → `{text, to, cached}` |
| `POST /api/ava/doc/translate-file` `{conv, text, to, name?}` | `copilot / doc_translate / context_menu` (one call per ≤8k-char chunk) | Full-text translate → PDF or text artifact → private-lane post + `{format, media_ref?/text, file_name, cached}` |
| `GET/POST /api/ava/chat-toggle` | none (no LLM) | D29 per-account per-conversation "Ava in this chat"; GET → `{on}`, POST `{conv, on}` → `{ok, on}` |

Gate order and error contract:

1. Flags off → **503** `{error, flag}` (mirrors `groupTranslationEnabled` in `ai_chat.ts`).
   `avaCopilotEnabled` gates everything incl. the toggle; `avaDocActionsEnabled` gates the
   three doc routes; `avaAutoTranslateFileEnabled` additionally gates translate-file.
2. Auth fail → 401/403 from `requireUser`.
3. Per-chat toggle OFF → **403** `{reason:"ava_off_chat"}` before any `avaReason` call.
4. Missing extracted text → **422** `{reason:"need_text"}` (see Extraction below).

## Flags (config.ts DEFAULTS — all ship dark, flip in KV only)

- `avaCopilotEnabled: false` — master
- `avaDocActionsEnabled: false` — Summarize/Translate context-menu actions
- `avaAutoTranslateFileEnabled: false` — whole-file translation (cost watch)

## Cache & KV keys (env.TOKENS)

- `doc:<conv>|<sha256(text)>|summary|-` — summaries, TTL 30d (D7)
- `doc:<conv>|<sha256(text)>|translate|<lang>` — inline translations, TTL 30d
- `doc:<conv>|<sha256(text)>|trfile|<lang>` — full translated text (PDF re-emitted cheaply), TTL 30d
- `avatoggle:<uid>:<conv>` = `"0"` when Ava is OFF for that chat; absence/`delete` = ON
  (default). Exported helper `avaChatToggleOn(env, uid, conv)` for the Phase-C ODL. Fail-open.

## Telemetry (PostHog via `trackUser`, email always stamped, app `ava_core`)

- `ava_doc_summarize_used` / `ava_doc_summarize_error` — `{conv, len, cache_hit, latency_ms[, reason]}`
- `ava_doc_translate_used` — `{conv, lang, len, cache_hit, latency_ms}`
- `ava_translate_file_used` — `{conv, lang, len, chunks, format, cache_hit, ok, latency_ms[, reason]}` (also emitted with `ok:false` on failure)
- `ava_chat_toggle` — `{conv, on}`
- `ava_private_lane_posted` — `{capability, conv, ok}`
- plus the automatic `ava_reason_call` per LLM invocation (from `ava_reason.ts`).

## Extraction & PDF decisions (per plan §7, no new npm deps)

- **Extraction:** server-readable extraction (unpdf) belongs to the consumers pipeline and
  does not exist in the worker package yet; E2EE media must extract on-device anyway. So
  the routes take client-supplied `text` as primary input; `media_ref` without `text`
  returns 422 `need_text` and the client extracts + retries. SKIPPED (deferred): worker-side
  fetch-and-extract of server-readable media — lands with the consumers extraction stage.
- **PDF:** `pdf-lib` is NOT in `worker/package.json` and adding deps was out of scope. A
  tiny hand-rolled PDF writer (valid PDF 1.4, A4, Helvetica/WinAnsi, correct xref) emits a
  clean text-only PDF when the translation is Latin-1-encodable; it is uploaded to the
  content-addressed public blob path `u/<uid>/public/<sha256>` (same layout `ava_image.ts`
  uses; unguessable URL) and referenced as `media_ref`. Non-Latin scripts (Hindi/Arabic/CJK)
  return `format:"text"` with the full translation + a TODO note — a Unicode-font PDF path
  arrives with pdf-lib later. No `user_media` row is written for the artifact (kept minimal;
  add library registration when the AvaStorage hook lands).

## Skipped / left for the client agent (Phase A+B client half)

- Chat-header toggle UI, context-menu items, orchid private-lane bubble rendering.
- Consumers-side unpdf extraction; charge hooks (Phase B economics) — not in scope for
  these endpoints yet; group-admin AI toggle (D6) is a separate control.
