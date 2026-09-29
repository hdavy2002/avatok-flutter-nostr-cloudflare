// [SAATHUM-WATCH-1 2026-09-28] Owner decisions on the listing detail page
// (web/src/pages/book/[id].astro is the watch page — no separate /watch route):
//
//  - state 'live', visitor not signed in / not booked: overlay on the hero
//    photo — "LIVE NOW" pill (reuses .ep-pill--live) + "Book to watch" button
//    (reuses .ep-btn--book), linking to the same checkout the page's own
//    "Book" button uses.
//  - state 'live', signed-in buyer with a confirmed + WhatsApp-verified
//    booking: the hero photo is REPLACED by the embedded YouTube player. The
//    video id comes ONLY from the entitled GET /api/saathum/watch/:id — never
//    rendered into the page HTML for anyone else.
//  - state 'ended': overlay "This live stream has ended." — a confirmed buyer
//    also sees the download/WhatsApp/email note (owner copy, 2026-09-28). No
//    player ever. The event also STOPS TAKING BOOKINGS the moment it's ended:
//    this island swaps the page's own "Book with my sankalp" button (and its
//    own book CTA in the live overlay, which this phase never renders) for a
//    non-clickable "Event ended" pill, reusing the existing disabled-button
//    style the SSR page already uses for "Booking closed". Checkout creation
//    is refused server-side either way (saathum_checkout.ts computeBookable).
//  - state 'none': this island renders nothing — the page's own SSR
//    badge/countdown keeps showing exactly as before.
//
// Two fetches, never conflated: /api/saathum/live-state/:id is PUBLIC and
// carries no video id, so every visitor (signed out included) can render the
// right overlay. /api/saathum/watch/:id is the entitled call — it is only
// ever made when a Clerk token exists, and only its response can put a video
// id in the DOM.
import { useEffect, useRef, useState } from 'react';
import { IslandBoundary } from '../../components/IslandBoundary';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { ApiError } from '../../lib/apiClient';
import { getLiveState, getWatch } from '../saathum-checkout/api';
import { capture, captureException } from '../../lib/analytics';

type Phase =
  | { kind: 'hidden' }
  | { kind: 'live_overlay' }
  | { kind: 'ended_overlay'; buyer: boolean }
  | { kind: 'player'; videoId: string; preview?: boolean };

function LiveOverlayInner({ listingId, checkoutHref }: { listingId: string; checkoutHref: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'hidden' });
  const shown = useRef<string | null>(null);
  const playerStarted = useRef(false);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      let publicState: 'none' | 'live' | 'ended';
      try {
        const ls = await getLiveState(listingId, ctrl.signal);
        publicState = ls.state;
      } catch (err) {
        if (ctrl.signal.aborted) return;
        captureException(err, { surface: 'saathum_live_overlay', listing_id: listingId });
        return;
      }
      // [SAATHUM-LIVE-PREVIEW-1 2026-09-29] /book/<id>?preview=live lets an ADMIN see the
      // paid-buyer player before the event date. The server decides who is an admin;
      // for anyone else the param changes nothing (not_booked -> falls through below).
      const wantPreview = typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('preview') === 'live';
      if (publicState === 'none' && !wantPreview) { setPhase({ kind: 'hidden' }); return; }

      // Only ever call the entitled endpoint when a session token exists —
      // a signed-out visitor never triggers it.
      const token = await getActiveToken().catch(() => null);
      if (token) {
        try {
          const w = await getWatch(listingId, token, ctrl.signal, wantPreview);
          if (ctrl.signal.aborted) return;
          if (w.stream_state === 'live' && w.youtube_video_id) {
            setPhase({ kind: 'player', videoId: w.youtube_video_id, preview: !!w.preview });
            if (w.preview) capture('saathum_live_admin_preview', { listing_id: listingId });
            return;
          }
          if (w.stream_state === 'ended') { setPhase({ kind: 'ended_overlay', buyer: true }); return; }
          // Booked but the entitled read disagrees on 'live' (race with the
          // public 30s cache) — fall through to the generic overlay below.
        } catch (err) {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError) {
            capture('saathum_watch_denied', { listing_id: listingId, error: err.error });
          } else {
            captureException(err, { surface: 'saathum_watch', listing_id: listingId });
          }
          // not_booked / no_stream / expired token — falls through to the
          // public-visitor overlay below, which is the correct experience.
        }
      }
      if (publicState === 'none') { setPhase({ kind: 'hidden' }); return; } // preview refused
      setPhase(publicState === 'live' ? { kind: 'live_overlay' } : { kind: 'ended_overlay', buyer: false });
    })();
    return () => ctrl.abort();
  }, [listingId]);

  useEffect(() => {
    if (phase.kind === 'hidden') return;
    const key = phase.kind === 'player' ? 'live' : phase.kind === 'live_overlay' ? 'live' : 'ended';
    if (shown.current === key) return;
    shown.current = key;
    capture('saathum_live_overlay_shown', { listing_id: listingId, state: key });
  }, [phase, listingId]);

  useEffect(() => {
    if (phase.kind === 'player' && !playerStarted.current) {
      playerStarted.current = true;
      capture('saathum_live_player_started', { listing_id: listingId });
    }
  }, [phase, listingId]);

  // [SAATHUM-WATCH-1 2026-09-28] Booking is closed once the stream has ended — the
  // page's own SSR "Book with my sankalp" button was rendered before we knew that
  // (or the show ended early, ahead of the schedule window SSR checks), so swap it
  // here for the same disabled-button markup the SSR page already uses for
  // "Booking closed", reusing its exact classes/attrs (no new styles).
  useEffect(() => {
    if (phase.kind !== 'ended_overlay') return;
    const btn = document.querySelector<HTMLAnchorElement>('a[data-ep-action="book"]');
    if (!btn) return;
    const span = document.createElement('span');
    span.className = btn.className;
    span.setAttribute('aria-disabled', 'true');
    span.textContent = 'Event ended';
    btn.replaceWith(span);
  }, [phase]);

  if (phase.kind === 'hidden') return null;

  if (phase.kind === 'player') {
    return (
      <div className="ep-live-cover" aria-label="Live now">
        <iframe
          className="ep-live-frame"
          src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(phase.videoId)}?autoplay=1&mute=1&modestbranding=1&rel=0&playsinline=1`}
          title="Live stream"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
        {phase.preview && (
          <span className="ep-pill ep-pill--soft" style={{ position: 'absolute', top: 8, left: 8, zIndex: 2 }}>
            Admin preview
          </span>
        )}
      </div>
    );
  }

  if (phase.kind === 'live_overlay') {
    return (
      <div className="ep-live-cover ep-live-cover--dim">
        <span className="ep-pill ep-pill--live"><i />LIVE NOW</span>
        <a
          className="ep-btn ep-btn--book ep-live-cta"
          href={checkoutHref}
          onClick={() => capture('saathum_live_overlay_book_click', { listing_id: listingId })}
        >
          Book to watch →
        </a>
      </div>
    );
  }

  // ended_overlay — owner copy 2026-09-28: buyers get the full download note,
  // everyone else just sees that the stream has ended.
  return (
    <div className="ep-live-cover ep-live-cover--dim">
      <span className="ep-pill ep-pill--soft">This live stream has ended.</span>
      {phase.buyer && (
        <p className="ep-live-ended-note">
          You can download your video from your dashboard under Past events. Once it&rsquo;s ready, we&rsquo;ll
          also send you the direct link on WhatsApp and email. The video can take 24 to 48 hours to appear.
        </p>
      )}
    </div>
  );
}

export default function LiveOverlay({ listingId, checkoutHref }: { listingId: string; checkoutHref: string }) {
  return (
    <IslandBoundary island="event-page-live-overlay">
      <ClerkIsland>
        <LiveOverlayInner listingId={listingId} checkoutHref={checkoutHref} />
      </ClerkIsland>
    </IslandBoundary>
  );
}
