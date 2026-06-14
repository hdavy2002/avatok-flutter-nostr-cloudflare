/* Phase B — Confirmation (the "confirm" step).
 *
 * Shows the confirmed booking and a deep link to the RIGHT viewer (owned by
 * other phases — we only render an <a>, never build the target):
 *   live    → /watch/<listingId>      (Phase C)
 *   consult → /consult/<bookingId>    (Phase D)
 *   agent   → /agent/<listingId>      (Phase E)
 *   event   → /dashboard              (this phase)
 * Also offers the quiet, optional "save a password" upgrade (§4b) — never blocks.
 */
import { useState } from 'react';
import type { Listing } from '../../lib/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { UpgradePrompt } from '../auth/UpgradePrompt';
import { AppDownloadCta } from '../../components/AppDownloadCta';
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

  let viewerHref: string;
  let viewerLabel: string;
  if (kind === 'agent') {
    viewerHref = `/agent/${encodeURIComponent(listing.id)}`;
    viewerLabel = 'Open the agent';
  } else if (kind === 'consult') {
    viewerHref = `/consult/${encodeURIComponent(bookingId)}`;
    viewerLabel = 'Go to your consult room';
  } else if (kind === 'live') {
    viewerHref = `/watch/${encodeURIComponent(listing.id)}`;
    viewerLabel = 'Watch live';
  } else {
    viewerHref = '/dashboard';
    viewerLabel = 'View in my dashboard';
  }

  const when =
    selection.type === 'calendar' ? fmtWhen(selection.startAt) : fmtWhen(selection.scheduledAt);

  const ctaClass =
    'inline-flex items-center justify-center gap-2.5 select-none no-underline w-full ' +
    'rounded-full border-zine border-ink shadow-zine-sm bg-lime text-ink ' +
    'transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed ' +
    'px-6 py-3.5 font-display font-semibold text-[19px] leading-none tracking-[-0.2px]';

  return (
    <div className="flex flex-col gap-4">
      <Card fillClassName="bg-mint" shadow="lg">
        <div className="flex flex-col gap-2">
          <span className="font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-ink">Confirmed</span>
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
            {result.paid ? <Pill kind="ok">Paid</Pill> : null}
            {result.escrow_coins ? <Pill kind="ok">{result.escrow_coins} AvaCoins held</Pill> : null}
          </div>
          <p className="mt-1 font-body font-bold text-[14px] text-ink/70">
            We emailed your confirmation and reminders.
          </p>
        </div>
      </Card>

      <a href={viewerHref} className={ctaClass}>
        {viewerLabel} →
      </a>
      <a
        href="/dashboard"
        className="text-center font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2"
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
