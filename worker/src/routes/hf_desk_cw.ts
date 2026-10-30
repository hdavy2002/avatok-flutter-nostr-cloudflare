// [HF-DESK-CW-1] Chatwoot-compatible API for the agent desk.
//
// The agent desk is Chatwoot's open-source (MIT) dashboard, served as static files. It talks to the Chatwoot REST API, so
// this file answers that API from OUR ticket tables. Nothing here owns ticket logic: replies, notes and status changes go
// through the same functions as the old desk (postStaffReply, applyPatch, addMessage), so email threading, the WhatsApp
// nudge, SLA and the outbox queues behave exactly as before.
//
// Mounted at <api host>/cw/...  (the dashboard's chatwootConfig.apiHost = "https://api.<domain>/cw").
// One account (id 1) and one inbox (id 1 = support@<domain>).
//
// Auth: Chatwoot sends devise-token-auth headers (access-token, client, uid). We mint our own opaque token at
// POST /cw/auth/hf_exchange (caller proves who they are with the normal Clerk bearer and must be support staff) and keep
// only its sha256 in support_desk_sessions. No new Worker secret needed.
//
// ID mapping: conversation id = ticket number; message id = support_messages rowid; activity (event) id = EVENT_BASE + event id;
// agent id = support_staff rowid; contact id = support_contacts.id.
import type { Env } from "../types";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { postStaffReply } from "../lib/support_reply";
import { addMessage } from "../lib/support_ops";
import { applyPatch } from "./hf_support_admin";
import { primaryVerifiedEmailFor } from "../lib/identity";
import {
  addEvent, CATEGORIES, escapeHtml, getTicket, resolveStaff, sanitizeHtml, sha256Hex, type StaffCtx, type TicketRow,
} from "../lib/support_core";

const ACCOUNT_ID = 1;
const INBOX_ID = 1;
const PAGE = 25;
const EVENT_BASE = 1_000_000_000;
const SESSION_MS = 14 * 24 * 3600_000;
const HIDDEN = "('spam','trash')";

const CW_HEADERS = ["access-token", "client", "uid", "token-type", "expiry"];
const cors = (extra: Record<string, string> = {}) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": ["content-type", "authorization", ...CW_HEADERS].join(","),
  "access-control-max-age": "7200",
  "cache-control": "private, no-store",
  ...extra,
});
const out = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...cors() } });
const fail = (status: number, error: string) => out({ error, errors: [error], message: error }, status);
const secs = (ms: number | null | undefined) => (ms ? Math.floor(ms / 1000) : 0);
const n = (v: unknown) => Number(v ?? 0) || 0;

// ---------------------------------------------------------------------------------------------------------------------
// status / priority mapping
// ---------------------------------------------------------------------------------------------------------------------
export function cwStatus(s: string): "open" | "pending" | "snoozed" | "resolved" {
  if (s === "waiting") return "pending";
  if (s === "on_hold") return "snoozed";
  if (s === "solved" || s === "closed" || s === "spam" || s === "trash") return "resolved";
  return "open"; // new | open
}
const STATUS_SQL: Record<string, string> = {
  open: "('new','open')", pending: "('waiting')", snoozed: "('on_hold')", resolved: "('solved','closed')",
};
export const cwPriority = (p: string): string | null => (p === "normal" ? null : p === "low" || p === "high" || p === "urgent" ? p : null);
const ourPriority = (p: unknown): string => (p === "low" || p === "high" || p === "urgent" ? p : "normal");

// ---------------------------------------------------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------------------------------------------------
interface Agent { id: number; uid: string | null; email: string; name: string | null; role: string }

async function agents(env: Env): Promise<Agent[]> {
  const r = await env.DB_META.prepare("SELECT rowid AS id, uid, email, name, role FROM support_staff ORDER BY rowid").all<Agent>();
  return r.results ?? [];
}

/**
 * The desk user for a staff member. Chatwoot treats user id 0 as "signed out" and bounces to the login page, so every
 * staff member needs a real id. A support_staff row is found by uid, else claimed by email (the owner's seed row has no uid
 * until claimed: isAdminUid admins never pass resolveStaff's email path). Admins with no row get a stable non-zero id.
 */
async function agentFor(env: Env, staff: StaffCtx): Promise<Agent> {
  const list = await agents(env);
  const byUid = list.find((a) => a.uid === staff.uid);
  if (byUid) return byUid;
  const email = (staff.email ?? (await primaryVerifiedEmailFor(env, staff.uid).catch(() => null)) ?? "").toLowerCase();
  const byEmail = email ? list.find((a) => !a.uid && a.email.toLowerCase() === email) : undefined;
  if (byEmail) {
    await env.DB_META.prepare("UPDATE support_staff SET uid=?2 WHERE email=?1 AND uid IS NULL").bind(byEmail.email, staff.uid).run().catch(() => undefined);
    return { ...byEmail, uid: staff.uid };
  }
  let h = 0;
  for (const c of staff.uid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { id: 900_000 + (h % 99_999), uid: staff.uid, email: email || staff.email || "", name: staff.name, role: staff.role };
}

async function sessionStaff(req: Request, env: Env): Promise<{ staff: StaffCtx; agent: Agent } | null> {
  const token = req.headers.get("access-token");
  if (!token) return null;
  const row = await env.DB_META.prepare("SELECT uid FROM support_desk_sessions WHERE token_hash=?1 AND expires_at>?2")
    .bind(await sha256Hex(token), Date.now()).first<{ uid: string }>();
  if (!row) return null;
  const staff = await resolveStaff(env, row.uid);
  if (!staff) return null;
  return { staff, agent: await agentFor(env, staff) };
}

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function exchange(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return fail(401, "unauthorized");
  const staff = await resolveStaff(env, u.uid);
  if (!staff) return fail(403, "not_support_staff");
  const token = randomToken();
  const client = randomToken().slice(0, 22);
  const now = Date.now();
  const expires = now + SESSION_MS;
  await env.DB_META.prepare("INSERT INTO support_desk_sessions (token_hash,uid,created_at,expires_at) VALUES (?1,?2,?3,?4)")
    .bind(await sha256Hex(token), staff.uid, now, expires).run();
  await env.DB_META.prepare("DELETE FROM support_desk_sessions WHERE expires_at<?1").bind(now).run().catch(() => undefined);
  const agent = await agentFor(env, staff);
  return out({
    headers: { "access-token": token, "token-type": "Bearer", client, expiry: String(Math.floor(expires / 1000)), uid: agent.email || staff.uid },
    data: userJson(agent, staff),
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// JSON shapes (mirrors app/views/api/v1/**.jbuilder in Chatwoot)
// ---------------------------------------------------------------------------------------------------------------------
// Layout choices the dashboard saves (contact panel open, list layout, sort...). Kept per agent in support_settings.
const DEFAULT_UI: Record<string, unknown> = { is_contact_sidebar_open: true };
const uiKey = (uid: string) => `desk_ui:${uid}`;
async function loadUi(env: Env, uid: string): Promise<Record<string, unknown>> {
  const row = await env.DB_META.prepare("SELECT value FROM support_settings WHERE key=?1").bind(uiKey(uid)).first<{ value: string }>().catch(() => null);
  try { return { ...DEFAULT_UI, ...(row ? JSON.parse(row.value) : {}) }; } catch { return { ...DEFAULT_UI }; }
}
async function saveUi(env: Env, uid: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const next = { ...(await loadUi(env, uid)), ...patch };
  const v = JSON.stringify(next);
  if (v.length > 20_000) return next;
  await env.DB_META.prepare("INSERT INTO support_settings (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(uiKey(uid), v, Date.now()).run();
  return next;
}

const cwRole = (r: string) => (r === "admin" ? "administrator" : "agent");

function userJson(a: Agent, staff: StaffCtx, ui: Record<string, unknown> = DEFAULT_UI) {
  const name = a.name || staff.name || a.email || "Agent";
  return {
    id: a.id, account_id: ACCOUNT_ID, available_name: name, avatar_url: "", confirmed: true, display_name: name, message_signature: "",
    email: a.email || staff.email || "", name, provider: "email", pubsub_token: "", role: cwRole(staff.role), ui_settings: ui, uid: a.email, type: "User",
    access_token: "",
    accounts: [{
      id: ACCOUNT_ID, name: `${BRAND.name} Support`, status: "active", active_at: null, role: cwRole(staff.role), permissions: [cwRole(staff.role)],
      availability: "online", availability_status: "online", auto_offline: false, accepts_conversations: true, accepts_calls: false, api_and_webhooks: false,
    }],
  };
}

function agentJson(a: Agent) {
  const name = a.name || a.email;
  return { id: a.id, account_id: ACCOUNT_ID, availability_status: "online", auto_offline: false, confirmed: true, email: a.email, provider: "email", available_name: name, name, role: cwRole(a.role), thumbnail: "" };
}
const agentEvent = (a: Agent) => ({ id: a.id, name: a.name || a.email, available_name: a.name || a.email, avatar_url: "", type: "user", availability_status: "online", thumbnail: "" });

function accountJson() {
  return {
    id: ACCOUNT_ID, name: `${BRAND.name} Support`, locale: "en", domain: BRAND.domain, support_email: BRAND.emails.support, status: "active",
    settings: {}, created_at: new Date(0).toISOString(), cache_keys: { label: "hf-labels-1", inbox: "hf-inbox-1", team: "hf-team-1" },
    features: { channel_email: true, labels: true, canned_responses: true, macros: false, custom_attributes: false, agent_management: true, inbox_management: true, team_management: false, reports: false, crm: true, help_center: false, campaigns: false, integrations: false, automations: false, voice_recorder: false, captain_integration: false },
  };
}

function inboxJson() {
  return {
    id: INBOX_ID, avatar_url: "", channel_id: 1, name: `${BRAND.name} support`, channel_type: "Channel::Email", provider: null, email: BRAND.emails.support,
    forward_to_email: BRAND.emails.support, greeting_enabled: false, greeting_message: "", working_hours_enabled: false, enable_email_collect: false,
    csat_survey_enabled: false, csat_config: {}, enable_auto_assignment: false, auto_assignment_config: {}, out_of_office_message: "", working_hours: [],
    timezone: "Asia/Kolkata", allow_messages_after_resolved: true, lock_to_single_conversation: false, sender_name_type: "friendly", business_name: BRAND.name,
  };
}

interface Contact { id: number; email: string | null; name: string | null; whatsapp: string | null; uid: string | null; created_at: number }
function contactJson(c: Contact | null) {
  if (!c) return { id: 0, name: "Unknown", email: null, phone_number: null, thumbnail: "", additional_attributes: {}, custom_attributes: {}, blocked: false, identifier: null, type: "contact" };
  return {
    id: c.id, name: c.name || c.email || "Customer", email: c.email, phone_number: c.whatsapp, thumbnail: "", identifier: c.uid,
    additional_attributes: {}, custom_attributes: {}, blocked: false, availability_status: "offline", created_at: secs(c.created_at), type: "contact", contact_type: "lead",
  };
}

const LABEL_COLOURS: Record<string, string> = { calls: "#1f93ff", wallet: "#d81b72", withdraw: "#f59e0b", bookings: "#10b981", influencer: "#8b5cf6", app: "#0ea5e9", report: "#ef4444", other: "#64748b" };
const CAT_KEYS = Object.keys(CATEGORIES) as string[];
const labelsJson = () => CAT_KEYS.map((c, i) => ({ id: i + 1, title: c, description: (CATEGORIES as Record<string, string>)[c] ?? "", color: LABEL_COLOURS[c] ?? "#64748b", show_on_sidebar: true }));

interface MsgRow { rid: number; id: string; ticket_number: number; author_type: string; author_uid: string | null; author_name: string | null; text: string; html_r2_key: string | null; message_id_header: string | null; created_at: number }

async function messageJson(env: Env, m: MsgRow, ag: Agent[], contact: Contact | null, withHtml: boolean, subject: string | null = null) {
  const type = m.author_type === "customer" ? 0 : m.author_type === "system" ? 2 : 1;
  const agent = m.author_uid ? ag.find((a) => a.uid === m.author_uid) : undefined;
  let html: string | null = null;
  if (withHtml && m.html_r2_key) {
    const o = await env.BACKUP_R2.get(m.html_r2_key).catch(() => null);
    if (o) html = sanitizeHtml(await o.text());
  }
  const isEmail = m.author_type === "customer" && !!m.message_id_header;
  const attrs: Record<string, unknown> = {};
  if (isEmail) attrs.email = {
    html_content: html ? { full: html, reply: html } : {}, text_content: { full: m.text, reply: m.text },
    from: contact?.email ? [contact.email] : [], to: [BRAND.emails.support], cc: [], bcc: [], subject: subject ?? undefined, message_id: m.message_id_header,
  };
  return {
    id: m.rid, content: m.text, inbox_id: INBOX_ID, conversation_id: m.ticket_number, message_type: type,
    content_type: isEmail ? "incoming_email" : "text", status: "sent", content_attributes: attrs, created_at: secs(m.created_at),
    private: m.author_type === "note", source_id: m.message_id_header, account_id: ACCOUNT_ID,
    sender: type === 0 ? contactJson(contact) : agent ? agentEvent(agent) : m.author_type === "system" ? undefined : { id: 0, name: m.author_name ?? "Support", type: "user", thumbnail: "" },
    sender_type: type === 0 ? "Contact" : "User", sender_id: type === 0 ? contact?.id ?? 0 : agent?.id ?? 0,
  };
}

async function contactOf(env: Env, id: number): Promise<Contact | null> {
  return env.DB_META.prepare("SELECT id,email,name,whatsapp,uid,created_at FROM support_contacts WHERE id=?1").bind(id).first<Contact>();
}

async function conversationJson(env: Env, t: TicketRow, ag: Agent[], me: Agent) {
  const contact = await contactOf(env, t.contact_id);
  const last = await env.DB_META.prepare(
    "SELECT rowid AS rid,* FROM support_messages WHERE ticket_number=?1 AND author_type IN ('customer','staff','note') ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).bind(t.number).first<MsgRow>();
  const lastJson = last ? await messageJson(env, last, ag, contact, false) : null;
  const assignee = t.assignee_uid ? ag.find((a) => a.uid === t.assignee_uid) : undefined;
  const unread = t.unread_staff ? 1 : 0;
  return {
    meta: { sender: contactJson(contact), channel: "Channel::Email", ...(assignee ? { assignee: agentJson(assignee), assignee_type: "User" } : {}), hmac_verified: false },
    id: t.number, messages: lastJson ? [lastJson] : [], account_id: ACCOUNT_ID, uuid: `hf-${t.number}`,
    additional_attributes: { mail_subject: t.subject, source: t.channel, hf_code: `HF-${t.number}` },
    agent_last_seen_at: unread ? 0 : secs(t.updated_at) + 1, assignee_last_seen_at: 0, can_reply: !["closed", "spam", "trash"].includes(t.status),
    anonymous_caller: false, contact_last_seen_at: 0, custom_attributes: {}, inbox_id: INBOX_ID, labels: [t.category], muted: false,
    snoozed_until: t.status === "on_hold" && t.snooze_until ? secs(t.snooze_until) : null, status: cwStatus(t.status),
    created_at: secs(t.created_at), updated_at: t.updated_at / 1000, timestamp: secs(t.updated_at), first_reply_created_at: secs(t.first_responded_at),
    unread_count: unread, last_non_activity_message: lastJson, last_activity_at: secs(t.updated_at), priority: cwPriority(t.priority),
    waiting_since: t.first_responded_at ? 0 : secs(t.created_at), sla_policy_id: null, _me: me.id,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------------------------------------------------
function listWhere(url: URL, me: StaffCtx): { where: string[]; binds: unknown[] } {
  const where = [`status NOT IN ${HIDDEN}`];
  const binds: unknown[] = [];
  const status = url.searchParams.get("status") ?? "open";
  if (status !== "all" && STATUS_SQL[status]) where.push(`status IN ${STATUS_SQL[status]}`);
  const labels = url.searchParams.getAll("labels[]").concat(url.searchParams.getAll("labels"));
  if (labels.length) { where.push(`category IN (${labels.map(() => "?").join(",")})`); binds.push(...labels); }
  const q = url.searchParams.get("q");
  if (q) { where.push("(subject LIKE ? OR preview LIKE ? OR CAST(number AS TEXT)=?)"); binds.push(`%${q}%`, `%${q}%`, q.replace(/^HF-/i, "")); }
  void me;
  return { where, binds };
}

async function counts(env: Env, url: URL, me: StaffCtx) {
  const { where, binds } = listWhere(url, me);
  const base = where.join(" AND ");
  const one = async (extra: string, more: unknown[] = []) =>
    n((await env.DB_META.prepare(`SELECT COUNT(*) AS c FROM support_tickets WHERE ${base}${extra}`).bind(...binds, ...more).first<{ c: number }>())?.c);
  const mine = await one(" AND assignee_uid=?", [me.uid]);
  const unassigned = await one(" AND assignee_uid IS NULL");
  const all = await one("");
  return { mine_count: mine, assigned_count: all - unassigned, unassigned_count: unassigned, all_count: all };
}

async function listConversations(env: Env, url: URL, me: StaffCtx, meAgent: Agent): Promise<Response> {
  const { where, binds } = listWhere(url, me);
  const type = url.searchParams.get("assignee_type") ?? "me";
  if (type === "me") { where.push("assignee_uid=?"); binds.push(me.uid); }
  else if (type === "unassigned") where.push("assignee_uid IS NULL");
  else if (type === "assigned") where.push("assignee_uid IS NOT NULL");
  const page = Math.max(1, n(url.searchParams.get("page")) || 1);
  const sort = url.searchParams.get("sort_by") ?? "last_activity_at_desc";
  const order: Record<string, string> = {
    last_activity_at_desc: "updated_at DESC", last_activity_at_asc: "updated_at ASC", created_at_desc: "created_at DESC", created_at_asc: "created_at ASC",
    priority_desc: "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC",
    priority_asc: "CASE priority WHEN 'low' THEN 0 WHEN 'normal' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, updated_at DESC",
    waiting_since_asc: "created_at ASC", waiting_since_desc: "created_at DESC",
  };
  const rows = (await env.DB_META.prepare(`SELECT * FROM support_tickets WHERE ${where.join(" AND ")} ORDER BY ${order[sort] ?? order.last_activity_at_desc} LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`)
    .bind(...binds).all<TicketRow>()).results ?? [];
  const ag = await agents(env);
  const payload = [];
  for (const t of rows) payload.push(await conversationJson(env, t, ag, meAgent));
  return out({ data: { meta: await counts(env, url, me), payload } });
}

async function listMessages(env: Env, t: TicketRow, url: URL): Promise<Response> {
  const ag = await agents(env);
  const contact = await contactOf(env, t.contact_id);
  const msgs = (await env.DB_META.prepare("SELECT rowid AS rid,* FROM support_messages WHERE ticket_number=?1 ORDER BY created_at, rowid LIMIT 1000").bind(t.number).all<MsgRow>()).results ?? [];
  const payload = [];
  for (const m of msgs) payload.push(await messageJson(env, m, ag, contact, true, t.subject));
  const events = (await env.DB_META.prepare("SELECT id,actor,type,data_json,created_at FROM support_events WHERE ticket_number=?1 AND type IN ('status','priority','category','assign','merge','merged_into','split','snooze','reopened') ORDER BY id LIMIT 300")
    .bind(t.number).all<{ id: number; actor: string; type: string; data_json: string | null; created_at: number }>()).results ?? [];
  for (const e of events) {
    payload.push({ id: EVENT_BASE + e.id, content: activityText(e, ag), inbox_id: INBOX_ID, conversation_id: t.number, message_type: 2, content_type: "text", status: "sent", content_attributes: {}, created_at: secs(e.created_at), private: false, account_id: ACCOUNT_ID });
  }
  payload.sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  // The dashboard seeds the thread with the latest message and pages around it by id. Ids here are not time-ordered
  // (events sit above EVENT_BASE), so cut by position in the time-sorted list instead. The whole thread fits one page.
  const before = n(url.searchParams.get("before"));
  const after = n(url.searchParams.get("after"));
  let page = payload;
  if (before) { const i = payload.findIndex((x) => x.id === before); page = i >= 0 ? payload.slice(0, i) : payload; }
  else if (after) { const i = payload.findIndex((x) => x.id === after); page = i >= 0 ? payload.slice(i + 1) : []; }
  const assignee = t.assignee_uid ? ag.find((a) => a.uid === t.assignee_uid) : undefined;
  return out({ meta: { labels: [t.category], additional_attributes: { mail_subject: t.subject }, contact: contactJson(contact), ...(assignee ? { assignee: agentEvent(assignee) } : {}), agent_last_seen_at: 0, assignee_last_seen_at: 0 }, payload: page });
}

function activityText(e: { actor: string; type: string; data_json: string | null }, ag: Agent[]): string {
  const who = e.actor === "system" ? "System" : e.actor === "customer" ? "Customer" : (ag.find((a) => a.uid === e.actor)?.name ?? "An agent");
  let d: Record<string, unknown> = {};
  try { d = e.data_json ? JSON.parse(e.data_json) : {}; } catch { /* keep {} */ }
  switch (e.type) {
    case "status": return `${who} changed the status to ${cwStatus(String(d.to ?? ""))}`;
    case "priority": return `${who} set the priority to ${String(d.to ?? "")}`;
    case "category": return `${who} set the label to ${String(d.to ?? "")}`;
    case "assign": return d.to ? `${who} assigned the conversation to ${ag.find((a) => a.uid === d.to)?.name ?? "a teammate"}` : `${who} removed the assignee`;
    case "snooze": return d.until ? `${who} snoozed the conversation` : "Snooze cleared";
    case "reopened": return "The customer reopened the conversation";
    default: return `${who}: ${e.type.replace(/_/g, " ")}`;
  }
}

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) return (await req.json()) as Record<string, unknown>;
    if (ct.includes("multipart/form-data") || ct.includes("form-urlencoded")) {
      const f = await req.formData();
      const o: Record<string, unknown> = {};
      for (const [k, v] of f.entries()) o[k] = v;
      return o;
    }
  } catch { /* empty body */ }
  return {};
}

async function createMessage(req: Request, env: Env, staff: StaffCtx, t: TicketRow): Promise<Response> {
  const b = await bodyOf(req);
  if (Object.keys(b).some((k) => k.startsWith("attachments"))) return fail(422, "Attachments from this desk are not supported yet. Use the old desk for files.");
  const content = typeof b.content === "string" ? b.content.trim() : "";
  if (!content) return fail(422, "Message is empty");
  const isPrivate = b.private === true || b.private === "true";
  const now = Date.now();
  let id: string;
  if (isPrivate) {
    id = await addMessage(env, t.number, { authorType: "note", authorUid: staff.uid, authorName: staff.name ?? staff.email ?? "Staff", text: content, now });
    await addEvent(env, t.number, staff.uid, "note", { messageId: id }, now);
  } else {
    const r = await postStaffReply(env, staff, t, { html: markdownToHtml(content), text: markdownToText(content) }, now);
    if (!r.ok) return fail(422, r.error);
    id = r.messageId;
  }
  const m = await env.DB_META.prepare("SELECT rowid AS rid,* FROM support_messages WHERE id=?1").bind(id).first<MsgRow>();
  if (!m) return fail(500, "internal");
  const json = await messageJson(env, m, await agents(env), await contactOf(env, t.contact_id), false);
  return out({ ...json, ...(typeof b.echo_id === "string" ? { echo_id: b.echo_id } : {}) });
}

async function toggleStatus(req: Request, env: Env, staff: StaffCtx, t: TicketRow): Promise<Response> {
  const b = await bodyOf(req);
  const want = String(b.status ?? (cwStatus(t.status) === "resolved" ? "open" : "resolved"));
  let e: string | null = null;
  if (want === "snoozed") {
    const until = n(b.snoozed_until) ? n(b.snoozed_until) * 1000 : Date.now() + 24 * 3600_000;
    e = await applyPatch(env, staff, t, { snoozeUntil: until });
  } else {
    const map: Record<string, string> = { open: "open", pending: "waiting", resolved: "solved" };
    if (!map[want]) return fail(422, "invalid_status");
    if (t.snooze_until) await applyPatch(env, staff, t, { snoozeUntil: null });
    e = await applyPatch(env, staff, (await getTicket(env, t.number))!, { status: map[want] });
  }
  if (e) return fail(422, e);
  const now = (await getTicket(env, t.number))!;
  return out({ meta: {}, payload: { success: true, conversation_id: t.number, current_status: cwStatus(now.status), snoozed_until: now.status === "on_hold" ? secs(now.snooze_until) : null } });
}

// ---------------------------------------------------------------------------------------------------------------------
// live updates: the desk polls this every few seconds (patched BaseActionCableConnector) instead of an ActionCable socket.
// Events are rebuilt from the tables (no event log): tickets created/updated and messages written since the cursor.
// ---------------------------------------------------------------------------------------------------------------------
const POLL_OVERLAP_MS = 3_000; // D1 writes land a little out of order; re-send a small window, the dashboard upserts by id

async function updates(env: Env, url: URL, me: Agent): Promise<Response> {
  const now = Date.now();
  const since = n(url.searchParams.get("since"));
  if (!since || since < now - 15 * 60_000) return out({ cursor: now, events: [], reload: !!since }); // first poll, or a long sleep: just re-sync
  const from = since - POLL_OVERLAP_MS;
  const ag = await agents(env);
  const events: { event: string; data: unknown }[] = [];
  const tickets = (await env.DB_META.prepare(`SELECT * FROM support_tickets WHERE updated_at>=?1 AND status NOT IN ${HIDDEN} ORDER BY updated_at LIMIT 100`).bind(from).all<TicketRow>()).results ?? [];
  const convs = new Map<number, Awaited<ReturnType<typeof conversationJson>>>();
  for (const t of tickets) {
    const c = await conversationJson(env, t, ag, me);
    convs.set(t.number, c);
    events.push({ event: t.created_at >= from ? "conversation.created" : "conversation.updated", data: c });
  }
  const msgs = (await env.DB_META.prepare("SELECT rowid AS rid,* FROM support_messages WHERE created_at>=?1 AND author_type IN ('customer','staff','note') ORDER BY created_at LIMIT 200").bind(from).all<MsgRow>()).results ?? [];
  for (const m of msgs) {
    const t = await getTicket(env, m.ticket_number);
    if (!t || t.status === "spam" || t.status === "trash") continue;
    const mj = await messageJson(env, m, ag, await contactOf(env, t.contact_id), true, t.subject);
    events.push({ event: "message.created", data: { ...mj, conversation: { assignee_id: ag.find((a) => a.uid === t.assignee_uid)?.id ?? null, unread_count: t.unread_staff ? 1 : 0, last_activity_at: secs(t.updated_at), contact_inbox: { source_id: null } } } });
  }
  return out({ cursor: now, events });
}

// ---------------------------------------------------------------------------------------------------------------------
// markdown (the Chatwoot editor sends markdown) -> email HTML, and -> plain text for the in-app copy
// ---------------------------------------------------------------------------------------------------------------------
function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
export function markdownToHtml(md: string): string {
  const blocks = md.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const html: string[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) html.push(`<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;color:#555">${markdownToHtml(quote.join("\n\n"))}</blockquote>`);
    quote = [];
  };
  for (const b of blocks) {
    const lines = b.split("\n");
    if (lines.every((l) => /^\s*>/.test(l))) { quote.push(lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n")); continue; }
    flushQuote();
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) { html.push(`<ul>${lines.map((l) => `<li>${inlineMd(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`); continue; }
    html.push(`<p>${lines.map(inlineMd).join("<br>")}</p>`);
  }
  flushQuote();
  return html.join("");
}
export const markdownToText = (md: string): string =>
  md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();

// ---------------------------------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------------------------------
export async function hfDeskCwRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (!p.startsWith("/cw/")) return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  const path = p.slice(3).replace(/\.json$/, "").replace(/\/+$/, "");
  const m = req.method;
  const url = new URL(req.url);
  try {
    if (path === "/auth/hf_exchange" && m === "POST") return await exchange(req, env);

    const s = await sessionStaff(req, env);
    if (!s) return fail(401, "You need to sign in or sign up before continuing.");
    const { staff, agent } = s;
    let me = userJson(agent, staff, await loadUi(env, staff.uid));

    if (path === "/auth/validate_token") return out({ payload: { success: true, data: me } });
    if (path === "/auth/sign_out" && m === "DELETE") {
      await env.DB_META.prepare("DELETE FROM support_desk_sessions WHERE token_hash=?1").bind(await sha256Hex(req.headers.get("access-token") ?? "")).run();
      return out({ success: true });
    }
    if (path === "/api/v1/profile" && m === "PUT") {
      const b = await bodyOf(req);
      const prof = (b.profile ?? {}) as Record<string, unknown>;
      if (prof.ui_settings && typeof prof.ui_settings === "object") me = userJson(agent, staff, await saveUi(env, staff.uid, prof.ui_settings as Record<string, unknown>));
      return out(me);
    }
    if (path.startsWith("/api/v1/profile")) return out(me);

    const acc = /^\/api\/v1\/accounts\/(\d+)(\/.*)?$/.exec(path);
    if (!acc) return out({}, 404);
    if (n(acc[1]) !== ACCOUNT_ID) return fail(404, "account_not_found");
    const r = acc[2] ?? "";
    const write = m !== "GET";
    if (write && staff.role === "viewer") return fail(403, "read_only");

    if (r === "") return out(accountJson());
    if (r === "/cache_keys") return out({ cache_keys: accountJson().cache_keys });
    if (r === "/inboxes") return out({ payload: [inboxJson()] });
    if (r === `/inboxes/${INBOX_ID}`) return out(inboxJson());
    if (r === `/inboxes/${INBOX_ID}/assignable_agents` || r === "/agents" || r.startsWith("/assignable_agents")) {
      const list = (await agents(env)).filter((a) => a.uid && a.role !== "viewer").map(agentJson);
      return out(r === "/agents" ? list : { payload: list });
    }
    if (r === "/labels") return out({ payload: labelsJson() });
    if (r === "/canned_responses") {
      const rows = (await env.DB_META.prepare("SELECT rowid AS id,shortcut,title,body_html,created_at,updated_at FROM support_canned ORDER BY title").all<{ id: number; shortcut: string | null; title: string; body_html: string; created_at: number; updated_at: number }>()).results ?? [];
      const q = (url.searchParams.get("search") ?? "").toLowerCase();
      return out(rows.map((c) => ({ id: c.id, account_id: ACCOUNT_ID, short_code: c.shortcut || c.title, content: c.body_html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), created_at: c.created_at, updated_at: c.updated_at }))
        .filter((c) => !q || c.short_code.toLowerCase().includes(q) || c.content.toLowerCase().includes(q)));
    }
    if (r === "/hf_updates") return await updates(env, url, agent);
    if (r === "/conversations" && m === "GET") return await listConversations(env, url, staff, agent);
    if (r === "/conversations/meta") return out({ meta: await counts(env, url, staff) });
    if (r === "/conversations/filter" && m === "POST") return await listConversations(env, url, staff, agent);
    if (r === "/conversations/search") {
      const q = url.searchParams.get("q") ?? "";
      const u2 = new URL(url); u2.searchParams.set("q", q); u2.searchParams.set("status", "all"); u2.searchParams.set("assignee_type", "all");
      return await listConversations(env, u2, staff, agent);
    }
    if (r === "/conversations/unread_counts") return out({ payload: {} });

    const conv = /^\/conversations\/(\d+)(\/.*)?$/.exec(r);
    if (conv) {
      const t = await getTicket(env, n(conv[1]));
      if (!t || t.status === "trash") return fail(404, "Conversation not found");
      const sub = conv[2] ?? "";
      if (sub === "" && m === "GET") return out(await conversationJson(env, t, await agents(env), agent));
      if (sub === "/messages" && m === "GET") return await listMessages(env, t, url);
      if (sub === "/messages" && m === "POST") return await createMessage(req, env, staff, t);
      if (sub === "/toggle_status" && m === "POST") return await toggleStatus(req, env, staff, t);
      if (sub === "/toggle_priority" && m === "POST") {
        const b = await bodyOf(req);
        const e = await applyPatch(env, staff, t, { priority: ourPriority(b.priority) });
        return e ? fail(422, e) : out({});
      }
      if (sub === "/assignments" && m === "POST") {
        const b = await bodyOf(req);
        if (b.team_id !== undefined && b.assignee_id === undefined) return out({});
        const ag = await agents(env);
        const target = b.assignee_id ? ag.find((a) => a.id === n(b.assignee_id)) : undefined;
        if (b.assignee_id && !target?.uid) return fail(422, "invalid_assignee");
        const e = await applyPatch(env, staff, t, { assigneeUid: target?.uid ?? null });
        if (e) return fail(422, e);
        return out(target ? agentEvent(target) : null);
      }
      if (sub === "/labels") {
        if (m === "GET") return out({ payload: [t.category] });
        const b = await bodyOf(req);
        const list = Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : [];
        const pick = [...list].reverse().find((l) => CAT_KEYS.includes(l)) ?? "other";
        const e = await applyPatch(env, staff, t, { category: pick });
        return e ? fail(422, e) : out({ payload: [pick] });
      }
      if (sub === "/update_last_seen" || sub === "/unread") {
        await env.DB_META.prepare("UPDATE support_tickets SET unread_staff=?2 WHERE number=?1").bind(t.number, sub === "/unread" ? 1 : 0).run();
        return out({});
      }
      if (sub === "/participants") return out([]);
      if (sub === "/attachments") return out({ payload: [] });
      if (sub === "/draft_messages") return out({});
      return out({});
    }

    const ct = /^\/contacts\/(\d+)(\/.*)?$/.exec(r);
    if (ct) {
      const c = await contactOf(env, n(ct[1]));
      if (!c) return fail(404, "Contact not found");
      const sub = ct[2] ?? "";
      if (sub === "") return out({ payload: contactJson(c) });
      if (sub === "/conversations") {
        const rows = (await env.DB_META.prepare(`SELECT * FROM support_tickets WHERE contact_id=?1 AND status NOT IN ${HIDDEN} ORDER BY updated_at DESC LIMIT 20`).bind(c.id).all<TicketRow>()).results ?? [];
        const ag = await agents(env);
        const payload = [];
        for (const t of rows) payload.push(await conversationJson(env, t, ag, agent));
        return out({ payload });
      }
      if (sub === "/labels") return out({ payload: [] });
      return out({ payload: [] });
    }

    // Everything the email desk does not use yet: answer empty in the shape the dashboard expects, so screens render.
    if (r === "/notifications") return out({ data: { meta: { unread_count: 0, count: 0, current_page: 1 }, payload: [] } });
    if (r === "/notifications/unread_count") return out(0);
    if (r === "/custom_filters" || r === "/teams" || r === "/custom_attribute_definitions" || r === "/macros" || r === "/dashboard_apps" || r === "/agent_bots" || r === "/automation_rules" || r === "/campaigns" || r === "/portals" || r === "/working_hours") return out(r === "/macros" || r === "/automation_rules" || r === "/portals" ? { payload: [] } : []);
    if (r === "/integrations/apps") return out({ payload: [] });
    if (r.startsWith("/contacts")) return out({ meta: { count: 0, current_page: 1 }, payload: [] });
    return out(m === "GET" ? { payload: [] } : {});
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: BRAND.slug, extra: { area: "hf_desk_cw" } });
    return fail(500, "internal");
  }
}
