// ava_chat_history.ts — AvaChat (talk-to-Ava) conversation history in D1.
// The device keeps a local copy too; this is the cloud backup (cross-device).
//   POST /api/ava/chat/history  {sessionId, persona?, title?, messages:[{role,text}]}
//   GET  /api/ava/chat/history            → { sessions:[{session_id,persona,title,updated_at}] }
//   GET  /api/ava/chat/history?id=<sid>   → { session:{...,messages} }

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";

async function ensureTable(env: Env): Promise<void> {
  await metaDb(env).prepare(
    `CREATE TABLE IF NOT EXISTS avachat_sessions (
       session_id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       persona TEXT,
       title TEXT,
       messages_json TEXT NOT NULL DEFAULT '[]',
       updated_at INTEGER NOT NULL
     )`,
  ).run();
}

export async function avaChatHistorySave(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const sid = String(b.sessionId ?? "").trim();
  if (!sid) return json({ error: "sessionId required" }, 400);
  const messages = Array.isArray(b.messages) ? b.messages.slice(-500) : [];
  try {
    await ensureTable(env);
    await metaDb(env).prepare(
      `INSERT INTO avachat_sessions (session_id, user_id, persona, title, messages_json, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(session_id) DO UPDATE SET persona=?3, title=?4, messages_json=?5, updated_at=?6`,
    ).bind(sid, ctx.uid, String(b.persona ?? ""), String(b.title ?? "").slice(0, 120), JSON.stringify(messages), Date.now()).run();
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "save failed", detail: String(e?.message ?? e).slice(0, 160) }, 502);
  }
}

export async function avaChatHistoryGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const id = new URL(req.url).searchParams.get("id");
  try {
    await ensureTable(env);
    if (id) {
      const row = await metaDb(env).prepare(
        "SELECT session_id, persona, title, messages_json, updated_at FROM avachat_sessions WHERE session_id=?1 AND user_id=?2",
      ).bind(id, ctx.uid).first<any>();
      return json({ ok: true, session: row ? { ...row, messages: JSON.parse(row.messages_json || "[]") } : null });
    }
    const rows = await metaDb(env).prepare(
      "SELECT session_id, persona, title, updated_at FROM avachat_sessions WHERE user_id=?1 ORDER BY updated_at DESC LIMIT 50",
    ).bind(ctx.uid).all();
    return json({ ok: true, sessions: rows.results ?? [] });
  } catch (e: any) {
    return json({ error: "get failed", detail: String(e?.message ?? e).slice(0, 160) }, 502);
  }
}
