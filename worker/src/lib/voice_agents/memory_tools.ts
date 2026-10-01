// [AUMFE-VOICE-RUNTIME-1 2026-10-01] Tools shared by EVERY voice guide. The runtime appends these to the agent's own
// tools, so an agent definition never lists them. The model never supplies a uid: ctx.uid is the verified caller.
import type { VoiceTool, VoiceToolCtx } from "./types";
import { remember, recall, upsertProfile } from "../agent_memory";
import { geoLookup, tzoneFor, type GeoPlace } from "../astrology";

const MAX_RECALL_LINES = 5;
const MAX_LINE_CHARS = 200;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** "6:5", "06:05", "6:05" -> "06:05"; anything else -> null. */
export function normalizeTob(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** YYYY-MM-DD -> DD-MM-YYYY (the format the timezone endpoint takes). */
export function dobToApiDate(dob: string): string {
  const [y, m, d] = dob.split("-");
  return `${d}-${m}-${y}`;
}

/**
 * Pick one place from geocoder candidates, or report ambiguity. Candidates within ~0.5 degrees of the first are the
 * same place (the geocoder often returns the same city twice). An optional hint ("Uttar Pradesh", "IN") narrows by
 * substring of place_name or exact country code.
 */
export function pickPlace(cands: GeoPlace[], hint: string): { place: GeoPlace } | { ambiguous: GeoPlace[] } {
  let list = cands;
  const h = hint.trim().toLowerCase();
  if (h && list.length > 1) {
    const narrowed = list.filter((c) => c.country_code.toLowerCase() === h || (h.length > 2 && c.place_name.toLowerCase().includes(h)));
    if (narrowed.length) list = narrowed;
  }
  const first = list[0];
  const distinct = list.filter((c) => Math.abs(c.lat - first.lat) > 0.5 || Math.abs(c.lon - first.lon) > 0.5);
  return distinct.length === 0 ? { place: first } : { ambiguous: list.slice(0, 5) };
}

export const rememberTool: VoiceTool = {
  decl: {
    name: "remember",
    description:
      "Save one short, durable fact about the customer for future calls (a name they like to be called, a life event, a worry, a goal). " +
      "Call it quietly while you keep talking; never announce it. One fact per call, under 160 characters. Never save card numbers or passwords.",
    parameters: {
      type: "OBJECT",
      properties: { fact: { type: "STRING", description: "The fact, written in third person, e.g. 'Prefers to be called Anu; asking about marriage timing'." } },
      required: ["fact"],
    },
  },
  blocking: false,
  async run(ctx: VoiceToolCtx, args) {
    const fact = str(args.fact);
    if (!fact) return { saved: false, reason: "empty" };
    try {
      const r = await remember(ctx.env, ctx.uid, ctx.agentId, fact, ctx.sessionId, "fact");
      if (r.ok) return { saved: true };
      return { saved: false, reason: r.skipped };
    } catch (e) {
      return { saved: false, reason: "error", detail: String((e as Error)?.message ?? e).slice(0, 120) };
    }
  },
};

export const recallTool: VoiceTool = {
  decl: {
    name: "recall",
    description:
      "Look up what you already know about the customer from earlier calls. Use it when they refer to something from before, " +
      "or before you ask something they may have told you already.",
    parameters: {
      type: "OBJECT",
      properties: { question: { type: "STRING", description: "What you want to remember, in a few words, e.g. 'their job' or 'earlier question about marriage'." } },
      required: ["question"],
    },
  },
  blocking: true,
  async run(ctx: VoiceToolCtx, args) {
    const q = str(args.question);
    if (!q) return { memories: [] };
    try {
      const lines = await recall(ctx.env, ctx.uid, q, MAX_RECALL_LINES);
      return { memories: lines.slice(0, MAX_RECALL_LINES).map((l) => l.slice(0, MAX_LINE_CHARS)) };
    } catch (e) {
      return { error: "recall_failed", detail: String((e as Error)?.message ?? e).slice(0, 120) };
    }
  },
};

export const saveBirthDetailsTool: VoiceTool = {
  decl: {
    name: "save_birth_details",
    description:
      "Save the customer's birth details after they have told you and confirmed them, so their chart can be read. " +
      "Needs date of birth (YYYY-MM-DD) and place of birth. Time of birth is HH:MM in 24-hour form; if they do not know it, set tob_unknown true. " +
      "If it answers with ambiguous_place, ask the customer which one (state or country) and call again with place_hint.",
    parameters: {
      type: "OBJECT",
      properties: {
        name: { type: "STRING", description: "Customer's name, optional." },
        dob: { type: "STRING", description: "Date of birth, YYYY-MM-DD." },
        tob: { type: "STRING", description: "Time of birth, 24-hour HH:MM. Omit when unknown." },
        tob_unknown: { type: "BOOLEAN", description: "true when the customer does not know their birth time." },
        place: { type: "STRING", description: "Birth town or city, e.g. 'Dehradun'." },
        place_hint: { type: "STRING", description: "State or country to disambiguate the place, e.g. 'Uttarakhand'. Optional." },
      },
      required: ["dob", "place"],
    },
  },
  blocking: true,
  async run(ctx: VoiceToolCtx, args) {
    const dob = str(args.dob);
    const place = str(args.place);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return { error: "invalid_dob", hint: "Use YYYY-MM-DD." };
    if (!place) return { error: "place_required" };
    const tobRaw = str(args.tob);
    const tobUnknown = args.tob_unknown === true || (!tobRaw && args.tob_unknown !== false);
    let tob: string | null = null;
    if (tobRaw) {
      tob = normalizeTob(tobRaw);
      if (!tob) return { error: "invalid_tob", hint: "Use 24-hour HH:MM, or set tob_unknown." };
    }
    try {
      const geo = await geoLookup(ctx.env, place, 5, ctx.uid);
      if (!geo.ok) return { error: "place_lookup_failed" };
      if (!geo.data.length) return { error: "place_not_found", hint: "Ask for the nearest big town or the state." };
      const picked = pickPlace(geo.data, str(args.place_hint));
      if ("ambiguous" in picked) {
        return {
          error: "ambiguous_place",
          candidates: picked.ambiguous.map((c) => ({ place_name: c.place_name, country_code: c.country_code })),
        };
      }
      const g = picked.place;
      const tz = await tzoneFor(ctx.env, g.lat, g.lon, dobToApiDate(dob), ctx.uid);
      const input: Record<string, unknown> = {
        dob, tob, tob_unknown: tob ? false : tobUnknown,
        place: g.place_name, lat: g.lat, lon: g.lon, tz_id: g.timezone_id || null,
        tzone: tz.ok ? tz.data : null,
      };
      const name = str(args.name);
      if (name) input.name = name;
      const r = await upsertProfile(ctx.env, ctx.uid, input);
      if (!r.ok) return { error: r.error };
      ctx.showCard?.({
        title: "Birth details saved",
        items: [
          { label: "Born", value: dob },
          { label: "Time", value: tob ?? "not known" },
          { label: "Place", value: g.place_name },
        ],
      });
      return { saved: true, place: g.place_name, time_known: !!tob };
    } catch (e) {
      return { error: "save_failed", detail: String((e as Error)?.message ?? e).slice(0, 120) };
    }
  },
};

/** Appended to every agent's own tools by the runtime. */
export const memoryTools: VoiceTool[] = [rememberTool, recallTool, saveBirthDetailsTool];
