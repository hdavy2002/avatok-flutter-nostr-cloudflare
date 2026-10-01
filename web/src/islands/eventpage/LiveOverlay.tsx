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
//
// [SAATHUM-FREEVID-WEB-1 2026-10-01] FREE events (listing.free_watch / live-state `free`):
// anyone signed in with an email may watch — no booking, no checkout, no WhatsApp.
//  - signed out: the overlay and the panel button say "Sign in to watch free" and go to
//    the email sign-in, which returns here and skips the WhatsApp gate (signInUrlForFreeWatch).
//  - signed in: the entitled watch call returns `playable` (live OR ended replay) and the
//    player shows with the admin's crop.
//  - the panel's "Watch free" button never starts checkout.
// Paid events behave as before; the player just gets the crop too.
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { IslandBoundary } from '../../components/IslandBoundary';
import { hasClerkSessionHint } from '../../lib/sessionHint';
// [WEB-PERF-3 2026-09-30] Owner decision: non-critical code loads later, in the
// background. This island mounts on EVERY event page (client:load) and used to
// wrap itself in <ClerkIsland>, so every visitor downloaded ~300 KB of Clerk
// even though only a signed-in buyer (or admin preview) on a live/ended event
// ever needs a token. Clerk now loads only in that case, lazily.
const loadClerk = () => import('../../lib/clerk');
const LazyClerkIsland = lazy(() => loadClerk().then((m) => ({ default: m.ClerkIsland })));
import { ApiError } from '../../lib/apiClient';
import { getLiveState, getWatch, postWatchViewOnce } from '../saathum-checkout/api';
import { signInUrlForFreeWatch } from '../../lib/authRedirect';
import { toCrop, type VideoCrop } from '../../components/dash2/crop';
import { capture, captureException } from '../../lib/analytics';
import { YouTubeGuardedPlayer } from '../../components/dash2/YouTubeGuardedPlayer';

type Phase =
  | { kind: 'hidden' }
  | { kind: 'live_overlay' }
  | { kind: 'ended_overlay'; buyer: boolean }
  | { kind: 'replay_overlay' } // free event, ended, video available to signed-in viewers
  | { kind: 'player'; videoId: string; preview?: boolean; crop: VideoCrop | null };

type Authed = 'unknown' | 'in' | 'out';

function LiveOverlayInner({ listingId, checkoutHref, freeWatch, freeVideo, onNeedAuth }: { listingId: string; checkoutHref: string; freeWatch: boolean; freeVideo: boolean; onNeedAuth: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'hidden' });
  const [isFree, setIsFree] = useState(freeWatch);
  const [isReplay, setIsReplay] = useState(false);
  const [authed, setAuthed] = useState<Authed>('unknown');
  const tokenRef = useRef<string | null>(null);
  const shown = useRef<string | null>(null);
  const playerStarted = useRef(false);

  useEffect(() => {
    const ctrl = new AbortController();
    // Hint only (cookie, no Clerk load): lets the free-event button read "Sign in to watch free".
    setAuthed(hasClerkSessionHint() ? 'in' : 'out');
    (async () => {
      let publicState: 'none' | 'live' | 'ended';
      let free = freeWatch;
      let replay = false;
      // [SAATHUM-FREEVID-ANYTIME-1] free + video saved = watchable anytime.
      // [SAATHUM-FREEVID-FLOW-1] Seeded from the server-rendered page so a stale cached
      // live-state (public, max-age 30s) can never hide the player.
      let available = freeVideo;
      try {
        const ls = await getLiveState(listingId, ctrl.signal);
        publicState = ls.state;
        free = free || Boolean(ls.free);
        replay = Boolean(ls.replay);
        available = available || Boolean(ls.available);
        setIsFree(free);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        captureException(err, { surface: 'saathum_live_overlay', listing_id: listingId });
        // [SAATHUM-FREEVID-FLOW-1] A free video still plays without the public read.
        if (!(free && available)) return;
        publicState = 'none';
      }
      // [SAATHUM-LIVE-PREVIEW-1 2026-09-29] /book/<id>?preview=live lets an ADMIN see the
      // paid-buyer player before the event date. The server decides who is an admin;
      // for anyone else the param changes nothing (not_booked -> falls through below).
      const wantPreview = typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('preview') === 'live';
      const freeAvail = free && available;
      setIsReplay(replay);
      if (publicState === 'none' && !wantPreview && !freeAvail) { setPhase({ kind: 'hidden' }); return; }
      // [SAATHUM-LIVE-FAST-1 2026-09-29] Paint the public overlay IMMEDIATELY, then
      // upgrade to the player if the entitled read says so. Waiting for Clerk first
      // (up to 5s) left the page looking not-live for seconds.
      const publicPhase = (): Phase => (publicState === 'live'
        ? { kind: 'live_overlay' }
        : free && (replay || freeAvail) ? { kind: 'replay_overlay' } : { kind: 'ended_overlay', buyer: false });
      if (publicState !== 'none' || freeAvail) setPhase(publicPhase());

      // Only ever call the entitled endpoint when a session token exists —
      // a signed-out visitor never triggers it.
      // [SAATHUM-LIVE-TOKEN-WAIT-1 2026-09-29] Wait (up to 5s) for Clerk to load.
      // This island hydrates before Clerk has restored the session, so the plain
      // getActiveToken() said "signed out" and a PAYING buyer (or an admin preview)
      // got the "Book to watch" overlay / nothing instead of the player.
      // [WEB-PERF-3] No session cookie = signed out: skip Clerk entirely.
      let token: string | null = null;
      if (hasClerkSessionHint()) {
        onNeedAuth(); // mount the lazy ClerkIsland so the session can restore
        token = await loadClerk().then((m) => m.getActiveTokenWaited(8000)).catch(() => null);
      }
      if (ctrl.signal.aborted) return;
      tokenRef.current = token;
      setAuthed(token ? 'in' : 'out');
      if (token) {
        try {
          const w = await getWatch(listingId, token, ctrl.signal, wantPreview);
          if (ctrl.signal.aborted) return;
          // [SAATHUM-FREEVID-WEB-1] Free: the server says when the player may show (live or replay).
          if (free || w.free) {
            if (w.playable && w.youtube_video_id) {
              setPhase({ kind: 'player', videoId: w.youtube_video_id, preview: !!w.preview, crop: toCrop(w.crop) });
              if (w.preview) capture('saathum_live_admin_preview', { listing_id: listingId });
              return;
            }
            if (publicState !== 'none' || freeAvail) setPhase(publicPhase());
            return;
          }
          if (w.stream_state === 'live' && w.youtube_video_id) {
            setPhase({ kind: 'player', videoId: w.youtube_video_id, preview: !!w.preview, crop: toCrop(w.crop) });
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
      if (publicState === 'none' && !freeAvail) { setPhase({ kind: 'hidden' }); return; } // preview refused
      setPhase(publicPhase());
    })();
    return () => ctrl.abort();
  }, [listingId]);

  // [SAATHUM-FREEVID-WEB-1] The panel's "Watch free" button (server-rendered, never checkout):
  // signed out it reads "Sign in to watch free" and follows its href to the email sign-in;
  // signed in it just brings the video into view instead of navigating away.
  useEffect(() => {
    if (!isFree) return;
    const btn = document.querySelector<HTMLAnchorElement>('a[data-ep-action="watch-free"]');
    if (!btn) return;
    btn.textContent = authed === 'out' ? 'Sign in to watch free →' : 'Watch free →';
    const onClick = (e: MouseEvent) => {
      capture('saathum_watch_free_click', { listing_id: listingId, signed_in: authed !== 'out' });
      if (authed === 'out') return; // href = /sign-in?redirect_url=…&freewatch=1
      e.preventDefault();
      document.querySelector('.ep-art')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    btn.addEventListener('click', onClick);
    return () => btn.removeEventListener('click', onClick);
  }, [isFree, authed, listingId]);

  useEffect(() => {
    if (phase.kind === 'hidden') return;
    const key = phase.kind === 'player' ? 'live' : phase.kind === 'live_overlay' ? 'live' : phase.kind === 'replay_overlay' ? 'replay' : 'ended';
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
    const btn = document.querySelector<HTMLAnchorElement>('a[data-ep-action="book"], a[data-ep-action="watch-free"]');
    if (!btn) return;
    const span = document.createElement('span');
    span.className = btn.className;
    span.setAttribute('aria-disabled', 'true');
    span.textContent = 'Event ended';
    btn.replaceWith(span);
  }, [phase]);

  // [SAATHUM-LIVE-BOOKING-1 2026-09-29] While the stream is live, bookings are OPEN
  // (the server allows it). The SSR page may already have rendered "Booking closed"
  // because the scheduled start passed — swap it back for a live book button.
  useEffect(() => {
    // Also while the player is showing (admin preview, or a buyer booking for another family).
    if (phase.kind !== 'live_overlay' && phase.kind !== 'player') return;
    if (isFree) return; // a free event has no booking to reopen
    const closed = document.querySelector<HTMLElement>('span.ep-btn--book[aria-disabled="true"]');
    if (!closed) return;
    const a = document.createElement('a');
    a.className = closed.className;
    a.href = checkoutHref;
    a.setAttribute('data-ep-action', 'book');
    a.setAttribute('data-ep-listing-id', listingId);
    a.textContent = 'Book & watch live →';
    closed.replaceWith(a);
  }, [phase, checkoutHref, listingId, isFree]);

  // [SAATHUM-FREEVID-HERO-1 2026-10-01] Owner: once the free video is playing on this page,
  // the panel's "Watch free" button is pointless — grey it out (same disabled style the
  // page already uses for "Booking closed"/"Event ended").
  useEffect(() => {
    if (phase.kind !== 'player' || !isFree) return;
    const btn = document.querySelector<HTMLAnchorElement>('a[data-ep-action="watch-free"]');
    if (!btn) return;
    const span = document.createElement('span');
    span.className = btn.className;
    span.setAttribute('aria-disabled', 'true');
    span.setAttribute('data-ep-action', 'watch-free-playing');
    span.textContent = 'Watching now';
    btn.replaceWith(span);
  }, [phase, isFree]);

  if (phase.kind === 'hidden') return null;

  if (phase.kind === 'player') {
    // [SAATHUM-LIVE-GUARDED-1 2026-09-29] Owner: viewers must never reach YouTube
    // (logo, title, "Watch on YouTube", right-click → copy URL) or they share the
    // paid stream. The guarded player puts a transparent shield over the whole
    // iframe and drives YouTube through our own controls (play/pause, mute,
    // volume, fullscreen of OUR wrapper) — same component as the dashboard.
    return (
      <div className="ep-live-cover ep-live-cover--player" aria-label="Live now">
        <YouTubeGuardedPlayer
          videoId={phase.videoId}
          title="Live stream"
          autoPlay
          className="ep-live-guarded"
          crop={phase.crop}
          onPlay={() => {
            capture('saathum_live_player_play', { listing_id: listingId, preview: !!phase.preview });
            // [SAATHUM-FREEVID-WEB-1] First Play only (the player reports it once): one
            // PostHog event + one server view count per listing per page load. An admin's
            // preview is neither tracked nor counted.
            if (phase.preview) return;
            capture('saathum_video_play', { listing_id: listingId, free: isFree, surface: 'event_page' });
            if (tokenRef.current) postWatchViewOnce(listingId, tokenRef.current);
          }}
          onError={(code) => capture('saathum_live_player_error', { listing_id: listingId, code })}
        />
        {phase.preview && <span className="ep-pill ep-pill--soft ep-live-preview-tag">Admin preview</span>}
      </div>
    );
  }

  if ((phase.kind === 'live_overlay' || phase.kind === 'replay_overlay') && isFree) {
    // [SAATHUM-FREEVID-HERO-1 2026-10-01] Owner: someone landing straight on the event link
    // must see on the photo itself that the video is on and that one click watches it.
    // The whole photo is the button: signed out -> email sign-in (returns here and plays);
    // signed in -> the player is already loading, so the click just reloads into it.
    const live = phase.kind === 'live_overlay';
    const href = authed === 'out' ? signInUrlForFreeWatch() : (typeof window !== 'undefined' ? window.location.pathname + '?freewatch=1' : '#');
    return (
      <a
        className="ep-live-cover ep-live-cover--dim ep-live-watch"
        href={href}
        aria-label="Watch this video for free"
        onClick={() => capture('saathum_live_overlay_book_click', { listing_id: listingId, free: true, surface: 'hero' })}
      >
        {live
          ? <span className="ep-pill ep-pill--live"><i />LIVE NOW · FREE</span>
          : <span className="ep-pill ep-pill--live"><i />{isReplay ? 'Replay · free' : 'Free · watch now'}</span>}
        <span className="ep-live-watch-play" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
        </span>
        <span className="ep-live-watch-text">{authed === 'out' ? 'Click to watch free — sign in with your email' : 'Click to watch free'}</span>
      </a>
    );
  }

  if (phase.kind === 'live_overlay' || phase.kind === 'replay_overlay') {
    const live = phase.kind === 'live_overlay';
    // [SAATHUM-FREEVID-WEB-1] Free event: only a signed-out visitor gets a button (to the
    // email sign-in); a signed-in one is waiting for the player, so no button flashes.
    const showCta = !isFree || authed === 'out';
    return (
      <div className="ep-live-cover ep-live-cover--dim">
        {live
          ? <span className="ep-pill ep-pill--live"><i />LIVE NOW</span>
          : <span className="ep-pill ep-pill--soft">{isReplay ? 'Replay available' : 'Free to watch'}</span>}
        {showCta && (
          <a
            className="ep-btn ep-btn--book ep-live-cta"
            href={isFree ? signInUrlForFreeWatch() : checkoutHref}
            onClick={() => capture('saathum_live_overlay_book_click', { listing_id: listingId, free: isFree })}
          >
            {isFree ? 'Sign in to watch free →' : 'Book to watch →'}
          </a>
        )}
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

export default function LiveOverlay({ listingId, checkoutHref, freeWatch = false, freeVideo = false }: { listingId: string; checkoutHref: string; freeWatch?: boolean; freeVideo?: boolean }) {
  const [withClerk, setWithClerk] = useState(false);
  return (
    <IslandBoundary island="event-page-live-overlay">
      {withClerk && (
        <Suspense fallback={null}>
          <LazyClerkIsland>{null}</LazyClerkIsland>
        </Suspense>
      )}
      <LiveOverlayInner listingId={listingId} checkoutHref={checkoutHref} freeWatch={freeWatch} freeVideo={freeVideo} onNeedAuth={() => setWithClerk(true)} />
    </IslandBoundary>
  );
}
