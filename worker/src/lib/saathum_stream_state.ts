// [SAATHUM-WATCH-1 2026-09-28] The ONE definition of a Saa Thum event's
// live-stream state, shared by:
//   - GET /api/saathum/live-state/:listingId (routes/saathum_checkout.ts)
//   - GET /api/saathum/watch/:listingId (adds stream_state to the response)
//   - the explore/marketplace feed's per-card is_live_stream flag
//     (routes/listings.ts shapeCard)
//   - notifySaathumLateBuyerIfLive (routes/saathum_checkout.ts) — an ended
//     stream must never message a late buyer a dead link.
//
// STATE RULES (owner decision 2026-09-28):
//   none  — no event_videos row for this listing, OR a row exists but the
//           live window hasn't opened yet (see EARLY_WINDOW_MS below).
//   live  — a row exists, it is not ended, and now >= starts_at - 15min.
//           A listing with no starts_at (should not happen for a live_event,
//           but never trust that) is treated as live the moment the link is
//           saved, since there is no clock to gate on.
//   ended — ended_at is set, OR the listing is completed/cancelled, OR the
//           clock fallback: now > starts_at + duration_min + 60min grace.
import type { Env } from "../types";
import { track, trackException } from "../hooks";

export type SaathumStreamState = "none" | "live" | "ended";

const EARLY_WINDOW_MS = 15 * 60 * 1000; // link saved early never shows LIVE ahead of time
const CLOCK_GRACE_MS = 60 * 60 * 1000; // owner's "grace" fallback when nobody flips it to ended

export interface StreamStateInput {
  hasVideo: boolean;
  endedAt: number | null;
  listingStatus: string | null | undefined;
  startsAt: number | null | undefined;
  durationMin: number | null | undefined;
  now: number;
}

export function computeStreamState(input: StreamStateInput): SaathumStreamState {
  const { hasVideo, endedAt, listingStatus, startsAt, durationMin, now } = input;
  if (!hasVideo) return "none";
  if (endedAt != null) return "ended";
  if (listingStatus === "completed" || listingStatus === "cancelled") return "ended";
  if (startsAt != null) {
    const clockEndsAt = startsAt + Math.max(0, Number(durationMin ?? 0)) * 60_000 + CLOCK_GRACE_MS;
    if (now > clockEndsAt) return "ended";
    if (now >= startsAt - EARLY_WINDOW_MS) return "live";
    return "none"; // saved early — not live yet, not ended
  }
  return "live"; // no starts_at to gate on; a saved link is live until ended
}

interface EventVideoRow {
  youtube_video_id: string;
  source_url: string | null;
  ended_at: number | null;
}
interface ListingTimingRow {
  status: string | null;
  starts_at: number | null;
  duration_min: number | null;
}

/** Single-listing lookup, used by the public live-state endpoint, the watch
 *  endpoint, and the late-buyer notify check. One extra D1 round trip beyond
 *  what each caller already does — acceptable for a per-request read. */
export async function streamStateForListing(
  env: Env, listingId: string,
): Promise<{ state: SaathumStreamState; endedAt: number | null; video: EventVideoRow | null }> {
  const db = env.DB_META;
  const [listing, video] = await Promise.all([
    db.prepare(`SELECT status, starts_at, duration_min FROM listings WHERE id=?1`).bind(listingId)
      .first<ListingTimingRow>().catch(() => null),
    db.prepare(`SELECT youtube_video_id, source_url, ended_at FROM event_videos WHERE listing_id=?1`).bind(listingId)
      .first<EventVideoRow>().catch(() => null),
  ]);
  const state = computeStreamState({
    hasVideo: !!video,
    endedAt: video?.ended_at ?? null,
    listingStatus: listing?.status ?? null,
    startsAt: listing?.starts_at ?? null,
    durationMin: listing?.duration_min ?? null,
    now: Date.now(),
  });
  return { state, endedAt: video?.ended_at ?? null, video: video ?? null };
}

/**
 * Batched lookup for the explore/marketplace feed (routes/listings.ts
 * shapeCard) — ONE IN-query for a whole page of card ids, matching the shape
 * of cardStatsFor/promosForCards in that file. `listingTiming` is supplied by
 * the caller (already has status/starts_at/duration_min on the CARD_SELECT
 * row) so this never re-reads the listings table.
 */
export async function eventVideoRowsFor(env: Env, ids: string[]): Promise<Map<string, EventVideoRow>> {
  const map = new Map<string, EventVideoRow>();
  if (!ids.length) return map;
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
  try {
    const rs = await env.DB_META.prepare(
      `SELECT listing_id, youtube_video_id, source_url, ended_at FROM event_videos WHERE listing_id IN (${placeholders})`,
    ).bind(...ids).all<EventVideoRow & { listing_id: string }>();
    for (const r of (rs.results ?? [])) map.set(String(r.listing_id), r);
  } catch { /* fails soft — cards simply omit is_live_stream, like cardStatsFor */ }
  return map;
}

export function isLiveStreamCard(
  video: EventVideoRow | undefined, listingStatus: string | null | undefined,
  startsAt: number | null | undefined, durationMin: number | null | undefined,
): boolean {
  return computeStreamState({
    hasVideo: !!video,
    endedAt: video?.ended_at ?? null,
    listingStatus, startsAt, durationMin,
    now: Date.now(),
  }) === "live";
}

const APP = "saathum";

/**
 * [SAATHUM-WATCH-1] Cron sweep (index.ts scheduled(), every 5 min), two passes:
 *   1. Asks YouTube whether a saved-but-not-yet-ended live stream has actually
 *      ended (liveStreamingDetails.actualEndTime), for listings that started
 *      within the last 24h. Batches up to 50 video ids per call (YouTube's
 *      limit). Skipped quietly (one `track`, never an exception) when
 *      YOUTUBE_API_KEY is unset.
 *   2. ALWAYS runs regardless of (1): persists ended_at for any video whose
 *      scheduled window + grace has passed but pass (1) hasn't (yet, or ever,
 *      without an API key) confirmed via YouTube — the same clock rule
 *      computeStreamState() already uses at read time, just written down here
 *      so admin archive / user past-events / tiles and the
 *      saathum_stream_ended_archived telemetry all get one definite moment.
 * Each pass emits saathum_stream_ended_archived {listing_id, via} exactly once
 * per listing, because both UPDATEs are guarded by `ended_at IS NULL`.
 */
export async function checkSaathumStreamEnds(env: Env): Promise<{ checked: number; ended: number; api: "ok" | "skipped" | "error" }> {
  const apiKey = (env.YOUTUBE_API_KEY ?? "").trim();
  const db = env.DB_META;
  const now = Date.now();
  let rows: { listing_id: string; youtube_video_id: string }[] = [];
  let ended = 0;
  let apiOutcome: "ok" | "skipped" | "error" = apiKey ? "ok" : "skipped";
  // [SAATHUM-WATCH-1 2026-09-28] The YouTube API pass and the clock-fallback pass below
  // both run every time — no early return — so a missing API key, or no listing due for
  // an API check right now, never stops old streams from still getting archived by clock.
  if (apiKey) {
    const dayAgo = now - 24 * 60 * 60 * 1000;
    try {
      const rs = await db.prepare(
        `SELECT v.listing_id AS listing_id, v.youtube_video_id AS youtube_video_id
           FROM event_videos v JOIN listings l ON l.id = v.listing_id
          WHERE v.ended_at IS NULL AND l.starts_at IS NOT NULL AND l.starts_at >= ?1
            AND l.starts_at - ?2 <= ?3
          LIMIT 500`,
      // [SAATHUM-LIVE-ENDED-RESET-1 2026-09-29] Only ask YouTube about events whose live
      // window has OPENED. A future event's link (e.g. a test video, or last week's
      // stream pasted early) already has an actualEndTime, and this pass archived it
      // weeks ahead of the show.
      ).bind(dayAgo, EARLY_WINDOW_MS, now).all<{ listing_id: string; youtube_video_id: string }>();
      rows = rs.results ?? [];
    } catch (err) {
      await trackException(env, err, { route: "checkSaathumStreamEnds:query", handled: true, app_name: APP });
      apiOutcome = "error";
      rows = [];
    }
  }
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const idParam = batch.map((b) => b.youtube_video_id).join(",");
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(idParam)}&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url);
      if (!res.ok) { apiOutcome = "error"; continue; }
      const data = await res.json() as { items?: { id: string; liveStreamingDetails?: { actualEndTime?: string } }[] };
      const endedIds = new Set(
        (data.items ?? [])
          .filter((it) => !!it.liveStreamingDetails?.actualEndTime)
          .map((it) => it.id),
      );
      for (const b of batch) {
        if (!endedIds.has(b.youtube_video_id)) continue;
        await db.prepare(`UPDATE event_videos SET ended_at=?2 WHERE listing_id=?1 AND ended_at IS NULL`)
          .bind(b.listing_id, now).run().catch(() => {});
        ended++;
        // [SAATHUM-WATCH-1 2026-09-28] Fires once: the WHERE above only ever matches a
        // listing while its ended_at is still NULL, so a later cron pass can't re-fire this.
        void track(env, "system", "saathum_stream_ended_archived", APP, { listing_id: b.listing_id, via: "youtube" });
      }
    } catch (err) {
      apiOutcome = "error";
      await trackException(env, err, { route: "checkSaathumStreamEnds:youtube_api", handled: true, app_name: APP });
    }
  }
  // [SAATHUM-WATCH-1 2026-09-28] Persist the clock fallback too (not just compute it at
  // read time): a stream whose YouTube id we don't have an actualEndTime for yet, but
  // whose scheduled window + grace has long passed, is written to ended_at here so the
  // admin archive / user past-events / tile "not live" all get the SAME one-time
  // "this is now archived" moment (and so `via: 'clock'` telemetry fires exactly once).
  try {
    const graceRows = await db.prepare(
      `SELECT v.listing_id AS listing_id
         FROM event_videos v JOIN listings l ON l.id = v.listing_id
        WHERE v.ended_at IS NULL AND l.starts_at IS NOT NULL
          AND (l.starts_at + COALESCE(l.duration_min, 0) * 60000 + ?1) < ?2
        LIMIT 500`,
    ).bind(CLOCK_GRACE_MS, now).all<{ listing_id: string }>();
    for (const r of graceRows.results ?? []) {
      await db.prepare(`UPDATE event_videos SET ended_at=?2 WHERE listing_id=?1 AND ended_at IS NULL`)
        .bind(r.listing_id, now).run().catch(() => {});
      void track(env, "system", "saathum_stream_ended_archived", APP, { listing_id: r.listing_id, via: "clock" });
    }
  } catch (err) {
    await trackException(env, err, { route: "checkSaathumStreamEnds:clock_fallback", handled: true, app_name: APP });
  }
  await track(env, "system", "saathum_stream_end_check", APP, { checked: rows.length, ended, api: apiOutcome });
  return { checked: rows.length, ended, api: apiOutcome };
}
