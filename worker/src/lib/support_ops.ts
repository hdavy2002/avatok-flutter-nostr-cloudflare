// [HF-SUPPORT-1] Ticket writes shared by inbound mail, the customer API, the admin API and the cron: create a ticket, add a
// message (with its attachments and the ticket bookkeeping), validate pre-uploaded attachments, merge, split.
// Writes that must be all-or-nothing go through DB_META.batch (one D1 transaction).
import type { Env } from "../types";
import { BRAND } from "./brand";
import {
  addEvent, allocateTicketNumber, ackMessage, isBusinessTime, defaultPriority, isPriority, firstResponseDue, getTicket, isMoneyCategory, loadSettings, makePreview,
  MAX_MESSAGE_ATTACHMENT_BYTES, MAX_TEXT_CHARS, reindexTicket, setTicketStatus, ticketCode, clip, type SupportSettings, type TicketRow,
  IDENTICAL_WINDOW_MS, sha256Hex, normaliseForHash, DAY_MS, MAX_TICKETS_PER_DAY,
} from "./support_core";

export interface NewAttachmentRecord { id: string; r2Key: string; name: string; size: number; contentType: string }

export interface MessageArgs {
  authorType: "customer" | "staff" | "system" | "note";
  authorUid?: string | null;
  authorName?: string | null;
  text: string;
  htmlKey?: string | null;
  rawKey?: string | null;
  messageIdHeader?: string | null;
  inReplyTo?: string | null;
  hash?: string | null;
  now: number;
  /** Attachments already stored by the caller (inbound mail). */
  attachments?: NewAttachmentRecord[];
  /** Ids from POST /attachments (uploaded earlier by `uploaderUid`, not yet attached). */
  attachmentIds?: string[];
  uploaderUid?: string | null;
  /** Pre-chosen id (outgoing mail needs the id before the row exists). */
  id?: string;
}

const msgInsert = (env: Env, ticket: number, id: string, a: MessageArgs, text: string) =>
  env.DB_META.prepare(
    `INSERT INTO support_messages (id,ticket_number,author_type,author_uid,author_name,text,html_r2_key,raw_r2_key,preview,message_id_header,in_reply_to,hash,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
  ).bind(id, ticket, a.authorType, a.authorUid ?? null, a.authorName ?? null, text, a.htmlKey ?? null, a.rawKey ?? null, makePreview(text),
    a.messageIdHeader ?? null, a.inReplyTo ?? null, a.hash ?? null, a.now);

/** Statements that add a message, link its attachments and update the ticket's bookkeeping (preview, unread flags, timestamps). */
export function messageStatements(env: Env, ticket: number, a: MessageArgs): { id: string; statements: D1PreparedStatement[] } {
  const id = a.id ?? crypto.randomUUID();
  const text = a.text.length > MAX_TEXT_CHARS ? a.text.slice(0, MAX_TEXT_CHARS - 1) + "…" : a.text;
  const st: D1PreparedStatement[] = [msgInsert(env, ticket, id, a, text)];
  for (const att of a.attachments ?? []) {
    st.push(env.DB_META.prepare(
      "INSERT INTO support_attachments (id,r2_key,name,size,content_type,ticket_number,message_id,uid,purpose,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'ticket',?9)",
    ).bind(att.id, att.r2Key, att.name, att.size, att.contentType, ticket, id, a.authorUid ?? null, a.now));
  }
  for (const attId of a.attachmentIds ?? []) {
    st.push(env.DB_META.prepare(
      "UPDATE support_attachments SET ticket_number=?1,message_id=?2 WHERE id=?3 AND ticket_number IS NULL AND purpose='ticket' AND uid=?4",
    ).bind(ticket, id, attId, a.uploaderUid ?? a.authorUid ?? ""));
  }
  const p = makePreview(text);
  if (a.authorType === "customer") {
    st.push(env.DB_META.prepare("UPDATE support_tickets SET unread_staff=1,last_customer_at=?2,preview=?3,updated_at=?2 WHERE number=?1").bind(ticket, a.now, p));
  } else if (a.authorType === "staff") {
    st.push(env.DB_META.prepare(
      "UPDATE support_tickets SET unread_customer=1,last_staff_at=?2,first_responded_at=COALESCE(first_responded_at,?2),preview=?3,updated_at=?2 WHERE number=?1",
    ).bind(ticket, a.now, p));
  } else {
    st.push(env.DB_META.prepare("UPDATE support_tickets SET updated_at=MAX(updated_at,?2) WHERE number=?1").bind(ticket, a.now));
  }
  return { id, statements: st };
}

export async function addMessage(env: Env, ticket: number, a: MessageArgs): Promise<string> {
  const { id, statements } = messageStatements(env, ticket, a);
  await env.DB_META.batch(statements);
  return id;
}

export interface CreateTicketArgs {
  uid: string | null;
  contactId: number;
  subject: string;
  category: string;
  priority?: string;
  channel: "email" | "app" | "web";
  status?: "new" | "spam" | "open";
  linkedFrom?: number | null;
  meta?: unknown;
  now: number;
  settings?: SupportSettings;
  /** The customer's first message. */
  message: Omit<MessageArgs, "authorType" | "now"> & { authorName?: string | null };
  /** In-app note "Your ticket HF-N is open..." (not written for spam / machine-generated mail). */
  writeAck: boolean;
  number?: number;
}

/** Create the ticket, its first customer message, the in-app acknowledgement and the first event, in one transaction. */
export async function createTicket(env: Env, a: CreateTicketArgs): Promise<{ number: number; messageId: string; afterHours: boolean }> {
  const settings = a.settings ?? await loadSettings(env);
  const number = a.number ?? await allocateTicketNumber(env);
  const status = a.status ?? "new";
  // desk automation rules: category -> assignee / priority (not for spam; an explicit priority from the caller wins)
  const rule = status === "spam" ? undefined : settings.automations.find((r) => r.category === a.category);
  const priority = a.priority ?? (rule?.priority && isPriority(rule.priority) ? rule.priority : defaultPriority(a.category));
  const assignee = rule?.assigneeUid ?? null;
  const due = status === "spam" ? null : firstResponseDue(priority, a.now, settings.hours, settings.holidays);
  const subject = clip(a.subject.replace(/\s+/g, " ").trim() || "(no subject)", 200);
  const msg = messageStatements(env, number, { ...a.message, authorType: "customer", authorUid: a.uid, now: a.now });
  const st: D1PreparedStatement[] = [
    env.DB_META.prepare(
      `INSERT INTO support_tickets (number,uid,contact_id,subject,category,priority,status,channel,preview,last_customer_at,first_response_due_at,
         linked_from,money,unread_staff,meta_json,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'',?9,?10,?11,?12,?13,?14,?9,?9)`,
    ).bind(number, a.uid, a.contactId, subject, a.category, priority, status, a.channel, a.now, due, a.linkedFrom ?? null,
      isMoneyCategory(a.category) ? 1 : 0, status === "spam" ? 0 : 1, a.meta === undefined ? null : JSON.stringify(a.meta).slice(0, 2000)),
    ...(assignee ? [env.DB_META.prepare("UPDATE support_tickets SET assignee_uid=?2 WHERE number=?1").bind(number, assignee)] : []),
    ...msg.statements,
  ];
  const afterHours = !isBusinessTime(a.now, settings.hours, settings.holidays);
  if (status === "spam") st.push(env.DB_META.prepare("UPDATE support_tickets SET unread_staff=0 WHERE number=?1").bind(number));
  if (a.writeAck) {
    st.push(env.DB_META.prepare(
      `INSERT INTO support_messages (id,ticket_number,author_type,author_name,text,preview,created_at) VALUES (?1,?2,'system',?6,?3,?4,?5)`,
    ).bind(crypto.randomUUID(), number, ackMessage(number, a.now, settings), makePreview(ackMessage(number, a.now, settings)), a.now + 1, BRAND.name));
  }
  st.push(env.DB_META.prepare("INSERT INTO support_events (ticket_number,actor,type,data_json,created_at) VALUES (?1,?2,'created',?3,?4)")
    .bind(number, a.uid ?? "customer", JSON.stringify({ channel: a.channel, category: a.category, linkedFrom: a.linkedFrom ?? null }), a.now));
  await env.DB_META.batch(st);
  await reindexTicket(env, number);
  return { number, messageId: msg.id, afterHours };
}

// ---------------------------------------------------------------------------------------------------------------------
// attachments uploaded earlier (POST /api/hf/support/attachments)
// ---------------------------------------------------------------------------------------------------------------------
export type AttachmentIdsResult = { ok: true; ids: string[]; total: number } | { ok: false; error: "bad_attachment" | "attachments_too_large" };

/** The ids must be the caller's own, uploaded for a ticket, and not yet attached to a message. Total <= 25 MB. */
export async function checkAttachmentIds(env: Env, ids: unknown, uploaderUid: string): Promise<AttachmentIdsResult> {
  if (ids === undefined || ids === null) return { ok: true, ids: [], total: 0 };
  if (!Array.isArray(ids) || ids.length > 10 || ids.some((x) => typeof x !== "string" || !/^[0-9a-f-]{36}$/i.test(x))) return { ok: false, error: "bad_attachment" };
  const unique = [...new Set(ids as string[])];
  let total = 0;
  for (const id of unique) {
    const r = await env.DB_META.prepare("SELECT size FROM support_attachments WHERE id=?1 AND uid=?2 AND ticket_number IS NULL AND purpose='ticket'").bind(id, uploaderUid).first<{ size: number }>();
    if (!r) return { ok: false, error: "bad_attachment" };
    total += Number(r.size);
  }
  if (total > MAX_MESSAGE_ATTACHMENT_BYTES) return { ok: false, error: "attachments_too_large" };
  return { ok: true, ids: unique, total };
}

// ---------------------------------------------------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------------------------------------------------
/** Tickets this person opened in the last 24 hours (by contact, so the same person by email and by app counts together). */
export async function recentTicketCount(env: Env, contactId: number, now: number): Promise<number> {
  const r = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE contact_id=?1 AND created_at>?2 AND linked_from IS NULL").bind(contactId, now - DAY_MS).first<{ n: number }>();
  return Number(r?.n ?? 0);
}
export const overDailyTicketLimit = async (env: Env, contactId: number, now: number): Promise<boolean> =>
  (await recentTicketCount(env, contactId, now)) >= MAX_TICKETS_PER_DAY;

export async function textHash(text: string): Promise<string> { return sha256Hex(normaliseForHash(text)); }

/** The same person sent exactly this text in the last 10 minutes: return that message's ticket so the duplicate is merged, not stored twice. */
export async function findIdenticalRecent(env: Env, contactId: number, hash: string, now: number): Promise<{ ticket: number; messageId: string } | null> {
  const r = await env.DB_META.prepare(
    `SELECT m.id AS id, m.ticket_number AS ticket FROM support_messages m JOIN support_tickets t ON t.number=m.ticket_number
      WHERE t.contact_id=?1 AND m.author_type='customer' AND m.hash=?2 AND m.created_at>?3 ORDER BY m.created_at DESC LIMIT 1`,
  ).bind(contactId, hash, now - IDENTICAL_WINDOW_MS).first<{ id: string; ticket: number }>();
  return r ? { ticket: Number(r.ticket), messageId: r.id } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// merge / split
// ---------------------------------------------------------------------------------------------------------------------
export type MergeResult = { ok: true } | { ok: false; error: "not_found" | "same_ticket" | "different_customers" | "already_merged" };

/** Move every message and attachment of `from` into `into`; `from` becomes a closed ticket pointing at `into`. Same customer only. */
export async function mergeTickets(env: Env, fromNumber: number, intoNumber: number, actor: string, now = Date.now()): Promise<MergeResult> {
  if (fromNumber === intoNumber) return { ok: false, error: "same_ticket" };
  const [from, into] = await Promise.all([getTicket(env, fromNumber), getTicket(env, intoNumber)]);
  if (!from || !into) return { ok: false, error: "not_found" };
  if (from.merged_into || into.merged_into) return { ok: false, error: "already_merged" };
  if (from.contact_id !== into.contact_id && !(from.uid && from.uid === into.uid)) return { ok: false, error: "different_customers" };
  await env.DB_META.batch([
    env.DB_META.prepare("UPDATE support_messages SET ticket_number=?2 WHERE ticket_number=?1").bind(fromNumber, intoNumber),
    env.DB_META.prepare("UPDATE support_attachments SET ticket_number=?2 WHERE ticket_number=?1").bind(fromNumber, intoNumber),
    env.DB_META.prepare("UPDATE support_tickets SET status='closed',closed_at=?2,merged_into=?3,unread_staff=0,unread_customer=0,updated_at=?2 WHERE number=?1").bind(fromNumber, now, intoNumber),
    env.DB_META.prepare("UPDATE support_tickets SET unread_staff=MAX(unread_staff,?3),money=MAX(money,?4),updated_at=?2 WHERE number=?1").bind(intoNumber, now, from.unread_staff, from.money),
    env.DB_META.prepare(
      "INSERT INTO support_messages (id,ticket_number,author_type,author_name,text,preview,created_at) VALUES (?1,?2,'note','System',?3,?3,?4)",
    ).bind(crypto.randomUUID(), intoNumber, `${ticketCode(fromNumber)} was merged into this ticket.`, now),
  ]);
  await addEvent(env, fromNumber, actor, "merge", { into: intoNumber }, now);
  await addEvent(env, intoNumber, actor, "merge_in", { from: fromNumber }, now);
  await reindexTicket(env, fromNumber); await reindexTicket(env, intoNumber);
  return { ok: true };
}

export type SplitResult = { ok: true; number: number } | { ok: false; error: "not_found" | "cannot_split_first" | "not_customer_message" };

/** Move one customer message (and its attachments) out into a new ticket linked to the original. */
export async function splitTicket(env: Env, number: number, messageId: string, actor: string, now = Date.now()): Promise<SplitResult> {
  const t = await getTicket(env, number);
  const m = await env.DB_META.prepare("SELECT id,author_type,text,created_at FROM support_messages WHERE id=?1 AND ticket_number=?2").bind(messageId, number).first<{ id: string; author_type: string; text: string; created_at: number }>();
  if (!t || !m) return { ok: false, error: "not_found" };
  if (m.author_type !== "customer") return { ok: false, error: "not_customer_message" };
  const first = await env.DB_META.prepare("SELECT id FROM support_messages WHERE ticket_number=?1 AND author_type='customer' ORDER BY created_at LIMIT 1").bind(number).first<{ id: string }>();
  if (first?.id === messageId) return { ok: false, error: "cannot_split_first" };
  const settings = await loadSettings(env);
  const newNumber = await allocateTicketNumber(env);
  await env.DB_META.batch([
    env.DB_META.prepare(
      `INSERT INTO support_tickets (number,uid,contact_id,subject,category,priority,status,channel,preview,last_customer_at,first_response_due_at,linked_from,money,unread_staff,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,'open',?7,?8,?9,?10,?11,?12,1,?9,?9)`,
    ).bind(newNumber, t.uid, t.contact_id, clip(m.text.replace(/\s+/g, " ").trim() || t.subject, 80), t.category, t.priority, t.channel, makePreview(m.text), now,
      firstResponseDue(t.priority, now, settings.hours, settings.holidays), number, t.money),
    env.DB_META.prepare("UPDATE support_messages SET ticket_number=?2 WHERE id=?1").bind(messageId, newNumber),
    env.DB_META.prepare("UPDATE support_attachments SET ticket_number=?2 WHERE message_id=?1").bind(messageId, newNumber),
    env.DB_META.prepare(
      "INSERT INTO support_messages (id,ticket_number,author_type,author_name,text,preview,created_at) VALUES (?1,?2,'note','System',?3,?3,?4)",
    ).bind(crypto.randomUUID(), number, `A message was split into ${ticketCode(newNumber)}.`, now),
  ]);
  await addEvent(env, number, actor, "split", { to: newNumber, messageId }, now);
  await addEvent(env, newNumber, actor, "created", { splitFrom: number }, now);
  await reindexTicket(env, number); await reindexTicket(env, newNumber);
  return { ok: true, number: newNumber };
}

export { setTicketStatus };
export type { TicketRow };
