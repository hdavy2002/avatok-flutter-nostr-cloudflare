// [REFUND-POLICY-SRV-1] Owner decision 2026-09-28: customer refund-request windows by
// Saathum event_type (listings.attrs.event_type; see web/src/lib/eventTypes.ts for the
// web mirror). ONE helper so the checkout payload, any refund-request route and the
// website's own copy ("Free cancellation up to N before it starts") can never disagree.
//
//   havan, puja                       -> 24 hours before starts_at
//   satsang, sermon, meditation       -> 72 hours (3 days) before starts_at
//   missing / unrecognised event_type -> treated as 'havan' (24h), per the owner's rule
//
// This is deliberately NOT the same machinery as commercial_lifecycle.ts's
// cancellationDecision()/policy-snapshot window (that is the older avaTOK 1:1-consult /
// live-event marketplace and is snapshotted per order). Saathum checkouts
// (routes/saathum_checkout.ts) are a separate product line and read this helper live off
// the listing, because the window is a fixed product rule keyed on event_type, not a
// per-order commercial policy snapshot.

export type SaathumEventType = "havan" | "puja" | "satsang" | "sermon" | "meditation";

const LONG_WINDOW_TYPES: ReadonlySet<string> = new Set(["satsang", "sermon", "meditation"]);

/**
 * Hours before `starts_at` a customer may still request a refund, keyed on
 * `listings.attrs.event_type`. Missing/unknown defaults to the 'havan' window (24h).
 */
export function refundWindowHours(eventType: string | null | undefined): number {
  const t = (eventType ?? "").trim().toLowerCase();
  return LONG_WINDOW_TYPES.has(t) ? 72 : 24;
}

/**
 * Can a refund still be requested for this listing, right now?
 * `starts_at` missing/invalid fails OPEN (ok:true) — a listing with no schedule yet
 * cannot have "started", so there is no window to have missed.
 */
export function canRequestRefund(
  listing: { event_type?: string | null; starts_at?: number | null },
  now: number,
): { ok: true; hoursBefore: number } | { ok: false; hoursBefore: number; startsAt: number } {
  const hoursBefore = refundWindowHours(listing.event_type);
  const startsAt = Number(listing.starts_at ?? 0);
  if (!Number.isFinite(startsAt) || startsAt <= 0) return { ok: true, hoursBefore };
  const cutoff = startsAt - hoursBefore * 3_600_000;
  return now <= cutoff ? { ok: true, hoursBefore } : { ok: false, hoursBefore, startsAt };
}

/** Human-facing copy for a refused refund request, matching §3 of REFUND-POLICY-SRV-1. */
export function refundWindowRefusalMessage(eventType: string | null | undefined): string {
  const hours = refundWindowHours(eventType);
  const t = (eventType ?? "").trim().toLowerCase() || "havan";
  const label = ["havan", "puja", "satsang", "sermon", "meditation"].includes(t) ? t : "havan";
  return hours >= 72
    ? `Refunds for a ${label} can be requested up to 3 days before it starts.`
    : `Refunds for a ${label} can be requested up to 24 hours before it starts.`;
}
