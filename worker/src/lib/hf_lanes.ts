// [HF-LANE-VERIFY-1] Protected-lane eligibility (rulebook HF-WOM-2, HF-LGBT-3). Pure helpers + one D1 read for the calls feature.
import type { Env } from "../types";
import { readConfig } from "../routes/config";

export type Lane = "women" | "lgbtq";
export type KycGenderCode = "F" | "M" | "T";

/** `?lane=` / `:lane` value -> Lane, or null for anything else. */
export function parseLane(v: unknown): Lane | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "women" || s === "lgbtq" ? s : null;
}

/** Women-only space: Aadhaar gender must be female ONLY ([HF-CREATOR-SPACES-1] 2026-10-24: transgender is no longer accepted here, T goes to the LGBTQ+ space). */
export function womenEligible(gender: string | null | undefined): boolean {
  return gender === "F";
}

/** Eligibility for a lane given the Aadhaar record. LGBTQ+ accepts any gender once Aadhaar is verified. */
export function laneEligible(lane: Lane, aadhaarVerified: boolean, gender: string | null | undefined): boolean {
  if (!aadhaarVerified) return false;
  return lane === "women" ? womenEligible(gender) : true;
}

export const WOMEN_NOT_ELIGIBLE_MESSAGE = "The women-only space is open to callers whose Aadhaar shows female.";

export type LaneSelfieStatus = "none" | "pending" | "approved" | "rejected";

/** Private identity evidence shared by host onboarding and protected spaces. Latest upload wins. */
export async function latestLaneSelfie(env: Env, uid: string): Promise<{ status: LaneSelfieStatus; reason: string | null }> {
  const row = await env.DB_META.prepare(
    "SELECT review_status, review_reason FROM hf_selfie WHERE uid=?1 ORDER BY created_at DESC, id DESC LIMIT 1",
  ).bind(uid).first<{ review_status: string; review_reason: string | null }>().catch(() => null);
  const status: LaneSelfieStatus = row?.review_status === "approved" || row?.review_status === "pending" || row?.review_status === "rejected"
    ? row.review_status : "none";
  return { status, reason: status === "rejected" ? row?.review_reason ?? null : null };
}

// ── [HF-INTRO-W2] Women-to-Women, fan side (HF-INTRO-18, D17): behind hfWomenAadhaarOnlyEnabled a fan qualifies with a verified Aadhaar showing Female.
// No selfie, no "joined the lane" row. LGBTQ+ is unchanged. Flag off: every function below answers exactly as before.
export async function womenAadhaarOnlyOn(env: Env): Promise<boolean> {
  try { return (await readConfig(env)).hfWomenAadhaarOnlyEnabled === true; } catch { return false; }
}
/** What the fan still needs for a women-only channel (flag-on rule): 'aadhaar' = no verified Aadhaar yet, 'female_only' = verified but not Female, null = allowed. */
export type WomenNeed = "aadhaar" | "female_only";
export async function womenNeed(env: Env, uid: string): Promise<WomenNeed | null> {
  const k = await env.DB_META.prepare("SELECT gender, verified_at FROM hf_kyc WHERE uid=?1").bind(uid).first<{ gender: string | null; verified_at: number | null }>().catch(() => null);
  if (!k || k.verified_at == null) return "aadhaar";
  return womenEligible(k.gender) ? null : "female_only";
}
/** The extra fields of a 403 lane_required for the women lane: {lane:'women'} plus need:'aadhaar'|'female_only' while the flag is on (clients show "Verify now" vs "women only"). */
export async function womenLaneRequiredExtra(env: Env, uid: string): Promise<{ lane: "women"; need?: WomenNeed }> {
  if (!(await womenAadhaarOnlyOn(env))) return { lane: "women" };
  const need = await womenNeed(env, uid);
  return need ? { lane: "women", need } : { lane: "women" };
}

/** Single authority for discovery, profile visibility and direct call requests. Fail closed.
 *  [HF-CREATOR-SPACES-1] women = joined + Aadhaar F + latest selfie APPROVED; lgbtq = declared + Aadhaar verified + latest selfie APPROVED. */
export async function getLaneAccess(env: Env, uid: string): Promise<{ women: boolean; lgbtq: boolean }> {
  const rows = (await env.DB_META.prepare(
    `SELECT a.lane AS lane, a.declared_at AS declared_at, k.gender AS gender FROM hf_lane_access a
       JOIN hf_kyc k ON k.uid = a.uid AND k.verified_at IS NOT NULL
      WHERE a.uid = ?1`,
  ).bind(uid).all<{ lane: string; declared_at: number | null; gender: string | null }>().catch(() => null))?.results ?? [];
  const out = { women: false, lgbtq: false };
  const womenAadhaarOnly = await womenAadhaarOnlyOn(env); // [HF-INTRO-W2]
  if (womenAadhaarOnly && (await womenNeed(env, uid)) === null) out.women = true;
  if (!rows.length) return out;
  if ((await latestLaneSelfie(env, uid)).status !== "approved") return out;
  for (const r of rows) {
    if (r.lane === "women" && !womenAadhaarOnly && womenEligible(r.gender)) out.women = true;
    if (r.lane === "lgbtq" && r.declared_at != null) out.lgbtq = true;
  }
  return out;
}
