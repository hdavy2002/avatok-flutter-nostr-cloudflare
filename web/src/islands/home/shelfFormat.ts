// [SHV2-S3] Pure helpers for the event shelves island (contracts.md §6a) — no
// runtime imports, so this can be tested with plain `node --experimental-strip-types
// --test` and no bundler/DOM. The island imports these and injects everything
// else (React, ListingTile, the controller).

export interface LocalStart { iso: string; label: string; zone: string }

/** Browser-local time with a visible zone label and an explicit IST fallback
 *  (A4.2/AC-08). Returns null when there is no start time to show at all. */
export function formatLocalStart(startsAtMs: number | null): LocalStart | null {
  if (!startsAtMs) return null;
  const d = new Date(startsAtMs);
  if (!Number.isFinite(d.getTime())) return null;
  let timeZone = 'Asia/Kolkata';
  let zone = 'IST';
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved) timeZone = resolved;
  } catch {
    // Intl unavailable — IST fallback above stands.
  }
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: 'short' }).formatToParts(d);
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (tz) zone = tz;
  } catch {
    // Keep the IST fallback.
  }
  let label: string;
  try {
    label = d.toLocaleString(undefined, {
      timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    label = d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }
  return { iso: d.toISOString(), label, zone };
}

export interface CardAction { label: string; href: string; cta: 'join_now' | 'view_details' }

/** A4.2's fail-closed rule, expressed as the `ListingTile` §2a action payload:
 *  "Join now" only when the controller says joinable, otherwise "View details" —
 *  never a third label, never invented text. */
export function actionFor(joinable: boolean, href: string): CardAction {
  return joinable
    ? { label: 'Join now', href, cta: 'join_now' }
    : { label: 'View details', href, cta: 'view_details' };
}

export interface VisibleFields { showLanguage: boolean; showDuration: boolean }

/**
 * `ListingTile`'s non-poster-first layout already shows language (its stub
 * line) and duration (bottom-right) visibly; its poster-first layout hides
 * both (see SpiritualEventShelves.tsx's `EventCard` doc comment for the full
 * accounting of what the tile shows in each layout). The shelf only adds
 * language/duration itself when the tile would otherwise hide them, so a
 * poster-first card never shows the same fact twice.
 */
export function visibleFieldsFor(posterFirst: boolean): VisibleFields {
  return { showLanguage: posterFirst, showDuration: posterFirst };
}
