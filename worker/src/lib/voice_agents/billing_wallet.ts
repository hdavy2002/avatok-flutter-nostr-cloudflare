// [AUMFE-VOICE-BILLING-1 2026-10-02] Wallet I/O for paid voice calls. Pure maths: billing.ts.
//
// MONEY PLUMBING (same split as lib/voice_billing.ts / do/reception_room.ts):
//   - reserve / release_reservation = a RUNWAY HOLD only (allow_free:true, never moves money; expires on its own).
//   - chargeAmount = the REAL, permanent, ledgered, idempotent-by-op_id debit, one per started minute. We use it (not
//     consume_reserved) because it writes the double-entry platform:fees ledger row, honours team billing and carries
//     the statement metadata, and because consume_reserved CLAMPS to what is reserved (a short hold would silently
//     under-charge). forceMeter:true so betaFreePremium cannot make a voice call free.
import type { Env } from "../../types";
import { walletOp } from "../../routes/wallet";
import { chargeAmount } from "../../feature_pricing";
import { billingUidFor } from "../../team_billing";
import { opIdCharge, opIdRelease, opIdReserve, reservationRef } from "./billing";

export const VOICE_FEATURE_KEY = "voice_guide_minute";

/** The wallet that admits AND pays for the call (team wallet when on a team). Resolved once per call. */
export async function resolvePayer(env: Env, uid: string): Promise<string> {
  return billingUidFor(env, uid).catch(() => uid);
}

/** Spendable tokens (free + bonus + paid) of `payer`, or null when the wallet could not be read. */
export async function readSpendable(env: Env, payer: string): Promise<number | null> {
  try {
    const r = await walletOp(env, payer, { op: "balance", uid: payer });
    if (r.status !== 200) return null;
    const n = Number(r.body?.spendable);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
  } catch { return null; }
}

export type HoldResult = { ok: true; held: number } | { ok: false; reason: "insufficient" | "error" };

/** Add `amount` tokens to the call's runway hold (additive per ref). Idempotent by op id. */
export async function holdRunway(env: Env, payer: string, sessionId: string, amount: number, heldAfter: number, expiresAtMs: number): Promise<HoldResult> {
  if (amount <= 0) return { ok: true, held: heldAfter };
  try {
    const r = await walletOp(env, payer, {
      op: "reserve", uid: payer, amount, ref: reservationRef(sessionId), allow_free: true, expires_at: expiresAtMs,
      op_id: opIdReserve(sessionId, heldAfter === amount ? 0 : heldAfter), app_name: "voice_guide",
    });
    if (r.status === 200 && r.body?.ok === true) return { ok: true, held: heldAfter };
    if (r.status === 402) return { ok: false, reason: "insufficient" };
    return { ok: false, reason: "error" };
  } catch { return { ok: false, reason: "error" }; }
}

export type ChargeResult = { ok: true; charged: number } | { ok: false; reason: "insufficient" | "error" };

/** Charge one started minute. Permanent spend, idempotent by `voice:<sid>:m<N>`: a retry/duplicate never double-charges. */
export async function chargeMinute(env: Env, payer: string, sessionId: string, minute: number, tokens: number, agentName: string, ratePerMin: number): Promise<ChargeResult> {
  try {
    const r = await chargeAmount(env, payer, VOICE_FEATURE_KEY, tokens, opIdCharge(sessionId, minute), {
      forceMeter: true,
      meta: { category: "call", context: `Voice guide: ${agentName}`.slice(0, 120), durationSec: 60, ratePerMin },
    });
    if (r.ok) return { ok: true, charged: r.charged ?? tokens };
    return { ok: false, reason: r.reason === "insufficient" ? "insufficient" : "error" };
  } catch { return { ok: false, reason: "error" }; }
}

/** Release whatever is still held. Idempotent by `voice:<sid>:release`; safe when nothing was ever held. Returns tokens released. */
export async function releaseHold(env: Env, payer: string, sessionId: string): Promise<number> {
  try {
    const r = await walletOp(env, payer, { op: "release_reservation", uid: payer, ref: reservationRef(sessionId), op_id: opIdRelease(sessionId), app_name: "voice_guide" });
    return r.status === 200 ? Math.max(0, Math.trunc(Number(r.body?.refunded) || 0)) : 0;
  } catch { return 0; }
}
