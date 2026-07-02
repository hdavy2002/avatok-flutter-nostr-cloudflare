// Chat archive READ endpoint (Phase 3, ABLY-R2-3).
//
// Ably history serves the most-recent messages instantly; this endpoint serves
// the DEEP archive (everything, forever) from R2 via the D1 message_index. The
// client loads recent from Ably, then pages older history here on scroll-up.
//
//   GET /api/msg/archive?conv=<conv>&before=<serial>&limit=<n>
//     → { messages: [{serial, sender, kind, body, media_ref, created_at}], nextBefore }
//
// Auth: Clerk-gated; the caller must be a member of `conv`. Bodies are read from
// the private BACKUP_R2 bucket by the index's r2_key.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";

const MAX_LIMIT = 50;

async function isMember(env: Env, conv: string, uid: string): Promise<boolean> {
  const r = await env.DB_META.prepare(
    "SELECT 1 FROM conversation_members WHERE conv_id=?1 AND uid=?2 LIMIT 1",
  ).bind(conv, uid).first();
  return !!r;
}

export async function archiveList(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const u = new URL(req.url);
  const conv = u.searchParams.get("conv") || "";
  if (!conv) return json({ error: "conv required" }, 400);
  if (!(await isMember(env, conv, ctx.uid))) return json({ error: "not a member" }, 403);

  const before = u.searchParams.get("before") || "";          // serial cursor (exclusive)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(u.searchParams.get("limit")) || 30));

  // Newest-first page, strictly older than the cursor (serial sorts chronologically).
  const rows = await env.DB_META.prepare(
    `SELECT serial, sender, kind, media_ref, client_id, r2_key, created_at
       FROM message_index
      WHERE conv=?1 ${before ? "AND serial < ?3" : ""}
      ORDER BY serial DESC
      LIMIT ?2`,
  ).bind(...(before ? [conv, limit, before] : [conv, limit])).all<{
    serial: string; sender: string; kind: string; media_ref: string | null; client_id: string | null; r2_key: string; created_at: number;
  }>();

  const items = rows.results ?? [];
  // Fetch bodies from R2 in parallel (bounded by `limit`). A missing object (very
  // old prune / write lag) degrades to a null body rather than failing the page.
  const messages = await Promise.all(items.map(async (r) => {
    let body: string | null = null;
    try {
      if (env.BACKUP_R2) {
        const obj = await env.BACKUP_R2.get(r.r2_key);
        if (obj) { const j = await obj.json<any>(); body = j?.body ?? null; }
      }
    } catch { /* body unavailable — index row still returned */ }
    return { serial: r.serial, sender: r.sender, kind: r.kind, body, media_ref: r.media_ref, client_id: r.client_id, created_at: r.created_at };
  }));

  const nextBefore = items.length === limit ? items[items.length - 1].serial : null;
  return json({ messages, nextBefore });
}

// ---- WRITE side (Phase 3 hardening): consume chat-archive → R2 body + D1 index ----
// The router enqueues each sent message (flag CHAT_ARCHIVE=1) to Q_ARCHIVE; the
// queue consumer calls archiveWrite to persist the body to R2 and a metadata row
// to message_index (the deep, forever archive that archiveList pages back).

let _indexReady = false;
async function ensureIndexTable(env: Env): Promise<void> {
  if (_indexReady) return;
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS message_index (
       serial     TEXT PRIMARY KEY,   -- canonical, chronologically-sortable msg id (globally unique)
       conv       TEXT NOT NULL,
       sender     TEXT NOT NULL,
       kind       TEXT NOT NULL,
       media_ref  TEXT,
       client_id  TEXT,
       r2_key     TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  ).run();
  await env.DB_META.prepare(
    "CREATE INDEX IF NOT EXISTS idx_msgidx_conv ON message_index(conv, serial)",
  ).run();
  _indexReady = true;
}

export interface ArchiveMsg {
  conv: string; serial: string; sender: string; kind: string;
  body?: string | null; media_ref?: string | null; client_id?: string | null;
  created_at: number; group?: boolean;
}

/** Persist one archived message: body → R2, metadata → D1 index. Idempotent on
 *  `serial`, so queue redeliveries are safe (at-least-once → exactly-once effect). */
export async function archiveWrite(env: Env, m: ArchiveMsg): Promise<void> {
  if (!m || !m.conv || !m.serial) return;
  await ensureIndexTable(env);
  const r2Key = `arch/${m.conv}/${m.serial}`;
  if (env.BACKUP_R2) {
    await env.BACKUP_R2.put(r2Key, JSON.stringify({ body: m.body ?? null }), {
      httpMetadata: { contentType: "application/json" },
    });
  }
  await env.DB_META.prepare(
    `INSERT INTO message_index (serial, conv, sender, kind, media_ref, client_id, r2_key, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT(serial) DO NOTHING`,
  ).bind(m.serial, m.conv, m.sender, m.kind, m.media_ref ?? null, m.client_id ?? null, r2Key, m.created_at).run();
}
