// [AUMFE-VOICE-PACKS-1 2026-10-02] Small helpers shared by the numerology, tarot and marriage tool packs.
// Packs read the CALLER's saved profile (never a uid or birth data from the model) and fail soft: a tool returns
// { error, hint } instead of throwing. The runtime (do/voice_session.ts) emits voice_tool_call {tool, ms, ok} for every call.
import { astroCall } from "../../astrology";
import type { AstroTtl } from "../../astrology";
import { sharedGuideTools } from "../../guides/brain";
import type { VoiceTool, VoiceToolCtx } from "../types";

export type Fail = { error: string; hint?: string };

export const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "OBJECT", properties, ...(required.length ? { required } : {}) });

/** Collapse whitespace, trim, cap length. null/undefined -> "". */
export const txt = (v: unknown, max = 200): string => (v == null ? "" : String(v).replace(/\s+/g, " ").trim().slice(0, max));

/** Clip to `max` characters, preferring a sentence boundary so the model never speaks half a sentence. */
export function clip(v: unknown, max = 400): string {
  const t = txt(v, 100000);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "") + "...";
}

/** First sentence of a text, capped (for the call-screen card). */
export function firstSentence(v: unknown, max = 90): string {
  const t = txt(v, 1000);
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return clip(m ? m[1] : t, max);
}

export const isFail = (x: unknown): x is Fail => !!x && typeof x === "object" && "error" in (x as object);

/** AstrologyAPI call through the shared client (cache by ttl, telemetry astro_api_call). */
export function api(ctx: VoiceToolCtx, path: string, body: Record<string, unknown>, ttl: AstroTtl) {
  return astroCall<any>(ctx.env, path, body, { ttl, uid: ctx.uid });
}

/** Typed failure for the model: never leaks vendor error text beyond a short code. */
export function failOf(r: { error: string }): Fail {
  if (r.error === "astro_not_configured") return { error: "astro_unavailable", hint: "tell the customer you could not read it right now" };
  if (/valid name/i.test(r.error)) return { error: "name_rejected", hint: "ask the customer to spell the name in English letters" };
  if (/valid date of birth/i.test(r.error)) return { error: "dob_rejected", hint: "ask the customer to confirm the date of birth" };
  return { error: "astro_unavailable", hint: "tell the customer you could not read it right now" };
}

export const NO_BIRTH: Fail = { error: "no_birth_details", hint: "ask the customer and call save_birth_details" };

/** YYYY-MM-DD -> parts, or null when not a real calendar date between 1900 and tomorrow. */
export function parseDob(v: unknown): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ""));
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  if (d.getTime() > Date.now() + 24 * 3600 * 1000) return null;
  return { year, month, day };
}

/**
 * The catalogue/knowledge tools of the shared brain (search_catalog, search_tradition, optionally recommend_for_chart),
 * picked by name so there is ONE definition of them. Called lazily (tests that mock modules rely on import-time laziness).
 */
export function brainTools(names: string[]): VoiceTool[] {
  const all = sharedGuideTools();
  return names.map((n) => all.find((t) => t.decl.name === n)).filter((t): t is VoiceTool => !!t);
}

/** Memoised lazy tool list for a pack. */
export function lazyTools(build: () => VoiceTool[]): () => VoiceTool[] {
  let cached: VoiceTool[] | null = null;
  return () => (cached ??= build());
}
