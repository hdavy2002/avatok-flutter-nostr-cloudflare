// /api/notifications — the in-app feed (list / unread-count / mark-read). NIP-98
// (+ Clerk) auth; uid from the signature, so a user only sees their own feed.
import type { Env } from "../types";
import { json } from "../util";
import { metaSession, metaDb } from "../db/shard";
import { requireUser, isFail } from "../authz";

export async function listNotifications(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cursor = Number(new URL(req.url).searchParams.get("cursor") || Date.now());
  const rs = await metaSession(env).prepare(
    "SELECT id, type, title, body, data, read, created_at FROM notifications WHERE uid=?1 AND created_at < ?2 ORDER BY created_at DESC LIMIT 30",
  ).bind(ctx.uid, cursor).all();
  const items = (rs.results ?? []).map((r: any) => ({ ...r, read: !!r.read, data: r.data ? safeJson(r.data) : null }));
  const next = items.length === 30 ? items[items.length - 1].created_at : null;
  return json({ items, cursor: next });
}

export async function unreadCount(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const c = await metaSession(env).prepare("SELECT count(*) AS n FROM notifications WHERE uid=?1 AND read=0").bind(ctx.uid).first<{ n: number }>();
  return json({ unread: c?.n ?? 0 });
}

export async function markRead(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { ids?: string[]; all?: boolean };
  if (b.all) {
    await metaDb(env).prepare("UPDATE notifications SET read=1 WHERE uid=?1 AND read=0").bind(ctx.uid).run();
    return json({ ok: true });
  }
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 100) : [];
  if (!ids.length) return json({ ok: true });
  const place = ids.map((_, i) => `?${i + 2}`).join(",");
  await metaDb(env).prepare(`UPDATE notifications SET read=1 WHERE uid=?1 AND id IN (${place})`).bind(ctx.uid, ...ids).run();
  return json({ ok: true });
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
