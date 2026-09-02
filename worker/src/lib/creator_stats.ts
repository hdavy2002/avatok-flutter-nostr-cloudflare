// [LIST-STATS-1] Derived, cached per-creator trust-ladder stats. Backs
// Specs/SPEC-2026-09-02-LISTING-TRUST-AND-VIBE.md §1 rows 2-4 ("has he done
// this before", "does he show up", "do people come back") and the badges in
// §5. Schema landed dark by worker/migrations/2026-09-02-creator-stats.sql
// (creator_stats table — read it, do not edit it from here).
//
// Cards and pages READ the cached `creator_stats` row; nothing in the
// request path computes these numbers live. This file owns the two ways the
// row gets filled: an on-write refresh right after a commercial session
// settles/ends (recordCommercialStreamEvent in commercial_stream_sessions.ts)
// and a cron sweep for rows that have gone stale (index.ts scheduled()).
//
// Every query here is wrapped so ONE missing/lagging table (staging can be
// behind prod on migrations) fails soft — never throws into the caller. The
// worker-wide fail-soft idiom used elsewhere in this file's neighbourhood is
// `console.warn("<thing> skipped:", String(e))` (see routes/stream.ts,
// money_engine.ts) — reused here rather than inventing a new log shape.

import type { Env } from "../types";
import { metaDb } from "../db/shard";

const FIVE_MIN_MS = 5 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000; // 6h — matches the cron contract below.

export interface CreatorStats {
  creator_id: string;
  shows_hosted: number;
  hours_live: number;
  on_time_pct: number | null;
  cancel_rate: number | null;
  comeback_pct: number | null;
  avg_response_min: number | null;
  sessions_done: number;
  sold_out_count: number;
  first_session_at: number | null;
  last_session_at: number | null;
  updated_at: number;
}

function emptyStats(creatorId: string): CreatorStats {
  return {
    creator_id: creatorId,
    shows_hosted: 0,
    hours_live: 0,
    on_time_pct: null,
    cancel_rate: null,
    comeback_pct: null,
    avg_response_min: null,
    sessions_done: 0,
    sold_out_count: 0,
    first_session_at: null,
    last_session_at: null,
    updated_at: Date.now(),
  };
}

/** One query, wrapped, returning `fallback` instead of throwing. Every stat
 * below goes through this so a single absent table/column on a lagging
 * environment degrades that one field to null/0 rather than killing the
 * whole refresh. */
async function safeFirst<T>(
  env: Env,
  label: string,
  sql: string,
  binds: unknown[],
  fallback: T,
): Promise<T> {
  try {
    const row = await metaDb(env).prepare(sql).bind(...binds).first<T>();
    return row ?? fallback;
  } catch (e) {
    console.warn(`creator_stats ${label} skipped:`, String(e));
    return fallback;
  }
}

/**
 * computeCreatorStats — derives every field from the real commercial/listing
 * tables. Source per field:
 *
 *  - shows_hosted:      commercial_sessions WHERE creator_id=? AND kind='live_event'
 *                        AND live_started_at IS NOT NULL (a show that actually
 *                        started, not merely scheduled).
 *  - hours_live:        SUM(ended_at - live_started_at) over the same rows,
 *                        i.e. commercial_sessions.{live_started_at,ended_at}
 *                        for kind='live_event', converted ms -> hours.
 *  - on_time_pct:       commercial_sessions.{scheduled_at,live_started_at} for
 *                        creator_id=? (both kinds — "does he show up" isn't
 *                        live-only). scheduled_at is the authority-recorded
 *                        listing/booking start time (set at session creation
 *                        from listings.starts_at or bookings.starts_at — see
 *                        createProviderCall in commercial_stream_sessions.ts),
 *                        so no join to listings/bookings is needed.
 *                        pct = COUNT(live_started_at - scheduled_at <= 5min)
 *                              / COUNT(live_started_at IS NOT NULL).
 *                        null when the denominator is 0 (no shows yet).
 *  - cancel_rate:       listings WHERE creator_id=?: COUNT(status='cancelled')
 *                        / COUNT(status != 'draft') (a listing only "counts"
 *                        once it left draft). null when denominator is 0.
 *  - comeback_pct:      commercial_entitlements WHERE role='buyer' AND
 *                        state='consumed', joined to listings for creator_id,
 *                        grouped by account_id: (# buyers with >=2 consumed
 *                        entitlements) / (# buyers with >=1). null when there
 *                        are no buyers yet.
 *  - avg_response_min:  listing_questions WHERE creator_id=? AND answered_at
 *                        IS NOT NULL: AVG(answered_at - created_at) in
 *                        minutes. null when no question has been answered —
 *                        "no data" must never render as "0 min".
 *  - sessions_done:     commercial_sessions WHERE creator_id=? AND
 *                        state='ended' (both kinds — "consumed 1:1 consults +
 *                        live shows" that actually happened).
 *  - sold_out_count:    listings WHERE creator_id=? AND capacity IS NOT NULL
 *                        AND joined_count >= capacity. `listings` has no
 *                        separate seats_taken column — joined_count is the
 *                        seats-taken counter (see migrations/listings.sql).
 *  - first_session_at / last_session_at: MIN/MAX(live_started_at) over
 *                        commercial_sessions WHERE creator_id=? AND
 *                        live_started_at IS NOT NULL.
 *
 * TODO(stats): none of the fields above are skipped — every column the spec
 * asks for (§4.2) exists in the tables landed so far. If a future column is
 * missing on a given environment, safeFirst() degrades that one field to
 * null/0 rather than failing the whole refresh.
 */
export async function computeCreatorStats(env: Env, creatorId: string): Promise<CreatorStats> {
  const shows = await safeFirst<{ n: number; hours: number | null; first_at: number | null; last_at: number | null }>(
    env,
    "shows_hosted/hours_live/first_last",
    `SELECT COUNT(*) n,
            SUM(CASE WHEN ended_at IS NOT NULL THEN (ended_at - live_started_at) ELSE 0 END) hours,
            MIN(live_started_at) first_at,
            MAX(live_started_at) last_at
       FROM commercial_sessions
      WHERE creator_id=?1 AND kind='live_event' AND live_started_at IS NOT NULL`,
    [creatorId],
    { n: 0, hours: 0, first_at: null, last_at: null },
  );

  const onTime = await safeFirst<{ started: number; on_time: number }>(
    env,
    "on_time_pct",
    `SELECT
        COUNT(*) started,
        SUM(CASE WHEN (live_started_at - scheduled_at) <= ?2 THEN 1 ELSE 0 END) on_time
       FROM commercial_sessions
      WHERE creator_id=?1 AND live_started_at IS NOT NULL`,
    [creatorId, FIVE_MIN_MS],
    { started: 0, on_time: 0 },
  );

  const cancel = await safeFirst<{ total: number; cancelled: number }>(
    env,
    "cancel_rate",
    `SELECT
        COUNT(*) total,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled
       FROM listings
      WHERE creator_id=?1 AND status != 'draft'`,
    [creatorId],
    { total: 0, cancelled: 0 },
  );

  // Buyers with >=1 / >=2 consumed entitlements across this creator's
  // listings. entitlements don't carry creator_id directly — join listings.
  const comeback = await safeFirst<{ buyers_1plus: number; buyers_2plus: number }>(
    env,
    "comeback_pct",
    `SELECT COUNT(*) buyers_1plus,
            SUM(CASE WHEN cnt >= 2 THEN 1 ELSE 0 END) buyers_2plus
       FROM (
         SELECT ce.account_id account_id, COUNT(*) cnt
           FROM commercial_entitlements ce
           JOIN listings l ON l.id = ce.listing_id
          WHERE l.creator_id=?1 AND ce.role='buyer' AND ce.state='consumed'
          GROUP BY ce.account_id
       )`,
    [creatorId],
    { buyers_1plus: 0, buyers_2plus: 0 },
  );

  const response = await safeFirst<{ avg_min: number | null }>(
    env,
    "avg_response_min",
    `SELECT AVG((answered_at - created_at) / 60000.0) avg_min
       FROM listing_questions
      WHERE creator_id=?1 AND answered_at IS NOT NULL`,
    [creatorId],
    { avg_min: null },
  );

  const sessionsDone = await safeFirst<{ n: number }>(
    env,
    "sessions_done",
    `SELECT COUNT(*) n FROM commercial_sessions WHERE creator_id=?1 AND state='ended'`,
    [creatorId],
    { n: 0 },
  );

  const soldOut = await safeFirst<{ n: number }>(
    env,
    "sold_out_count",
    `SELECT COUNT(*) n FROM listings
      WHERE creator_id=?1 AND capacity IS NOT NULL AND joined_count >= capacity`,
    [creatorId],
    { n: 0 },
  );

  const stats = emptyStats(creatorId);
  stats.shows_hosted = Number(shows.n ?? 0);
  stats.hours_live = Math.round(((Number(shows.hours ?? 0)) / 3_600_000) * 100) / 100;
  stats.on_time_pct = onTime.started > 0 ? Math.round((onTime.on_time / onTime.started) * 10000) / 100 : null;
  stats.cancel_rate = cancel.total > 0 ? Math.round((cancel.cancelled / cancel.total) * 10000) / 100 : null;
  stats.comeback_pct = comeback.buyers_1plus > 0
    ? Math.round((comeback.buyers_2plus / comeback.buyers_1plus) * 10000) / 100
    : null;
  stats.avg_response_min = response.avg_min != null ? Math.round(Number(response.avg_min)) : null;
  stats.sessions_done = Number(sessionsDone.n ?? 0);
  stats.sold_out_count = Number(soldOut.n ?? 0);
  stats.first_session_at = shows.first_at != null ? Number(shows.first_at) : null;
  stats.last_session_at = shows.last_at != null ? Number(shows.last_at) : null;
  stats.updated_at = Date.now();
  return stats;
}

/** Recompute one creator's row and upsert it. Called fire-and-forget right
 * after a commercial session lands in a terminal state (see the hook in
 * commercial_stream_sessions.ts) — never awaited on the webhook/settlement
 * hot path, and never throws. */
export async function refreshCreatorStats(env: Env, creatorId: string): Promise<void> {
  if (!creatorId) return;
  try {
    const s = await computeCreatorStats(env, creatorId);
    await metaDb(env).prepare(
      `INSERT INTO creator_stats
         (creator_id, shows_hosted, hours_live, on_time_pct, cancel_rate, comeback_pct,
          avg_response_min, sessions_done, sold_out_count, first_session_at, last_session_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
       ON CONFLICT(creator_id) DO UPDATE SET
         shows_hosted=?2, hours_live=?3, on_time_pct=?4, cancel_rate=?5, comeback_pct=?6,
         avg_response_min=?7, sessions_done=?8, sold_out_count=?9,
         first_session_at=?10, last_session_at=?11, updated_at=?12`,
    ).bind(
      s.creator_id, s.shows_hosted, s.hours_live, s.on_time_pct, s.cancel_rate, s.comeback_pct,
      s.avg_response_min, s.sessions_done, s.sold_out_count, s.first_session_at, s.last_session_at, s.updated_at,
    ).run();
  } catch (e) {
    console.warn("refreshCreatorStats skipped:", String(e));
  }
}

/**
 * refreshStaleCreatorStats — cron sweep (wired into index.ts scheduled()).
 * Refreshes rows whose creator has had commercial activity more recently
 * than their cached updated_at, or whose row is simply older than STALE_MS,
 * bounded to `batch` creators per tick so a big backlog can't blow the cron
 * budget. Fails soft: an empty/missing table returns { scanned: 0 } rather
 * than throwing.
 */
export async function refreshStaleCreatorStats(
  env: Env,
  batch = 50,
): Promise<{ scanned: number; refreshed: number }> {
  const safeBatch = Math.max(1, Math.min(200, Math.trunc(batch)));
  const cutoff = Date.now() - STALE_MS;
  let creatorIds: string[] = [];
  try {
    // Any creator with commercial activity but no row, or a row older than
    // the staleness window. UNION so a brand-new creator (no creator_stats
    // row yet) is picked up on the very first tick after their first session.
    const rows = await metaDb(env).prepare(
      `SELECT creator_id FROM (
         SELECT DISTINCT cs.creator_id creator_id
           FROM commercial_sessions cs
           LEFT JOIN creator_stats st ON st.creator_id = cs.creator_id
          WHERE st.creator_id IS NULL OR st.updated_at < ?1
       )
       LIMIT ?2`,
    ).bind(cutoff, safeBatch).all<{ creator_id: string }>();
    creatorIds = (rows.results ?? []).map((r) => r.creator_id).filter(Boolean);
  } catch (e) {
    console.warn("refreshStaleCreatorStats scan skipped:", String(e));
    return { scanned: 0, refreshed: 0 };
  }
  let refreshed = 0;
  for (const id of creatorIds) {
    try {
      await refreshCreatorStats(env, id);
      refreshed += 1;
    } catch (e) {
      console.warn("refreshStaleCreatorStats item skipped:", String(e));
    }
  }
  return { scanned: creatorIds.length, refreshed };
}

// ---------------------------------------------------------------------------
// Badges — §5. Pure function: no DB access, so it's trivially testable and
// reusable from both the worker (card/page payloads) and any future admin
// tooling. `reviewSummary` is the same shape reviews.ts already returns
// (verified_count + rating average) — pass whatever the caller already has;
// this never re-queries.

export interface ReviewSummaryForBadges {
  /** Count of reviews with verified_attendee=1 for this creator (sum across
   * their listings, or a single listing's verified_count — caller's choice
   * of scope; the badge rule in §5 just says "verified reviews"). */
  verifiedCount: number;
  /** Average rating over the same population as verifiedCount. Null when
   * there is nothing to average (avoids a fake 5.0 per §4.6). */
  avgRating: number | null;
}

export type BadgeId =
  | "pehla_show"
  | "pakka_host"
  | "wapsi"
  | "bawaal"
  | "seedhi_baat"
  | "jaldi_jawab";

export const BADGE_COPY: Record<BadgeId, { label: string; hint: string }> = {
  pehla_show: {
    label: "PEHLA SHOW",
    hint: "Pehli baar host kar raha/rahi hai — jald hi regulars milenge.",
  },
  pakka_host: {
    label: "PAKKA HOST",
    hint: "10+ shows, 95%+ time pe live gaya — ye bandeya time ka pakka hai.",
  },
  wapsi: {
    label: "WAPSI KING/QUEEN",
    hint: "80%+ log wapas aate hain — content itna acha ki dobara ticket lete hain.",
  },
  bawaal: {
    label: "BAWAAL",
    hint: "3+ shows sold out — bawaal macha diya isne.",
  },
  seedhi_baat: {
    label: "SEEDHI BAAT",
    hint: "50+ verified reviews, 4.7★ se upar — jo bola so kiya.",
  },
  jaldi_jawab: {
    label: "JALDI JAWAB",
    hint: "Sawaal poocho, 15 min ke andar jawab — jaldi jawab, pakka jawab.",
  },
};

/**
 * badgesFor — pure, returns the ids that are earned right now. Rules straight
 * from §5:
 *   pehla_show   : shows_hosted === 0 (or stats not computed yet, i.e. null)
 *   pakka_host   : on_time_pct >= 95 && shows_hosted >= 10
 *   wapsi        : comeback_pct >= 80 && buyers >= 20
 *   bawaal       : sold_out_count >= 3
 *   seedhi_baat  : verified reviews >= 50 && avg >= 4.7
 *   jaldi_jawab  : avg_response_min != null && <= 15
 *
 * `buyers` (for the wapsi >=20 gate) isn't a creator_stats column — the spec
 * rule is `comeback_pct>=80 && buyers>=20`, so pass `opts.buyers1plus`
 * (comeback.buyers_1plus from computeCreatorStats, or wherever the caller
 * already has the buyer count) whenever it's available. It is intentionally
 * NOT required: this function has no DB access of its own, so a caller that
 * only has `stats` (e.g. a cached creator_stats row with no buyer count
 * alongside it) still gets a badgesFor() call rather than none — but that
 * caller MUST supply buyers1plus before this badge reaches production,
 * since the >=20 gate exists specifically to stop wapsi firing on 2 buyers
 * who both rebooked.
 */
export function badgesFor(
  stats: Pick<CreatorStats, "shows_hosted" | "on_time_pct" | "comeback_pct" | "sold_out_count" | "avg_response_min"> | null,
  reviewSummary: ReviewSummaryForBadges | null,
  opts?: { buyers1plus?: number },
): BadgeId[] {
  const badges: BadgeId[] = [];
  const showsHosted = stats?.shows_hosted ?? null;
  if (showsHosted === 0 || showsHosted === null) badges.push("pehla_show");

  if (
    stats
    && stats.on_time_pct != null
    && stats.on_time_pct >= 95
    && stats.shows_hosted >= 10
  ) badges.push("pakka_host");

  const buyers = opts?.buyers1plus;
  if (
    stats
    && stats.comeback_pct != null
    && stats.comeback_pct >= 80
    && (buyers === undefined || buyers >= 20)
  ) badges.push("wapsi");

  if (stats && stats.sold_out_count >= 3) badges.push("bawaal");

  if (
    reviewSummary
    && reviewSummary.verifiedCount >= 50
    && reviewSummary.avgRating != null
    && reviewSummary.avgRating >= 4.7
  ) badges.push("seedhi_baat");

  if (
    stats
    && stats.avg_response_min != null
    && stats.avg_response_min <= 15
  ) badges.push("jaldi_jawab");

  return badges;
}
