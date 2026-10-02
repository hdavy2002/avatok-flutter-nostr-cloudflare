// [AUMFE-GUIDE-BRAIN-1 2026-10-01] Pandit ji's conversations live in Preeti's tables (ai_conversations / ai_messages,
// migrations/2026-09-30-preeti-ai.sql) told apart by ai_conversations.agent = 'pandit' (2026-10-01-agent-memory-alters.sql).
// ai_messages.role is CHECK-constrained to ('visitor','preeti','tool','admin_note','system'), so:
//   customer  -> 'visitor'     Pandit ji -> 'preeti' (the existing assistant role; the column is not renamed)     tool rows -> 'tool'
import type { Env } from "../../types";
import type { CtxRow } from "./cost";
import type { ChatMessageOut, GuideCard } from "./types";

export const AGENT_ID = "pandit";
export const ROLE_CUSTOMER = "visitor";
export const ROLE_ASSISTANT = "preeti";
export const ROLE_TOOL = "tool";
/** [AUMFE-PANDIT-COST-1] Rolling-summary rows: role 'system', text "[summary] ...", tool_summary = last ai_messages.id covered. Never shown to the customer. */
export const ROLE_SYSTEM = "system";

export interface PanditConv { id: string; uid: string; message_count: number; status: string }

/** The conversation, only when it is this customer's Pandit ji conversation. */
export async function getOwnedConversation(env: Env, uid: string, id: string): Promise<PanditConv | null> {
  if (!id || id.length > 64) return null;
  const r = await env.DB_META.prepare(`SELECT id, uid, message_count, status FROM ai_conversations WHERE id=?1 AND uid=?2 AND agent=?3`)
    .bind(id, uid, AGENT_ID).first<PanditConv>();
  return r ?? null;
}

export async function latestConversation(env: Env, uid: string): Promise<PanditConv | null> {
  const r = await env.DB_META.prepare(
    `SELECT id, uid, message_count, status FROM ai_conversations WHERE uid=?1 AND agent=?2 AND status<>'resolved' ORDER BY last_message_at DESC LIMIT 1`,
  ).bind(uid, AGENT_ID).first<PanditConv>();
  return r ?? null;
}

export async function createConversation(env: Env, uid: string, name: string | null): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO ai_conversations (id, uid, visitor_id, name, agent, created_at, last_message_at) VALUES (?1,?2,?2,?3,?4,?5,?5)`,
  ).bind(id, uid, name, AGENT_ID, now).run();
  return id;
}

export interface NewRow {
  role: typeof ROLE_CUSTOMER | typeof ROLE_ASSISTANT | typeof ROLE_TOOL | typeof ROLE_SYSTEM;
  text: string; cards?: GuideCard[]; tool_name?: string; tool_summary?: string;
  model?: string; input_tokens?: number; output_tokens?: number; cost_micro_usd?: number; blocked?: boolean;
}

export async function insertRow(env: Env, conversationId: string, m: NewRow): Promise<void> {
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO ai_messages (conversation_id, role, text, cards_json, tool_name, tool_summary, model, input_tokens, output_tokens, cost_micro_usd, blocked, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
  ).bind(
    conversationId, m.role, m.text, m.cards?.length ? JSON.stringify(m.cards) : null, m.tool_name ?? null, m.tool_summary ?? null,
    m.model ?? null, m.input_tokens ?? null, m.output_tokens ?? null, m.cost_micro_usd ?? null, m.blocked ? 1 : 0, now,
  ).run();
  if (m.role !== ROLE_TOOL && m.role !== ROLE_SYSTEM) {
    await env.DB_META.prepare(`UPDATE ai_conversations SET message_count=message_count+1, last_message_at=?2 WHERE id=?1`).bind(conversationId, now).run();
  }
}

export function parseCards(raw: unknown): GuideCard[] {
  try { const a = JSON.parse(String(raw ?? "[]")); return Array.isArray(a) ? (a as GuideCard[]) : []; } catch { return []; }
}

/** Customer/assistant rows -> the wire shape (`visitor` -> 'user', `preeti` -> 'assistant'). Pure. */
export function toWire(rows: { role: string; text: string; cards_json: string | null }[]): ChatMessageOut[] {
  const out: ChatMessageOut[] = [];
  for (const r of rows) {
    if (r.role !== ROLE_CUSTOMER && r.role !== ROLE_ASSISTANT) continue;
    const cards = parseCards(r.cards_json);
    out.push({ role: r.role === ROLE_CUSTOMER ? "user" : "assistant", text: r.text, ...(cards.length ? { cards } : {}) });
  }
  return out;
}

/** Last N visible turns, oldest first. `beforeId` excludes rows from the current turn. */
export async function loadMessages(env: Env, conversationId: string, limit = 40): Promise<ChatMessageOut[]> {
  const rs = await env.DB_META.prepare(
    `SELECT role, text, cards_json FROM ai_messages WHERE conversation_id=?1 AND role IN ('visitor','preeti') AND blocked=0 AND text<>'' ORDER BY id DESC LIMIT ?2`,
  ).bind(conversationId, limit).all<{ role: string; text: string; cards_json: string | null }>();
  return toWire((rs.results ?? []).reverse());
}

/** [AUMFE-PANDIT-COST-1] Rows the prompt builder needs, oldest first: customer, assistant and summary rows with their ids. */
export async function loadContextRows(env: Env, conversationId: string, limit = 80): Promise<CtxRow[]> {
  const rs = await env.DB_META.prepare(
    `SELECT id, role, text, tool_summary FROM ai_messages WHERE conversation_id=?1 AND role IN ('visitor','preeti','system') AND blocked=0 AND text<>'' ORDER BY id DESC LIMIT ?2`,
  ).bind(conversationId, limit).all<CtxRow>();
  return (rs.results ?? []).reverse();
}

export async function countCustomerMessages(env: Env, conversationId: string): Promise<number> {
  const r = await env.DB_META.prepare(`SELECT COUNT(*) AS n FROM ai_messages WHERE conversation_id=?1 AND role='visitor'`).bind(conversationId).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** Customer messages this user sent to Pandit ji, across conversations, since `sinceMs`. */
export async function countCustomerMessagesSince(env: Env, uid: string, sinceMs: number): Promise<number> {
  const r = await env.DB_META.prepare(
    `SELECT COUNT(*) AS n FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id WHERE c.uid=?1 AND c.agent=?2 AND m.role='visitor' AND m.created_at>=?3`,
  ).bind(uid, AGENT_ID, sinceMs).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** Atomic claim: true only for the caller that moved the conversation to 'resolved' (so a double close does the work once). */
export async function resolveConversation(env: Env, uid: string, conversationId: string): Promise<boolean> {
  const r = await env.DB_META.prepare(`UPDATE ai_conversations SET status='resolved' WHERE id=?1 AND uid=?2 AND agent=?3 AND status<>'resolved'`).bind(conversationId, uid, AGENT_ID).run();
  return Number((r.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
}
