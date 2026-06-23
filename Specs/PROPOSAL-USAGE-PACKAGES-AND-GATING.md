# PROPOSAL — Usage Packages, Per-User Gating & Cost Telemetry

**Status:** Draft for review · **Date:** 2026-06-23 · **Owner decision pending on the tier numbers (proposed below).**

## 0. Decisions locked (this proposal builds on them)

- **Billing = monthly subscription tiers.** Free / $10 / $20 / $50. $50 = everything unlimited.
- **Allowances = daily caps that scale per tier.** Reset at UTC midnight. Reuses the existing daily-counter pattern.
- **Exhaustion = hard stop + upsell.** No pay-as-you-go overage. When a daily dimension is spent, the service returns a `plan_limit` response and the client shows "upgrade your plan".
- **Monitoring = PostHog** (out of the request path). **Enforcement = wallet/quota counters** (in the Worker, ~1–5 ms, strongly consistent). AI Gateway is *not* required for either.

Why this is low-latency / low-rewiring: every gate read is a Durable Object or KV lookup co-located in the Worker — no external proxy hop. The three enforcement choke points already exist; we generalize one counter and add one missing heartbeat.

## 1. Verified architecture facts

| Service | Backend | Who pays the cost | Gating today |
|---|---|---|---|
| Human text messaging (DMs, groups) | InboxDO + local | ~free (no AI) | none needed → **unlimited all tiers** |
| Ava AI text chat | Workers-AI Gemma / our key | tokens/turn | `dailyAvaTurnLimit` (KV counter) |
| Image generation | Flux-schnell (free) / Gemini "Nano Banana 2" (premium) | $0.005–$0.08/image | `feature_pricing` coins |
| AI voice agent calls (AvaVoice/AvaVision) | Gemini Live | per-minute | escrow + `/beat` coins |
| Live translation | Gemini 3.5 Live | per-minute | escrow + `/beat` coins |
| Ava Receptionist | Gemini Live (2-min cap) | per-session | premium-gated |
| **1:1 voice/video calls** | **CallRoom DO = signaling only; media is true P2P WebRTC** | **≈ $0 to us** | none → **unlimited all tiers** |
| **Group AV conference** | **LiveKit SFU** | **per participant-minute (real cost)** | `conferenceEnabled` + 25-cap; **no minute metering** |

Two facts that shape the design:

1. **P2P 1:1 calls cost us nothing** (media never touches our servers). Unlimited on every tier is correct and free. *Caveat:* no TURN/STUN relay is configured server-side, so strict-NAT calls may fail rather than fall back to a paid relay — zero cost, separate reliability item to revisit.
2. **Group conferences (LiveKit) are the one real, currently-unmetered media cost.** This is where capping group size and metering minutes matters most.

## 2. The tier matrix (proposed — tune against real PostHog cost data)

"Unlimited" = no daily counter. Numbers are **per UTC day**.

| Dimension | Free ($0) | Plus ($10/mo) | Pro ($20/mo) | Max ($50/mo) |
|---|---|---|---|---|
| Human text/voice-note messaging | Unlimited | Unlimited | Unlimited | Unlimited |
| 1:1 P2P voice & video calls | Unlimited | Unlimited | Unlimited | Unlimited |
| **Ava AI text chat** (turns/day) | 25 | 200 | 1,000 | Unlimited |
| **Image generation** (images/day) | 5 (free model) | 30 (premium model) | 100 | Unlimited |
| **AI voice-agent minutes/day** (AvaVoice/Vision) | 10 | 60 | 180 | Unlimited |
| **AI receptionist sessions/day** | 3 | 30 | 100 | Unlimited |
| **Live translation minutes/day** | 0 (locked) | 30 | 120 | Unlimited |
| Memory/RAG, file analysis, web search | Off | On | On | On |
| **Group conference — max participants** | **5** | 10 | 25 | 25 |
| Group conference minutes/day | 60 | 180 | 480 | Unlimited |

> **Decision needed — "text messaging unlimited":** I read this as *human* chat (free, no AI). **Ava AI text chat** (the chatbot) is treated as a capped AI dimension above, since each turn is a real model cost. If you instead want Ava AI chat unlimited on free too, say so — but that uncaps your single highest-volume AI cost. Recommend keeping it capped on Free.

**Margin guardrail (why daily caps are safe):** because every paid dimension is hard-capped per day, max monthly cost per user = Σ(daily cap × our unit cost × 30). Set each tier price above that number. Example — Plus ($10): 200 chats (~$0.40) + 30 premium images (~$2.40) + 60 voice-min (~$1.20) + 30 translate-min + 180 group-min ≈ well under $10 even at 100% utilization. The matrix above is intentionally conservative; widen it once PostHog shows real utilization is far below caps.

## 3. The gating layer (small diff, reuses what exists)

### 3.1 One generalized counter
Today `ai_quota.ts` keeps a single KV key `ava_turns:{uid}:{day}`. Generalize to **per-dimension** keys:

```
usage:{dim}:{uid}:{YYYY-MM-DD}     // TTL ~2 days, self-evicting
dim ∈ ava_chat | image | voice_min | recept | translate_min | conf_min
```

Same KV store (`env.TOKENS`), same check/increment functions, just parameterized by `dim`.

### 3.2 One gate function (new, ~30 lines in `ai_gate.ts`)

```ts
enforceAllowance(env, uid, tier, dim, units = 1): Promise<{
  allowed: boolean; reason?: "plan_limit"; remaining?: number; cap?: number; upsellTier?: string;
}>
```

Logic: look up `cap = PLANS[tier][dim]`. `cap === Infinity` → allow (Max tier / unlimited dims, no counter touched). Else `check` the daily counter; if exhausted → `{ allowed:false, reason:"plan_limit", upsellTier:next }`. Else `increment(units)` and allow. For per-minute services, `units` = minutes elapsed this beat.

### 3.3 Wire the choke points (most already exist)

| Path | File | Change |
|---|---|---|
| Ava AI text chat | `lib/ai_gate.ts` `enforceQuota` | call `enforceAllowance(uid,tier,"ava_chat")` (replaces the single-dim quota) |
| Image / receptionist | `feature_pricing.ts` callers | add `enforceAllowance(...,"image"/"recept")` before delivering; counter replaces coin spend as the gate |
| Voice agent / translation | existing `/beat` in `translate.ts`, `avavoice.ts`, `avavision.ts` | beat **decrements the daily minute counter** instead of (or alongside) coins; exhausted → end session with `plan_limit` |
| **Group conference** | `conference.ts` | **(a)** start/join: cap group size by `tier` (5/10/25/25) instead of fixed 25; set LiveKit `max_participants` accordingly. **(b)** add a **`POST /api/conference/:id/beat`** heartbeat — copy `translate.ts`'s beat — decrementing `conf_min`; on exhaust, the DO removes the participant / refuses re-join |

The conference `/beat` is the **only genuinely new endpoint**. Everything else is a one-line gate insertion.

### 3.4 Hard-stop response (uniform contract)
All gates return the same shape the clients already understand (mirrors today's `daily_cap` / 402):
```json
{ "ok": false, "blocked": true, "reason": "plan_limit",
  "dimension": "image", "cap": 5, "remaining": 0,
  "upsell": { "tier": "plus", "price_usd": 10 } }
```
Clients already render upsell/top-up popups — point them at this.

## 4. Billing & tier state

- **Tier on the user.** Replace the binary `premium:1` with `tier ∈ {0,1,2,3}` stored on the meta DB user row (and echoed in the wallet `balance` response so the whole client renders the right pill/badges). `premium = tier >= 1`.
- **Stripe subscriptions.** Add a subscription product per tier; a webhook (`checkout.session.completed` / `customer.subscription.updated|deleted`) writes `tier` and `renews_at`. Downgrade/cancel → `tier = 0` at period end. (Note: `walletRealMoney` is currently OFF pending legal — subscriptions are a separate money-in path that also needs that sign-off.)
- **`PLANS` config — server-owned.** Put the matrix in a `plan_config` KV blob (same pattern as `platform_config` / `feature_pricing.ts`): client may *read* it to display, never to enforce. Tunable without redeploy.
- **Fix the coin-unit bug first.** `feature_pricing.ts` declares 1 USD = 1000 coins; `translate.ts` / `avavoice.ts` use 100 coins/USD. Pick one (recommend **100 coins = $1**, matching the per-minute services and the user-facing "1 coin = 1¢") and migrate the other. Any cost/margin math is off by 10× until reconciled. *(Lower stakes now that AI gating uses daily counters not coins, but PostHog cost math and marketplace coins still need it consistent.)*
- **Kill switch.** Replace `betaFreePremium` with `billingEnabled`. While `false` → everyone is effectively Max/unlimited (today's beta behavior). Flip `true` to enforce tiers. One config flip, no redeploy.

## 5. PostHog telemetry (the monitoring half — richer)

PostHog stays **out of the request path** (async via `Q_ANALYTICS`). It is the source of truth for *what things cost us* and *where to set caps*, not for enforcement.

### 5.1 Enrich every consequential event with cost
Add to the props already emitted by `hooks.ts track()`:
`tier`, `dimension`, `units` (turns/images/minutes), `est_cost_usd` (our cost), `remaining`, `cap`.

### 5.2 New events to add
- `usage_consumed` — fired on every counter decrement `{dim, tier, used, cap, remaining, est_cost_usd}`. Single most important event — drives the per-user cost view.
- `plan_limit_hit` — `{dim, tier, upsell_tier}` → feeds the cap→upgrade funnel.
- `conference_minutes` — `{minutes, participants, est_cost_usd}` → the LiveKit cost AI Gateway can never see.
- `p2p_call` — `{kind: audio|video, duration_min}` → usage visibility even though cost ≈ 0.
- `plan_changed` — `{from, to, mrr_delta}`.

### 5.3 Dashboards (PostHog products to use)
- **AI Observability** — cost / tokens / latency per user, per model, per feature (your `est_cost_usd` + LLM traces).
- **Product Analytics + SQL editor** — *per-user total cost (AI + phone)* by summing `est_cost_usd` across `usage_consumed` + `conference_minutes`; *per-tier margin* = subscription revenue − Σ cost.
- **Funnels** — `plan_limit_hit` → `plan_changed` (cap-to-upgrade conversion; tells you if caps are too tight or too loose).
- **User activity / Cohorts** — flag users whose cost approaches their tier price (margin risk) for review.

Because the same call that decrements the counter also emits `usage_consumed`, the ledger (KV/DO) is truth and PostHog is the mirror — one write, two readers, no double accounting.

## 6. Build order (each step shippable, low blast radius)

1. **Reconcile the coin unit** (100 coins = $1) — prerequisite for all cost math.
2. **`PLANS` config blob** + add `tier` to the user/wallet response (default everyone tier-equivalent-Max while `billingEnabled=false`).
3. **Generalize `ai_quota.ts`** to per-dimension counters + add `enforceAllowance()`.
4. **Insert the gate** at the existing choke points (text, image, receptionist, voice/translate beats).
5. **Conference**: tier-based size cap + new `/beat` minute metering.
6. **PostHog**: enrich events + add the 5 new events + build the 4 dashboards.
7. **Stripe subscriptions** + webhook → `tier`.
8. **Flip `billingEnabled = true`** when the dashboards confirm caps beat costs.

## 7. Open items / for owner sign-off
- Confirm the **tier numbers** in §2 (or hand me utilization targets and I'll back-solve them).
- Confirm **Ava AI text chat is capped on Free** (§2 note).
- Subscriptions need the same **money-in legal sign-off** as `walletRealMoney`.
- TURN relay for P2P reliability — separate item (cost vs. connect-rate trade-off).
