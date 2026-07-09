# Phase C/D — SERVER SIDE (shadow mode) — Agent ODL, 2026-07-09

Implements plan §8/§9/§10/§12 (D23–D31) of `Specs/AVA-COPILOT-FINAL-PLAN-2026-07-08.md`.
Everything ships DARK: `odlEnabled` defaults OFF, all 8 capabilities are lifecycle
`shadow`, and the ODL path contains **zero AI calls** (regex + templates + KV only —
the reasoner stays reachable only via `avaReason()` in later phases, per
`Specs/AVA-ENGINEERING-LAW.md`). Deploying this changes NOTHING user-visible.

## What exists (all NEW files unless noted)

| File | What it is |
|---|---|
| `worker/src/lib/ava_triggers.ts` | THE one trigger/regex bank (D23/D31). `TRIGGER_BANK_VERSION=1`, `TRIGGER_BANK` as serializable data (regex sources as strings), pure `matchTriggers(text)`. 9 categories: otp, money, date_meeting, birthday, festival, life_event, commerce, travel, contact_marker. |
| `worker/src/lib/ava_capabilities.ts` | Capability Registry (D24/D25/D27). In-code seed of the 8 v1 capabilities (`meeting, expense_split, birthday, otp_guard, order_tracking, travel_plan, celebration, reminder`), each `{id, owner:"davy", role:"copilot", lifecycle:"shadow", cost_class, min_opportunity, daily_limit, kill_switch}`. KV blob `cap_registry` = overrides ONLY, layered over the seed (never re-materialized). `CATEGORY_TO_CAPABILITY` maps trigger categories → capabilities. |
| `worker/src/lib/ava_opportunity.ts` | Deterministic Opportunity Score 0–100 (`opportunityScore`). Category base + corroboration + question mark + first person + length band + recency − group penalty. NO AI, no I/O. |
| `worker/src/lib/ava_templates.ts` | Reply Template Bank v1: 8 capabilities × 3 langs (en/hi/hinglish) × 2 registers (casual/formal) = 48 templates with `{slot}` placeholders. `pickTemplate`, `fillTemplate`, `hasTemplate`, `guessLang`. |
| `worker/src/lib/ava_budget.ts` | Budget Manager + trust ledger + learning-loop counters, all KV (env.TOKENS). `checkAndSpend`, `spendMoment`, `getTrust`/`isMuted`, `recordOutcome`, `ledgerSnapshot`. |
| `worker/src/lib/ava_governor.ts` | Global AI Governor as KV policy (no DO yet). Key `ava_governor` (overrides over defaults): `{min_opportunity_floor, generation_off, wake_only, paused}`. `governorGate(env, cap, opportunity)`, `setGovernorPolicy`. Guardian is NEVER gated here (Constitution 12). |
| `worker/src/lib/ava_odl.ts` | The ODL orchestrator. `odlProcess(env, {uid, conv, text, senderUid, isGroup})`: per-chat toggle → matchTriggers → score → registry → kill switch → trust mute → budget → governor → min_opportunity → moments budget → shadow telemetry. Whole function try/catch fail-silent. Production branch exists but only returns a filled template (no posting wired — deliberate). |
| `worker/src/routes/ava_odl_routes.ts` | `GET /api/ava/triggers` (D31 device sync, ETag on version), `GET /api/ava/ledger` (D25 snapshot), `POST /api/ava/moment-outcome` (learning loop). All requireUser. |
| `worker/src/routes/ava_guardian.ts` (EDITED — one additive block + one import) | Inside `guardianScan`, after the `guardian_scan` telemetry: if `readConfig(env).odlEnabled === true`, a detached `void odlProcess(...)` per recipient. Default OFF → no-op. Nothing else changed. |
| `Specs/reports/PHASE-CD-WIRING.md` | The exact index.ts + config.ts lines for the orchestrator (files not owned by this agent). |

## PostHog events (app_name `ava_odl`) — the shadow-mode deliverable

| Event | When | Key props |
|---|---|---|
| `ava_odl_wake` | every trigger-bank match (per recipient) | capability, lifecycle, trigger_category, trigger_patterns, categories, opportunity, lang_guess, bank_version, is_group, msg_len |
| `ava_odl_sleep` | no-match messages, sampled **1:100** | msg_len, sampled:100, bank_version |
| `ava_moment_shadow` | every woke non-production capability | capability, opportunity, min_opportunity, trigger_category, **would_fire**, gate_reason, template_available, lang_guess, cost_class, user_evals_today |
| `ava_moment_outcome` | POST /api/ava/moment-outcome | capability, conv, outcome, trust_score, muted (stamped with user email via trackUser) |
| `ava_moment_candidate` | production lifecycle only (none in v1) | capability, opportunity, template_used |

`gate_reason` values: `kill_switch`, `trust_muted`, `user_daily_budget`,
`capability_daily_limit`, `governor_paused`, `governor_wake_only`,
`governor_floor`, `below_min_opportunity`, `moments_budget`.

Acceptance projection (D27): `would_fire` rate per capability from
`ava_moment_shadow`, joined with real `ava_moment_outcome` data once beta starts.

## KV keys (all on env.TOKENS)

| Key | Meaning | TTL |
|---|---|---|
| `cap_registry` | capability overrides only (JSON `{capId: {patch}}`) | none |
| `ava_governor` | governor policy overrides | none |
| `avatoggle:<uid>:<conv>` | per-chat Ava toggle mirror — `"0"` = OFF (D29) | set by toggle owner |
| `avabudget:<uid>:<ymd>` | per-user daily eval count (limit 500) | 2 d |
| `avamoments:<uid>:<ymd>` | account-wide unsolicited-Moments count (limit 500/day, Constitution 2) | 2 d |
| `avacap:<capId>:<ymd>` | per-capability daily evals (circuit breaker vs `daily_limit`) | 2 d |
| `avacapwf:<capId>:<ymd>` | per-capability daily would_fire | 2 d |
| `avacapout:<capId>:<outcome>:<ymd>` | learning-loop outcome counters | 2 d |
| `avatrust:<uid>:<conv>` | trust ledger `{score, muted_until, updated_at}` (+1 accepted/edited, −1 dismissed, 30-day mute at ≤ −3) | 90 d, refreshed |

Flag blob (`platform_config`, via scripts/flags.sh): `odlEnabled` (master, default
OFF), `avaMomentsEnabled` (reserved posting master, default OFF), plus the 8
per-capability `avaCap*Enabled` kill switches (absent = on, explicit false = off).

## How to turn the shadow scan ON (staging first, always)

```bash
scripts/flags.sh set odlEnabled=true     # obeys .avatok-target; prod needs ALLOW_PROD=1
```

## How to promote a capability shadow → production

1. **Read the ledger**: `GET /api/ava/ledger` + the PostHog `ava_moment_shadow`
   dashboards. Gate on D25 numbers (projected acceptance ≥ the Constitution-13
   floor of 2–5%, cost within budget).
2. **Registry flip (KV override, no deploy)** — one step per lifecycle stage,
   never straight to production (D27):
   ```js
   // via a small admin script or wrangler kv THROUGH scripts/cf.sh, key cap_registry:
   { "meeting": { "lifecycle": "beta" } }        // then later: "production"
   ```
   (Programmatically: `setCapabilityOverride(env, "meeting", { lifecycle: "beta" })`.)
3. **Posting gate**: user-visible Moments additionally require the future posting
   path to be wired in `ava_odl.ts` step 6 (postAvaMessage private lane) AND
   `avaMomentsEnabled=true`. Until both, even "production" emits telemetry only.
4. **Kill switch stays live**: `scripts/flags.sh set avaCapMeetingEnabled=false`
   silences one capability instantly; `odlEnabled=false` kills the whole layer;
   `ava_governor` `{"paused":true}` is the load-shedding stop.

## Invariants honored

- Zero AI calls in the whole ODL path (Engineering Law §Sacred Rule).
- Fail-silent everywhere; Guardian floor and message delivery untouched.
- Guardian is exempt from Governor and budgets (Constitution 12).
- Overrides-only KV blobs (registry, governor) — never re-materialized.
- All new flags/lifecycles default OFF/shadow — deploy is user-invisible.
