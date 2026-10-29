// [SUPPORT-QUEUE-1] WhatsApp outbox + queues (whatsapp-priority / whatsapp-normal).
//
// Queues carry IDs, never content: enqueueWhatsApp() writes the text to
// `whatsapp_queue_outbox` (D1) and queues `{ job:'send', outboxId, key }`. The consumer
// (handleWhatsAppQueue, wired in index.ts queue()) loads the row and sends through the existing
// WasenderAPI code (lib/whatsapp_send.ts sendWhatsAppText).
//
// ⚠️ WasenderAPI is an UNOFFICIAL gateway riding one linked WhatsApp number: a burst risks a ban.
// Pacing = a D1 slot (queue_settings.whatsapp_last_send_at) shared by BOTH lanes, spaced by
// queue_settings.whatsapp_min_interval_ms (default 1000 = 1 msg/sec). A Durable Object token
// bucket would give strict priority/fairness; the D1 slot is the v1 simple version.
//
// Not the same as lib/whatsapp_notify.ts's cron-drained `whatsapp_outbox` (buyer notifications),
// which keeps its own table and its manual-reconcile rules. Result handling here mirrors it: a
// provider_error is AMBIGUOUS (the message may have gone out) and is never replayed.

import type { Env } from "../types";
import { safeQueueSend } from "./queue_guard";
import { sendWhatsAppText } from "./whatsapp_send";

export type WhatsAppLane = "priority" | "normal";

export interface WhatsAppEnqueueInput {
  to: string;            // E.164, e.g. +919876543210
  text: string;
  kind: string;          // e.g. 'otp', 'booking_reminder'
  lane?: WhatsAppLane;   // default 'normal'
  /** Idempotency key. Same key twice = one message. Omit only if duplicates are acceptable. */
  key?: string;
}

/** The ONLY thing a WhatsApp queue carries. */
export interface WhatsAppJob { job: "send"; outboxId: string; key: string }

export type WhatsAppEnqueueStatus = "queued" | "sending" | "sent" | "failed" | "manual_reconcile" | "invalid";
export interface WhatsAppEnqueueResult {
  outboxId: string | null;
  key: string;
  status: WhatsAppEnqueueStatus;
  /** true when a job was handed to the queue by this call */
  queued: boolean;
}

export const WA_MAX_TEXT_CHARS = 4096;
export const WA_MAX_ATTEMPTS = 5;
export const WA_RETRY_DELAYS_S = [30, 120, 600, 3600, 21600] as const;
const WA_DEFAULT_INTERVAL_MS = 1000;
const WA_CLAIM_STALE_MS = 5 * 60_000;
const E164 = /^\+\d{8,15}$/;

export function waRetryDelaySeconds(attempts: number): number {
  return WA_RETRY_DELAYS_S[Math.max(0, Math.min(WA_RETRY_DELAYS_S.length - 1, Math.floor(attempts) - 1))];
}

export function whatsAppQueueFor(env: Env, lane: WhatsAppLane): Queue | undefined {
  return lane === "priority" ? env.Q_WA_PRIORITY : env.Q_WA_NORMAL;
}

interface WaRow {
  id: string; idem_key: string; e164: string; message: string; kind: string; lane: string;
  status: string; attempts: number; updated_at: number;
}

export async function enqueueWhatsApp(env: Env, input: WhatsAppEnqueueInput): Promise<WhatsAppEnqueueResult> {
  const key = (input.key ?? "").trim() || `wa:${crypto.randomUUID()}`;
  const lane: WhatsAppLane = input.lane === "priority" ? "priority" : "normal";
  const to = (input.to ?? "").trim();
  if (!E164.test(to) || !input.text || input.text.length > WA_MAX_TEXT_CHARS || !input.kind) {
    return { outboxId: null, key, status: "invalid", queued: false };
  }
  const now = Date.now();
  const outboxId = crypto.randomUUID();
  let row: { id: string; status: string; lane: string } | null;
  try {
    await env.DB_META.prepare(
      `INSERT OR IGNORE INTO whatsapp_queue_outbox (id,idem_key,e164,message,kind,lane,status,attempts,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,'queued',0,?7,?7)`,
    ).bind(outboxId, key, to, input.text, input.kind, lane, now).run();
    row = await env.DB_META.prepare("SELECT id,status,lane FROM whatsapp_queue_outbox WHERE idem_key=?1 LIMIT 1")
      .bind(key).first<{ id: string; status: string; lane: string }>() ?? null;
  } catch {
    return { outboxId: null, key, status: "failed", queued: false };
  }
  if (!row) return { outboxId: null, key, status: "failed", queued: false };
  if (row.status !== "queued") return { outboxId: row.id, key, status: row.status as WhatsAppEnqueueStatus, queued: false };

  const queue = whatsAppQueueFor(env, row.lane === "priority" ? "priority" : "normal");
  if (!queue) {
    // Queue not provisioned: the row stays 'queued' and recoverWhatsAppQueue() picks it up later.
    return { outboxId: row.id, key, status: "queued", queued: false };
  }
  try {
    const job: WhatsAppJob = { job: "send", outboxId: row.id, key };
    await safeQueueSend(queue, job);
    await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET queue_accepted_at=?2 WHERE id=?1").bind(row.id, now).run().catch(() => undefined);
    return { outboxId: row.id, key, status: "queued", queued: true };
  } catch {
    return { outboxId: row.id, key, status: "queued", queued: false }; // row is durable; the sweep re-queues it
  }
}

/** Cron safety net: queue ids for rows whose queue send never happened (binding missing / send threw). */
export async function recoverWhatsAppQueue(env: Env, limit = 50): Promise<number> {
  const cutoff = Date.now() - 120_000;
  let rows: Array<{ id: string; idem_key: string; lane: string }> = [];
  try {
    const r = await env.DB_META.prepare(
      `SELECT id,idem_key,lane FROM whatsapp_queue_outbox
        WHERE status='queued' AND queue_accepted_at IS NULL AND created_at<?1 ORDER BY created_at LIMIT ?2`,
    ).bind(cutoff, Math.max(1, Math.min(100, limit))).all<{ id: string; idem_key: string; lane: string }>();
    rows = r.results ?? [];
  } catch { return 0; }
  let n = 0;
  for (const row of rows) {
    const queue = whatsAppQueueFor(env, row.lane === "priority" ? "priority" : "normal");
    if (!queue) continue;
    try {
      await safeQueueSend(queue, { job: "send", outboxId: row.id, key: row.idem_key } satisfies WhatsAppJob);
      await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET queue_accepted_at=?2 WHERE id=?1").bind(row.id, Date.now()).run();
      n++;
    } catch { /* next sweep */ }
  }
  return n;
}

function isJob(body: unknown): body is WhatsAppJob {
  const b = body as Partial<WhatsAppJob> | null;
  return !!b && b.job === "send" && typeof b.key === "string" && !!b.key && typeof b.outboxId === "string";
}

async function readIntervalMs(env: Env): Promise<number> {
  try {
    const r = await env.DB_META.prepare("SELECT value FROM queue_settings WHERE name='whatsapp_min_interval_ms'").first<{ value: number }>();
    const v = Number(r?.value);
    if (Number.isFinite(v) && v >= 0) return Math.min(60_000, Math.max(250, v));
  } catch { /* default */ }
  return WA_DEFAULT_INTERVAL_MS;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for the shared send slot (both lanes). Returns false if it could not be had in ~40 tries. */
export async function acquireWhatsAppSlot(env: Env, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<boolean> {
  const interval = await readIntervalMs(env);
  for (let i = 0; i < 40; i++) {
    const row = await env.DB_META.prepare("SELECT value FROM queue_settings WHERE name='whatsapp_last_send_at'").first<{ value: number }>();
    if (!row) {
      await env.DB_META.prepare("INSERT OR IGNORE INTO queue_settings (name,value,updated_at) VALUES ('whatsapp_last_send_at',0,0)").run();
      continue;
    }
    const last = Number(row.value);
    const now = Date.now();
    const wait = last + interval - now;
    if (wait > 0) { await sleep(Math.min(wait + Math.floor(Math.random() * 40), interval + 40)); continue; }
    const won = await env.DB_META.prepare("UPDATE queue_settings SET value=?2,updated_at=?2 WHERE name='whatsapp_last_send_at' AND value=?1")
      .bind(last, now).run();
    if ((won.meta?.changes ?? 0) > 0) return true;
  }
  return false;
}

export type WhatsAppJobOutcome = { done: true } | { done: false; retryAfterS: number };

/** One queue message. Never sends twice: sent/sending/manual_reconcile/failed rows are skipped. */
export async function processWhatsAppJob(env: Env, body: unknown, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<WhatsAppJobOutcome> {
  if (!isJob(body)) { console.error("[whatsapp-queue] unrecognised message dropped"); return { done: true }; }
  const row = await env.DB_META.prepare(
    "SELECT id,idem_key,e164,message,kind,lane,status,attempts,updated_at FROM whatsapp_queue_outbox WHERE idem_key=?1 LIMIT 1",
  ).bind(body.key).first<WaRow>();
  if (!row) throw new Error(`whatsapp outbox row missing for ${body.key}`); // retry, then DLQ
  if (row.id !== body.outboxId) { console.error(`[whatsapp-queue] outboxId mismatch for ${body.key}`); return { done: true }; }

  if (row.status === "sending") {
    // Another consumer owns it. A claim that has gone stale may have sent: ambiguous, never replay.
    if (Date.now() - row.updated_at > WA_CLAIM_STALE_MS) {
      await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET status='manual_reconcile',error='stale_claim_ambiguous',updated_at=?2 WHERE id=?1 AND status='sending'")
        .bind(row.id, Date.now()).run();
    }
    return { done: true };
  }
  if (row.status !== "queued") return { done: true }; // sent | failed | manual_reconcile

  if (row.attempts >= WA_MAX_ATTEMPTS) {
    await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET status='failed',error='retry budget exhausted',updated_at=?2 WHERE id=?1 AND status='queued'")
      .bind(row.id, Date.now()).run();
    return { done: true };
  }

  // Take the pacing slot BEFORE claiming, so a crash while waiting leaves a clean 'queued' row.
  if (!(await acquireWhatsAppSlot(env, opts.sleep))) return { done: false, retryAfterS: 10 };

  const claimAt = Date.now();
  const claim = await env.DB_META.prepare(
    "UPDATE whatsapp_queue_outbox SET status='sending',attempts=attempts+1,updated_at=?2 WHERE id=?1 AND status='queued'",
  ).bind(row.id, claimAt).run();
  if ((claim.meta?.changes ?? 0) === 0) return { done: true };
  const attempt = row.attempts + 1;

  const res = await sendWhatsAppText(env, row.e164, row.message); // never throws
  const now = Date.now();
  if (res.ok) {
    await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET status='sent',sent_at=?2,updated_at=?2,error=NULL WHERE id=?1 AND status='sending'")
      .bind(row.id, now).run();
    return { done: true };
  }
  if (res.reason === "rate_limited" || res.reason === "unconfigured") {
    // Known-not-accepted: safe to retry with backoff.
    if (attempt >= WA_MAX_ATTEMPTS) {
      await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET status='failed',error=?2,updated_at=?3 WHERE id=?1 AND status='sending'")
        .bind(row.id, `${res.reason}: ${res.detail}`.slice(0, 300), now).run();
      return { done: true };
    }
    await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET status='queued',error=?2,updated_at=?3 WHERE id=?1 AND status='sending'")
      .bind(row.id, `${res.reason}: ${res.detail}`.slice(0, 300), now).run();
    return { done: false, retryAfterS: waRetryDelaySeconds(attempt) };
  }
  if (res.reason === "not_on_whatsapp") {
    await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET status='failed',error='not_on_whatsapp',updated_at=?2 WHERE id=?1 AND status='sending'")
      .bind(row.id, now).run();
    return { done: true };
  }
  // provider_error: ambiguous. Park for a human; do not replay.
  await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET status='manual_reconcile',error=?2,updated_at=?3 WHERE id=?1 AND status='sending'")
    .bind(row.id, `ambiguous_provider_result: ${res.detail}`.slice(0, 300), now).run();
  return { done: true };
}

/** Queue() entry for whatsapp-priority / whatsapp-normal and their DLQs. */
export async function handleWhatsAppQueue(batch: MessageBatch, env: Env): Promise<void> {
  const q = batch.queue.replace(/-staging$/, "");
  const isDlq = q.endsWith("-dlq");
  for (const msg of batch.messages) {
    try {
      if (isDlq) {
        if (isJob(msg.body)) {
          await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET status='failed',error='dead-lettered after queue retries',updated_at=?2 WHERE idem_key=?1 AND status IN ('queued')")
            .bind(msg.body.key, Date.now()).run();
        }
        console.error(`[${q}] dead-lettered message acknowledged`);
        msg.ack();
        continue;
      }
      const out = await processWhatsAppJob(env, msg.body);
      if (out.done) msg.ack();
      else msg.retry({ delaySeconds: out.retryAfterS });
    } catch (e) {
      console.error(`[${q}] retry:`, String(e));
      msg.retry({ delaySeconds: waRetryDelaySeconds(msg.attempts) });
    }
  }
}
