// [AUMFE-GUIDE-BRAIN-1 2026-10-01] The one-line chart summary the Pandit ji screen shows beside the chat.
// Built by running the SAME tools the guides use (get_my_chart, get_current_dasha, check_doshas), so it is cached
// AstrologyAPI data and can never disagree with what the guide says. null = no profile, or no AstrologyAPI key / no reading.
import type { Env } from "../../types";
import { getMyChart, getCurrentDasha, checkDoshas } from "./astro_tools";
import type { VoiceToolCtx } from "../voice_agents/types";

export interface ChartSummary { lagna: string; moon_sign: string; nakshatra: string; dasha: string; doshas: string[] }

const DOSHA_LABEL: Record<string, string> = { manglik: "Manglik", kalsarpa: "Kalsarpa", sadhesati: "Sade Sati", pitra: "Pitra" };

const isErr = (x: unknown): boolean => !x || typeof x !== "object" || "error" in (x as Record<string, unknown>);

/** Tool outputs -> summary. Pure; exported for tests. Returns null when the chart itself could not be read. */
export function chartFromToolOutputs(chart: any, dasha: any, doshas: any): ChartSummary | null {
  if (isErr(chart)) return null;
  const d = isErr(dasha) ? null : dasha;
  const present: string[] = [];
  if (!isErr(doshas)) {
    for (const k of Object.keys(DOSHA_LABEL)) {
      const v = doshas[k];
      if (v && (v.present === true || v.running === true)) present.push(DOSHA_LABEL[k]);
    }
  }
  return {
    lagna: String(chart.lagna ?? ""),
    moon_sign: String(chart.rashi ?? ""),
    nakshatra: String(chart.nakshatra ?? ""),
    dasha: d ? [d.mahadasha, d.antardasha].filter(Boolean).join(" / ") : "",
    doshas: present,
  };
}

export async function loadChartSummary(env: Env, uid: string): Promise<ChartSummary | null> {
  const ctx: VoiceToolCtx = { env, uid, sessionId: "state", agentId: "pandit" }; // no showCard: this is a read, not a chat turn
  const chart = await getMyChart.run(ctx, {});
  if (isErr(chart)) return null; // no_birth_details / astro_unavailable -> no chart card
  const [dasha, doshas] = await Promise.all([getCurrentDasha.run(ctx, {}), checkDoshas.run(ctx, { which: "all" })]);
  return chartFromToolOutputs(chart, dasha, doshas);
}
