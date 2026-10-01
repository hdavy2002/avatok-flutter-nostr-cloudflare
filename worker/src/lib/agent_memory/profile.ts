// [AUMFE-AGENT-MEMORY-1] The customer's astro profile (birth details + memory consent) — one row per uid.
// Shared by every agent (voice guides + text Pandit ji). Geocoding / chart computation live in the
// astrology lib; this file only validates and stores what the customer typed (lat/lon/tzone optional).
import type { Env } from "../../types";
import { track } from "../../hooks";

export const APP = "aumfe_agent_memory";

export interface AstroProfile {
  uid: string;
  name: string | null;
  gender: string | null;
  dob: string | null;
  tob: string | null;
  tob_unknown: number;
  place: string | null;
  lat: number | null;
  lon: number | null;
  tzone: number | null;
  tz_id: string | null;
  language: string | null;
  snapshot_json: string | null;
  snapshot_version: number | null;
  computed_at: number | null;
  memory_consent: number;
  consent_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProfileInput {
  name?: unknown; gender?: unknown; dob?: unknown; tob?: unknown; tob_unknown?: unknown;
  place?: unknown; lat?: unknown; lon?: unknown; tzone?: unknown; tz_id?: unknown; language?: unknown;
}

const COLS = `uid, name, gender, dob, tob, tob_unknown, place, lat, lon, tzone, tz_id, language,
  snapshot_json, snapshot_version, computed_at, memory_consent, consent_at, created_at, updated_at`;

export async function getProfile(env: Env, uid: string): Promise<AstroProfile | null> {
  if (!uid) return null;
  return (await env.DB_META.prepare(`SELECT ${COLS} FROM astro_profiles WHERE uid=?1`).bind(uid).first<AstroProfile>()) ?? null;
}

function str(v: unknown, max: number): string | null | "bad" {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return "bad";
  const t = v.trim();
  return t.length > max ? "bad" : t || null;
}
function num(v: unknown, lo: number, hi: number): number | null | "bad" {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : "bad";
}

export function validDob(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  return dt.getTime() <= Date.now() + 24 * 3600 * 1000;
}
export function validTob(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export type UpsertResult = { ok: true; profile: AstroProfile } | { ok: false; error: string };

/** Partial update: fields absent from `input` keep their stored value. Changing a birth field voids the stored chart snapshot. */
export async function upsertProfile(env: Env, uid: string, input: ProfileInput): Promise<UpsertResult> {
  if (!uid) return { ok: false, error: "uid_required" };
  const cur = await getProfile(env, uid);
  const has = (k: keyof ProfileInput) => Object.prototype.hasOwnProperty.call(input, k);

  const name = has("name") ? str(input.name, 80) : cur?.name ?? null;
  const gender = has("gender") ? str(input.gender, 16) : cur?.gender ?? null;
  const place = has("place") ? str(input.place, 120) : cur?.place ?? null;
  const tzId = has("tz_id") ? str(input.tz_id, 64) : cur?.tz_id ?? null;
  const language = has("language") ? str(input.language, 16) : cur?.language ?? null;
  const dob = has("dob") ? str(input.dob, 10) : cur?.dob ?? null;
  let tob = has("tob") ? str(input.tob, 5) : cur?.tob ?? null;
  const lat = has("lat") ? num(input.lat, -90, 90) : cur?.lat ?? null;
  const lon = has("lon") ? num(input.lon, -180, 180) : cur?.lon ?? null;
  const tzone = has("tzone") ? num(input.tzone, -12, 14) : cur?.tzone ?? null;
  let tobUnknown = has("tob_unknown") ? (input.tob_unknown ? 1 : 0) : cur?.tob_unknown ?? 0;

  for (const [k, v] of Object.entries({ name, gender, place, tz_id: tzId, language, dob, tob, lat, lon, tzone })) {
    if (v === "bad") return { ok: false, error: `invalid_${k}` };
  }
  if (typeof dob === "string" && !validDob(dob)) return { ok: false, error: "invalid_dob" };
  if (typeof tob === "string" && !validTob(tob)) return { ok: false, error: "invalid_tob" };
  if (typeof gender === "string" && !["male", "female", "other"].includes(gender.toLowerCase())) return { ok: false, error: "invalid_gender" };
  if (tobUnknown === 1) tob = null;
  else if (tob) tobUnknown = 0;

  const now = Date.now();
  const g = typeof gender === "string" ? gender.toLowerCase() : null;
  const birthChanged = !cur || cur.dob !== dob || cur.tob !== tob || cur.place !== place || cur.lat !== lat || cur.lon !== lon || cur.tzone !== tzone;

  await env.DB_META.prepare(
    `INSERT INTO astro_profiles (uid, name, gender, dob, tob, tob_unknown, place, lat, lon, tzone, tz_id, language, memory_consent, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,?13,?13)
     ON CONFLICT(uid) DO UPDATE SET name=?2, gender=?3, dob=?4, tob=?5, tob_unknown=?6, place=?7, lat=?8, lon=?9, tzone=?10, tz_id=?11, language=?12, updated_at=?13`,
  ).bind(uid, name, g, dob, tob, tobUnknown, place, lat, lon, tzone, tzId, language, now).run();

  if (cur && birthChanged && cur.snapshot_json) {
    await env.DB_META.prepare(`UPDATE astro_profiles SET snapshot_json=NULL, snapshot_version=NULL, computed_at=NULL WHERE uid=?1`).bind(uid).run();
  }
  void track(env, uid, "astro_profile_saved", APP, { uid, has_tob: !!tob, has_geo: lat !== null && lon !== null, birth_changed: birthChanged });
  const profile = await getProfile(env, uid);
  return profile ? { ok: true, profile } : { ok: false, error: "write_failed" };
}

/** Consent gate for ALL agent memory. Withdrawing consent does not delete anything by itself (forgetAll does). */
export async function setConsent(env: Env, uid: string, consent: boolean): Promise<AstroProfile | null> {
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO astro_profiles (uid, memory_consent, consent_at, created_at, updated_at) VALUES (?1,?2,?3,?3,?3)
     ON CONFLICT(uid) DO UPDATE SET memory_consent=?2, consent_at=?3, updated_at=?3`,
  ).bind(uid, consent ? 1 : 0, now).run();
  void track(env, uid, "agent_memory_consent_set", APP, { uid, consent });
  return getProfile(env, uid);
}

export async function hasConsent(env: Env, uid: string): Promise<boolean> {
  const r = await env.DB_META.prepare(`SELECT memory_consent FROM astro_profiles WHERE uid=?1`).bind(uid).first<{ memory_consent: number }>();
  return r?.memory_consent === 1;
}
