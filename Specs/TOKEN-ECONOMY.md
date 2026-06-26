# Token Economy — canonical spec (replaces AvaCoins/coins)
**Status:** DECIDED 2026-06-26 · Owner: davy (hdavy2005)

The in-app currency is now **Tokens**. "AvaCoins" / "coins" are retired everywhere
(server, web, Flutter app, marketing). This is a **rename, not a rescale**.

## 1. Value

- **1 USD = 100 tokens** (1 token = $0.01 = 1 US cent). Unchanged numeric value —
  the previous unit was already 100 coins/USD, so **existing balances keep their
  exact number; only the label changes** (no migration of balances or prices).
- Example: a $10 plan grants **1,000 tokens** (10 × 100).

## 2. Subscription model

- Users belong to **one subscription class** (Free / Plus / Pro / Max …). Each class
  comes with a **monthly token allowance** ("buy X tokens").
- **Top-up on demand:** users can buy extra tokens any time (existing wallet top-up).
- **No carry-over:** unused tokens do **not** roll into the next month. The allowance
  **resets** at the monthly boundary to the class amount.
- **Exhaustion → upgrade:** if a user burns through the month's tokens early, they are
  prompted to **upgrade to the next class** (or top up). Hard stop on token-costed
  actions when the balance hits zero.

## 3. Free class

- **Unlimited basic**: human messaging (DMs, groups) and basic Ava chat stay free and
  unmetered.
- **Tokens for extras**: premium features (image/voice/vision generation, AI Search
  beyond the free cap, MCP tools, etc.) cost tokens. Free class gets a **small monthly
  token allowance** for extras (exact amount TBD — see §5).

## 4. Per-service costs (carried over from feature_pricing, now in tokens)

Same numeric values as the old coin prices (1 token = 1¢). Tune later.

| Action | Tokens | USD |
|---|---|---|
| Ava chat message | 1 | $0.01 |
| AI Search ingest / query (`ava_memory`) | 1 | $0.01 |
| Free-tier image | 1 | $0.01 |
| Premium image (Nano Banana 2) | 8 | $0.08 |
| Ava voice reply | 2 | $0.02 |
| Vision snapshot (beyond free) | 1 | $0.01 |
| Connected-app (MCP) tool call | 1 | $0.01 |
| Always-on guardian | 30 / mo | $0.30 |
| AvaStorage over-quota | 20 /GB/mo | $0.20 |

## 5. TBD (owner to define)

- **Monthly token allowance per class** (Free / Plus $10 / Pro $20 / Max $50).
  Guideline: paid class allowance ≈ priceUSD × 100 (e.g. Plus $10 → 1,000 tokens),
  but set deliberately against real cost data.
- Final per-service token costs (the table above is the current default).

## 6. Implementation notes

- **Wire & DB stability:** to protect live balances and the server↔client contract,
  internal JSON fields / D1 columns may keep their existing keys during the rename;
  the **user-facing term is always "Tokens"** and the canonical constant is
  `TOKENS_PER_USD = 100`. Any field/column rename that touches stored balances must be
  a guarded migration, never a blind rename.
- **Monthly reset / no carryover** is new mechanism on top of the existing wallet:
  a per-user monthly allowance grant + reset (cron or lazy-on-read), separate from
  on-demand top-up tokens.
