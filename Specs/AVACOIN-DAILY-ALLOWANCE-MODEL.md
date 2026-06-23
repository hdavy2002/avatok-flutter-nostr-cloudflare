# AvaCoin Daily-Allowance Model — abuse cap for the BETA-FREE era

**Date:** 2026-06-21 · **Status:** proposal for owner decision · Companion file: `AvaCoin-Daily-Allowance-Model.xlsx` (editable cost model)

## TL;DR

Give every user a **daily free allowance of 1,000 AvaCoins** that unlocks all premium services. Spend it down and you fall back to **basic** (free Gemma chat only, lightly capped) until the 00:00 UTC reset. This is a clean abuse cap **for the cheap features** — but a pooled coin cap alone is not enough, because two features (**live translation** and **vision snapshots**) are cheap in coins yet expensive to us, so a single abuser could turn "free" coins into **~$5–6.60/day** of our cost. The fix is a small set of **per-feature daily sub-caps** on the real-time AI. With those in place the realistic cost is **~$0.16–0.32 per active user/day (~$5–10/month)**, and 1,000 users is comfortably affordable (~$1,900–3,800/month).

## 1. First fix the coin rate (it is inconsistent in the code today)

The codebase disagrees with itself on what a coin is worth:

| Source | Rate | 1 coin = |
|---|---|---|
| `wallet.ts` (`COINS_PER_USD = 100`), top-up, payout, marketplace, app UI, `AvaVision/PRICING.md` | 100 coins / USD | **$0.01** |
| `feature_pricing.ts` header + `referral.ts` | 1,000 coins / USD | $0.001 |

The **wallet path is canonical and live** — top-ups credit coins at 100/USD, AvaVoice's `CREATOR_PAYS_RATE_PER_HOUR = 500` is explicitly "$5/hr ⇒ 1 coin = $0.01", and translation bills "5 coins/min = $3/hour (1 coin = $0.01)". The `feature_pricing.ts` "1,000/USD" comment is a documentation bug.

**Decision: standardise on 1 coin = $0.01 (100 coins = $1).** That makes 1,000 coins/day a tidy **$10/day face value**, and the AI feature coin amounts already deduct correctly — only the stale comment needs fixing.

## 2. What each feature actually costs us

All figures are cost-to-us per action. AI-voice/vision rates are the **verified June-2026 Gemini rates** from `Specs/avavision-build/PRICING.md`; Composio and LiveKit are current published prices.

| Feature | Engine | Our cost / action | Coin price | Margin |
|---|---|---|---|---|
| Text chat | Gemma 4 (Workers AI) | ~$0.0005 | 2 | 40× |
| Image — free | Flux-1-schnell (Workers AI) | ~$0.0006 | 5 | 83× |
| Image — paid | Nano Banana 2 | $0.04–0.067 | 80 | 15× |
| Voice reply | on-device TTS (Supertonic) | ~$0 | 20 | 200× |
| Composio / MCP tool call | Composio ($0.0003/call) | ~$0.0003 | 10 | 400× |
| GenUI render | Gemini Flash | $0.001–0.005 | 10 | 33× |
| **Vision snapshot** | Gemini 3 Flash | **$0.014–0.05** | 10 | **3.1×** |
| **AI voice call** | Gemini 3.1 Flash Live | **$0.013–0.022/min** (~$1/hr) | 17/min | 9.7× |
| **Receptionist (2-min)** | Gemini 3.1 Flash Live | **$0.035–0.05/call** | 35 | 8.2× |
| **Live translation** | Gemini 3.5 Live Translate | **$0.017–0.033/min** ($1–2/hr) | 5/min | **2.0×** |
| Group conference | LiveKit ($0.0005/part-min) | ~$0.0005/part-min | 1 | 20× |
| 1:1 P2P call | Cloudflare TURN | ~$0 | free | — |
| Messaging | InboxDO + R2 | ~$0/msg | free | — |

The "Messenger" core — messaging, 1:1 calls, group conferences — is **effectively free to run** (Durable Objects, R2, P2P WebRTC, and LiveKit at $0.0005/participant-minute). Your real spend is **AI**, and within AI it is concentrated in **real-time audio** (translation, voice agents, receptionist) where Gemini Live output audio at $12/M tokens dominates.

## 3. What 1,000 coins/day buys — and where the danger is

If a user spent the **entire** 1,000-coin daily allowance on one feature:

| All 1,000 coins on… | You get | Costs us (worst) |
|---|---|---|
| Text chat | 500 messages | $0.25 |
| Composio tools | 100 calls | $0.03 |
| Paid images | 12 images | $0.84 |
| **Vision snapshots** | 100 snapshots | **$5.00** |
| **Live translation** | 200 minutes (3.3 hrs) | **$6.60** |

Chat, tools, images, voice replies, conferences — a user can max them all day and cost us **under $1**. But **translation and vision snapshots are priced near our cost** (2–3× margin), so 1,000 "free" coins there = **$5–6.60/day = up to $198/month for one abuser.** That is the hole a pooled cap alone leaves open.

## 4. Recommended design: pooled cap **+** sub-caps + basic fallback

**a) Pooled daily allowance — 1,000 coins/day.** Funds all platform AI. Reset 00:00 UTC, no rollover. Exhausted → **basic mode**: free Gemma chat only (keep today's light per-day message cap), no AI tools, until reset. Messaging and 1:1/group calls stay free always (they aren't AI).

**b) Per-feature daily sub-caps** (apply *regardless* of remaining coins — they bound the real-money features):

| Feature | Free sub-cap / user / day | Rationale |
|---|---|---|
| Live translation | **30 min** | caps it at ~$1/day even maxed |
| AI voice call (non-marketplace) | **15 min** | ~$0.33/day |
| Receptionist answered calls | **10 calls** | ~$0.50/day |
| Vision snapshots | **10** | ~$0.50/day |
| Paid image gen | **10** | ~$0.84/day |

Past a sub-cap the feature stops for the day (or, later, can require a top-up) — the cheap features keep running on the pooled balance. Combined worst-case abuser ≈ **$2–3/day** instead of $6.60+, while a normal user never notices the caps.

**c) Marketplace stays outside the free pool.** AvaVoice and AvaVision *creator* sessions are paid escrow that pays creators — never fund them from the free allowance. Only the platform's own AI (chat, image, translation, receptionist, vision snapshots, tools, GenUI) draws on the 1,000 coins.

**d) 500 vs 1,000.** 500/day is plenty for a heavy normal user (250 chats, or 100 min translation) and halves worst-case exposure. **Recommend launching at 1,000** for generous beta optics, with the sub-caps doing the real protection — the pooled number is a soft signal, the sub-caps are the hard guardrail. Both are config values, tunable without a release.

## 5. Affordability at 1,000 users

Assuming a realistic active-user basket (40 chats, 1 paid image, 1 snapshot, 5 tool calls, 3 GenUI renders, 3 min translation, 2 min voice, 10 voice replies = **499 coins/day**) and 40% DAU:

| Scenario | Cost/day | Cost/month |
|---|---|---|
| Realistic (400 DAU) | $62–127 | **$1,860–3,800** |
| Worst case (every DAU maxes translation, **no sub-caps**) | $2,640 | $79,200 |
| Worst case **with the sub-caps in §4** | ~$800–1,000 | ~$24,000 |

The realistic line is very affordable. The sub-caps exist to make the worst case survivable rather than catastrophic — without them, ~400 abusers on translation alone would cost ~$79k/month.

## 6. Build checklist (small)

1. Fix the `feature_pricing.ts` rate comment → 1 coin = $0.01; add coin prices for receptionist + per-minute voice if metered.
2. Add the **1,000-coin daily grant** to the wallet DO for all users (replaces the old 250 free grant), reset 00:00 UTC, no rollover; spend draws from it.
3. On exhaustion return the existing `basic`/`daily_cap` fallback (already wired in `ai_gate.ts`).
4. Add per-feature **daily sub-cap counters** (D1 columns, same pattern as AvaVision's `snapshot_calls`) for translation minutes, voice minutes, receptionist calls, snapshots, paid images.
5. Expose all caps in `platform_config` KV so they're tunable without a release.

---
*Sources: repo `feature_pricing.ts`, `wallet.ts`, `translate.ts`, `avavoice.ts`, `receptionist.ts`, `Specs/avavision-build/PRICING.md`, `Specs/AVA-AI-COIN-PRICING-PROPOSAL.md`; Composio pricing (composio.dev/pricing, $0.249–0.299/1k calls); LiveKit Cloud pricing (livekit.com/pricing, $0.0004–0.0005/participant-min).*
