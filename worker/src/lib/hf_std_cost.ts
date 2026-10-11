// [HF-STD-PLAN-1] Actual Vobiz phone cost of one call = the sum of its legs in the HF-PAY-18 ledger (hf_vobiz_legs.total_cost_paise).
// Read-only on the ledger; the only write is the convenience column hf_calls.phone_cost_actual_paise. Never throws (best effort).
// "Known" means: at least 2 legs (host + caller) are on record for the call and every one of them carries a cost. Anything less is null,
// because a partial sum would understate the cost and make the platform estimate look better than it is.
import type { Env } from "../types";

export const MIN_LEGS_FOR_ACTUAL = 2;

/** Pure: legs in, actual cost (paise) or null when it is not fully known yet. */
export function sumActualLegCost(legs: Array<{ total_cost_paise: number | null }>): number | null {
  if (legs.length < MIN_LEGS_FOR_ACTUAL) return null;
  let t = 0;
  for (const l of legs) {
    if (l.total_cost_paise === null || l.total_cost_paise === undefined || !Number.isFinite(Number(l.total_cost_paise))) return null;
    t += Math.max(0, Math.trunc(Number(l.total_cost_paise)));
  }
  return t;
}

export async function actualPhoneCostPaise(env: Env, callId: string): Promise<number | null> {
  try {
    const rs = await env.DB_META.prepare("SELECT total_cost_paise FROM hf_vobiz_legs WHERE call_id=?1").bind(callId).all<{ total_cost_paise: number | null }>();
    return sumActualLegCost(rs.results ?? []);
  } catch { return null; }
}

/** Best effort: copy the legs' summed cost onto the call row. Returns the stored value, or null when not (yet) known. Never throws. */
export async function refreshActualPhoneCost(env: Env, callId: string | null | undefined): Promise<number | null> {
  if (!callId) return null;
  try {
    const v = await actualPhoneCostPaise(env, callId);
    if (v === null) return null;
    await env.DB_META.prepare("UPDATE hf_calls SET phone_cost_actual_paise=?2 WHERE id=?1").bind(callId, v).run();
    return v;
  } catch { return null; }
}

/** Same, starting from a leg uuid (the CDR path only knows the leg). Never throws. */
export async function refreshActualPhoneCostForLeg(env: Env, legUuid: string): Promise<void> {
  try {
    const r = await env.DB_META.prepare("SELECT call_id FROM hf_vobiz_legs WHERE leg_uuid=?1").bind(legUuid).first<{ call_id: string | null }>();
    await refreshActualPhoneCost(env, r?.call_id ?? null);
  } catch { /* convenience column only */ }
}
