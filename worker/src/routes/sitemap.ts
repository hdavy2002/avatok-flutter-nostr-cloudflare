// [WEB-SEO-3 2026-09-10] Dynamic sitemap feeds for user listings and creators.
//
// The static hand-rolled web/src/pages/sitemap-pages.xml.ts (see its header)
// only covers fixed marketing routes — it explicitly cannot enumerate
// per-listing (/l/[id]) or per-creator (/c/[handle]) pages because those are
// generated at request time. These two endpoints are that "second sitemap fed
// by the Worker's listings API" its header comment calls for.
//
// PUBLIC predicate mirrors exploreBrowse (routes/listings.ts ~line 3370):
// status IN ('published','live') and not expired. No auth, no per-user data.
//
// Both routes are wrapped in cached(..., 3600) at the index.ts call site, so
// this file itself does no caching — it just answers the query.
import type { Env } from "../types";
import { json } from "../util";
import { metaDb } from "../db/shard";
import { notEndedSql } from "../lib/listing_schedule";

const MAX_ROWS = 45000;

// GET /api/sitemap/listings — public listings for the listings sitemap.
export async function sitemapListings(env: Env): Promise<Response> {
  const rs = await metaDb(env).prepare(
    `SELECT l.id, u.handle AS handle, l.slug, l.updated_at
       FROM listings l LEFT JOIN users u ON u.uid = l.creator_id
      WHERE l.status IN ('published','live')
        AND (l.expires_at IS NULL OR l.expires_at > ?1)
        AND ${notEndedSql("l", "?1")} -- [LISTING-EXPIRY-1] no ended shows in the sitemap
      ORDER BY l.updated_at DESC
      LIMIT ?2`,
  ).bind(Date.now(), MAX_ROWS).all<any>();
  const listings = (rs.results ?? []).map((r) => ({
    id: String(r.id),
    handle: r.handle ?? null,
    slug: r.slug ?? null,
    updated_at: Number(r.updated_at ?? 0),
  }));
  return json({ listings });
}

// GET /api/sitemap/creators — distinct creator handles with >=1 public listing.
export async function sitemapCreators(env: Env): Promise<Response> {
  const rs = await metaDb(env).prepare(
    `SELECT u.handle AS handle, MAX(l.updated_at) AS updated_at
       FROM listings l JOIN users u ON u.uid = l.creator_id
      WHERE l.status IN ('published','live')
        AND (l.expires_at IS NULL OR l.expires_at > ?1)
        AND ${notEndedSql("l", "?1")}
        AND u.handle IS NOT NULL
      GROUP BY u.handle
      ORDER BY updated_at DESC
      LIMIT ?2`,
  ).bind(Date.now(), MAX_ROWS).all<any>();
  const creators = (rs.results ?? []).map((r) => ({
    handle: String(r.handle),
    updated_at: Number(r.updated_at ?? 0),
  }));
  return json({ creators });
}
