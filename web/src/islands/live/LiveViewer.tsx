// LiveViewer — the /watch/<id> island orchestrator (PHASE-C).
//
// Flow (gating model = MASTER-PROMPT §4b):
//   1. Page loads UNGATED → poster + "Join" button.
//   2. Join → requireGuestAuth() (opens GuestGate only if no session) →
//      GET /api/live/:id/join with the JWT.
//        • 403 "no paid order" → "Book to watch" CTA → /book/<id> (Phase B).
//        • state !== 'live' → countdown to starts_at, poll /join until live.
//        • live → play (WHEP first, LL-HLS fallback) + open the room socket.
//   3. session_ended (room WS) → tear everything down, show an "ended" card.
//
// Live = Cloudflare Stream Live (WHEP / LL-HLS). NO LiveKit, no media SDK;
// `hls.js` is dynamic-imported only when the fallback triggers.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ClerkIsland, requireGuestAuth } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { cfImage } from '../../lib/config';
import { Spinner } from '../../components';
import { WhepPlayer, type WhepStatus } from './WhepPlayer';
import { HlsFallback, type HlsStatus } from './HlsFallback';
import { useLiveRoom, roomUrlFor } from './room';
import { LiveChat } from './LiveChat';
import { ViewerCount } from './ViewerCount';
import { DonateButton } from './DonateButton';

export interface LiveViewerProps {
  listingId: string;
  title?: string;
  poster?: string | null;
  creatorHandle?: string | null;
}

interface JoinResponse {
  ok: boolean;
  whep: string | null;
  hls: string | null;
  state: string; // scheduled | live | ended
  live?: boolean;
  starts_at: number | null;
  ends_at: number | null;
  title?: string;
  creator_id?: string;
  room_token?: string;
}

type Phase = 'idle' | 'joining' | 'waiting' | 'live' | 'ended' | 'noticket' | 'error';
type Transport = 'whep' | 'hls' | null;

interface State {
  phase: Phase;
  join: JoinResponse | null;
  token: string | null;
  creatorHref: string | null;
  errorMsg: string | null;
}

type Action =
  | { t: 'joining' }
  | { t: 'joined'; join: JoinResponse; token: string; creatorHref: string }
  | { t: 'waiting'; join: JoinResponse; token: string; creatorHref: string }
  | { t: 'noticket' }
  | { t: 'ended' }
  | { t: 'error'; msg: string }
  | { t: 'reset' };

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'joining': return { ...s, phase: 'joining', errorMsg: null };
    case 'joined': return { ...s, phase: 'live', join: a.join, token: a.token, creatorHref: a.creatorHref };
    case 'waiting': return { ...s, phase: 'waiting', join: a.join, token: a.token, creatorHref: a.creatorHref };
    case 'noticket': return { ...s, phase: 'noticket' };
    case 'ended': return { ...s, phase: 'ended' };
    case 'error': return { ...s, phase: 'error', errorMsg: a.msg };
    case 'reset': return { ...s, phase: 'idle', errorMsg: null };
    default: return s;
  }
}

function Inner({ listingId, title, poster, creatorHandle }: LiveViewerProps) {
  const [state, dispatch] = useReducer(reducer, {
    phase: 'idle', join: null, token: null,
    creatorHref: creatorHandle ? `/c/${encodeURIComponent(creatorHandle)}` : null,
    errorMsg: null,
  });
  const bookHref = `/book/${encodeURIComponent(listingId)}`;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const whepRef = useRef<WhepPlayer | null>(null);
  const hlsRef = useRef<HlsFallback | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [transport, setTransport] = useState<Transport>(null);
  const [muted, setMuted] = useState(true);
  const [playerNote, setPlayerNote] = useState<string | null>(null);

  // ── Room socket (only once we have a token + we're live/waiting) ──────────
  const roomUrl =
    state.join?.room_token && (state.phase === 'live' || state.phase === 'waiting')
      ? roomUrlFor(listingId, state.join.room_token)
      : null;
  const room = useLiveRoom(roomUrl);

  // ── Join (the gated action) ───────────────────────────────────────────────
  const doJoin = useCallback(async () => {
    dispatch({ t: 'joining' });
    let jwt: string;
    try {
      jwt = await requireGuestAuth();
    } catch {
      dispatch({ t: 'reset' }); // gate dismissed
      return;
    }
    try {
      const j = await request<JoinResponse>(`/api/live/${encodeURIComponent(listingId)}/join`, { auth: jwt });
      const creatorHref =
        (creatorHandle && `/c/${encodeURIComponent(creatorHandle)}`) ||
        (j.creator_id ? `/c/${encodeURIComponent(j.creator_id)}` : '/explore');
      if (j.state === 'ended') { dispatch({ t: 'ended' }); return; }
      if (j.live === true && j.whep) dispatch({ t: 'joined', join: j, token: jwt, creatorHref });
      else dispatch({ t: 'waiting', join: j, token: jwt, creatorHref });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) dispatch({ t: 'noticket' });
      else dispatch({ t: 'error', msg: e instanceof ApiError ? e.error : 'Could not join the stream.' });
    }
  }, [listingId, creatorHandle]);

  // ── While waiting: poll /join until the stream goes live ──────────────────
  useEffect(() => {
    if (state.phase !== 'waiting' || !state.token) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const j = await request<JoinResponse>(`/api/live/${encodeURIComponent(listingId)}/join`, { auth: state.token });
        if (cancelled) return;
        if (j.state === 'ended') { dispatch({ t: 'ended' }); return; }
        if (j.live === true && j.whep) {
          dispatch({ t: 'joined', join: j, token: state.token!, creatorHref: state.creatorHref ?? '/explore' });
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (!cancelled) pollRef.current = setTimeout(tick, 6000);
    };
    pollRef.current = setTimeout(tick, 6000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [state.phase, state.token, state.creatorHref, listingId]);

  // ── Player: WHEP first, LL-HLS fallback ───────────────────────────────────
  const startHls = useCallback(async (hls: string) => {
    setTransport('hls');
    setPlayerNote('Low-latency unavailable — using HLS');
    const video = videoRef.current;
    if (!video) return;
    const player = new HlsFallback({
      url: hls,
      video,
      onStatus: (s: HlsStatus, d) => {
        if (s === 'failed') setPlayerNote(`Playback error${d ? ` (${d})` : ''}`);
      },
    });
    hlsRef.current = player;
    try { await player.start(); } catch { setPlayerNote('Could not start playback.'); }
  }, []);

  useEffect(() => {
    if (state.phase !== 'live' || !state.join) return;
    const { whep, hls } = state.join;
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;

    const begin = async () => {
      if (whep) {
        const player = new WhepPlayer({
          url: whep,
          video,
          onStatus: (s: WhepStatus, d) => {
            if (disposed) return;
            if (s === 'playing') { setTransport('whep'); setPlayerNote(null); }
            else if (s === 'failed') {
              // tear down WHEP and fall back to HLS if we have a URL
              whepRef.current?.close();
              whepRef.current = null;
              if (hls && transport !== 'hls') void startHls(hls);
              else if (!hls) setPlayerNote(`Stream error${d ? ` (${d})` : ''}`);
            }
          },
        });
        whepRef.current = player;
        try {
          await player.start();
        } catch {
          if (disposed) return;
          if (hls) void startHls(hls);
          else setPlayerNote('Could not connect to the stream.');
        }
      } else if (hls) {
        void startHls(hls);
      } else {
        setPlayerNote('Stream not available yet.');
      }
    };
    void begin();

    return () => {
      disposed = true;
      whepRef.current?.close();
      whepRef.current = null;
      hlsRef.current?.close();
      hlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.join]);

  // ── Lifecycle: room broadcasts session_ended → tear down + ended card ─────
  useEffect(() => {
    if (room.ended && state.phase === 'live') {
      whepRef.current?.close();
      hlsRef.current?.close();
      dispatch({ t: 'ended' });
    }
  }, [room.ended, state.phase]);

  const unmute = () => {
    const v = videoRef.current;
    if (v) { v.muted = false; v.play().catch(() => {}); setMuted(false); }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (state.phase === 'idle' || state.phase === 'joining' || state.phase === 'error' || state.phase === 'noticket') {
    return (
      <PosterGate
        title={title}
        poster={poster}
        phase={state.phase}
        errorMsg={state.errorMsg}
        bookHref={bookHref}
        onJoin={doJoin}
        onRetry={() => dispatch({ t: 'reset' })}
      />
    );
  }

  if (state.phase === 'ended') {
    return <EndedCard title={title} creatorHref={state.creatorHref ?? '/explore'} />;
  }

  // waiting | live
  const startsAt = state.join?.starts_at ?? null;
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-0 px-0 md:grid-cols-[1fr_360px] md:gap-4 md:px-4 md:py-4">
      {/* Stage */}
      <div className="relative flex flex-col bg-ink md:rounded-zine md:border-zine md:border-ink md:overflow-hidden md:shadow-zine">
        <div className="relative aspect-video w-full bg-ink">
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full bg-ink object-contain"
            playsInline
            autoPlay
            muted={muted}
            poster={poster ? cfImage(poster, { width: 1280, fit: 'cover' }) : undefined}
          />

          {state.phase === 'waiting' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/80 px-6 text-center">
              <Countdown startsAt={startsAt} />
            </div>
          )}

          {/* top-left status */}
          <div className="absolute left-3 top-3">
            <ViewerCount viewers={room.viewers} conn={room.conn} hostLive={room.hostLive} />
          </div>

          {/* transport note */}
          {playerNote && (
            <div className="absolute bottom-3 left-3 rounded-zineSm border-zine border-ink bg-card px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.04em] text-inkSoft shadow-zine-xs">
              {playerNote}
            </div>
          )}

          {/* unmute prompt (autoplay policy) */}
          {state.phase === 'live' && muted && transport && (
            <button
              type="button"
              onClick={unmute}
              className="absolute bottom-3 right-3 rounded-full border-zine border-ink bg-lime px-3.5 py-2 font-display font-semibold text-[14px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-y-[2px] active:shadow-zine-pressed"
            >
              🔇 Tap to unmute
            </button>
          )}

          {/* donation banner */}
          {room.lastDonation && (
            <DonationBanner
              key={room.lastDonation.id}
              name={room.lastDonation.name}
              amount={room.lastDonation.amount}
              onDone={room.clearDonation}
            />
          )}
        </div>

        {/* action bar */}
        <div className="flex items-center gap-3 border-t-zine border-ink bg-paper px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate font-display font-semibold text-[16px] text-ink">{title ?? state.join?.title ?? 'Live'}</p>
            {room.donationsCount > 0 && (
              <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-mintInk">
                {room.donationsTotal} AvaCoins · {room.donationsCount} gifts
              </p>
            )}
          </div>
          <DonateButton listingId={listingId} auth={state.token} requireAuth={requireGuestAuth} />
        </div>

        {room.pinned && (
          <div className="border-t-zine border-ink bg-blue px-3 py-2 font-body font-bold text-[13px] text-ink">
            📌 {room.pinned}
          </div>
        )}
      </div>

      {/* Chat (sidebar on desktop, stacked on mobile) */}
      <aside className="flex h-[60vh] min-h-0 flex-col bg-card md:h-auto md:rounded-zine md:border-zine md:border-ink md:overflow-hidden md:shadow-zine-sm">
        <div className="border-b-zine border-ink px-3 py-2 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-inkSoft">
          Live chat
        </div>
        <div className="min-h-0 flex-1">
          <LiveChat
            messages={room.messages}
            onSend={room.sendChat}
            onReact={room.sendReaction}
            warn={room.warn}
            onWarnSeen={room.clearWarn}
            disabled={state.phase !== 'live' && state.phase !== 'waiting'}
          />
        </div>
      </aside>
    </div>
  );
}

// ── sub-views ───────────────────────────────────────────────────────────────

function PosterGate({
  title, poster, phase, errorMsg, bookHref, onJoin, onRetry,
}: {
  title?: string; poster?: string | null; phase: Phase; errorMsg: string | null;
  bookHref: string; onJoin: () => void; onRetry: () => void;
}) {
  const joining = phase === 'joining';
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="overflow-hidden rounded-zine border-zine border-ink bg-paper2 shadow-zine">
        <div className="relative aspect-video w-full bg-ink">
          {poster ? (
            <img src={cfImage(poster, { width: 1280, fit: 'cover' })} alt={title ?? 'Live'} className="h-full w-full object-cover opacity-90" />
          ) : (
            <div className="flex h-full w-full items-center justify-center font-mono uppercase tracking-[0.08em] text-inkMute">Live</div>
          )}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-ink/55 px-6 text-center">
            <h1 className="font-display font-semibold text-[26px] leading-tight text-white drop-shadow">{title ?? 'Live stream'}</h1>

            {phase === 'noticket' ? (
              <div className="flex flex-col items-center gap-2">
                <p className="font-body font-bold text-[15px] text-white/90">You need a ticket to watch this stream.</p>
                <a href={bookHref} className="rounded-full border-zine border-ink bg-lime px-7 py-3.5 font-display font-semibold text-[18px] text-ink no-underline shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed">
                  Book to watch
                </a>
              </div>
            ) : phase === 'error' ? (
              <div className="flex flex-col items-center gap-2">
                <p className="font-body font-bold text-[15px] text-white/90">{errorMsg}</p>
                <button type="button" onClick={onRetry} className="rounded-full border-zine border-ink bg-card px-6 py-3 font-display font-semibold text-[16px] text-ink shadow-zine-sm">
                  Try again
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={onJoin}
                disabled={joining}
                className="inline-flex items-center gap-2.5 rounded-full border-zine border-ink bg-lime px-8 py-4 font-display font-semibold text-[20px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed disabled:opacity-80"
              >
                {joining ? <><Spinner size={18} /> Joining…</> : <>▶ Join the stream</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EndedCard({ title, creatorHref }: { title?: string; creatorHref: string }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <div className="rounded-zine border-zine border-ink bg-card p-10 shadow-zine">
        <p className="font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-coral">Stream ended</p>
        <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink">{title ?? 'This live has ended'}</h1>
        <p className="mt-2 font-body font-bold text-[15px] text-inkSoft">Thanks for watching. Catch the creator's next one.</p>
        <a href={creatorHref} className="mt-6 inline-flex rounded-full border-zine border-ink bg-lime px-7 py-3.5 font-display font-semibold text-[18px] text-ink no-underline shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed">
          View the creator
        </a>
      </div>
    </div>
  );
}

function Countdown({ startsAt }: { startsAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!startsAt) {
    return (
      <>
        <Spinner size={22} color="#fff" />
        <p className="font-display font-semibold text-[18px] text-white">Waiting for the creator to go live…</p>
      </>
    );
  }
  const ms = Math.max(0, startsAt - now);
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = d > 0 ? [`${d}d`, `${h}h`, `${m}m`] : h > 0 ? [`${h}h`, `${m}m`, `${sec}s`] : [`${m}m`, `${sec}s`];
  return (
    <>
      <p className="font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-white/80">Starts in</p>
      <p className="font-mono font-bold text-[34px] tabular-nums text-white">{ms <= 0 ? 'any moment…' : parts.join(' ')}</p>
      <p className="font-body font-bold text-[14px] text-white/80">Hang tight — you'll be pulled in automatically.</p>
    </>
  );
}

function DonationBanner({ name, amount, onDone }: { name: string; amount: number; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4200);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div
      className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full border-zine border-ink bg-mint px-4 py-2 font-display font-semibold text-[15px] text-mintInk shadow-zine"
      style={{ animation: 'zine-drop 0.4s ease-out' }}
    >
      ✨ {name} donated {amount} AvaCoins
      <style>{'@keyframes zine-drop{0%{transform:translate(-50%,-16px);opacity:0}100%{transform:translate(-50%,0);opacity:1}}'}</style>
    </div>
  );
}

/** Public entry: wraps the viewer in <ClerkIsland> so requireGuestAuth() works. */
export function LiveViewer(props: LiveViewerProps) {
  return (
    <ClerkIsland>
      <Inner {...props} />
    </ClerkIsland>
  );
}

export default LiveViewer;
