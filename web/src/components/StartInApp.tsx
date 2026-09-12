/*
 * StartInApp — the screen a CREATOR sees where the browser used to offer to
 * transmit. [APP-ONLY-TX-1 2026-09-12]
 *
 * Owner decision 2026-09-12, `Specs/RULEBOOK-PAID-SESSIONS.md` §7: **all
 * transmission is from the app.** Creators start live events and 1:1s only in
 * the Flutter app; the browser is a customer surface (watch, listen, talk,
 * chat, upload) and nothing else. So every creator-facing entry point on the
 * website resolves here: a deep link into the app plus a Play Store fallback.
 *
 * Deliberately inert: this component requests NO camera or microphone and
 * mounts no media SDK. That is the whole point — see rulebook §5, "never build
 * or resurface a browser hosting/green-room/backstage surface for creators".
 */
import { useEffect } from 'react';
import { Button } from './Button';
import { capture } from '../lib/analytics';
import { appSessionDeepLink } from '../lib/urls';

const PLAY_STORE = 'https://play.google.com/store/apps/details?id=ai.avatok.avatok_call';

export interface StartInAppProps {
  /** Which lane sent the creator here — drives the copy and the deep link. */
  kind: 'live_event' | 'consult_1to1';
  /** Listing title, when known. */
  title?: string | null;
  /** Live events deep-link by listing id. */
  listingId?: string | null;
  /** 1:1s deep-link by booking id. */
  bookingId?: string | null;
  startsAt?: number | null;
  endsAt?: number | null;
  /** Where "Back" goes. Defaults to the dashboard. */
  backHref?: string;
  backLabel?: string;
  /** PostHog `web_creator_redirected_to_app` `from` property. */
  from: string;
}

function fmtWhen(ms?: number | null): string | null {
  if (!ms) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toUTCString();
  }
}

function fmtRange(startsAt?: number | null, endsAt?: number | null): string | null {
  const start = fmtWhen(startsAt);
  if (!start) return null;
  if (!endsAt) return start;
  try {
    const end = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(endsAt));
    return `${start} - ${end}`;
  } catch {
    return start;
  }
}

export function StartInApp({
  kind, title, listingId, bookingId, startsAt, endsAt, backHref = '/dashboard', backLabel = 'My dashboard', from,
}: StartInAppProps) {
  const deep = appSessionDeepLink({ kind, listingId, bookingId });
  const isLive = kind === 'live_event';
  const when = fmtRange(startsAt, endsAt);

  useEffect(() => {
    try {
      capture('web_creator_redirected_to_app', {
        from,
        kind,
        listing_id: listingId ?? null,
        booking_id: bookingId ?? null,
        has_deep_link: Boolean(deep),
      });
    } catch {
      /* best-effort */
    }
    // one event per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <span className="font-mono text-[13px] font-bold uppercase tracking-[0.1em] text-blueInk">
          Creators go live in the app
        </span>
        <h1 className="font-display text-[27px] font-semibold leading-[1.06] text-ink">
          {isLive ? 'Start this event from the avaTOK app' : 'Start this session from the avaTOK app'}
        </h1>

        {(title || when) && (
          <div className="w-full rounded-zine border-zine border-ink bg-card px-4 py-3 shadow-zine-xs">
            {title && <p className="font-display text-[17px] font-semibold text-ink">{title}</p>}
            {when && (
              <p className="mt-1 font-mono text-[13px] font-bold uppercase tracking-[0.04em] text-inkSoft">{when}</p>
            )}
          </div>
        )}

        <p className="font-body text-[15px] font-bold leading-relaxed text-inkSoft">
          {isLive
            ? 'Your camera and microphone only broadcast from the avaTOK app. Open the app to go live - your ticket holders are watching on this page.'
            : 'Your camera and microphone only transmit from the avaTOK app. Open the app to take this appointment - your customer is waiting in his browser.'}
        </p>

        <div className="flex w-full flex-col gap-3">
          {deep && (
            <a href={deep} className="no-underline">
              <Button variant="lime" fullWidth label="Open in the avaTOK app" />
            </a>
          )}
          <a href={PLAY_STORE} rel="noopener" className="no-underline">
            <Button variant="ghost" fullWidth label="Get the avaTOK app" />
          </a>
          <a href={backHref} className="font-body text-[13px] font-bold text-inkSoft underline">
            {backLabel}
          </a>
        </div>
      </div>
    </div>
  );
}

export default StartInApp;
