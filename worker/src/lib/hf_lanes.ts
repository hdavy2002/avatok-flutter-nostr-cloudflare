// [HF-LANE-VERIFY-1] Protected-lane eligibility (rulebook HF-WOM-2, HF-LGBT-3). Pure helpers + one D1 read for the calls feature.
import type { Env } from "../types";

export type Lane = "women" | "lgbtq";
export type KycGenderCode = "F" | "M" | "T";

/** `?lane=` / `:lane` value -> Lane, or null for anything else. */
export function parseLane(v: unknown): Lane | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "women" || s === "lgbtq" ? s : null;
}

/** Women-only space: Aadhaar gender must be female or transgender (/women-only page states this). */
export function womenEligible(gender: string | null | undefined): boolean {
  return gender === "F" || gender === "T";
}

/** Eligibility for a lane given the Aadhaar record. LGBTQ+ accepts any gender once Aadhaar is verified. */
export function laneEligible(lane: Lane, aadhaarVerified: boolean, gender: string | null | undefined): boolean {
  if (!aadhaarVerified) return false;
  return lane === "women" ? womenEligible(gender) : true;
}

export const WOMEN_NOT_ELIGIBLE_MESSAGE = "The women-only space is open to callers whose Aadhaar shows female or transgender.";

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

/** Single authority for discovery, profile visibility and direct call requests. Fail closed. */
export async function getLaneAccess(env: Env, uid: string): Promise<{ women: boolean; lgbtq: boolean }> {
  const rows = (await env.DB_META.prepare(
    `SELECT a.lane AS lane, a.declared_at AS declared_at, k.gender AS gender FROM hf_lane_access a
       JOIN hf_kyc k ON k.uid = a.uid AND k.verified_at IS NOT NULL
      WHERE a.uid = ?1`,
  ).bind(uid).all<{ lane: string; declared_at: number | null; gender: string | null }>().catch(() => null))?.results ?? [];
  const out = { women: false, lgbtq: false };
  for (const r of rows) {
    if (r.lane === "women" && womenEligible(r.gender)) out.women = true;
  }
  // Keep women's F/T access independent of missing or unavailable selfie records.
  if (rows.some((r) => r.lane === "lgbtq" && r.declared_at != null)) {
    out.lgbtq = (await latestLaneSelfie(env, uid)).status === "approved";
  }
  return out;
}
