// [HF-NATIVE-S2/S3] Native-app host list + options. The web's GET /api/hosts/public is untouched (bare array, web depends on it).
//   GET /api/hf/hosts?topic=a,b&lang=hi,en&minPrice=&maxPrice=&online=1&lane=women|lgbtq&sort=online_first|price_low|rating&limit=24&offset=
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

const LIST_TTL_S = 45;
const err = (status: number, error: string) => json({ error }, status);
const NO_STORE = { "cache-control": "private, no-store" };

export async function hfHostsListRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (req.method !== "GET" || !(p === "/api/hf/hosts" || p === "/api/hf/options")) return null;
  if (p === "/api/hf/options") return json(buildHfOptions(), 200, { "cache-control": "public, max-age=3600" });
  try {
    if ((await readConfig(env)).hostsPublicEnabled !== true) return err(404, "not_enabled");
    const parsed = parseHostList(url.searchParams);
    if (!parsed.ok) return err(parsed.status, parsed.error);
    const q = parsed.q;
    const authed = req.headers.has("authorization");
    if (q.lane) {
      const u = await requireUser(req, env);
      if (isFail(u)) return err(u.status, u.error);
      if (!(await getLaneAccess(env, u.uid))[q.lane]) return err(403, "lane_required");
    }
    // Edge cache: anonymous, non-lane only. Key is the validated, canonically ordered query, so junk params cannot fragment it.
    const cacheable = !q.lane && !authed && typeof caches !== "undefined";
    const key = cacheable ? new Request(`https://hf-hosts.cache.invalid/api/hf/hosts?${listCacheKey(q)}`) : null;
    if (cacheable && key) {
      const hit = await caches.default.match(key).catch(() => undefined);
      if (hit) return hit;
    }
    const b = buildListSql(SEL, q);
    const rows = (await env.DB_META.prepare(b.sql).bind(...b.binds).all<LiveRow>()).results ?? [];
    const total = Number((await env.DB_META.prepare(b.countSql).bind(...b.countBinds).first<{ c: number }>())?.c ?? 0);
    const aggs = await hostAggregates(env, rows.map((r) => r.uid));
    const items = rows.map((r) => card(env, r, aggs.get(r.uid)));
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
