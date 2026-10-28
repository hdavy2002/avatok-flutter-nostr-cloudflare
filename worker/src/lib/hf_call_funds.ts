// [HF-CALL-MODES-C] A top-up landed while the person may be on a call: tell their live call so it can reserve the next chunk now and keep going
// (spec 2.3 "top-up while talking"). Called right after a wallet credit (hf_topup settle, Play verify). Best effort and idempotent: the DO's /funds
// only acts for a connected call in chunk-billing mode, and a missed poke is healed by the call's own 30 s funds retry. NEVER throws, never blocks a credit.
import type { Env } from "../types";
import type { HfCallFundsRequest } from "./hf_call_contracts";

export async function pokeLiveCall(env: Env, uid: string): Promise<boolean> {
  try {
    if (!uid) return false;
    const row = await env.DB_META.prepare("SELECT id FROM hf_calls WHERE caller_uid=?1 AND status='connected' ORDER BY created_at DESC LIMIT 1").bind(uid).first<{ id: string }>();
    if (!row?.id) return false;
    const body: HfCallFundsRequest = { uid, reason: "topup" };
    const r = await env.HF_CALL.get(env.HF_CALL.idFromName(row.id)).fetch("https://hfcall/funds", { method: "POST", body: JSON.stringify(body) });
    return r.ok;
  } catch {
    return false;
  }
}
