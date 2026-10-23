# SPEC-2026-10-23-HF-CALL-MODES-QUEUE — Influencer call modes, live "On a call", call queue, 5-minute chunk billing, booking lengths

Status: APPROVED by owner 2026-10-23 (decisions below). Ships DARK behind flags. Repo read at origin/main 38876010.

## 0. Owner decisions (2026-10-23)
- Three-way switch (web + app): **Online** (instant calls + queue + bookings) / **Bookings only** ("available by appointment") / **Offline**.
- Instant call when Online and idle; no minimum notice.
- "On a call" comes from the live joined call (server), not the app. Callers then get **Book a time** or **Join the queue**.
- Queue: WhatsApp "you're in the queue #N"; when the call ends: **60-second break, then auto-connect** next fan (heads-up WhatsApp just before); influencer sees how many are waiting (web dashboard + app), can pause the queue.
- Booked lengths 15 / 30 / 60 / 120 / 180 / 240 / 300 min. **Booking holds the cost of 15 minutes**, then 5-minute chunks.
- **One money engine** for instant, queued and booked calls: money taken 5 minutes ahead; only spoken minutes charged; caller-only whisper when the wallet can't fund the next chunk; top-up while talking extends the call; max 5 hours.

Defaults adopted for details (coordinator, owner may override):
- D1 Offline: confirmed bookings still ring; Offline stops instant calls, queue and NEW bookings. Switch warns "You have N booked calls. They will still ring."
- D2 To start an instant call / join the queue: spendable ≥ max(₹20, one 5-minute chunk at her rate).
- D3 Influencer misses a queued call: 1st miss → fan keeps place (front); 2nd consecutive miss → queue_paused=1 (mode NOT changed, HF-BOOK-8); waiters told; paused entries expire after 15 min.
- D4 Queue max 10 waiting; max wait 2 h.
- D5 Whisper: "Your wallet balance has run out. This call will end in about X minutes. Please top up your wallet while you are speaking."
- D6 Shipped apps' "Offline" = Bookings only (old app already says "You are offline. Bookings stay open.").
- D7 Lengths 15/30/60/120/180/240/300; hold = cost of min(L,15) minutes.

## 1. Current state (evidence)
### 1.1 Presence
- hf_hosts.presence 'online'|'busy'|'offline' (migrations/2026-10-09-hf-presence.sql:2), presence_call_id owner (2026-10-12-hf-call-presence-owner.sql:2). Choice and line state are conflated.
- Only toggle: PUT /api/hosts/me/presence {online:boolean} (routes/hf_calls.ts:693-738): online→busy if presence_call_id else online (:728); offline (:730); notifyHostOnline (:733); routes :1065-1067; /presence/beat bumps presence_at (:720). No auto-offline (hf_calls_store.ts:98-100, HF-BOOK-8).
- **BUG**: startBookingCore refuses unless host.presence==='online' (routes/hf_bookings.ts ~:718-719) and claimHost requires presence='online' (hf_calls_store.ts:73) → a booked call FAILS if she is Offline or Busy at the booked minute, contradicting HF-REEL-16.
- Readers map unknown→offline: hf_hosts_public.ts:67; hf_search.ts:121,147; hf_reels.ts:104; hf_hosts_list.ts:82,:123; hf_online_count.ts:15; hf_favourites.ts:57; hf_me.ts:132. Flutter PresenceRepo._presence (hf-flutter/lib/data/repos/presence_repo.dart); PresenceStore.online treats busy as online (data/presence_store.dart:26-27); footer pill demo/screens/influencer.dart:241-415. Web HostPanel web/src/islands/dashboard-hf/v3/Overview.tsx:260-301.
### 1.2 Instant calls exist
POST /api/hf/calls (hf_calls.ts:113-224) needs presence==='online' (:131), blocks/closing/lane/booking cutoff (nextBookingCutoff :73-87) → startTokenCall (:229-279) or legacy rupee path. Host-first (HF-CALL-1): do/hf_call.ts init :252 → hostAnswer → hostDigits dials caller (:323-350).
### 1.3 Busy
claimHost sets presence='busy' at call START (hf_calls_store.ts:72-75; called hf_calls.ts:191, :241, hf_bookings.ts ~:724) — "On a call" shows while only ringing. releaseHost (:77-79) from settleAndPost; cron repairs orphans after 10 min (:102-105). Join = conf() "enter" → connect() (do/hf_call.ts:369-406, connected_at). Caller UI: web host_unavailable → Notify (HostCallActions.tsx:173,399); app call_real.dart:254-256.
### 1.4 Queue: none; HF-CALL-6 forbids (rulebook :54; lib/hf_notify.ts:1-3). WhatsApp outbox drained only by 5-min cron (whatsapp_notify.ts:342; index.ts:515-534). Never a 1-minute cron (rulebook :468) → sub-minute timers must be DO alarms. Direct sender: sendWhatsAppText (lib/whatsapp_send.ts:35).
### 1.5 Bookings are 10 min
HF_BOOKING_MINUTES=10 (lib/hf_booking_availability.ts:30); forced [10] (routes/hf_bookings.ts:93-94; lib/hf_booking_store.ts:30,54); APP_MINUTES=10 (hf_bookings_app.ts:45,:144,:320,:471). Hold = full length: reservedPaise=chargePaise(price,duration*60) (hf_bookings.ts:369-370) via buildReservationStatements (:514); cancel (:640) and start (:715) require reservation.secondsCovered===duration_min*60. Auto-start runHfBookingAutoStart (hf_bookings_app.ts:659-673), 5-min cron, window 5 min before. Booked call hardEndsAt=ends_at, maxSeconds=duration*60, booked:true (:728-770), settles reservedLotsOnly (hf_token_calls.ts:158). Slot engine supports any length (slotsForDate; MAX_DURATION_MINUTES availability.ts:34). UI hard-codes 10: hf-flutter booking.dart:60,135,137; models/booking.dart:188,258; web /h/[slug].astro:186,193; WhatsApp hf_bookings_app.ts:509.
### 1.6 Money today
prepareTokenStart (hf_token_calls.ts:72-113): canStart 2 min (hf_token_math.ts:12,:255) + ₹20 (hf_money_rules.ts:20); reserves whole call to cap MAX_CALL_SECONDS=3600 via reserveForCall. maxSeconds=min(cap,secondsCovered); DO tasks.limit=connectedAt+maxSec (do/hf_call.ts:398-402); Vobiz Conference timeLimit backstop maxSec+90 (backstopSec :108-111; noticeAndConferenceXml hf_call_math.ts:124-130). Single gate hftres:<callId> (hf_token_ledger.ts:16, reserveForCall :452-498); readReservation collects per-lot reserve rows by call_id but secondsCovered from the single gate note; settleCall `held = new Map(lots.map(...))` would OVERWRITE duplicate lots (:~575); non-booked settle may draw unreserved lots (:~578). settleTokenCall per-second, clamped (hf_token_calls.ts:152-195); ₹1 first-minute (firstMinuteDrop hf_money_rules.ts:90; :21); monitor judgeCall (:127-150). 60-s warning: alarm warn → speakIntoCall to BOTH legs (do/hf_call.ts ~:483-487; hf_call_math.ts:135). speakIntoCall (lib/hf_vobiz.ts:20-25): Member Speak then Call Speak {legs:"aleg"} — "VERIFY ON FIRST LIVE CALL"; member ids from conference enter (s.member[role] :380); caller leg is its own outbound call so aleg = caller only. Vobiz supports per-member Speak/Play (…/Conference/{name}/Member/{member_id}/Play/). Top-up mid-call does NOT extend: settleHfTopup → creditLot (lib/hf_topup.ts:68-132); DO limit fixed at connect; app promises "Top up to keep talking" (call_real.dart:510,562,608) — false today. Cap 60 min (hf_call_math.ts:6; hf_token_math.ts:11; HF-PAY-2).

## 2. Target design
### 2.1 Host mode + line state
- NEW hf_hosts.call_mode 'online'|'bookings_only'|'offline' (written only by her or account closing). Line lock = presence_call_id (existing; value <callId> or 'q:<queueEntryId>'). NEW hf_hosts.on_call_since (set ONLY in HfCallDO.connect() when both legs joined; cleared in releaseHost). NEW hf_hosts.queue_paused.
- presence stays as a DERIVED column for every existing reader + shipped app; every mode/line write rewrites it in the same statement: busy if on_call_since NOT NULL; else online if call_mode='online'; else offline.
- publicCallState() (new lib/hf_host_status.ts):
  | callState | condition | fan sees |
  | available | mode online, no lock, no waiters | Call now |
  | on_call | on_call_since set | "On a call" + Book a time + Join the queue |
  | connecting | lock held, not joined (ringing / 60-s break) | shown Online; Call → Join the queue |
  | queue_only | mode online, idle, waiters>0 | Join the queue (no jumping) |
  | appointments | mode bookings_only | "Available by appointment" + Book a time + Notify me |
  | offline | mode offline | Offline + Notify me (no new booking) |
- claimHost new: `UPDATE hf_hosts SET presence_call_id=?callId WHERE uid=? AND status='live' AND presence_call_id IS NULL AND (?booked=1 OR (call_mode='online' AND NOT EXISTS(waiting queue)))` → booked claims in any mode (fixes §1.1 bug). Queue dispatch uses claimHostFromQueue ('q:<entry>' → <callId>).
- Line machine: idle --claim--> ringing --connect--> on_call --finalize--> (waiters? break : idle); break(60s, lock q:<entry>) --dispatch--> ringing | --skip--> break(10s) | --empty/mode change--> idle.

### 2.2 Queue (replaces HF-CALL-6 "no queue")
Table hf_call_queue(id, host_uid, fan_uid, seq INTEGER, status waiting|offered|connected|done|left|skipped|expired|closed, skip_reason fan_no_answer|low_balance|blocked|host_missed|host_offline|booking_conflict, host_miss_count, call_id, joined_at, offered_at, ended_at, updated_at, wa_join_at, wa_next_at); UNIQUE(fan_uid) WHERE status IN ('waiting','offered'); INDEX(host_uid,status,seq).
Rules (HF-CALL-10):
1. Join: hfCallQueueEnabled, mode online, not paused, callState on_call|connecting|queue_only; fan verified WhatsApp + age gate + lane; no block either way; neither closing; fan not on a live call; < hfQueueMaxLength (10) waiting; spendable ≥ max(₹20, 5-min chunk at her frozen rate). No money held while waiting; re-checked at dispatch.
2. One active entry per fan (unique index) → 409 already_queued with current host slug.
3. Position live on screen; WhatsApp only at join (#N) and "you're next" (no moving-up spam — WasenderAPI ban risk).
4. Call ends + waiters + mode online + not paused: lock line 'q:<head>', heads-up WhatsApp + push to head fan, wait hfQueueBreakSeconds (60), re-check rule 1, reserve first chunk, startInstantCall(source:'queue'); influencer rung first (HF-CALL-1) "Next from your queue: <first name>".
5. Fan no answer → skipped/fan_no_answer + WhatsApp; next fan after 10 s.
6. Influencer declines/misses → D3.
7. Low balance at dispatch → skipped/low_balance + WhatsApp with top-up link; next fan at once.
8. Mode → bookings_only/offline (or closing forces offline): all waiting → closed/host_offline + WhatsApp; lock released. Pause keeps waiters, stops joins + dispatch; after 15 min paused → expired.
9. Booking first: skip dispatch if nextBookingCutoff (hf_calls.ts:73) < 5 min; else queued call capped at cutoff (hardEndsAt).
10. Block created while waiting removes entry silently (neutral wording).
11. Waiting > hfQueueMaxWaitMinutes (120) → expired + WhatsApp.
12. Fan can leave any time (DELETE), no message.
13. Notify me stays for appointments/offline; queue replaces it only for the on-call case.
Orchestrator: NEW Durable Object HfHostLineDO (idFromName(hostUid)) — serialises all queue mutations; owns break/dispatch/expiry alarms. Poked by HfCallDO after releaseHost (line-free), mode/pause changes, join/leave, and a 5-min cron safety sweep runHfQueueCron (lost alarms, orphan q: locks).
WhatsApp (sendWhatsAppText direct, after INSERT OR IGNORE into whatsapp_outbox checkout_id=<entryId>, kind=hf_queue_<x> for dedupe/audit; brand via BRAND.name, never typed):
- join: "<brand>: You're in <Name>'s queue, #<N>. We'll WhatsApp you just before we call. Nothing is charged until you talk. Leave the queue: <link>"
- next: "<brand>: You're next for <Name>. We'll call you in about 1 minute — keep your phone free. Your number stays hidden."
- skipped no answer: "<brand>: We called you for <Name> but couldn't reach you, so you've left the queue. Nothing was charged. Join again: <link>"
- skipped low balance: "<brand>: It was your turn with <Name>, but your wallet needs at least ₹<X> to start. Top up and join again: <link>"
- closed: "<brand>: <Name> has stopped taking calls for now, so the queue is closed. Nothing was charged. Book a time: <link>"
- expired: "<brand>: Your place in <Name>'s queue has expired. Nothing was charged."

### 2.3 One money engine (lot wallet / hfTokensEnabled path; with hfCallChunkBillingEnabled ON the legacy rupee path hfReserve hf_calls.ts:165-224 refuses: calls_not_ready)
- Ledger: NEW reserveChunk(env, uid, callId, n, price, fromSec, toSec, gatePredicate): gate op hftres:<callId>:c<n>, per-lot …:c<n>:<lot>, kind='reserve', call_id; value=chargePaise(price,toSec)−chargePaise(price,fromSec) (tier-safe); partial allowed; gate predicate always includes NOT EXISTS(op_id IN (hftset:<callId>, hftrel:<callId>)) so a chunk can never land after settle/release. readReservation must AGGREGATE rows by lotId and sum secondsCovered over chunk gates (also fixes settleCall Map overwrite). release/buildReleaseStatements/settleCall/booking checks (hf_bookings.ts:640,:715) use the aggregate. Chunk 0 reserved at start (prepareTokenStart cap=300 s instead of whole call); a booking's hold counts as chunk 0.
- Call DO (do/hf_call.ts) new S fields: fundedSec, capSec=hfCallMaxMinutes*60 (18000), chunkN, short; tasks chunk, fundsRetry, whisper.
  connect(): markOnCall(hostUid, callId); tasks.chunk = connectedAt + (fundedSec−300+5) s; limit = connectedAt + min(fundedSec, capSec, hardEndsAt−connectedAt); Vobiz timeLimit backstop = capSec+90 ALWAYS.
  chunk alarm: ok → fundedSec+=300, reschedule chunk/limit/warn; partial/failed → short=true, limit to partial, whisper CALLER ONLY (D5 text, X=whole minutes left, min 1), fundsRetry every 30 s. At limit−60 s: caller hears the D5 whisper with "1 minute"; influencer hears neutral "This call will end in one minute." (no money reason). Time-cap / booking-end warnings stay "One minute left on this call." to both.
- Top-up while talking: after creditLot in settleHfTopup (hf_topup.ts:111) and the Play credit path → pokeLiveCall(env, uid): find hf_calls caller_uid=? status='connected' → POST /funds to its DO → reserve needed chunks now, clear short, push limit back, whisper caller "Thanks — your wallet is topped up. Your call continues." /info returns moving capAt (shipped app countdown call_real.dart:510 updates on poll).
- Settle unchanged via settleTokenCall with maxSeconds := fundedSec (clamped); per-second for joined seconds; unused chunk/hold released in the same hftset batch; ₹1 first-minute rule kept; booked stay reservedLotsOnly; judgeCall normalChargePaise=chargePaise(price,min(joined,fundedSec)).
- Hard cap 5 h (hfCallMaxMinutes=300, only with chunk flag); old calls keep 60 min.
- speakToCaller (lib/hf_vobiz.ts): Member Speak → Call Speak (caller leg) → Member Play of pre-rendered R2 MP3 (X=1..5 + topped-up) fallback.

### 2.4 Booking lengths (hfBookingLengthsEnabled)
HF_BOOKING_LENGTHS=[15,30,60,120,180,240,300] replaces HF_BOOKING_MINUTES; schedules store the list; slots API takes durationMinutes and returns only starts where [start,start+L] fits open windows + buffer. hold_seconds=min(L,15)*60; reserved_paise=chargePaise(price,hold_seconds) stored on booking; checks compare hold_seconds (fallback duration_min*60 for old rows). Start: chunk engine with hardEndsAt=ends_at, fundedSec=hold; next chunk at minute 10; can't fund → whisper and end at funded time; booking completed. Influencer told the hold covers only the first 15 min. Cancel: full hold back (HF-REEL-28, HF-BOOK-3/4). Old app POST without durationMinutes → 15 when flag on (10 when off).
NOTE: today's HF-BOOKING-UNIFY-1 normalises lengths to [10] on read (lib/hf_booking_store.ts) — with the flag ON this becomes the lengths list; with the flag OFF keep [10].

### 2.5 Endpoints (shared contract; types in worker/src/lib/hf_call_contracts.ts)
- GET /api/hosts/me/presence → {ok, presence (legacy), mode, onCall, queue:{waiting, paused, open}}
- PUT /api/hosts/me/presence {mode} OR legacy {online:boolean} (true→online, false→bookings_only per D6) → same shape. Leaving online closes the queue (rule 8).
- PUT /api/hosts/me/queue {paused}; GET /api/hosts/me/queue → {waiting, paused, entries:[{position, firstName, joinedAt}]} (first names only, never numbers)
- GET /api/hf/hosts/:slug (public, fresh) + mode, callState, queue:{open, waiting}
- POST /api/hf/calls refusals keep error:"host_unavailable" and ADD reason:'on_call'|'connecting'|'queue_only'|'appointments'|'offline', canQueue, canBook, queueWaiting
- POST /api/hf/hosts/:slug/queue → {entryId, position, waiting}; errors queue_closed|queue_full|already_queued|low_balance(+shortfallPaise)|not_verified
- DELETE /api/hf/hosts/:slug/queue (leave)
- GET /api/hf/queue/me → {entry:null|{entryId, hostSlug, hostName, position, status, callId?}}
- GET /api/hf/calls/:id adds fundedUntil, short, capAt (moving), source:'instant'|'queue'|'booking'
- Booking slots/quote/app POST: durationMinutes ∈ lengths; responses add durationsMinutes, holdPaise, holdMinutes
- Internal HfCallDO POST /funds; /info adds fundedSec, short. Internal HfHostLineDO: join, leave, line-free, mode, pause, sweep.

### 2.6 Data model (CREATEs never share a file with ALTERs)
- 2026-10-24-hf-call-modes-alters.sql: hf_hosts ADD call_mode TEXT NOT NULL DEFAULT 'online', on_call_since INTEGER, queue_paused INTEGER NOT NULL DEFAULT 0; hf_calls ADD source TEXT, queue_entry_id TEXT, funded_seconds INTEGER, chunks INTEGER
- 2026-10-24-hf-call-modes-backfill.sql: UPDATE hf_hosts SET call_mode=CASE presence WHEN 'offline' THEN 'bookings_only' ELSE 'online' END; on_call_since for rows with a connected call
- 2026-10-24-hf-call-queue.sql: CREATE hf_call_queue + indexes
- 2026-10-24-hf-booking-hold-alters.sql: hf_bookings ADD hold_seconds INTEGER; hf_booking_quotes ADD hold_seconds INTEGER
- wrangler.toml: [[durable_objects.bindings]] HF_HOST_LINE + [[migrations]] new_classes=["HfHostLineDO"] (check the next migration tag)

### 2.7 Flags (config.ts interface + DEFAULTS same change; numerics in numericKeys; all OFF)
hfCallModesEnabled=false, hfCallQueueEnabled=false, hfCallChunkBillingEnabled=false, hfBookingLengthsEnabled=false (the four booleans public), hfCallChunkMinutes=5, hfCallMaxMinutes=300, hfQueueMaxLength=10, hfQueueBreakSeconds=60, hfQueueMaxWaitMinutes=120, hfQueuePauseExpireMinutes=15, hfBookingHoldMinutes=15. With modes OFF call_mode is still written but presence behaves exactly as today. Turn-on order: modes → chunk billing → queue → lengths; raise hfAppMinBuild after the new app is on Closed Alpha.

### 2.8 PostHog (track(env, uid, event, HF_CALL_APP, props) — 5-arg form)
hf_host_mode_changed{from,to,surface}; hf_host_on_call{call_id,on}; hf_queue_joined{host_uid,position}; hf_queue_left{wait_s}; hf_queue_dispatched{wait_s,position_at_join}; hf_queue_skipped{reason}; hf_queue_closed{reason,waiting}; hf_queue_paused{paused,by}; hf_call_chunk_reserved{n,seconds,paise,partial}; hf_call_funds_short{funded_s,elapsed_s}; hf_call_whisper{kind,ok,via}; hf_call_topup_extended{added_s}; hf_call_ended +source,funded_seconds,chunks; hf_booking_quote_created +hold_minutes. Add to Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md.

### 2.9 Rulebook (Lane A writes ONE rulebook commit for all lanes)
Changed: HF-CALL-6 (queue on on-call; Notify stays for offline/appointments; drop "no line/position" sentence); HF-REEL-15 (three-way switch); HF-REEL-16 (Offline = no instant/queue/new bookings, confirmed bookings ring; Bookings only = by appointment); HF-REEL-19, HF-REEL-28 (lengths, 15-min hold); HF-BOOK-9 (lengths list); HF-PAY-2 (per-second kept; start needs max(₹20, 5-min chunk); max 5 h; 60 s heads-up; money taken 5 min ahead); HF-REEL-35 r1 (₹20 + chunk). New: HF-CALL-7 modes; HF-CALL-8 on-call from joined call; HF-CALL-9 queue flow; HF-CALL-10 queue rules; HF-PAY-22 chunk engine; HF-PAY-23 caller-only whisper + top-up while talking; HF-BOOK-10 lengths + 15-min hold. Changelog row. Help/FAQ/terms copy in Lane E.

## 3. Risks
Money: chunk landing after hangup (gate predicate NOT EXISTS hftset/hftrel + releaseOrphanChunks in settleAndPost + monitor case); double charge (per-chunk op ids, single settle gate, idempotent retry); top-up mid-chunk (/funds idempotent, only while fundedSec < elapsed+300 and < cap); settle billing unreserved time (clamp maxSeconds=fundedSec); refund removing a reserved lot (existing conflict path + monitor case); booked long call with 15-min hold (owner accepted; shown to influencer).
Vobiz: Member/Call Speak "VERIFY ON FIRST LIVE CALL" → MP3 Member Play fallback; no enter events → Call Speak on caller leg; timeLimit must be the 5 h backstop; one queued dispatch per host; spend alerts must allow 5 h.
Scheduling: cron stays 5-min; sub-minute timers in DO alarms only.
WasenderAPI: queue messages direct, ≤1 per fan per 60 s, per-host send lock in HfHostLineDO.
App builds: Flutter needs CI build; server stays compatible (presence values unchanged, legacy {online} PUT, host_unavailable kept, capAt moves, booking POST without length defaults 15). Raise hfAppMinBuild before hfBookingLengthsEnabled.
Fairness: while anyone waits, instant callers must queue.

## 4. Lanes (no lane edits another lane's files)
Phase 0 (Lane A first commit): lib/hf_call_contracts.ts, all flags in routes/config.ts, all migration files, helper signatures with stub bodies: claimHost/claimHostFromQueue/markOnCall/releaseHost (hf_calls_store.ts), notifyLineFree/queueGate/closeQueue (stub lib/hf_queue_store.ts → Lane B owns), startInstantCall (stub lib/hf_call_start.ts → Lane C owns). Land before others start.
- Lane A (host mode + status): lib/hf_call_contracts.ts, lib/hf_host_status.ts, lib/hf_calls_store.ts, routes/hf_host_mode.ts (presence + queue-pause routes moved out of hf_calls.ts:693-738), routes/hf_hosts_public.ts, lib/hf_hosts_list.ts, routes/hf_hosts_list.ts, routes/hf_search.ts, routes/hf_reels.ts, routes/hf_favourites.ts, routes/hf_me.ts, routes/hf_online_count.ts, lib/hf_presence_nudge.ts, lib/hf_exit.ts (forceHostOffline → mode offline + closeQueue), routes/config.ts, worker/migrations/2026-10-24-*, rulebook.
- Lane B (queue): do/hf_host_line.ts, lib/hf_queue_store.ts, lib/hf_queue_messages.ts, routes/hf_queue.ts, worker/src/index.ts (route + DO export + runHfQueueCron), worker/src/types.ts (HF_HOST_LINE), wrangler.toml.
- Lane C (money + call DO): do/hf_call.ts, lib/hf_call_start.ts (startTokenCall moved out of routes/hf_calls.ts), routes/hf_calls.ts (refusal reasons, liveFields; swap presence block for import of A's routes), lib/hf_call_math.ts, lib/hf_token_calls.ts, lib/hf_token_ledger.ts, lib/hf_token_math.ts, lib/hf_vobiz.ts, lib/hf_topup.ts + routes/hf_tokens_play.ts (pokeLiveCall hook only), lib/hf_money_rules.ts, lib/hf_money_monitor.ts. Ledger first (D depends on aggregated reservation).
- Lane D (booking lengths + booked start): lib/hf_booking_availability.ts, lib/hf_booking_store.ts, routes/hf_bookings.ts, routes/hf_bookings_app.ts, lib/hf_booking_approval.ts, lib/hf_booking_reminders.ts.
- Lane E (clients): web — dashboard-hf/v3/Overview.tsx HostPanel (three-way + "N waiting" + Pause queue), web/src/islands/calls/HostCallActions.tsx (Book a time / Join the queue / position / leave / low-balance top-up), web/src/lib/hfCallsApi.ts, web/src/lib/hfBookingsApi.ts, booking pages, web/src/pages/h/[slug].astro, help/FAQ/terms; Flutter hf-flutter/lib/** presence repo/store/bridge, screens/influencer.dart (three-way footer + waiting count), settings_real.dart (pause queue), call_real.dart + call_kit.dart (queue screen, whisper-aware low-balance banner, top-up returns to call), booking screens + models/booking.dart (length picker, 15-min hold copy), feed/profile kits (callState).
Order: Phase 0 → C ledger → {C DO, D, B} parallel → E wiring → staged flag flips → two-phone live Vobiz check → hfAppMinBuild bump.
Tests per lane: see each lane brief; use in-memory SQLite real-handler pattern (worker/src/routes/hf_bookings_e2e.test.ts makeEnv).
