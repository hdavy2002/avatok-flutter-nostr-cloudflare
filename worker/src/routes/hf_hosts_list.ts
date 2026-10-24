// [HF-NATIVE-S2/S3] Native-app host list + options. The web's GET /api/hosts/public is untouched (bare array, web depends on it).
//   GET /api/hf/hosts?topic=a,b&lang=hi,en&minPrice=&maxPrice=&online=1&lane=women|lgbtq&space=women|lgbtq&sort=online_first|price_low|rating&limit=24&offset=
//        -> { items:[card], nextOffset:number|null, total }   same card shape as /api/hosts/public (flag hostsPublicEnabled)
//   GET /api/hf/options  -> topics/moodGroups/languages/styles/priceMin/priceMax, public, cached 1 h
// Lane lists follow the public route's rule: bearer + lane access, else 403 lane_required; never cached.
import type { Env } from "../types";
import { json } from "../util";
import { trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { readConfig } from "./config";
import { requireUser, isFail } from "../authz";
import { getLaneAccess } from "../lib/hf_lanes";
import { hostAggregates } from "../lib/hf_reviews";
import { buildHfOptions } from "../lib/hf_options";
import { parseHostList, buildListSql, listCacheKey } from "../lib/hf_hosts_list";
import { card, SEL, type LiveRow } from "./hf_hosts_public";
import { lineFieldsForUids } from "../lib/hf_host_line_view"; // [HF-CALL-MODES-A]
import { canBook } from "../lib/hf_host_status";
import { readHfStdPlan } from "../lib/hf_token_config"; // [HF-STD-PLAN-1]
import { pricingStd, readInfluencerRate } from "../lib/hf_influencer_rate"; // [HF-WIRE-18]

const LIST_TTL_S = 45;
const err = (status: number, error: string) => json({ error }, status);
const NO_STORE = { "cache-control": "private, no-store" };

export async function hfHostsListRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  // [HF-CALL-MODES-A] GET /api/hf/hosts/:slug -> fresh, uncached call state of ONE host (what the fan's Call / Book / Queue buttons poll).
  const one = p.match(/^\/api\/hf\/hosts\/([a-z0-9-]{3,40})$/);
  if (req.method !== "GET" || !(p === "/api/hf/hosts" || p === "/api/hf/options" || (one && one[1] !== "me"))) return null;
  if (one) {
    try {
      const cfg1 = await readConfig(env);
      if (cfg1.hostsPublicEnabled !== true) return err(404, "not_enabled");
      const h = await env.DB_META.prepare("SELECT uid, slug, presence FROM hf_hosts WHERE slug=?1 AND status='live'").bind(one[1]).first<{ uid: string; slug: string; presence: string | null }>();
      if (!h) return err(404, "not_found");
      const status = h.presence === "online" || h.presence === "busy" ? h.presence : "offline";
      const line = (await lineFieldsForUids(env, [h.uid]))?.get(h.uid);
      if (!line) return json({ ok: true, slug: h.slug, status }, 200, NO_STORE);
      return json({ ok: true, slug: h.slug, status, mode: line.mode, callState: line.callState, queue: line.queue, canQueue: line.queue.open, canBook: canBook(line.callState) }, 200, NO_STORE);
    } catch (e) {
      await trackException(env, e, { route: p, method: "GET", handled: true, app_name: BRAND.slug, extra: { area: "hf_hosts_list" } });
      return err(500, "internal_error");
    }
  }
  if (p === "/api/hf/options") return json(buildHfOptions(), 200, { "cache-control": "public, max-age=3600" });
  try {
    const cfgAll = await readConfig(env);
    if (cfgAll.hostsPublicEnabled !== true) return err(404, "not_enabled");
    const parsed = parseHostList(url.searchParams);
    if (!parsed.ok) return err(parsed.status, parsed.error);
    const std = pricingStd(readHfStdPlan(cfgAll as unknown as Record<string, unknown>), cfgAll as unknown as Record<string, unknown>); // [HF-STD-PLAN-1] [HF-WIRE-18]
    const q = parsed.q;
    const authed = req.headers.has("authorization");
    if (q.lane) {
      const u = await requireUser(req, env);
      if (isFail(u)) return err(u.status, u.error);
      if (!(await getLaneAccess(env, u.uid))[q.lane]) return err(403, "lane_required");
    }
    // Edge cache: anonymous, non-lane only. Key is the validated, canonically ordered query, so junk params cannot fragment it.
    const cacheable = !q.lane && !authed && typeof caches !== "undefined";
    const key = cacheable ? new Request(`https://hf-hosts.cache.invalid/api/hf/hosts?${listCacheKey(q)}&pricing=creator-r1&std=${std.enabled ? std.tariff.tiers[0].paisePerMin : "off"}`) : null;
    if (cacheable && key) {
      const hit = await caches.default.match(key).catch(() => undefined);
      if (hit) return hit;
    }
    const b = buildListSql(SEL, q, std.enabled ? std.tariff.tiers[0].paisePerMin : undefined);
    const rows = (await env.DB_META.prepare(b.sql).bind(...b.binds).all<LiveRow>()).results ?? [];
    const total = Number((await env.DB_META.prepare(b.countSql).bind(...b.countBinds).first<{ c: number }>())?.c ?? 0);
    const aggs = await hostAggregates(env, rows.map((r) => r.uid));
    const lines = await lineFieldsForUids(env, rows.map((r) => r.uid)); // [HF-CALL-MODES-A] null while hfCallModesEnabled is off
    const items = rows.map((r) => card(env, r, aggs.get(r.uid), std, lines?.get(r.uid)));
    const end = q.offset + items.length;
    const body = { items, nextOffset: items.length > 0 && end < total ? end : null, total };
    if (!cacheable || !key) return json(body, 200, NO_STORE);
    const res = json(body, 200, { "cache-control": `public, max-age=${LIST_TTL_S}` });
    const put = caches.default.put(key, res.clone()).catch(() => undefined);
    if (ctx) ctx.waitUntil(put); else await put;
    return res;
  } catch (e) {
    await trackException(env, e, { route: p, method: "GET", handled: true, app_name: BRAND.slug, extra: { area: "hf_hosts_list" } });
    return err(500, "internal_error");
  }
}
