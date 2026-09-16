import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
// AgentTalkRoom — the customer's live call with an AI voice agent
// (`[AGENT-LIVE-1]`, BUILD SPEC §6, R2 §3.1-3.3). Mounted at
// `/talk/[booking].astro`.
//
// Flow: auth (requireGuestAuth, same gate as booking) → prejoin → mic
// permission → connect AgentLiveSocket (R2 §3.2 envelope) + AudioPipeline at
// 24 kHz both ways → wait for `ready` (showing a countdown if the slot hasn't
// started yet) → live (orb, captions, timer ring, mute, share a photo, end
// call) → `ended` → TalkEndedCard. A socket drop reconnects automatically for
// up to 45s (re-prejoining for a fresh token) before giving up.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClerkIsland, requireGuestAuth } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/Spinner';
import { Countdown } from '../consult-gs/Countdown';
import { AudioPipeline } from '../agent/AudioPipeline';
import { useMicPermission } from './useMicPermission';
import { AgentLiveSocket } from './AgentLiveSocket';
import type { AgentLiveEndedMsg, AgentLiveTimerMsg } from './AgentLiveSocket';
import { TalkEndedCard } from './TalkEndedCard';
import { ApiError, getAgentBooking, prejoinAgentTalk, uploadTalkImage, forgetAgentMemory, agentTalkWsUrl } from '../../lib/agentLive';
import type { AgentPrejoin, AgentBooking } from '../../lib/agentLive';
import { capture, captureException } from '../../lib/analytics';

const RECONNECT_BUDGET_MS = 45_000;
const RECONNECT_RETRY_MS = 3_000;

type Phase = 'loading' | 'refused' | 'mic' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'lost';

interface CaptionLine {
  id: string;
  speaker: 'customer' | 'agent';
  text: string;
}

interface SharedImage {
  clientUploadId: string;
  imageId: string | null;
  status: 'uploading' | 'accepted' | 'analyzing' | 'ready' | 'failed';
  thumbUrl: string;
}

function visitorTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

function AgentTalkRoomInner({ bookingId }: { bookingId: string }) {
  const {t:uiT}=useUiTranslation("web-agent-live");

  const [phase, setPhase] = useState<Phase>('loading');
  const [refusalMsg, setRefusalMsg] = useState<string | null>(null);
  const [prejoin, setPrejoin] = useState<AgentPrejoin | null>(null);
  const [booking, setBooking] = useState<AgentBooking | null>(null);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [captions, setCaptions] = useState<CaptionLine[]>([]);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [ended, setEnded] = useState<AgentLiveEndedMsg | null>(null);
  const [images, setImages] = useState<SharedImage[]>([]);
  const [forgetting, setForgetting] = useState(false);

  const mic = useMicPermission();

  const socketRef = useRef<AgentLiveSocket | null>(null);
  const audioRef = useRef<AudioPipeline | null>(null);
  const connectionGenRef = useRef(0);
  const lastSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const readyAtRef = useRef<number | null>(null);
  const connectStartRef = useRef<number>(Date.now());
  const dropAtRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const phaseRef = useRef<Phase>('loading');
  const endedFiredRef = useRef(false);

  useEffect(() => { phaseRef.current = phase; }, [phase]);

  useEffect(() => {
    mountedRef.current = true;
    capture('agent_talk_open', { booking_id: bookingId });
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      void audioRef.current?.dispose();
    };
  }, [bookingId]);

  // ── bootstrap: auth → prejoin + booking read ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await requireGuestAuth();
      } catch {
        if (!cancelled) { setRefusalMsg('Sign in to open this session.'); setPhase('refused'); }
        return;
      }
      try {
        const [pj, bk] = await Promise.all([
          prejoinAgentTalk(bookingId),
          getAgentBooking(bookingId).catch(() => null),
        ]);
        if (cancelled) return;
        setPrejoin(pj);
        if (bk) setBooking(bk);
        setEndsAt(pj.endsAt);
        setPhase('mic');
      } catch (e) {
        if (cancelled) return;
        const status = e instanceof ApiError ? e.status : 0;
        setRefusalMsg(
          status === 403 || status === 404
            ? "This session isn't open yet, or has already ended."
            : 'Could not open this session. Please try again.',
        );
        setPhase('refused');
        captureException(e, { code: 'agent_prejoin_failed', booking_id: bookingId });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  // ── connect once mic is granted ────────────────────────────────────────
  const connect = useCallback(
    (pj: AgentPrejoin) => {
      connectionGenRef.current += 1;
      connectStartRef.current = Date.now();
      const socket = new AgentLiveSocket(
        agentTalkWsUrl(bookingId, pj.roomToken),
        {
          onReady: () => {
            if (!mountedRef.current) return;
            readyAtRef.current = Date.now();
            dropAtRef.current = null;
            setPhase('live');
            capture('agent_talk_ready', { booking_id: bookingId, connect_ms: Date.now() - connectStartRef.current, outcome: 'ok' });
            void audioRef.current?.resumeOutput();
          },
          onCaption: (m) => {
            if (!mountedRef.current) return;
            setCaptions((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.speaker === m.speaker) {
                const copy = prev.slice(0, -1);
                copy.push({ ...last, text: (last.text + m.delta).slice(-600) });
                return copy;
              }
              return [...prev.slice(-40), { id: `${Date.now()}-${Math.random()}`, speaker: m.speaker, text: m.delta }];
            });
          },
          onTimer: (m: AgentLiveTimerMsg) => {
            if (!mountedRef.current) return;
            setRemainingMs(m.remainingMs);
            setEndsAt(m.endsAt);
          },
          onImageAck: (m) => {
            if (!mountedRef.current) return;
            setImages((prev) => prev.map((im) => (im.imageId === m.imageId ? { ...im, status: m.status } : im)));
          },
          onPlaybackClear: () => audioRef.current?.clearPlayback(),
          onAudio: (pcm) => {
            const ok = audioRef.current?.playChunk(pcm);
            if (ok === false) {
              // R2 §3.1 backpressure — tell the room its queue is full so it
              // can decide whether the connection is healthy.
              socketRef.current?.reportPlayback(0, 500);
            }
          },
          onEnded: (m) => {
            if (!mountedRef.current || endedFiredRef.current) return;
            endedFiredRef.current = true;
            setEnded(m);
            setPhase('ended');
            const billedS = readyAtRef.current ? Math.round((Date.now() - readyAtRef.current) / 1000) : 0;
            capture('agent_talk_ended', { booking_id: bookingId, reason: m.reason, billed_s: billedS });
            socket.close();
            void audioRef.current?.dispose();
          },
          onStatus: () => {},
          onClose: () => {
            if (!mountedRef.current || endedFiredRef.current) return;
            // A drop before ever reaching `ready` also counts as a failed
            // connect attempt for the telemetry contract.
            if (!readyAtRef.current) {
              capture('agent_talk_ready', { booking_id: bookingId, connect_ms: Date.now() - connectStartRef.current, outcome: 'failed' });
            }
            if (dropAtRef.current == null) dropAtRef.current = Date.now();
            if (Date.now() - dropAtRef.current >= RECONNECT_BUDGET_MS) {
              setPhase('lost');
              return;
            }
            setPhase('reconnecting');
            reconnectTimerRef.current = setTimeout(() => void reconnect(), RECONNECT_RETRY_MS);
          },
        },
        { connectionGeneration: connectionGenRef.current, timezone: visitorTz(), lastServerSeq: lastSeqRef.current },
      );
      socketRef.current = socket;
      socket.connect();
    },
    [bookingId],
  );

  const reconnect = useCallback(async () => {
    if (!mountedRef.current || endedFiredRef.current) return;
    try {
      const pj = await prejoinAgentTalk(bookingId);
      if (!mountedRef.current || endedFiredRef.current) return;
      setPrejoin(pj);
      connect(pj);
    } catch {
      if (!mountedRef.current) return;
      if (dropAtRef.current != null && Date.now() - dropAtRef.current >= RECONNECT_BUDGET_MS) {
        setPhase('lost');
        return;
      }
      reconnectTimerRef.current = setTimeout(() => void reconnect(), RECONNECT_RETRY_MS);
    }
  }, [bookingId, connect]);

  // ── mic granted → wire audio pipeline + connect socket ─────────────────
  useEffect(() => {
    if (phase !== 'mic' || mic.state !== 'granted' || !prejoin || !mic.stream) return;
    const audio = new AudioPipeline(
      {
        onMicChunk: (pcm) => socketRef.current?.sendAudio(pcm),
        onAgentSpeaking: setSpeaking,
      },
      { inputRate: 24000, outputRate: 24000 },
    );
    audioRef.current = audio;
    setPhase('connecting');
    void audio.startMic().catch(() => {
      /* mic already granted upstream — startMic re-acquires its own stream */
    });
    connect(prejoin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, mic.state, mic.stream, prejoin]);

  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      audioRef.current?.setMuted(next);
      socketRef.current?.setMuted(next);
      return next;
    });
  };

  const endCall = () => {
    if (!window.confirm("End this call now? You'll still be charged for the full slot.")) return;
    socketRef.current?.end();
  };

  const forgetMe = () => {
    if (!booking?.agentId) return;
    if (!window.confirm('Forget everything this agent remembers about you? This cannot be undone.')) return;
    setForgetting(true);
    forgetAgentMemory(booking.agentId)
      .then(() => capture('agent_memory_forget', { agent_id: booking.agentId, booking_id: bookingId }))
      .catch((e) => captureException(e, { code: 'agent_forget_failed', booking_id: bookingId }))
      .finally(() => setForgetting(false));
  };

  const onPickPhoto = () => fileInputRef.current?.click();
  const onPhotoChosen = async (file: File) => {
    const clientUploadId = globalThis.crypto?.randomUUID?.() ?? `img_${Date.now()}`;
    const thumbUrl = URL.createObjectURL(file);
    const entry: SharedImage = { clientUploadId, imageId: null, status: 'uploading', thumbUrl };
    setImages((prev) => [...prev, entry].slice(-6));
    const startedAt = Date.now();
    try {
      const r = await uploadTalkImage(bookingId, file, clientUploadId);
      setImages((prev) => prev.map((im) => (im.clientUploadId === clientUploadId ? { ...im, imageId: r.imageId, status: 'analyzing' } : im)));
      capture('agent_talk_image_shared', { booking_id: bookingId, outcome: 'ok', ms: Date.now() - startedAt });
    } catch (e) {
      setImages((prev) => prev.map((im) => (im.clientUploadId === clientUploadId ? { ...im, status: 'failed' } : im)));
      capture('agent_talk_image_shared', { booking_id: bookingId, outcome: 'error', ms: Date.now() - startedAt });
      captureException(e, { code: 'agent_image_upload_failed', booking_id: bookingId });
    }
  };

  // ── render ──────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <Centered>
        <Spinner size={28} />
      </Centered>
    );
  }

  if (phase === 'refused') {
    return (
      <Centered>
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <h1 className="font-display font-semibold text-[24px] text-ink"><UiText id="web-agent-live.8b6611fb041b275d" source="Couldn’t open this session" /></h1>
          <p className="font-body font-bold text-[14px] text-inkSoft">{refusalMsg}</p>
          <a href="/dashboard" className="no-underline"><Button variant="lime" label={uiT("web-agent-live.be1b53baca18d782","My bookings")} /></a>
        </div>
      </Centered>
    );
  }

  if (phase === 'ended' && ended) {
    // The `AgentBooking` read has no single `amount` field — it's the sum of
    // the receipt lines (fee + net, or a single "AI voice agent" line,
    // depending on what WS-D lands). Summing is correct either way.
    const amount = (booking?.receiptLines ?? []).reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
    return (
      <Centered>
        <div className="w-full max-w-md">
          <TalkEndedCard
            reason={ended.reason}
            money={ended.money}
            amount={amount}
            listingId={booking?.agentId ?? ''}
            agentName={prejoin?.agent.name}
          />
        </div>
      </Centered>
    );
  }

  if (phase === 'lost') {
    return (
      <Centered>
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <h1 className="font-display font-semibold text-[24px] text-ink"><UiText id="web-agent-live.6c44751e62681094" source="Connection lost" /></h1>
          <p className="font-body font-bold text-[14px] text-inkSoft"><UiText id="web-agent-live.4cbedec09d3a9756" source="We couldn’t reconnect you in time. Check your receipt in My bookings." />{" "}</p>
          <a href="/dashboard" className="no-underline"><Button variant="lime" label={uiT("web-agent-live.be1b53baca18d782","My bookings")} /></a>
        </div>
      </Centered>
    );
  }

  if (phase === 'mic') {
    return (
      <Centered>
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          {mic.state === 'denied' ? (
            <>
              <p className="font-body font-bold text-[14px] text-coral">{mic.error}</p>
              <Button variant="blue" label={uiT("web-agent-live.d85928b810be02e2","Allow & retry")} onClick={mic.retry} />
            </>
          ) : (
            <>
              <Spinner size={26} />
              <p className="font-body font-bold text-[14px] text-inkSoft"><UiText id="web-agent-live.4ac6179b67484be6" source="Starting your microphone…" /></p>
            </>
          )}
        </div>
      </Centered>
    );
  }

  // 'connecting' | 'live' | 'reconnecting'
  const agentInfo = prejoin?.agent;
  const showCountdown = phase === 'connecting' && prejoin && prejoin.startsAt > prejoin.serverNow;
  const totalMs = prejoin ? Math.max(1, prejoin.endsAt - prejoin.startsAt) : 1;
  const ringPct = remainingMs != null ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 1;

  return (
    <Centered>
      <div className="flex w-full max-w-md flex-col items-center gap-5">
        <div className="relative">
          <svg width="132" height="132" className="-rotate-90">
            <circle cx="66" cy="66" r="60" fill="none" stroke="var(--zine-paper2, #e8e2d0)" strokeWidth="6" />
            <circle
              cx="66" cy="66" r="60" fill="none" stroke="var(--zine-lime, #a7e05a)" strokeWidth="6"
              strokeDasharray={2 * Math.PI * 60}
              strokeDashoffset={2 * Math.PI * 60 * (1 - ringPct)}
              strokeLinecap="round"
            />
          </svg>
          <div
            className={[
              'absolute inset-[10px] flex items-center justify-center rounded-full border-zine border-ink bg-lilac shadow-zine',
              speaking ? 'ring-4 ring-lilac animate-pulse' : '',
            ].join(' ')}
          >
            <Avatar src={agentInfo?.avatar ?? null} name={agentInfo?.name ?? uiT("web-agent-live.11b39c93777e8f1f","Agent")} size={96} fallbackClassName="bg-lilac" />
          </div>
        </div>

        <h1 className="font-display font-semibold text-[24px] leading-tight text-ink">{agentInfo?.name ?? uiT("web-agent-live.c89eff1a5f8f97aa","AI voice agent")}</h1>

        {showCountdown && prejoin && (
          <Countdown target={prejoin.startsAt} label={uiT("web-agent-live.5fefbb92603fab9c","Starts in")} onZero={() => {}} />
        )}
        {phase === 'connecting' && !showCountdown && (
          <span className="font-mono font-bold uppercase text-[13px] tracking-[0.08em] text-inkSoft"><UiText id="web-agent-live.72021eb70e91b4d5" source="Connecting…" /></span>
        )}
        {phase === 'reconnecting' && (
          <span className="font-mono font-bold uppercase text-[13px] tracking-[0.08em] text-coral"><UiText id="web-agent-live.27b80374e1151af6" source="Reconnecting…" /></span>
        )}
        {phase === 'live' && endsAt != null && (
          <Countdown target={endsAt} label={uiT("web-agent-live.87d0485a90e5ebb0","Ends in")} onZero={() => {}} />
        )}

        {captions.length > 0 && (
          <div className="flex max-h-40 w-full flex-col gap-1.5 overflow-y-auto rounded-zine border-zine border-ink bg-card p-3">
            {captions.slice(-6).map((c) => (
              <p key={c.id} className="font-body text-[13px] leading-snug text-ink">
                <span className="font-bold text-inkSoft">{c.speaker === 'agent' ? (agentInfo?.name ?? uiT("web-agent-live.11b39c93777e8f1f","Agent")) : uiT("web-agent-live.08b041935798fbf6","You")}: </span>
                {c.text}
              </p>
            ))}
          </div>
        )}

        {images.length > 0 && (
          <div className="flex w-full gap-2 overflow-x-auto">
            {images.map((im) => (
              <div key={im.clientUploadId} className="relative flex-none">
                <img src={im.thumbUrl} alt={uiT("web-agent-live.e3c4b39d6d501347","Shared")} className="h-16 w-16 rounded-zineField border-zine border-ink object-cover" />
                <span className="absolute -bottom-1 left-0 right-0 truncate rounded-b-zineField bg-ink/80 px-1 text-center font-mono text-[9px] font-bold uppercase text-paper">
                  {im.status}
                </span>
              </div>
            ))}
          </div>
        )}

        {prejoin?.imageReading && (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPhotoChosen(f);
              e.target.value = '';
            }}
          />
        )}

        <div className="flex w-full items-center justify-center gap-3">
          <button
            type="button"
            onClick={toggleMute}
            aria-pressed={muted}
            className={[
              'flex h-14 w-14 items-center justify-center rounded-full border-zine border-ink shadow-zine-xs',
              muted ? 'bg-coral text-white' : 'bg-card text-ink',
            ].join(' ')}
          >
            {muted ? '🔇' : '🎙️'}
          </button>
          {prejoin?.imageReading && (
            <button
              type="button"
              onClick={onPickPhoto}
              className="flex h-14 w-14 items-center justify-center rounded-full border-zine border-ink bg-card text-ink shadow-zine-xs"
              aria-label={uiT("web-agent-live.7a5508f657d21dc8","Share a photo")}
            >
              📷
            </button>
          )}
          <button
            type="button"
            onClick={endCall}
            className="flex h-14 w-14 items-center justify-center rounded-full border-zine border-ink bg-coral text-white shadow-zine-xs"
            aria-label={uiT("web-agent-live.2fe13d93a1f4b267","End call")}
          >
            ☎
          </button>
        </div>

        {booking?.agentId && prejoin?.memoryEnabled && (
          <button
            type="button"
            onClick={forgetMe}
            disabled={forgetting}
            className="font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-inkMute underline"
          >
            {forgetting ? uiT("web-agent-live.f935bf31caf8e3a9","Forgetting…") : uiT("web-agent-live.bcb66ca711be5812","Forget me")}
          </button>
        )}
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[calc(100dvh-4rem)] items-center justify-center px-4 py-8">{children}</div>;
}

export function AgentTalkRoom({ bookingId }: { bookingId: string }) {
  return (
    <IslandBoundary island="agent-talk-room">
      <ClerkIsland>
        <AgentTalkRoomInner bookingId={bookingId} />
      </ClerkIsland>
    </IslandBoundary>
  );
}

export default AgentTalkRoom;
