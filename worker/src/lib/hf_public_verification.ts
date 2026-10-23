/**
 * [HF-IDV-WHATSAPP-1 2026-10-24] Owner decision: a creator / host is verified by a WhatsApp OTP on their
 * phone number and nothing else. In India every mobile number is Aadhaar-linked, so there is no Aadhaar
 * check and no selfie video for going live, publishing, or being callable/bookable.
 * Aadhaar (hf_kyc) is still used ONLY for: payouts (money out) and entering the Women-only / LGBTQ+ spaces.
 * Private evidence stays inside the worker. Only the two booleans are public.
 */
import type { Env } from "../types";

export interface PhoneEvidence {
  /** 1 when contact_verification.phone_verified=1 AND the matching phone_otp row is 'verified' (same rule as bookings). */
  phone_verified?: number | null;
}

/** SQL predicate: uid (an SQL expression, e.g. `h.uid` or `?1`) has a WhatsApp-OTP-verified number. Mirrors the booking gate. */
export function phoneVerifiedSql(uidExpr: string): string {
  return `EXISTS (SELECT 1 FROM contact_verification cv JOIN phone_otp p ON p.uid=cv.uid AND p.phone_hash=cv.phone_hash WHERE cv.uid=${uidExpr} AND cv.phone_verified=1 AND p.status='verified')`;
}

export async function isPhoneVerified(env: Env, uid: string): Promise<boolean> {
  const r = await env.DB_META.prepare(`SELECT ${phoneVerifiedSql("?1")} AS ok`).bind(uid).first<{ ok: number }>().catch(() => null);
  return Number(r?.ok) === 1;
}

/** Shared with creator publication. The only identity blocker left is a verified WhatsApp number. */
export function identityEvidenceBlockers(phone: PhoneEvidence | null | undefined): string[] {
  return Number(phone?.phone_verified) === 1 ? [] : ["whatsapp"];
}

export function publicVerification(phone: PhoneEvidence | null | undefined, listingStatus: string) {
  const identityVerified = identityEvidenceBlockers(phone).length === 0;
  return { identityVerified, callEligible: identityVerified && listingStatus === "live" };
}
