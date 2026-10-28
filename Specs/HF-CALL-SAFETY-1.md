# HF-CALL-SAFETY-1 (backend: HF-CALL-SAFETY-BE)

Owner-approved rules: every call is recorded, nothing new is spoken, recording goes to private R2, then speech-to-text, then a decision model, then action. Everything ships dark (shadow mode) behind flags.

## Flags (`routes/config.ts` DEFAULTS and `numericKeys`)

| Flag | Default | Meaning |
|---|---|---|
| `hfCallRecordingEnabled` | false | Adds the `<Record>` verb on the caller leg; influencer call-rules gate on; clients show the fan notice. |
| `hfCallReviewEnabled` | false | Cron processes recordings (copy, transcribe, decide, queue). |
| `hfAutoStrikeEnabled` | false | Lets a score >= `hfStrikeHighScore` strike by itself, and a sure `danger` pause by itself. |
| `hfStrikeHighScore` / `hfStrikeQueueScore` | 0.9 / 0.6 | Auto strike line / admin queue line. |
| `hfStrikesToPause` / `hfStrikeExpiryDays` | 3 / 90 | Active strikes that pause / days a strike is active. |
| `hfFlaggedAudioDays` / `hfCleanTranscriptDays` | 30 / 30 | Retention. |
| `hfCallRulesVersion` | 1 | Raise to make every influencer accept again. |

## Pipeline

1. `noticeAndConferenceXml(..., record)`: caller leg gets `<Record recordSession="true" playBeep="false" callbackUrl=".../recording/<callId>/caller">` before the unchanged `SAFETY_NOTICE`. Only the caller leg is recorded (conference-level and REST recording are not usable per the Vobiz docs).
2. Webhook `POST /api/hf/vobiz/<secret>/recording/<callId>/<role>` (same secret check as the other Vobiz webhooks). Idempotent on `RecordingID` (`INSERT OR IGNORE`); always 200 for a well-formed delivery, 500 only on a transient DB error so Vobiz retries.
3. Cron (`runHfSafetyCron`, every 5 min, inside the scheduled `Promise.all`): job table `hf_call_recordings`, statuses received -> copied -> transcribed -> done (skipped / failed). Steps retry with backoff, 5 attempts. Copy to private `DIGITAL` (`hf-call-audio/<call>/<recording>.mp3`, size verified), then the Vobiz original is deleted. Clean audio is deleted right after transcription.
4. STT behind `SttProvider`: Gemini audio (inline up to 14 MB, else Files API), JSON schema, Hindi/Hinglish, speaker labels with confidence. Sarvam is not implemented (hook: `pickStt`).
5. Decision behind `DecisionProvider`, in order: JEV (stub; only active when a key exists in `env.JEV_API_KEY` or KV `hf_safety_jev_key:v1`), clef via Workers AI (`@cf/cloudflare/clef`, typed noul/choice questions per category in 40-line chunks), Gemini strict-JSON fallback. Each model call emits `$ai_generation` (no text).
6. Rules engine (`lib/hf_safety_rules.ts`, pure): score >= 0.9 and auto on and speaker >= 0.9 sure -> strike; 0.6 to 0.9 (or not sure who spoke, or auto off) -> admin queue; below 0.6 nothing, score saved; `danger` always raises the owner WhatsApp alert and pauses only when auto is on and the speaker is sure.

## Tables (DB_META, one migration file each, `2026-10-28-hf-call-safety-*.sql`, NOT applied)

`hf_call_recordings` (job), `hf_call_reviews` (verdict, score, speaker, `lines_json`, `flagged_idx`, `women_lane`, status clean|queued|struck|dismissed|paused, kind review|danger|fan_report), `hf_strikes` (one per call and person), `hf_appeals` (one per strike), `hf_review_access_log`, `hf_mod_state` (uid, status active|paused|banned, reason, review_due_at, prior_host_status, payout_pending), `hf_call_rules_accept`, `hf_call_reports`, `hf_banned_numbers` (phone hash), `hf_safety_notices` (queue with quiet hours and unique `notice_key`).

## Enforcement (`hfModStatus(uid)`, fails open if the table is missing)

Going Online / bookings-only (`hf_host_mode`), call start (`hf_calls`), queue join, new booking (customer and host), influencer payout create (earnings held), sign-up OTP send for banned numbers. A paused influencer's `hf_hosts.status` becomes `paused` (hidden from Reels and search by the existing live filters); the old status is restored on restore. A paused fan can still log in and withdraw. Influencers must have accepted `hfCallRulesVersion` before going Online (only while `hfCallRecordingEnabled`). Blocked: 403 `{error:"account_paused"}` or `{error:"call_rules_required"}`.

## Money

Pause: bookings cancelled with a full refund (`releaseHfBookingsForUser`), earnings held. Ban: flagged calls' fans refunded newest first from held money using `correctCallCharge` (with `reverseHost`), the rest paid to the UPI via `createExitPayout` (duplicate-guarded; cron follow-up for earnings still maturing).

## HTTP (exactly the contract)

User: `GET /api/hf/safety/me`, `POST /api/hf/safety/strikes/:id/appeal`, `POST /api/hf/safety/rules/accept`, `POST /api/hf/calls/:callId/report`.
Admin (ADMIN_UIDS, narrowed by KV `hf_safety_reviewers:v1` comma-separated uids when set): `GET .../summary`, `GET .../queue?tab=review|strikes|paused|access&cursor=`, `GET .../reviews/:id`, `POST .../reviews/:id/transcript`, `GET .../reviews/:id/clip`, `POST .../reviews/:id/decision`, `POST .../appeals/:id/decision`, `GET .../users/:uid/ban-preview`, `POST .../users/:uid/ban`, `POST .../users/:uid/restore`.
Interpretations: queue returns `{ok, items, nextCursor}` (repo convention); appeal rows add `reviewId`, `strikeId`; paused rows use `id = uid`; the strikes tab lists open appeals first, then recent struck reviews. Every detail open, transcript and clip is written to `hf_review_access_log` and `admin_audit`.

## Notifications

Queued in `hf_safety_notices` (push, WhatsApp via `whatsapp_outbox` kind `hf_safety`, email) with quiet hours 8am-11pm IST. Owner alerts (danger now; queue item over 24 h once a day; failing jobs max hourly) go through `sendAdminAlert` and ignore quiet hours. Messages never name or quote the other person.

## Retention (`hf_retention.ts` -> `hf_safety_retention.ts`)

Flagged audio 30 days; transcripts 30 days clean / 1 year flagged; verdicts, strikes, appeals, reports, access log, recordings 1 year; sent notices 90 days.

## Not verified

Live Vobiz `<Record>` callback field names; clef response field names; Gemini Files API upload path; which stereo channel is which (speaker comes from the model); no inbound WhatsApp webhook exists, so "APPEAL" reply is not wired (messages point to the Appeal button); account-deletion purge of the safety tables (the 1-year rule applies instead).

## Deploy order (later, by the coordinator)

1. Apply the ten migrations to DB_META. 2. Deploy the worker. 3. Set flags in order: `hfCallRecordingEnabled`, then `hfCallReviewEnabled`, then `hfAutoStrikeEnabled` last, after a week of queue review.
