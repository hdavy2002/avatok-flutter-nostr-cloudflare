// [HF-WIRE-20] Who is paying: the payer's REAL contact details for the gateway order.
// Phone = the number she verified by WhatsApp OTP (phone_otp, status 'verified', same source /api/hf/me reads); email = a real address
// (Clerk, then the one typed at sign-up in hf_user_email). A placeholder address (@noemail.<domain>) is never returned, and nothing
// here ever invents a number: unknown = null, and the caller decides (a top-up with no number is refused).
import type { Env } from "../types";
import { cashfreePhone } from "./cashfree";
import { emailFor } from "./identity";
import { realEmailOrNull } from "./placeholder_email";

export interface TopupCustomer { phone: string | null; email: string | null }

export async function topupCustomer(env: Env, uid: string): Promise<TopupCustomer> {
  const [e164, clerk, typed] = await Promise.all([
    env.DB_META.prepare(
      `SELECT o.e164 AS e164
         FROM contact_verification cv
         JOIN phone_otp o ON o.uid=cv.uid AND o.phone_hash=cv.phone_hash AND o.status='verified'
        WHERE cv.uid=?1 AND cv.phone_verified=1
        ORDER BY o.verified_at DESC LIMIT 1`,
    ).bind(uid).first<{ e164: string | null }>().then((r) => r?.e164 ?? null).catch(() => null),
    emailFor(env, uid).catch(() => null),
    env.DB_META.prepare("SELECT email FROM hf_user_email WHERE uid=?1").bind(uid).first<{ email: string }>().then((r) => r?.email ?? null).catch(() => null),
  ]);
  return { phone: cashfreePhone(e164), email: realEmailOrNull(clerk) ?? realEmailOrNull(typed) };
}
