/* Phase B — Confirmation (the "confirm" step).
 *
 * Shows the confirmed booking and a deep link to the RIGHT viewer (owned by
 * other phases — we only render an <a>, never build the target):
 *   live    → /live/<listingId>       (commercial viewer)
 *   consult → /session/<bookingId>    (commercial consult room)
 *   agent   → /agent/<listingId>      (Phase E)
 *   event   → /dashboard              (this phase)
 * Also offers the quiet, optional "save a password" upgrade (§4b) — never blocks.
 */
import { useState } from 'react';
import type { Listing } from '../../lib/types';
import { livePath, sessionPath, readReturnParam } from '../../lib/urls';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { UpgradePrompt } from '../auth/UpgradePrompt';
import { AppDownloadCta } from '../../components/AppDownloadCta';
import { freeBox } from '../../lib/copy';
import type { BookingResult, BookSelection } from './types';

function fmtWhen(ms?: number): string | null {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toUTCString();
  }
}

export interface ConfirmationProps {
  listing: Listing;
  selection: BookSelection;
  result: BookingResult;
}

export function Confirmation({ listing, selection, result }: ConfirmationProps) {
  const [showUpgrade, setShowUpgrade] = useState(true);
  const kind = (listing.kind ?? '') as string;
  const bookingId = result.booking_id;
  // [LIST-FREE-1] The buyer paid ₹0 on this booking because the listing is
  // free_entry — the host funded it. Read the listing flag (not `result.paid`
  // alone) so this only fires for the actual free lane.
  const isFreeEntry = Boolean(listing.free_entry);
  const spotsLeft = typeof result.spots_left === 'number' ? result.spots_left : null;

  let viewerHref: string;
  let viewerLabel: string;
  if (kind === 'agent') {
    viewerHref = `/agent/${encodeURIComponent(listing.id)}`;
    viewerLabel = 'Open the agent';
  } else if (kind === 'consult' || kind === 'consult_1to1') {
    viewerHref = sessionPath(bookingId);
    viewerLabel = 'Go to your consult room';
  } else if (kind === 'live' || kind === 'live_event') {
    // [WEB-COMM-PAY-1] Listings of this kind are stored as `live_event`
    // (see worker's checkoutKind()); `live` is kept as a legacy alias.
    viewerHref = livePath(listing.id);
    viewerLabel = 'Watch live';
  } else {
    viewerHref = '/dashboard';
    viewerLabel = 'View in my dashboard';
  }

  // [JOIN-LINK-1] `?return=<room>` — set by the "Pay and join" panel a visitor
  // hits at a bare /live/:id he has no ticket for. Honouring it is what makes
  // that panel a single flow instead of "pay, then go and find the room again".
  // `readReturnParam` only ever yields a room path on this origin, so this can
  // never become an open redirect out of a payment confirmation.
  const returnTo = readReturnParam();
  if (returnTo) {
    viewerHref = returnTo;
    viewerLabel = returnTo.startsWith('/live/') ? 'Watch live' : 'Go to your session';
  }

  const when =
    selection.type === 'calendar'
      ? fmtWhen(selection.startAt)
      : selection.type === 'commercial'
        ? fmtWhen(selection.slot?.start_at ?? result.start_at)
        : fmtWhen(selection.scheduledAt);

  const ctaClass =
    'inline-flex items-center justify-center gap-2.5 select-none no-underline w-full ' +
    'rounded-zine border-zine border-ink shadow-zine-sm bg-lime text-ink ' +
    'transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed ' +
    'px-6 py-3.5 font-display font-semibold text-[19px] leading-none tracking-[0.02em]';

  return (
    <div className="flex flex-col gap-4">
      <Card fillClassName="bg-mint" shadow="lg">
        <div className="flex flex-col gap-2">
          {/* [UI-MOTION-1 2026-09-10] "success-check" (transitions.dev, `.t-*`
              in styles/motion.css) — presentation only, no amount/currency
              here. `data-state="in"` is set on mount, not toggled later: this
              component only ever renders once a booking is already confirmed,
              so the mount itself IS the moment to animate; a CSS `@keyframes`
              animation (unlike a transition) plays correctly from an initial
              attribute value, no two-frame rAF trick needed. */}
          <div className="flex items-center gap-2">
            <span className="t-success-check" data-state="in" aria-hidden="true" style={{ width: 20, height: 20, color: 'inherit' }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                <path d="M4 12.5l5 5L20 6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="font-mono font-bold uppercase text-[14px] tracking-[0.1em] text-ink">Confirmed</span>
          </div>
          <h2 className="font-display font-semibold text-[24px] leading-tight text-ink">
            You’re booked: {selection.title}
          </h2>
          {when && (
            <p className="font-body font-bold text-[15px] text-ink/80">
              {when}
              {selection.type === 'agent' ? ` · ${selection.minutes} min` : ''}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Pill kind="plain">Booking {bookingId.slice(0, 8)}</Pill>
            {isFreeEntry ? <Pill kind="ok">Free</Pill> : null}
            {!isFreeEntry && result.paid ? <Pill kind="ok">Paid</Pill> : null}
            {!isFreeEntry && result.escrow_coins ? <Pill kind="ok">{result.escrow_coins} Tokens held</Pill> : null}
            {isFreeEntry && spotsLeft != null ? <Pill kind="hint">{freeBox.spotsLeft(spotsLeft)}</Pill> : null}
          </div>
          {isFreeEntry ? (
            <p className="mt-1 font-body font-bold text-[14px] text-ink/70">{freeBox.hostPays}</p>
          ) : (
            <p className="mt-1 font-body font-bold text-[14px] text-ink/70">
              Your booking is saved. You can find it anytime in All my bookings.
            </p>
          )}
        </div>
      </Card>

      <a href={viewerHref} className={ctaClass}>
        {viewerLabel} →
      </a>
      <a
        href="/dashboard"
        className="text-center font-mono font-bold uppercase text-[14px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2"
      >
        All my bookings
      </a>

      {/* Web-first: the viewer link above works in-browser now. The app is the
          upgrade — renders only once a store listing is live (else nothing). */}
      <AppDownloadCta compact title="" subtitle="" className="pt-1" />

      {showUpgrade && (
        <UpgradePrompt
          compact
          reason="Save a password so you can find this booking from any device."
          onDismiss={() => setShowUpgrade(false)}
          onUpgraded={() => setShowUpgrade(false)}
        />
      )}
    </div>
  );
}

export default Confirmation;
