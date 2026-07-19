# MASTER PLAN — Token Billing Engine · Cockpit Wallet · PSTN Live Agent

2026-07-19. Companion to: AvaTok_Tiered_Pricing_Brief.pdf (canonical pricing —
also stored verbatim-in-substance in Graphiti episode "CANONICAL PRICING"),
Specs/PLAN-2026-07-19-vobiz-media-stream-agent.md (PSTN transport handover),
Specs/PLAN-2026-07-19-gemini-live-india-finetune.md (agent behavior rules).

## DONE TODAY ([RECEPT-BILLING-1])
- Rate corrected to the brief: `ava_receptionist_minute = 3` tokens/min
  (supersedes same-day verbal "5"). Hard cap already 3:00 (`receptHardCapMs`).
- `receptBillingLive` flag (config, default false): when true, receptionist
  minutes charge FOR REAL even while `betaFreePremium` keeps everything else
  free — the owner's live token-deduction test switch
  (`chargeFeature(..., {forceMeter})`). Test: flip flag, agent-mode call,
  check wallet balance + `ava_recept_billed` + wallet_ledger row.
- Voice Agent (6/min, 10min cap) + Marketplace (12/min platform fee + creator
  markup, 30min cap, payout LEGAL BLOCKER) stored in Graphiti as canonical,
  inactive.

## PHASE 1 — Billing engine v2 (per-second, brief-compliant)
Current billing = per-started-minute at finalize. The brief requires:
1. **Wallet in token-hundredths**: today's wallet is integer whole tokens
   (WalletDO). Add hundredths WITHOUT migrating balances: keep the wallet in
   whole tokens; meter calls internally in hundredths and settle the CEIL to the
   wallet at finalize, OR migrate WalletDO to ×100 units (bigger; audit
   wallet_ledger consumers first). Decision needed.
2. **Start gate**: `/api/receptionist/start` reject agent-mode when balance < 3
   tokens (reuse walletOp balance read; distinct 402 reason `insufficient_tokens`
   so the client can deep-link to top-up).
3. **Live decrement + client display**: DO sends `{t:"balance", tokens_left,
   est_minutes}` control frame every 15s; client shows it (app change).
4. **Hard stop at zero**: DO tracks accrued hundredths (0.05 tok/s); when the
   NEXT second would exceed balance → play low-balance line (one-shot TTS or
   [SYSTEM] cue → her own words) → finalize("balance_exhausted").
5. **Per-call cost ledger**: new D1 table `call_cost_ledger(call_id, user_id,
   mode, start_ts, end_ts, duration_seconds, tokens_charged,
   actual_api_cost_inr)` — reception_room already computes `estUsd` at finalize
   (audio+text token accounting); convert USD→INR (config numeric usdInr, e.g.
   96.4) and INSERT. Internal only — never exposed to clients.
6. **Margin alert**: at finalize compute worst-minute real cost; if > ₹2.20
   (config `receptMarginAlertPaise=220`) emit `ava_recept_margin_alert` +
   consider a push to the owner ops account.

## PHASE 2 — Cockpit wallet page (owner's ask: "aircraft cockpit view")
Goal: user sees exactly where money went and what they earned.
Server (build first):
- `GET /api/wallet/statement?from&to&cursor` — unified feed joining
  wallet_transactions (has app_name/feature + op_id + ts + amount) with
  friendly labels; each row: {ts, direction: earn|spend|topup|payout, feature
  ("AI Receptionist", "AI Voice Agent", "Marketplace sale", …), tokens, balance_after,
  ref (call_id/listing_id)}.
- `GET /api/wallet/summary?period=day|week|month` — aggregates: total earned
  (marketplace sales, creator share), total spent by feature (pie), avg/min
  cost per receptionist call, minutes used, projected runway (balance ÷ 30-day
  burn), top-up history.
- Reuse: wallet_ledger + wallet_transactions already carry app_name per spend
  (chargeFeature writes them); marketplace earnings land via money-settlements
  queue. Verify each row type renders a label; unknown → "Other".
Client (Flutter) — one screen, cockpit layout, AD design system:
- Top instrument row: balance dial, 30-day burn gauge, runway estimate,
  earned-vs-spent delta.
- Middle: per-feature spend breakdown (bars/pie: Receptionist, Voice Agent,
  chat, images, listings) + earnings breakdown (marketplace, creator share).
- Bottom: infinite-scroll statement with per-row icon, feature, tokens ±,
  running balance, tap → detail (call duration, listing link).
- Live: after any call ends, refresh via existing push/inbox signal.

## PHASE 3 — PSTN live agent (Vobiz media streams)
Full handover already in Specs/PLAN-2026-07-19-vobiz-media-stream-agent.md.
Summary: Vobiz supports `<Stream bidirectional keepCallAlive>` WebSocket audio
(L16 16k in / 24k out = Gemini native, clearAudio barge-in). New VobizAgentRoom
DO + pstn_agent.ts route; pstn.ts only emits Stream XML when owner mode=agent +
`pstnAgentEnabled` flag; all failure paths fall back to voicemail XML. Billing:
same engine as Phase 1 (3 tok/min receptionist profile; the brief prices PSTN
and in-app IDENTICALLY — no separate price). PRE-REQ: top up Gemini credits on
avatok-avaglobal (#7456307191); confirm audio-streams enabled on the Vobiz account.

## PHASE 4 — Telephony subscription tiers (Teler resale) — separate lane
₹700 Tier-1 (1 channel+1 number) / ₹2,500 Tier-2 (4+4) / ₹700 add-on channel.
Needs: subscription products in the wallet/billing system, per-account
channel+number provisioning records, and CONCURRENCY TRACKING (peak simultaneous
calls per account + busy/rejection rate; alert at 80% peak utilization;
voicemail tier oversubscribe ~3:1, bulk ~1:1). Do not start until Phase 1-2 land.

## Order & effort
1. Phase 1 (billing v2): 1 session server + small app bits. HIGHEST priority —
   the brief marks it "build now", and Phase 3 depends on it.
2. Phase 2 (cockpit): 1 session server API + 1-2 sessions Flutter UI.
3. Phase 3 (PSTN agent): 1-2 sessions (bridge exists).
4. Phase 4 (subscriptions): after 1-2.

## Standing rules for whoever implements
- Deploy via scripts/cf.sh (ALLOW_PROD=1), flags via scripts/flags.sh; declare
  every config key in interface+DEFAULTS (+numericKeys for numbers) or it's fake.
- Commit via git_safe_commit.py with [ISSUE-ID], push via git_safe_push.py.
- Never enable Marketplace creator payouts (legal blocker) — pricing may ship
  dark, payouts may not.
- All prices identical PSTN vs in-app. Hard caps (3/10/30) enforced in code.
- Gemini: thinking disabled; add per-turn context compression (backend-only
  optimization; user price stays flat).
