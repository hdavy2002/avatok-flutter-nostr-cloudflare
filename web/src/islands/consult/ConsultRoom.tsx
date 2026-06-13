/*
 * ConsultRoom — the fan's side of a paid 1:1 consult at /consult/<booking>.
 * Fully client-side (no SSR of media). Flow: PreJoin green-room → auth gate
 * (requireGuestAuth, Phase 0) → GET /api/consult/:b/join → native-WebRTC SFU
 * session (SfuClient) + room WS (RoomSocket) for attendance/chat/countdown.
 *
 * Gate states from /join are handled per PHASE-D step 2:
 *   425 too early        → Countdown to opens_at, auto-retry when it opens
 *   403 not your session → message + link to /dashboard
 *   409 session inactive → status; if live_event → redirect to /watch/<listing>
 *   410 session over     → ended screen
 *
 * No LiveKit / Dyte / RealtimeKit — native RTCPeerConnection only (SfuClient).
 * Money is server-side only: /cancel and /extend just call the Worker; the
 * creator drives /complete and the fan reacts to the WS `session_ended` event.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClerkIsland, requireGuestAuth } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { Button, Spinner } from '../../components';
import { PreJoin } from './PreJoin';
import { Countdown } from './Countdown';
import { MediaControls } from './MediaControls';
import { SfuClient, type SfuConnState } from './SfuClient';
import { RoomSocket, parseTrackAnnounce, type RoomEvent, type WelcomeMsg } from './RoomSocket';

interface JoinResponse {
  ok: boolean;
  mode: 'p2p' | 'sfu';
  room: string | null;
  room_token: string;
  starts_at: number;
  ends_at: number;
  title: string;
  capacity: number;
  host_id: string;
  listing_id: string | null;
  peer: string;
  peer_name: string;
  thread_peer: string;
}

type Phase = 'prejoin' | 'joining' | 'live' | 'ended';
type Gate =
  | { kind: 'too_early'; opensAt: number; startsAt: number }
  | { kind: 'forbidden'; message: string }
  | { kind: 'inactive'; message: string }
  | { kind: 'over' }
  | null;

interface ChatLine {
  id: string;
  from: string;
  text: string;
  mine: boolean;
}

const HUD: Record<SfuConnState, { label: string; cls: string } | null> = {
  idle: null,
  connecting: { label: 'Connecting…', cls: 'border-ink bg-card text-inkSoft' },
  connected: { label: '● Connected', cls: 'border-ink bg-card text-mintInk' },
  reconnecting: { label: 'Reconnecting…', cls: 'border-coral bg-card text-coral shadow-zine-error' },
  failed: { label: 'Connection lost', cls: 'border-coral bg-card text-coral shadow-zine-error' },
  closed: null,
};

function ConsultRoomInner({ booking }: { booking: string }) {
  const [phase, setPhase] = useState<Phase>('prejoin');
  const [gate, setGate] = useState<Gate>(null);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [info, setInfo] = useState<JoinResponse | null>(null);
  const [conn, setConn] = useState<SfuConnState>('idle');
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'reconnecting' | 'closed'>('connecting');
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [startsAt, setStartsAt] = useState<number | null>(null);
  const [hostLive, setHostLive] = useState<boolean | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [endReason, setEndReason] = useState<string>('Session ended.');

  const localRef = useRef<MediaStream | null>(null);
  const sfuRef = useRef<SfuClient | null>(null);
  const roomRef = useRef<RoomSocket | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const publishedRef = useRef<{ sessionId: string; audio: string | null; video: string | null } | null>(null);

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice((n) => (n === m ? null : n)), 4000);
  };

  // Attach streams to their <video> elements when both exist.
  useEffect(() => {
    if (localVideoRef.current && localRef.current) {
      localVideoRef.current.srcObject = localRef.current;
      void localVideoRef.current.play().catch(() => {});
    }
  }, [phase]);
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
      void remoteVideoRef.current.play().catch(() => {});
    }
  }, [remoteStream]);

  const teardown = useCallback(() => {
    try {
      roomRef.current?.close();
    } catch {
      /* ignore */
    }
    try {
      sfuRef.current?.close();
    } catch {
      /* ignore */
    }
    roomRef.current = null;
    sfuRef.current = null;
    localRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    localRef.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const endSession = useCallback(
    (reason: string) => {
      setEndReason(reason);
      teardown();
      setPhase('ended');
    },
    [teardown],
  );

  // ── room WS event handling ────────────────────────────────────────────────
  const handleEvent = useCallback(
    (e: RoomEvent) => {
      switch (e.type) {
        case 'presence': {
          if (e.joined && e.role === 'host') {
            flash(`${e.name ?? 'The host'} joined`);
            setHostLive(true);
            // A peer arriving after us missed our announce — re-announce.
            const pub = publishedRef.current;
            if (pub) roomRef.current?.announceTracks(pub.sessionId, pub.audio, pub.video);
          } else if (!e.joined && e.role === 'host') {
            setHostLive(false);
          }
          break;
        }
        case 'track': {
          const a = parseTrackAnnounce(e);
          if (a && a.session !== sfuRef.current?.currentSessionId) {
            void sfuRef.current?.pull(a.session, [a.audio, a.video]).catch(() => flash('Could not load the other video.'));
          }
          break;
        }
        case 'chat':
        case 'fly': {
          if (typeof e.text === 'string') {
            setChat((c) => [
              ...c.slice(-60),
              { id: `${Date.now()}-${Math.random()}`, from: String(e.from ?? 'Guest'), text: e.text!, mine: false },
            ]);
          }
          break;
        }
        case 'host_connected':
          setHostLive(true);
          break;
        case 'host_reconnecting':
          setHostLive(false);
          break;
        case 'session_ended':
          endSession('The session has ended.');
          break;
        case 'warn':
          if (e.reason) flash(String(e.reason));
          break;
      }
    },
    [endSession],
  );

  // ── connect: SFU publish + room WS ────────────────────────────────────────
  const goLive = useCallback(
    async (res: JoinResponse) => {
      setInfo(res);
      setEndsAt(res.ends_at);
      setStartsAt(res.starts_at);
      setPhase('live');

      const token = res.room_token;

      // 1) SFU: publish local media first so we have a session id to announce.
      const sfu = new SfuClient({
        bookingId: booking,
        token,
        onRemoteStream: (s) => setRemoteStream(s),
        onState: (s) => setConn(s),
      });
      sfuRef.current = sfu;

      // 2) Room WS: attendance / chat / countdown.
      const room = new RoomSocket(booking, token, {
        onWelcome: (m: WelcomeMsg) => {
          setEndsAt(m.ends_at || res.ends_at);
          setStartsAt(m.starts_at || res.starts_at);
          setHostLive(m.host_live);
          // (Re-)announce our tracks every time the socket (re)opens.
          const pub = publishedRef.current;
          if (pub) room.announceTracks(pub.sessionId, pub.audio, pub.video);
        },
        onEvent: handleEvent,
        onStatus: (s) => setWsStatus(s),
      });
      roomRef.current = room;
      room.connect();

      try {
        const local = localRef.current!;
        const pub = await sfu.publish(local);
        publishedRef.current = pub;
        room.announceTracks(pub.sessionId, pub.audio, pub.video);
      } catch (e) {
        const msg = (e as Error)?.message ?? '';
        flash(
          msg.startsWith('503')
            ? 'Live video is not available on this environment yet.'
            : 'Could not start your video. Check your connection.',
        );
        setConn('failed');
      }
    },
    [booking, handleEvent],
  );

  // ── join (auth gate → /join → gate states) ────────────────────────────────
  const attemptJoin = useCallback(async () => {
    setJoinErr(null);
    setGate(null);
    setPhase('joining');
    let token: string;
    try {
      token = await requireGuestAuth();
    } catch {
      // gate dismissed
      setPhase('prejoin');
      return;
    }
    try {
      const res = await request<JoinResponse>(`/api/consult/${encodeURIComponent(booking)}/join`, { auth: token });
      await goLive(res);
    } catch (e) {
      if (e instanceof ApiError) {
        const body = (e.body ?? {}) as Record<string, unknown>;
        if (e.status === 425) {
          setGate({
            kind: 'too_early',
            opensAt: Number(body.opens_at) || Date.now() + 60_000,
            startsAt: Number(body.starts_at) || 0,
          });
          setPhase('prejoin');
          return;
        }
        if (e.status === 409 && body.error === 'live_event' && body.listing_id) {
          window.location.href = `/watch/${encodeURIComponent(String(body.listing_id))}`;
          return;
        }
        if (e.status === 409) {
          setGate({ kind: 'inactive', message: statusText(String(body.status ?? e.error)) });
          setPhase('prejoin');
          return;
        }
        if (e.status === 403) {
          setGate({ kind: 'forbidden', message: e.error || 'This is not your session.' });
          setPhase('prejoin');
          return;
        }
        if (e.status === 410) {
          setGate({ kind: 'over' });
          setPhase('prejoin');
          return;
        }
        setJoinErr(e.error || 'Could not join the session.');
      } else {
        setJoinErr('Could not join the session. Check your connection.');
      }
      setPhase('prejoin');
    }
  }, [booking, goLive]);

  // ── controls ──────────────────────────────────────────────────────────────
  const onReadyFromPreJoin = (stream: MediaStream, mic: boolean, cam: boolean) => {
    localRef.current = stream;
    setMicOn(mic);
    setCamOn(cam);
    void attemptJoin();
  };

  const toggleMic = () => {
    const next = !micOn;
    setMicOn(next);
    localRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
  };
  const toggleCam = () => {
    const next = !camOn;
    setCamOn(next);
    localRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
  };

  const leave = useCallback(async () => {
    // If we backed out before the session started, cancel (refund engine runs
    // server-side). Otherwise just leave the room.
    const notStarted = startsAt != null && Date.now() < startsAt;
    if (notStarted) {
      try {
        const token = await requireGuestAuth();
        await request(`/api/consult/${encodeURIComponent(booking)}/cancel`, { method: 'POST', auth: token });
      } catch {
        /* best-effort; refund engine + dashboard reflect truth */
      }
    }
    endSession(notStarted ? 'You left before the session started.' : 'You left the session.');
  }, [booking, startsAt, endSession]);

  const extend = useCallback(async () => {
    try {
      const token = await requireGuestAuth();
      const r = await request<{ ok: boolean; ends_at: number }>(
        `/api/consult/${encodeURIComponent(booking)}/extend`,
        { method: 'POST', auth: token },
      );
      if (r.ends_at) setEndsAt(r.ends_at);
      flash('Added 15 minutes.');
    } catch (e) {
      flash(e instanceof ApiError && e.status === 403 ? 'Only the host can add time.' : 'Could not extend the session.');
    }
  }, [booking]);

  const sendChat = () => {
    const t = draft.trim();
    if (!t) return;
    roomRef.current?.chat(t);
    setChat((c) => [...c.slice(-60), { id: `${Date.now()}`, from: 'You', text: t, mine: true }]);
    setDraft('');
  };

  // ── render ─────────────────────────────────────────────────────────────────
  if (phase === 'ended') {
    return (
      <Centered>
        <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
          <h1 className="font-display font-semibold text-[26px] text-ink">Call ended</h1>
          <p className="font-body font-bold text-[15px] text-inkSoft">{endReason}</p>
          <div className="flex gap-3">
            <a href="/dashboard" className="no-underline">
              <Button variant="lime" label="My bookings" />
            </a>
            <a href="/explore" className="no-underline">
              <Button variant="ghost" label="Explore" />
            </a>
          </div>
        </div>
      </Centered>
    );
  }

  if (phase === 'live' && info) {
    const hud = HUD[conn];
    return (
      <div className="relative mx-auto flex h-[calc(100dvh-4rem)] max-w-6xl flex-col gap-3 px-3 py-3">
        {/* top bar */}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="mr-auto font-display font-semibold text-[18px] text-ink">{info.title}</h1>
          {hud && (
            <span className={`rounded-zine-badge border-zine px-3 py-1.5 font-mono font-bold text-[12px] ${hud.cls}`}>
              {hud.label}
            </span>
          )}
          {wsStatus === 'reconnecting' && (
            <span className="rounded-zine-badge border-zine border-coral bg-card px-3 py-1.5 font-mono font-bold text-[12px] text-coral">
              Room offline…
            </span>
          )}
          {endsAt && <Countdown target={endsAt} label="Ends in" onZero={() => endSession('Time is up.')} />}
        </div>

        {/* stage */}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-zine border-zine border-ink bg-ink shadow-zine">
          {remoteStream ? (
            <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-paper2 text-center">
              <Spinner size={28} />
              <p className="font-body font-bold text-[15px] text-inkSoft">
                {hostLive === false ? `Waiting for ${info.peer_name}…` : `Connecting to ${info.peer_name}…`}
              </p>
            </div>
          )}

          {/* local PiP */}
          <div className="absolute bottom-3 right-3 aspect-[3/4] w-28 overflow-hidden rounded-zine border-zine border-ink bg-ink shadow-zine-sm sm:w-36">
            <video ref={localVideoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
            {!camOn && (
              <div className="absolute inset-0 flex items-center justify-center bg-ink/80 font-display text-[12px] text-paper">
                Camera off
              </div>
            )}
          </div>

          {notice && (
            <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-zine-badge border-zine border-ink bg-card px-3 py-1.5 font-body font-bold text-[13px] text-ink shadow-zine-xs">
              {notice}
            </div>
          )}
        </div>

        {/* chat strip */}
        <div className="flex items-end gap-2">
          <div className="flex max-h-24 min-h-0 flex-1 flex-col justify-end gap-1 overflow-y-auto">
            {chat.slice(-4).map((l) => (
              <p key={l.id} className="font-body text-[13px] text-inkSoft">
                <span className={`font-bold ${l.mine ? 'text-blueInk' : 'text-ink'}`}>{l.from}:</span> {l.text}
              </p>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendChat()}
            maxLength={120}
            placeholder="Message…"
            aria-label="Chat message"
            className="min-w-0 flex-1 rounded-zine-field border-zine border-ink bg-card px-3 py-2 font-body font-bold text-[14px] text-ink focus:outline-none focus:shadow-zine-focus"
          />
          <Button variant="blue" label="Send" onClick={sendChat} />
        </div>

        {/* controls */}
        <div className="pt-1">
          <MediaControls
            micOn={micOn}
            camOn={camOn}
            onToggleMic={toggleMic}
            onToggleCam={toggleCam}
            onLeave={() => void leave()}
            canExtend={false}
            onExtend={extend}
          />
        </div>
      </div>
    );
  }

  // phase === 'prejoin' (incl. gate states) or 'joining'
  if (gate?.kind === 'too_early') {
    return (
      <Centered>
        <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
          <span className="font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Not open yet</span>
          <h1 className="font-display font-semibold text-[26px] text-ink">You're early</h1>
          <p className="font-body font-bold text-[15px] text-inkSoft">
            The room opens 10 minutes before your slot. We'll let you in automatically.
          </p>
          <Countdown target={gate.opensAt} label="Opens in" onZero={() => void attemptJoin()} />
          <a href="/dashboard" className="font-mono text-[12px] uppercase tracking-[0.06em] text-blueInk underline">
            Back to my bookings
          </a>
        </div>
      </Centered>
    );
  }
  if (gate?.kind === 'forbidden') {
    return (
      <Centered>
        <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
          <h1 className="font-display font-semibold text-[26px] text-ink">This isn't your booking</h1>
          <p className="font-body font-bold text-[15px] text-inkSoft">{gate.message}</p>
          <a href="/dashboard" className="no-underline">
            <Button variant="lime" label="My bookings" />
          </a>
        </div>
      </Centered>
    );
  }
  if (gate?.kind === 'inactive') {
    return (
      <Centered>
        <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
          <h1 className="font-display font-semibold text-[26px] text-ink">Session not active</h1>
          <p className="font-body font-bold text-[15px] text-inkSoft">{gate.message}</p>
          <a href="/dashboard" className="no-underline">
            <Button variant="lime" label="My bookings" />
          </a>
        </div>
      </Centered>
    );
  }
  if (gate?.kind === 'over') {
    return (
      <Centered>
        <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
          <h1 className="font-display font-semibold text-[26px] text-ink">This session is over</h1>
          <p className="font-body font-bold text-[15px] text-inkSoft">
            The booking window has closed. Any refund is handled automatically.
          </p>
          <a href="/dashboard" className="no-underline">
            <Button variant="lime" label="My bookings" />
          </a>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <PreJoin
        title="Your 1:1 session"
        joining={phase === 'joining'}
        error={joinErr}
        onReady={onReadyFromPreJoin}
      />
    </Centered>
  );
}

function statusText(status: string): string {
  switch (status) {
    case 'cancelled_user':
    case 'cancelled_creator':
      return 'This booking was cancelled.';
    case 'pending':
      return 'This booking is still pending confirmation.';
    case 'completed':
      return 'This session is already complete.';
    default:
      return `This session can't be joined right now (${status}).`;
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[calc(100dvh-4rem)] items-center justify-center px-4 py-8">{children}</div>;
}

/** Public entry: wraps the room in ClerkIsland so requireGuestAuth() can open the gate. */
export function ConsultRoom({ booking }: { booking: string }) {
  return (
    <ClerkIsland>
      <ConsultRoomInner booking={booking} />
    </ClerkIsland>
  );
}

export default ConsultRoom;
