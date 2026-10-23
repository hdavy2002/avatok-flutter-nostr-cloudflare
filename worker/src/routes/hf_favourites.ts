// [HF-DASH-FRAANDS-1] Saved ("hearted") hosts, shown on the dashboard screen "My Fraands". Flag hfFavouritesEnabled (off -> 404 not_enabled).
//   GET    /api/hf/favourites         -> { ok, items:[{ slug, displayName, photoUrl, headline, presence:'online'|'busy'|'offline', savedAt,
//                                       languages, topics, plan, pricePerMin, pricePaisePerMin, priceLabel, priceTiers, womenOnly }], count }
//   GET    /api/hf/favourites/:slug   -> { ok, saved }
//   PUT    /api/hf/favourites/:slug   -> { ok, saved:true, count }    idempotent; 404 not a live host, 400 cannot_save_self, 409 limit_reached | account_closing
//   DELETE /api/hf/favourites/:slug   -> { ok, saved:false, count }   idempotent
// Signed in only. Every query is scoped to the caller's uid. Never returns a uid, phone or email. Only live hosts are listed or saveable, and a
// protected-lane host (women / LGBTQ) is only visible to a caller with that lane's access, the same way the public host card treats a lane.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { isClosing } from "../lib/hf_exit";
import { getLaneAccess } from "../lib/hf_lanes";
import { readConfig } from "./config";
import { card, SEL, type LiveRow } from "./hf_hosts_public";
import { lineFieldsForUids } from "../lib/hf_host_line_view"; // [HF-CALL-MODES-A]
import { readHfStdPlan } from "../lib/hf_token_config";
import { pricingStd, readInfluencerRate } from "../lib/hf_influencer_rate"; // [HF-WIRE-18]

export const MAX_FAVOURITES = 500;
const err = (status: number, error: string, message?: string) => json({ ok: false, error, message: message ?? error }, status);
const NO_STORE = { "cache-control": "private, no-store" };

interface LaneFlags { women_lane?: number | null; lgbtq_lane?: number | null; lgbtq_public?: number | null }
const visible = (h: LaneFlags, a: { women: boolean; lgbtq: boolean }) =>
  !(h.women_lane === 1 && !a.women) && !(h.lgbtq_lane === 1 && h.lgbtq_public !== 1 && !a.lgbtq);

async function countFor(env: Env, uid: string): Promise<number> {
  return Number((await env.DB_META.prepare("SELECT COUNT(*) AS c FROM hf_favourites WHERE uid=?1").bind(uid).first<{ c: number }>())?.c ?? 0);
}

export async function hfFavouritesRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  const one = p.match(/^\/api\/hf\/favourites\/([a-z0-9-]{3,40})$/);
  if (p !== "/api/hf/favourites" && !one) return null;
  const m = req.method;
  if (p === "/api/hf/favourites" ? m !== "GET" : !(m === "GET" || m === "PUT" || m === "DELETE")) return err(405, "method_not_allowed");
  try {
    const cfg = await readConfig(env);
    if (cfg.hfFavouritesEnabled !== true) return err(404, "not_enabled");
    const u = await requireUser(req, env);
    if (isFail(u)) return err(u.status, u.error);
    const uid = u.uid;

    if (!one) {
      const access = await getLaneAccess(env, uid);
      const std = pricingStd(readHfStdPlan(cfg as unknown as Record<string, unknown>), cfg as unknown as Record<string, unknown>); // [HF-DASH-V3-1] [HF-WIRE-18]
      const rows = (await env.DB_META.prepare(`${SEL} WHERE h.status='live' AND h.slug IS NOT NULL AND h.uid IN (SELECT host_uid FROM hf_favourites WHERE uid=?1)
        AND NOT EXISTS (SELECT 1 FROM hf_blocks b WHERE (b.blocker_uid=?1 AND b.blocked_uid=h.uid) OR (b.blocker_uid=h.uid AND b.blocked_uid=?1))`) // [HF-DAILY-FLOWS-1] blocked either way = not listed
        .bind(uid).all<LiveRow>()).results ?? [];
      const saved = new Map(((await env.DB_META.prepare("SELECT host_uid, created_at FROM hf_favourites WHERE uid=?1").bind(uid).all<{ host_uid: string; created_at: number }>()).results ?? [])
        .map((r) => [r.host_uid, Number(r.created_at)]));
      const lines = await lineFieldsForUids(env, rows.map((r) => r.uid)); // [HF-CALL-MODES-A]
      const items = rows.filter((r) => visible(r, access)).map((r) => {
        const c = card(env, r, undefined, std, lines?.get(r.uid));
        // [HF-DASH-V3-1] + languages, topics and the price block so the dashboard card can start a real call (HostCallActions).
        return { slug: c.slug, displayName: c.displayName, photoUrl: c.avatarUrl, headline: c.tagline || null, presence: c.status, savedAt: saved.get(r.uid) ?? 0,
          languages: c.languages, topics: c.topics, plan: c.plan, pricePerMin: c.pricePerMin, pricePaisePerMin: c.pricePaisePerMin, priceLabel: c.priceLabel, priceTiers: c.priceTiers, womenOnly: c.womenOnly, ...(lines?.get(r.uid) ?? {}) };
      }).sort((a, b) => b.savedAt - a.savedAt);
      return json({ ok: true, items, count: items.length }, 200, NO_STORE);
    }

    const slug = one[1];
    const host = await env.DB_META.prepare("SELECT uid, women_lane, lgbtq_lane, lgbtq_public FROM hf_hosts WHERE slug=?1 AND status='live'")
      .bind(slug).first<{ uid: string } & LaneFlags>();
    if (m === "GET") {
      if (!host) return json({ ok: true, saved: false }, 200, NO_STORE);
      const row = await env.DB_META.prepare("SELECT 1 AS x FROM hf_favourites WHERE uid=?1 AND host_uid=?2").bind(uid, host.uid).first();
      return json({ ok: true, saved: !!row }, 200, NO_STORE);
    }

    if (await isClosing(env, uid)) return err(409, "account_closing", "Your account is being closed, so it can't be changed.");
    const limited = await rateLimit(env, `hffav:${uid}`, 60, 60);
    if (limited) return limited;

    if (m === "DELETE") {
      // Removing never needs the host to be live-visible to this caller; a slug that is not live is a no-op.
      if (host) await env.DB_META.prepare("DELETE FROM hf_favourites WHERE uid=?1 AND host_uid=?2").bind(uid, host.uid).run();
      return json({ ok: true, saved: false, count: await countFor(env, uid) }, 200, NO_STORE);
    }

    // PUT
    if (!host || !visible(host, await getLaneAccess(env, uid))) return err(404, "not_found", "This host isn't available.");
    if (host.uid === uid) return err(400, "cannot_save_self", "You can't save your own profile.");
    const already = await env.DB_META.prepare("SELECT 1 AS x FROM hf_favourites WHERE uid=?1 AND host_uid=?2").bind(uid, host.uid).first();
    if (!already) {
      if ((await countFor(env, uid)) >= MAX_FAVOURITES) return err(409, "limit_reached", `You can save up to ${MAX_FAVOURITES} hosts. Remove one to save another.`);
      await env.DB_META.prepare("INSERT OR IGNORE INTO hf_favourites (uid, host_uid, created_at) VALUES (?1,?2,?3)").bind(uid, host.uid, Date.now()).run();
    }
    return json({ ok: true, saved: true, count: await countFor(env, uid) }, 200, NO_STORE);
  } catch (e) {
    await trackException(env, e, { route: p, method: m, handled: true, app_name: BRAND.slug, extra: { area: "hf_favourites" } });
    return err(500, "internal_error", "Something went wrong. Please try again.");
  }
}
