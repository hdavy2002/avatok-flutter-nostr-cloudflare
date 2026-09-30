// [SAATHUM-PREETI-1 2026-09-30] Monthly AI spend cap. Provider cost is stored as micro-USD (it is genuinely
// USD); the rupee cap converts with cfg.usdInrRate. The month is the IST calendar month.
import type { Env } from "../../types";
import { readConfig } from "../../routes/config";
import { track, trackException } from "../../hooks";
import { sendWhatsAppText } from "../whatsapp_send";
import { currentBrand } from "./brand_runtime";
import { getAgentConfig, istMonth, monthCostMicroUsd } from "./store";

const APP = "saathum";

export interface BudgetState { over: boolean; pct: number; cost_rupees: number; cap_rupees: number }

async function rupeesFor(env: Env, micro: number): Promise<number> {
  const plat = await readConfig(env);
  return (micro / 1e6) * Number(plat.usdInrRate || 96.4);
}

/** Before every Gemini call. cap 0 means "no AI spend allowed" (treated as over). */
export async function budgetState(env: Env): Promise<BudgetState> {
  const [micro, cfg] = await Promise.all([monthCostMicroUsd(env), getAgentConfig(env)]);
  const cost = await rupeesFor(env, micro);
  const cap = cfg.monthly_cap_rupees;
  return { over: cost >= cap, pct: cap > 0 ? (cost / cap) * 100 : 100, cost_rupees: Math.round(cost * 100) / 100, cap_rupees: cap };
}

async function alertOps(env: Env, text: string, kind: string): Promise<void> {
  try {
    const cfg = await getAgentConfig(env);
    const r = await sendWhatsAppText(env, cfg.alert_whatsapp, text);
    await track(env, "system", "preeti_spend_alert", APP, { kind, sent: r.ok, reason: r.ok ? null : r.reason });
    if (!r.ok) await trackException(env, new Error(`preeti_alert_failed:${r.reason}`), { route: "preeti.spend.alert", handled: true, app_name: APP, extra: { kind } });
  } catch (e) {
    await trackException(env, e, { route: "preeti.spend.alert", handled: true, app_name: APP, extra: { kind } });
  }
}

/** Add a call's cost to the IST month, then fire the 80% / 100% alerts exactly once per month. */
export async function recordSpend(env: Env, microUsd: number): Promise<void> {
  const month = istMonth();
  const add = Math.max(0, Math.round(microUsd));
  try {
    await env.DB_META.prepare(
      `INSERT INTO ai_spend_months (month, cost_micro_usd) VALUES (?1,?2)
       ON CONFLICT(month) DO UPDATE SET cost_micro_usd = cost_micro_usd + ?2`,
    ).bind(month, add).run();
    await checkSpendAlerts(env);
  } catch (e) {
    await trackException(env, e, { route: "preeti.spend.record", handled: true, app_name: APP });
  }
}

export async function checkSpendAlerts(env: Env): Promise<void> {
  const month = istMonth();
  const st = await budgetState(env);
  if (st.cap_rupees <= 0) return;
  const brand = await currentBrand(env);
  const cap = st.cap_rupees;
  const claim = async (col: "alert80_at" | "alert100_at"): Promise<boolean> => {
    const r = await env.DB_META.prepare(`UPDATE ai_spend_months SET ${col}=?2 WHERE month=?1 AND ${col} IS NULL`).bind(month, Date.now()).run();
    return Number((r as any).meta?.changes ?? 0) > 0;
  };
  if (st.pct >= 100 && (await claim("alert100_at"))) {
    // 100% also satisfies 80% — do not send a second "about to cross" message afterwards.
    await claim("alert80_at");
    await alertOps(env, `🚨 ${brand.name} AI helper has reached the monthly limit of ₹${cap} (spent ₹${st.cost_rupees}). It now tells visitors to WhatsApp us instead. Please top up / raise the cap in Admin > AI assistant.`, "100");
  } else if (st.pct >= 80 && (await claim("alert80_at"))) {
    await alertOps(env, `⚠️ ${brand.name} AI helper: we're about to cross ₹${cap} this month (spent ₹${st.cost_rupees}, ${Math.round(st.pct)}%). Please top up.`, "80");
  }
}
