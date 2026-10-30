// [HF-DESK-CW-1] Chatwoot-compatible API for the agent desk.
//
// The agent desk is Chatwoot's open-source (MIT) dashboard, served as static files. It talks to the Chatwoot REST API, so
// this file answers that API from OUR ticket tables. Nothing here owns ticket logic: replies, notes and status changes go
// through the same functions as the old desk (postStaffReply, applyPatch, addMessage, mergeTickets, splitTicket), so email
// threading, the WhatsApp nudge, SLA and the outbox queues behave exactly as before.
//
// Mounted at <api host>/cw/...  (the dashboard's chatwootConfig.apiHost = "https://api.<domain>/cw").
// One account (id 1) and one inbox (id 1 = support@<domain>).
//
// Auth: Chatwoot sends devise-token-auth headers (access-token, client, uid). We mint our own opaque token at
// POST /cw/auth/hf_exchange (caller proves who they are with the normal Clerk bearer and must be support staff) and keep
// only its sha256 in support_desk_sessions. No new Worker secret needed.
//
// ID mapping: conversation id = ticket number; message id = support_messages rowid; activity (event) id = EVENT_BASE + event id;
// agent id = support_staff rowid; contact id = support_contacts.id; canned response id = support_canned rowid;
// label id = 1..8 for the built-in categories, LABEL_BASE + support_labels.id for agent-made labels.
//
// [HF-DESK-CW-3] attachments (signed links + uploads), To/Cc/Bcc, settings that save (agents, labels, canned replies,
// personal signature), contacts list, full search, spam / merge / split / block sender.
import type { Env } from "../types";
import { requireUser, isFail } from "../authz";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { postStaffReply } from "../lib/support_reply";
import { addMessage, mergeTickets, splitTicket } from "../lib/support_ops";
import { applyPatch } from "./hf_support_admin";
import { primaryVerifiedEmailFor } from "../lib/identity";
import {
  addEvent, attachmentKey, CATEGORIES, checkAttachment, escapeHtml, fileExtension, getTicket, MAX_MESSAGE_ATTACHMENT_BYTES, resolveStaff,
  safeFileName, sanitizeHtml, setTicketStatus, sha256Hex, type StaffCtx, type TicketRow,
} from "../lib/support_core";

const ACCOUNT_ID = 1;
const INBOX_ID = 1;
const PAGE = 25;
const EVENT_BASE = 1_000_000_000;
const LABEL_BASE = 100;
const SESSION_MS = 14 * 24 * 3600_000;
const HIDDEN = "('spam','trash')";
const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

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
const str = (v: unknown) => (typeof v === "string" ? v : "");

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

interface Session { staff: StaffCtx; agent: Agent; th: string; base: string }

async function sessionStaff(req: Request, env: Env): Promise<Session | null> {
  const token = req.headers.get("access-token");
  if (!token) return null;
  const th = await sha256Hex(token);
  const row = await env.DB_META.prepare("SELECT uid FROM support_desk_sessions WHERE token_hash=?1 AND expires_at>?2").bind(th, Date.now()).first<{ uid: string }>();
  if (!row) return null;
  const staff = await resolveStaff(env, row.uid);
  if (!staff) return null;
  return { staff, agent: await agentFor(env, staff), th, base: `${new URL(req.url).origin}/cw` };
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
// per-agent settings kept in support_settings: layout (ui_settings) and the markdown of the personal signature
// ---------------------------------------------------------------------------------------------------------------------
const DEFAULT_UI: Record<string, unknown> = { is_contact_sidebar_open: true };
const uiKey = (uid: string) => `desk_ui:${uid}`;
const sigKey = (uid: string) => `desk_sig:${uid}`;
async function getSettingValue(env: Env, key: string): Promise<string | null> {
  const row = await env.DB_META.prepare("SELECT value FROM support_settings WHERE key=?1").bind(key).first<{ value: string }>().catch(() => null);
  return row?.value ?? null;
}
async function putSettingValue(env: Env, key: string, value: string): Promise<void> {
  await env.DB_META.prepare("INSERT INTO support_settings (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(key, value, Date.now()).run();
}
async function loadUi(env: Env, uid: string): Promise<Record<string, unknown>> {
  const v = await getSettingValue(env, uiKey(uid));
  try { return { ...DEFAULT_UI, ...(v ? JSON.parse(v) : {}) }; } catch { return { ...DEFAULT_UI }; }
}
async function saveUi(env: Env, uid: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const next = { ...(await loadUi(env, uid)), ...patch };
  const v = JSON.stringify(next);
  if (v.length <= 20_000) await putSettingValue(env, uiKey(uid), v);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------------
// JSON shapes (mirrors app/views/api/v1/**.jbuilder in Chatwoot)
// ---------------------------------------------------------------------------------------------------------------------
const cwRole = (r: string) => (r === "admin" ? "administrator" : "agent");

function userJson(a: Agent, staff: StaffCtx, ui: Record<string, unknown> = DEFAULT_UI, signature = "") {
  const name = a.name || staff.name || a.email || "Agent";
  return {
    id: a.id, account_id: ACCOUNT_ID, available_name: name, avatar_url: "", confirmed: true, display_name: name, message_signature: signature,
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
  return { id: a.id, account_id: ACCOUNT_ID, availability_status: a.uid ? "online" : "offline", auto_offline: false, confirmed: !!a.uid, email: a.email, provider: "email", available_name: name, name, role: cwRole(a.role), thumbnail: "" };
}
const agentEvent = (a: Agent) => ({ id: a.id, name: a.name || a.email, available_name: a.name || a.email, avatar_url: "", type: "user", availability_status: "online", thumbnail: "" });

async function cacheKeys(env: Env) {
  const l = await env.DB_META.prepare("SELECT COUNT(*) AS c, COALESCE(MAX(updated_at),0) AS u FROM support_labels").first<{ c: number; u: number }>().catch(() => null);
  return { label: `hf-labels-${l?.c ?? 0}-${l?.u ?? 0}`, inbox: "hf-inbox-1", team: "hf-team-1" };
}

async function accountJson(env: Env) {
  return {
    id: ACCOUNT_ID, name: `${BRAND.name} Support`, locale: "en", domain: BRAND.domain, support_email: BRAND.emails.support, status: "active",
    settings: {}, created_at: new Date(0).toISOString(), cache_keys: await cacheKeys(env),
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
async function isBlockedEmail(env: Env, email: string | null): Promise<boolean> {
  if (!email) return false;
  const e = email.toLowerCase();
  const r = await env.DB_META.prepare("SELECT 1 AS x FROM support_blocklist WHERE (kind='email' AND value=?1) OR (kind='domain' AND value=?2) LIMIT 1").bind(e, e.split("@")[1] ?? "").first().catch(() => null);
  return !!r;
}
function contactJson(c: Contact | null, blocked = false) {
  if (!c) return { id: 0, name: "Unknown", email: null, phone_number: null, thumbnail: "", additional_attributes: {}, custom_attributes: {}, blocked: false, identifier: null, type: "contact" };
  return {
    id: c.id, name: c.name || c.email || "Customer", email: c.email, phone_number: c.whatsapp, thumbnail: "", identifier: c.uid,
    additional_attributes: {}, custom_attributes: {}, blocked, availability_status: "offline", created_at: secs(c.created_at), type: "contact", contact_type: "lead",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// labels: the 8 built-in categories (one per ticket) + agent-made labels (any number per ticket)
// ---------------------------------------------------------------------------------------------------------------------
// [HF-DESK-UX-1] website palette (no green): lavender, rani, marigold, plum2, rani-light, plum, deep red, muted
const LABEL_COLOURS: Record<string, string> = { calls: "#6d4fd0", wallet: "#d81b72", withdraw: "#f59e0b", bookings: "#6b2468", influencer: "#e0569b", app: "#4a1747", report: "#b42318", other: "#6f5b6f" };
const CAT_KEYS = Object.keys(CATEGORIES) as string[];
interface LabelRow { id: number; title: string; description: string; color: string; show_on_sidebar: number }
async function customLabels(env: Env): Promise<LabelRow[]> {
  return (await env.DB_META.prepare("SELECT id,title,description,color,show_on_sidebar FROM support_labels ORDER BY title").all<LabelRow>().catch(() => ({ results: [] as LabelRow[] }))).results ?? [];
}
async function labelsJson(env: Env) {
  const builtIn = CAT_KEYS.map((c, i) => ({ id: i + 1, title: c, description: (CATEGORIES as Record<string, string>)[c] ?? "", color: LABEL_COLOURS[c] ?? "#6f5b6f", show_on_sidebar: true }));
  const mine = (await customLabels(env)).map((l) => ({ id: LABEL_BASE + l.id, title: l.title, description: l.description, color: l.color, show_on_sidebar: !!l.show_on_sidebar }));
  return [...builtIn, ...mine];
}
async function ticketLabels(env: Env, t: Pick<TicketRow, "number" | "category">): Promise<string[]> {
  const rows = (await env.DB_META.prepare("SELECT label FROM support_ticket_labels WHERE ticket_number=?1 ORDER BY label").bind(t.number).all<{ label: string }>().catch(() => ({ results: [] as { label: string }[] }))).results ?? [];
  return [t.category, ...rows.map((r) => r.label).filter((l) => l !== t.category)];
}
const LABEL_TITLE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

// ---------------------------------------------------------------------------------------------------------------------
// attachments: signed download links (an <img> cannot send the access-token header)
// ---------------------------------------------------------------------------------------------------------------------
interface AttRow { id: string; message_id: string | null; name: string; size: number; content_type: string }
const fileSig = async (attId: string, th: string) => (await sha256Hex(`hf-desk-file:${attId}:${th}`)).slice(0, 32);
async function attJson(a: AttRow, rid: number, th: string, base: string) {
  const url = `${base}/files/${a.id}/${encodeURIComponent(safeFileName(a.name))}?k=${th.slice(0, 16)}&s=${await fileSig(a.id, th)}`;
  const kind = a.content_type.startsWith("image/") ? "image" : a.content_type.startsWith("video/") ? "video" : a.content_type.startsWith("audio/") ? "audio" : "file";
  return { id: a.id, message_id: rid, file_type: kind, account_id: ACCOUNT_ID, extension: fileExtension(a.name), data_url: url, thumb_url: kind === "image" ? url : "", file_size: a.size, width: null, height: null, file_name: a.name };
}
async function attachmentsOf(env: Env, ticket: number): Promise<Map<string, AttRow[]>> {
  const rows = (await env.DB_META.prepare("SELECT id,message_id,name,size,content_type FROM support_attachments WHERE ticket_number=?1 AND purpose='ticket'").bind(ticket).all<AttRow>()).results ?? [];
  const map = new Map<string, AttRow[]>();
  for (const r of rows) if (r.message_id) map.set(r.message_id, [...(map.get(r.message_id) ?? []), r]);
  return map;
}

async function serveFile(env: Env, url: URL, id: string): Promise<Response> {
  const k = url.searchParams.get("k") ?? "";
  const s = url.searchParams.get("s") ?? "";
  if (!/^[0-9a-f]{16}$/.test(k) || !/^[0-9a-f]{32}$/.test(s) || !/^[0-9a-f-]{36}$/i.test(id)) return new Response("not found", { status: 404 });
  const sessions = (await env.DB_META.prepare("SELECT token_hash FROM support_desk_sessions WHERE substr(token_hash,1,16)=?1 AND expires_at>?2 LIMIT 5").bind(k, Date.now()).all<{ token_hash: string }>()).results ?? [];
  let okSig = false;
  for (const r of sessions) if ((await fileSig(id, r.token_hash)) === s) okSig = true;
  if (!okSig) return new Response("link expired", { status: 403 });
  const a = await env.DB_META.prepare("SELECT r2_key,name,content_type FROM support_attachments WHERE id=?1 AND purpose='ticket'").bind(id).first<{ r2_key: string; name: string; content_type: string }>();
  if (!a) return new Response("not found", { status: 404 });
  const obj = await env.BACKUP_R2.get(a.r2_key);
  if (!obj) return new Response("not found", { status: 404 });
  const inline = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i.test(a.content_type);
  const fname = safeFileName(a.name).replace(/"/g, "");
  return new Response(obj.body, {
    headers: {
      "content-type": inline ? a.content_type : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${fname}"`,
      "x-content-type-options": "nosniff", "cache-control": "private, max-age=300", "access-control-allow-origin": "*",
    },
  });
}

/** Files sent from the desk (multipart attachments[]): stored like the old desk's uploads, ready for postStaffReply / addMessage. */
async function storeUploads(env: Env, staff: StaffCtx, files: File[]): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  if (files.length > 10) return { ok: false, error: "At most 10 files per message." };
  let total = 0;
  const ids: string[] = [];
  for (const f of files) {
    const name = safeFileName(f.name || "file");
    const type = (f.type || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const v = checkAttachment(name, type, f.size);
    if (!v.ok) return { ok: false, error: v.reason === "too_large" ? `${name} is larger than 10 MB.` : v.reason === "empty" ? `${name} is empty.` : `${name}: this file type is not allowed (images, PDFs and documents only).` };
    total += f.size;
    if (total > MAX_MESSAGE_ATTACHMENT_BYTES) return { ok: false, error: "Files add up to more than 25 MB." };
  }
  for (const f of files) {
    const id = crypto.randomUUID();
    const name = safeFileName(f.name || "file");
    const type = (f.type || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const key = attachmentKey("pending", id, name);
    await env.BACKUP_R2.put(key, new Uint8Array(await f.arrayBuffer()), { httpMetadata: { contentType: type }, customMetadata: { name: name.slice(0, 200) } });
    await env.DB_META.prepare("INSERT INTO support_attachments (id,r2_key,name,size,content_type,ticket_number,message_id,uid,purpose,created_at) VALUES (?1,?2,?3,?4,?5,NULL,NULL,?6,'ticket',?7)")
      .bind(id, key, name, f.size, type, staff.uid, Date.now()).run();
    ids.push(id);
  }
  return { ok: true, ids };
}

// ---------------------------------------------------------------------------------------------------------------------
// messages and conversations
// ---------------------------------------------------------------------------------------------------------------------
interface MsgRow { rid: number; id: string; ticket_number: number; author_type: string; author_uid: string | null; author_name: string | null; text: string; html_r2_key: string | null; message_id_header: string | null; created_at: number }

interface MsgCtx { ag: Agent[]; contact: Contact | null; th: string; base: string; subject?: string | null; atts?: Map<string, AttRow[]> }

async function messageJson(env: Env, m: MsgRow, c: MsgCtx, withHtml: boolean) {
  const type = m.author_type === "customer" ? 0 : m.author_type === "system" ? 2 : 1;
  const agent = m.author_uid ? c.ag.find((a) => a.uid === m.author_uid) : undefined;
  let html: string | null = null;
  if (withHtml && m.html_r2_key && m.author_type === "customer") {
    const o = await env.BACKUP_R2.get(m.html_r2_key).catch(() => null);
    if (o) html = sanitizeHtml(await o.text());
  }
  const isEmail = m.author_type === "customer" && !!m.message_id_header;
  const attrs: Record<string, unknown> = {};
  if (isEmail) attrs.email = {
    html_content: html ? { full: html, reply: html } : {}, text_content: { full: m.text, reply: m.text },
    from: c.contact?.email ? [c.contact.email] : [], to: [BRAND.emails.support], cc: [], bcc: [], subject: c.subject ?? undefined, message_id: m.message_id_header,
  };
  const files = c.atts?.get(m.id) ?? [];
  const attachments = [];
  for (const a of files) attachments.push(await attJson(a, m.rid, c.th, c.base));
  return {
    id: m.rid, content: m.text, inbox_id: INBOX_ID, conversation_id: m.ticket_number, message_type: type,
    content_type: isEmail ? "incoming_email" : "text", status: "sent", content_attributes: attrs, created_at: secs(m.created_at),
    private: m.author_type === "note", source_id: m.message_id_header, account_id: ACCOUNT_ID,
    sender: type === 0 ? contactJson(c.contact) : agent ? agentEvent(agent) : m.author_type === "system" ? undefined : { id: 0, name: m.author_name ?? "Support", type: "user", thumbnail: "" },
    sender_type: type === 0 ? "Contact" : "User", sender_id: type === 0 ? c.contact?.id ?? 0 : agent?.id ?? 0,
    ...(attachments.length ? { attachments } : {}),
  };
}

async function contactOf(env: Env, id: number): Promise<Contact | null> {
  return env.DB_META.prepare("SELECT id,email,name,whatsapp,uid,created_at FROM support_contacts WHERE id=?1").bind(id).first<Contact>();
}

async function conversationJson(env: Env, t: TicketRow, ag: Agent[], me: Agent, th: string, base = "") {
  const contact = await contactOf(env, t.contact_id);
  const last = await env.DB_META.prepare(
    "SELECT rowid AS rid,* FROM support_messages WHERE ticket_number=?1 AND author_type IN ('customer','staff','note') ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).bind(t.number).first<MsgRow>();
  const lastJson = last ? await messageJson(env, last, { ag, contact, th, base, atts: await attachmentsOf(env, t.number) }, false) : null;
  const assignee = t.assignee_uid ? ag.find((a) => a.uid === t.assignee_uid) : undefined;
  const unread = t.unread_staff ? 1 : 0;
  return {
    meta: { sender: contactJson(contact), channel: "Channel::Email", ...(assignee ? { assignee: agentJson(assignee), assignee_type: "User" } : {}), hmac_verified: false },
    id: t.number, messages: lastJson ? [lastJson] : [], account_id: ACCOUNT_ID, uuid: `hf-${t.number}`,
    additional_attributes: { mail_subject: t.subject, source: t.channel, hf_code: `HF-${t.number}` },
    agent_last_seen_at: unread ? 0 : secs(t.updated_at) + 1, assignee_last_seen_at: 0, can_reply: !["closed", "spam", "trash"].includes(t.status),
    anonymous_caller: false, contact_last_seen_at: 0, custom_attributes: {}, inbox_id: INBOX_ID, labels: await ticketLabels(env, t), muted: false,
    snoozed_until: t.status === "on_hold" && t.snooze_until ? secs(t.snooze_until) : null, status: cwStatus(t.status),
    created_at: secs(t.created_at), updated_at: t.updated_at / 1000, timestamp: secs(t.updated_at), first_reply_created_at: secs(t.first_responded_at),
    unread_count: unread, last_non_activity_message: lastJson, last_activity_at: secs(t.updated_at), priority: cwPriority(t.priority),
    waiting_since: t.first_responded_at ? 0 : secs(t.created_at), sla_policy_id: null, _me: me.id,
  };
}

/** Text search across ticket number, subject, preview, the customer's email / name and every message's text. */
function searchClause(q: string): { sql: string; binds: unknown[] } {
  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const num = q.replace(/^\s*#?HF-?/i, "").trim();
  return {
    sql: `(subject LIKE ?1 ESCAPE '\\' OR preview LIKE ?1 ESCAPE '\\' OR CAST(number AS TEXT)=?2
      OR contact_id IN (SELECT id FROM support_contacts WHERE email LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' OR whatsapp LIKE ?1 ESCAPE '\\')
      OR number IN (SELECT ticket_number FROM support_messages WHERE text LIKE ?1 ESCAPE '\\'))`,
    binds: [like, num],
  };
}

/** Numbered ?N placeholders are local to one clause; renumber them so several clauses can share one statement. */
function renumber(sql: string, offset: number): string {
  return sql.replace(/\?(\d+)/g, (_, d) => `?${Number(d) + offset}`);
}

function listWhere(url: URL): { where: string[]; binds: unknown[] } {
  const where = [`status NOT IN ${HIDDEN}`];
  const binds: unknown[] = [];
  const add = (sql: string, b: unknown[]) => { where.push(renumber(sql, binds.length)); binds.push(...b); };
  const status = url.searchParams.get("status") ?? "open";
  if (status !== "all" && STATUS_SQL[status]) where.push(`status IN ${STATUS_SQL[status]}`);
  const labels = url.searchParams.getAll("labels[]").concat(url.searchParams.getAll("labels")).filter(Boolean);
  if (labels.length) {
    const marks = labels.map((_, i) => `?${i + 1}`).join(",");
    add(`(category IN (${marks}) OR number IN (SELECT ticket_number FROM support_ticket_labels WHERE label IN (${marks})))`, labels);
  }
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q) { const c = searchClause(q); add(c.sql, c.binds); }
  return { where, binds };
}

async function counts(env: Env, url: URL, me: StaffCtx) {
  const { where, binds } = listWhere(url);
  const base = where.join(" AND ");
  const one = async (extra: string, more: unknown[] = []) =>
    n((await env.DB_META.prepare(`SELECT COUNT(*) AS c FROM support_tickets WHERE ${base}${renumber(extra, binds.length)}`).bind(...binds, ...more).first<{ c: number }>())?.c);
  const mine = await one(" AND assignee_uid=?1", [me.uid]);
  const unassigned = await one(" AND assignee_uid IS NULL");
  const all = await one("");
  return { mine_count: mine, assigned_count: all - unassigned, unassigned_count: unassigned, all_count: all };
}

async function listConversations(env: Env, url: URL, s: Session): Promise<Response> {
  const { where, binds } = listWhere(url);
  const type = url.searchParams.get("assignee_type") ?? "me";
  if (type === "me") { where.push(`assignee_uid=?${binds.length + 1}`); binds.push(s.staff.uid); }
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
  for (const t of rows) payload.push(await conversationJson(env, t, ag, s.agent, s.th, s.base));
  return out({ data: { meta: await counts(env, url, s.staff), payload } });
}

async function listMessages(env: Env, t: TicketRow, url: URL, th: string, base: string): Promise<Response> {
  const ag = await agents(env);
  const contact = await contactOf(env, t.contact_id);
  const atts = await attachmentsOf(env, t.number);
  const msgs = (await env.DB_META.prepare("SELECT rowid AS rid,* FROM support_messages WHERE ticket_number=?1 ORDER BY created_at, rowid LIMIT 1000").bind(t.number).all<MsgRow>()).results ?? [];
  const payload: Array<{ id: number; created_at: number } & Record<string, unknown>> = [];
  for (const m of msgs) payload.push(await messageJson(env, m, { ag, contact, th, base, subject: t.subject, atts }, true));
  const events = (await env.DB_META.prepare("SELECT id,actor,type,data_json,created_at FROM support_events WHERE ticket_number=?1 AND type IN ('status','priority','category','assign','merge','merge_in','split','snooze','reopened','labels','spam','block') ORDER BY id LIMIT 300")
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
  return out({ meta: { labels: await ticketLabels(env, t), additional_attributes: { mail_subject: t.subject }, contact: contactJson(contact), ...(assignee ? { assignee: agentEvent(assignee) } : {}), agent_last_seen_at: 0, assignee_last_seen_at: 0 }, payload: page });
}

function activityText(e: { actor: string; type: string; data_json: string | null }, ag: Agent[]): string {
  const who = e.actor === "system" ? "System" : e.actor === "customer" ? "Customer" : (ag.find((a) => a.uid === e.actor)?.name ?? "An agent");
  let d: Record<string, unknown> = {};
  try { d = e.data_json ? JSON.parse(e.data_json) : {}; } catch { /* keep {} */ }
  switch (e.type) {
    case "status": return `${who} changed the status to ${cwStatus(String(d.to ?? ""))}`;
    case "priority": return `${who} set the priority to ${String(d.to ?? "")}`;
    case "category": return `${who} set the category to ${String(d.to ?? "")}`;
    case "labels": return `${who} changed the labels`;
    case "assign": return d.to ? `${who} assigned the conversation to ${ag.find((a) => a.uid === d.to)?.name ?? "a teammate"}` : `${who} removed the assignee`;
    case "snooze": return d.until ? `${who} snoozed the conversation` : "Snooze cleared";
    case "reopened": return "The customer reopened the conversation";
    case "merge": return `${who} merged this conversation into HF-${String(d.into ?? "")}`;
    case "merge_in": return `${who} merged HF-${String(d.from ?? "")} into this conversation`;
    case "split": return `${who} split a message into HF-${String(d.to ?? d.number ?? "")}`;
    case "block": return `${who} blocked the sender`;
    default: return `${who}: ${e.type.replace(/_/g, " ")}`;
  }
}

async function bodyOf(req: Request): Promise<{ data: Record<string, unknown>; files: File[] }> {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) return { data: (await req.json()) as Record<string, unknown>, files: [] };
    if (ct.includes("multipart/form-data") || ct.includes("form-urlencoded")) {
      const f = await req.formData();
      const o: Record<string, unknown> = {};
      const files: File[] = [];
      for (const [k, v] of f.entries()) {
        if (typeof v !== "string") { if (k.startsWith("attachments")) files.push(v as File); continue; }
        if (k.endsWith("[]")) o[k.slice(0, -2)] = [...((o[k.slice(0, -2)] as unknown[]) ?? []), v];
        else o[k] = v;
      }
      return { data: o, files };
    }
  } catch { /* empty body */ }
  return { data: {}, files: [] };
}

/**
 * Chatwoot appends the previous email as a "> On ... wrote:" quote. The email keeps it (normal email etiquette); the ticket
 * stores only the new text, so the app and the desk do not show the whole thread again under every reply.
 */
export function splitQuote(content: string): { main: string; full: string } {
  const full = content.replace(/\r\n/g, "\n");
  const lines = full.split("\n");
  let cut = lines.length;
  while (cut > 0 && (lines[cut - 1].trim() === "" || /^\s*>/.test(lines[cut - 1]))) cut--;
  const tail = lines.slice(cut);
  if (!tail.some((l) => /^\s*>\s*On .+wrote:\s*$/i.test(l))) return { main: full.trim(), full };
  return { main: lines.slice(0, cut).join("\n").trim(), full };
}

/** Chatwoot appends the agent's signature on the client; the server adds the rich one to every email, so drop the copy. */
export function stripSignature(content: string, signatureMd: string): string {
  const sig = signatureMd.trim();
  if (!sig) return content;
  const c = content.trimEnd();
  if (!c.endsWith(sig)) return content;
  return c.slice(0, c.length - sig.length).replace(/(\s|-{2,})+$/, "").trimEnd();
}

async function createMessage(req: Request, env: Env, s: Session, t: TicketRow): Promise<Response> {
  const { data: b, files } = await bodyOf(req);
  const sig = (await getSettingValue(env, sigKey(s.staff.uid))) ?? "";
  const content = stripSignature(str(b.content), sig).trim();
  if (!content && !files.length) return fail(422, "Message is empty");
  let attachmentIds: string[] = [];
  if (files.length) {
    const up = await storeUploads(env, s.staff, files);
    if (!up.ok) return fail(422, up.error);
    attachmentIds = up.ids;
  }
  const isPrivate = b.private === true || b.private === "true";
  const now = Date.now();
  let id: string;
  if (isPrivate) {
    id = await addMessage(env, t.number, { authorType: "note", authorUid: s.staff.uid, authorName: s.staff.name ?? s.staff.email ?? "Staff", text: splitQuote(content).main || "(file)", now, attachmentIds, uploaderUid: s.staff.uid });
    await addEvent(env, t.number, s.staff.uid, "note", { messageId: id }, now);
  } else {
    const { main, full } = splitQuote(content || "Please see the attached file.");
    const r = await postStaffReply(env, s.staff, t, {
      html: markdownToHtml(full), text: markdownToText(main || "Please see the attached file."), attachmentIds,
      to: b.to_emails, cc: b.cc_emails, bcc: b.bcc_emails,
    }, now);
    if (!r.ok) return fail(422, r.error === "invalid_recipients" ? "One of the To / Cc / Bcc addresses is not a valid email address." : r.error);
    id = r.messageId;
  }
  const m = await env.DB_META.prepare("SELECT rowid AS rid,* FROM support_messages WHERE id=?1").bind(id).first<MsgRow>();
  if (!m) return fail(500, "internal");
  const json = await messageJson(env, m, { ag: await agents(env), contact: await contactOf(env, t.contact_id), th: s.th, base: s.base, atts: await attachmentsOf(env, t.number) }, false);
  return out({ ...json, ...(typeof b.echo_id === "string" ? { echo_id: b.echo_id } : {}) });
}

async function toggleStatus(req: Request, env: Env, staff: StaffCtx, t: TicketRow): Promise<Response> {
  const { data: b } = await bodyOf(req);
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

async function setLabels(env: Env, staff: StaffCtx, t: TicketRow, list: string[]): Promise<Response> {
  const wanted = [...new Set(list.map((l) => String(l).trim().toLowerCase()).filter(Boolean))];
  const cat = [...wanted].reverse().find((l) => CAT_KEYS.includes(l)) ?? (wanted.length ? "other" : t.category);
  const known = new Set((await customLabels(env)).map((l) => l.title));
  const extra = wanted.filter((l) => !CAT_KEYS.includes(l) && known.has(l));
  if (cat !== t.category) {
    const e = await applyPatch(env, staff, t, { category: cat });
    if (e) return fail(422, e);
  }
  const now = Date.now();
  await env.DB_META.batch([
    env.DB_META.prepare("DELETE FROM support_ticket_labels WHERE ticket_number=?1").bind(t.number),
    ...extra.map((l) => env.DB_META.prepare("INSERT OR IGNORE INTO support_ticket_labels (ticket_number,label,created_at) VALUES (?1,?2,?3)").bind(t.number, l, now)),
    env.DB_META.prepare("UPDATE support_tickets SET updated_at=?2 WHERE number=?1").bind(t.number, now),
  ]);
  if (extra.length) await addEvent(env, t.number, staff.uid, "labels", { labels: extra }, now);
  return out({ payload: [cat, ...extra] });
}

// ---------------------------------------------------------------------------------------------------------------------
// spam / merge / split / block (buttons added to the dashboard by patches/0002)
// ---------------------------------------------------------------------------------------------------------------------
async function blockContactEmail(env: Env, staff: StaffCtx, email: string | null, reason: string): Promise<boolean> {
  if (!email || !EMAIL_RE.test(email)) return false;
  await env.DB_META.prepare("INSERT OR IGNORE INTO support_blocklist (kind,value,reason,created_by,created_at) VALUES ('email',?1,?2,?3,?4)").bind(email.toLowerCase(), reason, staff.uid, Date.now()).run();
  return true;
}

async function markSpam(env: Env, staff: StaffCtx, t: TicketRow, block: boolean): Promise<Response> {
  await setTicketStatus(env, t, "spam", staff.uid);
  await env.DB_META.prepare("UPDATE support_tickets SET unread_staff=0 WHERE number=?1").bind(t.number).run();
  let blocked = false;
  if (block) {
    const c = await contactOf(env, t.contact_id);
    blocked = await blockContactEmail(env, staff, c?.email ?? null, `spam HF-${t.number}`);
  }
  return out({ success: true, blocked });
}

// ---------------------------------------------------------------------------------------------------------------------
// settings: agents, labels, canned responses, profile (name, personal signature)
// ---------------------------------------------------------------------------------------------------------------------
const isAdmin = (s: StaffCtx) => s.role === "admin";

async function agentsRoute(req: Request, env: Env, s: Session, id: number | null): Promise<Response> {
  const m = req.method;
  if (m === "GET") return out((await agents(env)).map(agentJson));
  if (!isAdmin(s.staff)) return fail(403, "Only admins can manage the team.");
  const { data: b } = await bodyOf(req);
  const role = b.role === "administrator" ? "admin" : "agent";
  const now = Date.now();
  if (m === "POST" && id === null) {
    const email = str(b.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return fail(422, "Enter a valid email address.");
    const name = str(b.name).trim().slice(0, 80) || email.split("@")[0];
    const exists = await env.DB_META.prepare("SELECT 1 AS x FROM support_staff WHERE email=?1").bind(email).first();
    if (exists) return fail(422, "This person is already on the team.");
    await env.DB_META.prepare("INSERT INTO support_staff (email,uid,name,role,created_at) VALUES (?1,NULL,?2,?3,?4)").bind(email, name, role, now).run();
    const row = (await agents(env)).find((a) => a.email === email)!;
    return out(agentJson(row));
  }
  const target = id === null ? undefined : (await agents(env)).find((a) => a.id === id);
  if (!target) return fail(404, "Agent not found");
  if (m === "PATCH" || m === "PUT") {
    const name = str(b.name).trim().slice(0, 80);
    if (target.uid === s.staff.uid && b.role !== undefined && role !== "admin") return fail(422, "You cannot remove your own admin role.");
    await env.DB_META.prepare("UPDATE support_staff SET name=COALESCE(NULLIF(?2,''),name), role=CASE WHEN ?3 THEN ?4 ELSE role END WHERE rowid=?1")
      .bind(id, name, b.role !== undefined ? 1 : 0, role).run();
    return out(agentJson((await agents(env)).find((a) => a.id === id)!));
  }
  if (m === "DELETE") {
    if (target.uid === s.staff.uid) return fail(422, "You cannot remove yourself.");
    const admins = (await agents(env)).filter((a) => a.role === "admin");
    if (target.role === "admin" && admins.length <= 1) return fail(422, "The team needs at least one admin.");
    await env.DB_META.prepare("DELETE FROM support_staff WHERE rowid=?1").bind(id).run();
    if (target.uid) await env.DB_META.prepare("DELETE FROM support_desk_sessions WHERE uid=?1").bind(target.uid).run();
    return out({});
  }
  return fail(405, "method_not_allowed");
}

async function labelsRoute(req: Request, env: Env, s: Session, id: number | null): Promise<Response> {
  const m = req.method;
  if (m === "GET") return out({ payload: await labelsJson(env) });
  if (id !== null && id < LABEL_BASE) return fail(422, "Built-in labels (ticket categories) cannot be changed.");
  const { data: b } = await bodyOf(req);
  const now = Date.now();
  const title = str(b.title).trim().toLowerCase().replace(/\s+/g, "-");
  const color = /^#[0-9a-f]{6}$/i.test(str(b.color)) ? str(b.color) : "#64748b";
  const desc = str(b.description).slice(0, 200);
  const sidebar = b.show_on_sidebar === false || b.show_on_sidebar === "false" ? 0 : 1;
  if (m === "POST" && id === null) {
    if (!LABEL_TITLE.test(title)) return fail(422, "Label names use lower-case letters, numbers, - and _ (up to 40).");
    if (CAT_KEYS.includes(title)) return fail(422, "That name is a built-in label.");
    const r = await env.DB_META.prepare("INSERT OR IGNORE INTO support_labels (title,description,color,show_on_sidebar,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)").bind(title, desc, color, sidebar, now).run();
    if (!(r.meta?.changes)) return fail(422, "A label with this name already exists.");
    const row = (await customLabels(env)).find((l) => l.title === title)!;
    return out({ id: LABEL_BASE + row.id, title: row.title, description: row.description, color: row.color, show_on_sidebar: !!row.show_on_sidebar });
  }
  const row = (await customLabels(env)).find((l) => LABEL_BASE + l.id === id);
  if (!row) return fail(404, "Label not found");
  if (m === "PATCH" || m === "PUT") {
    const newTitle = title || row.title;
    if (!LABEL_TITLE.test(newTitle) || CAT_KEYS.includes(newTitle)) return fail(422, "Label names use lower-case letters, numbers, - and _ (up to 40).");
    await env.DB_META.batch([
      env.DB_META.prepare("UPDATE support_labels SET title=?2,description=?3,color=?4,show_on_sidebar=?5,updated_at=?6 WHERE id=?1").bind(row.id, newTitle, b.description !== undefined ? desc : row.description, b.color !== undefined ? color : row.color, b.show_on_sidebar !== undefined ? sidebar : row.show_on_sidebar, now),
      env.DB_META.prepare("UPDATE support_ticket_labels SET label=?2 WHERE label=?1").bind(row.title, newTitle),
    ]);
    return out({ id: id!, title: newTitle, description: b.description !== undefined ? desc : row.description, color: b.color !== undefined ? color : row.color, show_on_sidebar: b.show_on_sidebar !== undefined ? !!sidebar : !!row.show_on_sidebar });
  }
  if (m === "DELETE") {
    await env.DB_META.batch([
      env.DB_META.prepare("DELETE FROM support_ticket_labels WHERE label=?1").bind(row.title),
      env.DB_META.prepare("DELETE FROM support_labels WHERE id=?1").bind(row.id),
    ]);
    return out({});
  }
  return fail(405, "method_not_allowed");
}

const htmlToPlain = (html: string) => html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p[^>]*>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

async function cannedRoute(req: Request, env: Env, s: Session, id: number | null, url: URL): Promise<Response> {
  const m = req.method;
  type Row = { id: number; cid: string; shortcut: string | null; title: string; body_html: string; created_at: number; updated_at: number };
  const all = async () => (await env.DB_META.prepare("SELECT rowid AS id,id AS cid,shortcut,title,body_html,created_at,updated_at FROM support_canned ORDER BY title").all<Row>()).results ?? [];
  const shape = (c: Row) => ({ id: c.id, account_id: ACCOUNT_ID, short_code: c.shortcut || c.title, content: htmlToPlain(c.body_html), created_at: c.created_at, updated_at: c.updated_at });
  if (m === "GET") {
    const q = (url.searchParams.get("search") ?? "").toLowerCase();
    return out((await all()).map(shape).filter((c) => !q || c.short_code.toLowerCase().includes(q) || c.content.toLowerCase().includes(q)));
  }
  const { data: raw } = await bodyOf(req);
  const b = (raw.canned_response && typeof raw.canned_response === "object" ? raw.canned_response : raw) as Record<string, unknown>;
  const code = str(b.short_code).trim().slice(0, 60);
  const content = str(b.content).trim().slice(0, 8000);
  const now = Date.now();
  if (m === "POST" && id === null) {
    if (!code || !content) return fail(422, "Short code and message are both required.");
    await env.DB_META.prepare("INSERT INTO support_canned (id,title,shortcut,category,body_html,created_by,created_at,updated_at) VALUES (?1,?2,?2,NULL,?3,?4,?5,?5)")
      .bind(crypto.randomUUID(), code, markdownToHtml(content), s.staff.uid, now).run();
    return out(shape((await all()).find((c) => c.shortcut === code && c.created_at === now)!));
  }
  const row = (await all()).find((c) => c.id === id);
  if (!row) return fail(404, "Canned response not found");
  if (m === "PATCH" || m === "PUT") {
    await env.DB_META.prepare("UPDATE support_canned SET title=COALESCE(NULLIF(?2,''),title), shortcut=COALESCE(NULLIF(?2,''),shortcut), body_html=CASE WHEN ?3='' THEN body_html ELSE ?4 END, updated_at=?5 WHERE rowid=?1")
      .bind(id, code, content, content ? markdownToHtml(content) : "", now).run();
    return out(shape((await all()).find((c) => c.id === id)!));
  }
  if (m === "DELETE") {
    await env.DB_META.prepare("DELETE FROM support_canned WHERE rowid=?1").bind(id).run();
    return out({});
  }
  return fail(405, "method_not_allowed");
}

async function updateProfile(req: Request, env: Env, s: Session): Promise<Record<string, unknown>> {
  const { data: b } = await bodyOf(req);
  // JSON {profile:{...}} or multipart "profile[field]"
  const p: Record<string, unknown> = { ...((b.profile && typeof b.profile === "object") ? b.profile as Record<string, unknown> : {}) };
  for (const [k, v] of Object.entries(b)) { const mm = /^profile\[(\w+)\]$/.exec(k); if (mm) p[mm[1]] = v; }
  let ui = await loadUi(env, s.staff.uid);
  if (p.ui_settings && typeof p.ui_settings === "object") ui = await saveUi(env, s.staff.uid, p.ui_settings as Record<string, unknown>);
  else if (typeof p.ui_settings === "string") { try { ui = await saveUi(env, s.staff.uid, JSON.parse(p.ui_settings)); } catch { /* ignore */ } }
  const name = str(p.display_name || p.name).trim().slice(0, 80);
  if (name && s.agent.id < 900_000) await env.DB_META.prepare("UPDATE support_staff SET name=?2 WHERE rowid=?1").bind(s.agent.id, name).run();
  let sig = (await getSettingValue(env, sigKey(s.staff.uid))) ?? "";
  if (typeof p.message_signature === "string") {
    sig = p.message_signature.slice(0, 4000);
    await putSettingValue(env, sigKey(s.staff.uid), sig);
    const html = sig.trim() ? markdownToHtml(sig) : "";
    await env.DB_META.prepare("INSERT INTO support_signatures (scope_key,html,use_for,updated_by,updated_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(scope_key) DO UPDATE SET html=excluded.html,use_for=excluded.use_for,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
      .bind(`me:${s.staff.uid}`, html, html ? "personal" : "team", s.staff.uid, Date.now()).run();
  }
  const agent = name && s.agent.id < 900_000 ? { ...s.agent, name } : s.agent;
  return userJson(agent, s.staff, ui, sig);
}

// ---------------------------------------------------------------------------------------------------------------------
// contacts and search
// ---------------------------------------------------------------------------------------------------------------------
async function listContacts(env: Env, url: URL, q: string): Promise<Response> {
  const page = Math.max(1, n(url.searchParams.get("page")) || 1);
  const sortRaw = url.searchParams.get("sort") ?? "name";
  const desc = sortRaw.startsWith("-");
  const col = ({ name: "COALESCE(name,email)", email: "email", created_at: "created_at", last_activity_at: "created_at" } as Record<string, string>)[sortRaw.replace(/^-/, "")] ?? "COALESCE(name,email)";
  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const where = q ? "WHERE email LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' OR whatsapp LIKE ?1 ESCAPE '\\'" : "";
  const binds = q ? [like] : [];
  const total = n((await env.DB_META.prepare(`SELECT COUNT(*) AS c FROM support_contacts ${where}`).bind(...binds).first<{ c: number }>())?.c);
  const rows = (await env.DB_META.prepare(`SELECT id,email,name,whatsapp,uid,created_at FROM support_contacts ${where} ORDER BY ${col} ${desc ? "DESC" : "ASC"}, id LIMIT 15 OFFSET ${(page - 1) * 15}`).bind(...binds).all<Contact>()).results ?? [];
  const payload = [];
  for (const c of rows) payload.push(contactJson(c, await isBlockedEmail(env, c.email)));
  return out({ meta: { count: total, current_page: page }, payload });
}

async function searchAll(env: Env, url: URL, s: Session, what: "all" | "conversations" | "contacts" | "messages"): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return out({ payload: { conversations: [], contacts: [], messages: [], articles: [] } });
  const ag = await agents(env);
  const payload: Record<string, unknown[]> = { articles: [] };
  if (what === "all" || what === "conversations") {
    const c = searchClause(q);
    const rows = (await env.DB_META.prepare(`SELECT * FROM support_tickets WHERE status NOT IN ${HIDDEN} AND ${c.sql} ORDER BY updated_at DESC LIMIT 25`).bind(...c.binds).all<TicketRow>()).results ?? [];
    const list = [];
    for (const t of rows) {
      const contact = await contactOf(env, t.contact_id);
      const first = await env.DB_META.prepare("SELECT rowid AS rid,* FROM support_messages WHERE ticket_number=?1 ORDER BY created_at LIMIT 1").bind(t.number).first<MsgRow>();
      const assignee = t.assignee_uid ? ag.find((a) => a.uid === t.assignee_uid) : undefined;
      list.push({
        id: t.number, account_id: ACCOUNT_ID, created_at: secs(t.created_at),
        message: first ? await messageJson(env, first, { ag, contact, th: s.th, base: s.base }, false) : {}, contact: contactJson(contact), inbox: inboxJson(),
        agent: assignee ? agentJson(assignee) : {}, additional_attributes: { mail_subject: t.subject, hf_code: `HF-${t.number}` },
      });
    }
    payload.conversations = list;
  }
  if (what === "all" || what === "contacts") {
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = (await env.DB_META.prepare("SELECT id,email,name,whatsapp,uid,created_at FROM support_contacts WHERE email LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' OR whatsapp LIKE ?1 ESCAPE '\\' ORDER BY id DESC LIMIT 25").bind(like).all<Contact>()).results ?? [];
    payload.contacts = rows.map((c) => contactJson(c));
  }
  if (what === "all" || what === "messages") {
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = (await env.DB_META.prepare(`SELECT m.rowid AS rid, m.* FROM support_messages m JOIN support_tickets t ON t.number=m.ticket_number WHERE t.status NOT IN ${HIDDEN} AND m.author_type IN ('customer','staff','note') AND m.text LIKE ?1 ESCAPE '\\' ORDER BY m.created_at DESC LIMIT 25`).bind(like).all<MsgRow>()).results ?? [];
    const list = [];
    for (const m of rows) {
      const t = await getTicket(env, m.ticket_number);
      list.push({ ...(await messageJson(env, m, { ag, contact: t ? await contactOf(env, t.contact_id) : null, th: s.th, base: s.base }, false)), inbox: inboxJson() });
    }
    payload.messages = list;
  }
  return out({ payload });
}

// ---------------------------------------------------------------------------------------------------------------------
// live updates: the desk polls this every few seconds (patched BaseActionCableConnector) instead of an ActionCable socket.
// Events are rebuilt from the tables (no event log): tickets created/updated and messages written since the cursor.
// ---------------------------------------------------------------------------------------------------------------------
const POLL_OVERLAP_MS = 3_000; // D1 writes land a little out of order; re-send a small window, the dashboard upserts by id

async function updates(env: Env, url: URL, s: Session): Promise<Response> {
  const now = Date.now();
  const since = n(url.searchParams.get("since"));
  if (!since || since < now - 15 * 60_000) return out({ cursor: now, events: [], reload: !!since }); // first poll, or a long sleep: just re-sync
  const from = since - POLL_OVERLAP_MS;
  const ag = await agents(env);
  const events: { event: string; data: unknown }[] = [];
  const tickets = (await env.DB_META.prepare(`SELECT * FROM support_tickets WHERE updated_at>=?1 AND status NOT IN ${HIDDEN} ORDER BY updated_at LIMIT 100`).bind(from).all<TicketRow>()).results ?? [];
  for (const t of tickets) {
    events.push({ event: t.created_at >= from ? "conversation.created" : "conversation.updated", data: await conversationJson(env, t, ag, s.agent, s.th, s.base) });
  }
  const msgs = (await env.DB_META.prepare("SELECT rowid AS rid,* FROM support_messages WHERE created_at>=?1 AND author_type IN ('customer','staff','note') ORDER BY created_at LIMIT 200").bind(from).all<MsgRow>()).results ?? [];
  for (const m of msgs) {
    const t = await getTicket(env, m.ticket_number);
    if (!t || t.status === "spam" || t.status === "trash") continue;
    const mj = await messageJson(env, m, { ag, contact: await contactOf(env, t.contact_id), th: s.th, base: s.base, subject: t.subject, atts: await attachmentsOf(env, t.number) }, true);
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
  md.replace(/\r\n/g, "\n").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();

// ---------------------------------------------------------------------------------------------------------------------
// My Inbox (Chatwoot "notifications"): one card per active ticket, newest activity first. A card is unread while the
// ticket has an unread customer message (unread_staff=1); reading the card marks the ticket read, like opening it.
// ---------------------------------------------------------------------------------------------------------------------
const ACTIVE = "('new','open','waiting','on_hold')";
async function notificationsRoute(env: Env, req: Request, url: URL, s: Session, r: string): Promise<Response> {
  const db = env.DB_META;
  if (r === "/notifications/unread_count") {
    const c = await db.prepare(`SELECT COUNT(*) AS c FROM support_tickets WHERE unread_staff=1 AND status IN ${ACTIVE}`).first<{ c: number }>();
    return out(c?.c ?? 0);
  }
  if (r === "/notifications/read_all" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { primary_actor_id?: unknown };
    const id = n(body.primary_actor_id);
    if (id > 0) await db.prepare("UPDATE support_tickets SET unread_staff=0 WHERE number=?1").bind(id).run();
    else await db.prepare(`UPDATE support_tickets SET unread_staff=0 WHERE unread_staff=1 AND status IN ${ACTIVE}`).run();
    return out({});
  }
  const one = /^\/notifications\/(\d+)\/unread$/.exec(r);
  if (one && req.method === "POST") {
    await db.prepare("UPDATE support_tickets SET unread_staff=1 WHERE number=?1").bind(n(one[1])).run();
    return out({});
  }
  if (r !== "/notifications" || req.method !== "GET") return out({});
  const page = Math.max(1, n(url.searchParams.get("page")) || 1);
  const asc = url.searchParams.get("sort_order") === "asc";
  const rows = (await db.prepare(`SELECT * FROM support_tickets WHERE status IN ${ACTIVE} ORDER BY updated_at ${asc ? "ASC" : "DESC"} LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`).all<TicketRow>()).results ?? [];
  const counts = await db.prepare(`SELECT COUNT(*) AS c, SUM(CASE WHEN unread_staff=1 THEN 1 ELSE 0 END) AS u FROM support_tickets WHERE status IN ${ACTIVE}`).first<{ c: number; u: number | null }>();
  const ag = await agents(env);
  const payload = [];
  for (const t of rows) {
    const conv = await conversationJson(env, t, ag, s.agent, s.th, s.base);
    const who = (conv.meta?.sender as { name?: string } | undefined)?.name || "Customer";
    payload.push({
      id: t.number, notification_type: t.status === "new" ? "conversation_creation" : "assigned_conversation_new_message",
      primary_actor_type: "Conversation", primary_actor_id: t.number, primary_actor: conv,
      push_message_title: `HF-${t.number}`, push_message_body: `${who}: ${t.subject || "(no subject)"}`,
      read_at: t.unread_staff ? null : secs(t.updated_at), created_at: secs(t.created_at), last_activity_at: secs(t.updated_at),
      snoozed_until: null, meta: {}, user: { id: s.agent.id },
    });
  }
  return out({ data: { meta: { unread_count: counts?.u ?? 0, count: counts?.c ?? 0, current_page: page }, payload } });
}

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
    const file = /^\/files\/([0-9a-f-]{36})(\/[^/]*)?$/i.exec(path);
    if (file && m === "GET") return await serveFile(env, url, file[1]);

    const s = await sessionStaff(req, env);
    if (!s) return fail(401, "You need to sign in or sign up before continuing.");
    const { staff, agent } = s;
    const me = () => (async () => userJson(agent, staff, await loadUi(env, staff.uid), (await getSettingValue(env, sigKey(staff.uid))) ?? ""))();

    if (path === "/auth/validate_token") return out({ payload: { success: true, data: await me() } });
    if (path === "/auth/sign_out" && m === "DELETE") {
      await env.DB_META.prepare("DELETE FROM support_desk_sessions WHERE token_hash=?1").bind(s.th).run();
      return out({ success: true });
    }
    if (path === "/api/v1/profile" && (m === "PUT" || m === "PATCH")) return out(await updateProfile(req, env, s));
    if (path.startsWith("/api/v1/profile")) return out(await me());

    const acc = /^\/api\/v1\/accounts\/(\d+)(\/.*)?$/.exec(path);
    if (!acc) return out({}, 404);
    if (n(acc[1]) !== ACCOUNT_ID) return fail(404, "account_not_found");
    const r = acc[2] ?? "";
    const write = m !== "GET";
    if (write && staff.role === "viewer") return fail(403, "read_only");

    if (r === "") return out(await accountJson(env));
    if (r === "/cache_keys") return out({ cache_keys: await cacheKeys(env) });
    if (r === "/inboxes") return out({ payload: [inboxJson()] });
    if (r === `/inboxes/${INBOX_ID}`) return out(inboxJson());
    if (r === `/inboxes/${INBOX_ID}/assignable_agents` || r.startsWith("/assignable_agents")) {
      return out({ payload: (await agents(env)).filter((a) => a.uid && a.role !== "viewer").map(agentJson) });
    }
    const ag = /^\/agents(?:\/(\d+))?$/.exec(r);
    if (ag) return await agentsRoute(req, env, s, ag[1] ? n(ag[1]) : null);
    const lb = /^\/labels(?:\/(\d+))?$/.exec(r);
    if (lb) return await labelsRoute(req, env, s, lb[1] ? n(lb[1]) : null);
    const cr = /^\/canned_responses(?:\/(\d+))?$/.exec(r);
    if (cr) return await cannedRoute(req, env, s, cr[1] ? n(cr[1]) : null, url);

    if (r === "/hf_updates") return await updates(env, url, s);
    if (r === "/search") return await searchAll(env, url, s, "all");
    const sr = /^\/search\/(conversations|contacts|messages)$/.exec(r);
    if (sr) return await searchAll(env, url, s, sr[1] as "conversations" | "contacts" | "messages");
    if (r === "/search/articles") return out({ payload: { articles: [] } });

    if (r === "/conversations" && m === "GET") return await listConversations(env, url, s);
    if (r === "/conversations/meta") return out({ meta: await counts(env, url, staff) });
    if (r === "/conversations/filter" && m === "POST") return await listConversations(env, url, s);
    if (r === "/conversations/search") {
      const u2 = new URL(url); u2.searchParams.set("status", "all"); u2.searchParams.set("assignee_type", "all");
      return await listConversations(env, u2, s);
    }
    if (r === "/conversations/unread_counts") return out({ payload: {} });

    const conv = /^\/conversations\/(\d+)(\/.*)?$/.exec(r);
    if (conv) {
      const t = await getTicket(env, n(conv[1]));
      if (!t || t.status === "trash") return fail(404, "Conversation not found");
      const sub = conv[2] ?? "";
      if (sub === "" && m === "GET") return out(await conversationJson(env, t, await agents(env), agent, s.th, s.base));
      if (sub === "/messages" && m === "GET") return await listMessages(env, t, url, s.th, s.base);
      if (sub === "/messages" && m === "POST") return await createMessage(req, env, s, t);
      if (sub === "/toggle_status" && m === "POST") return await toggleStatus(req, env, staff, t);
      if (sub === "/toggle_priority" && m === "POST") {
        const { data: b } = await bodyOf(req);
        const e = await applyPatch(env, staff, t, { priority: ourPriority(b.priority) });
        return e ? fail(422, e) : out({});
      }
      if (sub === "/assignments" && m === "POST") {
        const { data: b } = await bodyOf(req);
        if (b.team_id !== undefined && b.assignee_id === undefined) return out({});
        const list = await agents(env);
        const target = b.assignee_id ? list.find((a) => a.id === n(b.assignee_id)) : undefined;
        if (b.assignee_id && !target?.uid) return fail(422, "That teammate has not signed in to the desk yet, so they cannot be assigned.");
        const e = await applyPatch(env, staff, t, { assigneeUid: target?.uid ?? null });
        if (e) return fail(422, e);
        return out(target ? agentEvent(target) : null);
      }
      if (sub === "/labels") {
        if (m === "GET") return out({ payload: await ticketLabels(env, t) });
        const { data: b } = await bodyOf(req);
        return await setLabels(env, staff, t, Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : []);
      }
      if (sub === "/hf_spam" && m === "POST") {
        const { data: b } = await bodyOf(req);
        return await markSpam(env, staff, t, b.block === true || b.block === "true");
      }
      if (sub === "/hf_block" && m === "POST") {
        const c = await contactOf(env, t.contact_id);
        const ok = await blockContactEmail(env, staff, c?.email ?? null, `blocked from HF-${t.number}`);
        if (!ok) return fail(422, "This conversation has no sender email to block.");
        await addEvent(env, t.number, staff.uid, "block", { email: c?.email });
        return out({ success: true });
      }
      if (sub === "/hf_merge" && m === "POST") {
        const { data: b } = await bodyOf(req);
        const into = n(String(b.into ?? "").replace(/^\s*#?HF-?/i, ""));
        if (!into) return fail(422, "Enter the ticket number to merge into, e.g. HF-10002.");
        const res = await mergeTickets(env, t.number, into, staff.uid);
        if (!res.ok) {
          const msg: Record<string, string> = { not_found: "That ticket does not exist.", same_ticket: "That is this ticket.", different_customers: "Only tickets from the same customer can be merged.", already_merged: "One of these tickets is already merged." };
          return fail(422, msg[res.error] ?? res.error);
        }
        return out({ success: true, into });
      }
      const split = /^\/messages\/(\d+)\/hf_split$/.exec(sub);
      if (split && m === "POST") {
        const msg = await env.DB_META.prepare("SELECT id FROM support_messages WHERE rowid=?1 AND ticket_number=?2").bind(n(split[1]), t.number).first<{ id: string }>();
        if (!msg) return fail(404, "Message not found");
        const res = await splitTicket(env, t.number, msg.id, staff.uid);
        if (!res.ok) {
          const text: Record<string, string> = { not_found: "Message not found.", cannot_split_first: "The first message is the ticket itself; it cannot be split off.", not_customer_message: "Only customer messages can be split into a new ticket." };
          return fail(422, text[res.error] ?? res.error);
        }
        return out({ success: true, conversation_id: res.number });
      }
      if (sub === "/update_last_seen" || sub === "/unread") {
        await env.DB_META.prepare("UPDATE support_tickets SET unread_staff=?2 WHERE number=?1").bind(t.number, sub === "/unread" ? 1 : 0).run();
        return out({});
      }
      if (sub === "/attachments") {
        const atts = await attachmentsOf(env, t.number);
        const rows = (await env.DB_META.prepare("SELECT rowid AS rid,id FROM support_messages WHERE ticket_number=?1").bind(t.number).all<{ rid: number; id: string }>()).results ?? [];
        const list = [];
        for (const row of rows) for (const a of atts.get(row.id) ?? []) list.push(await attJson(a, row.rid, s.th, s.base));
        return out({ payload: list });
      }
      if (sub === "/participants") return out([]);
      if (sub === "/draft_messages") return out({});
      return out({});
    }

    if (r === "/contacts" || r === "/contacts/active" || (r === "/contacts/filter" && m === "POST")) return await listContacts(env, url, "");
    if (r === "/contacts/search") return await listContacts(env, url, (url.searchParams.get("q") ?? "").trim());
    const ct = /^\/contacts\/(\d+)(\/.*)?$/.exec(r);
    if (ct) {
      const c = await contactOf(env, n(ct[1]));
      if (!c) return fail(404, "Contact not found");
      const sub = ct[2] ?? "";
      if (sub === "" && m === "GET") return out({ payload: contactJson(c, await isBlockedEmail(env, c.email)) });
      if (sub === "" && (m === "PATCH" || m === "PUT")) {
        const { data: raw } = await bodyOf(req);
        const b = (raw.contact && typeof raw.contact === "object" ? raw.contact : raw) as Record<string, unknown>;
        const name = b.name !== undefined ? str(b.name).trim().slice(0, 120) : null;
        await env.DB_META.prepare("UPDATE support_contacts SET name=COALESCE(?2,name) WHERE id=?1").bind(c.id, name).run();
        if (b.blocked === true || b.blocked === "true") await blockContactEmail(env, staff, c.email, "blocked from contact");
        else if ((b.blocked === false || b.blocked === "false") && c.email) await env.DB_META.prepare("DELETE FROM support_blocklist WHERE kind='email' AND value=?1").bind(c.email.toLowerCase()).run();
        const fresh = (await contactOf(env, c.id))!;
        return out({ payload: contactJson(fresh, await isBlockedEmail(env, fresh.email)) });
      }
      if (sub === "" && m === "DELETE") return fail(422, "Customers cannot be deleted from the desk (tickets are kept for the retention period).");
      if (sub === "/conversations") {
        const rows = (await env.DB_META.prepare(`SELECT * FROM support_tickets WHERE contact_id=?1 AND status NOT IN ${HIDDEN} ORDER BY updated_at DESC LIMIT 20`).bind(c.id).all<TicketRow>()).results ?? [];
        const list = await agents(env);
        const payload = [];
        for (const t of rows) payload.push(await conversationJson(env, t, list, agent, s.th, s.base));
        return out({ payload });
      }
      if (sub === "/labels") return out({ payload: [] });
      if (sub === "/notes") return out([]);
      return out({ payload: [] });
    }

    // Everything the email desk does not use yet: answer empty in the shape the dashboard expects, so screens render.
    if (r === "/notifications" || r.startsWith("/notifications/")) return await notificationsRoute(env, req, url, s, r);
    if (r === "/custom_filters" || r === "/teams" || r === "/custom_attribute_definitions" || r === "/macros" || r === "/dashboard_apps" || r === "/agent_bots" || r === "/automation_rules" || r === "/campaigns" || r === "/portals" || r === "/working_hours") return out(r === "/macros" || r === "/automation_rules" || r === "/portals" ? { payload: [] } : []);
    if (r === "/integrations/apps") return out({ payload: [] });
    return out(m === "GET" ? { payload: [] } : {});
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: BRAND.slug, extra: { area: "hf_desk_cw" } });
    return fail(500, "internal");
  }
}
