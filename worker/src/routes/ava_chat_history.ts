// ava_chat_history.ts — AvaChat (talk-to-Ava) conversation history in D1.
// The device keeps a local copy too (per-account SQLite); this is the cloud
// backup (cross-device) AND the source of truth for the session list metadata
// (title, starred, archived, manual sort order).
//
//   POST /api/ava/chat/history       {sessionId, persona?, title?, starred?,
//                                      archived?, sortOrder?, messages:[{role,text}]}
//   GET  /api/ava/chat/history                 → { sessions:[{session_id,persona,
//                                                  title,starred,archived,sort_order,updated_at}] }
//   GET  /api/ava/chat/history?id=<sid>        → { session:{...,messages} }
//   GET  /api/ava/chat/history?archived=1      → archived sessions only
//   POST /api/ava/chat/history/meta  {sessionId, action:'rename'|'star'|'archive'
//                                      |'delete', title?, starred?, archived?}
//                                   OR {action:'reorder', order:[sessionId,...]}
//
// The metadata columns (starred/archived/sort_order) are added in-place by
// ensureTable() the same way the table itself is created lazily — no separate
// migration file is needed and an older DB upgrades on the next write.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";

// [ONEBRAIN-B0] avachat_sessions now ALSO has a real migration
// (worker/migrations/brain_phase_b0.sql, applied to avatok-meta). This ensureTable()
// is kept as the lazy safety-net for fresh/older DBs and MUST stay schema-identical
// to that migration — the effective schema here (base columns + the starred/archived/
// sort_order ALTERs) IS what the migration creates inline. No drift.
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
  // In-place upgrade for DBs created before the session-list metadata existed.
  // SQLite has no "ADD COLUMN IF NOT EXISTS", so each ALTER is best-effort and a
  // duplicate-column error (already added) is swallowed.
  for (const ddl of [
    `ALTER TABLE avachat_sessions ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE avachat_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE avachat_sessions ADD COLUMN sort_order REAL`,
  ]) {
    try { await metaDb(env).prepare(ddl).run(); } catch { /* column exists */ }
  }
}

export async function avaChatHistorySave(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const sid = String(b.sessionId ?? "").trim();
  if (!sid) return json({ error: "sessionId required" }, 400);
  const messages = Array.isArray(b.messages) ? b.messages.slice(-500) : [];
  const starred = b.starred ? 1 : 0;
  const archived = b.archived ? 1 : 0;
  const sortOrder = typeof b.sortOrder === "number" ? b.sortOrder : null;
  try {
    await ensureTable(env);
    // Preserve metadata on conflict: a plain message save must not clobber an
    // existing star/archive/order the user set elsewhere. We only overwrite a
    // flag/order when the caller explicitly sent a non-default value.
    await metaDb(env).prepare(
      `INSERT INTO avachat_sessions
         (session_id, user_id, persona, title, messages_json, starred, archived, sort_order, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(session_id) DO UPDATE SET
         persona=?3,
         title=?4,
         messages_json=?5,
         starred=CASE WHEN ?6=1 THEN 1 ELSE starred END,
         archived=CASE WHEN ?7=1 THEN 1 ELSE archived END,
         sort_order=COALESCE(?8, sort_order),
         updated_at=?9`,
    ).bind(
      sid, ctx.uid, String(b.persona ?? ""), String(b.title ?? "").slice(0, 120),
      JSON.stringify(messages), starred, archived, sortOrder, Date.now(),
    ).run();
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: "save failed", detail: String(e?.message ?? e).slice(0, 160) }, 502);
  }
}

export async function avaChatHistoryGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const archivedOnly = url.searchParams.get("archived") === "1";
  try {
    await ensureTable(env);
    if (id) {
      const row = await metaDb(env).prepare(
        "SELECT session_id, persona, title, messages_json, starred, archived, sort_order, updated_at FROM avachat_sessions WHERE session_id=?1 AND user_id=?2",
      ).bind(id, ctx.uid).first<any>();
      return json({ ok: true, session: row ? { ...row, messages: JSON.parse(row.messages_json || "[]") } : null });
    }
    // List: caller picks active (default) or archived. Manual order first
    // (sort_order ascending, NULLs last), then most-recent.
    const rows = await metaDb(env).prepare(
      `SELECT session_id, persona, title, starred, archived, sort_order, updated_at
         FROM avachat_sessions
        WHERE user_id=?1 AND archived=?2
        ORDER BY (sort_order IS NULL) ASC, sort_order ASC, updated_at DESC
        LIMIT 200`,
    ).bind(ctx.uid, archivedOnly ? 1 : 0).all();
    return json({ ok: true, sessions: rows.results ?? [] });
  } catch (e: any) {
    return json({ error: "get failed", detail: String(e?.message ?? e).slice(0, 160) }, 502);
  }
}

/// Lightweight metadata mutations for the session list: rename, star/unstar,
/// archive/unarchive, delete, and manual reorder. Keeping these off the heavy
/// `save` path means a one-tap action never re-uploads the whole transcript.
export async function avaChatHistoryMeta(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = String(b.action ?? "").trim();
  try {
    await ensureTable(env);
    const now = Date.now();
    switch (action) {
      case "rename": {
        const sid = String(b.sessionId ?? "").trim();
        if (!sid) return json({ error: "sessionId required" }, 400);
        await metaDb(env).prepare(
          "UPDATE avachat_sessions SET title=?1, updated_at=?2 WHERE session_id=?3 AND user_id=?4",
        ).bind(String(b.title ?? "").slice(0, 120), now, sid, ctx.uid).run();
        return json({ ok: true });
      }
      case "star": {
        const sid = String(b.sessionId ?? "").trim();
        if (!sid) return json({ error: "sessionId required" }, 400);
        await metaDb(env).prepare(
          "UPDATE avachat_sessions SET starred=?1 WHERE session_id=?2 AND user_id=?3",
        ).bind(b.starred ? 1 : 0, sid, ctx.uid).run();
        return json({ ok: true });
      }
      case "archive": {
        const sid = String(b.sessionId ?? "").trim();
        if (!sid) return json({ error: "sessionId required" }, 400);
        await metaDb(env).prepare(
          "UPDATE avachat_sessions SET archived=?1, updated_at=?2 WHERE session_id=?3 AND user_id=?4",
        ).bind(b.archived ? 1 : 0, now, sid, ctx.uid).run();
        return json({ ok: true });
      }
      case "delete": {
        const sid = String(b.sessionId ?? "").trim();
        if (!sid) return json({ error: "sessionId required" }, 400);
        await metaDb(env).prepare(
          "DELETE FROM avachat_sessions WHERE session_id=?1 AND user_id=?2",
        ).bind(sid, ctx.uid).run();
        return json({ ok: true });
      }
      case "reorder": {
        const order: string[] = Array.isArray(b.order) ? b.order.map((s: any) => String(s)) : [];
        if (order.length === 0) return json({ ok: true });
        // Assign ascending sort_order in the given sequence (10, 20, 30…) so a
        // later single-item move can slot between two rows without a full rewrite.
        const stmt = metaDb(env).prepare(
          "UPDATE avachat_sessions SET sort_order=?1 WHERE session_id=?2 AND user_id=?3",
        );
        const batch = order.map((sid, i) => stmt.bind((i + 1) * 10, sid, ctx.uid));
        await metaDb(env).batch(batch);
        return json({ ok: true });
      }
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e: any) {
    return json({ error: "meta failed", detail: String(e?.message ?? e).slice(0, 160) }, 502);
  }
}
