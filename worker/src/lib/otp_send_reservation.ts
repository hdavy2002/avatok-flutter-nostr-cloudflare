// [HF-SEC-OTP-1] One shared ledger: reserve before any provider operation.
import type { Env } from "../types";
import { json } from "../util";
import { track } from "../hooks";
import { sendOtp, checkOnWhatsapp, otpProvider, type SendResult } from "./otp_sender";

type SendPolicy = {
  uid: string; phoneHash: string; e164: string; now: number;
  actorLimit: number; phoneLimit: number; globalLimit: number;
  hourMs: number; gapMs: number; cooldown: "phone" | "account";
  actorWindow?: { limit: number; ms: number };
};

// The Nth newest attempt determines when the corresponding budget frees up.
// All statuses count, including pending, failed and expired. No read-before-write.
const DEADLINE_SQL = `SELECT MAX(deadline) FROM (
  SELECT COALESCE((SELECT created_at FROM phone_otp
    WHERE (?5=1 AND phone_hash=?2) OR (?5=0 AND uid=?1)
    ORDER BY created_at DESC LIMIT 1),0)+?6 AS deadline
  UNION ALL SELECT COALESCE((SELECT created_at FROM phone_otp WHERE phone_hash=?2
    ORDER BY created_at DESC LIMIT 1 OFFSET ?7),0)+?8
  UNION ALL SELECT COALESCE((SELECT created_at FROM phone_otp WHERE uid=?1
    ORDER BY created_at DESC LIMIT 1 OFFSET ?9),0)+?8
  UNION ALL SELECT COALESCE((SELECT created_at FROM phone_otp
    ORDER BY created_at DESC LIMIT 1 OFFSET ?10),0)+?8
  UNION ALL SELECT COALESCE((SELECT created_at FROM phone_otp WHERE uid=?1
    ORDER BY created_at DESC LIMIT 1 OFFSET ?11),0)+?12
)`;
export const OTP_RESERVE_SQL = `INSERT INTO phone_otp
  (uid, phone_hash, e164, session_id, status, attempts, created_at)
  SELECT ?1, ?2, ?3, NULL, 'pending', 0, ?4
  WHERE (${DEADLINE_SQL}) <= ?4 RETURNING id`;

function bindings(p: SendPolicy): (string | number)[] {
  return [p.uid, p.phoneHash, p.e164, p.now, p.cooldown === "phone" ? 1 : 0,
    p.gapMs, p.phoneLimit - 1, p.hourMs, p.actorLimit - 1, p.globalLimit - 1,
    (p.actorWindow?.limit ?? 1) - 1, p.actorWindow?.ms ?? 0];
}

export async function reserveOtpSend(db: Env["DB_META"], policy: SendPolicy): Promise<
  { granted: true; id: number } | { granted: false; retryAfter: number }
> {
  const args = bindings(policy);
  // D1 serializes writes. Predicate and insertion execute as ONE SQLite statement.
  const row = await db.prepare(OTP_RESERVE_SQL).bind(...args).first<{ id: number }>();
  if (row) return { granted: true, id: row.id };
  // Informational read only; this never grants capacity or invokes the provider.
  // Refer to otherwise unused parameters so SQLite/D1 accept the same bindings.
  const wait = await db.prepare(`SELECT (${DEADLINE_SQL}) AS deadline WHERE ?3 IS NOT NULL AND ?4 IS NOT NULL`)
    .bind(...args).first<{ deadline: number }>();
  return { granted: false, retryAfter: Math.max(1, Math.ceil(((wait?.deadline ?? policy.now + policy.gapMs) - policy.now) / 1000)) };
}

export function otpRateLimited(retryAfter: number): Response {
  return json({ error: "rate_limited", message: `Please wait ${retryAfter}s before asking for another code.`, retry_after_s: retryAfter },
    429, { "Retry-After": String(retryAfter) });
}

export async function finishOtpSend(db: Env["DB_META"], id: number, sessionId: string | null): Promise<void> {
  await db.prepare("UPDATE phone_otp SET status=?2, session_id=?3 WHERE id=?1 AND status='pending'")
    .bind(id, sessionId === null ? "failed" : "sent", sessionId).run();
}

/** No retries: exceptions/unknown outcomes leave a counted, non-verifiable attempt. */
export async function reserveAndSendOtp(env: Env, policy: SendPolicy, ttlMin: number, preflight = false): Promise<SendResult | Response> {
  const metric = (outcome: string) => {
    // Bounded categories only: no phone/IP, hashes, session, code or provider payload.
    return track(env, "otp_service", "otp_send_reservation", "avatok", { outcome }).catch(() => {});
  };
  let reservation: Awaited<ReturnType<typeof reserveOtpSend>>;
  try { reservation = await reserveOtpSend(env.DB_META, policy); }
  catch { await metric("reservation_unavailable"); return json({ error: "otp_unavailable", message: "Please try again shortly." }, 503); }
  if (!reservation.granted) { await metric("reservation_rejected"); return otpRateLimited(reservation.retryAfter); }
  await metric("reservation_granted");
  let sent: SendResult;
  try {
    if (preflight && await checkOnWhatsapp(env, policy.e164) === false) {
      sent = { ok: false, provider: otpProvider(env) ?? "wasender", reason: "not_on_whatsapp", detail: "" };
    } else {
      sent = await sendOtp(env, policy.e164, ttlMin);
    }
  } catch {
    await metric("provider_ambiguous");
    // Keep pending: never release capacity or retry an unknown provider outcome.
    return json({ error: "send_failed", message: "We couldn’t confirm the code was sent. Please wait before requesting another." }, 502);
  }
  await metric(sent.ok ? "provider_sent" : sent.reason === "provider_error" ? "provider_ambiguous" : `provider_${sent.reason}`);
  try { await finishOtpSend(env.DB_META, reservation.id, sent.ok ? sent.sessionId : null); }
  catch {
    await metric("record_ambiguous");
    return json({ error: "send_failed", message: "We couldn’t confirm the code was sent. Please wait before requesting another." }, 503);
  }
  if (!sent.ok && sent.reason === "rate_limited") return otpRateLimited(Math.max(60, Math.ceil(policy.gapMs / 1000)));
  return sent;
}
