// LiveStage — the joined-call chrome for the GetStream live viewer. [WEB-GS-LIVE-1]
//
// Must be rendered inside <StreamVideo><StreamCall call={call}>. Renders the
// host's published track (viewer role — this NEVER requests a local camera or
// microphone), a live badge with elapsed time, viewer count, a reconnecting
// overlay with manual retry, and the chat sidebar (GsChat).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ParticipantView,
  useCall,
  useCallStateHooks,
  CallingState,
} from '@stream-io/video-react-sdk';
import { Avatar, Spinner } from '../../components';
import { capture } from '../../lib/analytics';
import { GsChat } from './GsChat';
import type { CommercialSessionState } from '../../lib/getstream';

/*
 * [LIVE-GRACE-WEB-1] The server contract (Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md
 * "Contracts shared by all WPs") adds a `reconnecting` state and
 * `reconnect_deadline_ms` to `GET .../live/:id/state`, landing with WP8. Widen
 * the shape locally rather than editing the shared lib (owned by another
 * WP) — the extra fields are always optional/absent until WP8 ships.
 */
export type LiveServerState = Omit<CommercialSessionState, 'state'> & {
  state: CommercialSessionState['state'] | 'reconnecting';
  reconnect_deadline_ms?: number;
  outcome?: string;
};

export interface LiveStageProps {
  title: string;
  creatorName: string | null;
  creatorAvatar: string | null;
  myName: string;
  chatApiKey: string;
  chatUserId: string;
  chatToken: string;
  chatChannelId: string;
  chatChannelType?: string;
  /** Worker-authoritative lifecycle; transport state is insufficient. */
  serverState: LiveServerState | null;
  onLeave: () => void;
  /**
   * [APP-ONLY-TX-1 2026-09-12] Session JWT getter for chat file uploads.
   * RULEBOOK-PAID-SESSIONS §7: the customer's browser may view, listen, talk,
   * chat AND upload. Omit and the attach button is simply absent.
   */
  getJwt?: () => Promise<string | null>;
  listingId?: string | null;
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtElapsed(startedAt: Date | undefined, now: number): string {
  if (!startedAt) return '00:00';
  const s = Math.max(0, Math.floor((now - startedAt.getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** mm:ss remaining until `deadlineMs`, clamped at 00:00. */
function fmtCountdown(deadlineMs: number | undefined, now: number): string {
  const remainingS = typeof deadlineMs === 'number' ? Math.max(0, Math.round((deadlineMs - now) / 1000)) : 0;
  const m = Math.floor(remainingS / 60);
  const sec = remainingS % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const RECONNECT_STUCK_MS = 15_000;

export function LiveStage({
  title,
  creatorName,
  creatorAvatar,
  myName,
  chatApiKey,
  chatUserId,
  chatToken,
  chatChannelId,
  chatChannelType,
  serverState,
  onLeave,
  getJwt,
  listingId,
}: LiveStageProps) {
  const call = useCall();
  const { useCallCallingState, useIsCallLive, useCallStartedAt, useParticipantCount, useRemoteParticipants } =
    useCallStateHooks();
  const callingState = useCallCallingState();
  const transportLive = useIsCallLive();
  const isLive = serverState ? serverState.state === 'live' : transportLive;
  const serverEnded = serverState?.state === 'ended' || serverState?.state === 'cancelled';
  // [LIVE-GRACE-WEB-1] Server-authoritative — distinct from the SDK's own
  // `reconnecting` transport state below. The seat/call object stays alive;
  // this only overlays a message and a countdown to the grace deadline.
  const hostReconnecting = serverState?.state === 'reconnecting';
  const startedAt = useCallStartedAt();
  const viewerCount = useParticipantCount();
  const remoteParticipants = useRemoteParticipants();
  const host = remoteParticipants[0];

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const reconnecting = callingState === CallingState.RECONNECTING || callingState === CallingState.MIGRATING;
  const connectionLost = callingState === CallingState.RECONNECTING_FAILED || callingState === CallingState.OFFLINE;

  // [WEB-POSTHOG-1] §2.6 live_player_state — one event per state transition,
  // with `ms` = time spent in the PREVIOUS state.
  const playerState: 'connecting' | 'playing' | 'stalled' | 'ended' = connectionLost
    ? 'ended'
    : reconnecting
      ? 'stalled'
      : host
        ? 'playing'
        : 'connecting';
  const prevPlayerStateRef = useRef<string | null>(null);
  const prevPlayerStateAtRef = useRef<number>(Date.now());
  useEffect(() => {
    if (prevPlayerStateRef.current === playerState) return;
    const ms = Date.now() - prevPlayerStateAtRef.current;
    prevPlayerStateRef.current = playerState;
    prevPlayerStateAtRef.current = Date.now();
    try {
      capture('live_player_state', { state: playerState, ms });
    } catch {
      /* best-effort */
    }
  }, [playerState]);

  const [reconnectStuckAt, setReconnectStuckAt] = useState<number | null>(null);
  const stallCountRef = useRef(0);
  useEffect(() => {
    if (!reconnecting) {
      setReconnectStuckAt(null);
      return;
    }
    if (reconnectStuckAt == null) {
      const t = setTimeout(() => {
        setReconnectStuckAt(Date.now());
        stallCountRef.current += 1;
        try {
          capture('live_stall', { ms: RECONNECT_STUCK_MS, count: stallCountRef.current });
        } catch {
          /* best-effort */
        }
      }, RECONNECT_STUCK_MS);
      return () => clearTimeout(t);
    }
  }, [reconnecting, reconnectStuckAt]);

  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!call || retrying) return;
    setRetrying(true);
    try {
      await call.join();
    } catch {
      // Surfaced by the calling-state going back to RECONNECTING_FAILED/OFFLINE;
      // the retry button stays available for another attempt.
    } finally {
      setRetrying(false);
    }
  };

  const elapsed = useMemo(() => fmtElapsed(startedAt, now), [startedAt, now]);

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-0 px-0 md:grid-cols-[1fr_360px] md:gap-4 md:px-4 md:py-4">
      {/* Stage */}
      <div className="relative flex flex-col bg-ink md:rounded-zine md:border-zine md:border-ink md:overflow-hidden md:shadow-zine">
        <div className="relative aspect-video w-full bg-ink">
          {host ? (
            <ParticipantView
              participant={host}
              ParticipantViewUI={null}
              className="absolute inset-0 h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-contain"
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
              <Spinner size={26} color="#fff" />
              <p className="font-display font-semibold text-[16px] text-white">
                {serverEnded ? 'The creator has ended this session.' : isLive ? 'Connecting to the stream…' : 'Waiting for the creator to go live…'}
              </p>
            </div>
          )}

          {/* top-left status */}
          <div className="absolute left-3 top-3 flex items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-full border-zine border-ink bg-card px-3 py-1.5 shadow-zine-xs">
              <span
                className={['inline-block h-2.5 w-2.5 rounded-full', isLive ? 'bg-coral' : 'bg-inkMute'].join(' ')}
                style={isLive ? { animation: 'zine-pulse 1.4s ease-in-out infinite' } : undefined}
                aria-hidden
              />
              <span className="font-mono font-bold uppercase text-[14px] tracking-[0.06em] text-ink">
                {serverEnded ? 'Ended' : hostReconnecting ? 'Reconnecting' : isLive ? 'Live' : 'Waiting'}
              </span>
              {isLive && (
                <span className="font-mono text-[14px] text-inkSoft tabular-nums font-bold">· {elapsed}</span>
              )}
              <span className="font-mono text-[14px] text-inkSoft tabular-nums font-bold">
                · {fmtCount(viewerCount)} watching
              </span>
            </div>
            <style>{'@keyframes zine-pulse{0%,100%{opacity:1}50%{opacity:.35}}'}</style>
          </div>

          {/* creator-reconnecting overlay — server-authoritative, takes
              precedence over the SDK's own transport-level overlay below;
              the seat/call stays intact so the viewer keeps their place. */}
          {hostReconnecting && !connectionLost && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/70 px-6 text-center">
              <Spinner size={26} color="#fff" />
              <p className="font-display font-semibold text-[16px] text-white">
                Creator reconnecting · {fmtCountdown(serverState?.reconnect_deadline_ms, now)}
              </p>
              <p className="font-body font-bold text-[13px] text-white/80">Your seat is saved — hang tight.</p>
            </div>
          )}

          {/* reconnecting overlay — the last frame stays visible underneath */}
          {!hostReconnecting && reconnecting && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/60 px-6 text-center">
              <Spinner size={26} color="#fff" />
              <p className="font-display font-semibold text-[16px] text-white">Reconnecting…</p>
              {reconnectStuckAt && (
                <>
                  <p className="font-body font-bold text-[13px] text-white/80">This is taking longer than usual.</p>
                  <button
                    type="button"
                    onClick={retry}
                    disabled={retrying}
                    className="rounded-full border-zine border-ink bg-lime px-5 py-2 font-display font-semibold text-[14px] text-ink shadow-zine-sm disabled:opacity-70"
                  >
                    {retrying ? 'Retrying…' : 'Retry now'}
                  </button>
                </>
              )}
            </div>
          )}

          {connectionLost && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/80 px-6 text-center">
              <p className="font-display font-semibold text-[18px] text-white">Connection lost</p>
              <p className="font-body font-bold text-[14px] text-white/80">We couldn't keep you connected to the stream.</p>
              <button
                type="button"
                onClick={retry}
                disabled={retrying}
                className="rounded-full border-zine border-ink bg-lime px-6 py-2.5 font-display font-semibold text-[15px] text-ink shadow-zine-sm disabled:opacity-70"
              >
                {retrying ? 'Retrying…' : 'Reconnect'}
              </button>
            </div>
          )}
        </div>

        {/* action bar */}
        <div className="flex items-center gap-3 border-t-zine border-ink bg-paper px-3 py-2.5">
          {creatorName && <Avatar src={creatorAvatar} name={creatorName} size={36} />}
          <div className="min-w-0 flex-1">
            <p className="truncate font-display font-semibold text-[16px] text-ink">{title}</p>
            {creatorName && <p className="truncate font-body font-bold text-[13px] text-inkSoft">with {creatorName}</p>}
          </div>
          <button
            type="button"
            onClick={onLeave}
            className="shrink-0 rounded-full border-zine border-ink bg-card px-4 py-2 font-display font-semibold text-[14px] text-ink shadow-zine-sm transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
          >
            Leave
          </button>
        </div>
      </div>

      {/* Chat (side panel on desktop, stacked below the stage on phones).
          [APP-ONLY-TX-1 2026-09-12] now carries file attachments — RULEBOOK §7. */}
      <aside className="flex h-[60vh] min-h-0 flex-col bg-card md:h-auto md:rounded-zine md:border-zine md:border-ink md:overflow-hidden md:shadow-zine-sm">
        <div className="border-b-zine border-ink px-3 py-2 font-mono font-bold uppercase text-[14px] tracking-[0.06em] text-inkSoft">
          Live chat
        </div>
        <div className="min-h-0 flex-1">
          <GsChat
            apiKey={chatApiKey}
            userId={chatUserId}
            token={chatToken}
            channelId={chatChannelId}
            channelType={chatChannelType}
            myName={myName}
            disabled={connectionLost || serverEnded}
            getJwt={getJwt}
            listingId={listingId}
          />
        </div>
      </aside>
    </div>
  );
}

export default LiveStage;
