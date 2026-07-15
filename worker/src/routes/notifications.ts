// /api/notifications — the in-app feed (list / unread-count / mark-read). NIP-98
// (+ Clerk) auth; uid from the signature, so a user only sees their own feed.
import type { Env } from "../types";
import { json } from "../util";
import { metaSession, metaDb } from "../db/shard";
import { requireUser, isFail } from "../authz";

/// [NOTIF-RETENTION-1] Notifications live for 24h (owner decision 2026-07-15:
/// "auto delete notification after a day"). This feed is a "what just happened"
/// ticker — a day-old "your agent reached a deal" is noise, and the owner's feed
/// had grown into an unreadable wall of them.
export const NOTIF_TTL_MS = 24 * 60 * 60 * 1000;

export async function listNotifications(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cursor = Number(new URL(req.url).searchParams.get("cursor") || Date.now());
  // [NOTIF-RETENTION-1] Purge this user's expired rows before reading. Done on
  // the read path deliberately: a Cron Trigger would have to scan every uid in
  // the table, whereas this is an indexed (uid, created_at) delete over one
  // user's rows, it only runs for users who actually open the feed, and it can
  // never leave a user looking at rows the next query would drop. Awaited (not
  // fire-and-forget) so the SELECT below can't race it and return a row we just
  // deleted; best-effort — a purge failure must never blank the feed.
  const cutoff = Date.now() - NOTIF_TTL_MS;
  try {
    await metaDb(env).prepare("DELETE FROM notifications WHERE uid=?1 AND created_at < ?2")
      .bind(ctx.uid, cutoff).run();
  } catch { /* retention is best-effort — never fail the read */ }
  // Bound the window by the cutoff too, so a stale client cursor can't page back
  // into rows the purge hasn't reached yet on another shard/replica.
  const rs = await metaSession(env).prepare(
    "SELECT id, type, title, body, data, read, created_at FROM notifications WHERE uid=?1 AND created_at < ?2 AND created_at >= ?3 ORDER BY created_at DESC LIMIT 30",
  ).bind(ctx.uid, cursor, cutoff).all();
  const items = (rs.results ?? []).map((r: any) => ({ ...r, read: !!r.read, data: r.data ? safeJson(r.data) : null }));
  const next = items.length === 30 ? items[items.length - 1].created_at : null;
  return json({ items, cursor: next });
}

/// [NOTIF-CLEAR-1] DELETE /api/notifications — "Clear all" (owner request
/// 2026-07-15). Deletes rather than marks read: the feed is disposable by design
/// (see NOTIF_TTL_MS), and "clear" that leaves everything on screen greyed out is
/// not what anyone means by clear.
export async function clearNotifications(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const r = await metaDb(env).prepare("DELETE FROM notifications WHERE uid=?1").bind(ctx.uid).run();
  return json({ ok: true, deleted: r.meta?.changes ?? 0 });
}

export async function unreadCount(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // [NOTIF-RETENTION-1] Must apply the SAME 24h cutoff as the feed. Counting rows
  // the feed will never show would strand a permanent unread badge over an empty
  // list — the classic "badge says 3, list is empty" bug.
  const c = await metaSession(env).prepare(
    "SELECT count(*) AS n FROM notifications WHERE uid=?1 AND read=0 AND created_at >= ?2",
  ).bind(ctx.uid, Date.now() - NOTIF_TTL_MS).first<{ n: number }>();
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
