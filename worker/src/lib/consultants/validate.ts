// [AUMFE-CONSULT-W4-1] Pure validators for the consultant desk + admin APIs (no I/O, unit-tested).
import { DISCIPLINES, type Discipline, type ConsultantStatus } from "./types";
import type { AvailabilityRule, AvailabilityException } from "./slots";
import { RATE_MIN, RATE_MAX } from "./pricing";

export const MAX_RULES = 20;
export const MAX_EXCEPTIONS = 120;
export const SLOT_MINUTES = [30, 45, 60] as const;
export const MAX_BUFFER = 30;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = <T>(error: string): Checked<T> => ({ ok: false, error });

export const isHM = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const isDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const mins = (s: string): number => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

export interface AvailabilityInput { rules: AvailabilityRule[]; exceptions: AvailabilityException[]; slot_minutes: number; buffer_minutes: number }

export function validateAvailability(body: unknown): Checked<AvailabilityInput> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const rulesIn = Array.isArray(b.rules) ? b.rules : [];
  const exIn = Array.isArray(b.exceptions) ? b.exceptions : [];
  if (rulesIn.length > MAX_RULES) return bad("too_many_rules");
  if (exIn.length > MAX_EXCEPTIONS) return bad("too_many_exceptions");
  const slot = b.slot_minutes, buf = b.buffer_minutes;
  if (!(SLOT_MINUTES as readonly unknown[]).includes(slot)) return bad("bad_slot_minutes");
  if (typeof buf !== "number" || !Number.isInteger(buf) || buf < 0 || buf > MAX_BUFFER) return bad("bad_buffer_minutes");

  const rules: AvailabilityRule[] = [];
  const seen = new Set<string>();
  for (const r of rulesIn as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") return bad("bad_rule");
    const { weekday, start, end } = r;
    if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return bad("bad_weekday");
    if (!isHM(start) || !isHM(end)) return bad("bad_time");
    if (mins(start) >= mins(end)) return bad("start_after_end");
    const k = `${weekday}|${start}`;
    if (seen.has(k)) return bad("duplicate_rule");
    seen.add(k);
    rules.push({ weekday, start, end });
  }
  const exceptions: AvailabilityException[] = [];
  const exSeen = new Set<string>();
  for (const e of exIn as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") return bad("bad_exception");
    if (!isDate(e.date)) return bad("bad_date");
    const off = e.off === true || e.off === 1;
    if (off) {
      const k = `${e.date}|1|`;
      if (exSeen.has(k)) continue;
      exSeen.add(k);
      exceptions.push({ date: e.date, off: true });
    } else {
      if (!isHM(e.start) || !isHM(e.end)) return bad("bad_time");
      if (mins(e.start) >= mins(e.end)) return bad("start_after_end");
      const k = `${e.date}|0|${e.start}`;
      if (exSeen.has(k)) return bad("duplicate_exception");
      exSeen.add(k);
      exceptions.push({ date: e.date, off: false, start: e.start, end: e.end });
    }
  }
  return { ok: true, value: { rules, exceptions, slot_minutes: slot as number, buffer_minutes: buf } };
}

const str = (v: unknown, max: number): string | null | undefined => {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > max ? undefined : t;
};

/** Desk self-edit: bio, tagline, languages, city only. Returns the columns to set. */
export function validateDeskProfile(body: unknown): Checked<{ bio?: string | null; tagline?: string | null; city?: string | null; languages_json?: string }> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out: { bio?: string | null; tagline?: string | null; city?: string | null; languages_json?: string } = {};
  if ("bio" in b) { const v = str(b.bio, 2000); if (v === undefined) return bad("bad_bio"); out.bio = v || null; }
  if ("tagline" in b) { const v = str(b.tagline, 160); if (v === undefined) return bad("bad_tagline"); out.tagline = v || null; }
  if ("city" in b) { const v = str(b.city, 80); if (v === undefined) return bad("bad_city"); out.city = v || null; }
  if ("languages" in b) {
    if (!Array.isArray(b.languages) || b.languages.length > 12) return bad("bad_languages");
    const l = b.languages.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
    if (l.some((x) => x.length > 30)) return bad("bad_languages");
    out.languages_json = JSON.stringify([...new Set(l)]);
  }
  if (!Object.keys(out).length) return bad("nothing_to_update");
  return { ok: true, value: out };
}

export const slugOk = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) && s.length >= 2 && s.length <= 60;

const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Admin profile patch (any field). `current` supplies the existing rate/floor/ceil so cross-field rules hold. */
export function validateAdminPatch(
  body: unknown, current: { rate_rupees: number; rate_floor: number; rate_ceil: number },
): Checked<Record<string, string | number | null>> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out: Record<string, string | number | null> = {};
  if ("name" in b) { const v = str(b.name, 80); if (!v) return bad("bad_name"); out.name = v; }
  if ("slug" in b) { if (!slugOk(b.slug)) return bad("bad_slug"); out.slug = b.slug; }
  if ("disciplines" in b) {
    const d = b.disciplines;
    if (!Array.isArray(d) || !d.length || d.length > DISCIPLINES.length || d.some((x) => !(DISCIPLINES as readonly string[]).includes(x as string))) return bad("bad_disciplines");
    out.disciplines_json = JSON.stringify([...new Set(d as Discipline[])]);
  }
  for (const [k, max] of [["tagline", 160], ["bio", 2000], ["lineage", 300], ["city", 80]] as const) {
    if (k in b) { const v = str(b[k], max); if (v === undefined) return bad(`bad_${k}`); out[k] = v || null; }
  }
  if ("languages" in b) {
    if (!Array.isArray(b.languages) || b.languages.length > 12 || b.languages.some((x) => typeof x !== "string" || !x.trim() || x.length > 30)) return bad("bad_languages");
    out.languages_json = JSON.stringify([...new Set((b.languages as string[]).map((x) => x.trim()))]);
  }
  if ("years" in b) { if (b.years !== null && !intIn(b.years, 0, 80)) return bad("bad_years"); out.years = b.years as number | null; }
  if ("status" in b) {
    if (!["draft", "live", "paused"].includes(b.status as string)) return bad("bad_status");
    out.status = b.status as ConsultantStatus;
  }
  if ("sort_order" in b) { if (!intIn(b.sort_order, 0, 100000)) return bad("bad_sort_order"); out.sort_order = b.sort_order; }
  if ("slot_minutes" in b) { if (!(SLOT_MINUTES as readonly unknown[]).includes(b.slot_minutes)) return bad("bad_slot_minutes"); out.slot_minutes = b.slot_minutes as number; }
  if ("buffer_minutes" in b) { if (!intIn(b.buffer_minutes, 0, MAX_BUFFER)) return bad("bad_buffer_minutes"); out.buffer_minutes = b.buffer_minutes; }
  const floor = "rate_floor" in b ? b.rate_floor : current.rate_floor;
  const ceil = "rate_ceil" in b ? b.rate_ceil : current.rate_ceil;
  const rate = "rate" in b ? b.rate : current.rate_rupees;
  if ("rate_floor" in b || "rate_ceil" in b || "rate" in b) {
    if (!intIn(floor, RATE_MIN, RATE_MAX) || !intIn(ceil, RATE_MIN, RATE_MAX) || floor > ceil) return bad("bad_rate_bounds");
    if (!intIn(rate, floor, ceil)) return bad("rate_out_of_bounds");
    if ("rate_floor" in b) out.rate_floor = floor;
    if ("rate_ceil" in b) out.rate_ceil = ceil;
    if ("rate" in b) out.rate_rupees = rate;
  }
  if (!Object.keys(out).length) return bad("nothing_to_update");
  return { ok: true, value: out };
}

export const BOOKING_STATUSES = ["held", "awaiting_review", "confirmed", "in_call", "completed", "no_show_consultant", "no_show_customer", "cancelled", "expired"];
export const REFUNDABLE = ["no_show_consultant", "cancelled", "confirmed"];
export const CANCELLABLE = ["held", "awaiting_review", "confirmed"];

/** Age in whole years from a YYYY-MM-DD dob, or null. */
export function ageFromDob(dob: unknown, nowMs: number): number | null {
  if (!isDate(dob)) return null;
  const d = new Date(`${dob}T00:00:00Z`), n = new Date(nowMs);
  let a = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) a--;
  return a >= 0 && a < 130 ? a : null;
}
