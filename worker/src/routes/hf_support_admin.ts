// [HF-SUPPORT-1] Support desk (admin) API. Contract: Specs/HF-SUPPORT-CONTRACT.md.
// Guard: a signed-in account that is a support_staff member (matched by uid, or by VERIFIED email at first login) or an isAdminUid admin.
// viewer = read only; agent = work tickets; admin = also settings, team, queues retry/discard, suppressions, team signature.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { readConfig } from "./config";
import { readWalletPaise } from "./hf_me";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { emailFor, primaryVerifiedEmailFor } from "../lib/identity";
import { enqueueEmail, recoverEmailOutbox } from "../lib/email_outbox";
import { recoverWhatsAppQueue } from "../lib/whatsapp_queue";
import { safeQueueSend } from "../lib/queue_guard";
import { postStaffReply } from "../lib/support_reply";
import { ticketSubject, signatureFor, wrapReplyHtml, recipientEmailFor } from "../lib/support_mail";
import { mergeTickets, splitTicket, addMessage, checkAttachmentIds } from "../lib/support_ops";
import { htmlToPlainText } from "../lib/support_mime";
import {
  addEvent, canWrite, CATEGORIES, clip, DAY_MS, firstResponseDue, getTicket, isCategory, isDeskAdmin, isMoneyCategory, isPriority, isStatus, loadSettings,
  maskWhatsApp, parseTicketNumber, reindexTicket, resolveStaff, sanitizeHtml, setSetting, getSetting, setTicketStatus, slaState, supportFrom, textToHtml, ticketCode,
  type Priority, type StaffCtx, type Status, type TicketRow,
} from "../lib/support_core";
import { customerStatus } from "./hf_support";

const NO_STORE = { "cache-control": "private, no-store" };
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, ...extra }, status, NO_STORE);
const ok = (body: Record<string, unknown> = {}, status = 200) => json({ ok: true, ...body }, status, NO_STORE);
const PAGE = 50;
const VIEWER_TTL_MS = 30_000;
const n = (v: unknown): number => Number(v ?? 0) || 0;

/** "email" -> "Email" (the desk shows "via Email" and filters with the same words). */
const channelLabel = (c: string): string => (c ? c.charAt(0).toUpperCase() + c.slice(1) : "Email");
const STAFF_STATUS_LABEL: Record<string, string> = { new: "New", open: "Open", waiting: "Waiting on customer", on_hold: "On hold", solved: "Solved", closed: "Closed", spam: "Spam", trash: "Trash" };

/** One readable line per event for the ticket history. */
function eventText(type: string, data: Record<string, unknown> | null, actor: string, names: Map<string, string | null>): string {
  const who = actor === "system" ? "System" : actor === "customer" ? "Customer" : (names.get(actor) ?? "Staff");
  const lab = (v: unknown) => STAFF_STATUS_LABEL[String(v)] ?? String(v ?? "");
  switch (type) {
    case "created": return `Ticket opened${data?.channel ? ` via ${channelLabel(String(data.channel))}` : ""}`;
    case "status": return `${who} changed the status to ${lab(data?.to)}`;
    case "priority": return `${who} set the priority to ${String(data?.to ?? "")}`;
    case "category": return `${who} set the category to ${String(data?.to ?? "")}`;
    case "assign": return data?.to ? `${who} assigned the ticket to ${names.get(String(data.to)) ?? "a teammate"}` : `${who} unassigned the ticket`;
    case "reply": return `${who} replied`;
    case "note": return `${who} added an internal note`;
    case "merge": return `${who} merged another ticket into this one`;
    case "merged_into": return `${who} merged this ticket into another`;
    case "split": return `${who} split a message into a new ticket`;
    case "snooze": return data?.until ? "Snoozed" : "Snooze cleared";
    case "unsnoozed": return "Snooze ended";
    case "reminder": return "Reminder sent to the customer";
    case "reopened": return "Customer reopened the ticket";
    case "nudge": return "Customer notified on WhatsApp";
    default: return type.replace(/_/g, " ");
  }
}

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try { const v = await req.json(); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------------
// list / search
// ---------------------------------------------------------------------------------------------------------------------
const OPEN_SET = "('new','open')";
const FOLDERS: Record<string, (uid: string) => { where: string; binds: unknown[] }> = {
  unassigned: () => ({ where: `t.assignee_uid IS NULL AND t.status IN ${OPEN_SET}`, binds: [] }),
  mine: (uid) => ({ where: `t.assignee_uid=? AND t.status IN ('new','open','waiting','on_hold')`, binds: [uid] }),
  open: () => ({ where: `t.status IN ${OPEN_SET}`, binds: [] }),
  waiting: () => ({ where: `t.status='waiting'`, binds: [] }),
  on_hold: () => ({ where: `t.status='on_hold'`, binds: [] }),
  solved: () => ({ where: `t.status='solved'`, binds: [] }),
  closed: () => ({ where: `t.status='closed'`, binds: [] }),
  spam: () => ({ where: `t.status='spam'`, binds: [] }),
  trash: () => ({ where: `t.status='trash'`, binds: [] }),
};

const esc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/** FTS5 query from free text: each word becomes a quoted prefix term. */
export function ftsQuery(q: string): string {
  return q.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}@._-]/gu, "")).filter(Boolean).slice(0, 8).map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
}

interface ListRow extends TicketRow { contact_email: string | null; contact_name: string | null; display_name: string | null; reg_name: string | null }

async function foldersCounts(env: Env, uid: string): Promise<Record<string, number>> {
  const r = await env.DB_META.prepare(
    `SELECT
       SUM(CASE WHEN assignee_uid IS NULL AND status IN ('new','open') THEN 1 ELSE 0 END) AS unassigned,
       SUM(CASE WHEN assignee_uid=?1 AND status IN ('new','open','waiting','on_hold') THEN 1 ELSE 0 END) AS mine,
       SUM(CASE WHEN status IN ('new','open') THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN status='waiting' THEN 1 ELSE 0 END) AS waiting,
       SUM(CASE WHEN status='on_hold' THEN 1 ELSE 0 END) AS on_hold,
       SUM(CASE WHEN status='solved' THEN 1 ELSE 0 END) AS solved,
       SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed,
       SUM(CASE WHEN status='spam' THEN 1 ELSE 0 END) AS spam,
       SUM(CASE WHEN status='trash' THEN 1 ELSE 0 END) AS trash,
       SUM(CASE WHEN unread_staff=1 AND status IN ('new','open','waiting','on_hold') THEN 1 ELSE 0 END) AS unread
     FROM support_tickets WHERE merged_into IS NULL`,
  ).bind(uid).first<Record<string, number | null>>();
  const out: Record<string, number> = {};
  for (const k of ["unassigned", "mine", "open", "waiting", "on_hold", "solved", "closed", "spam", "trash", "unread"]) out[k] = n(r?.[k]);
  return out;
}

async function listTickets(env: Env, staff: StaffCtx, url: URL): Promise<Response> {
  const sp = url.searchParams;
  const folderName = sp.get("folder") ?? "open";
  const folder = FOLDERS[folderName];
  if (!folder) return err(400, "invalid_folder");
  const f = folder(staff.uid);
  const where: string[] = ["t.merged_into IS NULL", f.where];
  const binds: unknown[] = [...f.binds];
  const category = sp.get("category"); if (category) { if (!isCategory(category)) return err(400, "invalid_category"); where.push("t.category=?"); binds.push(category); }
  const priority = sp.get("priority"); if (priority) { if (!isPriority(priority)) return err(400, "invalid_priority"); where.push("t.priority=?"); binds.push(priority); }
  const channelQ = sp.get("channel")?.toLowerCase(); if (channelQ) { if (!["email", "app", "web"].includes(channelQ)) return err(400, "invalid_channel"); where.push("t.channel=?"); binds.push(channelQ); }
  const assignee = sp.get("assignee"); if (assignee) { if (assignee === "none") where.push("t.assignee_uid IS NULL"); else { where.push("t.assignee_uid=?"); binds.push(assignee); } }

  const q = (sp.get("q") ?? "").trim().slice(0, 100);
  let usedFts = false;
  const num = parseTicketNumber(q);
  if (q && num) { where.push("t.number=?"); binds.push(num); }
  else if (q) {
    const fts = ftsQuery(q);
    if (fts) { where.push("t.number IN (SELECT number FROM support_fts WHERE support_fts MATCH ?)"); binds.push(fts); usedFts = true; }
  }
  const cursor = Math.max(0, Number.parseInt(sp.get("cursor") ?? "0", 10) || 0);
  const run = async (w: string[], b: unknown[]): Promise<ListRow[]> => (await env.DB_META.prepare(
    `SELECT t.*, c.email AS contact_email, c.name AS contact_name, u.display_name AS display_name,
            NULLIF(trim(COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,'')),'') AS reg_name
       FROM support_tickets t
       LEFT JOIN support_contacts c ON c.id=t.contact_id
       LEFT JOIN users u ON u.uid=t.uid
       LEFT JOIN hf_user_registration r ON r.uid=t.uid
      WHERE ${w.join(" AND ")}
      ORDER BY t.updated_at DESC, t.number DESC LIMIT ${PAGE + 1} OFFSET ${cursor}`,
  ).bind(...b).all<ListRow>()).results ?? [];
  let rows: ListRow[];
  try { rows = await run(where, binds); }
  catch (e) {
    if (!usedFts) throw e;
    // FTS5 not available on this database: LIKE fallback over subject, preview, contact email and name
    const like = `%${esc(q.toLowerCase())}%`;
    const w2 = where.filter((x) => !x.includes("support_fts"));
    const b2 = binds.slice(0, binds.length - 1);
    w2.push(`(lower(t.subject) LIKE ? ESCAPE '\\' OR lower(t.preview) LIKE ? ESCAPE '\\' OR lower(COALESCE(c.email,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(c.name,'')) LIKE ? ESCAPE '\\')`);
    b2.push(like, like, like, like);
    rows = await run(w2, b2);
  }
  const more = rows.length > PAGE;
  const page = more ? rows.slice(0, PAGE) : rows;

  const uids = [...new Set(page.map((r) => r.uid).filter((x): x is string => !!x))];
  const hosts = new Set<string>();
  if (uids.length) {
    try {
      const marks = uids.map((_, i) => `?${i + 1}`).join(",");
      for (const h of (await env.DB_META.prepare(`SELECT uid FROM hf_hosts WHERE uid IN (${marks}) AND status IN ('live','paused','pending_review')`).bind(...uids).all<{ uid: string }>()).results ?? []) hosts.add(h.uid);
    } catch { /* hf_hosts absent: everyone is a fan */ }
  }
  const staffNames = await staffNameMap(env);
  const now = Date.now();
  return ok({
    folder: folderName,
    counts: await foldersCounts(env, staff.uid),
    tickets: page.map((r) => ({
      number: ticketCode(r.number), code: ticketCode(r.number), seq: r.number,
      customer: { name: r.reg_name ?? r.display_name ?? r.contact_name ?? r.contact_email ?? "Unknown", email: r.contact_email, role: !r.uid ? "unverified" : hosts.has(r.uid) ? "influencer" : "fan", uid: r.uid ?? undefined },
      subject: r.subject, preview: r.preview, category: r.category, priority: r.priority, status: r.status, channel: channelLabel(r.channel),
      assignee: r.assignee_uid ? { uid: r.assignee_uid, name: staffNames.get(r.assignee_uid) ?? null } : null,
      sla: { dueAt: r.first_response_due_at, state: slaState(r.first_response_due_at, r.first_responded_at, r.created_at, now) },
      createdAt: r.created_at, updatedAt: r.updated_at, unread: r.unread_staff === 1, snoozeUntil: r.snooze_until,
    })),
    nextCursor: more ? String(cursor + PAGE) : null,
    me: { uid: staff.uid, name: staff.name ?? staff.email ?? "Me", role: staff.role },
  });
}

async function staffNameMap(env: Env): Promise<Map<string, string | null>> {
  const m = new Map<string, string | null>();
  try { for (const s of (await env.DB_META.prepare("SELECT uid,name,email FROM support_staff WHERE uid IS NOT NULL").all<{ uid: string; name: string | null; email: string }>()).results ?? []) m.set(s.uid, s.name ?? s.email); } catch { /* none */ }
  return m;
}

// ---------------------------------------------------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------------------------------------------------
async function safe<T>(fn: () => Promise<T>): Promise<T | null> { try { return await fn(); } catch { return null; } }

/** Everything the agent needs about the person. A value that cannot be read is null (never an error). */
export async function customerPanel(env: Env, t: TicketRow, now = Date.now()): Promise<Record<string, unknown>> {
  const contact = await safe(() => env.DB_META.prepare("SELECT email,name,whatsapp FROM support_contacts WHERE id=?1").bind(t.contact_id).first<{ email: string | null; name: string | null; whatsapp: string | null }>());
  const uid = t.uid;
  const base = { uid, name: contact?.name ?? null, handle: null as string | null, role: uid ? "fan" : "unverified", verified: false, whatsappMasked: maskWhatsApp(contact?.whatsapp), email: contact?.email ?? null,
    joinedAt: null as number | null, walletRupees: null as number | null, pendingWithdrawRupees: null as number | null, calls30d: null as number | null, strikes: null as number | null,
    recentMoney: [] as unknown[], otherTickets: [] as unknown[] };
  base.otherTickets = (await safe(async () => ((await env.DB_META.prepare(
    "SELECT number,subject,status,category,updated_at FROM support_tickets WHERE (contact_id=?1 OR (?2 IS NOT NULL AND uid=?2)) AND number<>?3 AND merged_into IS NULL ORDER BY updated_at DESC LIMIT 10",
  ).bind(t.contact_id, uid, t.number).all<{ number: number; subject: string; status: string; category: string; updated_at: number }>()).results ?? []).map((o) => ({ number: ticketCode(o.number), seq: o.number, code: ticketCode(o.number), subject: o.subject, status: o.status, statusLabel: STAFF_STATUS_LABEL[o.status] ?? o.status, category: o.category, updatedAt: o.updated_at })))) ?? [];
  if (!uid) return base;

  const [user, reg, host, cv, wa, email] = await Promise.all([
    safe(() => env.DB_META.prepare("SELECT handle,display_name,created_at FROM users WHERE uid=?1").bind(uid).first<{ handle: string | null; display_name: string | null; created_at: number }>()),
    safe(() => env.DB_META.prepare("SELECT first_name,last_name,username FROM hf_user_registration WHERE uid=?1").bind(uid).first<{ first_name: string | null; last_name: string | null; username: string | null }>()),
    safe(() => env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(uid).first<{ status: string }>()),
    safe(() => env.DB_META.prepare("SELECT email_verified,phone_verified FROM contact_verification WHERE uid=?1").bind(uid).first<{ email_verified: number; phone_verified: number }>()),
    safe(() => verifiedWhatsAppNumber(env, uid)),
    safe(() => recipientEmailFor(env, t)),
  ]);
  const regName = `${reg?.first_name ?? ""} ${reg?.last_name ?? ""}`.trim();
  base.name = regName || user?.display_name || contact?.name || base.name;
  base.handle = user?.handle ?? reg?.username ?? null;
  base.role = host && ["live", "paused", "pending_review"].includes(host.status) ? "influencer" : "fan";
  base.verified = !!cv && n(cv.email_verified) === 1 && n(cv.phone_verified) === 1;
  base.whatsappMasked = maskWhatsApp(wa) ?? base.whatsappMasked;
  base.email = email ?? base.email;
  base.joinedAt = user ? n(user.created_at) || null : null;

  const paise = await safe(async () => readWalletPaise(env, uid, (await readConfig(env)).hfTokensEnabled === true));
  base.walletRupees = paise === null || paise === undefined ? null : Math.round(paise) / 100;
  const pend = await safe(() => env.DB_META.prepare("SELECT COALESCE(SUM(amount_rupees),0) AS s FROM hf_payout_requests WHERE host_uid=?1 AND status IN ('requested','approved')").bind(uid).first<{ s: number }>());
  base.pendingWithdrawRupees = pend ? n(pend.s) : null;
  const calls = await safe(() => env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_calls WHERE (caller_uid=?1 OR host_uid=?1) AND created_at>?2").bind(uid, now - 30 * DAY_MS).first<{ c: number }>());
  base.calls30d = calls ? n(calls.c) : null;
  const strikes = await safe(() => env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_strikes WHERE uid=?1 AND removed_at IS NULL AND expires_at>?2").bind(uid, now).first<{ c: number }>());
  base.strikes = strikes ? n(strikes.c) : null;
  const topups = (await safe(async () => (await env.DB_META.prepare("SELECT amount_rupees,status,COALESCE(paid_at,created_at) AS at FROM hf_topups WHERE uid=?1 ORDER BY created_at DESC LIMIT 5").bind(uid).all<{ amount_rupees: number; status: string; at: number }>()).results ?? [])) ?? [];
  const payouts = (await safe(async () => (await env.DB_META.prepare("SELECT amount_rupees,status,created_at AS at FROM hf_payout_requests WHERE host_uid=?1 ORDER BY created_at DESC LIMIT 5").bind(uid).all<{ amount_rupees: number; status: string; at: number }>()).results ?? [])) ?? [];
  base.recentMoney = [
    ...topups.map((r) => ({ kind: "topup", label: `Top-up (${r.status})`, rupees: n(r.amount_rupees), amountRupees: n(r.amount_rupees), status: r.status, at: n(r.at) })),
    ...payouts.map((r) => ({ kind: "withdrawal", label: `Withdrawal (${r.status})`, rupees: n(r.amount_rupees), amountRupees: -n(r.amount_rupees), status: r.status, at: n(r.at) })),
  ].sort((a, b) => b.at - a.at).slice(0, 8);
  return base;
}

interface AdminMsg { id: string; author_type: string; author_uid: string | null; author_name: string | null; text: string; html_r2_key: string | null; created_at: number; message_id_header: string | null }

async function getTicketDetail(env: Env, staff: StaffCtx, numberRaw: string): Promise<Response> {
  const num = parseTicketNumber(numberRaw);
  const t = num ? await getTicket(env, num) : null;
  if (!t) return err(404, "not_found");
  const msgs = (await env.DB_META.prepare(
    "SELECT id,author_type,author_uid,author_name,text,html_r2_key,created_at,message_id_header FROM support_messages WHERE ticket_number=?1 ORDER BY created_at, rowid LIMIT 1000",
  ).bind(t.number).all<AdminMsg>()).results ?? [];
  const atts = (await env.DB_META.prepare("SELECT id,message_id,name,size,content_type FROM support_attachments WHERE ticket_number=?1").bind(t.number).all<{ id: string; message_id: string | null; name: string; size: number; content_type: string }>()).results ?? [];
  const events = (await env.DB_META.prepare("SELECT id,actor,type,data_json,created_at FROM support_events WHERE ticket_number=?1 ORDER BY created_at DESC, id DESC LIMIT 200").bind(t.number).all<{ id: number; actor: string; type: string; data_json: string | null; created_at: number }>()).results ?? [];
  const contactEmail = (await safe(() => env.DB_META.prepare("SELECT email FROM support_contacts WHERE id=?1").bind(t.contact_id).first<{ email: string | null }>()))?.email ?? (await safe(() => recipientEmailFor(env, t)));
  // delivery state of each staff reply (the email outbox row is keyed support-reply:<message id>)
  const delivery = new Map<string, string>();
  const staffIds = msgs.filter((m) => m.author_type === "staff").map((m) => m.id);
  if (staffIds.length) {
    const marks = staffIds.map((_, i) => `?${i + 1}`).join(",");
    const rows = (await safe(async () => (await env.DB_META.prepare(`SELECT outbox_key,delivery_status FROM email_outbox WHERE outbox_key IN (${marks})`).bind(...staffIds.map((id) => `support-reply:${id}`)).all<{ outbox_key: string; delivery_status: string | null }>()).results ?? [])) ?? [];
    for (const r of rows) {
      const st = r.delivery_status ?? "queued";
      delivery.set(r.outbox_key.slice("support-reply:".length), st === "provider_accepted" ? "sent" : st === "pending" || st === "sending" ? "queued" : st);
    }
  }
  const messages = [];
  for (const m of msgs) {
    let html: string | undefined;
    if (m.html_r2_key) { const o = await env.BACKUP_R2.get(m.html_r2_key).catch(() => null); if (o) html = sanitizeHtml(await o.text()); }
    const kind = m.author_type === "note" ? "note" : m.author_type === "staff" ? "support" : m.author_type === "system" ? "system" : "customer";
    messages.push({
      id: m.id, kind, type: m.author_type, authorName: m.author_name, authorUid: m.author_uid, ...(kind === "customer" && contactEmail ? { authorEmail: contactEmail } : {}),
      text: m.text, ...(html ? { html } : {}), createdAt: m.created_at, ...(kind === "support" ? { delivery: delivery.get(m.id) ?? null } : {}),
      attachments: atts.filter((a) => a.message_id === m.id).map((a) => ({ id: a.id, name: a.name, size: a.size, contentType: a.content_type })),
    });
  }
  const now = Date.now();
  if (canWrite(staff) && t.unread_staff) await env.DB_META.prepare("UPDATE support_tickets SET unread_staff=0 WHERE number=?1").bind(t.number).run().catch(() => undefined);
  const names = await staffNameMap(env);
  const viewers = await currentViewers(env, t.number, staff.uid, now);
  return ok({
    ticket: {
      number: ticketCode(t.number), code: ticketCode(t.number), seq: t.number, subject: t.subject, category: t.category, priority: t.priority, status: t.status, customerStatus: customerStatus(t.status),
      channel: channelLabel(t.channel), assignee: t.assignee_uid ? { uid: t.assignee_uid, name: names.get(t.assignee_uid) ?? null } : null,
      createdAt: t.created_at, updatedAt: t.updated_at, solvedAt: t.solved_at, closedAt: t.closed_at, snoozeUntil: t.snooze_until, mergedInto: t.merged_into, linkedFrom: t.linked_from,
      money: t.money === 1, sla: { dueAt: t.first_response_due_at, state: slaState(t.first_response_due_at, t.first_responded_at, t.created_at, now), respondedAt: t.first_responded_at },
      meta: (() => { try { return t.meta_json ? JSON.parse(t.meta_json) : null; } catch { return null; } })(),
    },
    messages,
    events: events.reverse().map((e) => {
      const data = (() => { try { return e.data_json ? JSON.parse(e.data_json) as Record<string, unknown> : null; } catch { return null; } })();
      return { id: e.id, actor: e.actor, type: e.type, text: eventText(e.type, data, e.actor, names), data, createdAt: e.created_at };
    }),
    customer: await customerPanel(env, t, now),
    viewers,
    you: { uid: staff.uid, role: staff.role },
  });
}

async function currentViewers(env: Env, number: number, selfUid: string, now: number): Promise<Array<{ uid: string; name: string | null; seenAt: number; me: boolean }>> {
  const rows = (await safe(async () => (await env.DB_META.prepare("SELECT uid,name,seen_at FROM support_viewers WHERE ticket_number=?1 AND seen_at>?2").bind(number, now - VIEWER_TTL_MS).all<{ uid: string; name: string | null; seen_at: number }>()).results ?? [])) ?? [];
  return rows.map((r) => ({ uid: r.uid, name: r.name, seenAt: r.seen_at, me: r.uid === selfUid }));
}

async function heartbeat(env: Env, staff: StaffCtx, numberRaw: string): Promise<Response> {
  const num = parseTicketNumber(numberRaw);
  if (!num || !(await getTicket(env, num))) return err(404, "not_found");
  const now = Date.now();
  await env.DB_META.prepare(
    "INSERT INTO support_viewers (ticket_number,uid,name,seen_at) VALUES (?1,?2,?3,?4) ON CONFLICT(ticket_number,uid) DO UPDATE SET seen_at=excluded.seen_at,name=excluded.name",
  ).bind(num, staff.uid, staff.name ?? staff.email ?? null, now).run();
  if (Math.random() < 0.02) await env.DB_META.prepare("DELETE FROM support_viewers WHERE seen_at<?1").bind(now - 10 * 60_000).run().catch(() => undefined);
  return ok({ viewers: await currentViewers(env, num, staff.uid, now), ttlMs: VIEWER_TTL_MS });
}

// ---------------------------------------------------------------------------------------------------------------------
// ticket actions
// ---------------------------------------------------------------------------------------------------------------------
export interface PatchInput { status?: unknown; priority?: unknown; category?: unknown; assigneeUid?: unknown; snoozeUntil?: unknown }

/** Apply a validated patch to one ticket. Returns an error code or null. Shared by PATCH and bulk. */
export async function applyPatch(env: Env, staff: StaffCtx, t: TicketRow, p: PatchInput, now = Date.now()): Promise<string | null> {
  if (p.status !== undefined && !isStatus(p.status)) return "invalid_status";
  if (p.priority !== undefined && !isPriority(p.priority)) return "invalid_priority";
  if (p.category !== undefined && !isCategory(p.category)) return "invalid_category";
  if (p.assigneeUid !== undefined && p.assigneeUid !== null) {
    if (typeof p.assigneeUid !== "string") return "invalid_assignee";
    const s = await resolveAssignee(env, p.assigneeUid);
    if (!s) return "invalid_assignee";
  }
  let snooze: number | null | undefined;
  if (p.snoozeUntil !== undefined) {
    if (p.snoozeUntil === null) snooze = null;
    else if (typeof p.snoozeUntil === "number" && p.snoozeUntil > now && p.snoozeUntil < now + 365 * DAY_MS) snooze = Math.floor(p.snoozeUntil);
    else return "invalid_snooze";
  }
  let cur = t;
  if (p.assigneeUid !== undefined) {
    await env.DB_META.prepare("UPDATE support_tickets SET assignee_uid=?2,updated_at=?3 WHERE number=?1").bind(t.number, p.assigneeUid, now).run();
    await addEvent(env, t.number, staff.uid, "assign", { from: t.assignee_uid, to: p.assigneeUid }, now);
  }
  if (p.priority !== undefined && p.priority !== t.priority) {
    const settings = await loadSettings(env);
    const due = t.first_responded_at ? t.first_response_due_at : firstResponseDue(p.priority as Priority, t.created_at, settings.hours, settings.holidays);
    await env.DB_META.prepare("UPDATE support_tickets SET priority=?2,first_response_due_at=?3,updated_at=?4 WHERE number=?1").bind(t.number, p.priority, due, now).run();
    await addEvent(env, t.number, staff.uid, "priority", { from: t.priority, to: p.priority }, now);
  }
  if (p.category !== undefined && p.category !== t.category) {
    await env.DB_META.prepare("UPDATE support_tickets SET category=?2,money=?3,updated_at=?4 WHERE number=?1").bind(t.number, p.category, isMoneyCategory(p.category as string) ? 1 : 0, now).run();
    await addEvent(env, t.number, staff.uid, "category", { from: t.category, to: p.category }, now);
  }
  if (snooze !== undefined) {
    if (snooze === null) {
      await env.DB_META.prepare("UPDATE support_tickets SET snooze_until=NULL,updated_at=?2 WHERE number=?1").bind(t.number, now).run();
    } else {
      await setTicketStatus(env, cur, "on_hold", staff.uid, now);
      cur = { ...cur, status: "on_hold" };
      await env.DB_META.prepare("UPDATE support_tickets SET snooze_until=?2,updated_at=?3 WHERE number=?1").bind(t.number, snooze, now).run();
    }
    await addEvent(env, t.number, staff.uid, "snooze", { until: snooze }, now);
  }
  if (p.status !== undefined) await setTicketStatus(env, cur, p.status as Status, staff.uid, now);
  if (p.category !== undefined || p.priority !== undefined) await reindexTicket(env, t.number);
  return null;
}

async function resolveAssignee(env: Env, uid: string): Promise<boolean> {
  const row = await safe(() => env.DB_META.prepare("SELECT 1 AS x FROM support_staff WHERE uid=?1 AND role IN ('admin','agent')").bind(uid).first());
  if (row) return true;
  const s = await resolveStaff(env, uid);
  return !!s && s.role !== "viewer";
}

async function patchTicket(req: Request, env: Env, staff: StaffCtx, numberRaw: string): Promise<Response> {
  const num = parseTicketNumber(numberRaw);
  const t = num ? await getTicket(env, num) : null;
  if (!t) return err(404, "not_found");
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json");
  const e = await applyPatch(env, staff, t, b);
  if (e) return err(400, e);
  return ok();
}

async function replyTicket(req: Request, env: Env, staff: StaffCtx, numberRaw: string): Promise<Response> {
  const num = parseTicketNumber(numberRaw);
  const t = num ? await getTicket(env, num) : null;
  if (!t) return err(404, "not_found");
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json");
  const r = await postStaffReply(env, staff, t, b);
  if (!r.ok) return err(400, r.error);
  return ok({ messageId: r.messageId, delivery: r.delivery, ...(r.emailSkipped ? { emailSkipped: r.emailSkipped } : {}), nudge: r.nudge, status: r.status }, 201);
}

async function noteTicket(req: Request, env: Env, staff: StaffCtx, numberRaw: string): Promise<Response> {
  const num = parseTicketNumber(numberRaw);
  const t = num ? await getTicket(env, num) : null;
  if (!t) return err(404, "not_found");
  const b = await bodyOf(req);
  const text = typeof b?.text === "string" ? b.text.trim() : "";
  if (!text || text.length > 8000) return err(400, "invalid_text");
  const id = await addMessage(env, t.number, { authorType: "note", authorUid: staff.uid, authorName: staff.name ?? staff.email ?? "Staff", text, now: Date.now() });
  await addEvent(env, t.number, staff.uid, "note", { messageId: id });
  return ok({ messageId: id }, 201);
}

async function addBlock(env: Env, staff: StaffCtx, kind: "email" | "domain", value: string, reason: string | null): Promise<void> {
  await env.DB_META.prepare("INSERT OR IGNORE INTO support_blocklist (kind,value,reason,created_by,created_at) VALUES (?1,?2,?3,?4,?5)").bind(kind, value, reason, staff.uid, Date.now()).run();
}

async function spamTicket(req: Request, env: Env, staff: StaffCtx, numberRaw: string): Promise<Response> {
  const num = parseTicketNumber(numberRaw);
  const t = num ? await getTicket(env, num) : null;
  if (!t) return err(404, "not_found");
  const b = await bodyOf(req);
  await setTicketStatus(env, t, "spam", staff.uid);
  await env.DB_META.prepare("UPDATE support_tickets SET unread_staff=0 WHERE number=?1").bind(t.number).run();
  if (b?.block === true) {
    const c = await env.DB_META.prepare("SELECT email FROM support_contacts WHERE id=?1").bind(t.contact_id).first<{ email: string | null }>();
    if (c?.email) await addBlock(env, staff, "email", c.email.toLowerCase(), `spam ${ticketCode(t.number)}`);
  }
  return ok();
}

async function blockSender(req: Request, env: Env, staff: StaffCtx): Promise<Response> {
  if (req.method === "GET") {
    const rows = (await env.DB_META.prepare("SELECT kind,value,reason,created_by,created_at FROM support_blocklist ORDER BY created_at DESC LIMIT 500").all<{ kind: string; value: string; reason: string | null; created_by: string | null; created_at: number }>()).results ?? [];
    const names = await staffNameMap(env);
    return ok({ items: rows.map((r) => ({ [r.kind === "domain" ? "domain" : "email"]: r.value, at: r.created_at, by: r.created_by ? (names.get(r.created_by) ?? null) : null, reason: r.reason })) });
  }
  if (req.method === "DELETE") {
    const sp = new URL(req.url).searchParams;
    const q = (await (async () => (sp.get("email") || sp.get("domain") ? null : await bodyOf(req)))());
    const email = (sp.get("email") ?? (typeof q?.email === "string" ? q.email : "")).trim().toLowerCase();
    const domain = (sp.get("domain") ?? (typeof q?.domain === "string" ? q.domain : "")).trim().toLowerCase().replace(/^@/, "");
    if (!email && !domain) return err(400, "invalid_target");
    await env.DB_META.prepare("DELETE FROM support_blocklist WHERE kind=?1 AND value=?2").bind(email ? "email" : "domain", email || domain).run();
    return ok();
  }
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json");
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const domain = typeof b.domain === "string" ? b.domain.trim().toLowerCase().replace(/^@/, "") : "";
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) await addBlock(env, staff, "email", email, typeof b.reason === "string" ? b.reason.slice(0, 200) : null);
  else if (domain && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    if (domain === BRAND.domain || domain.endsWith(`.${BRAND.domain}`)) return err(400, "cannot_block_own_domain");
    await addBlock(env, staff, "domain", domain, typeof b.reason === "string" ? b.reason.slice(0, 200) : null);
  } else return err(400, "invalid_target");
  return ok();
}

async function mergeRoute(req: Request, env: Env, staff: StaffCtx, numberRaw: string): Promise<Response> {
  const from = parseTicketNumber(numberRaw);
  const b = await bodyOf(req);
  const into = parseTicketNumber(b?.into as string | number | undefined);
  if (!from || !into) return err(400, "invalid_ticket");
  const r = await mergeTickets(env, from, into, staff.uid);
  return r.ok ? ok({ into }) : err(r.error === "not_found" ? 404 : 400, r.error);
}

async function splitRoute(req: Request, env: Env, staff: StaffCtx, numberRaw: string): Promise<Response> {
  const num = parseTicketNumber(numberRaw);
  const b = await bodyOf(req);
  if (!num || typeof b?.messageId !== "string") return err(400, "invalid_request");
  const r = await splitTicket(env, num, b.messageId, staff.uid);
  return r.ok ? ok({ number: ticketCode(r.number), code: ticketCode(r.number), seq: r.number }, 201) : err(r.error === "not_found" ? 404 : 400, r.error);
}

async function bulk(req: Request, env: Env, staff: StaffCtx): Promise<Response> {
  const b = await bodyOf(req);
  if (!b || !Array.isArray(b.numbers) || b.numbers.length === 0 || b.numbers.length > 100) return err(400, "invalid_numbers");
  const action = typeof b.action === "string" ? b.action : "";
  const value = b.value;
  const patchFor = (): PatchInput | null => {
    switch (action) {
      case "assign": return { assigneeUid: value === null || value === "" ? null : value };
      case "status": return { status: value };
      case "priority": return { priority: value };
      case "category": return { category: value };
      case "solve": return { status: "solved" };
      case "close": return { status: "closed" };
      case "reopen": return { status: "open" };
      case "spam": return { status: "spam" };
      case "trash": return { status: "trash" };
      case "snooze": return { snoozeUntil: value };
      default: return null;
    }
  };
  const patch = patchFor();
  if (!patch) return err(400, "invalid_action");
  let done = 0;
  const failed: Array<{ number: unknown; error: string }> = [];
  for (const raw of b.numbers as unknown[]) {
    const num = parseTicketNumber(raw as string | number);
    const t = num ? await getTicket(env, num) : null;
    if (!t) { failed.push({ number: raw, error: "not_found" }); continue; }
    const e = await applyPatch(env, staff, t, patch);
    if (e) failed.push({ number: raw, error: e }); else done++;
  }
  return ok({ done, failed });
}

// ---------------------------------------------------------------------------------------------------------------------
// canned replies
// ---------------------------------------------------------------------------------------------------------------------
interface CannedRow { id: string; title: string; shortcut: string | null; category: string | null; body_html: string; updated_at: number }
const cannedDto = (r: CannedRow) => ({ id: r.id, title: r.title, shortcut: r.shortcut, category: r.category, body: htmlToPlainText(r.body_html), bodyHtml: r.body_html, updatedAt: r.updated_at });

async function cannedRoute(req: Request, env: Env, staff: StaffCtx, id: string | null): Promise<Response> {
  const m = req.method;
  if (m === "GET") {
    const rows = (await env.DB_META.prepare("SELECT id,title,shortcut,category,body_html,updated_at FROM support_canned ORDER BY title LIMIT 300").all<CannedRow>()).results ?? [];
    return ok({ items: rows.map(cannedDto), canned: rows.map(cannedDto) });
  }
  if (!canWrite(staff)) return err(403, "read_only");
  if (m === "DELETE") {
    if (!id) return err(400, "missing_id");
    await env.DB_META.prepare("DELETE FROM support_canned WHERE id=?1").bind(id).run();
    return ok();
  }
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json");
  const title = typeof b.title === "string" ? b.title.trim() : "";
  // The desk sends plain text in `body` (placeholders like {customer_name} kept); HTML in bodyHtml / html.
  const htmlIn = [b.bodyHtml, b.body_html, b.html].find((x) => typeof x === "string") as string | undefined;
  const html = htmlIn ?? (typeof b.body === "string" ? textToHtml(b.body) : undefined);
  if (m === "POST") {
    if (!title || title.length > 120 || !html?.trim()) return err(400, "invalid_canned");
    const newId = crypto.randomUUID(); const now = Date.now();
    await env.DB_META.prepare("INSERT INTO support_canned (id,title,shortcut,category,body_html,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)")
      .bind(newId, title, typeof b.shortcut === "string" ? b.shortcut.slice(0, 40) : null, typeof b.category === "string" && isCategory(b.category) ? b.category : null, sanitizeHtml(html), staff.uid, now).run();
    return ok({ id: newId }, 201);
  }
  if (m === "PUT") {
    if (!id) return err(400, "missing_id");
    const cur = await env.DB_META.prepare("SELECT id,title,shortcut,category,body_html,updated_at FROM support_canned WHERE id=?1").bind(id).first<CannedRow>();
    if (!cur) return err(404, "not_found");
    const nt = title || cur.title;
    await env.DB_META.prepare("UPDATE support_canned SET title=?2,shortcut=?3,category=?4,body_html=?5,updated_at=?6 WHERE id=?1").bind(
      id, nt, b.shortcut === undefined ? cur.shortcut : (typeof b.shortcut === "string" ? b.shortcut.slice(0, 40) : null),
      b.category === undefined ? cur.category : (typeof b.category === "string" && isCategory(b.category) ? b.category : null), html?.trim() ? sanitizeHtml(html) : cur.body_html, Date.now()).run();
    return ok();
  }
  return err(405, "method_not_allowed");
}

// ---------------------------------------------------------------------------------------------------------------------
// signature
// ---------------------------------------------------------------------------------------------------------------------
async function signatureRoute(req: Request, env: Env, staff: StaffCtx, test: boolean): Promise<Response> {
  if (test) {
    if (!canWrite(staff)) return err(403, "read_only");
    const to = staff.email ?? (await safe(() => primaryVerifiedEmailFor(env, staff.uid))) ?? (await safe(() => emailFor(env, staff.uid)));
    if (!to) return err(400, "no_email_on_account");
    const given = await bodyOf(req);
    const sig = typeof given?.html === "string" && given.html.trim() ? sanitizeHtml(given.html) : await signatureFor(env, staff.uid);
    const fake = { number: 0, subject: "Signature test" };
    const r = await enqueueEmail(env, {
      to, subject: `${ticketSubject(0, fake.subject).replace("[HF-0]", "[TEST]")}`, kind: "support_test", from: supportFrom(),
      html: wrapReplyHtml("<p>This is how a reply from you will look. Your signature is below.</p>", sig, 0),
      outboxKey: `support-sigtest:${staff.uid}:${Date.now()}`,
    }, { lane: "bulk" });
    return ok({ to, delivery: { status: r.status, queued: r.queued, durable: r.durable } });
  }
  const scope = new URL(req.url).searchParams.get("scope") === "me" ? "me" : "team";
  const key = scope === "me" ? `me:${staff.uid}` : "team";
  if (req.method === "GET") {
    const row = await env.DB_META.prepare("SELECT html,use_for,updated_at FROM support_signatures WHERE scope_key=?1").bind(key).first<{ html: string; use_for: string; updated_at: number }>();
    return ok({ scope, html: row?.html ?? "", useFor: scope === "me" ? (row?.use_for === "personal" ? "personal" : "team") : "team", updatedAt: row?.updated_at ?? null });
  }
  if (req.method !== "PUT") return err(405, "method_not_allowed");
  if (!canWrite(staff)) return err(403, "read_only");
  if (scope === "team" && !isDeskAdmin(staff)) return err(403, "admin_only");
  const b = await bodyOf(req);
  if (!b || typeof b.html !== "string") return err(400, "invalid_html");
  if (b.html.length > 20_000) return err(400, "signature_too_long");
  const useFor = scope === "me" ? (b.useFor === "personal" ? "personal" : b.useFor === "team" ? "team" : null) : "team";
  if (scope === "me" && useFor === null) return err(400, "invalid_use_for");
  await env.DB_META.prepare(
    "INSERT INTO support_signatures (scope_key,html,use_for,updated_by,updated_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(scope_key) DO UPDATE SET html=excluded.html,use_for=excluded.use_for,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
  ).bind(key, sanitizeHtml(b.html), useFor, staff.uid, Date.now()).run();
  return ok();
}

// ---------------------------------------------------------------------------------------------------------------------
// settings and staff
// ---------------------------------------------------------------------------------------------------------------------
async function settingsRoute(req: Request, env: Env, staff: StaffCtx): Promise<Response> {
  const read = async () => {
    const s = await loadSettings(env);
    const qs = await safe(() => env.DB_META.prepare("SELECT value FROM queue_settings WHERE name='whatsapp_min_interval_ms'").first<{ value: number }>());
    // business_hours carries both spellings: the desk reads from/to, the worker uses start/end + utcOffsetMin
    const h = s.hours;
    return {
      alert_whatsapp: s.alertWhatsapp ?? "",
      business_hours: { days: h.days, from: h.start, to: h.end, tz: h.tz ?? "Asia/Kolkata", start: h.start, end: h.end, utcOffsetMin: h.utcOffsetMin },
      holidays: s.holidayLabels,
      automations: s.automations,
      whatsapp_min_interval_ms: qs ? n(qs.value) : 1000,
    };
  };
  if (req.method === "GET") return ok({ settings: await read() });
  if (req.method !== "PUT") return err(405, "method_not_allowed");
  if (!isDeskAdmin(staff)) return err(403, "admin_only");
  const b = await bodyOf(req);
  if (!b) return err(400, "bad_json");
  const src = (b.settings && typeof b.settings === "object" ? b.settings : b) as Record<string, unknown>;
  // alert number: "" switches alerts off
  if (src.alert_whatsapp !== undefined) {
    if (typeof src.alert_whatsapp !== "string" || (src.alert_whatsapp.trim() !== "" && !/^\+\d{8,15}$/.test(src.alert_whatsapp.trim()))) return err(400, "invalid_alert_whatsapp");
  }
  let hoursToStore: Record<string, unknown> | null = null;
  if (src.business_hours !== undefined) {
    const h = src.business_hours as Record<string, unknown>;
    const start = (h?.start ?? h?.from) as unknown;
    const end = (h?.end ?? h?.to) as unknown;
    const tz = typeof h?.tz === "string" ? h.tz.slice(0, 40) : "Asia/Kolkata";
    const offset = Number.isInteger(h?.utcOffsetMin) ? (h.utcOffsetMin as number) : tz === "Asia/Kolkata" ? 330 : NaN;
    const okDays = Array.isArray(h?.days) && h.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6);
    const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!h || !okDays || typeof start !== "string" || typeof end !== "string" || !hm.test(start) || !hm.test(end) || start >= end || !Number.isInteger(offset)) return err(400, "invalid_business_hours");
    hoursToStore = { tz, utcOffsetMin: offset, days: h.days, start, end };
  }
  let holidaysToStore: Array<{ date: string; label: string }> | null = null;
  if (src.holidays !== undefined) {
    if (!(Array.isArray(src.holidays) && src.holidays.length <= 200)) return err(400, "invalid_holidays");
    holidaysToStore = [];
    for (const x of src.holidays as unknown[]) {
      const date = typeof x === "string" ? x : (x as { date?: unknown })?.date;
      const label = typeof x === "string" ? "" : (x as { label?: unknown })?.label;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(400, "invalid_holidays");
      holidaysToStore.push({ date, label: typeof label === "string" ? label.slice(0, 60) : "" });
    }
  }
  let rulesToStore: Array<{ id: string; category: string; assigneeUid: string | null; priority: string | null }> | null = null;
  if (src.automations !== undefined) {
    if (!(Array.isArray(src.automations) && src.automations.length <= 20)) return err(400, "invalid_automations");
    rulesToStore = [];
    const seen = new Set<string>();
    for (const r of src.automations as unknown[]) {
      const o = (r ?? {}) as Record<string, unknown>;
      if (!isCategory(o.category) || seen.has(o.category)) return err(400, "invalid_automations");
      if (o.priority !== null && o.priority !== undefined && o.priority !== "" && !isPriority(o.priority)) return err(400, "invalid_automations");
      let assignee: string | null = null;
      if (typeof o.assigneeUid === "string" && o.assigneeUid) {
        if (!(await resolveAssignee(env, o.assigneeUid))) return err(400, "invalid_assignee");
        assignee = o.assigneeUid;
      }
      seen.add(o.category);
      rulesToStore.push({ id: typeof o.id === "string" && o.id ? o.id.slice(0, 40) : o.category, category: o.category, assigneeUid: assignee, priority: typeof o.priority === "string" && o.priority ? o.priority : null });
    }
  }
  if (src.whatsapp_min_interval_ms !== undefined && !(Number.isInteger(src.whatsapp_min_interval_ms) && (src.whatsapp_min_interval_ms as number) >= 250 && (src.whatsapp_min_interval_ms as number) <= 60_000)) return err(400, "invalid_interval");
  if (src.alert_whatsapp !== undefined) await setSetting(env, "alert_whatsapp", (src.alert_whatsapp as string).trim());
  if (hoursToStore) await setSetting(env, "business_hours", JSON.stringify(hoursToStore));
  if (holidaysToStore) await setSetting(env, "holidays", JSON.stringify(holidaysToStore));
  if (rulesToStore) await setSetting(env, "automations", JSON.stringify(rulesToStore));
  if (src.whatsapp_min_interval_ms !== undefined) {
    await env.DB_META.prepare("INSERT INTO queue_settings (name,value,updated_at) VALUES ('whatsapp_min_interval_ms',?1,?2) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(src.whatsapp_min_interval_ms, Date.now()).run();
  }
  return ok({ settings: await read() });
}

async function staffRoute(req: Request, env: Env, staff: StaffCtx, tail: string | null): Promise<Response> {
  if (req.method === "GET") {
    const rows = (await env.DB_META.prepare("SELECT email,uid,name,role,created_at FROM support_staff ORDER BY created_at, email").all<{ email: string; uid: string | null; name: string | null; role: string; created_at: number }>()).results ?? [];
    const list = rows.map((r) => ({ id: r.email, email: r.email, uid: r.uid, name: r.name, role: r.role, createdAt: r.created_at, active: !!r.uid }));
    return ok({ items: list, staff: list });
  }
  if (!isDeskAdmin(staff)) return err(403, "admin_only");
  if (req.method === "POST") {
    const b = await bodyOf(req);
    const email = typeof b?.email === "string" ? b.email.trim().toLowerCase() : "";
    const role = b?.role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, "invalid_email");
    if (role !== "admin" && role !== "agent" && role !== "viewer") return err(400, "invalid_role");
    await env.DB_META.prepare(
      "INSERT INTO support_staff (email,uid,name,role,created_at) VALUES (?1,NULL,?2,?3,?4) ON CONFLICT(email) DO UPDATE SET role=excluded.role,name=COALESCE(excluded.name,support_staff.name)",
    ).bind(email, typeof b?.name === "string" ? b.name.trim().slice(0, 80) || null : null, role, Date.now()).run();
    return ok({}, 201);
  }
  if (req.method === "DELETE") {
    let email = new URL(req.url).searchParams.get("email") ?? (tail ? decodeURIComponent(tail) : "");
    if (!email) { const b = await bodyOf(req); email = typeof b?.email === "string" ? b.email : ""; }
    email = email.trim().toLowerCase();
    if (!email) return err(400, "invalid_email");
    const row = await env.DB_META.prepare("SELECT uid,role FROM support_staff WHERE email=?1").bind(email).first<{ uid: string | null; role: string }>();
    if (!row) return err(404, "not_found");
    if (row.uid === staff.uid) return err(400, "cannot_remove_yourself");
    if (row.role === "admin") {
      const admins = await env.DB_META.prepare("SELECT COUNT(*) AS c FROM support_staff WHERE role='admin'").first<{ c: number }>();
      if (n(admins?.c) <= 1) return err(400, "last_admin");
    }
    await env.DB_META.prepare("DELETE FROM support_staff WHERE email=?1").bind(email).run();
    return ok();
  }
  return err(405, "method_not_allowed");
}

// ---------------------------------------------------------------------------------------------------------------------
// queues, failed, suppressions
// ---------------------------------------------------------------------------------------------------------------------
async function queuesRoute(env: Env): Promise<Response> {
  const now = Date.now();
  const q = async (sql: string, ...b: unknown[]) => (await safe(() => env.DB_META.prepare(sql).bind(...b).first<Record<string, number | null>>())) ?? {};
  const email = async (lane: "priority" | "bulk") => {
    const waiting = await q(`SELECT COUNT(*) AS w, MIN(created_at) AS oldest FROM email_outbox WHERE lane=?1 AND delivery_status IN ('queued','sending')`, lane);
    const done = await q(`SELECT COUNT(*) AS d FROM email_outbox WHERE lane=?1 AND delivery_status IN ('provider_accepted','delivered') AND accepted_at>?2`, lane, now - 5 * 60_000);
    const failed = await q(`SELECT COUNT(*) AS f FROM email_outbox WHERE lane=?1 AND delivery_status IN ('failed','bounced') AND updated_at>?2`, lane, now - DAY_MS);
    return { queue: `email-${lane}`, kind: "email", waiting: n(waiting.w), donePerMin: Math.round((n(done.d) / 5) * 10) / 10, failed24h: n(failed.f), oldestAt: waiting.oldest ?? null, oldestAgeSec: waiting.oldest ? Math.round((now - n(waiting.oldest)) / 1000) : 0 };
  };
  const wa = async (lane: "priority" | "normal") => {
    const waiting = await q(`SELECT COUNT(*) AS w, MIN(created_at) AS oldest FROM whatsapp_queue_outbox WHERE lane=?1 AND status IN ('queued','sending')`, lane);
    const done = await q(`SELECT COUNT(*) AS d FROM whatsapp_queue_outbox WHERE lane=?1 AND status='sent' AND sent_at>?2`, lane, now - 5 * 60_000);
    const failed = await q(`SELECT COUNT(*) AS f FROM whatsapp_queue_outbox WHERE lane=?1 AND status IN ('failed','manual_reconcile') AND updated_at>?2`, lane, now - DAY_MS);
    return { queue: `whatsapp-${lane}`, kind: "whatsapp", waiting: n(waiting.w), donePerMin: Math.round((n(done.d) / 5) * 10) / 10, failed24h: n(failed.f), oldestAt: waiting.oldest ?? null, oldestAgeSec: waiting.oldest ? Math.round((now - n(waiting.oldest)) / 1000) : 0 };
  };
  const inbound = async () => {
    const waiting = await q(`SELECT COUNT(*) AS w, MIN(created_at) AS oldest FROM support_inbound WHERE status='received'`);
    const done = await q(`SELECT COUNT(*) AS d FROM support_inbound WHERE status IN ('processed','duplicate','dropped','spam') AND processed_at>?1`, now - 5 * 60_000);
    const failed = await q(`SELECT COUNT(*) AS f FROM support_inbound WHERE status='failed' AND COALESCE(processed_at,created_at)>?1`, now - DAY_MS);
    return { queue: "support-inbound", kind: "inbound", waiting: n(waiting.w), donePerMin: Math.round((n(done.d) / 5) * 10) / 10, failed24h: n(failed.f), oldestAt: waiting.oldest ?? null, oldestAgeSec: waiting.oldest ? Math.round((now - n(waiting.oldest)) / 1000) : 0 };
  };
  const raw = await Promise.all([inbound(), email("priority"), email("bulk"), wa("priority"), wa("normal")]);
  // the desk reads name / perMin / oldestSec (and shows its own description per name); the longer names stay for other readers
  const queues = raw.map((x) => ({ ...x, name: x.queue, perMin: x.donePerMin, oldestSec: x.waiting > 0 ? x.oldestAgeSec : null, paused: false }));
  const sup = await q(`SELECT COUNT(*) AS c FROM email_suppressions`);
  // Cloudflare's own queue metrics need an account API token that is not bound to this worker: reported as unavailable, not guessed.
  return ok({ queues, suppressions: n(sup.c), cloudflare: null, asOf: now });
}

interface FailedItem { id: string; kind: "email" | "whatsapp" | "inbound"; status: string; to: string | null; subject: string | null; error: string | null; attempts: number; at: number }

async function failedRoute(env: Env): Promise<Response> {
  const since = Date.now() - 7 * DAY_MS;
  const items: FailedItem[] = [];
  const emails = (await safe(async () => (await env.DB_META.prepare(
    "SELECT outbox_key,to_email,subject,delivery_status,error_message,attempts,updated_at FROM email_outbox WHERE delivery_status IN ('failed','bounced') AND updated_at>?1 ORDER BY updated_at DESC LIMIT 100",
  ).bind(since).all<{ outbox_key: string; to_email: string | null; subject: string | null; delivery_status: string; error_message: string | null; attempts: number; updated_at: number }>()).results ?? [])) ?? [];
  for (const r of emails) items.push({ id: `email:${r.outbox_key}`, kind: "email", status: r.delivery_status, to: r.to_email, subject: r.subject, error: r.error_message, attempts: n(r.attempts), at: r.updated_at });
  const was = (await safe(async () => (await env.DB_META.prepare(
    "SELECT id,e164,kind,status,error,attempts,updated_at FROM whatsapp_queue_outbox WHERE status IN ('failed','manual_reconcile') AND updated_at>?1 ORDER BY updated_at DESC LIMIT 100",
  ).bind(since).all<{ id: string; e164: string; kind: string; status: string; error: string | null; attempts: number; updated_at: number }>()).results ?? [])) ?? [];
  for (const r of was) items.push({ id: `wa:${r.id}`, kind: "whatsapp", status: r.status, to: maskWhatsApp(r.e164), subject: r.kind, error: r.error, attempts: n(r.attempts), at: r.updated_at });
  const ins = (await safe(async () => (await env.DB_META.prepare(
    "SELECT id,env_from,status,reason,attempts,COALESCE(processed_at,created_at) AS at FROM support_inbound WHERE status='failed' AND COALESCE(processed_at,created_at)>?1 ORDER BY at DESC LIMIT 100",
  ).bind(since).all<{ id: string; env_from: string | null; status: string; reason: string | null; attempts: number; at: number }>()).results ?? [])) ?? [];
  for (const r of ins) items.push({ id: `in:${r.id}`, kind: "inbound", status: r.status, to: r.env_from, subject: null, error: r.reason, attempts: n(r.attempts), at: r.at });
  items.sort((a, b) => b.at - a.at);
  const top = items.slice(0, 200);
  return ok({
    failed: top,
    items: top.map((i) => ({ id: i.id, queue: i.kind === "email" ? "email" : i.kind === "whatsapp" ? "whatsapp" : "support-inbound", what: i.subject ?? (i.to ? `To ${i.to}` : i.kind), reason: i.error ?? i.status, at: i.at, kind: i.kind, status: i.status, to: i.to, attempts: i.attempts })),
  });
}

async function failedAction(env: Env, id: string, action: "retry" | "discard", staff: StaffCtx): Promise<Response> {
  const [kind, ...restParts] = id.split(":");
  const ref = restParts.join(":");
  const now = Date.now();
  if (!ref) return err(400, "invalid_id");
  if (kind === "email") {
    const row = await env.DB_META.prepare("SELECT delivery_status FROM email_outbox WHERE outbox_key=?1").bind(ref).first<{ delivery_status: string }>();
    if (!row) return err(404, "not_found");
    if (action === "retry") {
      if (row.delivery_status === "bounced") return err(400, "bounced_cannot_retry", { message: "The address bounced. Remove it from suppressions first if it was a mistake." });
      await env.DB_META.prepare("UPDATE email_outbox SET state='pending',delivery_status='failed',attempts=0,next_attempt_at=?2,lease_expires_at=NULL,error_message=NULL,updated_at=?2 WHERE outbox_key=?1 AND delivery_status='failed'").bind(ref, now).run();
      const queued = await recoverEmailOutbox(env, 20);
      return ok({ requeued: queued });
    }
    await env.DB_META.prepare("UPDATE email_outbox SET next_attempt_at=NULL,error_message=?2,updated_at=?3 WHERE outbox_key=?1 AND delivery_status IN ('failed','bounced')").bind(ref, `discarded by ${staff.uid}`, now).run();
    return ok();
  }
  if (kind === "wa") {
    const row = await env.DB_META.prepare("SELECT status FROM whatsapp_queue_outbox WHERE id=?1").bind(ref).first<{ status: string }>();
    if (!row) return err(404, "not_found");
    if (action === "retry") {
      await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET status='queued',attempts=0,error=NULL,queue_accepted_at=NULL,created_at=MIN(created_at,?2),updated_at=?3 WHERE id=?1 AND status IN ('failed','manual_reconcile')").bind(ref, now - 3 * 60_000, now).run();
      const queued = await recoverWhatsAppQueue(env, 20);
      return ok({ requeued: queued, warning: row.status === "manual_reconcile" ? "the first attempt may already have been delivered" : undefined });
    }
    await env.DB_META.prepare("UPDATE whatsapp_queue_outbox SET status='failed',error=?2,updated_at=?3 WHERE id=?1 AND status IN ('failed','manual_reconcile')").bind(ref, `discarded by ${staff.uid}`, now).run();
    return ok();
  }
  if (kind === "in") {
    const row = await env.DB_META.prepare("SELECT r2_key,env_from,env_to FROM support_inbound WHERE id=?1").bind(ref).first<{ r2_key: string; env_from: string | null; env_to: string | null }>();
    if (!row) return err(404, "not_found");
    if (action === "retry") {
      if (!env.Q_SUPPORT_INBOUND) return err(503, "queue_unavailable");
      await env.DB_META.prepare("UPDATE support_inbound SET status='received',attempts=0,reason=NULL WHERE id=?1 AND status='failed'").bind(ref).run();
      await safeQueueSend(env.Q_SUPPORT_INBOUND, { job: "inbound", r2Key: row.r2_key, envFrom: row.env_from ?? undefined, envTo: row.env_to ?? undefined });
      return ok({ requeued: 1 });
    }
    await env.DB_META.prepare("UPDATE support_inbound SET status='dropped',reason=?2,processed_at=?3 WHERE id=?1 AND status='failed'").bind(ref, `discarded by ${staff.uid}`, now).run();
    return ok();
  }
  return err(400, "invalid_id");
}

async function suppressionsRoute(req: Request, env: Env, staff: StaffCtx): Promise<Response> {
  if (req.method === "GET") {
    const rows = (await env.DB_META.prepare("SELECT email,reason,source,detail,created_at FROM email_suppressions ORDER BY created_at DESC LIMIT 200").all<{ email: string; reason: string; source: string; detail: string | null; created_at: number }>()).results ?? [];
    const list = rows.map((r) => ({ email: r.email, reason: r.reason, source: r.source, detail: r.detail, createdAt: r.created_at, at: r.created_at }));
    return ok({ items: list, suppressions: list });
  }
  if (!isDeskAdmin(staff)) return err(403, "admin_only");
  let email = new URL(req.url).searchParams.get("email") ?? "";
  if (!email) { const b = await bodyOf(req); email = typeof b?.email === "string" ? b.email : ""; }
  email = email.trim().toLowerCase();
  if (!email) return err(400, "invalid_email");
  await env.DB_META.prepare("DELETE FROM email_suppressions WHERE email=?1").bind(email).run();
  return ok();
}

// ---------------------------------------------------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------------------------------------------------
async function reportsRoute(env: Env, url: URL): Promise<Response> {
  const range = url.searchParams.get("range") ?? "7d";
  const days = range === "today" ? 1 : range === "30d" ? 30 : range === "90d" ? 90 : 7;
  const now = Date.now();
  const from = now - days * DAY_MS;
  const rows = (await env.DB_META.prepare(
    "SELECT number,category,priority,status,channel,assignee_uid,created_at,first_responded_at,first_response_due_at,solved_at FROM support_tickets WHERE created_at>?1 AND status<>'spam' AND merged_into IS NULL LIMIT 20000",
  ).bind(from).all<{ number: number; category: string; priority: string; status: string; channel: string; assignee_uid: string | null; created_at: number; first_responded_at: number | null; first_response_due_at: number | null; solved_at: number | null }>()).results ?? [];
  const solvedInRange = n((await env.DB_META.prepare("SELECT COUNT(*) AS c FROM support_tickets WHERE solved_at>?1").bind(from).first<{ c: number }>())?.c);
  const responseMs = rows.filter((r) => r.first_responded_at).map((r) => (r.first_responded_at as number) - r.created_at).sort((a, b) => a - b);
  const median = responseMs.length ? responseMs[Math.floor(responseMs.length / 2)] : null;
  const avg = responseMs.length ? Math.round(responseMs.reduce((a, b) => a + b, 0) / responseMs.length) : null;
  const tally = (key: (r: (typeof rows)[number]) => string) => { const o: Record<string, number> = {}; for (const r of rows) { const k = key(r); o[k] = (o[k] ?? 0) + 1; } return o; };
  const byDay: Record<string, { created: number; solved: number }> = {};
  const ist = 330 * 60_000;
  const dayOf = (ms: number) => new Date(ms + ist).toISOString().slice(0, 10);
  for (const r of rows) { const d = dayOf(r.created_at); (byDay[d] ??= { created: 0, solved: 0 }).created++; }
  for (const r of (await env.DB_META.prepare("SELECT solved_at FROM support_tickets WHERE solved_at>?1 LIMIT 20000").bind(from).all<{ solved_at: number }>()).results ?? []) { const d = dayOf(r.solved_at); (byDay[d] ??= { created: 0, solved: 0 }).solved++; }
  const breached = rows.filter((r) => r.first_response_due_at && ((r.first_responded_at ?? now) > r.first_response_due_at)).length;
  const withDue = rows.filter((r) => r.first_response_due_at);
  const openNow = rows.filter((r) => ["new", "open", "waiting", "on_hold"].includes(r.status)).length;
  const dayList = Object.entries(byDay).sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, v]) => ({ day, ...v }));
  const catMap = tally((r) => r.category);
  return ok({
    totals: { created: rows.length, solved: solvedInRange, open: openNow, firstReplyMinutes: median === null ? null : Math.round(median / 60_000), slaMetPct: withDue.length ? Math.round(((withDue.length - breached) / withDue.length) * 100) : null },
    perDay: dayList,
    range, from, to: now, created: rows.length, solved: solvedInRange, openNow: rows.filter((r) => ["new", "open", "waiting", "on_hold"].includes(r.status)).length,
    firstResponseMedianMin: median === null ? null : Math.round(median / 60_000), firstResponseAvgMin: avg === null ? null : Math.round(avg / 60_000),
    slaBreached: breached, byCategory: Object.entries(catMap).map(([category, count]) => ({ category, count })), byCategoryMap: catMap, byPriority: tally((r) => r.priority), byChannel: tally((r) => r.channel), byStatus: tally((r) => r.status),
    byAgent: tally((r) => r.assignee_uid ?? "unassigned"),
    byDay: Object.entries(byDay).sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, v]) => ({ day, ...v })),
    categories: CATEGORIES,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------------------------------
const WRITE_ROUTES = new Set(["reply", "note", "patch", "merge", "split", "spam", "bulk", "viewing"]);

export async function hfSupportAdminRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const prefix = "/api/admin/hf/support/";
  if (!p.startsWith(prefix)) return null;
  const parts = p.slice(prefix.length).replace(/\/+$/, "").split("/");
  const m = req.method;
  const head = parts[0];

  let route = "";
  let a1: string | null = null;
  let a2: string | null = null;
  if (head === "tickets") {
    if (parts.length === 1 && m === "GET") route = "list";
    else if (parts.length === 2) { a1 = parts[1]; route = m === "GET" ? "get" : m === "PATCH" ? "patch" : ""; }
    else if (parts.length === 3 && m === "POST" && ["reply", "note", "merge", "split", "spam", "viewing"].includes(parts[2])) { a1 = parts[1]; route = parts[2]; }
  } else if (head === "block" && parts.length === 1 && ["GET", "POST", "DELETE"].includes(m)) route = "block";
  else if (head === "bulk" && parts.length === 1 && m === "POST") route = "bulk";
  else if (head === "canned" && parts.length <= 2 && ["GET", "POST", "PUT", "DELETE"].includes(m)) { a1 = parts[1] ?? null; route = "canned"; }
  else if (head === "signature" && parts.length === 1 && (m === "GET" || m === "PUT")) route = "signature";
  else if (head === "signature" && parts[1] === "test" && parts.length === 2 && m === "POST") route = "signature_test";
  else if (head === "settings" && parts.length === 1 && (m === "GET" || m === "PUT")) route = "settings";
  else if (head === "staff" && parts.length <= 2 && ["GET", "POST", "DELETE"].includes(m)) { a1 = parts[1] ?? null; route = "staff"; }
  else if (head === "queues" && parts.length === 1 && m === "GET") route = "queues";
  // the desk calls queues/failed and queues/suppressions; the shorter paths stay as aliases
  else if ((head === "failed" || (head === "queues" && parts[1] === "failed")) && parts.length === (head === "queues" ? 2 : 1) && m === "GET") route = "failed";
  else if ((head === "failed" || (head === "queues" && parts[1] === "failed")) && parts.length === (head === "queues" ? 4 : 3) && m === "POST" && (parts[parts.length - 1] === "retry" || parts[parts.length - 1] === "discard")) {
    a1 = decodeURIComponent(parts[head === "queues" ? 2 : 1]); a2 = parts[parts.length - 1]; route = "failed_action";
  }
  else if ((head === "suppressions" && parts.length === 1) || (head === "queues" && parts[1] === "suppressions" && parts.length === 2)) { if (m === "GET" || m === "DELETE") route = "suppressions"; }
  else if (head === "reports" && parts.length === 1 && m === "GET") route = "reports";
  if (!route) return null;

  try {
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error === "auth not configured" ? "unavailable" : "unauthorized");
    const staff = await resolveStaff(env, u.uid);
    if (!staff) return err(403, "forbidden");
    // viewer = read only: every mutating route is refused before it runs (signature GET, canned GET, staff GET etc. are reads)
    const mutating = WRITE_ROUTES.has(route) || (route === "block" && m !== "GET") || (route === "canned" && m !== "GET") || (route === "signature" && m !== "GET") || route === "signature_test"
      || (route === "settings" && m !== "GET") || (route === "staff" && m !== "GET") || route === "failed_action" || (route === "suppressions" && m !== "GET");
    if (mutating && staff.role === "viewer") return err(403, "read_only");
    switch (route) {
      case "list": return await listTickets(env, staff, new URL(req.url));
      case "get": return await getTicketDetail(env, staff, a1 as string);
      case "patch": return await patchTicket(req, env, staff, a1 as string);
      case "reply": return await replyTicket(req, env, staff, a1 as string);
      case "note": return await noteTicket(req, env, staff, a1 as string);
      case "merge": return await mergeRoute(req, env, staff, a1 as string);
      case "split": return await splitRoute(req, env, staff, a1 as string);
      case "spam": return await spamTicket(req, env, staff, a1 as string);
      case "viewing": return await heartbeat(env, staff, a1 as string);
      case "block": return await blockSender(req, env, staff);
      case "bulk": return await bulk(req, env, staff);
      case "canned": return await cannedRoute(req, env, staff, a1);
      case "signature": return await signatureRoute(req, env, staff, false);
      case "signature_test": return await signatureRoute(req, env, staff, true);
      case "settings": return await settingsRoute(req, env, staff);
      case "staff": return await staffRoute(req, env, staff, a1);
      case "queues": return await queuesRoute(env);
      case "failed": return await failedRoute(env);
      case "failed_action":
        if (!isDeskAdmin(staff)) return err(403, "admin_only");
        return await failedAction(env, a1 as string, a2 as "retry" | "discard", staff);
      case "suppressions": return await suppressionsRoute(req, env, staff);
      case "reports": return await reportsRoute(env, new URL(req.url));
    }
    return null;
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: BRAND.slug, extra: { area: "hf_support_admin" } });
    return err(500, "internal");
  }
}

export { textToHtml, clip, checkAttachmentIds };
