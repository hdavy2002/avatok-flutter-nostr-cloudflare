// [VENICE-TIER-1] Per-account Venice "paid"/"free" tier resolution.
// Spec: Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md.
//
// REVISED SCOPE (owner, 2026-08-14): tier ONLY selects (a) the music model
// (minimax-music-v26, lib/venice.ts's ROUTES) and (b) the
// uncensored-TEXT chat lane ([VENICE-CHAT-1]). It NEVER unlocks NSFW media —
// there is no such lane; image/video stay SFW-only for everyone regardless
// of tier (see venice.ts's file header).
//
// tier === "paid" requires BOTH, checked cheaply and in this order (the
// D1 read is cheaper than the DO round-trip, so it short-circuits first):
//
//  (a) the account's 18+ uncensored opt-in — `users.venice_uncensored_optin`,
//      a lazily-added D1 column (ALTER TABLE + duplicate-column-catch, the
//      SAME pattern as routes/number.ts's ensureLastSeenCols/
//      [LASTSEEN-PRIVACY-1] — no deploy-time migration step needed). Default
//      absent/NULL = false, mirroring phone_discoverable/last_seen_visibility's
//      "column absent until first write" shape. A future Settings toggle sets
//      this the same way privacySet() (routes/number.ts) sets
//      phone_discoverable/who_can_add today: a small auth POST route
//      (e.g. POST /api/settings/venice-optin { venice_uncensored_optin:
//      boolean }) doing
//        `UPDATE users SET venice_uncensored_optin=?2, updated_at=?3 WHERE uid=?1`
//      after calling ensureOptinCol(). Not built here — no client toggle
//      exists yet — but the column/shape is ready for it.
//
//  (b) a positive PAID wallet balance — do/wallet.ts's WalletDO `balance` op
//      response field `balance` (NOT `free`, `bonus`, or `spendable` — those
//      mix in the 100-token welcome bonus and any earned/topped-up-then-spent
//      hold; `balance` alone is the DO's own PAID ledger, see wallet.ts's
//      `snap()`: `spendable: a.free + a.bonus + b.balance`). This reuses the
//      EXACT SAME cheap read lib/ai_billing.ts's currentDebtMicroUsd() already
//      performs (`walletOp(env, uid, { op: "balance", uid })`) — just a
//      different field off the same response body. No new wallet op is added.
//
// Cache: NONE. Per the work order this is a per-request-only check (no KV
// caching) — callers that need the tier more than once in a turn should
// resolve it once and pass the value along, not call this twice.
//
// Fail SAFE: any error (D1 read, wallet round-trip, malformed response)
// resolves to "free" — an outage here must never grant the uncensored lane.
import type { Env } from "../types";
import { metaSession, metaDb } from "../db/shard";
import { walletOp } from "../routes/wallet";
import type { VeniceTier } from "./venice";

// [LASTSEEN-PRIVACY-1]-style lazy column add — idempotent via the
// duplicate-column catch, so no deploy-time D1 migration is required.
let optinColEnsured = false;
async function ensureOptinCol(env: Env): Promise<void> {
  if (optinColEnsured) return;
  try {
    await metaDb(env).prepare("ALTER TABLE users ADD COLUMN venice_uncensored_optin INTEGER").run();
  } catch { /* already exists */ }
  optinColEnsured = true;
}

/** Best-effort read of this account's paid WalletDO balance. Never throws; 0 on any failure. */
async function paidBalance(env: Env, uid: string): Promise<number> {
  try {
    const r = await walletOp(env, uid, { op: "balance", uid });
    return Math.max(0, Number(r?.body?.balance ?? 0));
  } catch { return 0; }
}

/**
 * Resolve the Venice tier for this account, per-request (no caching).
 * "paid" only when the 18+ opt-in is set AND the paid wallet balance > 0;
 * "free" otherwise, including on any read failure.
 */
export async function veniceTier(env: Env, uid: string): Promise<VeniceTier> {
  try {
    await ensureOptinCol(env);
    const row = await metaSession(env).prepare(
      "SELECT venice_uncensored_optin FROM users WHERE uid=?1",
    ).bind(uid).first<{ venice_uncensored_optin: number | null }>();
    const optedIn = Number(row?.venice_uncensored_optin ?? 0) === 1;
    if (!optedIn) return "free";
    const balance = await paidBalance(env, uid);
    return balance > 0 ? "paid" : "free";
  } catch {
    return "free";
  }
}
