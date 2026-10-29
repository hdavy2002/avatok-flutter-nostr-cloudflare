// [HF-SUPPORT-1] Customer support API (app + support site). Contract: Specs/HF-SUPPORT-CONTRACT.md.
//   GET  /api/hf/support/tickets?status=open|solved|closed|all
//   POST /api/hf/support/tickets                       {category, subject, message, attachmentIds?, meta?}
//   GET  /api/hf/support/tickets/:number               (marks it read; internal notes are NEVER returned)
//   POST /api/hf/support/tickets/:number/reply|solve|reopen
//   POST /api/hf/support/attachments                   raw body, content-type + x-file-name (percent-encoded)
//   GET  /api/hf/support/attachments/:id               file stream (ticket owner, uploader, or staff)
// Customers only ever see their own tickets, and only author types customer/staff/system: `note` rows are filtered in SQL, not in the UI.
import type { Env } from "../types";
import { CORS, json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { nameFor } from "../lib/identity";
import {
  addEvent, canCustomerReopen, checkAttachment, isCategory, getTicket, loadSettings, MAX_ATTACHMENT_BYTES, MAX_CUSTOMER_MESSAGE_CHARS, MAX_SUBJECT_CHARS,
  parseTicketNumber, resolveStaff, safeFileName, setTicketStatus, statusLabel, statusOnCustomerMessage, upsertContact, ticketCode, clip, HOUR_MS,
  attachmentKey, fileExtension, MAX_AUTOREPLIES_PER_HOUR, sanitizeHtml, type TicketRow, type StaffCtx,
} from "../lib/support_core";
import { addMessage, checkAttachmentIds, createTicket, findIdenticalRecent, recentTicketCount, textHash } from "../lib/support_ops";
import { recipientEmailFor, sendAck } from "../lib/support_mail";
import { alertAdmin } from "../lib/support_alerts";

const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, ...extra }, status, NO_STORE);

/** Customer-facing status. new/open/on_hold collapse to "open" (contract). */
export function customerStatus(status: string): "open" | "waiting" | "solved" | "closed" {
  switch (status) {
    case "waiting": return "waiting";
    case "solved": return "solved";
    case "closed": case "spam": case "trash": return "closed";
    default: return "open";
  }
}

const OPEN_STATUSES = ["new", "open", "waiting", "on_hold"];
const SELF = "You";

function ticketDto(t: TicketRow) {
  return {
    number: ticketCode(t.number), subject: t.subject, category: t.category, status: customerStatus(t.status), statusLabel: statusLabel(t.status),
    preview: t.preview, updatedAt: t.updated_at, createdAt: t.created_at, unread: t.unread_customer === 1,
  };
}

const linkedRecently = new Map<string, number>();
/** Attach earlier email-only tickets to the account once the person has verified an address that matches (memoised 5 min). */
export async function linkGuestTickets(env: Env, uid: string): Promise<void> {
  const last = linkedRecently.get(uid);
  if (last && Date.now() - last < 5 * 60_000) return;
  if (linkedRecently.size > 1000) linkedRecently.clear();
  linkedRecently.set(uid, Date.now());
  try {
    const email = await recipientEmailFor(env, { uid, contact_id: 0 });
    if (!email) return;
    const c = await env.DB_META.prepare("SELECT id,uid FROM support_contacts WHERE email=?1").bind(email.toLowerCase()).first<{ id: number; uid: string | null }>();
    if (!c || (c.uid && c.uid !== uid)) return;
    if (!c.uid) {
      const mine = await env.DB_META.prepare("SELECT id FROM support_contacts WHERE uid=?1").bind(uid).first<{ id: number }>();
      if (mine && mine.id !== c.id) return; // the account already has its own contact row: do not guess a merge
      await env.DB_META.prepare("UPDATE support_contacts SET uid=?2 WHERE id=?1 AND uid IS NULL").bind(c.id, uid).run();
    }
    await env.DB_META.prepare("UPDATE support_tickets SET uid=?2 WHERE contact_id=?1 AND uid IS NULL").bind(c.id, uid).run();
  } catch { /* best-effort: the next visit retries */ }
}

async function contactFor(env: Env, uid: string): Promise<number> {
  const [email, name] = await Promise.all([emailFor(env, uid).catch(() => null), nameFor(env, uid).catch(() => null)]);
  return upsertContact(env, { uid, email: email && !/@noemail\./i.test(email) ? email : null, name });
}

/** The customer's own ticket, following a merge to its target. */
async function ownTicket(env: Env, uid: string, numberRaw: string): Promise<TicketRow | null> {
  const n = parseTicketNumber(numberRaw);
  if (!n) return null;
  let t = await getTicket(env, n);
  for (let i = 0; t?.merged_into && i < 5; i++) t = await getTicket(env, t.merged_into);
  if (!t || t.uid !== uid || t.status === "spam") return null;
  return t;
}

async function listTickets(env: Env, uid: string, url: URL): Promise<Response> {
  await linkGuestTickets(env, uid);
  const f = (url.searchParams.get("status") ?? "all").toLowerCase();
  const filter = f === "open" ? `AND status IN ('new','open','waiting','on_hold')` : f === "solved" ? `AND status='solved'` : f === "closed" ? `AND status='closed'` : "";
  const rows = (await env.DB_META.prepare(
    `SELECT * FROM support_tickets WHERE uid=?1 AND merged_into IS NULL AND status NOT IN ('spam','trash') ${filter} ORDER BY updated_at DESC LIMIT 100`,
  ).bind(uid).all<TicketRow>()).results ?? [];
  return json({ ok: true, tickets: rows.map((t) => { const d = ticketDto(t); return { number: d.number, subject: d.subject, category: d.category, status: d.status, statusLabel: d.statusLabel, preview: d.preview, updatedAt: d.updatedAt, unread: d.unread }; }) }, 200, NO_STORE);
}

const cleanMeta = (m: unknown): Record<string, string> | undefined => {
  if (!m || typeof m !== "object" || Array.isArray(m)) return undefined;
  const out: Record<string, string> = {};
  for (const k of ["appVersion", "build", "device", "os", "lastScreen", "platform"]) {
    const v = (m as Record<string, unknown>)[k];
    if (typeof v === "string" || typeof v === "number") out[k] = String(v).slice(0, 80);
  }
  return Object.keys(out).length ? out : undefined;
};

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try { const v = await req.json(); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
}

async function createOwnTicket(req: Request, env: Env, uid: string): Promise<Response> {
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json");
  if (!isCategory(b.category)) return err(400, "invalid_category");
  const subject = typeof b.subject === "string" ? b.subject.replace(/\s+/g, " ").trim() : "";
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (subject.length < 3 || subject.length > MAX_SUBJECT_CHARS) return err(400, "invalid_subject");
  if (message.length < 1 || message.length > MAX_CUSTOMER_MESSAGE_CHARS) return err(400, "invalid_message");
  const now = Date.now();
  const contactId = await contactFor(env, uid);
  const hash = await textHash(`${subject}\n${message}`);
  const dup = await findIdenticalRecent(env, contactId, hash, now);
  if (dup) { // same text from the same person within 10 minutes: one ticket, not two
    const t = await getTicket(env, dup.ticket);
    if (t) return json({ ok: true, merged: true, ticket: ticketDto(t) }, 200, NO_STORE);
  }
  if ((await recentTicketCount(env, contactId, now)) >= 5) return err(429, "rate_limited", { message: "You can open up to 5 tickets a day. Please add to an existing ticket." });
  const att = await checkAttachmentIds(env, b.attachmentIds, uid);
  if (!att.ok) return err(400, att.error);
  const settings = await loadSettings(env);
  const channel = b.meta && typeof (b.meta as Record<string, unknown>).platform === "string" && (b.meta as Record<string, string>).platform === "web" ? "web" : "app";
  const made = await createTicket(env, {
    uid, contactId, subject, category: b.category, channel, now, settings, writeAck: true, meta: cleanMeta(b.meta),
    message: { authorName: SELF, text: message, hash, attachmentIds: att.ids, uploaderUid: uid },
  });
  const t = (await getTicket(env, made.number)) as TicketRow;
  // acknowledgement email (bulk lane, <= 3 per address per hour) + admin WhatsApp alert; both are id-only queue jobs
  const to = await recipientEmailFor(env, t);
  if (to) {
    const sent = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM support_autoreply_log WHERE recipient=?1 AND created_at>?2").bind(to.toLowerCase(), now - HOUR_MS).first<{ n: number }>().catch(() => null);
    if (Number(sent?.n ?? 0) < MAX_AUTOREPLIES_PER_HOUR) {
      await env.DB_META.prepare("INSERT INTO support_autoreply_log (recipient,kind,created_at) VALUES (?1,'ack',?2)").bind(to.toLowerCase(), now).run().catch(() => undefined);
      await sendAck(env, t, to, { afterHours: made.afterHours, unknownSender: false }).catch(() => null);
    }
  }
  await alertAdmin(env, "new", { number: t.number, subject: t.subject, category: t.category, priority: t.priority }, String(t.number), now).catch(() => "failed");
  return json({ ok: true, ticket: ticketDto(t) }, 201, NO_STORE);
}

interface MsgRow { id: string; author_type: string; author_name: string | null; text: string; html_r2_key: string | null; created_at: number }
interface AttRow { id: string; message_id: string | null; name: string; size: number; content_type: string }

async function getOwnTicket(env: Env, uid: string, numberRaw: string): Promise<Response> {
  await linkGuestTickets(env, uid);
  const t = await ownTicket(env, uid, numberRaw);
  if (!t) return err(404, "not_found");
  // Internal notes are excluded here, in the query, so no later code path can leak one.
  const msgs = (await env.DB_META.prepare(
    "SELECT id,author_type,author_name,text,html_r2_key,created_at FROM support_messages WHERE ticket_number=?1 AND author_type IN ('customer','staff','system') ORDER BY created_at, rowid LIMIT 500",
  ).bind(t.number).all<MsgRow>()).results ?? [];
  const atts = (await env.DB_META.prepare("SELECT id,message_id,name,size,content_type FROM support_attachments WHERE ticket_number=?1 AND purpose='ticket'").bind(t.number).all<AttRow>()).results ?? [];
  const byMsg = new Map<string, AttRow[]>();
  for (const a of atts) if (a.message_id) (byMsg.get(a.message_id) ?? byMsg.set(a.message_id, []).get(a.message_id)!).push(a);
  const out = [];
  for (const m of msgs) {
    let html: string | undefined;
    if (m.author_type === "staff" && m.html_r2_key) {
      const obj = await env.BACKUP_R2.get(m.html_r2_key).catch(() => null);
      if (obj) html = sanitizeHtml(await obj.text());
    }
    out.push({
      id: m.id,
      author: m.author_type === "staff" ? "support" : m.author_type === "system" ? "system" : "customer",
      authorName: m.author_type === "staff" ? `${BRAND.name} support` : m.author_type === "system" ? BRAND.name : SELF,
      text: m.text,
      ...(html ? { html } : {}),
      createdAt: m.created_at,
      attachments: (byMsg.get(m.id) ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size, contentType: a.content_type })),
    });
  }
  if (t.unread_customer) await env.DB_META.prepare("UPDATE support_tickets SET unread_customer=0 WHERE number=?1").bind(t.number).run().catch(() => undefined);
  const d = ticketDto(t);
  return json({
    ok: true,
    ticket: { number: d.number, subject: d.subject, category: d.category, status: d.status, statusLabel: d.statusLabel, createdAt: d.createdAt, updatedAt: d.updatedAt, canReopen: canCustomerReopen(t.status, t.solved_at, Date.now()) },
    messages: out,
  }, 200, NO_STORE);
}

async function replyOwn(req: Request, env: Env, uid: string, numberRaw: string): Promise<Response> {
  const t = await ownTicket(env, uid, numberRaw);
  if (!t) return err(404, "not_found");
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json");
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message || message.length > MAX_CUSTOMER_MESSAGE_CHARS) return err(400, "invalid_message");
  const att = await checkAttachmentIds(env, b.attachmentIds, uid);
  if (!att.ok) return err(400, att.error);
  const now = Date.now();
  const recent = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM support_messages WHERE ticket_number=?1 AND author_type='customer' AND created_at>?2").bind(t.number, now - HOUR_MS).first<{ n: number }>();
  if (Number(recent?.n ?? 0) >= 20) return err(429, "rate_limited");
  const hash = await textHash(message);
  const contactId = t.contact_id;
  const dup = await findIdenticalRecent(env, contactId, hash, now);
  if (dup) return json({ ok: true, merged: true }, 200, NO_STORE);

  const act = statusOnCustomerMessage(t.status, t.solved_at, now);
  if (act.action === "ignore") return err(404, "not_found");
  if (act.action === "new_linked") {
    // Closed: the reply starts a new ticket linked to the old one (the app shows it as a new ticket).
    if ((await recentTicketCount(env, contactId, now)) >= 5) return err(429, "rate_limited");
    const settings = await loadSettings(env);
    const made = await createTicket(env, {
      uid, contactId, subject: t.subject, category: t.category, channel: t.channel === "web" ? "web" : "app", now, settings, writeAck: true, linkedFrom: t.number,
      message: { authorName: SELF, text: message, hash, attachmentIds: att.ids, uploaderUid: uid },
    });
    const nt = (await getTicket(env, made.number)) as TicketRow;
    await alertAdmin(env, "new", { number: nt.number, subject: nt.subject, category: nt.category, priority: nt.priority }, String(nt.number), now).catch(() => "failed");
    return json({ ok: true, newTicket: ticketDto(nt) }, 200, NO_STORE);
  }
  const id = await addMessage(env, t.number, { authorType: "customer", authorUid: uid, authorName: SELF, text: message, hash, now, attachmentIds: att.ids, uploaderUid: uid });
  if (t.status !== act.status) await setTicketStatus(env, t, act.status, "customer", now);
  if (act.reopened) await addEvent(env, t.number, "customer", "reopened", { by: "customer_reply" }, now);
  await alertAdmin(env, "reply", { number: t.number, subject: t.subject, category: t.category, priority: t.priority }, id, now).catch(() => "failed");
  return json({ ok: true }, 200, NO_STORE);
}

async function solveOwn(env: Env, uid: string, numberRaw: string): Promise<Response> {
  const t = await ownTicket(env, uid, numberRaw);
  if (!t) return err(404, "not_found");
  if (t.status === "solved" || t.status === "closed") return json({ ok: true }, 200, NO_STORE);
  const now = Date.now();
  await setTicketStatus(env, t, "solved", "customer", now);
  await addMessage(env, t.number, { authorType: "system", authorName: BRAND.name, text: "You marked this ticket as solved. You can reopen it within 7 days.", now });
  return json({ ok: true }, 200, NO_STORE);
}

async function reopenOwn(env: Env, uid: string, numberRaw: string): Promise<Response> {
  const t = await ownTicket(env, uid, numberRaw);
  if (!t) return err(404, "not_found");
  const now = Date.now();
  if (!canCustomerReopen(t.status, t.solved_at, now)) return err(400, "cannot_reopen", { message: "A ticket can be reopened within 7 days of being solved. Please start a new ticket." });
  await setTicketStatus(env, t, "open", "customer", now);
  await env.DB_META.prepare("UPDATE support_tickets SET unread_staff=1,last_customer_at=?2 WHERE number=?1").bind(t.number, now).run();
  await addEvent(env, t.number, "customer", "reopened", { by: "customer" }, now);
  await alertAdmin(env, "reply", { number: t.number, subject: t.subject, category: t.category, priority: t.priority }, `reopen:${t.number}:${now}`, now).catch(() => "failed");
  return json({ ok: true }, 200, NO_STORE);
}

// ---------------------------------------------------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------------------------------------------------
/** Header file names cannot carry non-ASCII (upload-filename-header-encoding): decode the %-escapes, then keep it printable. */
export function uploadFileName(req: Request): string {
  const raw = req.headers.get("x-file-name") ?? "file";
  let s = raw;
  try { s = decodeURIComponent(raw); } catch { /* keep raw */ }
  return safeFileName(s);
}

async function uploadAttachment(req: Request, env: Env, uid: string): Promise<Response> {
  const purpose = (new URL(req.url).searchParams.get("purpose") ?? req.headers.get("x-purpose") ?? "ticket").toLowerCase();
  if (purpose !== "ticket" && purpose !== "signature") return err(400, "invalid_purpose");
  let staff: StaffCtx | null = null;
  if (purpose === "signature") {
    staff = await resolveStaff(env, uid);
    if (!staff || staff.role === "viewer") return err(403, "forbidden");
  }
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_ATTACHMENT_BYTES) return err(413, "too_large");
  const contentType = (req.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  const name = uploadFileName(req);
  const recent = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM support_attachments WHERE uid=?1 AND created_at>?2").bind(uid, Date.now() - HOUR_MS).first<{ n: number }>();
  if (Number(recent?.n ?? 0) >= 40) return err(429, "rate_limited");
  const bytes = new Uint8Array(await req.arrayBuffer());
  const verdict = checkAttachment(name, contentType, bytes.length);
  if (!verdict.ok) return err(verdict.reason === "too_large" ? 413 : 400, verdict.reason);
  const id = crypto.randomUUID();
  const now = Date.now();
  if (purpose === "signature") {
    if (!contentType.startsWith("image/")) return err(400, "blocked_type");
    const key = `support-signature/${id}.${fileExtension(name) || "png"}`;
    await env.BLOBS.put(key, bytes, { httpMetadata: { contentType } });
    await env.DB_META.prepare("INSERT INTO support_attachments (id,r2_key,name,size,content_type,ticket_number,message_id,uid,purpose,created_at) VALUES (?1,?2,?3,?4,?5,NULL,NULL,?6,'signature',?7)")
      .bind(id, key, name, bytes.length, contentType, uid, now).run();
    return json({ ok: true, id, name, size: bytes.length, url: `${BRAND.mediaOrigin}/${key}` }, 201, NO_STORE);
  }
  const key = attachmentKey("pending", id, name);
  await env.BACKUP_R2.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { name: name.slice(0, 200) } });
  await env.DB_META.prepare("INSERT INTO support_attachments (id,r2_key,name,size,content_type,ticket_number,message_id,uid,purpose,created_at) VALUES (?1,?2,?3,?4,?5,NULL,NULL,?6,'ticket',?7)")
    .bind(id, key, name, bytes.length, contentType, uid, now).run();
  return json({ ok: true, id, name, size: bytes.length }, 201, NO_STORE);
}

async function downloadAttachment(env: Env, uid: string, id: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return err(404, "not_found");
  const a = await env.DB_META.prepare("SELECT r2_key,name,content_type,ticket_number,uid,purpose FROM support_attachments WHERE id=?1").bind(id).first<{ r2_key: string; name: string; content_type: string; ticket_number: number | null; uid: string | null; purpose: string }>();
  if (!a || a.purpose !== "ticket") return err(404, "not_found");
  let allowed = a.uid === uid && a.ticket_number === null; // the uploader, before it is attached
  if (!allowed && a.ticket_number !== null) {
    const t = await getTicket(env, a.ticket_number);
    allowed = !!t && t.uid === uid;
  }
  if (!allowed) allowed = !!(await resolveStaff(env, uid));
  if (!allowed) return err(404, "not_found");
  const obj = await env.BACKUP_R2.get(a.r2_key);
  if (!obj) return err(404, "not_found");
  const inline = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i.test(a.content_type);
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...CORS,
      "content-type": inline ? a.content_type : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=300",
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------------------------------
export async function hfSupportRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (!p.startsWith("/api/hf/support/")) return null;
  const rest = p.slice("/api/hf/support/".length).replace(/\/+$/, "");
  const parts = rest.split("/");
  const m = req.method;
  const route = parts[0] === "tickets"
    ? (parts.length === 1 ? (m === "GET" ? "list" : m === "POST" ? "create" : "")
      : parts.length === 2 ? (m === "GET" ? "get" : "")
      : parts.length === 3 && m === "POST" && ["reply", "solve", "reopen"].includes(parts[2]) ? parts[2] : "")
    : parts[0] === "attachments"
      ? (parts.length === 1 && m === "POST" ? "upload" : parts.length === 2 && m === "GET" ? "download" : "")
      : "";
  if (!route) return null;
  try {
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error === "auth not configured" ? "unavailable" : "unauthorized");
    switch (route) {
      case "list": return await listTickets(env, u.uid, new URL(req.url));
      case "create": return await createOwnTicket(req, env, u.uid);
      case "get": return await getOwnTicket(env, u.uid, parts[1]);
      case "reply": return await replyOwn(req, env, u.uid, parts[1]);
      case "solve": return await solveOwn(env, u.uid, parts[1]);
      case "reopen": return await reopenOwn(env, u.uid, parts[1]);
      case "upload": return await uploadAttachment(req, env, u.uid);
      case "download": return await downloadAttachment(env, u.uid, parts[1]);
    }
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: BRAND.slug, extra: { area: "hf_support" } });
    return err(500, "internal");
  }
}

export { clip };
