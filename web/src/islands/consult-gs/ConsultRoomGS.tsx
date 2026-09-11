/*
 * ConsultRoomGS — the buyer/creator's side of a paid 1:1 consult on the
 * GetStream commercial lane, at `/session/<booking>` (SPEC-2026-09-01 §4.4,
 * `[WEB-GS-CONSULT-1]`). Sibling to (never a replacement for) the legacy
 * native-WebRTC room at `/consult/<booking>` — that route and its islands
 * under `web/src/islands/consult/` are untouched.
 *
 * Flow (rewritten for [WAITROOM-WEB-1 2026-09-11],
 * Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md WP4 /
 * Specs/RULEBOOK-PAID-SESSIONS.md §3):
 *
 *   requireGuestAuth() → GET .../prejoin
 *     → green room (PreJoin: getUserMedia preflight + device choice)
 *     → WAITING ROOM (new): connects to the StreamSessionDO socket
 *       (`room_ws`), shows the counterparty, own preview, the meter, chat,
 *       the creator's check-in line. NO GetStream participant is created
 *       here — waiting costs nothing (RULEBOOK §3).
 *     → auto-join: when the socket's `roster` says both host and attendee
 *       are present, call the existing `/join` and enter the GetStream call.
 *     → CallStage (video, timer, extend, leave)
 *     → Leave (or the call ending) returns to the WAITING ROOM, keeping the
 *       same socket — only the cron/`ends_at + 2 min` or a server-confirmed
 *       ended/cancelled state ends the slot for good.
 *
 * Every refusal `joinCommercialSession`/`consultPrejoin` can return
 * (`JoinRefusalReason`) gets its own screen per §4.2 — no generic toast.
 *
 * Fails closed, per the pivot spec: if the provider join is refused or the
 * commercial lane is dark, this shows the refusal. It never falls back to
 * the legacy Cloudflare/WebRTC room — that would be an unmetered session.
 *
 * The waiting-room fields (`room_ws`, `room_token`, `check_in_by`,
 * `counterparty`) are landing concurrently from WP1/WP2 (worker). Every use
 * of them here is guarded — a prejoin response missing them (not deployed
 * yet, or the commercial lane's flags are off) falls back to today's
 * direct-join behaviour, with a console warning, rather than breaking.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { ClerkIsland, getActiveToken, requireGuestAuth } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { Button, Spinner } from '../../components';
import { PreJoin } from './PreJoin';
import { Countdown } from './Countdown';
import { CallStage } from './CallStage';
import { WaitingRoom, type WaitingChatLine, type WaitingRoster } from './WaitingRoom';
import { RoomSocket, type RosterMsg, type ChatMsg, type RoomEvent } from './RoomSocket';
import { capture, captureException } from '../../lib/analytics';
import {
  joinCommercialSession,
  consultPrejoin,
  commercialSessionState,
  streamClientFor,
  type CommercialJoinCredentials,
  type ConsultPrejoin,
  type JoinRefusal,
} from '../../lib/getstream';
import type { StreamVideoClient, Call } from '@stream-io/video-react-sdk';

type Phase = 'loading' | 'refused' | 'prejoin' | 'waiting' | 'joining' | 'live' | 'ended';

interface JoinPrefs {
  micOn: boolean;
  camOn: boolean;
  micId: string;
  camId: string;
}

const NOSHOW_CHECK_MS = 5000;
const END_GRACE_MS = 2 * 60_000; // ends_at + 2 min, matches commercialConsultJoinLateMin's intent

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toString();
  }
}

/** [WAITROOM-WEB-1] freshAppJwt() must resolve or reject within 10s — an
 * unresponsive Clerk/network call must never hang the bootstrap spinner
 * forever. Wrapping here (rather than in lib/clerk.tsx, which this WP does
 * not own) keeps the fix scoped to this island. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function ConsultRoomGSInner({ booking }: { booking: string }) {
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  const [phase, setPhase] = useState<Phase>('loading');
  const [refusal, setRefusal] = useState<JoinRefusal | null>(null);
  const [prejoin, setPrejoin] = useState<ConsultPrejoin | null>(null);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [endReason, setEndReason] = useState('Session ended.');
  const [call, setCall] = useState<Call | null>(null);
  const [creds, setCreds] = useState<CommercialJoinCredentials | null>(null);
  const [jwt, setJwt] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'reconnecting' | 'closed'>('connecting');
  const [roster, setRoster] = useState<WaitingRoster>({ host: false, attendee: false });
  const [chatLines, setChatLines] = useState<WaitingChatLine[]>([]);
  const [previewTick, setPreviewTick] = useState(0); // forces a re-render when the preview stream ref changes

  const jwtRef = useRef<string | null>(null);
  const prefsRef = useRef<JoinPrefs | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const callRef = useRef<Call | null>(null);
  const mountedRef = useRef(true);
  const operationGenerationRef = useRef(0);
  const leavingLiveRef = useRef(false);
  const phaseRef = useRef<Phase>('loading');
  const roomSocketRef = useRef<RoomSocket | null>(null);
  const autoJoinFiredRef = useRef(false);
  const noShowShownRef = useRef(false);
  // [WEB-POSTHOG-1] §2.6 consult_end `billed_min` — set the moment the call
  // is actually joined.
  const joinedAtRef = useRef<number | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // ── counterparty resolution: prefer the WP1/WP2 structured field, fall
  // back to the pre-existing flat fields so this works whether or not the
  // worker change has landed. ────────────────────────────────────────────
  const counterpartyName = prejoin?.counterparty?.name ?? prejoin?.counterparty_name ?? null;
  const counterpartyAvatar = prejoin?.counterparty?.avatar_url ?? prejoin?.counterparty_avatar ?? null;
  const roomWs = prejoin?.room_ws ?? null;
  const checkInBy = prejoin?.check_in_by ?? null;
  const waitingRoomSupported = !!roomWs;

  const teardownCall = useCallback(() => {
    const c = callRef.current;
    callRef.current = null;
    setCall(null);
    if (c) {
      void c.camera.disable().catch(() => {});
      void c.microphone.disable().catch(() => {});
      void c.leave().catch(() => {});
    }
  }, []);

  const closeRoomSocket = useCallback(() => {
    roomSocketRef.current?.close();
    roomSocketRef.current = null;
  }, []);

  const releasePreview = useCallback(() => {
    previewStreamRef.current?.getTracks().forEach((track) => track.stop());
    previewStreamRef.current = null;
    setPreviewTick((n) => n + 1);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      teardownCall();
      closeRoomSocket();
      releasePreview();
    };
  }, [teardownCall, closeRoomSocket, releasePreview]);

  const freshAppJwt = useCallback(async (): Promise<string> => {
    return withTimeout(
      (async () => {
        const fresh = await getActiveToken({ skipCache: true });
        if (fresh) return fresh;
        return requireGuestAuth();
      })(),
      10_000,
      'auth timed out',
    );
  }, []);

  const showRefusal = (r: JoinRefusal) => {
    setRefusal(r);
    setPhase('refused');
  };

  // ── ends_at + 2 min / server-confirmed end → the receipt screen ────────
  const finalizeEnded = useCallback(
    (reason: string) => {
      if (phaseRef.current === 'ended') return;
      teardownCall();
      closeRoomSocket();
      releasePreview();
      setEndReason(reason);
      setPhase('ended');
    },
    [teardownCall, closeRoomSocket, releasePreview],
  );

  // ── bootstrap: auth → prejoin ──────────────────────────────────────────
  const bootstrap = useCallback(async () => {
    const generation = ++operationGenerationRef.current;
    setPhase('loading');
    setJoinErr(null);
    let jwt: string;
    try {
      jwt = await freshAppJwt();
    } catch {
      if (!mountedRef.current || generation !== operationGenerationRef.current) return;
      showRefusal({ ok: false, reason: 'unavailable', status: 0, detail: 'sign-in was cancelled' });
      return;
    }
    if (!mountedRef.current || generation !== operationGenerationRef.current) return;
    jwtRef.current = jwt;
    setJwt(jwt);
    let res: ConsultPrejoin | JoinRefusal;
    try {
      res = await consultPrejoin(booking, jwt);
    } catch {
      if (!mountedRef.current || generation !== operationGenerationRef.current) return;
      showRefusal({ ok: false, reason: 'unavailable', status: 0, detail: 'could not reach avaTOK' });
      return;
    }
    if (!mountedRef.current || generation !== operationGenerationRef.current) return;
    if ('reason' in res) {
      try {
        capture('consult_prejoin', { booking_id: booking, outcome: 'refused' });
      } catch {
        /* best-effort */
      }
      showRefusal(res);
      return;
    }
    try {
      capture('consult_prejoin', { booking_id: booking, outcome: 'ok' });
    } catch {
      /* best-effort */
    }
    if (!res.room_ws || !res.check_in_by) {
      // eslint-disable-next-line no-console
      console.warn(
        '[WAITROOM-WEB-1] prejoin is missing room_ws/check_in_by — WP1/WP2 have not landed (or the flag is off). Falling back to the direct-join flow with no waiting room.',
      );
    }
    setPrejoin(res);
    setEndsAt(res.ends_at);
    setPhase('prejoin');
  }, [booking, freshAppJwt]);

  useEffect(() => {
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap]);

  // ── join: getstream.ts → SDK client/call → apply prefs → call.join() ──
  const attemptJoin = useCallback(
    async (prefs: JoinPrefs) => {
      prefsRef.current = prefs;
      const jwt = jwtRef.current;
      if (!jwt) {
        await bootstrap();
        return;
      }
      leavingLiveRef.current = false;
      setJoinErr(null);
      setPhase('joining');
      const joinStart = Date.now();

      const generation = ++operationGenerationRef.current;
      const fresh = await freshAppJwt().catch(() => null);
      if (!fresh || !mountedRef.current || generation !== operationGenerationRef.current) return;
      jwtRef.current = fresh;
      setJwt(fresh);
      const res = await joinCommercialSession('consult', booking, fresh);
      if (!mountedRef.current || generation !== operationGenerationRef.current) return;
      if (!res.ok) {
        try {
          capture('consult_join_result', { outcome: 'refused', reason: res.reason, status: res.status, ms: Date.now() - joinStart });
        } catch {
          /* best-effort */
        }
        // A refused re-join from the waiting room (e.g. the window closed
        // while we waited) still deserves the waiting room back, not a dead
        // end — only fall through to the hard refusal screen when there is
        // no waiting room to return to.
        if (waitingRoomSupported && phaseRef.current === 'joining') {
          // Let a fresh `roster` push (e.g. the peer reconnecting) retry the
          // auto-join rather than staying stuck on this one failed attempt.
          autoJoinFiredRef.current = false;
          setPhase('waiting');
          return;
        }
        showRefusal(res);
        return;
      }
      setCreds(res);

      try {
        const rawClient = await streamClientFor(res, async () => {
          const token = await freshAppJwt();
          const refreshed = await joinCommercialSession('consult', booking, token);
          if (!refreshed.ok) throw new Error('session credentials expired');
          jwtRef.current = token;
          if (mountedRef.current) setJwt(token);
          return refreshed;
        });
        const client = rawClient as unknown as StreamVideoClient;
        // [WEB-POSTHOG-1] gs_sdk_error is wired once, client-wide, in
        // lib/getstream.ts's `streamClientFor` — no per-call hook needed here.
        const c = client.call(res.call_type, res.call_id, { reuseInstance: true });

        // Apply the green room's choices to the Call's OWN device managers —
        // the SDK acquires its own tracks on join; the PreJoin preview stream
        // was only ever for permission + device selection (and, now, the
        // waiting-room local preview).
        if (prefs.micId) await c.microphone.select(prefs.micId).catch(() => {});
        if (prefs.camId) await c.camera.select(prefs.camId).catch(() => {});
        if (!prefs.micOn) await c.microphone.disable().catch(() => {});
        if (!prefs.camOn) await c.camera.disable().catch(() => {});

        // Keep a ref before any await so a failed join can always release the
        // SDK-owned devices, even when React has not rendered the Call yet.
        callRef.current = c;
        await c.join();
        if (!mountedRef.current || generation !== operationGenerationRef.current) {
          await c.leave().catch(() => {});
          return;
        }
        setCall(c);
        // The waiting-room preview is no longer needed once GetStream owns
        // the devices — release it now rather than holding two capture
        // sessions open.
        releasePreview();

        // Refresh the authoritative end time at the moment of joining — time
        // may have passed (or a prior extension landed) since the initial
        // /prejoin fetch that seeded the green room.
        try {
          const stateJwt = await freshAppJwt();
          if (mountedRef.current) {
            jwtRef.current = stateJwt;
            setJwt(stateJwt);
          }
          const state = await commercialSessionState('consult', booking, stateJwt);
          if (state.ends_at) setEndsAt(state.ends_at);
          else if (prejoin) setEndsAt(prejoin.ends_at);
        } catch {
          if (prejoin) setEndsAt(prejoin.ends_at);
        }

        if (!mountedRef.current || generation !== operationGenerationRef.current) return;
        setPhase('live');
        joinedAtRef.current = Date.now();
        try {
          capture('consult_join_result', { outcome: 'ok', status: 200, ms: Date.now() - joinStart });
        } catch {
          /* best-effort */
        }
      } catch (e) {
        if (!mountedRef.current || generation !== operationGenerationRef.current) return;
        teardownCall();
        if (waitingRoomSupported) {
          autoJoinFiredRef.current = false;
          setPhase('waiting');
        } else {
          setJoinErr('Could not start your video. Check your connection and try again.');
          setPhase('prejoin');
        }
        try {
          capture('gs_sdk_error', { code: 'consult_join_failed', message: e instanceof Error ? e.message : String(e) });
          capture('consult_join_result', { outcome: 'error', reason: 'sdk_error', ms: Date.now() - joinStart });
          captureException(e, { code: 'gs_consult_join_failed', booking_id: booking });
        } catch {
          /* best-effort */
        }
      }
    },
    [booking, bootstrap, freshAppJwt, prejoin, releasePreview, teardownCall, waitingRoomSupported],
  );

  // ── waiting-room socket lifecycle ───────────────────────────────────────
  const tryAutoJoin = useCallback(
    (r: WaitingRoster) => {
      if (phaseRef.current !== 'waiting' || autoJoinFiredRef.current) return;
      if (!(r.host && r.attendee)) return;
      autoJoinFiredRef.current = true;
      try {
        capture('waitroom_autojoin', { booking_id: booking, role: prejoin?.role ?? null, email });
      } catch {
        /* best-effort */
      }
      void attemptJoin(prefsRef.current ?? { micOn: true, camOn: true, micId: '', camId: '' });
    },
    [attemptJoin, booking, email, prejoin?.role],
  );

  const ensureRoomSocket = useCallback(() => {
    if (roomSocketRef.current || !roomWs) return;
    const sock = new RoomSocket(roomWs, {
      onWelcome: (m) => {
        if (!mountedRef.current) return;
        if (typeof m.ends_at === 'number') setEndsAt(m.ends_at);
      },
      onRoster: (m: RosterMsg) => {
        if (!mountedRef.current) return;
        setRoster({ host: m.host, attendee: m.attendee });
        tryAutoJoin({ host: m.host, attendee: m.attendee });
      },
      onChat: (m: ChatMsg) => {
        if (!mountedRef.current) return;
        setChatLines((prev) => [...prev.slice(-60), { id: `${Date.now()}-${Math.random()}`, from: m.from, text: m.text, mine: false }]);
      },
      onEvent: (e: RoomEvent) => {
        if (!mountedRef.current) return;
        if (e.type === 'session_ended') finalizeEnded('The session has ended.');
      },
      onStatus: (s) => {
        if (mountedRef.current) setWsStatus(s);
      },
    });
    roomSocketRef.current = sock;
    sock.connect();
  }, [finalizeEnded, roomWs, tryAutoJoin]);

  // Re-acquire a lightweight local preview when returning to the waiting
  // room after a live call left GetStream owning (and this component having
  // released) the previous preview stream. Best-effort only — a denied or
  // failed re-acquire just leaves the waiting room's preview slot empty,
  // never blocks the transition.
  const reacquirePreviewIfNeeded = useCallback(() => {
    if (previewStreamRef.current || typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    const prefs = prefsRef.current;
    navigator.mediaDevices
      .getUserMedia({
        audio: prefs?.micId ? { deviceId: { exact: prefs.micId } } : true,
        video: prefs?.camId ? { deviceId: { exact: prefs.camId } } : { facingMode: 'user' },
      })
      .then((stream) => {
        if (!mountedRef.current || phaseRef.current !== 'waiting') {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.getAudioTracks().forEach((t) => (t.enabled = prefs?.micOn ?? true));
        stream.getVideoTracks().forEach((t) => (t.enabled = prefs?.camOn ?? true));
        previewStreamRef.current = stream;
        setPreviewTick((n) => n + 1);
      })
      .catch(() => {
        /* camera busy/denied — the waiting room just shows no local preview */
      });
  }, []);

  const enterWaitingRoom = useCallback(() => {
    autoJoinFiredRef.current = false;
    noShowShownRef.current = false;
    setPhase('waiting');
    try {
      capture('waitroom_enter', { booking_id: booking, role: prejoin?.role ?? null, email });
    } catch {
      /* best-effort */
    }
    ensureRoomSocket();
    reacquirePreviewIfNeeded();
  }, [booking, email, ensureRoomSocket, prejoin?.role, reacquirePreviewIfNeeded]);

  const sendWaitingChat = useCallback(
    (text: string) => {
      const t = text.trim().slice(0, 500);
      if (!t) return;
      roomSocketRef.current?.chat(t);
      setChatLines((prev) => [...prev.slice(-60), { id: `local-${Date.now()}`, from: 'You', text: t, mine: true }]);
      try {
        capture('waitroom_chat_sent', { booking_id: booking, role: prejoin?.role ?? null, email });
      } catch {
        /* best-effort */
      }
    },
    [booking, email, prejoin?.role],
  );

  const leaveFromWaiting = useCallback(() => {
    finalizeEnded('You left the session.');
  }, [finalizeEnded]);

  // ── green room handoff ─────────────────────────────────────────────────
  const onReadyFromPreJoin = (stream: MediaStream, micOn: boolean, camOn: boolean, micId: string, camId: string) => {
    prefsRef.current = { micOn, camOn, micId, camId };
    if (waitingRoomSupported) {
      // Hand the preview stream to the waiting room's own preview — it is
      // released only once GetStream's device managers take over on join.
      previewStreamRef.current = stream;
      setPreviewTick((n) => n + 1);
      enterWaitingRoom();
      return;
    }
    // Fallback (WP1/WP2 not landed): today's behaviour — release the preview
    // camera immediately and go straight to the join attempt.
    previewStreamRef.current = stream;
    stream.getTracks().forEach((t) => t.stop());
    previewStreamRef.current = null;
    void attemptJoin({ micOn, camOn, micId, camId });
  };

  // ── leaving a LIVE call: back to the waiting room (socket stays open) ──
  const leaveLive = useCallback(
    (reason: string) => {
      if (leavingLiveRef.current) return;
      leavingLiveRef.current = true;
      try {
        const billedMin = joinedAtRef.current != null ? Math.max(1, Math.round((Date.now() - joinedAtRef.current) / 60000)) : 0;
        capture('consult_end', { billed_min: billedMin });
      } catch {
        /* best-effort */
      } finally {
        joinedAtRef.current = null;
      }
      teardownCall();
      if (waitingRoomSupported && roomSocketRef.current) {
        enterWaitingRoom();
      } else {
        closeRoomSocket();
        setEndReason(reason);
        setPhase('ended');
      }
    },
    [closeRoomSocket, enterWaitingRoom, teardownCall, waitingRoomSupported],
  );

  // Provider connection state is transport-only. Poll the Worker while in the
  // room so a server-side end/cancellation is reflected even when the SDK
  // websocket remains connected.
  useEffect(() => {
    if (phase !== 'live') return;
    let disposed = false;
    const sync = async () => {
      try {
        const token = await freshAppJwt();
        const state = await commercialSessionState('consult', booking, token);
        if (!disposed && (state.state === 'ended' || state.state === 'cancelled')) {
          finalizeEnded(state.state === 'cancelled' ? 'This booking was cancelled.' : 'The session has ended.');
        }
      } catch {
        // A transient poll failure must not tear down a healthy media call.
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [booking, finalizeEnded, freshAppJwt, phase]);

  // Waiting-room clock: the no-show line (buyer) and the ends_at + 2 min
  // hard stop — both driven by the server's numbers, never a local guess
  // (RULEBOOK §3: "the DO's alarms are the clock authority... the minute
  // cron is the safety net").
  useEffect(() => {
    if (phase !== 'waiting') return;
    const tick = () => {
      const now = Date.now();
      if (
        !noShowShownRef.current &&
        prejoin?.role === 'buyer' &&
        checkInBy != null &&
        now > checkInBy &&
        !roster.host
      ) {
        noShowShownRef.current = true;
        try {
          capture('waitroom_noshow_shown', { booking_id: booking, role: prejoin?.role ?? null, email });
        } catch {
          /* best-effort */
        }
      }
      if (endsAt != null && now > endsAt + END_GRACE_MS) {
        finalizeEnded('The session has ended.');
      }
    };
    tick();
    const id = window.setInterval(tick, NOSHOW_CHECK_MS);
    return () => window.clearInterval(id);
  }, [booking, checkInBy, email, endsAt, finalizeEnded, phase, prejoin?.role, roster.host]);

  // phase === 'ended' -----------------------------------------------------
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

  // phase === 'live' --------------------------------------------------------
  if (phase === 'live' && call && creds && endsAt && jwt) {
    const role = creds.role === 'creator' ? 'creator' : 'buyer';
    return (
      <CallStage
        call={call}
        bookingId={booking}
        jwt={jwt}
        role={role}
        peerName={counterpartyName ?? 'the other participant'}
        title="Your 1:1 session"
        endsAt={endsAt}
        onEndsAtChange={setEndsAt}
        onLeave={leaveLive}
      />
    );
  }

  // phase === 'waiting' -----------------------------------------------------
  if (phase === 'waiting' && prejoin) {
    return (
      <WaitingRoom
        role={prejoin.role}
        counterpartyName={counterpartyName}
        counterpartyAvatar={counterpartyAvatar}
        startsAt={prejoin.starts_at}
        endsAt={endsAt ?? prejoin.ends_at}
        checkInBy={checkInBy}
        previewStream={previewStreamRef.current}
        micOn={prefsRef.current?.micOn ?? true}
        camOn={prefsRef.current?.camOn ?? true}
        wsStatus={wsStatus}
        roster={roster}
        chat={chatLines}
        onSendChat={sendWaitingChat}
        onLeave={leaveFromWaiting}
        key={previewTick}
      />
    );
  }

  // phase === 'loading' -----------------------------------------------------
  if (phase === 'loading') {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-3">
          <Spinner size={28} />
          <p className="font-body font-bold text-[14px] text-inkSoft">Checking your booking…</p>
        </div>
      </Centered>
    );
  }

  // phase === 'refused' -------------------------------------------------------
  if (phase === 'refused' && refusal) {
    return <RefusalScreen refusal={refusal} onRetry={() => void bootstrap()} />;
  }

  // phase === 'prejoin' or 'joining' -----------------------------------------
  return (
    <Centered>
      <div className="flex w-full max-w-md flex-col gap-4">
        {prejoin && (
          <p className="text-center font-body font-bold text-[13px] text-inkMute">
            {counterpartyName ? (
              <>
                Meeting <span className="text-ink">{counterpartyName}</span> · runs until{' '}
                {fmtTime(prejoin.ends_at)}
              </>
            ) : (
              <>Runs until {fmtTime(prejoin.ends_at)}</>
            )}
          </p>
        )}
        <PreJoin
          title="Your 1:1 session"
          peerName={counterpartyName ?? undefined}
          joining={phase === 'joining'}
          error={joinErr}
          onReady={onReadyFromPreJoin}
        />
      </div>
    </Centered>
  );
}

function RefusalScreen({ refusal, onRetry }: { refusal: JoinRefusal; onRetry: () => void }) {
  switch (refusal.reason) {
    case 'too_early':
      return (
        <Centered>
          <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
            <span className="font-mono font-bold uppercase text-[14px] tracking-[0.1em] text-blueInk">Not open yet</span>
            <h1 className="font-display font-semibold text-[26px] text-ink">You're early</h1>
            <p className="font-body font-bold text-[15px] text-inkSoft">
              The room opens shortly before your slot. We'll let you in automatically.
            </p>
            {refusal.opens_at ? (
              <Countdown target={refusal.opens_at} label="Opens in" onZero={onRetry} />
            ) : (
              <Spinner size={24} />
            )}
            <a href="/dashboard" className="font-mono text-[14px] uppercase tracking-[0.06em] text-blueInk underline font-bold">
              Back to my bookings
            </a>
          </div>
        </Centered>
      );
    case 'too_late':
      return (
        <Centered>
          <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
            <h1 className="font-display font-semibold text-[26px] text-ink">This session has ended</h1>
            <p className="font-body font-bold text-[15px] text-inkSoft">
              The booking window has closed. Your receipt is in My bookings.
            </p>
            <a href="/dashboard" className="no-underline">
              <Button variant="lime" label="My bookings" />
            </a>
          </div>
        </Centered>
      );
    case 'not_yours':
      return (
        <Centered>
          <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
            <h1 className="font-display font-semibold text-[26px] text-ink">This isn't your booking</h1>
            <p className="font-body font-bold text-[15px] text-inkSoft">
              This consultation is booked for someone else. Signed in with the wrong account?
            </p>
            <a href="/dashboard" className="no-underline">
              <Button variant="lime" label="My bookings" />
            </a>
          </div>
        </Centered>
      );
    case 'needs_ticket':
      return (
        <Centered>
          <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
            <h1 className="font-display font-semibold text-[26px] text-ink">You'll need to book this first</h1>
            <p className="font-body font-bold text-[15px] text-inkSoft">
              This session isn't in your bookings yet.
            </p>
            <a href="/dashboard" className="no-underline">
              <Button variant="lime" label="Go to my bookings" />
            </a>
          </div>
        </Centered>
      );
    case 'not_found':
      return (
        <Centered>
          <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
            <h1 className="font-display font-semibold text-[26px] text-ink">Booking not found</h1>
            <p className="font-body font-bold text-[15px] text-inkSoft">
              We couldn't find this booking. It may have been cancelled, or the link may be wrong.
            </p>
            <a href="/dashboard" className="no-underline">
              <Button variant="lime" label="My bookings" />
            </a>
          </div>
        </Centered>
      );
    case 'disabled':
      return (
        <Centered>
          <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
            <h1 className="font-display font-semibold text-[26px] text-ink">Not open yet</h1>
            <p className="font-body font-bold text-[15px] text-inkSoft">
              Paid 1:1 sessions aren't live on avaTOK yet. Check back soon.
            </p>
            <a href="/explore" className="no-underline">
              <Button variant="ghost" label="Explore" />
            </a>
          </div>
        </Centered>
      );
    default:
      return (
        <Centered>
          <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
            <h1 className="font-display font-semibold text-[26px] text-ink">Couldn't reach avaTOK</h1>
            <p className="font-body font-bold text-[15px] text-inkSoft">
              Something went wrong on our end. Please try again.
            </p>
            <Button variant="lime" label="Try again" onClick={onRetry} />
          </div>
        </Centered>
      );
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[calc(100dvh-4rem)] items-center justify-center px-4 py-8">{children}</div>;
}

/** Public entry: wraps the room in ClerkIsland so requireGuestAuth() can open the gate. */
export function ConsultRoomGS({ booking }: { booking: string }) {
  return (
    <IslandBoundary island="consult-gs-room">
      <ClerkIsland>
        <ConsultRoomGSInner booking={booking} />
      </ClerkIsland>
    </IslandBoundary>
  );
}

export default ConsultRoomGS;
