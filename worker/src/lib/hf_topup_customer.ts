// [HF-WIRE-20] Who is paying: the payer's REAL contact details for the gateway order.
// Phone = the number she verified by WhatsApp OTP (phone_otp, status 'verified', same source /api/hf/me reads); email = a real address
// (Clerk, then the one typed at sign-up in hf_user_email). A placeholder address (@noemail.<domain>) is never returned, and nothing
// here ever invents a number: unknown = null, and the caller decides (a top-up with no number is refused).
import type { Env } from "../types";
import { cashfreePhone } from "./cashfree";
import { emailFor } from "./identity";
import { realEmailOrNull } from "./placeholder_email";

export interface TopupCustomer { phone: string | null; email: string | null; name: string | null }

/** [HF-WIRE-21] Details the app collected on its own screen when the profile had none (already validated by the caller). Used for this order only. */
export interface GivenDetails { name?: string | null; email?: string | null }

export async function topupCustomer(env: Env, uid: string, given: GivenDetails = {}): Promise<TopupCustomer> {
  const [e164, clerk, typed, profileName] = await Promise.all([
    env.DB_META.prepare(
      `SELECT o.e164 AS e164
         FROM contact_verification cv
         JOIN phone_otp o ON o.uid=cv.uid AND o.phone_hash=cv.phone_hash AND o.status='verified'
        WHERE cv.uid=?1 AND cv.phone_verified=1
        ORDER BY o.verified_at DESC LIMIT 1`,
    ).bind(uid).first<{ e164: string | null }>().then((r) => r?.e164 ?? null).catch(() => null),
    emailFor(env, uid).catch(() => null),
    env.DB_META.prepare("SELECT email FROM hf_user_email WHERE uid=?1").bind(uid).first<{ email: string }>().then((r) => r?.email ?? null).catch(() => null),
    // [HF-WIRE-21] The name on the profile (the gateway's receipt shows it).
    env.DB_META.prepare("SELECT display_name FROM users WHERE uid=?1").bind(uid).first<{ display_name: string | null }>().then((r) => r?.display_name?.trim() || null).catch(() => null),
  ]);
  return {
    phone: cashfreePhone(e164),
    email: realEmailOrNull(clerk) ?? realEmailOrNull(typed) ?? realEmailOrNull(given.email ?? null),
    name: profileName ?? (given.name?.trim() || null),
  };
}
