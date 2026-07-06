# Guardian Sentinel — PostHog Telemetry Spec v1.0 (2026-07-06)

Companion to `GUARDIAN-SENTINEL-FINAL-PLAN-2026-07-06.md` (phase O1, but events are emitted from G3/S1 onward). Finalized after design review with ChatGPT (converged in one round). Goals: fast debugging, detection-quality analytics, cost control, and a geographic map of spam/scam origination.

---

## 0. Three streams — never mixed (governing rule)

1. **Operational telemetry** (PostHog, short retention): latency, failures, timeouts, replay mismatches, rehydrations, budget breaches. Engineering eyes only.
2. **Behavioural analytics** (PostHog, standard retention): warnings, user actions, verification funnels, bucket bands, geo/ASN, rule hits. Product tuning + threshold calibration.
3. **Canonical audit** (NOT PostHog — D1/event store): append-only EvidenceAdded, ruleset/policy versions, verification history. The source of truth. PostHog is an observability tool, never a second owner of truth (constitution law 1).

## 1. PII policy (CHANGE from today's behaviour)

Today `guardian_scan`/`guardian_flag` stamp **sender_email + raw IP on every event, including clean scans**. New policy — data minimization for the EU PostHog instance:

| | Clean events | Flagged events |
|---|---|---|
| Identity | immutable `uid` only | `uid` (+ PostHog person mapping so email lookup still works — satisfies the project rule that telemetry is retrievable by user email, without stamping raw email as an event property) |
| Geo | `country`, `colo`, `hour_utc` | `country`, `region`, `city`, `colo` |
| Network | — | `asn`, `as_org`, `ip_hash` (or /24 prefix), `is_proxy`, `is_vpn`, `is_tor`, `is_datacenter`, `conn_type` (residential/mobile/datacenter) |
| Raw IP | **never in PostHog** | **never in PostHog** — raw IP lives only in operational Worker logs with short retention |
| Raw email | never as event property | never as event property |

Network facts are stored raw (is_vpn, ASN, hosting provider) — never a computed "badness score"; reputation changes, facts don't.

## 2. Event catalog

### 2.1 Existing events — retained, properties trimmed per §1

`guardian_scan` · `safety_scan` / `safety_scan_error` · `guardian_flag` · `guardian_warning_sent` · `guardian_sender_blocked` · `guardian_shield_toggled` · `guardian_adult_optout_set`.

### 2.2 New — Guardian detection (G3)

- `guardian_inline_scan` — lane (fast|deep), verdict, ms, timed_out, budget_exceeded, model, ruleset_version
- `guardian_inline_latency_budget_breach` — ms, budget_ms, lane
- `guardian_rule_hit` — rule_id, ruleset_version, category (which deterministic rules actually fire, pre-classifier)
- `guardian_rule_suppressed` — rule fired but confidence below warning threshold (threshold tuning gold)
- `guardian_budget_fallback` — cheap model used because latency/cost budget blocked escalation (detection quality vs budget)
- `guardian_false_positive_dismissed` — user tapped "This is fine" (primary FP signal)
- `guardian_warning_actioned` — action: block|report|dismiss|ignored (+ minutes_since_warning)
- `guardian_false_negative` — emitted when a report is UPHELD and no Guardian warning existed for that conv/sender (the most valuable long-term metric; without it we only ever optimize FP rate)

### 2.3 New — outcome ground truth (start day one; required to tune v2 auto-escalation)

- `guardian_outcome` — outcome: none|user_blocked|user_reported|report_upheld|report_rejected|verification_passed|verification_failed|account_banned|appeal_upheld|appeal_rejected; plus **time-to-outcome**: minutes_to_block / minutes_to_report / minutes_to_verify / minutes_to_ban
- `sentinel_trigger_simulated` — would_have_triggered_level2 / would_have_triggered_level3 under candidate thresholds (dark-mode simulation: compare would-trigger vs actual outcome with zero user impact)
- Bucket **distributions**, not just crossings: every `sentinel_evidence_added` carries bucket_value_before / bucket_value_after (band) so "what score do real scammers sit at?" is answerable without replay

### 2.4 New — Sentinel core (S1)

- `sentinel_event_ingested` — source, type, lag_ms
- `sentinel_evidence_added` — bucket, delta, rule_id, ruleset_version, value_before/after band
- `sentinel_bucket_crossed` — bucket, band_from, band_to
- `sentinel_do_rehydrated` — reason
- `sentinel_replay_mismatch` — **CRITICAL**: fold(evidence) ≠ cached score → the constitution is broken somewhere

### 2.5 New — mem0 (S2)

`mem0_write` · `mem0_write_failed` · `mem0_purge_retry` (backlog depth)

### 2.6 New — verification funnel (T1/U1)

- `verify_human_requested` — trigger: manual_t4|policy|marketplace
- `verify_human_passed` / `verify_human_declined` / `verify_human_expired`
- `verify_human_skipped` — already-valid recent pass (UX optimization)
- `trust_evidence_emitted` — bucket, value, evidence_version, ruleset_version, policy_version

## 3. Geo spam-origination map

**Properties on flagged events:** country, region, city, continent, colo · asn, as_org, hosting_provider, is_proxy, is_vpn, is_tor, is_datacenter, conn_type · flag_category, bucket, warning_action, verification_result · account_age_band, first_seen_country · hour_utc, weekday.

**PostHog insights (EU cloud, project 139917):**

1. World heat map — flags by sender country (choropleth via country breakdown)
2. Time series — flags/day by country (top 10) with rolling 24h/7d
3. Breakdown — flags by ASN / AS org (catches datacenter-driven spam farms)
4. Trend alert — NEW ASN appearing in flags (hotspot detection)
5. Funnel — scan → flag → warning → action → block → verification
6. Retention — repeat-offender senders grouped by ASN
7. `first_seen_country` vs current country divergence (account-takeover / relocation signal)

## 4. Dashboards (create in PostHog, mirror the existing dashboard pattern)

- **(a) Detection quality:** flags by category/severity, FP-dismiss rate, warning action rate, precision proxy = actioned/(actioned+dismissed), false-negative count, rule-hit leaderboard, suppressed-rule counts
- **(b) Latency & cost:** inline p50/p95 ms by lane, timeout rate, classifier spend/day by model, spend per flag, budget-fallback rate
- **(c) Geo threat map:** the §3 insights
- **(d) Sync & infra health:** replay mismatches, DO rehydrations, ingestion lag_ms, mem0 failure rate + purge backlog
- **(e) Outcome funnel & v2 calibration:** guardian_outcome distribution, time-to-outcome percentiles, simulated-trigger vs outcome confusion matrix, bucket-band distributions for confirmed scammers vs clean users

## 5. Day-one threshold alerts (exactly five)

1. **`sentinel_replay_mismatch` > 0** — even one means derived state diverged from the event log. Page immediately.
2. **Inline timeout rate > 2% over 5 min** — Guardian slowing down affects every guarded chat.
3. **FP-dismiss rate +50% vs trailing 7-day baseline** — almost always a ruleset regression after a deploy.
4. **mem0 write-failure rate or purge-retry backlog above threshold** — product keeps working, but infra needs eyes.
5. **Daily classifier spend or cost-per-flag > 2× 7-day average** — LLM cost drift is silent otherwise.

## 6. Standard properties on every guardian/sentinel event

`ruleset_version`, `policy_version`, `app_version`, `platform`, `is_group`, `guardian_enabled`, `flag_states` (relevant kill-switch values at emit time — the 2026-07-04 KV lesson applies to diagnosing telemetry too).

## 7. Retention

Operational stream: 30–90 days. Behavioural analytics: standard project retention. Raw IP: Worker logs only, ≤30 days. Canonical audit: D1/R2 per Trust Engine manifest policy — not PostHog's job.
