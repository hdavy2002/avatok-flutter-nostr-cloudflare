// [HF-SUPPORT-1] Inbound support email.
//
//   Cloudflare Email Routing -> worker email() -> raw .eml streamed to R2 (support/inbound/YYYY/MM/DD/<uuid>.eml)
//     -> safeQueueSend {job:'inbound', r2Key, envFrom, envTo} to `support-inbound` (+ `support-inbound-dlq`)
//   -> consumer (handleSupportInboundQueue, batch of up to 50): parse, de-dupe, block/spam/loop checks, thread, create or append,
//      store attachments, apply the status rules, queue the follow-ups as ids (ack on the bulk lane, admin WhatsApp alert).
//
// The queue carries the R2 key and the two envelope addresses, never the mail. Every raw email also gets a support_inbound row, so
// a failed queue send is re-queued by the cron (recoverInbound) and the admin Queues page can show inbound health.
import type { Env } from "../types";
import { safeQueueSend } from "./queue_guard";
import {
  accountUidForEmail, addEvent, allocateTicketNumber, attachmentKey, checkAttachment, classifyMail, emailsOfTicketOwner, getTicket, htmlKey, inboundKey, loadSettings,
  mayAutoReply, MAX_MESSAGE_ATTACHMENT_BYTES, resolveThread, setTicketStatus, sha256Hex, spamScore, statusOnCustomerMessage, stripQuotedReply, upsertContact,
  HOUR_MS, MAX_AUTOREPLIES_PER_HOUR, isBusinessTime, ticketCode, type TicketRow, type MailClass, cleanTicketSubject, isValidReplyTag } from "./support_core";
import { htmlToPlainText, parseMime } from "./support_mime";
import { addMessage, createTicket, findIdenticalRecent, overDailyTicketLimit, textHash, type NewAttachmentRecord } from "./support_ops";
import { sendAck } from "./support_mail";
import { alertAdmin, flushAlertSummaries } from "./support_alerts";

export interface InboundJob { job: "inbound"; r2Key: string; envFrom?: string; envTo?: string }
export const MAX_RAW_BYTES = 30 * 1024 * 1024;

const isJob = (b: unknown): b is InboundJob => {
  const j = b as Partial<InboundJob> | null;
  return !!j && j.job === "inbound" && typeof j.r2Key === "string" && j.r2Key.startsWith("support/inbound/");
};

// ---------------------------------------------------------------------------------------------------------------------
// email() handler
// ---------------------------------------------------------------------------------------------------------------------
/** Store the raw message and queue its key. Never parses; never blocks on the desk logic. */
export async function handleInboundEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  if (message.rawSize > MAX_RAW_BYTES) { message.setReject("Message too large"); return; }
  const now = Date.now();
  const id = crypto.randomUUID();
  const r2Key = inboundKey(now, id);
  const fixed = new FixedLengthStream(message.rawSize);
  await Promise.all([
    message.raw.pipeTo(fixed.writable),
    env.BACKUP_R2.put(r2Key, fixed.readable, { customMetadata: { from: message.from.slice(0, 200), to: message.to.slice(0, 200) } }),
  ]);
  const job: InboundJob = { job: "inbound", r2Key, envFrom: message.from.slice(0, 200), envTo: message.to.slice(0, 200) };
  try {
    await env.DB_META.prepare("INSERT OR IGNORE INTO support_inbound (id,r2_key,env_from,env_to,status,created_at) VALUES (?1,?2,?3,?4,'received',?5)")
      .bind(id, r2Key, job.envFrom ?? null, job.envTo ?? null, now).run();
  } catch { /* the consumer re-creates the row from the job */ }
  try {
    if (!env.Q_SUPPORT_INBOUND) throw new Error("Q_SUPPORT_INBOUND not bound");
    await safeQueueSend(env.Q_SUPPORT_INBOUND, job);
  } catch (e) {
    // The .eml is safe in R2 and (usually) has a 'received' row: recoverInbound() re-queues it. Do not bounce the customer's mail.
    console.error("[support-inbound] queue send failed, cron will retry:", String(e));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// consumer
// ---------------------------------------------------------------------------------------------------------------------
export async function handleSupportInboundQueue(batch: MessageBatch, env: Env): Promise<void> {
  const q = batch.queue.replace(/-staging$/, "");
  const isDlq = q.endsWith("-dlq");
  for (const msg of batch.messages) {
    try {
      if (!isJob(msg.body)) { console.error(`[${q}] unrecognised message dropped`); msg.ack(); continue; }
      if (isDlq) {
        await env.DB_META.prepare("UPDATE support_inbound SET status='failed',reason='dead-lettered after queue retries',processed_at=?2 WHERE r2_key=?1 AND status IN ('received')")
          .bind(msg.body.r2Key, Date.now()).run();
        console.error(`[${q}] dead-lettered inbound mail ${msg.body.r2Key}`);
        msg.ack();
        continue;
      }
      await processInbound(env, msg.body);
      msg.ack();
    } catch (e) {
      console.error(`[${q}] retry:`, String(e));
      try { await env.DB_META.prepare("UPDATE support_inbound SET attempts=attempts+1,reason=?2 WHERE r2_key=?1").bind((msg.body as InboundJob).r2Key, String(e).slice(0, 200)).run(); } catch { /* best-effort */ }
      msg.retry({ delaySeconds: Math.min(3600, 30 * 2 ** Math.max(0, msg.attempts - 1)) });
    }
  }
  await flushAlertSummaries(env).catch(() => 0);
}

/** Cron safety net: re-queue 'received' rows whose queue send never happened or whose consumer never finished. */
export async function recoverInbound(env: Env, limit = 50, now = Date.now()): Promise<number> {
  if (!env.Q_SUPPORT_INBOUND) return 0;
  let rows: Array<{ r2_key: string; env_from: string | null; env_to: string | null }> = [];
  try {
    rows = (await env.DB_META.prepare(
      "SELECT r2_key,env_from,env_to FROM support_inbound WHERE status='received' AND created_at<?1 AND attempts<8 ORDER BY created_at LIMIT ?2",
    ).bind(now - 2 * 60_000, Math.max(1, Math.min(100, limit))).all<{ r2_key: string; env_from: string | null; env_to: string | null }>()).results ?? [];
  } catch { return 0; }
  let n = 0;
  for (const r of rows) {
    try {
      await safeQueueSend(env.Q_SUPPORT_INBOUND, { job: "inbound", r2Key: r.r2_key, envFrom: r.env_from ?? undefined, envTo: r.env_to ?? undefined } satisfies InboundJob);
      await env.DB_META.prepare("UPDATE support_inbound SET attempts=attempts+1 WHERE r2_key=?1").bind(r.r2_key).run();
      n++;
    } catch { /* next sweep */ }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// processing
// ---------------------------------------------------------------------------------------------------------------------
export type InboundOutcome =
  | { result: "created"; ticket: number; spam: boolean }
  | { result: "appended"; ticket: number; reopened: boolean }
  | { result: "linked_new"; ticket: number; from: number }
  | { result: "duplicate" | "dropped" | "already_done"; reason: string; ticket?: number }
  | { result: "failed"; reason: string };

async function finish(env: Env, r2Key: string, status: string, reason: string | null, ticket: number | null, messageId: string | null): Promise<void> {
  await env.DB_META.prepare("UPDATE support_inbound SET status=?2,reason=?3,ticket_number=?4,message_id=?5,processed_at=?6 WHERE r2_key=?1")
    .bind(r2Key, status, reason, ticket, messageId, Date.now()).run();
}

function domainsOf(email: string): string[] {
  const d = email.split("@")[1] ?? "";
  const parts = d.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

export async function isBlocked(env: Env, email: string): Promise<boolean> {
  const doms = domainsOf(email);
  const marks = doms.map((_, i) => `?${i + 2}`).join(",");
  try {
    const r = await env.DB_META.prepare(`SELECT 1 AS x FROM support_blocklist WHERE (kind='email' AND value=?1)${doms.length ? ` OR (kind='domain' AND value IN (${marks}))` : ""} LIMIT 1`)
      .bind(email, ...doms).first();
    return !!r;
  } catch { return false; }
}

function inferType(name: string, type: string): string {
  const t = type.split(";")[0].trim().toLowerCase();
  if (t && t !== "application/octet-stream") return t;
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "").toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", pdf: "application/pdf", txt: "text/plain" } as Record<string, string>)[ext] ?? t;
}

/**
 * In-Reply-To / References id -> ticket. Matches the id we generated (stored on support_messages), and also the id the
 * mail provider assigned when it accepted our send (email_outbox.provider_message_id): Cloudflare Email Service does not
 * let us set Message-ID, so the customer's mail client quotes the provider's id, not ours. The outbox key
 * (support-reply:<message row id> / support-ack:N / support-reminder:N) tells us which ticket that mail belonged to.
 */
export async function ticketForMessageId(env: Env, rawId: string): Promise<number | null> {
  const bare = rawId.trim().replace(/^<|>$/g, "");
  if (!bare) return null;
  const variants = [bare, `<${bare}>`];
  try {
    const own = await env.DB_META.prepare("SELECT ticket_number FROM support_messages WHERE message_id_header IN (?1,?2) LIMIT 1")
      .bind(variants[0], variants[1]).first<{ ticket_number: number }>();
    if (own?.ticket_number) return own.ticket_number;
  } catch { /* fall through to the provider-id lookup */ }
  try {
    const sent = await env.DB_META.prepare(
      "SELECT outbox_key FROM email_outbox WHERE provider_message_id IN (?1,?2) AND outbox_key LIKE 'support-%' LIMIT 1",
    ).bind(variants[0], variants[1]).first<{ outbox_key: string }>();
    const key = sent?.outbox_key ?? "";
    const reply = /^support-reply:(.+)$/.exec(key);
    if (reply) {
      const m = await env.DB_META.prepare("SELECT ticket_number FROM support_messages WHERE id=?1").bind(reply[1]).first<{ ticket_number: number }>();
      return m?.ticket_number ?? null;
    }
    const num = /^support-(?:ack|reminder):(\d+)$/.exec(key);
    if (num) return Number(num[1]);
  } catch { /* outbox columns missing: no provider-id threading */ }
  return null;
}

/** Process one stored email. Safe to run twice (Message-ID de-duplication + idempotent follow-up keys). */
export async function processInbound(env: Env, job: InboundJob, now = Date.now()): Promise<InboundOutcome> {
  const r2Key = job.r2Key;
  const row = await env.DB_META.prepare("SELECT status FROM support_inbound WHERE r2_key=?1").bind(r2Key).first<{ status: string }>().catch(() => null);
  if (!row) {
    await env.DB_META.prepare("INSERT OR IGNORE INTO support_inbound (id,r2_key,env_from,env_to,status,created_at) VALUES (?1,?2,?3,?4,'received',?5)")
      .bind(crypto.randomUUID(), r2Key, job.envFrom ?? null, job.envTo ?? null, now).run();
  } else if (row.status !== "received") return { result: "already_done", reason: row.status };

  const obj = await env.BACKUP_R2.get(r2Key);
  if (!obj) { await finish(env, r2Key, "failed", "eml_missing_in_r2", null, null); return { result: "failed", reason: "eml_missing_in_r2" }; }
  const raw = new Uint8Array(await obj.arrayBuffer());
  const mail = parseMime(raw);

  const envFrom = (job.envFrom ?? "").trim().toLowerCase().replace(/^<|>$/g, "");
  const from = mail.from?.email ?? (envFrom || null);
  const cls = classifyMail(mail, envFrom || null);
  const headerId = mail.messageId ?? `noid-${(await sha256Hex(bytesKey(raw))).slice(0, 40)}@inbound`;

  // 1. de-duplicate by Message-ID. Same raw file seen before = resume the follow-ups, a different file with the same id = duplicate.
  const seen = await env.DB_META.prepare("SELECT id,ticket_number,raw_r2_key FROM support_messages WHERE message_id_header=?1").bind(headerId).first<{ id: string; ticket_number: number; raw_r2_key: string | null }>();
  if (seen) {
    if (seen.raw_r2_key === r2Key) { await resumeFollowUps(env, seen.ticket_number, seen.id, cls, from, now); await finish(env, r2Key, "processed", "resumed", seen.ticket_number, headerId); return { result: "appended", ticket: seen.ticket_number, reopened: false }; }
    await finish(env, r2Key, "duplicate", "message_id", seen.ticket_number, headerId);
    return { result: "duplicate", reason: "message_id", ticket: seen.ticket_number };
  }

  if (!from) { await finish(env, r2Key, "dropped", "no_sender", null, headerId); return { result: "dropped", reason: "no_sender" }; }

  // 2. blocklist, our own mail coming back, bounces
  if (await isBlocked(env, from)) { await finish(env, r2Key, "dropped", "blocklist", null, headerId); return { result: "dropped", reason: "blocklist" }; }
  if (cls.loop) { await finish(env, r2Key, "dropped", "loop", null, headerId); return { result: "dropped", reason: "loop" }; }
  if (cls.bounce) { await finish(env, r2Key, "dropped", "bounce", null, headerId); return { result: "dropped", reason: "bounce" }; }

  // 3. which ticket? support+N recipient, [HF-N] subject tag, In-Reply-To / References
  const recipients = [job.envTo ?? "", ...mail.to.map((a) => a.email), ...mail.cc.map((a) => a.email),
    ...(mail.headers.get("delivered-to") ?? []), ...(mail.headers.get("x-original-to") ?? [])].map((x) => x.trim().toLowerCase()).filter(Boolean);
  const thread = await resolveThread(
    { recipients, subject: mail.subject, inReplyTo: mail.inReplyTo, references: mail.references },
    (id) => ticketForMessageId(env, id),
  );
  let existing: TicketRow | null = null;
  let mismatch = false;
  if (thread) {
    existing = await getTicket(env, thread.number);
    for (let hop = 0; existing?.merged_into && hop < 5; hop++) existing = await getTicket(env, existing.merged_into);
    if (existing) {
      // A ticket number alone is not a key: only the ticket owner's address may add to it. [HF-REPLY-ADDR-1] The one
      // exception is a reply to our tagged Reply-To (support+N-<tag>@): only people we emailed know that address, so
      // anyone on the thread (e.g. a Cc'd colleague) may answer into it.
      const signed = thread.source === "recipient" && !!thread.tag && thread.number === existing.number && await isValidReplyTag(env, thread.number, thread.tag);
      if (!signed) {
        const owners = await emailsOfTicketOwner(env, existing);
        if (!owners.includes(from)) { mismatch = true; existing = null; }
      }
    }
  }
  // Out-of-office / list replies never reopen or add to a thread.
  if (existing && (cls.autoReply || cls.list)) { await finish(env, r2Key, "dropped", "auto_reply_on_thread", existing.number, headerId); return { result: "dropped", reason: "auto_reply_on_thread", ticket: existing.number }; }

  // 4. body, identical-message merge
  const textFull = mail.text.trim() ? mail.text : htmlToPlainText(mail.html);
  const bodyText = (existing ? stripQuotedReply(textFull) : textFull).trim();
  const uid = await accountUidForEmail(env, from);
  const contactId = await upsertContact(env, { email: from, uid, name: mail.from?.name || null }, now);
  const hash = await textHash(bodyText || mail.subject);
  const dup = await findIdenticalRecent(env, contactId, hash, now);
  if (dup) { await finish(env, r2Key, "duplicate", "identical_10min", dup.ticket, headerId); return { result: "duplicate", reason: "identical_10min", ticket: dup.ticket }; }

  const settings = await loadSettings(env);

  // 5. decide the plan BEFORE storing attachments (they are filed under the ticket they end up on)
  type Plan =
    | { kind: "append"; ticket: TicketRow; status: "new" | "open"; reopened: boolean; reason: string | null }
    | { kind: "new"; linkedFrom: number | null; subject: string; category: string; isSpam: boolean; note: string | null };
  let plan: Plan;
  if (existing) {
    const t: TicketRow = existing;
    const act = statusOnCustomerMessage(t.status, t.solved_at, now);
    if (act.action === "ignore") { await finish(env, r2Key, "dropped", "ticket_is_spam", t.number, headerId); return { result: "dropped", reason: "ticket_is_spam", ticket: t.number }; }
    plan = act.action === "append"
      ? { kind: "append", ticket: t, status: act.status as "new" | "open", reopened: act.reopened, reason: null }
      : { kind: "new", linkedFrom: t.number, subject: t.subject, category: t.category, isSpam: false, note: `continues ${ticketCode(t.number)}` };
  } else {
    const verdict = spamScore(mail);
    const isSpam = verdict.isSpam && !uid;
    if (!isSpam && await overDailyTicketLimit(env, contactId, now)) {
      // 5 new tickets/day per person: add to their latest live ticket rather than open a sixth
      const latest = await env.DB_META.prepare(
        "SELECT number FROM support_tickets WHERE contact_id=?1 AND merged_into IS NULL AND status IN ('new','open','waiting','on_hold') ORDER BY updated_at DESC LIMIT 1",
      ).bind(contactId).first<{ number: number }>();
      if (!latest) { await finish(env, r2Key, "dropped", "daily_limit", null, headerId); return { result: "dropped", reason: "daily_limit" }; }
      plan = { kind: "append", ticket: (await getTicket(env, latest.number)) as TicketRow, status: "open", reopened: false, reason: "daily_limit_appended" };
    } else {
      const subject = cleanTicketSubject(mail.subject) || "(no subject)";
      plan = { kind: "new", linkedFrom: null, subject, category: "other", isSpam,
        note: mismatch ? "thread_hint_ignored_sender_mismatch" : (verdict.reasons.length ? `spam_signals:${verdict.reasons.join(",")}` : null) };
    }
  }

  const messageId = crypto.randomUUID();
  let newNumber: number | null = null;
  const filingNumber = async (): Promise<number> => (plan.kind === "append" ? plan.ticket.number : (newNumber ??= await allocateTicketNumber(env)));
  const stored: NewAttachmentRecord[] = [];
  const refused: string[] = [];
  let total = 0;
  for (const att of mail.attachments) {
    const type = inferType(att.filename, att.contentType);
    if (att.inline && type.startsWith("image/") && att.size < 30_000) continue; // signature logos / tracking pixels
    const verdictA = checkAttachment(att.filename, type, att.size);
    if (!verdictA.ok || total + att.size > MAX_MESSAGE_ATTACHMENT_BYTES) { refused.push(`${att.filename} (${verdictA.ok ? "too_large" : verdictA.reason})`); continue; }
    const number = await filingNumber();
    const id = crypto.randomUUID();
    const key = attachmentKey(number, id, att.filename);
    await env.BACKUP_R2.put(key, att.content, { httpMetadata: { contentType: type }, customMetadata: { name: att.filename.slice(0, 200) } });
    stored.push({ id, r2Key: key, name: att.filename.slice(0, 200), size: att.size, contentType: type });
    total += att.size;
  }
  let text = bodyText || "(no text)";
  if (refused.length) text += `\n\n[Not saved: ${refused.join(", ")}]`;

  let htmlKeyStored: string | null = null;
  if (mail.html.trim()) {
    const number = await filingNumber();
    htmlKeyStored = htmlKey(number, messageId);
    await env.BACKUP_R2.put(htmlKeyStored, mail.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  }
  const base = { id: messageId, authorName: mail.from?.name || from, text, htmlKey: htmlKeyStored, rawKey: r2Key, messageIdHeader: headerId, inReplyTo: mail.inReplyTo, hash, attachments: stored };

  // 6a. add to a live ticket (status rules already applied in the plan)
  if (plan.kind === "append") {
    const t = plan.ticket;
    await addMessage(env, t.number, { ...base, authorType: "customer", authorUid: uid, now });
    if (t.status !== plan.status && !(t.status === "new" && plan.status === "new")) await setTicketStatus(env, t, plan.status, "customer", now);
    if (plan.reopened) await addEvent(env, t.number, "customer", "reopened", { by: "customer_reply" }, now);
    if (uid && !t.uid) await env.DB_META.prepare("UPDATE support_tickets SET uid=?2 WHERE number=?1 AND uid IS NULL").bind(t.number, uid).run().catch(() => undefined);
    if (refused.length) await addEvent(env, t.number, "system", "attachment_refused", { files: refused }, now);
    await finish(env, r2Key, "processed", plan.reason, t.number, headerId);
    await runFollowUps(env, t.number, messageId, { cls, from, uid, afterHours: false, isNew: false }, now);
    return { result: "appended", ticket: t.number, reopened: plan.reopened };
  }

  // 6b. a new ticket (fresh thread, or a continuation of a closed one)
  const number = newNumber ?? await allocateTicketNumber(env);
  const quiet = plan.isSpam || !mayAutoReply(cls);
  const created = await createTicket(env, {
    number, uid, contactId, subject: plan.subject, category: plan.category, channel: "email", status: plan.isSpam ? "spam" : "new",
    linkedFrom: plan.linkedFrom, now, settings, writeAck: !quiet,
    message: { id: messageId, authorName: base.authorName, text, htmlKey: htmlKeyStored, rawKey: r2Key, messageIdHeader: headerId, inReplyTo: mail.inReplyTo, hash, attachments: stored },
  });
  if (plan.note) await addEvent(env, number, "system", "note", { info: plan.note }, now);
  if (refused.length) await addEvent(env, number, "system", "attachment_refused", { files: refused }, now);
  await finish(env, r2Key, plan.isSpam ? "spam" : "processed", plan.note, number, headerId);
  if (!plan.isSpam) await runFollowUps(env, number, messageId, { cls, from, uid, afterHours: created.afterHours, isNew: true }, now);
  return plan.linkedFrom ? { result: "linked_new", ticket: number, from: plan.linkedFrom } : { result: "created", ticket: number, spam: plan.isSpam };
}

const bytesKey = (raw: Uint8Array): string => {
  // cheap stable identity for mail without a Message-ID: length + head + tail
  let s = `${raw.length}:`;
  for (let i = 0; i < Math.min(512, raw.length); i++) s += String.fromCharCode(raw[i]);
  for (let i = Math.max(0, raw.length - 256); i < raw.length; i++) s += String.fromCharCode(raw[i]);
  return s;
};

interface FollowUpCtx { cls: MailClass; from: string; uid: string | null; afterHours: boolean; isNew: boolean }

/** Ack email (bulk lane, <= 3 per sender per hour, never to machines) and the admin alert. Both are idempotent by key. */
async function runFollowUps(env: Env, number: number, messageId: string, f: FollowUpCtx, now: number): Promise<void> {
  const t = await getTicket(env, number);
  if (!t || t.status === "spam") return;
  if (f.isNew && mayAutoReply(f.cls)) {
    const sent = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM support_autoreply_log WHERE recipient=?1 AND created_at>?2").bind(f.from, now - HOUR_MS).first<{ n: number }>().catch(() => null);
    const already = await env.DB_META.prepare("SELECT 1 AS x FROM email_outbox WHERE outbox_key=?1").bind(`support-ack:${number}`).first().catch(() => null);
    if (!already && Number(sent?.n ?? 0) < MAX_AUTOREPLIES_PER_HOUR) {
      await env.DB_META.prepare("INSERT INTO support_autoreply_log (recipient,kind,created_at) VALUES (?1,'ack',?2)").bind(f.from, now).run().catch(() => undefined);
      const r = await sendAck(env, t, f.from, { afterHours: f.afterHours, unknownSender: !f.uid }).catch(() => null);
      await addEvent(env, number, "system", "ack", { status: r?.status ?? "failed" }, now);
    }
  }
  await alertAdmin(env, f.isNew ? "new" : "reply", { number: t.number, subject: t.subject, category: t.category, priority: t.priority }, f.isNew ? String(number) : messageId, now).catch(() => "failed");
}

/** A retry found the message already stored by THIS email: redo only the (idempotent) follow-ups. */
async function resumeFollowUps(env: Env, number: number, messageId: string, cls: MailClass, from: string | null, now: number): Promise<void> {
  if (!from) return;
  const first = await env.DB_META.prepare("SELECT id FROM support_messages WHERE ticket_number=?1 AND author_type='customer' ORDER BY created_at LIMIT 1").bind(number).first<{ id: string }>();
  const uid = await accountUidForEmail(env, from);
  const settings = await loadSettings(env);
  await runFollowUps(env, number, messageId, { cls, from, uid, afterHours: !isBusinessTime(now, settings.hours, settings.holidays), isNew: first?.id === messageId }, now);
}
