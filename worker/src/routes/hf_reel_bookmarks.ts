import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { rateLimit } from "../money";
import { isClosing } from "../lib/hf_exit";
import { savedReelItems } from "./hf_reels";

const headers = { "cache-control": "private, no-store" };
const error = (status: number, code: string) => json({ ok: false, error: code }, status, headers);
export async function hfReelBookmarksRoute(req: Request, env: Env, path: string): Promise<Response | null> {
  const match = path.match(/^\/api\/hf\/reel-bookmarks(?:\/((?:hfrl|hfiv)_[a-z0-9]{8,40}|hfin_[a-f0-9]{20}))?$/);
  if (!match) return null;
  const id = match[1];
  if (id ? !["PUT", "DELETE"].includes(req.method) : req.method !== "GET") return error(405, "method_not_allowed");
  const user = await requireUser(req, env);
  if (isFail(user)) return error(user.status, user.error);
  const cfg = await readConfig(env) as unknown as Record<string, unknown>;
  if (cfg.hfFavouritesEnabled !== true || cfg.hfReelsEnabled !== true) return error(404, "not_enabled");
  const uid = user.uid;
  if (!id) {
    const rows = (await env.DB_META.prepare("SELECT reel_id FROM hf_reel_bookmarks WHERE uid=?1 ORDER BY created_at DESC, reel_id LIMIT 500").bind(uid).all<{ reel_id: string }>()).results ?? [];
    // Keep each SQL statement below D1's bind limit.
    const items: unknown[] = [];
    for (let i = 0; i < rows.length; i += 50) items.push(...await savedReelItems(env, rows.slice(i, i + 50).map(r => r.reel_id), cfg, uid)); // [HF-REEL-ENGAGE-API-1] likedByMe
    const positions = new Map(rows.map((r, i) => [r.reel_id, i]));
    items.sort((a: any, b: any) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
    return json({ ok: true, items }, 200, headers);
  }
  if (await isClosing(env, uid)) return error(409, "account_closing");
  const limited = await rateLimit(env, `hfreelbookmark:${uid}`, 60, 60);
  if (limited) return limited;
  if (req.method === "DELETE") {
    await env.DB_META.prepare("DELETE FROM hf_reel_bookmarks WHERE uid=?1 AND reel_id=?2").bind(uid, id).run();
    return json({ ok: true, saved: false }, 200, headers);
  }
  if (!(await savedReelItems(env, [id], cfg)).length) return error(404, "not_found");
  // Atomic limit + idempotent insertion, including concurrent requests.
  await env.DB_META.prepare("INSERT OR IGNORE INTO hf_reel_bookmarks (uid,reel_id,created_at) SELECT ?1,?2,?3 WHERE (SELECT COUNT(*) FROM hf_reel_bookmarks WHERE uid=?1)<500").bind(uid, id, Date.now()).run();
  const saved = await env.DB_META.prepare("SELECT 1 FROM hf_reel_bookmarks WHERE uid=?1 AND reel_id=?2").bind(uid, id).first();
  return saved ? json({ ok: true, saved: true }, 200, headers) : error(409, "limit_reached");
}
