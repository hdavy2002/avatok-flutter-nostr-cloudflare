// [SUPPORT-QUEUE-1] Email queue messages carry IDs, never content.
//
// New shape: { job: 'send', outboxId, key }. The HTML body and attachments live in R2
// (BACKUP_R2, email-outbox/YYYY/MM/DD/<outboxId>/...) and the recipient/subject/from/replyTo
// live on the email_outbox row, all written by worker/src/lib/email_outbox.ts before the
// message was queued. This module loads them back and hands a normal EmailMsg to
// sendEmailDurably, so the claim/lease/Cloudflare->Brevo/status logic is unchanged.
//
// Legacy shape: the old full message ({to, subject, html, ...}) may still be sitting in the
// `email` queue at deploy time. It is passed straight to sendEmailDurably for one release.

import type { Env, EmailMsg } from "./types";
import { sendEmailDurably } from "./email_delivery";

export interface EmailJobMsg { job: "send"; outboxId: string; key: string }

export function isEmailJob(body: unknown): body is EmailJobMsg {
  const b = body as Partial<EmailJobMsg> | null;
  return !!b && b.job === "send" && typeof b.key === "string" && b.key.length > 0 && typeof b.outboxId === "string";
}

/** Retry schedule for the lane queues (seconds): 30s, 2m, 10m, 1h, 6h. `attempts` is Message.attempts (1-based). */
export const EMAIL_RETRY_DELAYS_S = [30, 120, 600, 3600, 21600] as const;
export function retryDelaySeconds(attempts: number): number {
  const i = Math.max(0, Math.min(EMAIL_RETRY_DELAYS_S.length - 1, Math.floor(attempts) - 1));
  return EMAIL_RETRY_DELAYS_S[i];
}

const OTP_KIND = /(^|[_:.-])otp([_:.-]|$)/i;

interface OutboxRow {
  state: string | null;
  delivery_status: string | null;
  outbox_id: string | null;
  to_email: string | null;
  subject: string | null;
  from_addr: string | null;
  reply_to_json: string | null;
  kind: string | null;
  order_id: string | null;
  recipient_id: string | null;
  message_version: string | null;
  body_r2_key: string | null;
  attachments_json: string | null;
  headers_json?: string | null;
}

async function failPermanently(env: Env, key: string, why: string): Promise<void> {
  try {
    await env.DB_META.prepare(
      `UPDATE email_outbox SET state='failed',delivery_status='failed',error_message=?2,next_attempt_at=NULL,lease_expires_at=NULL,updated_at=?3
       WHERE outbox_key=?1 AND delivery_status IN ('queued','failed')`,
    ).bind(key, why.slice(0, 500), Date.now()).run();
  } catch { /* the queue ack still happens; the row stays inspectable */ }
}

/** Resolve a queue body (new id-only job or legacy full message) and send it durably. */
export async function handleEmailQueueMessage(body: unknown, env: Env, opts?: { throwOnPermanent?: boolean }): Promise<void> {
  if (!isEmailJob(body)) {
    await sendEmailDurably(body as EmailMsg, env, { throwOnPermanent: opts?.throwOnPermanent ?? false });
    return;
  }
  const key = body.key;
  const baseCols = `state,delivery_status,outbox_id,to_email,subject,from_addr,reply_to_json,kind,order_id,recipient_id,
            message_version,body_r2_key,attachments_json`;
  // [HF-SUPPORT-1] headers_json is new; if the column is not migrated yet, fall back to the original query (no custom headers).
  let row: OutboxRow | null;
  try {
    row = await env.DB_META.prepare(`SELECT ${baseCols},headers_json FROM email_outbox WHERE outbox_key=?1 LIMIT 1`).bind(key).first<OutboxRow>();
  } catch {
    row = await env.DB_META.prepare(`SELECT ${baseCols} FROM email_outbox WHERE outbox_key=?1 LIMIT 1`).bind(key).first<OutboxRow>();
  }
  // No row: throw so the queue retries (then the DLQ) rather than silently dropping mail.
  if (!row) throw new Error(`email outbox row missing for ${key}`);
  if (row.outbox_id && row.outbox_id !== body.outboxId) {
    console.error(`[email-job] outboxId mismatch for ${key}`);
    return; // a stale/forged id: ack, never send
  }
  // Idempotency: already accepted/delivered/bounced rows are skipped before touching R2.
  if (["provider_accepted", "delivered", "bounced"].includes(String(row.delivery_status)) || row.state === "sent") return;

  if (!row.body_r2_key || !row.to_email || !row.subject) {
    await failPermanently(env, key, "outbox row has no stored message");
    return;
  }
  const r2 = env.BACKUP_R2;
  if (!r2) throw new Error("BACKUP_R2 binding missing on consumers worker");
  const bodyObj = await r2.get(row.body_r2_key);
  if (!bodyObj) {
    await failPermanently(env, key, "stored email body missing in R2");
    return;
  }
  const html = await bodyObj.text();

  const attachments: { name: string; content: string }[] = [];
  let refs: { name: string; key: string }[] = [];
  try { refs = row.attachments_json ? JSON.parse(row.attachments_json) : []; } catch { refs = []; }
  for (const ref of refs) {
    const obj = await r2.get(ref.key);
    if (!obj) {
      await failPermanently(env, key, `stored attachment missing in R2: ${ref.name}`.slice(0, 200));
      return;
    }
    attachments.push({ name: ref.name, content: await obj.text() });
  }

  let replyTo: EmailMsg["replyTo"];
  try { replyTo = row.reply_to_json ? JSON.parse(row.reply_to_json) : undefined; } catch { replyTo = undefined; }

  let headers: EmailMsg["headers"];
  try { headers = row.headers_json ? JSON.parse(row.headers_json) : undefined; } catch { headers = undefined; }
  // [HF-DESK-CW-3] Cc / Bcc ride in headers_json under reserved keys; they are recipients, never sent as headers (Bcc must stay hidden).
  const { cc, bcc, headers: sendHeaders } = splitRecipientHeaders(headers);

  await sendEmailDurably({
    headers: sendHeaders,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    to: row.to_email,
    subject: row.subject,
    html,
    outboxKey: key,
    kind: row.kind ?? undefined,
    orderId: row.order_id,
    recipientId: row.recipient_id,
    messageVersion: row.message_version ?? undefined,
    from: row.from_addr ?? undefined,
    replyTo,
    attachments: attachments.length ? attachments : undefined,
  }, env, { throwOnPermanent: opts?.throwOnPermanent ?? false });

  // A login code has no business sitting in R2 once the provider has it. Best-effort.
  if (row.kind && OTP_KIND.test(row.kind)) {
    try {
      const done = await env.DB_META.prepare("SELECT delivery_status FROM email_outbox WHERE outbox_key=?1").bind(key).first<{ delivery_status: string | null }>();
      if (done && ["provider_accepted", "delivered"].includes(String(done.delivery_status))) await r2.delete(row.body_r2_key);
    } catch { /* retention sweep will catch it */ }
  }
}

/** Dead-letter handler for email-priority-dlq / email-bulk-dlq: mark the row failed so it is visible, then ack. */
export async function handleEmailDlq(body: unknown, env: Env): Promise<void> {
  if (!isEmailJob(body)) { console.error("[email-dlq] unrecognised message dropped"); return; }
  await failPermanently(env, body.key, "dead-lettered after queue retries");
  console.error(`[email-dlq] ${body.key} dead-lettered`);
}

/** [HF-DESK-CW-3] Pull X-HF-Cc / X-HF-Bcc (comma-separated addresses) out of the stored headers. */
export function splitRecipientHeaders(h: Record<string, string> | undefined): { cc: string[]; bcc: string[]; headers: Record<string, string> | undefined } {
  if (!h) return { cc: [], bcc: [], headers: h };
  const rest: Record<string, string> = {};
  let cc: string[] = [];
  let bcc: string[] = [];
  const list = (v: string) => v.split(",").map((x) => x.trim()).filter((x) => /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(x)).slice(0, 10);
  for (const [k, v] of Object.entries(h)) {
    if (/^x-hf-cc$/i.test(k)) cc = list(String(v));
    else if (/^x-hf-bcc$/i.test(k)) bcc = list(String(v));
    else rest[k] = v;
  }
  return { cc, bcc, headers: Object.keys(rest).length ? rest : undefined };
}
