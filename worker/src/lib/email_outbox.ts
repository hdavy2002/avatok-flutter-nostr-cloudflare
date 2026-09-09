import type { Env } from "../types";

/**
 * Durable email hand-off shared by checkout, lifecycle mail and future reminder
 * producers. `provider_accepted` means Brevo accepted the request; it is not a
 * delivery receipt. Only a signed provider callback may move a row to delivered.
 */
export type EmailDeliveryStatus = "queued" | "sending" | "provider_accepted" | "delivered" | "failed" | "bounced";
export type EmailQueueStatus = EmailDeliveryStatus | "unavailable";

export interface DurableEmailMessage {
  to: string;
  subject: string;
  html: string;
  outboxKey?: string;
  kind?: string;
  orderId?: string | null;
  recipientId?: string | null;
  messageVersion?: string;
  from?: string;
  replyTo?: { email: string; name?: string };
  attachments?: { name: string; content: string }[];
}

export interface EmailQueueResult {
  outboxKey: string;
  status: EmailQueueStatus;
  queued: boolean;
  durable: boolean;
}

const DEFAULT_KIND = "commercial_email";
const DEFAULT_VERSION = "email.v1";
const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable identity for the commercial confirmation. Rendering changes do not duplicate mail. */
export function commercialEmailKey(orderId: string, recipientId: string, version = "commercial-confirmation.v1"): string {
  return `commercial-email:${orderId}:${recipientId}:${version}`;
}

function fallbackKey(msg: DurableEmailMessage): Promise<string> {
  return digest(JSON.stringify({ to: msg.to, subject: msg.subject, html: msg.html, attachments: msg.attachments ?? [] }));
}

function statusFromRow(row: { delivery_status?: string | null; state?: string | null } | null): EmailDeliveryStatus {
  const status = row?.delivery_status;
  if (status === "queued" || status === "sending" || status === "provider_accepted" || status === "delivered" || status === "failed" || status === "bounced") return status;
  if (row?.state === "sending") return "sending";
  if (row?.state === "sent") return "provider_accepted";
  if (row?.state === "failed") return "failed";
  return "queued";
}

/**
 * Persist the full provider payload before queueing it. If the new migration is
 * not deployed yet, the producer reports a bookkeeping failure and does not
 * send an unrecoverable payload. A successful purchase is never rolled back
 * for that email failure; the authenticated resend can recover after rollout.
 */
export async function enqueueEmail(env: Env, input: DurableEmailMessage): Promise<EmailQueueResult> {
  const key = input.outboxKey ?? await fallbackKey(input);
  const now = Date.now();
  const payload = JSON.stringify({ ...input, outboxKey: key });
  let existing: { state: string; delivery_status: string | null } | null = null;
  let durable = true;
  try {
    existing = await env.DB_META.prepare(
      "SELECT state,delivery_status FROM email_outbox WHERE outbox_key=?1 LIMIT 1",
    ).bind(key).first<{ state: string; delivery_status: string | null }>() ?? null;
    if (existing) {
      const existingStatus = statusFromRow(existing);
      if (existingStatus === "provider_accepted" || existingStatus === "delivered") {
        return { outboxKey: key, status: existingStatus, queued: false, durable: true };
      }
      if (existingStatus === "bounced" || existingStatus === "failed") {
        return { outboxKey: key, status: "failed", queued: false, durable: true };
      }
      if (existingStatus === "sending") {
        return { outboxKey: key, status: "sending", queued: false, durable: true };
      }
    }
    if (!existing) {
      await env.DB_META.prepare(
        `INSERT OR IGNORE INTO email_outbox
          (outbox_key,kind,state,payload_json,delivery_status,recipient_id,order_id,message_version,
           attempts,max_attempts,created_at,updated_at,next_attempt_at)
         VALUES (?1,?2,'pending',?3,'queued',?4,?5,?6,0,?7,?8,?8,?8)`,
      ).bind(key, input.kind ?? DEFAULT_KIND, payload, input.recipientId ?? null, input.orderId ?? null,
        input.messageVersion ?? DEFAULT_VERSION, MAX_ATTEMPTS, now).run();
    }
  } catch {
    // A missing/unavailable outbox is a real bookkeeping failure. Do not tell
    // checkout that mail is queued and do not send a payload that cannot be
    // recovered or inspected; the account can use the authenticated resend.
    return { outboxKey: key, status: "failed", queued: false, durable: false };
  }

  try {
    await env.Q_EMAIL.send({ ...input, outboxKey: key, kind: input.kind ?? DEFAULT_KIND, orderId: input.orderId ?? null, recipientId: input.recipientId ?? null, messageVersion: input.messageVersion ?? DEFAULT_VERSION });
    try {
      await env.DB_META.prepare(
        "UPDATE email_outbox SET state='pending',delivery_status='queued',queue_accepted_at=?2,updated_at=?2,next_attempt_at=?2 WHERE outbox_key=?1 AND state='pending' AND delivery_status='queued'",
      ).bind(key, now).run();
    } catch { /* the row remains queued; a concurrent consumer may own it */ }
    return { outboxKey: key, status: durable ? "queued" : "failed", queued: true, durable };
  } catch (error) {
    try {
      await env.DB_META.prepare(
        "UPDATE email_outbox SET state='failed',delivery_status='failed',error_message=?2,updated_at=?3,next_attempt_at=?3 WHERE outbox_key=?1 AND delivery_status IN ('queued','pending')",
      ).bind(key, String(error).slice(0, 500), Date.now()).run();
    } catch { /* preserve the purchase result */ }
    return { outboxKey: key, status: "failed", queued: false, durable };
  }
}

export async function verifiedClerkEmail(env: Env, uid: string): Promise<string | null> {
  if (!env.CLERK_SECRET_KEY || !uid) return null;
  try {
    // Auth resolves aliases to the canonical account uid. A deleted/recreated
    // Clerk user is still allowed to receive mail, but only through this
    // server-owned alias table and only when the current primary address is
    // verified. The canonical recipient id remains the outbox dedupe identity.
    let aliasIds: string[] = [];
    try {
      const aliases = await env.DB_META.prepare(
        "SELECT alias_clerk_id FROM clerk_uid_alias WHERE canonical_uid=?1 ORDER BY created_at DESC",
      ).bind(uid).all<{ alias_clerk_id: string }>();
      aliasIds = ((aliases.results ?? []) as Array<{ alias_clerk_id: string }>).map((row) => row.alias_clerk_id);
    } catch { /* alias migration may lag; the canonical id still works */ }
    const candidates = [uid, ...aliasIds];
    for (const candidate of candidates) {
      const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(candidate)}`, {
        headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
      });
      if (!response.ok) continue;
      const user = await response.json() as {
        primary_email_address_id?: string;
        email_addresses?: Array<{ id?: string; email_address?: string; verification?: { status?: string } }>;
      };
      const addresses = user.email_addresses ?? [];
      const primary = addresses.find((item) => item.id === user.primary_email_address_id) ?? addresses[0];
      if (primary?.email_address && primary.verification?.status === "verified") return primary.email_address;
    }
    return null;
  } catch {
    return null;
  }
}

/** Requeue rows left pending or with an expired sending lease after a Worker crash. */
export async function recoverEmailOutbox(env: Env, limit = 50): Promise<number> {
  const now = Date.now();
  let rows: Array<{ outbox_key: string; payload_json: string; delivery_status: string }> = [];
  try {
    await env.DB_META.prepare(
      `UPDATE email_outbox SET state='failed',delivery_status='failed',error_message='retry budget exhausted',
         lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?1
       WHERE delivery_status='sending' AND lease_expires_at IS NOT NULL AND lease_expires_at<?1
         AND attempts>=max_attempts`,
    ).bind(now).run();
    await env.DB_META.prepare(
      `UPDATE email_outbox SET state='pending',delivery_status='queued',lease_expires_at=NULL,updated_at=?1
       WHERE delivery_status='sending' AND lease_expires_at IS NOT NULL AND lease_expires_at<?1
         AND attempts<max_attempts`,
    ).bind(now).run();
    const result = await env.DB_META.prepare(
      `SELECT outbox_key,payload_json,delivery_status FROM email_outbox
       WHERE delivery_status IN ('queued','failed') AND attempts<max_attempts
         AND next_attempt_at IS NOT NULL AND next_attempt_at<=?1
       ORDER BY created_at LIMIT ?2`,
    ).bind(now, Math.max(1, Math.min(100, limit))).all<{ outbox_key: string; payload_json: string; delivery_status: string }>();
    rows = (result.results ?? []) as Array<{ outbox_key: string; payload_json: string; delivery_status: string }>;
  } catch {
    return 0;
  }
  let queued = 0;
  for (const row of rows) {
    try {
      // Failed rows are terminal to ordinary producers. Recovery owns the
      // explicit transition back to queued, guarded by the retry timestamp.
      if (row.delivery_status === "failed") {
        const reopened = await env.DB_META.prepare(
          `UPDATE email_outbox SET state='pending',delivery_status='queued',lease_expires_at=NULL,
             updated_at=?2 WHERE outbox_key=?1 AND delivery_status='failed'
             AND next_attempt_at IS NOT NULL AND next_attempt_at<=?2 AND attempts<max_attempts`,
        ).bind(row.outbox_key, now).run();
        if ((reopened.meta?.changes ?? 0) === 0) continue;
      }
      const msg = JSON.parse(row.payload_json) as DurableEmailMessage;
      const result = await enqueueEmail(env, { ...msg, outboxKey: row.outbox_key });
      if (result.queued) queued++;
    } catch { /* leave row eligible for the next sweep */ }
  }
  return queued;
}

export const EMAIL_OUTBOX_CONSTANTS = { MAX_ATTEMPTS, LEASE_MS } as const;
