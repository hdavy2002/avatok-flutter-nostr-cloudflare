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
//  - state 'ended': overlay "This live stream has ended"; a confirmed buyer
//    also sees "Your video will come on WhatsApp and email." No player ever.
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
  | { kind: 'player'; videoId: string };

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
      if (publicState === 'none') { setPhase({ kind: 'hidden' }); return; }

      // Only ever call the entitled endpoint when a session token exists —
      // a signed-out visitor never triggers it.
      const token = await getActiveToken().catch(() => null);
      if (token) {
        try {
          const w = await getWatch(listingId, token, ctrl.signal);
          if (ctrl.signal.aborted) return;
          if (w.stream_state === 'live' && w.youtube_video_id) {
            setPhase({ kind: 'player', videoId: w.youtube_video_id });
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

  // ended_overlay
  return (
    <div className="ep-live-cover ep-live-cover--dim">
      <span className="ep-pill ep-pill--soft">This live stream has ended</span>
      {phase.buyer && <p className="ep-live-ended-note">Your video will come on WhatsApp and email.</p>}
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
