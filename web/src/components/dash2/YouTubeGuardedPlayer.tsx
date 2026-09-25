// YouTubeGuardedPlayer — [DASH2-EVENTS 2026-09-25]. Owner decision "VIDEO = YOUTUBE"
// (Specs/SPEC-2026-09-25-DASHBOARD-2.md): an unlisted YouTube live/replay embedded so
// that NO click ever reaches YouTube.
//
//  - IFrame Player API, loaded once, on www.youtube-nocookie.com, with YouTube's own
//    controls, keyboard, fullscreen, captions and annotations all off.
//  - A transparent shield covers the WHOLE iframe (logo, title, "Watch on YouTube",
//    channel avatar, pause/end-screen suggestions, right-click menu). Clicking it
//    toggles play; right-click is swallowed.
//  - Our own control bar drives the player. Fullscreen is OUR wrapper (shield
//    included) — never YouTube's. iPhone Safari cannot fullscreen an element, so it
//    gets a CSS pseudo-fullscreen that covers the viewport instead.
//  - Before the first play and after the end we paint our own poster over the frame,
//    so YouTube's title card and end-screen grid are never even visible.
//  - Never renders a link to youtube.com.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { Maximize, Minimize, Pause, Play, Square, Volume2, VolumeX, Loader2, VideoOff } from 'lucide-react';
import { cn } from '../../lib/utils';
import { youtubeThumb } from './shared';

// ─────────────────────────── minimal YT typings ───────────────────────────
interface YTPlayer {
  playVideo(): void; pauseVideo(): void; stopVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  mute(): void; unMute(): void; isMuted(): boolean;
  setVolume(v: number): void; getVolume(): number;
  getCurrentTime(): number; getDuration(): number; getPlayerState(): number;
  getVideoData?(): { isLive?: boolean; video_id?: string };
  destroy(): void;
}
interface YTNamespace {
  Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer;
}
declare global {
  interface Window { YT?: YTNamespace & { loaded?: number }; onYouTubeIframeAPIReady?: () => void }
}

const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

let apiPromise: Promise<YTNamespace> | null = null;
/** Load https://www.youtube.com/iframe_api exactly once per page. */
function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (window.YT?.Player) resolve(window.YT); else reject(new Error('yt_api_missing'));
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { apiPromise = null; reject(new Error('yt_api_load_failed')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function errorText(code: number): string {
  if (code === 101 || code === 150) return 'This video can’t be played here — ask support.';
  if (code === 100) return 'This video isn’t available any more — ask support.';
  if (code === 2) return 'This video link looks wrong — ask support.';
  if (code === -1) return 'The video player couldn’t load. Check your connection and try again.';
  return 'This video couldn’t be played. Please try again in a moment.';
}

export interface GuardedPlayerHandle { play(): void; pause(): void }
export interface YouTubeGuardedPlayerProps {
  videoId: string;
  title: string;
  /** Poster painted over the frame before first play / after end. Defaults to the video's thumbnail. */
  poster?: string | null;
  autoPlay?: boolean;
  className?: string;
  onPlay?: (info: { isLive: boolean }) => void;
  onError?: (code: number) => void;
}

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export const YouTubeGuardedPlayer = forwardRef<GuardedPlayerHandle, YouTubeGuardedPlayerProps>(function YouTubeGuardedPlayer(
  { videoId, title, poster, autoPlay = false, className, onPlay, onError },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const firstPlayReported = useRef(false);
  const cbRef = useRef({ onPlay, onError });
  cbRef.current = { onPlay, onError };

  const [ready, setReady] = useState(false);
  const [state, setState] = useState<number>(S.UNSTARTED);
  const [started, setStarted] = useState(false);
  const [err, setErr] = useState<number | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLive, setIsLive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  const [fs, setFs] = useState(false);
  const [pseudoFs, setPseudoFs] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [pendingPlay, setPendingPlay] = useState(autoPlay);
  const [loadKey, setLoadKey] = useState(0);

  const playing = state === S.PLAYING || state === S.BUFFERING;

  // ── build / tear down the player ──
  useEffect(() => {
    let cancelled = false;
    setReady(false); setErr(null); setStarted(false); setState(S.UNSTARTED); setTime(0); setDuration(0); setIsLive(false);
    firstPlayReported.current = false;
    const host = hostRef.current;
    if (!host) return;
    // YT replaces its mount node with the iframe; give it a node React doesn't own.
    const mount = document.createElement('div');
    host.appendChild(mount);
    loadYouTubeApi().then((YT) => {
      if (cancelled) return;
      playerRef.current = new YT.Player(mount, {
        host: 'https://www.youtube-nocookie.com',
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0, rel: 0, modestbranding: 1, disablekb: 1, playsinline: 1,
          iv_load_policy: 3, fs: 0, cc_load_policy: 0, autoplay: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            if (cancelled) return;
            const p = playerRef.current;
            if (p) { setMuted(p.isMuted()); setVolume(p.getVolume()); }
            // The iframe must not be tabbable or focusable — keyboard lives on our wrapper.
            const iframe = host.querySelector('iframe');
            if (iframe) { iframe.setAttribute('tabindex', '-1'); iframe.setAttribute('title', title); iframe.setAttribute('aria-hidden', 'true'); }
            setReady(true);
          },
          onStateChange: (e: { data: number }) => {
            if (cancelled) return;
            setState(e.data);
            const p = playerRef.current;
            if (e.data === S.PLAYING) {
              setStarted(true);
              const d = p?.getDuration() ?? 0;
              const live = d === 0 || !!p?.getVideoData?.()?.isLive;
              setIsLive(live); setDuration(d);
              if (!firstPlayReported.current) { firstPlayReported.current = true; cbRef.current.onPlay?.({ isLive: live }); }
            }
            if (e.data === S.ENDED) { setStarted(false); setControlsVisible(true); }
          },
          onError: (e: { data: number }) => {
            if (cancelled) return;
            setErr(e.data);
            cbRef.current.onError?.(e.data);
          },
        },
      });
    }).catch(() => {
      if (cancelled) return;
      setErr(-1);
      cbRef.current.onError?.(-1);
    });
    return () => {
      cancelled = true;
      try { playerRef.current?.destroy(); } catch { /* already gone */ }
      playerRef.current = null;
      host.innerHTML = '';
    };
    // title is applied once on ready; a title change must not rebuild the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, loadKey]);

  // Deferred play (autoPlay, or play() before ready).
  useEffect(() => {
    if (ready && pendingPlay) { playerRef.current?.playVideo(); setPendingPlay(false); }
  }, [ready, pendingPlay]);

  // Progress polling while playing.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      setTime(p.getCurrentTime());
      const d = p.getDuration();
      setDuration(d);
      if (d === 0 || p.getVideoData?.()?.isLive) setIsLive(true);
    }, 250);
    return () => window.clearInterval(id);
  }, [playing]);

  // ── controls ──
  const play = useCallback(() => {
    if (err != null) return;
    if (!playerRef.current || !ready) { setPendingPlay(true); return; }
    playerRef.current.playVideo();
  }, [ready, err]);
  const pause = useCallback(() => { playerRef.current?.pauseVideo(); }, []);
  const toggle = useCallback(() => { if (playing) pause(); else play(); }, [playing, play, pause]);
  const stop = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    p.stopVideo(); p.seekTo(0, true); p.pauseVideo();
    setTime(0); setStarted(false); setState(S.CUED);
  }, []);
  const seek = useCallback((t: number) => { playerRef.current?.seekTo(t, true); setTime(t); }, []);
  const toggleMute = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isMuted() || volume === 0) { p.unMute(); if (volume === 0) { p.setVolume(60); setVolume(60); } setMuted(false); }
    else { p.mute(); setMuted(true); }
  }, [volume]);
  const changeVolume = useCallback((v: number) => {
    const p = playerRef.current;
    if (!p) return;
    p.setVolume(v); setVolume(v);
    if (v === 0) { p.mute(); setMuted(true); } else if (p.isMuted()) { p.unMute(); setMuted(false); }
  }, []);

  useImperativeHandle(ref, () => ({ play, pause }), [play, pause]);

  // ── fullscreen: our wrapper, or pseudo-fullscreen where the element API is missing ──
  useEffect(() => {
    const on = () => {
      const d = document as FsDoc;
      setFs((d.fullscreenElement ?? d.webkitFullscreenElement ?? null) === wrapRef.current);
    };
    document.addEventListener('fullscreenchange', on);
    document.addEventListener('webkitfullscreenchange', on);
    return () => { document.removeEventListener('fullscreenchange', on); document.removeEventListener('webkitfullscreenchange', on); };
  }, []);
  useEffect(() => {
    if (!pseudoFs) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    // position:fixed is relative to the nearest transformed/filtered ancestor, and
    // the Dialog and the vaul Drawer both transform. Neutralise those ancestors
    // while pseudo-fullscreen is on (the iframe can't be moved — it would reload).
    const touched: { el: HTMLElement; css: string }[] = [];
    for (let el = wrapRef.current?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const bf = (cs as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
      if (cs.transform !== 'none' || cs.filter !== 'none' || cs.backdropFilter !== 'none' && cs.backdropFilter !== '' || (bf && bf !== 'none')
        || cs.perspective !== 'none' || /transform|filter|perspective/.test(cs.willChange) || /paint|layout|strict|content/.test(cs.contain)) {
        touched.push({ el, css: el.style.cssText });
        el.style.setProperty('transform', 'none', 'important');
        el.style.setProperty('filter', 'none', 'important');
        el.style.setProperty('backdrop-filter', 'none', 'important');
        el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        el.style.setProperty('perspective', 'none', 'important');
        el.style.setProperty('will-change', 'auto', 'important');
        el.style.setProperty('contain', 'none', 'important');
        el.style.setProperty('animation', 'none', 'important');
      }
    }
    return () => {
      document.documentElement.style.overflow = prev;
      for (const t of touched) t.el.style.cssText = t.css;
    };
  }, [pseudoFs]);
  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current as FsEl | null;
    const d = document as FsDoc;
    if (!el) return;
    if (pseudoFs) { setPseudoFs(false); return; }
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen?.bind(d) ?? d.webkitExitFullscreen?.bind(d))?.();
      return;
    }
    const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (req && (document.fullscreenEnabled ?? true)) {
      try {
        const r = req();
        if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => setPseudoFs(true));
      } catch { setPseudoFs(true); }
    } else {
      setPseudoFs(true);
    }
  }, [pseudoFs]);
  const expanded = fs || pseudoFs;

  // ── auto-hide controls after 3s of stillness while playing ──
  const poke = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 3000);
  }, []);
  useEffect(() => {
    if (!playing) { window.clearTimeout(hideTimer.current); setControlsVisible(true); return; }
    poke();
    return () => window.clearTimeout(hideTimer.current);
  }, [playing, poke]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); poke(); }
    else if (k === 'f') { e.preventDefault(); toggleFullscreen(); }
    else if (k === 'm') { e.preventDefault(); toggleMute(); poke(); }
    else if (k === 'escape' && pseudoFs) { e.preventDefault(); setPseudoFs(false); }
  };

  const showPoster = err == null && !started;
  const posterSrc = poster || youtubeThumb(videoId);
  const btn = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-grand-cream transition-colors hover:bg-accent-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grand-gold';
  const hideCls = !controlsVisible && playing ? 'pointer-events-none opacity-0' : 'opacity-100';

  return (
    <div
      ref={wrapRef}
      role="region"
      aria-label={`Video player: ${title}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseMove={poke}
      onTouchStart={poke}
      className={cn(
        'd2-player group relative w-full overflow-hidden rounded-xl bg-grand-ink outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring',
        pseudoFs && 'd2-player-pseudo-fs',
        !controlsVisible && playing && 'cursor-none',
        className,
      )}
    >
      <div className="d2-player-frame relative aspect-video w-full">
        {/* YouTube mounts its iframe in here. */}
        <div ref={hostRef} className="absolute inset-0" />

        {/* Our poster: hides YouTube's title card before play and its end-screen grid after. */}
        {showPoster && (
          <div className="absolute inset-0 z-[5]">
            <img src={posterSrc} alt="" className="h-full w-full object-cover" draggable={false} />
            <div className="absolute inset-0 bg-gradient-to-t from-scrim/85 via-scrim/25 to-scrim/10" />
          </div>
        )}

        {/* THE SHIELD — covers the entire iframe; nothing below it is clickable. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 z-10 select-none"
          style={{ pointerEvents: 'auto', WebkitTouchCallout: 'none' }}
          onClick={() => { if (err == null) { toggle(); poke(); } }}
          onDoubleClick={(e) => { e.preventDefault(); toggleFullscreen(); }}
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* Centre state: big play, spinner, or error. */}
        {err != null ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-scrim/90 px-6 text-center" onContextMenu={(e) => e.preventDefault()}>
            <VideoOff className="h-8 w-8 text-grand-gold" />
            <p className="max-w-sm text-[15px] font-bold text-grand-cream">{errorText(err)}</p>
            {err === -1 && (
              <button type="button" onClick={() => setLoadKey((n) => n + 1)} className="rounded-full border border-border/70 px-4 py-2 text-sm font-bold text-grand-cream hover:bg-accent-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grand-gold">
                Try again
              </button>
            )}
          </div>
        ) : !playing ? (
          <button
            type="button"
            onClick={() => { play(); poke(); }}
            aria-label={state === S.PAUSED ? 'Resume' : 'Play'}
            className="absolute left-1/2 top-1/2 z-20 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[var(--dash-shadow-lg)] ring-4 ring-accent-foreground/25 transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-grand-gold motion-reduce:transition-none motion-reduce:hover:scale-100 sm:h-20 sm:w-20"
          >
            {pendingPlay || state === S.BUFFERING ? <Loader2 className="h-8 w-8 animate-spin" /> : <Play className="ml-1 h-8 w-8 fill-current" />}
          </button>
        ) : state === S.BUFFERING ? (
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 text-grand-cream"><Loader2 className="h-10 w-10 animate-spin" /></div>
        ) : null}

        {isLive && started && (
          <span className="pointer-events-none absolute left-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 text-[12px] font-extrabold tracking-[0.12em] text-primary-foreground shadow">
            <span className="h-2 w-2 rounded-full bg-primary-foreground" /> LIVE
          </span>
        )}

        {/* OUR control bar. */}
        {err == null && (
          <div
            className={cn(
              'absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-scrim/90 via-scrim/55 to-transparent px-2 pb-2 pt-10 transition-opacity duration-300 motion-reduce:transition-none sm:px-3',
              hideCls,
            )}
            onContextMenu={(e) => e.preventDefault()}
          >
            {!isLive && duration > 0 && (
              <input
                type="range"
                min={0}
                max={duration}
                step={0.1}
                value={Math.min(time, duration)}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="Seek"
                aria-valuetext={`${fmtTime(time)} of ${fmtTime(duration)}`}
                className="mb-1 block h-1.5 w-full cursor-pointer"
              />
            )}
            <div className="flex items-center gap-1 text-grand-cream">
              <button type="button" className={btn} onClick={() => { toggle(); poke(); }} aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
              </button>
              <button type="button" className={btn} onClick={stop} aria-label="Stop" disabled={!ready}>
                <Square className="h-4 w-4 fill-current" />
              </button>
              <button type="button" className={btn} onClick={toggleMute} aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'} disabled={!ready}>
                {muted || volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={muted ? 0 : volume}
                onChange={(e) => changeVolume(Number(e.target.value))}
                aria-label="Volume"
                className="hidden w-20 cursor-pointer sm:block"
                disabled={!ready}
              />
              <span className="ml-1 whitespace-nowrap text-[13px] font-bold tabular-nums tracking-[0.02em]">
                {isLive ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2 py-0.5 text-[11px] font-extrabold tracking-[0.12em] text-primary-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" /> LIVE
                  </span>
                ) : duration > 0 ? `${fmtTime(time)} / ${fmtTime(duration)}` : ''}
              </span>
              <span className="flex-1" />
              <button type="button" className={btn} onClick={toggleFullscreen} aria-label={expanded ? 'Exit full screen' : 'Full screen'}>
                {expanded ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default YouTubeGuardedPlayer;
