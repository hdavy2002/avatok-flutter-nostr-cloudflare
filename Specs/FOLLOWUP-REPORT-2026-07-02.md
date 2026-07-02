# AvaTOK Follow-up Execution Report (F1 + bucket 3)

**Date:** 2026-07-02 · **Scope:** everything done *after* `FOLLOWUP-PROMPTS-2026-07-02.md` was uploaded.
**Companion docs:** `Specs/LAUNCH-REPORT.md`, `Specs/LAUNCH-FLAG-MATRIX.md`, `Specs/BRAIN-FLIP-CHECKLIST.md`.

## Ground rules (unchanged)

- **No pushes** — every change is a local commit; you push once. No local builds (CI-only); code is
  written to compile by inspection.
- **No prod mutations from the AI** except the one you explicitly asked for (the PostHog dashboard).
- The follow-up doc's **STEP 1 (merge + CI green)** and **STEP 2 (redeploy consumers)** are yours —
  I can't push, watch CI, or deploy. Everything below is written to be validated on your next CI build.

## Decisions I made (because the question tool errored mid-ask)

1. **F1 DB migration → self-migrating, not a prod REST migration.** I've made zero prod DB writes all
   engagement, so instead of running the D1 REST migration on staging/prod, I used this codebase's
   established **self-migrating `ALTER` pattern** (guarded `ADD COLUMN`, once per isolate — same as
   `inbox.ts` and the guardian tables). The columns self-create at runtime; a migration `.sql` file is
   also committed for the record. You can apply it to staging/prod whenever you like — the code works
   either way.
2. **Stopped at the build-dependent client UI.** The pickers/hold-states/scroll-pagers/toggles across
   F1/F2/F3/F6/F7/F8 are net-new stateful Flutter widgets I can't verify without a build; adding them
   blind risks breaking the settings/chat screens. I did the server authority + docs + dashboard
   (bucket 3) and documented the client UI as the remaining work.

---

## What I built

### F1 — Receptionist status notes, expiry, default language (SERVER) · `d4b7f7a` `[F1-P12-1]`
Files: `worker/src/routes/receptionist.ts`, `worker/migrations/receptionist_status_note.sql`.

- **Self-migrating columns** `status_note` (TEXT), `status_expires_at` (INTEGER ms, null=never),
  `answer_lang` (TEXT BCP-47, null=auto) via `ensureStatusColumns` (guarded ALTER, once/isolate).
- **Save validation:** note capped at 500 chars; expiry **rejected if > 1 year** (`400 expiry_too_far`);
  `answer_lang` validated against the `LANG_CODES` allow-list.
- **Prompt builder:** includes the status note **only while unexpired** ("use it naturally, never read
  verbatim"); opens the call in `answer_lang` (P2 caller-adaptive switching still applies on top), else
  the legacy `language_code`.
- **Lazy-clear:** `loadSettings` nulls an expired note on the next read (+`recept_status_expired_cleared`).
- **Country→language default:** `COUNTRY_LANG` table (~45 markets); `GET /settings` returns
  `answer_lang_default` from GeoIP, used by the client **only** when the owner never set a language.
- **CF engine** (`reception_room_cf.ts` branch) got the feminine-register line + note/lang so both
  engines match.
- **Telemetry:** `recept_status_saved {has_expiry, ttl_bucket}`, `recept_lang_set {lang, source}`,
  `recept_status_expired_cleared`, `recept_status_used_in_call {call_id}`; `answer_lang` +
  `status_note_active` on `ava_recept_triggered`.
- **Voice picker:** already removed from the client earlier; the server pin (`AVA_VOICE`, P12) already
  ignores any client voice. Only a vestigial `_voice` field remains client-side (cleanup deferred).

**F1 remaining (client, deferred):** expanding notes box, expiry chips + custom picker, searchable
language picker pre-selecting `answer_lang_default` "(detected)", and the `_voice` vestige cleanup.

### F3 — Kill the double-write risk + backfill · `616e1eb` `[F3-P8-1]`
Files: `worker/src/routes/messaging.ts`, `worker/src/do/inbox.ts`.

- **Code-level mutual exclusion:** when `CHAT_ARCHIVE_V2=1`, the legacy per-message `CHAT_ARCHIVE`
  lane is **force-disabled in code** (`archiveLegacySuppressedOnce` logs once per isolate) — a
  misconfigured KV/var can never double-write. The two archive systems can no longer both run.
- **Backfill:** it's inherent — a flush starting from high-water 0 walks all existing DO history in
  paced, idempotent, high-water-gated batches. Emits `archive_backfill {msgs, ms, done}` on that
  initial flush (else `chat_archive_flush`). Re-running is idempotent (high-water guards it).

### F6 — Dedicated `safety_flag` frame · `978f5f6` `[F6-P6-1]`
File: `worker/src/routes/ava_guardian.ts`.

- On a flagged message, `guardianScan` posts a dedicated `{type:'safety_flag', conv, msg_id, category}`
  frame to the **recipient's** InboxDO (`/event` broadcast), so the chat can mark that bubble red
  directly instead of parsing the private-warning message. **The sender never receives it.** Best-effort;
  the existing warning-based red bubble still works as the fallback.

**F6 remaining (client, deferred):** persist the frame in the drift DB + the tap-sheet (category
explanation, Block / Report / "This is fine" → `safety_flag_dismissed`) + the Guardian adult opt-out.

### F5 — Liveness challenge pre-roll · already built (no commit needed)
`worker/src/routes/liveness.ts` (`/api/id/liveness/start|upload|verify`, registered in `index.ts`) **is**
the turn-left / turn-right / read-a-phrase pre-roll: Workers-AI head-pose per frame + Whisper STT on the
spoken phrase, random 4-word phrase, shared 3-attempts/24h budget, PASS → `kyc_status='verified'`.
The only gap is the **client** Rekognition→challenge-screen orchestration and the `rekognition+challenges`
provider label — deferred UI.

### F7 — AvaBrain flip checklist · `b5bd984` `[F7-P7-1]`
File: `Specs/BRAIN-FLIP-CHECKLIST.md`. Your privacy sign-off doc: what starts being ingested when
`brainEnabled` flips, what stays on-device (E2E/private), the verified uid-isolation invariant, the
opt-out-UI prerequisite (don't flip without it), and the staging verification steps. **You flip the
flag, not me.**

**F7 remaining (client, deferred):** the guardrail-toggle UI (master + per-app switches, default ON,
scoped, synced to a server prefs row the ingestion pipeline consults).

### F9 — PostHog "Launch Health" dashboard · created (no commit — PostHog-side)
[Dashboard 789484](https://eu.posthog.com/project/139917/dashboard/789484) (pinned, project 139917 EU):

- **Live chart:** "Call connect rate — started vs connected" (`call_started` vs `call_connected`,
  `B/A*100`), insight `JfRMsDlq` — uses events that already have data.
- **Metric-spec text tile:** every remaining Launch-Health metric mapped to its backing event
  (`call_push_sent`/`call_ring_ack`/`call_setup_ms`, `msg_delivery_latency`/`ttfm_ms`/`sync_catchup`,
  `sfu_*`, `safety_scan`/`safety_scan_error`, `liveness_gate_shown`→verified funnel,
  `agent_daily_limit_hit`, `profile_vet_*`, `drive_auto_backup`/`chat_archive_flush`/`archive_backfill`,
  `recept_status_*`, `$exception`). Most are **new events with no data until the merge+deploy** — build
  those insights on day one when they appear in the schema.

---

## Commits from this follow-up run (all local, none pushed)

| Commit | Issue | What |
|---|---|---|
| `d4b7f7a` | `[F1-P12-1]` | Receptionist status note + expiry + answer_lang (server + migration file) |
| `616e1eb` | `[F3-P8-1]`  | Archive mutual exclusion + backfill telemetry |
| `978f5f6` | `[F6-P6-1]`  | Dedicated `safety_flag` frame |
| `b5bd984` | `[F7-P7-1]`  | `BRAIN-FLIP-CHECKLIST.md` |

PostHog dashboard 789484 + insight `JfRMsDlq` created directly (not a repo commit).

## Still pending after this run

**Yours (human / build / deploy):**
- **STEP 1** — merge + push (your one-time push) → CI green; fix any type errors with minimal
  `[CI-FIX-n]` commits (I can do these once you tell me what broke).
- **STEP 2** — redeploy `avatok-consumers` (the `CALL_ROOMS` binding from Phase 1) → test call →
  verify `call_push_sent` / `call_ring_ack`.
- **Flag flips** on your human-gate sequence: `receptTakeoverGuard`, `PARTY_ENABLED`,
  `listingLivenessGate`, `CHAT_ARCHIVE_V2`, `groupAudioSfuEnabled` (+ LiveKit removal / cancel sub),
  `brainEnabled` (after the checklist), `profileCompletionGate`. Cancel LiveKit + confirm Ably cancelled.

**Deferred client UI (needs a build + device):** F1 pickers, F2 profile hold-state + scroll-to-red +
photo Rekognition wiring, F3 chat scroll-pager, F6 safety tap-sheet + opt-out, F7 brain toggles,
F8 sweep (P3 pull-side Opus, `Image.network`→CF-AVIF, error-copy, jank scoping, zine migration, Nostr
purge once build ≥ 0.1.18+27). All tracked in `LAUNCH-FLAG-MATRIX.md` / `LAUNCH-REPORT.md`.

**Not done (data-gated):** the remaining Launch-Health insights — build them once the launch build
ships and the new events flow into PostHog (the dashboard text tile is the checklist).
