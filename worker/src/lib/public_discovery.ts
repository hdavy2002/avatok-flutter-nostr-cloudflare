// [WEB-SEO-AUTO-1] Anonymous discovery authority. These SQL expressions are
// shared by listing/creator feeds, counts and detail projections; direct-link
// access is a separate approval/publication check in getListing.
import { notEndedSql } from "./listing_schedule";

export type DiscoveryReason = "example" | "hidden" | "ended" | "cancelled" | "expired";
export type PublicDiscovery = { indexable: boolean; reason?: DiscoveryReason; updated_at?: number };

/** Internal 'unpublished' is deliberately never exposed as a public reason. */
export function publicDiscoveryReasonSql(alias: string, nowRef: string): string {
  const expires = `(CASE WHEN ${alias}.expires_at < 100000000000 THEN ${alias}.expires_at * 1000 ELSE ${alias}.expires_at END)`;
  return `(CASE
    WHEN ${alias}.status='completed' THEN 'ended'
    WHEN ${alias}.status='cancelled' THEN 'cancelled'
    WHEN ${alias}.status NOT IN ('published','live') OR ${alias}.status IS NULL THEN 'unpublished'
    WHEN COALESCE(${alias}.is_example,0)<>0 THEN 'example'
    WHEN (CASE WHEN ${alias}.attrs IS NULL OR json_valid(${alias}.attrs)=0 THEN 0
      ELSE COALESCE(json_extract(${alias}.attrs,'$.hide_from_marketplace'),0)<>0 END) THEN 'hidden'
    WHEN ${alias}.expires_at > 0 AND ${expires} <= ${nowRef} THEN 'expired'
    WHEN NOT (${notEndedSql(alias, nowRef)}) THEN 'ended'
    ELSE NULL END)`;
}

export function publicListingEligibilitySql(alias: string, nowRef: string): string {
  return `${publicDiscoveryReasonSql(alias, nowRef)} IS NULL`;
}

/** Do not leak attrs, moderation state, or invalid timestamps to anonymous readers. */
export function publicDiscoveryProjection(row: { reason: unknown; updated_at?: unknown }): PublicDiscovery {
  const result: PublicDiscovery = { indexable: row.reason === null };
  if (["example", "hidden", "ended", "cancelled", "expired"].includes(String(row.reason))) {
    result.reason = row.reason as DiscoveryReason;
  }
  const timestamp = Number(row.updated_at);
  const ms = timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
  if (Number.isSafeInteger(ms) && ms > 0 && ms <= 8_640_000_000_000_000) result.updated_at = ms;
  return result;
}

export const SITEMAP_PAGE_SIZE = 10_000;
export const SITEMAP_MAX_PAGE = 50_000;
export type SitemapPage = { page: number; page_size: number; offset: number };

/** Strict bounded input: no negatives, fractions, exponent syntax or huge offsets. */
export function sitemapPage(req?: Request): SitemapPage | null {
  const params = req ? new URL(req.url).searchParams : new URLSearchParams();
  const bounded = (key: string, fallback: number, max: number): number | null => {
    const values = params.getAll(key);
    if (!values.length) return fallback;
    if (values.length !== 1 || !/^[1-9]\d{0,4}$/.test(values[0])) return null;
    const value = Number(values[0]);
    return value <= max ? value : null;
  };
  const page = bounded("page", 1, SITEMAP_MAX_PAGE);
  const page_size = bounded("page_size", SITEMAP_PAGE_SIZE, SITEMAP_PAGE_SIZE);
  return page === null || page_size === null ? null : { page, page_size, offset: (page - 1) * page_size };
}
