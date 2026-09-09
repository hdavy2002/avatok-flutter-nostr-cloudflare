import type { Env, EmailMsg } from "./types";

type DeliveryStatus = "queued" | "sending" | "provider_accepted" | "delivered" | "failed" | "bounced";
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

function sender(from?: string): { name: string; email: string } {
  const fallback = { name: "AvaTok", email: "noreply@avatok.ai" };
  if (!from) return fallback;
  const match = from.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  return match ? { name: (match[1] || fallback.name).trim(), email: match[2].trim() } : { name: fallback.name, email: from.trim() };
}

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

/** Brevo queue handler. Provider acceptance is recorded separately from delivery. */
export async function sendEmailDurably(msg: EmailMsg, env: Env): Promise<void> {
  const key = await keyFor(msg);
  const now = Date.now();
  let attempts = 0;
  let maxAttempts = MAX_ATTEMPTS;
  try {
    await env.DB_META.prepare(
      `UPDATE email_outbox SET state='pending',delivery_status='queued',lease_expires_at=NULL,updated_at=?1
       WHERE outbox_key=?2 AND delivery_status='sending' AND lease_expires_at IS NOT NULL AND lease_expires_at<?1`,
    ).bind(now, key).run();
    const row = await env.DB_META.prepare(
      "SELECT state,delivery_status,attempts,max_attempts FROM email_outbox WHERE outbox_key=?1 LIMIT 1",
    ).bind(key).first<{ state: string; delivery_status: string | null; attempts: number; max_attempts: number }>();
    if (!row) {
      await env.DB_META.prepare(
        `INSERT OR IGNORE INTO email_outbox
          (outbox_key,kind,state,payload_json,delivery_status,recipient_id,order_id,message_version,
           attempts,max_attempts,created_at,updated_at,next_attempt_at)
         VALUES (?1,?2,'pending',?3,'queued',?4,?5,?6,0,?7,?8,?8,?8)`,
      ).bind(key, msg.kind ?? "email", JSON.stringify({ ...msg, outboxKey: key }), msg.recipientId ?? null,
        msg.orderId ?? null, msg.messageVersion ?? "email.v1", MAX_ATTEMPTS, now).run();
    } else if (["provider_accepted", "delivered", "bounced"].includes(status(row))) {
      // Checkout is idempotent by order/recipient/version. An authenticated
      // resend is the one deliberate exception: restart a previously accepted
      // attempt so the button has useful semantics. A bounced address remains
      // terminal because retrying it cannot produce delivery evidence.
      if (msg.force && ["provider_accepted", "delivered"].includes(status(row))) {
        await env.DB_META.prepare(
          `UPDATE email_outbox SET state='pending',delivery_status='queued',attempts=0,
             error_message=NULL,lease_expires_at=NULL,next_attempt_at=?2,updated_at=?2
           WHERE outbox_key=?1 AND delivery_status IN ('provider_accepted','delivered')`,
        ).bind(key, now).run();
        attempts = 0;
        maxAttempts = Number(row.max_attempts ?? MAX_ATTEMPTS);
      } else {
        return;
      }
    } else {
      attempts = Number(row.attempts ?? 0);
      maxAttempts = Number(row.max_attempts ?? MAX_ATTEMPTS);
    }
    const claim = await env.DB_META.prepare(
      `UPDATE email_outbox SET state='sending',delivery_status='sending',attempts=attempts+1,
         lease_expires_at=?2,updated_at=?3 WHERE outbox_key=?1
         AND delivery_status IN ('queued','failed') AND attempts<max_attempts`,
    ).bind(key, now + LEASE_MS, now).run();
    // Zero changes means another consumer owns the send, the row is terminal,
    // or retry budget is exhausted. Ack it; only the owner may call Brevo.
    if ((claim.meta?.changes ?? 0) === 0) return;
    attempts += 1;
  } catch (error) {
    // Persistence/claim failure must reach queue retry. Sending without a claim
    // would defeat the exactly-once boundary and can duplicate a purchase mail.
    throw error;
  }

  if (!env.BREVO_API_KEY) {
    if (!await markFailure(env, key, "BREVO_API_KEY is not configured", attempts)) throw new Error("email failure could not be recorded");
    return;
  }

  let response: Response;
  let responseText = "";
  try {
    response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: sender(msg.from),
        to: [{ email: msg.to }],
        ...(msg.replyTo?.email ? { replyTo: { email: msg.replyTo.email, ...(msg.replyTo.name ? { name: msg.replyTo.name } : {}) } } : {}),
        subject: msg.subject,
        htmlContent: msg.html,
        ...(msg.attachments?.length ? { attachment: msg.attachments.map((item) => ({ name: item.name, content: item.content })) } : {}),
      }),
    });
    // Read exactly once. The old implementation attempted response.text() twice,
    // so support received an empty error body after the first read.
    responseText = (await response.text()).slice(0, 2000);
  } catch (error) {
    if (!await markFailure(env, key, String(error), attempts)) throw new Error("email failure could not be recorded");
    if (attempts < maxAttempts) throw error;
    return;
  }

  if (!response.ok) {
    // HTTP errors are failures until a provider callback proves a bounce.
    const retryable = response.status === 429 || response.status >= 500;
    if (!await markFailure(env, key, `Brevo ${response.status}: ${responseText}`, attempts, retryable)) {
      throw new Error("email failure could not be recorded");
    }
    if (attempts < maxAttempts && retryable) throw new Error(`Brevo send failed: ${response.status}`);
    return;
  }

  let providerMessageId: string | null = null;
  try { providerMessageId = (JSON.parse(responseText) as { messageId?: string }).messageId ?? null; } catch { /* Brevo may return an empty 2xx body */ }
  try {
    const accepted = await env.DB_META.prepare(
      `UPDATE email_outbox SET state='sent',delivery_status='provider_accepted',sent_at=?2,
         accepted_at=?2,provider_message_id=?3,error_message=NULL,lease_expires_at=NULL,updated_at=?2
       WHERE outbox_key=?1 AND delivery_status='sending' AND attempts=?4`,
    ).bind(key, Date.now(), providerMessageId, attempts).run();
    if ((accepted.meta?.changes ?? 0) === 0) throw new Error("email acceptance claim was lost");
  } catch { throw new Error("email acceptance could not be recorded"); }
}

export function emailDeliveryStatusFromRow(row: { delivery_status?: string | null; state?: string | null } | null): DeliveryStatus {
  return status(row);
}
