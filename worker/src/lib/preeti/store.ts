// [SAATHUM-PREETI-1 2026-09-30] D1 helpers for Preeti (config, prompts, conversations, messages, spend view,
// retention). All tables live in DB_META, created by migrations/2026-09-30-preeti-ai.sql.
import type { Env } from "../../types";
import { readConfig } from "../../routes/config";
import type {
  AdminAiConfig, AdminAiConversationDetail, AdminAiConversationRow, AdminAiMessage, AdminAiSpend, PreetiCard, PreetiMessageOut,
} from "./contracts";

export const RETENTION_MS = 365 * 24 * 3600_000; // owner decision: 12 months

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export interface AgentConfigRow {
  name: string; avatar_url: string | null; welcome_text: string;
  quick_replies: { home: string[]; article: string[]; event: string[] };
  support_whatsapp: string; alert_whatsapp: string; enabled: boolean;
  store_name: string | null; active_prompt_id: string | null; monthly_cap_rupees: number;
}

const DEFAULT_WELCOME =
  "Namaste 🙏 main {agent} hoon, {brand} ki AI helper. Kisi puja, havan, event ya booking ke baare mein poochhiye. Aap Hindi, English ya kisi aur bhasha mein baat karna chahenge?";
const DEFAULT_QR = {
  home: ["Upcoming pujas and havans", "How does booking work?", "Which puja is right for me?", "Talk to a human"],
  article: ["Explain this ritual simply", "What are its traditional benefits?", "Is there an upcoming event for this?", "Talk to a human"],
  event: ["What will happen in this event?", "Is booking open?", "How do I watch it?", "Check my booking status"],
};
export const DEFAULT_SUPPORT_WHATSAPP = "+919259457189";

let cfgCache: { at: number; cfg: AgentConfigRow } | null = null;
const CFG_TTL = 15_000;

function normQr(raw: unknown): AgentConfigRow["quick_replies"] {
  let o: any = {};
  try { o = JSON.parse(String(raw ?? "{}")); } catch { o = {}; }
  const arr = (v: unknown, d: string[]) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 6) : d);
  return { home: arr(o.home, DEFAULT_QR.home), article: arr(o.article, DEFAULT_QR.article), event: arr(o.event, DEFAULT_QR.event) };
}

export async function getAgentConfig(env: Env): Promise<AgentConfigRow> {
  if (cfgCache && Date.now() - cfgCache.at < CFG_TTL) return cfgCache.cfg;
  let cfg: AgentConfigRow = {
    name: "Preeti", avatar_url: null, welcome_text: DEFAULT_WELCOME, quick_replies: DEFAULT_QR,
    support_whatsapp: DEFAULT_SUPPORT_WHATSAPP, alert_whatsapp: DEFAULT_SUPPORT_WHATSAPP, enabled: false,
    store_name: null, active_prompt_id: "v1", monthly_cap_rupees: 2000,
  };
  try {
    const r = await env.DB_META.prepare("SELECT * FROM ai_agent_config WHERE id=1").first<any>();
    if (r) {
      cfg = {
        name: String(r.name || "Preeti"), avatar_url: r.avatar_url ?? null, welcome_text: String(r.welcome_text || DEFAULT_WELCOME),
        quick_replies: normQr(r.quick_replies_json), support_whatsapp: String(r.support_whatsapp || DEFAULT_SUPPORT_WHATSAPP),
        alert_whatsapp: String(r.alert_whatsapp || DEFAULT_SUPPORT_WHATSAPP), enabled: Number(r.enabled) === 1,
        store_name: r.store_name ?? null, active_prompt_id: r.active_prompt_id ?? null,
        monthly_cap_rupees: Math.max(0, Math.trunc(Number(r.monthly_cap_rupees ?? 2000))),
      };
    }
  } catch { /* migration not applied yet -> disabled defaults */ }
  cfgCache = { at: Date.now(), cfg };
  return cfg;
}

export function invalidateAgentConfig(): void { cfgCache = null; }

export type AgentConfigPatch = Partial<Omit<AdminAiConfig, "flag_enabled">> & { store_name?: string | null };

export async function putAgentConfig(env: Env, patch: AgentConfigPatch, byUid: string): Promise<AgentConfigRow> {
  const sets: string[] = []; const binds: unknown[] = [];
  const add = (col: string, v: unknown) => { binds.push(v); sets.push(`${col}=?${binds.length}`); };
  if (patch.name !== undefined) add("name", String(patch.name).trim().slice(0, 40) || "Preeti");
  if (patch.avatar_url !== undefined) add("avatar_url", patch.avatar_url ? String(patch.avatar_url).slice(0, 500) : null);
  if (patch.welcome_text !== undefined) add("welcome_text", String(patch.welcome_text).slice(0, 1200));
  if (patch.quick_replies !== undefined) add("quick_replies_json", JSON.stringify(normQr(JSON.stringify(patch.quick_replies))));
  if (patch.support_whatsapp !== undefined) add("support_whatsapp", String(patch.support_whatsapp).trim().slice(0, 20));
  if (patch.alert_whatsapp !== undefined) add("alert_whatsapp", String(patch.alert_whatsapp).trim().slice(0, 20));
  if (patch.enabled !== undefined) add("enabled", patch.enabled ? 1 : 0);
  if (patch.monthly_cap_rupees !== undefined) add("monthly_cap_rupees", Math.max(0, Math.min(10_000_000, Math.trunc(Number(patch.monthly_cap_rupees) || 0))));
  if (patch.active_prompt_id !== undefined) add("active_prompt_id", patch.active_prompt_id);
  if (patch.store_name !== undefined) add("store_name", patch.store_name);
  add("updated_at", Date.now()); add("updated_by", byUid);
  await env.DB_META.prepare(`UPDATE ai_agent_config SET ${sets.join(", ")} WHERE id=1`).bind(...binds).run();
  invalidateAgentConfig();
  return await getAgentConfig(env);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const FALLBACK_PERSONA =
  "You are {agent}, the friendly AI helper of {brand} ({site}). Help visitors with pujas, havans, events and bookings. Be warm, calm and brief.";

export async function activePrompt(env: Env): Promise<{ id: string; body: string }> {
  try {
    const cfg = await getAgentConfig(env);
    if (cfg.active_prompt_id) {
      const r = await env.DB_META.prepare("SELECT id, body FROM ai_agent_prompts WHERE id=?1").bind(cfg.active_prompt_id).first<{ id: string; body: string }>();
      if (r?.body) return r;
    }
  } catch { /* fall through */ }
  return { id: "fallback", body: FALLBACK_PERSONA };
}

export async function getPromptBody(env: Env, id: string): Promise<string | null> {
  try {
    const r = await env.DB_META.prepare("SELECT body FROM ai_agent_prompts WHERE id=?1").bind(id).first<{ body: string }>();
    return r?.body ?? null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------
export interface ConvRow {
  id: string; uid: string | null; visitor_id: string; name: string | null; e164: string | null; email: string | null;
  transcript_sent_through_id: number | null; transcript_sent_at: number | null;
  first_page: string | null; last_page: string | null; lead_score: number; badges: string[];
  status: "open" | "resolved" | "needs_human"; admin_note: string | null; is_test: number; message_count: number;
  lookup_locked_until: number | null; created_at: number; last_message_at: number;
}

function toConv(r: any): ConvRow {
  let badges: string[] = [];
  try { const b = JSON.parse(r.badges_json ?? "[]"); if (Array.isArray(b)) badges = b.map(String); } catch { badges = []; }
  return { ...r, email: r.email ?? null, transcript_sent_through_id: r.transcript_sent_through_id ?? null, transcript_sent_at: r.transcript_sent_at ?? null, lead_score: Number(r.lead_score ?? 0), badges, is_test: Number(r.is_test ?? 0), message_count: Number(r.message_count ?? 0) };
}

export async function getConv(env: Env, id: string): Promise<ConvRow | null> {
  const r = await env.DB_META.prepare("SELECT * FROM ai_conversations WHERE id=?1").bind(id).first<any>().catch(() => null);
  return r ? toConv(r) : null;
}

export async function createConversation(env: Env, a: {
  id?: string; uid?: string | null; visitorId: string; name?: string | null; e164?: string | null; email?: string | null; page?: string | null; isTest?: boolean;
}): Promise<ConvRow> {
  const id = a.id ?? crypto.randomUUID();
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT OR IGNORE INTO ai_conversations (id, uid, visitor_id, name, e164, email, first_page, last_page, is_test, created_at, last_message_at)
     VALUES (?1,?2,?3,?4,?5,?9,?6,?6,?7,?8,?8)`,
  ).bind(id, a.uid ?? null, a.visitorId, a.name ?? null, a.e164 ?? null, a.page ?? null, a.isTest ? 1 : 0, now, a.email ?? null).run();
  return (await getConv(env, id))!;
}

/** May this caller use this conversation? Signed-in -> uid match (or an anonymous one they hold the visitor id for). */
export function ownsConversation(c: ConvRow, uid: string | null, visitorId: string | null): boolean {
  if (uid && c.uid === uid) return true;
  if (!c.uid && visitorId && c.visitor_id === visitorId) return true;
  return false;
}

export async function latestConvForVisitor(env: Env, visitorId: string): Promise<ConvRow | null> {
  const r = await env.DB_META.prepare(
    "SELECT * FROM ai_conversations WHERE visitor_id=?1 AND uid IS NULL AND is_test=0 ORDER BY last_message_at DESC LIMIT 1",
  ).bind(visitorId).first<any>().catch(() => null);
  return r ? toConv(r) : null;
}

export async function latestConvForUid(env: Env, uid: string): Promise<ConvRow | null> {
  const r = await env.DB_META.prepare(
    "SELECT * FROM ai_conversations WHERE uid=?1 AND is_test=0 ORDER BY last_message_at DESC LIMIT 1",
  ).bind(uid).first<any>().catch(() => null);
  return r ? toConv(r) : null;
}

/**
 * Signed-in continuity: ONE conversation per uid (cross-device memory). An anonymous conversation held by the
 * same visitor_id is merged in (its messages move over, then the anonymous shell is deleted) — the visitor id is
 * a secret only that browser holds, so this is not a leak. Phone numbers never link conversations.
 */
export async function conversationForUser(env: Env, a: {
  uid: string; visitorId: string; name: string | null; e164: string | null; email?: string | null; page: string;
}): Promise<ConvRow & { identity_changed?: boolean }> {
  let main = await latestConvForUid(env, a.uid);
  const anon = await latestConvForVisitor(env, a.visitorId);
  if (!main && anon) {
    await env.DB_META.prepare("UPDATE ai_conversations SET uid=?2, name=COALESCE(?3,name), e164=COALESCE(?4,e164), email=COALESCE(?5,email) WHERE id=?1")
      .bind(anon.id, a.uid, a.name, a.e164, a.email ?? null).run();
    main = (await getConv(env, anon.id))!;
  } else if (main && anon && anon.id !== main.id) {
    await env.DB_META.prepare("UPDATE ai_messages SET conversation_id=?1 WHERE conversation_id=?2").bind(main.id, anon.id).run();
    const badges = [...new Set([...main.badges, ...anon.badges])];
    await env.DB_META.prepare(
      `UPDATE ai_conversations SET message_count=message_count+?2, lead_score=MAX(lead_score,?3), badges_json=?4,
         last_message_at=MAX(last_message_at,?5) WHERE id=?1`,
    ).bind(main.id, anon.message_count, anon.lead_score, JSON.stringify(badges), anon.last_message_at).run();
    await env.DB_META.prepare("DELETE FROM ai_conversations WHERE id=?1").bind(anon.id).run();
  }
  if (!main) main = await createConversation(env, { uid: a.uid, visitorId: a.visitorId, name: a.name, e164: a.e164, email: a.email, page: a.page });
  // Profile facts win over what an anonymous visit typed.
  let changed = false;
  if ((a.name && a.name !== main.name) || (a.e164 && a.e164 !== main.e164) || (a.email && a.email !== main.email)) {
    changed = !!((a.e164 && a.e164 !== main.e164) || (a.email && a.email !== main.email));
    await env.DB_META.prepare("UPDATE ai_conversations SET name=COALESCE(?2,name), e164=COALESCE(?3,e164), email=COALESCE(?4,email) WHERE id=?1")
      .bind(main.id, a.name, a.e164, a.email ?? null).run();
    main = (await getConv(env, main.id))!;
  }
  return { ...main, identity_changed: changed };
}

export async function setIdentity(env: Env, id: string, a: { name?: string | null; email: string; e164: string }): Promise<void> {
  await env.DB_META.prepare("UPDATE ai_conversations SET name=COALESCE(?2,name), email=?3, e164=?4 WHERE id=?1")
    .bind(id, a.name ? a.name.slice(0, 60) : null, a.email.slice(0, 254), a.e164).run();
}

export async function updateConversation(env: Env, id: string, patch: { status?: "open" | "resolved" | "needs_human"; admin_note?: string | null; badges?: string[]; lead_score?: number; last_page?: string }): Promise<void> {
  const sets: string[] = []; const binds: unknown[] = [id];
  const add = (c: string, v: unknown) => { binds.push(v); sets.push(`${c}=?${binds.length}`); };
  if (patch.status) add("status", patch.status);
  if (patch.admin_note !== undefined) add("admin_note", patch.admin_note === null ? null : String(patch.admin_note).slice(0, 2000));
  if (patch.badges) add("badges_json", JSON.stringify([...new Set(patch.badges)]));
  if (patch.lead_score !== undefined) add("lead_score", Math.max(0, Math.min(3, Math.trunc(patch.lead_score))));
  if (patch.last_page !== undefined) add("last_page", patch.last_page);
  if (!sets.length) return;
  await env.DB_META.prepare(`UPDATE ai_conversations SET ${sets.join(", ")} WHERE id=?1`).bind(...binds).run();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
export interface NewMessage {
  role: "visitor" | "preeti" | "tool" | "admin_note" | "system"; text: string; cards?: PreetiCard[];
  tool_name?: string; tool_summary?: string; model?: string; input_tokens?: number; output_tokens?: number;
  cost_micro_usd?: number; blocked?: boolean;
}

export async function insertMessage(env: Env, conversationId: string, m: NewMessage): Promise<number> {
  const now = Date.now();
  const r = await env.DB_META.prepare(
    `INSERT INTO ai_messages (conversation_id, role, text, cards_json, tool_name, tool_summary, model, input_tokens, output_tokens, cost_micro_usd, blocked, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
  ).bind(
    conversationId, m.role, m.text, m.cards?.length ? JSON.stringify(m.cards) : null, m.tool_name ?? null, m.tool_summary ?? null,
    m.model ?? null, m.input_tokens ?? null, m.output_tokens ?? null, m.cost_micro_usd ?? null, m.blocked ? 1 : 0, now,
  ).run();
  if (m.role === "visitor" || m.role === "preeti") {
    await env.DB_META.prepare("UPDATE ai_conversations SET message_count=message_count+1, last_message_at=?2 WHERE id=?1").bind(conversationId, now).run();
  }
  return Number((r as any).meta?.last_row_id ?? 0);
}

function parseCards(raw: unknown): PreetiCard[] {
  try { const a = JSON.parse(String(raw ?? "[]")); return Array.isArray(a) ? a : []; } catch { return []; }
}

/** Public history (visitor + preeti only), oldest first. */
export async function publicHistory(env: Env, conversationId: string, limit = 30): Promise<PreetiMessageOut[]> {
  const rs = await env.DB_META.prepare(
    `SELECT id, role, text, cards_json, created_at FROM ai_messages
      WHERE conversation_id=?1 AND role IN ('visitor','preeti') AND blocked=0 ORDER BY id DESC LIMIT ?2`,
  ).bind(conversationId, limit).all<any>().catch(() => null);
  return (rs?.results ?? []).reverse().map((r) => ({ id: Number(r.id), role: r.role, text: String(r.text ?? ""), cards: parseCards(r.cards_json), at: Number(r.created_at) }));
}

/** Visitor messages not yet answered by a real reply (the fixed identity ask does not count as an answer). */
export async function pendingVisitorMessages(env: Env, conversationId: string): Promise<{ id: number; text: string }[]> {
  const rs = await env.DB_META.prepare(
    `SELECT id, text FROM ai_messages WHERE conversation_id=?1 AND role='visitor' AND blocked=0 AND text<>''
        AND id > COALESCE((SELECT MAX(id) FROM ai_messages WHERE conversation_id=?1 AND role='preeti' AND COALESCE(model,'')<>'identity_ask'), 0)
      ORDER BY id ASC LIMIT 10`,
  ).bind(conversationId).all<{ id: number; text: string }>();
  return (rs.results ?? []).map((r) => ({ id: Number(r.id), text: String(r.text) }));
}

/** Last N turns for the model (no tool rows). */
export async function modelHistory(env: Env, conversationId: string, limit = 20, beforeId?: number): Promise<{ role: "visitor" | "preeti"; text: string }[]> {
  // [SAATHUM-PREETI-LEADGATE-1] The fixed identity-ask reply is never model context; beforeId excludes pending turns.
  const rs = await env.DB_META.prepare(
    `SELECT role, text FROM ai_messages WHERE conversation_id=?1 AND role IN ('visitor','preeti') AND blocked=0 AND text<>''
        AND COALESCE(model,'')<>'identity_ask' AND id<?3 ORDER BY id DESC LIMIT ?2`,
  ).bind(conversationId, limit, beforeId ?? Number.MAX_SAFE_INTEGER).all<{ role: "visitor" | "preeti"; text: string }>().catch(() => null);
  return (rs?.results ?? []).reverse();
}

function badgesOf(raw: unknown): string[] {
  try { const b = JSON.parse(String(raw ?? "[]")); return Array.isArray(b) ? b.map(String) : []; } catch { return []; }
}

function toRow(r: any): AdminAiConversationRow {
  return {
    id: r.id, name: r.name ?? null, e164: r.e164 ?? null, email: r.email ?? null, uid: r.uid ?? null,
    visitor_label: r.name ? String(r.name) : `Visitor ${String(r.visitor_id ?? "").slice(0, 6)}`,
    last_text: String(r.last_text ?? "").slice(0, 140), last_message_at: Number(r.last_message_at), badges: badgesOf(r.badges_json),
    status: r.status, lead_score: Number(r.lead_score ?? 0), message_count: Number(r.message_count ?? 0),
  };
}

export async function listConversations(env: Env, o: { q?: string; badge?: string; status?: string; cursor?: string; limit?: number }): Promise<{ rows: AdminAiConversationRow[]; next_cursor: string | null }> {
  const limit = Math.max(1, Math.min(100, o.limit ?? 40));
  const where = ["c.is_test=0"]; const binds: unknown[] = [];
  const add = (v: unknown) => { binds.push(v); return `?${binds.length}`; };
  if (o.status && ["open", "resolved", "needs_human"].includes(o.status)) where.push(`c.status=${add(o.status)}`);
  if (o.badge) where.push(`c.badges_json LIKE ${add(`%"${o.badge.replace(/[^a-z0-9_]/gi, "")}"%`)}`);
  if (o.q?.trim()) {
    const like = `%${o.q.trim().replace(/[%_\\]/g, "").slice(0, 60)}%`;
    const p = add(like);
    where.push(`(c.name LIKE ${p} OR c.e164 LIKE ${p} OR c.email LIKE ${p} OR c.visitor_id LIKE ${p} OR c.id LIKE ${p})`);
  }
  if (o.cursor) {
    const [ts, id] = o.cursor.split("|");
    if (Number(ts) > 0) { const a = add(Number(ts)); const b = add(id ?? ""); where.push(`(c.last_message_at < ${a} OR (c.last_message_at = ${a} AND c.id < ${b}))`); }
  }
  const lim = add(limit + 1);
  const rs = await env.DB_META.prepare(
    `SELECT c.*, (SELECT text FROM ai_messages m WHERE m.conversation_id=c.id AND m.role IN ('visitor','preeti') ORDER BY m.id DESC LIMIT 1) AS last_text
       FROM ai_conversations c WHERE ${where.join(" AND ")} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ${lim}`,
  ).bind(...binds).all<any>();
  const all = rs.results ?? [];
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page.map(toRow), next_cursor: all.length > limit && last ? `${last.last_message_at}|${last.id}` : null };
}

export async function getConversation(env: Env, id: string): Promise<AdminAiConversationDetail | null> {
  const r = await env.DB_META.prepare(
    `SELECT c.*, (SELECT text FROM ai_messages m WHERE m.conversation_id=c.id AND m.role IN ('visitor','preeti') ORDER BY m.id DESC LIMIT 1) AS last_text
       FROM ai_conversations c WHERE c.id=?1`,
  ).bind(id).first<any>().catch(() => null);
  if (!r) return null;
  const ms = await env.DB_META.prepare(
    "SELECT id, role, text, cards_json, tool_name, tool_summary, blocked, created_at FROM ai_messages WHERE conversation_id=?1 ORDER BY id ASC LIMIT 500",
  ).bind(id).all<any>();
  const messages: AdminAiMessage[] = (ms.results ?? []).map((m) => ({
    id: Number(m.id), role: m.role, text: String(m.text ?? ""), cards: parseCards(m.cards_json),
    tool_name: m.tool_name ?? null, tool_summary: m.tool_summary ?? null, blocked: Number(m.blocked) === 1, created_at: Number(m.created_at),
  }));
  let bookings: AdminAiConversationDetail["bookings"] = [];
  if (r.uid) {
    const bs = await env.DB_META.prepare(
      `SELECT c.checkout_id, COALESCE(l.title,'') AS listing_title, c.status, c.created_at FROM saathum_checkouts c
         LEFT JOIN listings l ON l.id=c.listing_id WHERE c.uid=?1 ORDER BY c.created_at DESC LIMIT 10`,
    ).bind(r.uid).all<any>().catch(() => null);
    bookings = (bs?.results ?? []).map((b) => ({ checkout_id: b.checkout_id, listing_title: b.listing_title, status: b.status, created_at: Number(b.created_at) }));
  }
  return {
    conversation: { ...toRow(r), first_page: r.first_page ?? null, last_page: r.last_page ?? null, admin_note: r.admin_note ?? null },
    messages, bookings,
  };
}

// ---------------------------------------------------------------------------
// Spend view (rupees are derived with the live FX rate; storage stays micro-USD)
// ---------------------------------------------------------------------------
export function istMonth(ms = Date.now()): string {
  const d = new Date(ms + 5.5 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function istMonthStart(ms = Date.now()): number {
  const d = new Date(ms + 5.5 * 3600_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 5.5 * 3600_000;
}

export async function monthCostMicroUsd(env: Env, month = istMonth()): Promise<number> {
  const r = await env.DB_META.prepare("SELECT cost_micro_usd FROM ai_spend_months WHERE month=?1").bind(month).first<{ cost_micro_usd: number }>().catch(() => null);
  return Number(r?.cost_micro_usd ?? 0);
}

export async function monthSpend(env: Env): Promise<AdminAiSpend> {
  const month = istMonth();
  const [micro, cfg, plat] = await Promise.all([monthCostMicroUsd(env, month), getAgentConfig(env), readConfig(env)]);
  const rupees = (micro / 1e6) * Number(plat.usdInrRate || 96.4);
  const start = istMonthStart();
  const cnt = await env.DB_META.prepare(
    `SELECT COUNT(*) AS m, COUNT(DISTINCT m.conversation_id) AS c FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id
      WHERE m.role='preeti' AND m.created_at>=?1 AND c.is_test=0`,
  ).bind(start).first<{ m: number; c: number }>().catch(() => null);
  const cap = cfg.monthly_cap_rupees;
  return {
    month, cost_rupees: Math.round(rupees * 100) / 100, cap_rupees: cap,
    pct: cap > 0 ? Math.round((rupees / cap) * 1000) / 10 : 100,
    messages: Number(cnt?.m ?? 0), conversations: Number(cnt?.c ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Retention (12 months) — called from the daily maintenance in index.ts scheduled()
// ---------------------------------------------------------------------------
export async function purgeOldChats(env: Env, now = Date.now()): Promise<{ messages: number; conversations: number }> {
  const cut = now - RETENTION_MS;
  const m = await env.DB_META.prepare("DELETE FROM ai_messages WHERE created_at < ?1").bind(cut).run();
  const c = await env.DB_META.prepare(
    `DELETE FROM ai_conversations WHERE last_message_at < ?1 OR (message_count = 0 AND created_at < ?2)`,
  ).bind(cut, now - 7 * 24 * 3600_000).run();
  await env.DB_META.prepare("DELETE FROM ai_booking_lookups WHERE created_at < ?1").bind(now - 90 * 24 * 3600_000).run();
  await env.DB_META.prepare("DELETE FROM ai_handoffs WHERE created_at < ?1").bind(cut).run();
  return { messages: Number((m as any).meta?.changes ?? 0), conversations: Number((c as any).meta?.changes ?? 0) };
}
