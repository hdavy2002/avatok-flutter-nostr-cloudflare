// LiveGsViewer — the /live/<id> island orchestrator. [WEB-GS-LIVE-1]
//
// New TRANSPORT for the paid-live-event product (GetStream, region Mumbai — see
// SPEC-2026-08-24 and CLAUDE.md's PRODUCT PIVOT). This is not a new brand: the
// poster/join gate, the "ended" card and the chat sidebar deliberately reuse the
// zine presentation of web/src/islands/live/LiveViewer.tsx. What's new is the
// transport underneath (GetStream instead of Cloudflare WHEP/HLS) and the six
// authorization outcomes lib/getstream.ts's `joinCommercialSession` can return —
// each one gets its own screen per SPEC-2026-09-01 §4.2. `needs_ticket` is a
// FEATURE (buy-while-live), not an error — see the dedicated branch below.
//
// HARD RULE (getstream.ts, restated): this island never constructs a GetStream
// call type or call id. Both come from the join response verbatim. A viewer
// never requests a local camera or microphone — LiveStage only ever renders the
// host's remote track.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { StreamVideo, StreamCall, type Call } from '@stream-io/video-react-sdk';
import { ClerkIsland, requireGuestAuth } from '../../lib/clerk';
import { cfImage } from '../../lib/config';
import { inrOrFree } from '../../lib/money';
import { Spinner } from '../../components';
import {
  joinCommercialSession,
  streamClientFor,
  type CommercialJoinCredentials,
  type JoinRefusal,
} from '../../lib/getstream';
import { LiveStage } from './LiveStage';

export interface LiveGsViewerProps {
  listingId: string;
  title?: string;
  poster?: string | null;
  price?: number | null;
  creatorName?: string | null;
  creatorHandle?: string | null;
  creatorAvatar?: string | null;
}

type Phase = 'idle' | 'authing' | 'joining' | 'refused' | 'live' | 'left';

interface State {
  phase: Phase;
  refusal: JoinRefusal | null;
  creds: CommercialJoinCredentials | null;
}

type Action =
  | { t: 'authing' }
  | { t: 'joining' }
  | { t: 'refused'; refusal: JoinRefusal }
  | { t: 'live'; creds: CommercialJoinCredentials }
  | { t: 'left' }
  | { t: 'reset' };

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'authing': return { ...s, phase: 'authing', refusal: null };
    case 'joining': return { ...s, phase: 'joining', refusal: null };
    case 'refused': return { ...s, phase: 'refused', refusal: a.refusal };
    case 'live': return { ...s, phase: 'live', creds: a.creds };
    case 'left': return { ...s, phase: 'left' };
    case 'reset': return { ...s, phase: 'idle', refusal: null };
    default: return s;
  }
}

function Inner({ listingId, title, poster, price, creatorName, creatorHandle, creatorAvatar }: LiveGsViewerProps) {
  const [state, dispatch] = useReducer(reducer, { phase: 'idle', refusal: null, creds: null });
  const jwtRef = useRef<string | null>(null);
  const [client, setClient] = useState<Awaited<ReturnType<typeof streamClientFor>> | null>(null);
  const [call, setCall] = useState<Call | null>(null);

  const bookHref = `/book/${encodeURIComponent(listingId)}`;
  const creatorHref = creatorHandle ? `/c/${encodeURIComponent(creatorHandle)}` : '/explore';

  const attemptJoin = useCallback(async () => {
    dispatch({ t: 'authing' });
    let jwt: string;
    try {
      jwt = await requireGuestAuth();
    } catch {
      dispatch({ t: 'reset' }); // gate dismissed
      return;
    }
    jwtRef.current = jwt;
    dispatch({ t: 'joining' });
    const result = await joinCommercialSession('live', listingId, jwt);
    if (!result.ok) {
      dispatch({ t: 'refused', refusal: result });
      return;
    }
    dispatch({ t: 'live', creds: result });
  }, [listingId]);

  // Once we have credentials: build the GetStream client + call and join it.
  // The server already authorized this join (window open, ticket held); no
  // backstage/asap negotiation is needed here — we join directly.
  useEffect(() => {
    if (state.phase !== 'live' || !state.creds) return;
    let disposed = false;
    const creds = state.creds;
    (async () => {
      try {
        const c = await streamClientFor(creds);
        if (disposed) return;
        const theCall = (c as any).call(creds.call_type, creds.call_id) as Call;
        setClient(c);
        setCall(theCall);
        await theCall.join();
      } catch {
        if (disposed) return;
        dispatch({ t: 'refused', refusal: { ok: false, reason: 'unavailable', status: 0, detail: 'could not connect to the stream' } });
      }
    })();
    return () => {
      disposed = true;
      // Leave the CALL, but never disconnect the shared client here — that is
      // reserved for sign-out (see getstream.ts `releaseStreamClient`).
      setCall((prev) => {
        prev?.leave().catch(() => {});
        return null;
      });
      setClient(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.creds]);

  const leave = useCallback(() => {
    dispatch({ t: 'left' });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  if (state.phase === 'left') {
    return <EndedCard title={title} creatorHref={creatorHref} rejoin={() => dispatch({ t: 'reset' })} />;
  }

  if (state.phase === 'refused' && state.refusal) {
    return (
      <RefusalScreen
        refusal={state.refusal}
        title={title}
        poster={poster}
        price={price}
        creatorName={creatorName}
        creatorHref={creatorHref}
        bookHref={bookHref}
        onRetry={() => dispatch({ t: 'reset' })}
        onJoin={attemptJoin}
      />
    );
  }

  if (state.phase === 'live' && state.creds && client && call) {
    return (
      <StreamVideo client={client as any}>
        <StreamCall call={call}>
          <LiveStage
            title={title ?? 'Live'}
            creatorName={creatorName ?? null}
            creatorAvatar={creatorAvatar ?? null}
            myName={creatorHandle ?? state.creds.user_id}
            onLeave={leave}
          />
        </StreamCall>
      </StreamVideo>
    );
  }

  // idle | authing | joining | (live, but the call hasn't been built yet)
  return (
    <PosterGate
      title={title}
      poster={poster}
      price={price}
      creatorName={creatorName}
      busy={state.phase === 'authing' || state.phase === 'joining' || state.phase === 'live'}
      onJoin={attemptJoin}
    />
  );
}

// ── sub-views ───────────────────────────────────────────────────────────────

function PosterGate({
  title, poster, price, creatorName, busy, onJoin,
}: {
  title?: string; poster?: string | null; price?: number | null; creatorName?: string | null;
  busy: boolean; onJoin: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="overflow-hidden rounded-zine border-zine border-ink bg-paper2 shadow-zine">
        <div className="relative aspect-video w-full bg-ink">
          {poster ? (
            <img src={cfImage(poster, { width: 1280, fit: 'cover' })} alt={title ?? 'Live'} className="h-full w-full object-cover opacity-90" />
          ) : (
            <div className="flex h-full w-full items-center justify-center font-mono uppercase tracking-[0.08em] text-inkMute font-bold">Live</div>
          )}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-ink/55 px-6 text-center">
            <h1 className="font-display font-semibold text-[26px] leading-tight text-white drop-shadow">{title ?? 'Live session'}</h1>
            {creatorName && <p className="font-body font-bold text-[15px] text-white/90">with {creatorName}</p>}
            <button
              type="button"
              onClick={onJoin}
              disabled={busy}
              className="inline-flex items-center gap-2.5 rounded-full border-zine border-ink bg-lime px-8 py-4 font-display font-semibold text-[20px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed disabled:opacity-80"
            >
              {busy ? <><Spinner size={18} /> Joining…</> : <>▶ Join the stream</>}
            </button>
            {typeof price === 'number' && price > 0 && (
              <p className="font-mono font-bold uppercase text-[13px] tracking-[0.06em] text-white/80">
                {inrOrFree(price)} ticket
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EndedCard({ title, creatorHref, rejoin }: { title?: string; creatorHref: string; rejoin: () => void }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <div className="rounded-zine border-zine border-ink bg-card p-10 shadow-zine">
        <p className="font-mono font-bold uppercase text-[14px] tracking-[0.1em] text-blueInk">You left the stream</p>
        <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink">{title ?? 'Live session'}</h1>
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={rejoin}
            className="inline-flex rounded-full border-zine border-ink bg-lime px-7 py-3.5 font-display font-semibold text-[18px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
          >
            Rejoin
          </button>
          <a href={creatorHref} className="inline-flex rounded-full border-zine border-ink bg-card px-7 py-3.5 font-display font-semibold text-[18px] text-ink no-underline shadow-zine-sm">
            View the creator
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * One screen per refusal reason (SPEC-2026-09-01 §4.2). `needs_ticket` is a
 * feature — the buyer can pay right now and be watching within one flow — not
 * an error, so it gets a CTA into checkout rather than a generic failure card.
 */
function RefusalScreen({
  refusal, title, poster, price, creatorName, creatorHref, bookHref, onRetry, onJoin,
}: {
  refusal: JoinRefusal;
  title?: string; poster?: string | null; price?: number | null; creatorName?: string | null;
  creatorHref: string; bookHref: string; onRetry: () => void; onJoin: () => void;
}) {
  const Frame = ({ children, tone = 'blueInk' }: { children: React.ReactNode; tone?: string }) => (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <div className="rounded-zine border-zine border-ink bg-card p-10 shadow-zine">
        <p className={`font-mono font-bold uppercase text-[14px] tracking-[0.1em] text-${tone}`}>{title ?? 'Live session'}</p>
        {children}
      </div>
    </div>
  );

  switch (refusal.reason) {
    case 'too_early':
      return (
        <TooEarlyScreen
          opensAt={refusal.opens_at ?? null}
          title={title}
          poster={poster}
          creatorName={creatorName}
          onWindowOpen={onJoin}
        />
      );

    case 'too_late':
      return (
        <Frame tone="coral">
          <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink">This session has ended</h1>
          <p className="mt-2 font-body font-bold text-[15px] text-inkSoft">Thanks for your interest — this one has wrapped up.</p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <a href="/dashboard/bookings" className="inline-flex rounded-full border-zine border-ink bg-lime px-7 py-3.5 font-display font-semibold text-[16px] text-ink no-underline shadow-zine-sm">
              View your receipt
            </a>
            <a href={creatorHref} className="inline-flex rounded-full border-zine border-ink bg-card px-7 py-3.5 font-display font-semibold text-[16px] text-ink no-underline shadow-zine-sm">
              View the creator
            </a>
          </div>
        </Frame>
      );

    case 'needs_ticket':
      // FEATURE, not an error: commercial_checkout.ts explicitly allows buying
      // a ticket while the listing is already live. Send the buyer to checkout
      // with this listing preloaded so they can pay and walk straight in.
      return (
        <Frame tone="mintInk">
          <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink">This is live right now</h1>
          <p className="mt-2 font-body font-bold text-[15px] text-inkSoft">
            Get your ticket and you'll be watching in a moment{creatorName ? ` — ${creatorName} is streaming now` : ''}.
          </p>
          <a
            href={bookHref}
            className="mt-6 inline-flex items-center gap-2 rounded-full border-zine border-ink bg-lime px-8 py-4 font-display font-semibold text-[18px] text-ink no-underline shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
          >
            {typeof price === 'number' ? `Get your ticket — ${inrOrFree(price)}` : 'Get your ticket'}
          </a>
        </Frame>
      );

    case 'not_yours':
      return (
        <Frame tone="coral">
          <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink">Not your session</h1>
          <p className="mt-2 font-body font-bold text-[15px] text-inkSoft">This session is booked for someone else.</p>
          <a href="/explore" className="mt-6 inline-flex rounded-full border-zine border-ink bg-card px-7 py-3.5 font-display font-semibold text-[16px] text-ink no-underline shadow-zine-sm">
            Back to explore
          </a>
        </Frame>
      );

    case 'disabled':
      return (
        <Frame>
          <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink">Not open yet</h1>
          <p className="mt-2 font-body font-bold text-[15px] text-inkSoft">Live sessions aren't open on the web yet — check back soon.</p>
          <a href="/explore" className="mt-6 inline-flex rounded-full border-zine border-ink bg-card px-7 py-3.5 font-display font-semibold text-[16px] text-ink no-underline shadow-zine-sm">
            Back to explore
          </a>
        </Frame>
      );

    case 'unavailable':
    default:
      return (
        <Frame tone="coral">
          <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink">Couldn't join the stream</h1>
          <p className="mt-2 font-body font-bold text-[15px] text-inkSoft">Something went wrong on our end. Please try again.</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-6 rounded-full border-zine border-ink bg-lime px-7 py-3.5 font-display font-semibold text-[16px] text-ink shadow-zine-sm"
          >
            Try again
          </button>
        </Frame>
      );
  }
}

/** `too_early` — a real countdown to the join window, with the creator's name
 * and start time; auto-retries the join once the window opens. */
function TooEarlyScreen({
  opensAt, title, poster, creatorName, onWindowOpen,
}: {
  opensAt: number | null; title?: string; poster?: string | null; creatorName?: string | null; onWindowOpen: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const firedRef = useRef(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (opensAt != null && now >= opensAt && !firedRef.current) {
      firedRef.current = true;
      onWindowOpen();
    }
  }, [now, opensAt, onWindowOpen]);

  const ms = opensAt != null ? Math.max(0, opensAt - now) : null;
  const s = ms != null ? Math.floor(ms / 1000) : null;
  const d = s != null ? Math.floor(s / 86400) : 0;
  const h = s != null ? Math.floor((s % 86400) / 3600) : 0;
  const m = s != null ? Math.floor((s % 3600) / 60) : 0;
  const sec = s != null ? s % 60 : 0;
  const parts = s == null ? null : d > 0 ? [`${d}d`, `${h}h`, `${m}m`] : h > 0 ? [`${h}h`, `${m}m`, `${sec}s`] : [`${m}m`, `${sec}s`];
  const startTimeLabel = opensAt != null ? new Date(opensAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="overflow-hidden rounded-zine border-zine border-ink bg-paper2 shadow-zine">
        <div className="relative aspect-video w-full bg-ink">
          {poster ? (
            <img src={cfImage(poster, { width: 1280, fit: 'cover' })} alt={title ?? 'Live'} className="h-full w-full object-cover opacity-60" />
          ) : null}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/60 px-6 text-center">
            <h1 className="font-display font-semibold text-[24px] leading-tight text-white drop-shadow">{title ?? 'Live session'}</h1>
            {creatorName && <p className="font-body font-bold text-[15px] text-white/90">with {creatorName}</p>}
            <p className="font-mono font-bold uppercase text-[14px] tracking-[0.1em] text-white/80">
              {ms === 0 ? 'Starting any moment…' : 'Doors open in'}
            </p>
            {parts && ms !== 0 && (
              <p className="font-mono font-bold text-[34px] tabular-nums text-white">{parts.join(' ')}</p>
            )}
            {startTimeLabel && <p className="font-body font-bold text-[13px] text-white/70">Starts {startTimeLabel}</p>}
            <p className="font-body font-bold text-[13px] text-white/70">You'll be pulled in automatically when the window opens.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Public entry: wraps the viewer in <ClerkIsland> so requireGuestAuth() works. */
export function LiveGsViewer(props: LiveGsViewerProps) {
  return (
    <ClerkIsland>
      <Inner {...props} />
    </ClerkIsland>
  );
}

export default LiveGsViewer;
