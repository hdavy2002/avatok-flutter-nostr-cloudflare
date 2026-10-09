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

/**
 * Does this caller currently have access to each protected lane? Used by the calls feature before connecting a call
 * to a lane host. Requires the lane row AND a still-verified Aadhaar (women also still F/T).
 */
export async function getLaneAccess(env: Env, uid: string): Promise<{ women: boolean; lgbtq: boolean }> {
  const rows = (await env.DB_META.prepare(
    `SELECT a.lane AS lane, k.gender AS gender FROM hf_lane_access a
       JOIN hf_kyc k ON k.uid = a.uid AND k.verified_at IS NOT NULL
      WHERE a.uid = ?1`,
  ).bind(uid).all<{ lane: string; gender: string | null }>().catch(() => null))?.results ?? [];
  const out = { women: false, lgbtq: false };
  for (const r of rows) {
    if (r.lane === "women" && womenEligible(r.gender)) out.women = true;
    if (r.lane === "lgbtq") out.lgbtq = true;
  }
  return out;
}
