import type { Env, EmailMsg } from "./types";
import { sendWithPolicy } from "./email_provider";

type DeliveryStatus = "queued" | "sending" | "provider_accepted" | "delivered" | "failed" | "bounced";
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function keyFor(msg: EmailMsg): Promise<string> {
  if (msg.outboxKey) return msg.outboxKey;
  return `email:${await digest(JSON.stringify({ to: msg.to, subject: msg.subject, html: msg.html, attachments: msg.attachments ?? [] }))}`;
}

function status(row: { delivery_status?: string | null; state?: string | null } | null): DeliveryStatus {
  const value = row?.delivery_status;
  if (value === "queued" || value === "sending" || value === "provider_accepted" || value === "delivered" || value === "failed" || value === "bounced") return value;
  if (row?.state === "sending") return "sending";
  if (row?.state === "sent") return "provider_accepted";
  if (row?.state === "failed") return "failed";
  return "queued";
}

async function markFailure(env: Env, key: string, message: string, attempts: number, retryable = true): Promise<boolean> {
  const now = Date.now();
  const nextAttemptAt = retryable && attempts < MAX_ATTEMPTS ? now : null;
  try {
    const result = await env.DB_META.prepare(
      `UPDATE email_outbox SET state='failed',delivery_status='failed',error_message=?2,
         attempts=?3,updated_at=?4,next_attempt_at=?5,lease_expires_at=NULL
       WHERE outbox_key=?1 AND delivery_status='sending' AND attempts=?3`,
    ).bind(key, message.slice(0, 500), attempts, now, nextAttemptAt).run();
    return (result.meta?.changes ?? 0) > 0;
  } catch { return false; }
}

/** Provider-agnostic email queue handler (Cloudflare primary / Brevo fallback via sendWithPolicy). Provider acceptance is recorded separately from delivery. */
export async function sendEmailDurably(msg: EmailMsg, env: Env, opts?: { throwOnPermanent?: boolean }): Promise<void> {
  const key = await keyFor(msg);
  const now = Date.now();
  let attempts = 0;
  let maxAttempts = MAX_ATTEMPTS;
  try {
    await env.DB_META.prepare(
      `UPDATE email_outbox SET state='failed',delivery_status='failed',
         error_message='retry budget exhausted',lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?1
       WHERE outbox_key=?2 AND delivery_status='sending' AND lease_expires_at IS NOT NULL
         AND lease_expires_at<?1 AND attempts>=max_attempts`,
    ).bind(now, key).run();
    await env.DB_META.prepare(
      `UPDATE email_outbox SET state='pending',delivery_status='queued',lease_expires_at=NULL,updated_at=?1
       WHERE outbox_key=?2 AND delivery_status='sending' AND lease_expires_at IS NOT NULL AND lease_expires_at<?1`,
    ).bind(now, key).run();
    const row = await env.DB_META.prepare(
      "SELECT state,delivery_status,attempts,max_attempts,next_attempt_at FROM email_outbox WHERE outbox_key=?1 LIMIT 1",
    ).bind(key).first<{ state: string; delivery_status: string | null; attempts: number; max_attempts: number; next_attempt_at: number | null }>();
    if (!row) {
      await env.DB_META.prepare(
        `INSERT OR IGNORE INTO email_outbox
          (outbox_key,kind,state,payload_json,delivery_status,recipient_id,order_id,message_version,
           attempts,max_attempts,created_at,updated_at,next_attempt_at)
         VALUES (?1,?2,'pending',?3,'queued',?4,?5,?6,0,?7,?8,?8,?8)`,
      ).bind(key, msg.kind ?? "email", JSON.stringify({ ...msg, outboxKey: key }), msg.recipientId ?? null,
        msg.orderId ?? null, msg.messageVersion ?? "email.v1", MAX_ATTEMPTS, now).run();
    } else if (["provider_accepted", "delivered", "bounced"].includes(status(row))) {
      if (status(row) === "bounced" && opts?.throwOnPermanent) throw new Error("email delivery bounced");
      return;
    } else {
      attempts = Number(row.attempts ?? 0);
      maxAttempts = Number(row.max_attempts ?? MAX_ATTEMPTS);
    }
    const claim = await env.DB_META.prepare(
      `UPDATE email_outbox SET state='sending',delivery_status='sending',attempts=attempts+1,
         lease_expires_at=?2,updated_at=?3 WHERE outbox_key=?1
         AND (delivery_status='queued' OR (delivery_status='failed' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?5))
         AND attempts=?4 AND attempts<max_attempts`,
    ).bind(key, now + LEASE_MS, now, attempts, now).run();
    // A zero CAS means another consumer owns it, it is pending retry, or the
    // budget is exhausted. Cron must surface that state so cadence flags do not
    // advance; queue delivery can ack and let recovery proceed.
    if ((claim.meta?.changes ?? 0) === 0) {
      if (opts?.throwOnPermanent) throw new Error("email delivery claim unavailable");
      return;
    }
    attempts += 1;
  } catch (error) {
    // Persistence/claim failure must reach queue retry. Sending without a claim
    // would bypass the durable ownership boundary.
    throw error;
  }

  const out = await sendWithPolicy(
    {
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      from: msg.from,
      replyTo: msg.replyTo,
      attachments: msg.attachments,
      headers: { "X-AvaTOK-Outbox-Key": key, "X-AvaTOK-Kind": msg.kind ?? "email" },
    },
    env,
  );

  if (out.ok) {
    const acceptedAt = Date.now();
    let changes = 0;
    try {
      const accepted = await env.DB_META.prepare(
        `UPDATE email_outbox SET state='sent',delivery_status='provider_accepted',sent_at=?2,
           accepted_at=?2,provider_message_id=?3,provider=?5,fallback_used=?6,error_message=NULL,lease_expires_at=NULL,updated_at=?2
         WHERE outbox_key=?1 AND delivery_status='sending' AND attempts=?4`,
      ).bind(key, acceptedAt, out.messageId, attempts, out.provider, out.fallbackUsed ? 1 : 0).run();
      changes = accepted.meta?.changes ?? 0;
    } catch {
      // [EMAIL-CF-5] The mail is already out. If the 2026-09-11 provider columns
      // are missing (consumer deployed before the migration), record acceptance
      // with the pre-migration columns instead of leaving the row 'sending' -
      // lease expiry would otherwise re-send it on every recovery sweep.
      try {
        const accepted = await env.DB_META.prepare(
          `UPDATE email_outbox SET state='sent',delivery_status='provider_accepted',sent_at=?2,
             accepted_at=?2,provider_message_id=?3,error_message=NULL,lease_expires_at=NULL,updated_at=?2
           WHERE outbox_key=?1 AND delivery_status='sending' AND attempts=?4`,
        ).bind(key, acceptedAt, out.messageId, attempts).run();
        changes = accepted.meta?.changes ?? 0;
      } catch { throw new Error("email acceptance could not be recorded"); }
    }
    if (changes === 0) throw new Error("email acceptance could not be recorded");
    return;
  }

  if (out.terminal === "bounced") {
    const bouncedAt = Date.now();
    const bounced = await env.DB_META.prepare(
      `UPDATE email_outbox SET state='failed',delivery_status='bounced',bounced_at=?2,error_message=?3,
         attempts=?4,updated_at=?2,next_attempt_at=NULL,lease_expires_at=NULL
       WHERE outbox_key=?1 AND delivery_status='sending' AND attempts=?4`,
    ).bind(key, bouncedAt, out.error.slice(0, 500), attempts).run();
    if ((bounced.meta?.changes ?? 0) === 0) throw new Error("email failure could not be recorded");
    if (opts?.throwOnPermanent) throw new Error("email delivery bounced");
    return;
  }

  if (!await markFailure(env, key, out.error, attempts, out.retryable)) {
    throw new Error("email failure could not be recorded");
  }
  if (!out.retryable && opts?.throwOnPermanent) throw new Error(`email delivery rejected: ${out.error}`);
  if (attempts < maxAttempts && out.retryable) throw new Error(`email send failed: ${out.error}`);
  if (out.retryable && opts?.throwOnPermanent) throw new Error("email delivery retry budget exhausted");
  return;
}

export function emailDeliveryStatusFromRow(row: { delivery_status?: string | null; state?: string | null } | null): DeliveryStatus {
  return status(row);
}
