// [SAATHUM-FREEVIDEOS-WEB-1 2026-10-01] The /watch/<id> page body: hero (cover -> guarded player),
// category chip, title, description, "Watch free" button, WhatsApp share and "More free videos".
// Follows the patterns of ../eventpage/LiveOverlay.tsx (free-event path).
//
// NOTE FOR AI:
//  - The YouTube id is NEVER in the page HTML. It only arrives from the entitled
//    GET /api/free-videos/:id/watch (signed in; email is enough, no WhatsApp) and goes straight
//    into <YouTubeGuardedPlayer> with the admin's crop + autoPlay.
//  - Signed out: the cover is a link to /sign-in?redirect_url=/watch/<id>?freewatch=1 — the
//    marker makes the sign-in skip the WhatsApp gate and come back here, where the video plays
//    (signed in + ?freewatch=1 starts it on load).
//  - Clerk: only the lazily-loaded ClerkSessionBridge, and only for a visitor who has a session
//    cookie (hasClerkSessionHint) — a signed-out visitor never downloads Clerk. Never mount a
//    ClerkIsland here (one Clerk provider per page).
//  - First Play only: one postFreeVideoViewOnce + one PostHog saathum_video_play.
//  - The "Watch free" button greys to "Watching now" while the player is showing.
import { Suspense, lazy, useEffect, useRef, useState, type MouseEvent } from 'react';
import { IslandBoundary } from '../../components/IslandBoundary';
import { YouTubeGuardedPlayer } from '../../components/dash2/YouTubeGuardedPlayer';
import { toCrop, type VideoCrop } from '../../components/dash2/crop';
import { ApiError } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { FREE_WATCH_PARAM, signInUrlForFreeWatchPath } from '../../lib/authRedirect';
import { brandUrl } from '../../lib/brand';
import { cfImage } from '../../lib/config';
import { hasClerkSessionHint } from '../../lib/sessionHint';
import { whatsappShareVideoHref } from '../../lib/shareText';
import { getFreeVideoWatch, getFreeVideos, postFreeVideoViewOnce, type FreeVideoCardData } from './api';
import { FreeVideoCard, watchPath } from './FreeVideoCard';
import '../../components/eventpage/eventpage.css';
import '../home/BookNowShelf.css';
import './freevideos.css';

// [WEB-PERF-3] Clerk loads only for a visitor with a session cookie, in the background.
const loadClerk = () => import('../../lib/clerk');
const LazyClerkIsland = lazy(() => loadClerk().then((m) => ({ default: m.ClerkSessionBridge })));

type Phase =
  | { kind: 'cover' }
  | { kind: 'starting' }
  | { kind: 'error' }
  | { kind: 'player'; videoId: string; crop: VideoCrop | null };

const PlayIcon = () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>;
const WaIcon = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.6.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.8-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1 4.9 4.9 0 0 0 1 2.6 11.2 11.2 0 0 0 4.3 3.8c1.6.7 2.2.7 3 .6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c0-.1-.2-.2-.5-.3z" /></svg>;

function WatchInner({ video, onNeedAuth }: { video: FreeVideoCardData; onNeedAuth: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'cover' });
  // 'out' on the server and first client render (no hydration mismatch); the hint corrects it.
  const [signedIn, setSignedIn] = useState(false);
  const [more, setMore] = useState<FreeVideoCardData[]>([]);
  const tokenRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const playedRef = useRef(false);
  const path = watchPath(video.id);

  const start = async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setPhase({ kind: 'starting' });
    try {
      onNeedAuth(); // mount the lazy ClerkSessionBridge so the session can restore
      const token = await loadClerk().then((m) => m.getActiveTokenWaited(8000)).catch(() => null);
      if (!token) {
        // The cookie hint was stale (expired session): send him to sign in, back here with the marker.
        capture('free_video_watch_denied', { listing_id: video.id, error: 'no_token' });
        window.location.assign(signInUrlForFreeWatchPath(path));
        return;
      }
      tokenRef.current = token;
      const w = await getFreeVideoWatch(video.id, token);
      if (!w.youtube_video_id) throw new Error('no_video');
      setPhase({ kind: 'player', videoId: w.youtube_video_id, crop: toCrop(w.crop) });
      capture('free_video_player_started', { listing_id: video.id, live: Boolean(w.is_live) });
    } catch (err) {
      startedRef.current = false;
      if (err instanceof ApiError) {
        capture('free_video_watch_denied', { listing_id: video.id, error: err.error, status: err.status });
        if (err.status === 401) { window.location.assign(signInUrlForFreeWatchPath(path)); return; }
      } else {
        captureException(err, { surface: 'free_video_watch', listing_id: video.id });
      }
      setPhase({ kind: 'error' });
    }
  };

  useEffect(() => {
    const hint = hasClerkSessionHint();
    setSignedIn(hint);
    capture('free_video_page_view', { listing_id: video.id, signed_in: hint, live: video.is_live });
    // Back from the sign-in (or a signed-in click on a card): the marker means "play now".
    if (hint && new URLSearchParams(window.location.search).get(FREE_WATCH_PARAM) === '1') void start();
  }, [video.id]);

  // "More free videos": loaded in the background, hidden when there is nothing else.
  useEffect(() => {
    const ctrl = new AbortController();
    getFreeVideos({ limit: 4 }, ctrl.signal)
      .then((list) => setMore(list.filter((v) => v.id !== video.id).slice(0, 3)))
      .catch((err) => { if (!ctrl.signal.aborted) captureException(err, { surface: 'free_video_more', listing_id: video.id }); });
    return () => ctrl.abort();
  }, [video.id]);

  const href = signedIn ? `${path}?${FREE_WATCH_PARAM}=1` : signInUrlForFreeWatchPath(path);
  const click = (surface: 'hero' | 'button') => (e: MouseEvent<HTMLAnchorElement>) => {
    capture('free_video_watch_click', { listing_id: video.id, signed_in: signedIn, surface });
    if (!signedIn) return; // href = the email sign-in, which returns here and plays
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (phase.kind === 'player') return;
    void start();
    document.querySelector('.fv-hero')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const cover = video.cover_url ? cfImage(video.cover_url, { width: 1280 }) : null;
  const playing = phase.kind === 'player';
  const starting = phase.kind === 'starting';
  const shareHref = whatsappShareVideoHref({ title: video.title, url: brandUrl(path), categoryLabel: video.category_label });

  return (
    <>
      <div className="ep-photowrap fv-hero">
        <div className="ep-art">
          {cover ? <img src={cover} alt="" decoding="async" fetchPriority="high" /> : <div className="ep-art-empty">{video.category_label}</div>}
          {playing && (
            <div className="ep-live-cover ep-live-cover--player" aria-label="Free video">
              <YouTubeGuardedPlayer
                videoId={phase.videoId}
                title={video.title}
                autoPlay
                className="ep-live-guarded"
                crop={phase.crop}
                onPlay={() => {
                  // First Play only: one PostHog event + one server view count per page load.
                  if (playedRef.current) return;
                  playedRef.current = true;
                  capture('saathum_video_play', { listing_id: video.id, free: true, surface: 'free_video_page' });
                  if (tokenRef.current) postFreeVideoViewOnce(video.id, tokenRef.current);
                }}
                onError={(code) => capture('free_video_player_error', { listing_id: video.id, code })}
              />
            </div>
          )}
          {!playing && (
            <a
              className="ep-live-cover ep-live-cover--dim ep-live-watch"
              href={href}
              aria-label={`Watch ${video.title} for free`}
              aria-busy={starting}
              onClick={click('hero')}
            >
              <span className="ep-pill ep-pill--live"><i />{video.is_live ? 'LIVE · FREE' : 'Free video'}</span>
              <span className="ep-live-watch-play" aria-hidden="true"><PlayIcon /></span>
              <span className="ep-live-watch-text">
                {starting ? 'Starting your video…'
                  : phase.kind === 'error' ? 'We couldn’t start the video. Click to try again.'
                    : signedIn ? 'Click to watch free' : 'Click to watch free — sign in with your email'}
              </span>
            </a>
          )}
        </div>
      </div>

      <div className="fv-info">
        <span className="fv-cat">{video.category_label}</span>
        <h1 className="fv-title">{video.title}</h1>
        {video.description && <p className="fv-desc">{video.description}</p>}
        <div className="fv-actions">
          {playing
            ? <span className="ep-btn ep-btn--book fv-watch-btn" aria-disabled="true" data-fv-action="watching-now">Watching now</span>
            : (
              <a className="ep-btn ep-btn--book fv-watch-btn" href={href} data-fv-action="watch-free" aria-busy={starting} onClick={click('button')}>
                {starting ? 'Starting…' : <>Watch free <span aria-hidden="true">→</span></>}
              </a>
            )}
          <a
            className="ep-ib ep-ib--wa fv-share"
            href={shareHref}
            target="_blank"
            rel="noopener"
            title="Share on WhatsApp"
            aria-label={`Share ${video.title} on WhatsApp`}
            onClick={() => capture('free_video_share_click', { listing_id: video.id, channel: 'whatsapp' })}
          ><WaIcon /></a>
        </div>
        {!signedIn && !playing && <p className="ep-fine">Free to watch. You only need to sign in with your email.</p>}
      </div>

      {more.length > 0 && (
        <section className="fv-more" aria-labelledby="fv-more-title">
          <div className="fv-more-head">
            <h2 id="fv-more-title">More free videos</h2>
            <a className="fv-more-all" href="/free-videos" onClick={() => capture('free_videos_see_all_click', { surface: 'free_video_page' })}>See all <span aria-hidden="true">→</span></a>
          </div>
          <div className={'bn-grid bn-grid--' + more.length}>
            {more.map((v, i) => <FreeVideoCard key={v.id} v={v} surface="free_video_page_more" position={i} />)}
          </div>
        </section>
      )}
    </>
  );
}

export default function FreeVideoWatch({ video }: { video: FreeVideoCardData }) {
  const [withClerk, setWithClerk] = useState(false);
  return (
    <IslandBoundary island="free-video-watch">
      {withClerk && (
        <Suspense fallback={null}>
          <LazyClerkIsland />
        </Suspense>
      )}
      <WatchInner video={video} onNeedAuth={() => setWithClerk(true)} />
    </IslandBoundary>
  );
}
