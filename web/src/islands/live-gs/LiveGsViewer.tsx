import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
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
import { useUser } from '@clerk/clerk-react';
import { StreamVideo, StreamCall, type Call } from '@stream-io/video-react-sdk';
import { ClerkIsland, getActiveToken, requireGuestAuth } from '../../lib/clerk';
import { livePath, payAndJoinPath } from '../../lib/urls';
import { IslandBoundary } from '../../components/IslandBoundary';
import { cfImage } from '../../lib/config';
import { inrOrFree } from '../../lib/money';
import { freeBox } from '../../lib/copy';
import { Spinner } from '../../components';
import { capture, captureException } from '../../lib/analytics';
import {
  joinCommercialSession,
  commercialSessionState,
  streamClientFor,
  type CommercialJoinCredentials,
  type JoinRefusal,
} from '../../lib/getstream';
import { LiveStage, type LiveServerState } from './LiveStage';
import { CommercialQualityControls } from '../consult-gs/ConsultRoomGS';

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
  const {t:uiT}=useUiTranslation("web-live-gs");
  const { user } = useUser();

  const [state, dispatch] = useReducer(reducer, { phase: 'idle', refusal: null, creds: null });
  const jwtRef = useRef<string | null>(null);
  const [client, setClient] = useState<Awaited<ReturnType<typeof streamClientFor>> | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [serverState, setServerState] = useState<LiveServerState | null>(null);
  const [serverEnded, setServerEnded] = useState(false);
  // [LIVE-GRACE-WEB-1] true when the session ended with outcome `host_no_return`
  // (server contract, WP8) — swaps the generic "ended" card for the refund line.
  const [noReturn, setNoReturn] = useState(false);
  const reconnectingShownRef = useRef(false);
  const noReturnShownRef = useRef(false);
  const callRef = useRef<Call | null>(null);
  const operationGenerationRef = useRef(0);
  // [WEB-POSTHOG-1] §2.6 live_leave `watched_s` — set the moment the call is
  // actually joined (StreamCall mounted), not at attempt time.
  const joinedAtRef = useRef<number | null>(null);
  const hasTicket = typeof price === 'number';

  // [JOIN-LINK-1] "Pay and join" — checkout, then straight back into THIS room.
  // Without `?return=` the confirmation sent the buyer to a bookings list after
  // he had paid to watch a stream that was already running.
  const bookHref = payAndJoinPath(listingId, livePath(listingId));
  const creatorHref = creatorHandle ? `/c/${encodeURIComponent(creatorHandle)}` : '/explore';

  const freshAppJwt = useCallback(async (): Promise<string> => {
    const fresh = await getActiveToken({ skipCache: true });
    return fresh ?? requireGuestAuth();
  }, []);

  const attemptJoin = useCallback(async () => {
    const generation = ++operationGenerationRef.current;
    dispatch({ t: 'authing' });
    let jwt: string;
    try {
      jwt = await freshAppJwt();
    } catch {
      dispatch({ t: 'reset' }); // gate dismissed
      return;
    }
    if (generation !== operationGenerationRef.current) return;
    jwtRef.current = jwt;
    dispatch({ t: 'joining' });
    const attemptStart = Date.now();
    try {
      capture('live_join_attempt', { listing_id: listingId, session_id: null, has_ticket: hasTicket });
    } catch {
      /* best-effort */
    }
    const fresh = await freshAppJwt().catch(() => null);
    if (!fresh || generation !== operationGenerationRef.current) return;
    jwt = fresh;
    jwtRef.current = fresh;
    const result = await joinCommercialSession('live', listingId, fresh);
    if (generation !== operationGenerationRef.current) return;
    if (!result.ok) {
      try {
        capture('live_join_result', {
          outcome: 'refused',
          reason: result.reason,
          status: result.status,
          ms: Date.now() - attemptStart,
        });
      } catch {
        /* best-effort */
      }
      dispatch({ t: 'refused', refusal: result });
      return;
    }
    try {
      capture('live_join_result', { outcome: 'ok', status: 200, ms: Date.now() - attemptStart });
    } catch {
      /* best-effort */
    }
    dispatch({ t: 'live', creds: result });
  }, [freshAppJwt, listingId, hasTicket]);

  // Once we have credentials: build the GetStream client + call and join it.
  // The server already authorized this join (window open, ticket held); no
  // backstage/asap negotiation is needed here — we join directly.
  useEffect(() => {
    if (state.phase !== 'live' || !state.creds) return;
    let disposed = false;
    const generation = ++operationGenerationRef.current;
    const creds = state.creds;
    (async () => {
      try {
        const c = await streamClientFor(creds, async () => {
          const token = await freshAppJwt();
          const refreshed = await joinCommercialSession('live', listingId, token);
          if (!refreshed.ok) throw new Error('session credentials expired');
          jwtRef.current = token;
          return refreshed;
        });
        if (disposed || generation !== operationGenerationRef.current) return;
        // [WEB-POSTHOG-1] gs_sdk_error is wired once, client-wide, in
        // lib/getstream.ts's `streamClientFor` — no per-call hook needed here.
        const theCall = (c as any).call(creds.call_type, creds.call_id) as Call;
        setClient(c);
        setCall(theCall);
        callRef.current = theCall;
        await theCall.join();
        if (disposed || generation !== operationGenerationRef.current) {
          await theCall.leave().catch(() => {});
          return;
        }
        joinedAtRef.current = Date.now();
      } catch (e) {
        if (disposed) return;
        try {
          capture('gs_sdk_error', { code: 'join_failed', message: e instanceof Error ? e.message : String(e) });
          captureException(e, { code: 'gs_join_failed', listing_id: listingId });
        } catch {
          /* best-effort */
        }
        const failedCall = callRef.current;
        callRef.current = null;
        failedCall?.leave().catch(() => {});
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
      callRef.current = null;
      setClient(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshAppJwt, listingId, state.phase, state.creds]);

  // The Worker owns the lifecycle. GetStream's local calling state only tells
  // us about transport; it cannot prove that a paid event is live or ended.
  useEffect(() => {
    if (state.phase !== 'live' || !state.creds) return;
    let disposed = false;
    const sync = async () => {
      try {
        const jwt = await freshAppJwt();
        const next = (await commercialSessionState('live', listingId, jwt)) as LiveServerState;
        if (disposed) return;
        setServerState(next);
        if (next.state === 'reconnecting') {
          // Keep the seat/stream object alive — do not leave the call.
          if (!reconnectingShownRef.current) {
            reconnectingShownRef.current = true;
            try { capture('live_reconnecting_shown', { listing_id: listingId, surface: 'viewer' }); } catch { /* best-effort */ }
          }
        } else {
          reconnectingShownRef.current = false;
        }
        if (next.state === 'ended' || next.state === 'cancelled') {
          setServerEnded(true);
          if (next.outcome === 'host_no_return') {
            setNoReturn(true);
            if (!noReturnShownRef.current) {
              noReturnShownRef.current = true;
              try { capture('live_no_return_shown', { listing_id: listingId }); } catch { /* best-effort */ }
            }
          }
          callRef.current?.leave().catch(() => {});
          dispatch({ t: 'left' });
        }
      } catch {
        // Keep the call alive through transient status-poll failures.
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [freshAppJwt, listingId, state.phase, state.creds]);

  // §2.6 live_leave — cover "closed the tab while watching", which the
  // reducer's `left`/`refused` transitions never see.
  useEffect(() => {
    const onPageHide = () => {
      if (state.phase !== 'live' || joinedAtRef.current == null) return;
      try {
        capture('live_leave', { watched_s: Math.round((Date.now() - joinedAtRef.current) / 1000) });
      } catch {
        /* best-effort */
      }
      joinedAtRef.current = null;
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [state.phase]);

  const leave = useCallback(() => {
    try {
      const watchedS = joinedAtRef.current != null ? Math.round((Date.now() - joinedAtRef.current) / 1000) : 0;
      capture('live_leave', { watched_s: watchedS });
    } catch {
      /* best-effort */
    } finally {
      joinedAtRef.current = null;
    }
    callRef.current?.leave().catch(() => {});
    dispatch({ t: 'left' });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  if (state.phase === 'left') {
    return (
      <EndedCard
        title={title}
        creatorHref={creatorHref}
        ended={serverEnded}
        refund={noReturn}
        rejoin={() => { setServerEnded(false); setNoReturn(false); setServerState(null); dispatch({ t: 'reset' }); }}
      />
    );
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
        listingId={listingId}
        onRetry={() => dispatch({ t: 'reset' })}
        onJoin={attemptJoin}
      />
    );
  }

  if (state.phase === 'live' && state.creds && client && call) {
    return (
      <StreamVideo client={client as any}>
        <StreamCall call={call}>
          <CommercialQualityControls key={user?.id ?? 'anonymous'} accountId={user?.id ?? null} call={call} />
          <LiveStage
            title={title ?? uiT("web-live-gs.b64ac05f17e64d03","Live")}
            creatorName={creatorName ?? null}
            creatorAvatar={creatorAvatar ?? null}
            myName={creatorHandle ?? state.creds.user_id}
            chatApiKey={state.creds.chat?.api_key ?? ''}
            chatUserId={state.creds.chat?.user_id ?? ''}
            chatToken={state.creds.chat?.token ?? ''}
            chatChannelId={state.creds.chat?.channel_id ?? ''}
            chatChannelType={state.creds.chat?.channel_type}
            serverState={serverState}
            onLeave={leave}
            getJwt={freshAppJwt}
            listingId={listingId}
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
  const {t:uiT}=useUiTranslation("web-live-gs");

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="overflow-hidden rounded-zine border-zine border-ink bg-paper2 shadow-zine">
        <div className="relative aspect-video w-full bg-ink">
          {poster ? (
            <img src={cfImage(poster, { width: 1280, fit: 'cover' })} alt={title ?? uiT("web-live-gs.b64ac05f17e64d03","Live")} className="h-full w-full object-cover opacity-90" />
          ) : (
            <div className="flex h-full w-full items-center justify-center font-mono uppercase tracking-[0.08em] text-inkMute font-bold"><UiText id="web-live-gs.b64ac05f17e64d03" source="Live" /></div>
          )}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-ink/55 px-6 text-center">
            <h1 className="font-display font-semibold text-[26px] leading-tight text-white drop-shadow">{title ?? uiT("web-live-gs.94f506b7d34d68a2","Live session")}</h1>
            {creatorName && <p className="font-body font-bold text-[15px] text-white/90"><UiText id="web-live-gs.0695b563acde461f" source="with" />{" "}{creatorName}</p>}
            <button
              type="button"
              onClick={onJoin}
              disabled={busy}
              className="inline-flex items-center gap-2.5 rounded-full border-zine border-ink bg-lime px-8 py-4 font-display font-semibold text-[20px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed disabled:opacity-80"
            >
              {busy ? <><Spinner size={18} />{" "}<UiText id="web-live-gs.6bbb89ee5d48b326" source="Joining…" /></> : <><UiText id="web-live-gs.4477824203f397da" source="▶ Join the stream" /></>}
            </button>
            {typeof price === 'number' && price > 0 && (
              <p className="font-mono font-bold uppercase text-[13px] tracking-[0.06em] text-white/80">
                {inrOrFree(price)}{" "}<UiText id="web-live-gs.14069429150abcbf" source="ticket" />{" "}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EndedCard({ title, creatorHref, ended, refund, rejoin }: { title?: string; creatorHref: string; ended: boolean; refund: boolean; rejoin: () => void }) {
  const {t:uiT}=useUiTranslation("web-live-gs");

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <div className="rounded-zine border-zine border-ink bg-card p-10 shadow-zine">
        <p className="font-mono font-bold uppercase text-[14px] tracking-[0.1em] text-blueInk">
          {refund ? uiT("web-live-gs.17c2838d2719098d","Refund on the way") : ended ? uiT("web-live-gs.4a50e4c0c4ffa965","Session ended") : uiT("web-live-gs.12a8ae6a6915353c","You left the stream")}
        </p>
        <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink">{title ?? uiT("web-live-gs.94f506b7d34d68a2","Live session")}</h1>
        {refund && (
          <p className="mt-2 font-body font-bold text-[15px] leading-relaxed text-inkSoft"><UiText id="web-live-gs.aa3c07495699aacd" source="The creator couldn't return — the unused part of your ticket is being refunded." />{" "}</p>
        )}
        <div className="mt-6 flex items-center justify-center gap-3">
          {!refund && (
            <button
              type="button"
              onClick={rejoin}
              className="inline-flex rounded-full border-zine border-ink bg-lime px-7 py-3.5 font-display font-semibold text-[18px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
            >
              {ended ? uiT("web-live-gs.fb7099ad8e818d42","Check again") : uiT("web-live-gs.fb5cdea2e140edbf","Rejoin")}
            </button>
          )}
          <a href={creatorHref} className="inline-flex rounded-full border-zine border-ink bg-card px-7 py-3.5 font-display font-semibold text-[18px] text-ink no-underline shadow-zine-sm"><UiText id="web-live-gs.e73afff1478776ab" source="View the creator" />{" "}</a>
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
  refusal, title, poster, price, creatorName, creatorHref, bookHref, listingId, onRetry, onJoin,
}: {
  refusal: JoinRefusal;
  title?: string; poster?: string | null; price?: number | null; creatorName?: string | null;
  creatorHref: string; bookHref: string; listingId: string; onRetry: () => void; onJoin: () => void;
}) {
  const {t:uiT}=useUiTranslation("web-live-gs");

  // [WEB-POSTHOG-1] §2.6 live_refusal_shown — once per distinct refusal
  // actually rendered to the viewer (the free-lane branches below resolve to
  // a screen the raw `refusal.reason` alone wouldn't tell you).
  useEffect(() => {
    const reason =
      refusal.status === 409 && refusal.detail === 'free_session_full'
        ? 'free_session_full'
        : refusal.status === 403 && refusal.detail === 'free_sessions_disabled'
          ? 'free_sessions_disabled'
          : refusal.reason;
    try {
      capture('live_refusal_shown', { reason });
      // [JOIN-LINK-1] §2.6 pay_and_join_shown — the one refusal a payment fixes.
      if (reason === 'needs_ticket') capture('pay_and_join_shown', { listing_id: listingId, kind: 'live' });
    } catch {
      /* best-effort */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refusal]);

  const Frame = ({ children, tone = 'blueInk' }: { children: React.ReactNode; tone?: string }) => (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center">
      <div className="rounded-zine border-zine border-ink bg-card p-10 shadow-zine">
        <p className={`font-mono font-bold uppercase text-[14px] tracking-[0.1em] text-${tone}`}>{title ?? uiT("web-live-gs.94f506b7d34d68a2","Live session")}</p>
        {children}
      </div>
    </div>
  );

  // [LIST-FREE-1] SPEC-2026-09-02-LISTING-TRUST-AND-VIBE.md §2.4/§3.4. The
  // free lane's two refusals arrive as raw wire values, not a dedicated
  // JoinRefusalReason — getstream.ts's refusalFor() doesn't know about the
  // free lane at all: a 409 falls through to its `unavailable` default, and a
  // 403 `free_sessions_disabled` would otherwise be misread as `needs_ticket`
  // (its detail contains neither "not your" nor "ticket|entitlement", so it
  // hits that catch-all). Match the exact server strings
  // (worker/src/routes/commercial_stream_sessions.ts) before the reason
  // switch below, rather than teaching getstream.ts a new reason — this is
  // additive to the existing refusal screen, not a parallel error path, and
  // the ticketless→checkout `needs_ticket` branch below is untouched.
  if (refusal.status === 409 && refusal.detail === 'free_session_full') {
    return (
      <Frame tone="blueInk">
        <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink">{freeBox.full}</h1>
        <p className="mt-2 font-body font-bold text-[15px] text-inkSoft"><UiText id="web-live-gs.8f01e8752ccec47f" source="All spots are taken — no purchase was needed." /></p>
        <a href={creatorHref} className="mt-6 inline-flex rounded-full border-zine border-ink bg-card px-7 py-3.5 font-display font-semibold text-[16px] text-ink no-underline shadow-zine-sm"><UiText id="web-live-gs.e73afff1478776ab" source="View the creator" />{" "}</a>
      </Frame>
    );
  }
  if (refusal.status === 403 && refusal.detail === 'free_sessions_disabled') {
    return (
      <Frame>
        <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink">{freeBox.disabled}</h1>
        <a href="/explore" className="mt-6 inline-flex rounded-full border-zine border-ink bg-card px-7 py-3.5 font-display font-semibold text-[16px] text-ink no-underline shadow-zine-sm"><UiText id="web-live-gs.8d8733bfd7fdf8f4" source="Back to explore" />{" "}</a>
      </Frame>
    );
  }

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
          <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink"><UiText id="web-live-gs.e5ff4964c447ad8c" source="This session has ended" /></h1>
          <p className="mt-2 font-body font-bold text-[15px] text-inkSoft"><UiText id="web-live-gs.04abe8973a77074e" source="Thanks for your interest — this one has wrapped up." /></p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <a href="/dashboard/bookings" className="inline-flex rounded-full border-zine border-ink bg-lime px-7 py-3.5 font-display font-semibold text-[16px] text-ink no-underline shadow-zine-sm"><UiText id="web-live-gs.10c6f3643e79618f" source="View your receipt" />{" "}</a>
            <a href={creatorHref} className="inline-flex rounded-full border-zine border-ink bg-card px-7 py-3.5 font-display font-semibold text-[16px] text-ink no-underline shadow-zine-sm"><UiText id="web-live-gs.e73afff1478776ab" source="View the creator" />{" "}</a>
          </div>
        </Frame>
      );

    case 'needs_ticket':
      // FEATURE, not an error: commercial_checkout.ts explicitly allows buying
      // a ticket while the listing is already live. Send the buyer to checkout
      // with this listing preloaded so they can pay and walk straight in.
      return (
        <Frame tone="mintInk">
          <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink"><UiText id="web-live-gs.a15d0ff65a82faae" source="This is live right now" /></h1>
          <p className="mt-2 font-body font-bold text-[15px] text-inkSoft"><UiText id="web-live-gs.b093bfe139941a63" source="Get your ticket and you'll be watching in a moment" />{creatorName ? uiT("web-live-gs.bae66a73dcacded3"," — {value0} is streaming now",{value0:String(creatorName)}) : ''}.
          </p>
          <a
            href={bookHref}
            className="mt-6 inline-flex items-center gap-2 rounded-full border-zine border-ink bg-lime px-8 py-4 font-display font-semibold text-[18px] text-ink no-underline shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
          >
            {typeof price === 'number' ? uiT("web-live-gs.97493f16afec7825","Get your ticket — {value0}",{value0:String(inrOrFree(price))}) : uiT("web-live-gs.f750370b27aec8f5","Get your ticket")}
          </a>
        </Frame>
      );

    case 'not_yours':
      return (
        <Frame tone="coral">
          <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink"><UiText id="web-live-gs.c37264783e427dfe" source="Not your session" /></h1>
          <p className="mt-2 font-body font-bold text-[15px] text-inkSoft"><UiText id="web-live-gs.ce40935e74e4e096" source="This session is booked for someone else." /></p>
          <a href="/explore" className="mt-6 inline-flex rounded-full border-zine border-ink bg-card px-7 py-3.5 font-display font-semibold text-[16px] text-ink no-underline shadow-zine-sm"><UiText id="web-live-gs.8d8733bfd7fdf8f4" source="Back to explore" />{" "}</a>
        </Frame>
      );

    case 'disabled':
      return (
        <Frame>
          <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink"><UiText id="web-live-gs.a52b97a613669bf9" source="Not open yet" /></h1>
          <p className="mt-2 font-body font-bold text-[15px] text-inkSoft"><UiText id="web-live-gs.91eb72b90b9c8681" source="Live sessions aren't open on the web yet — check back soon." /></p>
          <a href="/explore" className="mt-6 inline-flex rounded-full border-zine border-ink bg-card px-7 py-3.5 font-display font-semibold text-[16px] text-ink no-underline shadow-zine-sm"><UiText id="web-live-gs.8d8733bfd7fdf8f4" source="Back to explore" />{" "}</a>
        </Frame>
      );

    case 'unavailable':
    default:
      return (
        <Frame tone="coral">
          <h1 className="mt-3 font-display font-semibold text-[26px] leading-tight text-ink"><UiText id="web-live-gs.99cd86d6307ae880" source="Couldn't join the stream" /></h1>
          <p className="mt-2 font-body font-bold text-[15px] text-inkSoft"><UiText id="web-live-gs.a3dcdf028063c109" source="Something went wrong on our end. Please try again." /></p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-6 rounded-full border-zine border-ink bg-lime px-7 py-3.5 font-display font-semibold text-[16px] text-ink shadow-zine-sm"
          ><UiText id="web-live-gs.d8b8392e2c542950" source="Try again" />{" "}</button>
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
  const {t:uiT}=useUiTranslation("web-live-gs");

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
            <img src={cfImage(poster, { width: 1280, fit: 'cover' })} alt={title ?? uiT("web-live-gs.b64ac05f17e64d03","Live")} className="h-full w-full object-cover opacity-60" />
          ) : null}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/60 px-6 text-center">
            <h1 className="font-display font-semibold text-[24px] leading-tight text-white drop-shadow">{title ?? uiT("web-live-gs.94f506b7d34d68a2","Live session")}</h1>
            {creatorName && <p className="font-body font-bold text-[15px] text-white/90"><UiText id="web-live-gs.0695b563acde461f" source="with" />{" "}{creatorName}</p>}
            <p className="font-mono font-bold uppercase text-[14px] tracking-[0.1em] text-white/80">
              {ms === 0 ? uiT("web-live-gs.ac4b984674c624d9","Starting any moment…") : uiT("web-live-gs.4393151378584154","Doors open in")}
            </p>
            {parts && ms !== 0 && (
              <p className="font-mono font-bold text-[34px] tabular-nums text-white">{parts.join(' ')}</p>
            )}
            {startTimeLabel && <p className="font-body font-bold text-[13px] text-white/70"><UiText id="web-live-gs.96dbedeca7dfb7fa" source="Starts" />{" "}{startTimeLabel}</p>}
            <p className="font-body font-bold text-[13px] text-white/70"><UiText id="web-live-gs.6852a522f5be278d" source="You'll be pulled in automatically when the window opens." /></p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Public entry: wraps the viewer in <ClerkIsland> so requireGuestAuth() works. */
export function LiveGsViewer(props: LiveGsViewerProps) {
  return (
    <IslandBoundary island="live-gs-viewer">
      <ClerkIsland>
        <Inner {...props} />
      </ClerkIsland>
    </IslandBoundary>
  );
}

export default LiveGsViewer;
