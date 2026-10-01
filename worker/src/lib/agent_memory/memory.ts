// [AUMFE-AGENT-MEMORY-1] Remembered facts / open threads / session summaries, per customer, shared by every agent.
// D1 (ai_memory) is the owner of truth; mem0 is a derived semantic index (fail-open, never blocks).
// Limits borrowed from agent_live/memory.ts. Every write is gated on astro_profiles.memory_consent=1.
import type { Env } from "../../types";
import { track } from "../../hooks";
import { BRAND } from "../brand";
import { mem0Add, mem0Configured, mem0DeleteOne, mem0DeleteUser, mem0Search } from "../mem0";
import { APP, hasConsent } from "./profile";

export const MAX_FACTS = 40;
export const MAX_OPEN_THREADS = 10;
export const MAX_FACT_CHARS = 160;
export const MAX_SUMMARY_CHARS = 1500;

export type MemoryKind = "fact" | "open_thread" | "summary";

export interface MemoryRow {
  id: string;
  uid: string;
  agent: string;
  kind: MemoryKind;
  text: string;
  source_conversation_id: string | null;
  mem0_id: string | null;
  created_at: number;
  deleted_at: number | null;
}

/** One mem0 "user" per customer; prefix derived from the brand slug so a rename is a single edit. */
export function mem0UserId(uid: string): string {
  return `${BRAND.slug}::${uid}`;
}

function tel(env: Env, uid: string, event: string, props: Record<string, unknown> = {}): void {
  void track(env, uid, event, APP, { uid, ...props });
}

export type RememberResult = { ok: true; id: string; duplicate?: boolean } | { ok: false; skipped: "no_consent" | "empty" | "no_uid" };

export async function remember(
  env: Env, uid: string, agent: string, text: string, sourceConversationId: string | null = null, kind: MemoryKind = "fact",
): Promise<RememberResult> {
  if (!uid) return { ok: false, skipped: "no_uid" };
  const max = kind === "summary" ? MAX_SUMMARY_CHARS : MAX_FACT_CHARS;
  const t = (text || "").trim().slice(0, max);
  if (!t) return { ok: false, skipped: "empty" };
  if (!(await hasConsent(env, uid))) {
    tel(env, uid, "agent_memory_skipped", { agent, reason: "no_consent", kind });
    return { ok: false, skipped: "no_consent" };
  }

  const dup = await env.DB_META.prepare(
    `SELECT id FROM ai_memory WHERE uid=?1 AND kind=?2 AND deleted_at IS NULL AND lower(text)=lower(?3) LIMIT 1`,
  ).bind(uid, kind, t).first<{ id: string }>();
  if (dup) return { ok: true, id: dup.id, duplicate: true };

  // Summaries are idempotent per session (one per source conversation).
  if (kind === "summary" && sourceConversationId) {
    const ex = await env.DB_META.prepare(
      `SELECT id FROM ai_memory WHERE uid=?1 AND kind='summary' AND source_conversation_id=?2 AND deleted_at IS NULL LIMIT 1`,
    ).bind(uid, sourceConversationId).first<{ id: string }>();
    if (ex) return { ok: true, id: ex.id, duplicate: true };
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO ai_memory (id, uid, agent, kind, text, source_conversation_id, mem0_id, created_at) VALUES (?1,?2,?3,?4,?5,?6,NULL,?7)`,
  ).bind(id, uid, agent, kind, t, sourceConversationId, now).run();

  // Semantic index — fail-open, but a failure is reported.
  if (mem0Configured(env)) {
    const { id: mid, res } = await mem0Add(env, mem0UserId(uid), t, { agent, kind, ai_memory_id: id });
    if (mid) await env.DB_META.prepare(`UPDATE ai_memory SET mem0_id=?1 WHERE id=?2`).bind(mid, id).run();
    if (!res.ok) tel(env, uid, "agent_memory_mem0_failed", { op: "add", reason: res.reason });
  }

  await evictOverCap(env, uid, kind);
  tel(env, uid, "agent_memory_remembered", { agent, kind });
  return { ok: true, id };
}

/** FIFO cap: soft-delete the oldest rows beyond the cap (summaries are not capped here; briefing reads only the newest). */
async function evictOverCap(env: Env, uid: string, kind: MemoryKind): Promise<void> {
  const cap = kind === "fact" ? MAX_FACTS : kind === "open_thread" ? MAX_OPEN_THREADS : 0;
  if (!cap) return;
  const over = await env.DB_META.prepare(
    `SELECT id, mem0_id FROM ai_memory WHERE uid=?1 AND kind=?2 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?3`,
  ).bind(uid, kind, cap).all<{ id: string; mem0_id: string | null }>();
  for (const r of over.results ?? []) await softDelete(env, uid, r.id, r.mem0_id);
}

async function softDelete(env: Env, uid: string, id: string, mem0Id: string | null): Promise<void> {
  await env.DB_META.prepare(`UPDATE ai_memory SET deleted_at=?1 WHERE id=?2 AND uid=?3 AND deleted_at IS NULL`).bind(Date.now(), id, uid).run();
  if (mem0Id && mem0Configured(env)) {
    const res = await mem0DeleteOne(env, mem0Id);
    if (!res.ok) tel(env, uid, "agent_memory_mem0_failed", { op: "delete", reason: res.reason });
  }
}

export async function listMemories(env: Env, uid: string, opts: { kind?: MemoryKind; limit?: number } = {}): Promise<MemoryRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const q = opts.kind
    ? env.DB_META.prepare(`SELECT * FROM ai_memory WHERE uid=?1 AND deleted_at IS NULL AND kind=?2 ORDER BY created_at DESC LIMIT ?3`).bind(uid, opts.kind, limit)
    : env.DB_META.prepare(`SELECT * FROM ai_memory WHERE uid=?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?2`).bind(uid, limit);
  return (await q.all<MemoryRow>()).results ?? [];
}

export async function forgetOne(env: Env, uid: string, id: string): Promise<boolean> {
  const row = await env.DB_META.prepare(`SELECT id, mem0_id FROM ai_memory WHERE id=?1 AND uid=?2 AND deleted_at IS NULL`).bind(id, uid).first<{ id: string; mem0_id: string | null }>();
  if (!row) return false;
  await softDelete(env, uid, row.id, row.mem0_id);
  tel(env, uid, "agent_memory_forgot_one", {});
  return true;
}

/** Forget me: soft-delete every memory, wipe mem0, drop session summaries and stored transcripts. The profile row stays (customer can delete data separately). */
export async function forgetAll(env: Env, uid: string): Promise<{ memories: number; transcripts: number; mem0: boolean }> {
  const now = Date.now();
  const r = await env.DB_META.prepare(`UPDATE ai_memory SET deleted_at=?1 WHERE uid=?2 AND deleted_at IS NULL`).bind(now, uid).run();
  const memories = Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);

  let mem0ok = true;
  if (mem0Configured(env)) {
    const res = await mem0DeleteUser(env, mem0UserId(uid));
    mem0ok = res.ok;
    if (!res.ok) tel(env, uid, "agent_memory_mem0_failed", { op: "delete_user", reason: res.reason });
  }

  const keys = await env.DB_META.prepare(`SELECT transcript_r2_key AS k FROM agent_sessions WHERE uid=?1 AND transcript_r2_key IS NOT NULL`).bind(uid).all<{ k: string }>();
  const list = (keys.results ?? []).map((x) => x.k).filter((k) => k.startsWith(`agent-sessions/${uid}/`));
  for (let i = 0; i < list.length; i += 1000) await env.DIGITAL.delete(list.slice(i, i + 1000));
  await env.DB_META.prepare(`UPDATE agent_sessions SET summary=NULL, transcript_r2_key=NULL WHERE uid=?1`).bind(uid).run();

  tel(env, uid, "agent_memory_forget_all", { memories, transcripts: list.length, mem0: mem0ok });
  return { memories, transcripts: list.length, mem0: mem0ok };
}

/** Semantic recall: mem0 search when configured, D1 LIKE fallback when unset or failing. Returns plain text lines. */
export async function recall(env: Env, uid: string, query: string, limit = 8): Promise<string[]> {
  const q = (query || "").trim();
  if (!uid || !q) return [];
  if (!(await hasConsent(env, uid))) return [];
  if (mem0Configured(env)) {
    const { texts, res } = await mem0Search(env, mem0UserId(uid), q, limit);
    if (res.ok) return texts;
    tel(env, uid, "agent_memory_mem0_failed", { op: "search", reason: res.reason });
  }
  const words = Array.from(new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))).slice(0, 6);
  if (!words.length) return [];
  const likes = words.map((_, i) => `lower(text) LIKE ?${i + 2} ESCAPE '\\'`).join(" OR ");
  const binds = words.map((w) => `%${w.replace(/[\\%_]/g, "\\$&")}%`);
  const rows = await env.DB_META.prepare(
    `SELECT text FROM ai_memory WHERE uid=?1 AND deleted_at IS NULL AND kind IN ('fact','summary') AND (${likes}) ORDER BY created_at DESC LIMIT ${Math.min(limit, 20)}`,
  ).bind(uid, ...binds).all<{ text: string }>();
  return (rows.results ?? []).map((r) => r.text);
}
