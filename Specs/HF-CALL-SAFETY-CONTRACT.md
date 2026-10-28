# HF-CALL-SAFETY — shared build contract (owner-approved 2026-10-28)

Owner approved the plan doc https://claude.ai/artifact/CbnYME9e2KGqfJwEZwvscZ and the screen canvas
https://claude.ai/artifact/PX2g7KynvCJdC4z69KVaCF. The detailed backend spec is `Specs/HF-CALL-SAFETY-1.md` (backend lane).
Rulebook rows: `Specs/RULEBOOK-HELLO-FRAANDS.md` section 21 (HF-SAFE-1…13).

## Owner rules (do not change)
1. Every call is recorded by Vobiz. NOTHING new is spoken on the call (spoken words cost paid minutes). Leave `SAFETY_NOTICE` in `worker/src/lib/hf_call_math.ts` exactly as it is.
2. Fans see an in-app/web safety notice before calling: recorded for safety, nobody listens live; don't share phone number / UPI ID / address; never pay outside Hello Fraands, report it after the call. "Don't show this again" tick (stored per account, local).
3. Influencers agree to the call rules at sign-up (app onboarding step 7, before "Sent for approval"). Existing influencers must accept once before they can go Online again. Rules: don't sell (use the Hello Fraands Shop), no outside payment, no contact sharing, be respectful.
4. After the call: recording → private R2 (never the public BLOBS bucket) → speech-to-text (Hindi/Hinglish) → decision model → action.
5. Verdicts: clean, selling, outside_payment, contact_sharing, abuse, sexual, danger. Score >= hfStrikeHighScore (0.9) → automatic strike (only when hfAutoStrikeEnabled); hfStrikeQueueScore (0.6) .. 0.9 → admin queue, no strike; < 0.6 nothing (score saved). danger → pause now + urgent owner WhatsApp alert. Who said it must also be >= 0.9 sure for an auto strike, else queue.
6. Strikes: tied to one call + one person (fan or influencer). Active 90 days (hfStrikeExpiryDays). 3 active (hfStrikesToPause) → account paused: influencer hidden from Reels/search, calls/queue/new bookings off, existing bookings cancelled with full refund to fans' wallets; paused fan cannot call/book but can log in and withdraw. Only an employee can ban. Ban = permanent, WhatsApp number blocked from new sign-up.
7. Appeal: once per strike, by WhatsApp reply "APPEAL" or the app/web Appeal button → admin queue; accepted = strike removed.
8. Money: paused influencer's earnings held until review ends. On confirmed ban: refund fans of flagged calls from held money first, rest paid out to the influencer's UPI as for a closed account.
9. Retention: clean call audio deleted right after transcription; flagged audio kept 30 days; transcript 30 days clean / 1 year flagged; verdicts, strikes, decisions 1 year. Admin sees flagged line + 2 lines each side; full transcript needs a typed reason; every open is logged.
10. Women-only calls are recorded and checked like others; mark their reviews `women_lane=1` so the admin UI can badge them.
11. Shadow mode first: everything ships behind flags that default OFF.

## Flags (worker/src/routes/config.ts DEFAULTS — backend lane owns this file)
booleans: `hfCallRecordingEnabled` (false), `hfCallReviewEnabled` (false), `hfAutoStrikeEnabled` (false)
numbers (also in numericKeys): `hfStrikeHighScore` 0.9, `hfStrikeQueueScore` 0.6, `hfStrikesToPause` 3, `hfStrikeExpiryDays` 90, `hfFlaggedAudioDays` 30, `hfCleanTranscriptDays` 30, `hfCallRulesVersion` 1
Clients show the fan pre-call notice and the influencer rules gate only when `hfCallRecordingEnabled` is true.

## D1 tables (DB_META; each CREATE TABLE in its own migration file)
hf_call_recordings, hf_call_reviews, hf_strikes, hf_appeals, hf_review_access_log, hf_mod_state(uid PK, status active|paused|banned, reason, review_due_at, updated_at, by_uid), hf_call_rules_accept(uid PK, version, accepted_at), hf_call_reports (fan post-call reports). Exact columns: backend lane decides and documents in Specs/HF-CALL-SAFETY-1.md.

## HTTP API (backend lane implements; UI lanes build against exactly this)
User (normal HF auth, same as other /api/hf routes):
- GET  /api/hf/safety/me → `{ status:"active"|"paused"|"banned", activeStrikes:number, strikesToPause:number, reviewDueAt:number|null, heldPaise:number, rulesAccepted:boolean, rulesVersion:number, recordingEnabled:boolean, strikes:[{ id, reason:"selling"|"outside_payment"|"contact_sharing"|"abuse"|"sexual"|"danger", reasonText, callAt:number, quote:string|null /* the user's OWN words only */, expiresAt:number, removedAt:number|null, removedWhy:string|null, appealStatus:null|"open"|"accepted"|"rejected", canAppeal:boolean }] }`
- POST /api/hf/safety/strikes/:id/appeal `{ message }` → `{ ok, appealStatus:"open" }` (409 if already appealed)
- POST /api/hf/safety/rules/accept `{ version }` → `{ ok }`
- POST /api/hf/calls/:callId/report `{ reasons:["selling"|"outside_payment"|"asked_number"|"abusive"], note? }` → `{ ok }` (only a party of that call; keeps audio 30 days and queues the call)
- Going Online / call start / queue join / new booking return 403 `{ error:"account_paused" }` or `{ error:"call_rules_required" }` when blocked.
Admin (existing admin auth used by /api/admin/hf/*; safety pages restricted to safety reviewers):
- GET  /api/admin/hf/safety/summary → `{ checkedToday, flaggedToday, strikesToday, waiting, oldestWaitingMs }`
- GET  /api/admin/hf/safety/queue?tab=review|strikes|paused|access&cursor= → rows `{ id, kind:"danger"|"review"|"appeal"|"fan_report"|"paused", uid, role, name, photo, verdict, score, speaker, speakerScore, callAt, durationSec, activeStrikes, waitingMs, summary, womenLane }`
- GET  /api/admin/hf/safety/reviews/:id → `{ ...row, lines:[{ t:"06:12", speaker:"fan"|"influencer", text, flagged:boolean }] /* flagged ±2 only */, audioUntil:number|null, history:[...] }`
- POST /api/admin/hf/safety/reviews/:id/transcript `{ reason }` → full lines (logged)
- GET  /api/admin/hf/safety/reviews/:id/clip → audio/mpeg 15 s around the flagged line (logged)
- POST /api/admin/hf/safety/reviews/:id/decision `{ action:"confirm_strike"|"dismiss"|"pause", target:"fan"|"influencer", reason, note? }`
- POST /api/admin/hf/safety/appeals/:id/decision `{ decision:"accept"|"reject", note? }`
- GET  /api/admin/hf/safety/users/:uid/ban-preview → `{ name, strikes:[...], heldPaise, refunds:[{ fanUid, paise }], refundTotalPaise, payoutPaise }`
- POST /api/admin/hf/safety/users/:uid/ban `{ reason, refundFans:true }`
- POST /api/admin/hf/safety/users/:uid/restore `{ removeStrikeIds:[...] }`

## Notifications (backend lane; WhatsApp from the HF WasenderAPI session, email from no-reply@hellofraands.com via BRAND, push via hf_push.ts)
strike given (WA+email+push, reason + how to appeal) · 2nd active strike warning · paused · appeal received (WA) · review decided · fans refunded after a ban · bookings cancelled by a pause · danger → owner WA now · queue item older than 24 h → owner WA once a day · review job failing → owner WA max hourly. Never quote or name the other person. Quiet hours 8 am–11 pm except owner danger alerts.

## Intro-video clean-up (HF-INTRO-DELETE-1)
Reject → delete video + poster from R2 (keep the row, clear keys, set deleted_at); approve → delete the older 'replaced' video's files; purge CDN cache for those URLs; drafts never submitted for 7 days → delete; daily sweep in hf_retention.ts; weekly orphan check of `intro-video/`; admin New influencers rejected row shows the lotus "Video deleted" panel; telemetry `hf_intro_video_deleted {reason, bytes}`.
