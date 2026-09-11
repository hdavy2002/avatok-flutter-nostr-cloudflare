// [LISTING-EXPIRY-1 2026-09-11] The ONE place that decides where a listing sits in
// time: upcoming, starting, live, ended, cancelled.
//
// WHY THIS FILE EXISTS
// --------------------
// Until this change nothing anywhere compared a live event's start time with
// the clock. A listing left the marketplace only when its STATUS changed, and a
// live event's status only changed if the host actually went live and GetStream
// reported the stream ended. "Cooking with Davy" (prod, 8 Sept 2026 02:42 IST)
// was still on /marketplace on 11 Sept, its page counted down from 00:00:00:00,
// checkout still took ₹118 for it, and the one buyer who had paid could never
// join and was never refunded (no session row → the no-show sweep never saw it).
// See AUDIT-2026-09-11-listing-expiry.md.
//
// Every surface — checkout, the gateway order route, the marketplace queries,
// the sitemap, the public listing page, the app — now asks THIS module, so they
// cannot disagree about whether a show is over.
//
// Pure functions + SQL fragments. No I/O.

/** Buyers may still buy a published (not yet live) show this long after its start
 *  time. Deliberately the SAME 15 minutes the host no-show sweeps use
 *  (commercial_settlement.ts loadOverdueNoShowAuthorities, and
 *  routes/commercial_lifecycle.ts runCommercialOrphanNoShowSweep): selling a ticket after that point would sell
 *  something the sweep refunds in the next five minutes. */
export const LATE_BOOKING_GRACE_MS = 15 * 60_000;

/** A published event is moved to `completed` by the cron this long after its
 *  scheduled END, not at the end itself, so a host running a little over is not
 *  cut off mid-show by a status flip. Public lists hide it at the end time. */
export const END_GRACE_MS = 15 * 60_000;

/** A `live` listing whose scheduled end is this far in the past is treated as a
 *  stuck projection (the provider "ended" webhook never arrived) and is no longer
 *  advertised on the live-now rail. Status authority stays with the provider. */
export const STUCK_LIVE_MS = 6 * 60 * 60_000;

export type ScheduleState =
  /** A fixed-date show whose start is still ahead. */
  | "upcoming"
  /** Start time has passed, end has not, and the provider has not confirmed live. */
  | "starting"
  /** Provider-confirmed live. */
  | "live"
  /** The show is over (by status or by the clock). */
  | "ended"
  /** Cancelled by the host, an admin or the no-show rule. */
  | "cancelled"
  /** A marketplace (sell/buy/social) listing past its paid 30-day window. */
  | "expired"
  /** Bookable without a fixed date (consultations, classifieds, on-request). */
  | "open"
  /** draft / pending_review / approved / rejected — not public. */
  | "unpublished";

type RowLike = {
  kind?: unknown;
  status?: unknown;
  starts_at?: unknown;
  duration_min?: unknown;
  expires_at?: unknown;
};

/** Epoch ms. Some historical rows stored seconds; anything below ~2001 in ms was seconds. */
export function toMs(value: unknown): number | null {
  const n = Math.trunc(Number(value));
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n < 100_000_000_000 ? n * 1000 : n;
}

/** The scheduled window of a fixed-date live event, or null for anything else. */
export function eventWindow(row: RowLike): { start: number; end: number } | null {
  if (String(row.kind ?? "") !== "live_event") return null;
  const start = toMs(row.starts_at);
  if (start === null) return null;
  const minutes = Math.max(1, Math.trunc(Number(row.duration_min ?? 60)) || 60);
  return { start, end: start + minutes * 60_000 };
}

export function scheduleState(row: RowLike, now = Date.now()): ScheduleState {
  const status = String(row.status ?? "");
  if (status === "cancelled") return "cancelled";
  if (status === "completed") return "ended";
  if (status !== "published" && status !== "live") return "unpublished";
  const expires = toMs(row.expires_at);
  if (expires !== null && expires <= now) return "expired";
  if (status === "live") return "live";
  const win = eventWindow(row);
  if (!win) return "open";
  if (now < win.start) return "upcoming";
  if (now < win.end) return "starting";
  return "ended";
}

export type Bookability =
  | { ok: true; state: ScheduleState }
  | { ok: false; state: ScheduleState; reason: "event_ended" | "booking_closed" | "listing_cancelled" | "listing_unavailable"; message: string };

/**
 * May a buyer buy a seat right now? Consultations and classifieds have no fixed
 * event time — their own slot validation (future slot required) is the guard —
 * so for them this only checks status.
 */
export function bookability(row: RowLike, now = Date.now()): Bookability {
  const state = scheduleState(row, now);
  switch (state) {
    case "upcoming":
    case "open":
      return { ok: true, state };
    case "live": {
      const win = eventWindow(row);
      if (win && now >= win.end) {
        return { ok: false, state, reason: "event_ended", message: "This show has ended." };
      }
      return { ok: true, state };
    }
    case "starting": {
      const win = eventWindow(row);
      if (win && now < win.start + LATE_BOOKING_GRACE_MS) return { ok: true, state };
      return { ok: false, state, reason: "booking_closed", message: "Booking for this show has closed." };
    }
    case "ended":
      return { ok: false, state, reason: "event_ended", message: "This show has ended." };
    case "cancelled":
      return { ok: false, state, reason: "listing_cancelled", message: "This show was cancelled." };
    default:
      return { ok: false, state, reason: "listing_unavailable", message: "This listing is not available." };
  }
}

/** SQL expression (epoch ms) for a listing row's scheduled end. */
export function endMsSql(alias: string): string {
  const s = `(CASE WHEN ${alias}.starts_at < 100000000000 THEN ${alias}.starts_at * 1000 ELSE ${alias}.starts_at END)`;
  return `(${s} + MAX(1, COALESCE(${alias}.duration_min, 60)) * 60000)`;
}

/**
 * WHERE fragment that hides a fixed-date live event whose scheduled end has
 * passed but whose status is still `published` (the cron has not closed it yet,
 * or the host never went live). `nowRef` is a bind placeholder such as `?3`.
 * `live` rows are left to the provider, apart from the stuck-live cap applied on
 * the live-now rail.
 */
export function notEndedSql(alias: string, nowRef: string): string {
  return `NOT (${alias}.kind='live_event' AND ${alias}.status='published'
    AND COALESCE(${alias}.starts_at, 0) > 0 AND ${endMsSql(alias)} <= ${nowRef})`;
}

/** WHERE fragment for the live-now rail: a `live` row past end + STUCK_LIVE_MS is not advertised. */
export function notStuckLiveSql(alias: string, nowRef: string): string {
  return `NOT (${alias}.kind='live_event' AND COALESCE(${alias}.starts_at, 0) > 0
    AND ${endMsSql(alias)} + ${STUCK_LIVE_MS} <= ${nowRef})`;
}
