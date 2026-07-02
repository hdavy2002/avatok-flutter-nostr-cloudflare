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

// P8 Stage 2 (restoreV2): page older history from the BATCHED per-user R2 jsonl
// archive that InboxDO writes when chatArchiveV2 is on
// (archive/<uid>/<yyyy-mm>/<firstId>.jsonl). Uid-scoped — a caller only ever reads
// THEIR OWN archive (the DO wrote it under their uid), so no membership check is
// needed. Newest-first, strictly older than `before` (an InboxDO message id).
//
//   GET /api/archive/page?before=<id>&conv=<optional>&limit=<n>
//     → { messages:[{id,conv,sender,kind,body,media_ref,client_id,created_at}], next_before }
export async function archivePage(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.BACKUP_R2) return json({ messages: [], next_before: null });
  const u = new URL(req.url);
  const before = Number(u.searchParams.get("before") || 0) || Number.MAX_SAFE_INTEGER;
  const conv = u.searchParams.get("conv") || "";
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(u.searchParams.get("limit")) || 30));

  const prefix = `archive/${ctx.uid}/`;
  const segments: { key: string; firstId: number }[] = [];
  try {
    let cursor: string | undefined;
    do {
      const res = await env.BACKUP_R2.list({ prefix, cursor, limit: 1000 });
      for (const o of res.objects) {
        const m = o.key.match(/\/(\d+)\.jsonl$/);
        if (m) segments.push({ key: o.key, firstId: Number(m[1]) });
      }
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor);
  } catch { return json({ messages: [], next_before: null }); }

  // Newest segments first; skip any whose whole range is >= the cursor.
  segments.sort((a, b) => b.firstId - a.firstId);
  const out: Record<string, unknown>[] = [];
  for (const seg of segments) {
    if (out.length >= limit) break;
    if (seg.firstId >= before) continue;
    let text = "";
    try { const obj = await env.BACKUP_R2.get(seg.key); if (!obj) continue; text = await obj.text(); }
    catch { continue; }
    const rows: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as Record<string, unknown>; if (r && r.t === "msg") rows.push(r); } catch { /* skip bad line */ }
    }
    // rows ascend by id; walk newest-first, take id < before (+ optional conv).
    for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
      const r = rows[i];
      if (Number(r.id) >= before) continue;
      if (conv && String(r.conv) !== conv) continue;
      out.push({ id: r.id, conv: r.conv, sender: r.sender, kind: r.kind, body: r.body ?? null,
        media_ref: r.media_ref ?? null, client_id: r.client_id ?? null, created_at: r.created_at });
    }
  }
  const nextBefore = out.length ? out[out.length - 1].id : null;
  return json({ messages: out, next_before: nextBefore });
}
