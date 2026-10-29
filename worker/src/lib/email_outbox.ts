import type { Env } from "../types";
import { isPlaceholderEmail } from "./placeholder_email";
import { safeQueueSend } from "./queue_guard";

/**
 * Durable email hand-off shared by checkout, lifecycle mail and future reminder
 * producers. Transport is Cloudflare Email Service (Brevo fallback);
 * `provider_accepted` means the sending provider accepted the request, it is
 * not a delivery receipt. Only a provider event (Cloudflare's `email-events`
 * queue consumer for Cloudflare sends; no webhook exists for Brevo) may move
 * a row to delivered.
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
  /**
   * [HF-SUPPORT-1] Extra RFC 5322 headers (Message-ID, In-Reply-To, References, Auto-Submitted) so support mail threads.
   * Stored on the outbox row (headers_json, migration 2026-10-29-hf-support-email-outbox-headers.sql) and sent by the consumer.
   * Absent for every other producer; nothing changes for them.
   */
  headers?: Record<string, string>;
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

/** Delivery lane. priority = OTP + human-reply mail; bulk = receipts, statements, acknowledgements. */
export type EmailLane = "priority" | "bulk";

export interface EnqueueEmailOptions {
  lane?: EmailLane;
  /**
   * For fire-and-forget producers that used to call `Q_EMAIL.send` directly (OTP, receipts...).
   * If the store-then-queue-ID path itself fails (R2/D1 hiccup, migration not applied yet) AND the
   * message is small enough for the 16 KB queue guard, fall back to the legacy inline shape the
   * consumer still accepts, so a bookkeeping failure never silently drops a login code.
   * Strict callers (checkout) leave this off: they must not send what they cannot inspect.
   */
  inlineFallback?: boolean;
}

/** The ONLY thing an email queue carries now: ids. The consumer loads the row + R2 objects. */
export interface EmailSendJob {
  job: "send";
  outboxId: string;
  key: string;
}

const PRIORITY_KIND = /(^|[_:.-])(otp|reply|verify|verification|login|support_reply)([_:.-]|$)/i;

export function defaultEmailLane(kind?: string): EmailLane {
  return kind && PRIORITY_KIND.test(kind) ? "priority" : "bulk";
}

/** Lane queue; falls back to the legacy `email` queue where the lane queues are not bound (tests, staging). */
export function emailQueueFor(env: Env, lane: EmailLane): Queue {
  const q = lane === "priority" ? env.Q_EMAIL_PRIORITY : env.Q_EMAIL_BULK;
  return q ?? env.Q_EMAIL;
}

function safeObjectName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";
}

interface StoredEmailBlobs {
  bodyKey: string;
  attachments: { name: string; key: string }[];
}

/** R2 layout: email-outbox/YYYY/MM/DD/<outboxId>/body.html and att-<n>-<name> (base64 text). */
async function storeEmailBlobs(env: Env, outboxId: string, input: DurableEmailMessage, now: number): Promise<StoredEmailBlobs> {
  const d = new Date(now);
  const day = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
  const prefix = `email-outbox/${day}/${outboxId}`;
  const bodyKey = `${prefix}/body.html`;
  await env.BACKUP_R2.put(bodyKey, input.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  const attachments: { name: string; key: string }[] = [];
  let i = 0;
  for (const att of input.attachments ?? []) {
    const key = `${prefix}/att-${i++}-${safeObjectName(att.name)}`;
    await env.BACKUP_R2.put(key, att.content, { httpMetadata: { contentType: "text/plain" }, customMetadata: { name: att.name.slice(0, 200), encoding: "base64" } });
    attachments.push({ name: att.name, key });
  }
  return { bodyKey, attachments };
}

async function sendJob(env: Env, lane: EmailLane, outboxId: string, key: string): Promise<void> {
  const job: EmailSendJob = { job: "send", outboxId, key };
  await safeQueueSend(emailQueueFor(env, lane), job);
}

/**
 * [SUPPORT-QUEUE-1] Store-then-queue-ID. The HTML body and every attachment go to R2 and the
 * recipient/subject/from/replyTo/kind/lane/R2 keys go on the `email_outbox` row BEFORE anything
 * is queued; the queue message is just `{job:'send', outboxId, key}`. The email consumer loads the
 * row + objects and sends through the Cloudflare Email Service / Brevo path.
 *
 * If the migration (2026-10-29-support-queue-1-email-outbox-r2.sql) is not deployed yet, the
 * producer reports a bookkeeping failure and does not send an unrecoverable payload, unless the
 * caller opted into `inlineFallback`. A successful purchase is never rolled back for that email
 * failure; the authenticated resend can recover after rollout.
 */
export async function enqueueEmail(env: Env, input: DurableEmailMessage, opts: EnqueueEmailOptions = {}): Promise<EmailQueueResult> {
  const lane = opts.lane ?? defaultEmailLane(input.kind);
  const key = input.outboxKey ?? await fallbackKey(input);
  const now = Date.now();
  let outboxId = "";
  let durable = true;
  try {
    const existing = await env.DB_META.prepare(
      "SELECT state,delivery_status,outbox_id,body_r2_key FROM email_outbox WHERE outbox_key=?1 LIMIT 1",
    ).bind(key).first<{ state: string; delivery_status: string | null; outbox_id: string | null; body_r2_key: string | null }>() ?? null;
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
      outboxId = crypto.randomUUID();
      const stored = await storeEmailBlobs(env, outboxId, input, now);
      const inserted = await env.DB_META.prepare(
        `INSERT OR IGNORE INTO email_outbox
          (outbox_key,kind,state,payload_json,delivery_status,recipient_id,order_id,message_version,
           attempts,max_attempts,created_at,updated_at,next_attempt_at,
           outbox_id,to_email,subject,from_addr,reply_to_json,body_r2_key,attachments_json,lane)
         VALUES (?1,?2,'pending',?3,'queued',?4,?5,?6,0,?7,?8,?8,?8,?9,?10,?11,?12,?13,?14,?15,?16)`,
      ).bind(key, input.kind ?? DEFAULT_KIND, JSON.stringify({ v: 2, outboxId, lane }), input.recipientId ?? null, input.orderId ?? null,
        input.messageVersion ?? DEFAULT_VERSION, MAX_ATTEMPTS, now,
        outboxId, input.to, input.subject, input.from ?? null, input.replyTo ? JSON.stringify(input.replyTo) : null,
        stored.bodyKey, JSON.stringify(stored.attachments), lane).run();
      if ((inserted.meta?.changes ?? 0) === 0) {
        // Another producer created the row between our SELECT and INSERT: use its id.
        const winner = await env.DB_META.prepare("SELECT outbox_id FROM email_outbox WHERE outbox_key=?1 LIMIT 1")
          .bind(key).first<{ outbox_id: string | null }>();
        outboxId = winner?.outbox_id ?? outboxId;
      } else if (input.headers && Object.keys(input.headers).length) {
        // [HF-SUPPORT-1] Separate statement, only for messages that carry headers: if the column is not migrated yet the
        // mail still goes out (without the threading headers; the [HF-N] subject tag and Reply-To still thread it).
        try {
          await env.DB_META.prepare("UPDATE email_outbox SET headers_json=?2 WHERE outbox_key=?1").bind(key, JSON.stringify(input.headers)).run();
        } catch { /* headers_json column missing: send without custom headers */ }
      }
    } else if (!existing.body_r2_key) {
      // Legacy row (inline payload_json, pre-migration): upgrade it to R2-backed storage in place.
      outboxId = existing.outbox_id ?? crypto.randomUUID();
      const stored = await storeEmailBlobs(env, outboxId, input, now);
      await env.DB_META.prepare(
        `UPDATE email_outbox SET outbox_id=?2,to_email=?3,subject=?4,from_addr=?5,reply_to_json=?6,
           body_r2_key=?7,attachments_json=?8,lane=?9,updated_at=?10
         WHERE outbox_key=?1 AND body_r2_key IS NULL`,
      ).bind(key, outboxId, input.to, input.subject, input.from ?? null, input.replyTo ? JSON.stringify(input.replyTo) : null,
        stored.bodyKey, JSON.stringify(stored.attachments), lane, now).run();
    } else {
      outboxId = existing.outbox_id ?? "";
    }
  } catch {
    // A missing/unavailable outbox is a real bookkeeping failure. Do not tell checkout that mail
    // is queued and do not send a payload that cannot be recovered or inspected; the account can
    // use the authenticated resend. Fire-and-forget producers may opt into the small legacy shape.
    if (opts.inlineFallback) {
      try {
        await safeQueueSend(env.Q_EMAIL, { ...input, outboxKey: key, kind: input.kind ?? DEFAULT_KIND, orderId: input.orderId ?? null, recipientId: input.recipientId ?? null, messageVersion: input.messageVersion ?? DEFAULT_VERSION });
        return { outboxKey: key, status: "queued", queued: true, durable: false };
      } catch { /* too large or queue down: fall through to the failure result */ }
    }
    return { outboxKey: key, status: "failed", queued: false, durable: false };
  }

  try {
    await sendJob(env, lane, outboxId, key);
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
      if (primary?.email_address && primary.verification?.status === "verified" && !isPlaceholderEmail(primary.email_address)) return primary.email_address; // [HF-WIRE-17]
    }
    return null;
  } catch {
    return null;
  }
}

/** Requeue rows left pending or with an expired sending lease after a Worker crash. */
export async function recoverEmailOutbox(env: Env, limit = 50): Promise<number> {
  const now = Date.now();
  type RecoverRow = { outbox_key: string; payload_json: string; delivery_status: string; outbox_id: string | null; body_r2_key: string | null; lane: string | null };
  let rows: RecoverRow[] = [];
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
      `SELECT outbox_key,payload_json,delivery_status,outbox_id,body_r2_key,lane FROM email_outbox
       WHERE delivery_status IN ('queued','failed') AND attempts<max_attempts
         AND next_attempt_at IS NOT NULL AND next_attempt_at<=?1
       ORDER BY created_at LIMIT ?2`,
    ).bind(now, Math.max(1, Math.min(100, limit))).all<RecoverRow>();
    rows = (result.results ?? []) as RecoverRow[];
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
      const lane: EmailLane = row.lane === "priority" ? "priority" : "bulk";
      if (row.body_r2_key && row.outbox_id) {
        // Content already lives in R2: re-send the id only.
        await sendJob(env, lane, row.outbox_id, row.outbox_key);
        queued++;
        continue;
      }
      // Legacy row with the full payload inline: upgrade it to R2-backed storage and queue the id.
      const msg = JSON.parse(row.payload_json) as DurableEmailMessage;
      if (typeof msg.html !== "string") continue;
      const result = await enqueueEmail(env, { ...msg, outboxKey: row.outbox_key }, { lane });
      if (result.queued) queued++;
    } catch { /* leave row eligible for the next sweep */ }
  }
  return queued;
}

export const EMAIL_OUTBOX_CONSTANTS = { MAX_ATTEMPTS, LEASE_MS } as const;
