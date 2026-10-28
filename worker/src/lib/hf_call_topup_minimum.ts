// Minimum wallet credit for five more minutes of an active caller-owned call.
import type { Env } from "../types";
import { chargePaise, validTariff, type Tariff } from "./hf_token_math";
import { validCreatorSnapshot } from "./hf_creator_pricing";

type Call = { caller_uid: string; status: string; connected_at: number | null; rate_paise: number; pricing_snapshot: string | null };
export function callTopupMinimum(c: Call): number | null {
  if (c.status !== "connected" || c.connected_at == null) return null;
  const connectedAt = Number(c.connected_at);
  if (!Number.isSafeInteger(connectedAt) || connectedAt <= 0 || connectedAt > Date.now()) return null;
  let price: number | Tariff = Number(c.rate_paise);
  if (c.pricing_snapshot) {
    try {
      const s = JSON.parse(c.pricing_snapshot);
      if (s?.plan === "std") { if (!validTariff(s.tariff)) return null; price = s.tariff; }
      else if (validCreatorSnapshot(s)) price = Number(s.ratePaise);
      else if (s && typeof s === "object" && !s.plan && Number.isSafeInteger(s.ratePaise) && s.ratePaise > 0 && s.ratePaise === Number(c.rate_paise)) price = s.ratePaise;
      else return null;
    } catch { return null; }
  }
  if (typeof price === "number" && (!Number.isSafeInteger(price) || price <= 0)) return null;
  // The next reservation begins at the funded boundary, not the elapsed time.
  // Use the highest frozen tier so this remains safe without relying on a moving boundary.
  const rate = typeof price === "number" ? price : Math.max(...price.tiers.map((tier) => tier.paisePerMin));
  const amount = chargePaise(rate, 300);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
export async function activeCallTopupMinimum(env: Env, uid: string, callId: unknown): Promise<{ minimum: number } | { status: number; error: string; message: string }> {
  if (typeof callId !== "string" || !callId || callId.length > 100) return { status: 400, error: "invalid_call", message: "Call not found." };
  const c = await env.DB_META.prepare("SELECT caller_uid, status, connected_at, rate_paise, pricing_snapshot FROM hf_calls WHERE id=?1").bind(callId).first<Call>();
  if (!c || c.caller_uid !== uid) return { status: 404, error: "not_found", message: "Call not found." };
  if (c.status !== "connected" || c.connected_at == null) return { status: 409, error: "call_not_active", message: "This call is no longer active." };
  const minimum = callTopupMinimum(c);
  if (minimum == null) return { status: 409, error: "call_pricing_unavailable", message: "Call pricing is unavailable." };
  try {
    const stub = env.HF_CALL.get(env.HF_CALL.idFromName(callId));
    const response = await stub.fetch("https://hfcall/info", { method: "POST", body: "{}" });
    if (!response.ok) throw new Error("call info unavailable");
    const info = await response.json() as { fundedSec?: unknown; maxSeconds?: unknown; hardEndsAt?: unknown };
    if (!Number.isSafeInteger(info.fundedSec) || Number(info.fundedSec) < 0 ||
        !Number.isSafeInteger(info.maxSeconds) || Number(info.maxSeconds) <= 0) throw new Error("not chunk billed");
    const nextEnd = Number(info.fundedSec) + 300;
    if (nextEnd > Number(info.maxSeconds)) throw new Error("call cap reached");
    if (info.hardEndsAt != null && (!Number.isSafeInteger(info.hardEndsAt) ||
        Number(c.connected_at) + nextEnd * 1000 > Number(info.hardEndsAt) || Date.now() >= Number(info.hardEndsAt))) {
      throw new Error("booking deadline reached");
    }
  } catch { return { status: 409, error: "call_topup_unavailable", message: "Adding time to this call is unavailable." }; }
  return { minimum };
}
