// [WEB-SEO-AUTO-1] Public sitemap feeds. Unpaginated callers receive page one.
// The dispatch layer caches each query URL. Database failures propagate rather
// than publishing a successful empty sitemap that could remove indexed URLs.
import type { Env } from "../types";
import { json } from "../util";
import { metaDb } from "../db/shard";
import { publicListingEligibilitySql, publicDiscoveryProjection, sitemapPage } from "../lib/public_discovery";

const ELIGIBLE = publicListingEligibilitySql("l", "?1");
const CREATOR_HANDLE = "u.handle IS NOT NULL AND TRIM(u.handle)<>''";
const invalidPage = () => json({ error: "invalid_sitemap_page" }, 400);

// GET /api/sitemap/listings?page=1&page_size=10000
export async function sitemapListings(env: Env, req?: Request): Promise<Response> {
  const paging = sitemapPage(req);
  if (!paging) return invalidPage();
  const rs = await metaDb(env).prepare(
    `SELECT l.id, l.title, u.handle AS handle, l.slug, l.updated_at
       FROM listings l LEFT JOIN users u ON u.uid = l.creator_id
      WHERE ${ELIGIBLE}
      ORDER BY l.id ASC
      LIMIT ?2 OFFSET ?3`,
  ).bind(Date.now(), paging.page_size + 1, paging.offset).all<any>();
  if (rs.success === false || !Array.isArray(rs.results)) throw new Error("sitemap_listings_unavailable");
  const listings = rs.results.slice(0, paging.page_size).map((r) => ({
    id: String(r.id),
    title: String(r.title || 'Public ritual'),
    handle: r.handle ?? null,
    slug: r.slug ?? null,
    updated_at: publicDiscoveryProjection({ reason: null, updated_at: r.updated_at }).updated_at,
  }));
  return json({ listings, page: paging.page, page_size: paging.page_size, has_more: rs.results.length > paging.page_size });
}

// GET /api/sitemap/creators?page=1&page_size=10000
export async function sitemapCreators(env: Env, req?: Request): Promise<Response> {
  const paging = sitemapPage(req);
  if (!paging) return invalidPage();
  const rs = await metaDb(env).prepare(
    `SELECT u.handle AS handle, MAX(l.updated_at) AS updated_at
       FROM listings l JOIN users u ON u.uid = l.creator_id
      WHERE ${ELIGIBLE} AND ${CREATOR_HANDLE}
      GROUP BY u.handle
      ORDER BY u.handle ASC
      LIMIT ?2 OFFSET ?3`,
  ).bind(Date.now(), paging.page_size + 1, paging.offset).all<any>();
  if (rs.success === false || !Array.isArray(rs.results)) throw new Error("sitemap_creators_unavailable");
  const creators = rs.results.slice(0, paging.page_size).map((r) => ({
    handle: String(r.handle),
    updated_at: publicDiscoveryProjection({ reason: null, updated_at: r.updated_at }).updated_at,
  }));
  return json({ creators, page: paging.page, page_size: paging.page_size, has_more: rs.results.length > paging.page_size });
}

// GET /api/sitemap/manifest?page_size=10000 — only counts, never a capped URL list.
export async function sitemapManifest(env: Env, req?: Request): Promise<Response> {
  const paging = sitemapPage(req);
  if (!paging) return invalidPage();
  const counts = await metaDb(env).prepare(
    `SELECT COUNT(*) AS listings, COUNT(DISTINCT CASE WHEN ${CREATOR_HANDLE} THEN u.handle END) AS creators
       FROM listings l LEFT JOIN users u ON u.uid=l.creator_id
      WHERE ${ELIGIBLE}`,
  ).bind(Date.now()).first<{ listings: number; creators: number }>();
  if (!counts || !Number.isSafeInteger(counts.listings) || !Number.isSafeInteger(counts.creators)) {
    throw new Error("sitemap_manifest_unavailable");
  }
  return json({
    page_size: paging.page_size,
    listings: { count: counts.listings, pages: Math.ceil(counts.listings / paging.page_size) },
    creators: { count: counts.creators, pages: Math.ceil(counts.creators / paging.page_size) },
  });
}
