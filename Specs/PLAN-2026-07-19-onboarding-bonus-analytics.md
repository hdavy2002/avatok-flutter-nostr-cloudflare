# PLAN — Signup Bonus · AI-Receptionist Onboarding · Receptionist/Voicemail Analytics

2026-07-19, owner brief. Status: PLAN ONLY. Prereqs all live: pay-per-use billing
(3 tok/min agent, 1 tok voicemail), per-user mode field, cell-call live agent
(pstnAgentEnabled=true), concurrency enforcement ON, cockpit wallet APIs.

## A. 100-token welcome bonus (server, small)
- On account creation (find the signup/first-login hook — Clerk user bootstrap in
  worker; grep where a users row is first inserted), credit 100 tokens:
  `walletOp(env, uid, {op:"credit"|equivalent, amount:100, type:"promo",
  app_name:"welcome_bonus", op_id:`welcome:${uid}`})` — idempotent by op_id so a
  re-login can never double-grant. Decide promo-vs-paid bucket: use the FREE/promo
  bucket (like daily free coins) so bonuses can't be paid out; verify walletOp
  credit op shape in routes/wallet.ts + WalletDO first.
- Statement label in wallet_statement.ts FEATURE_LABELS: welcome_bonus → "Welcome
  bonus". Telemetry `welcome_bonus_granted` (email-stamped).
- Retroactive? OWNER DECIDED 2026-07-19: **YES — all existing users get the
  bonus.** Built as `POST /api/admin/welcome-backfill[/:secret]?cursor=`
  (routes/welcome_bonus.ts) paging the users table and issuing the same
  idempotent `welcome:<uid>` grant; run to completion against prod. ✅ SHIPPED
  [WELCOME-100-1]: WalletDO gained a PERSISTENT promo bucket (`acct.bonus`,
  op "promo_credit") because the existing `free` bucket resets daily and is
  zeroed on the premium flip — the bonus must survive both, yet stay
  non-payable (spend draws free → bonus → paid; payouts touch paid only).

## B. AI-Receptionist onboarding flow (Flutter + small server)
✅ SHIPPED [RECEPT-ONBOARD-1] (2026-07-19, commit 301b263, worker version
3e713ee9-8c5c-4e55-84db-c978da7c14cb):
- Server: self-migrating `receptionist_settings.agent_scope` TEXT
  ("cell"|"app"|"all", NULL/invalid → "all" fail-open) in ensureStatusColumns;
  GET returns `agent_scope`; PUT validates + persists it (?21 in the upsert).
  Enforcement BOTH lanes: /start (app lane) demotes mode=agent+scope=cell to
  the zero-cost vm flow; pstn.ts agentStreamXmlOrNull reads agent_scope in the
  same D1 query and falls to voicemail when scope="app" (with a mode-only
  SELECT fallback until the column self-migrates).
- `pstnPaidConditionsUnlocked=true` flipped in prod KV (pay-per-use replaces
  the paid-conditions gate) — verified cache-busted on /api/config.
- Flutter: receptionist_onboarding.dart — full-screen agent wizard (cost intro
  → balance check ≥3 tokens w/ WalletScreen top-up CTA → scope choice → DID
  step w/ struck-through "700 tokens/month" + green "Free in Beta" pill →
  forwarding conditions (cell/all only; reuses PstnForwardingSetupScreen) →
  privacy copy → token summary → save) + one-screen Voice mail sheet (1 token/
  voicemail). receptionist_section.dart toggles now route every mode
  transition through these flows; cancel = no change; save is optimistic with
  rollback. Analytics `recept_onboarding_step` {step, mode} on every step +
  done/cancelled/topup_cta/forwarding_opened.
- Deferred: `onboarded_at` column (wizard currently opens on every agent-ON
  flip — harmless, re-openable by design); DID billing stays display-only
  (TEL-TIERS-1 rail, activate when beta ends); needs an app build ("ship it")
  to reach devices.
Trigger: user flips **AI Voice Agent** toggle ON in the merged Receptionist/Voice
mail page (before saving mode=agent). A separate lighter sheet when flipping
**Voice mail** ON. Multi-step sheet/wizard, AD design system.

Agent-mode steps (exact owner spec):
1. COST INTRO — "An AI conversation costs **3 tokens/min**, calls capped at
   **3 minutes** to save you money."
2. BALANCE CHECK — fetch wallet balance; need ≥3 tokens to proceed. If short:
   top-up CTA (deep-link to wallet), block Continue. (Server already 402s on
   save; this makes it friendly.)
3. SCOPE CHOICE — "Where should Ava answer?" → **Cell phone calls** /
   **AvaTOK-to-AvaTOK calls** / Both. NEW server field:
   `receptionist_settings.agent_scope` TEXT ("cell"|"app"|"all", default "all");
   self-migrate column; PUT/GET carry it; enforcement: /start (app lane) checks
   scope∈{app,all}; pstn.ts agent lane checks scope∈{cell,all}. (Both lanes
   fall back to voicemail when out of scope.)
4. DID NUMBER — "You need a virtual phone number — **700 tokens/month**."
   GREYED OUT with a bright green pill **“Free in Beta”**. No charge wired yet
   (subscription rail exists from TEL-TIERS-1 when we activate it). OWNER
   CONFIRMED 2026-07-19: retail price when beta ends is **700 tokens/month**
   (matches TEL-TIERS-1); the "600" previously quoted here was the owner's
   mistake — do NOT use 600 anywhere. For now the pill is display-only.
5. (Cell scope only) FORWARDING CONDITIONS — the 3 toggles: when I **reject** a
   call · when my **phone is off** · when I'm **not picking up**. Reuse the
   existing carrier-forwarding machinery:
   app/lib/features/avadial/pstn_forwarding_setup.dart already implements
   condition-based forwarding (cfb/cfnrc/cfnry MMI codes) — embed/reuse it, don't
   rebuild. Note [AVA-VM-PAID-1] in config.ts: reject/no-answer conditions were
   marked paid-tier (pstnPaidConditionsUnlocked flag) — with pay-per-use they
   should now be unlocked: flip pstnPaidConditionsUnlocked=true when this ships.
6. PRIVACY COPY — "Under these conditions your call is diverted to your DiD
   number by YOUR phone company. No SMS, OTP or text messages are forwarded, and
   no information leaves your phone — this is standard carrier call routing."
7. TOKEN SUMMARY — "700 tokens/month for your number (**Free in Beta**) ·
   3 tokens/min while Ava talks to your callers · max 3 min per call." → Done →
   save mode=agent (+scope + conditions).

Voicemail-mode sheet: one screen — "Each voicemail costs **1 token**. All
messages appear in your Inbox." → save mode=vm.

Server work in B: agent_scope column + validation + both-lane enforcement;
optionally an `onboarded_at` column so the wizard shows once (re-openable from
the settings card).

## C. Receptionist/Voicemail ANALYTICS page (the big piece)
Goal: per-OWNER dashboard of incoming Ava/voicemail traffic: which numbers call
most, origin country, busiest hours, mode split, minutes & tokens spent.

C1. Event enrichment (worker, do first — data quality feeds everything):
- At /start (app lane) and handleAnswer/record-cb (PSTN lane) emit ONE canonical
  event `ava_recept_call_summary` at call end with props: owner_uid, owner email
  (trackUserContact), caller_e164 (PSTN) or caller_uid/name (app),
  caller_country (derive: E.164 prefix table server-side; app lane use req.cf
  country of caller), mode (agent|vm), transport (app|vobiz), duration_s,
  tokens_charged, hour_utc + owner-local hour (req.cf.timezone), outcome
  (completed|missed|busy|balance_exhausted). Much cheaper to aggregate one rich
  event than stitch 8 event types later.
- Also mirror each summary into a per-owner D1 table `recept_call_stats`
  (owner_uid, ts, caller_key hashed, country, mode, duration_s, tokens) — the
  DASHBOARD reads D1 (fast, free, no PostHog egress); PostHog stays the
  ops/debug view. (Lesson: user-facing analytics should not depend on PostHog
  query latency/limits.)

C2. Server API `GET /api/receptionist/analytics?days=30` (requireUser, own data
only): {top_callers:[{caller,count,minutes}], by_country:[{country,count}],
by_hour:[24 buckets], mode_split, totals:{calls,minutes,tokens}, trend:[daily
counts]}. Reads recept_call_stats; PostHog personal-API proxy only as fallback/
backfill (POSTHOG_PERSONAL_API_KEY exists server-side; never expose it).

C3. Flutter page "Receptionist / Voicemail — Analytics": entry from the merged
settings card + inbox. Cards: busiest-hours bar chart (24h), country list with
counts, top callers (tap → contact/thread), totals row (calls/minutes/tokens
this month), mode split. Reuse cockpit-wallet widget patterns.

C4. AvaBrain feed: send each ava_recept_call_summary to Q_BRAIN as an ingestion
episode ("Sonal called 3× this week, mostly evenings") — MUST respect the
AvaBrain consent rules (rulebook §3): master brain toggle + per-app guardrail
(register a "receptionist" guardrail toggle in main Settings, default ON,
checked by the ingestion pipeline; consent fails closed).

## Order & effort
1. A (welcome bonus) — small; 1 short session incl. backfill decision.
2. B server (agent_scope + condition unlock) then B Flutter wizard — 1-2 sessions.
3. C1 enrichment + D1 mirror — 1 session (do before C2/C3 so data accrues).
4. C2+C3 dashboard — 1-2 sessions. C4 brain feed alongside C1.
- App changes across A-C need builds ("ship it").

## Open questions for owner — ANSWERED 2026-07-19
- Welcome bonus retroactive for existing users? → **YES, backfill ALL existing
  users** (shipped: [WELCOME-100-1] idempotent `welcome:<uid>` grant + admin
  backfill route, run to completion against prod).
- DID retail price when beta ends? → **700 tokens/month** (matches TEL-TIERS-1).
  The "600" quoted in the original brief was the owner's mistake; this doc has
  been corrected to 700 throughout.
- Analytics retention window? → **90 days in D1** (`recept_call_stats`),
  aggregate beyond that.
