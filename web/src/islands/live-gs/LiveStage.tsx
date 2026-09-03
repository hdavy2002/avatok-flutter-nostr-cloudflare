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
  onLeave: () => void;
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
  onLeave,
}: LiveStageProps) {
  const call = useCall();
  const { useCallCallingState, useIsCallLive, useCallStartedAt, useParticipantCount, useRemoteParticipants } =
    useCallStateHooks();
  const callingState = useCallCallingState();
  const isLive = useIsCallLive();
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
                {isLive ? 'Connecting to the stream…' : 'Waiting for the creator to go live…'}
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
                {isLive ? 'Live' : 'Backstage'}
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

          {/* reconnecting overlay — the last frame stays visible underneath */}
          {reconnecting && (
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

      {/* Chat (sidebar on desktop, stacked on mobile) */}
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
            disabled={connectionLost}
          />
        </div>
      </aside>
    </div>
  );
}

export default LiveStage;
