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
  // [WAITROOM-WEB-2 fix 12] setter only — WaitingRoom used to be remounted
  // via `key={previewTick}` on every bump, which reset (and lost) the chat
  // draft the moment the preview stream ref changed. Bumping this state
  // still forces the re-render that picks up the new `previewStreamRef`
  // value, but no longer remounts the component.
  const [, setPreviewTick] = useState(0);

  const jwtRef = useRef<string | null>(null);
  const prefsRef = useRef<JoinPrefs | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const callRef = useRef<Call | null>(null);
  const mountedRef = useRef(true);
  const operationGenerationRef = useRef(0);
  const leavingLiveRef = useRef(false);
  const phaseRef = useRef<Phase>('loading');
  const roomSocketRef = useRef<RoomSocket | null>(null);
  // [WAITROOM-WEB-2 fix 1] `roster` state lags a render behind — the 5s
  // retry timer and any synchronous check need the LATEST roster, not the
  // one from whenever this closure was created.
  const rosterRef = useRef<WaitingRoster>({ host: false, attendee: false });
  // True for the whole life of one `attemptJoin()` call — the 5s timer must
  // never stack a second attempt on top of one already in flight.
  const joinInFlightRef = useRef(false);
  // Epoch ms the join window opens. Seeded from prejoin's `join_opens_at`
  // (when present) and re-armed from a 425 refusal's `opens_at` — auto-join
  // must not hammer `/join` before the server will actually accept it.
  const opensAtRef = useRef<number | null>(null);
  // [WAITROOM-WEB-2 fix 1] Set after a DELIBERATE Leave (from a live call
  // back to the waiting room) so the roster-driven/timer-driven auto-join
  // does not immediately rejoin the caller into the call they just left.
  // Cleared the moment the roster actually changes, or by the "Rejoin call"
  // button.
  const autoJoinPausedRef = useRef(false);
  const [autoJoinPaused, setAutoJoinPaused] = useState(false);
  // [WAITROOM-WEB-2 fix 6/7] Epoch ms of the creator's first socket open.
  // Prefers the server's `host_checked_in_at` (welcome/roster); falls back
  // to this client's own first observation of `roster.host === true` when
  // that field is absent.
  const hostCheckedInAtRef = useRef<number | null>(null);
  // [WAITROOM-WEB-3 C3] True once we've heard ANYTHING from the socket
  // (welcome or roster) at least once. `phase` flips to 'waiting' — and the
  // no-show tick effect starts running — before the socket has actually
  // opened; without this gate, the tick's very first run saw the default
  // `roster.host === false` and no `hostCheckedInAtRef` yet, called that a
  // no-show, and `noShowRef` (with nothing left to ever clear it) stuck the
  // visitor there for good even once the real roster arrived seconds later.
  const rosterSeenRef = useRef(false);
  const noShowShownRef = useRef(false);
  // [WAITROOM-WEB-3 C11] Set once the waiting-room socket gives up for good
  // (RoomSocket's `onAuthFailed`, fix 16) — from then on there is no socket
  // left to report roster presence, so auto-join retries must stop waiting
  // for `roster.host && roster.attendee` and go by the join window alone.
  const socketAbandonedRef = useRef(false);
  // [WAITROOM-WEB-2 fix 6] Terminal: `check_in_by` passed with the host
  // never checked in. Stops auto-join for good and starts polling the
  // server consult state for the refund/cancellation outcome.
  const noShowRef = useRef(false);
  const [noShow, setNoShow] = useState(false);
  // [WAITROOM-WEB-2 fix 11] This client's own DO uid, learned from the
  // `presence` event the DO always echoes back to a socket for its own
  // join (role uniquely identifies "us" in a 1:1: 'host' XOR 'attendee').
  const myRoomUidRef = useRef<string | null>(null);
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

  // [WAITROOM-WEB-2 fix 3] Time out only the token READ, never the sign-in
  // popup — `requireGuestAuth()` can legitimately sit open for minutes while
  // a human types credentials into a Clerk modal; wrapping the whole chain in
  // a 10s timeout (as an earlier draft did) killed that popup out from under
  // the user.
  const freshAppJwt = useCallback(async (): Promise<string> => {
    const fresh = await withTimeout(getActiveToken({ skipCache: true }), 10_000, 'auth timed out').catch(() => null);
    return fresh ?? requireGuestAuth();
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

  // [WAITROOM-WEB-2 fix 1] Seed the join window from prejoin's own
  // `join_opens_at`, when the server sends one — a re-arm from a 425's
  // `opens_at` (in attemptJoin's refusal branch) always wins after that.
  useEffect(() => {
    if (typeof prejoin?.join_opens_at === 'number') {
      opensAtRef.current = prejoin.join_opens_at;
    }
  }, [prejoin?.join_opens_at]);

  // Re-acquire a lightweight local preview when returning to the waiting
  // room after a live call left GetStream owning (and this component having
  // released) the previous preview stream, or after a failed join
  // (`attemptJoin`'s catch — fix 10) released it ahead of `c.join()`.
  // Best-effort only — a denied or failed re-acquire just leaves the
  // waiting room's preview slot empty, never blocks the transition.
  // Declared ahead of `attemptJoin` (which references it) — a `const`
  // declared after would be in the temporal dead zone when attemptJoin's own
  // useCallback dependency array is evaluated on first render.
  const reacquirePreviewIfNeeded = useCallback(() => {
    if (previewStreamRef.current || typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    const prefs = prefsRef.current;
    const audio: MediaStreamConstraints['audio'] = prefs?.micId ? { deviceId: { exact: prefs.micId } } : true;
    const adopt = (stream: MediaStream) => {
      if (!mountedRef.current || phaseRef.current !== 'waiting') {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.getAudioTracks().forEach((t) => (t.enabled = prefs?.micOn ?? true));
      stream.getVideoTracks().forEach((t) => (t.enabled = prefs?.camOn ?? true));
      previewStreamRef.current = stream;
      setPreviewTick((n) => n + 1);
    };
    navigator.mediaDevices
      .getUserMedia({
        audio,
        // [AV-AUDIO-ONLY-1] `camOn === false` here means either "the user
        // turned the camera off" or "PreJoin found no camera at all" — either
        // way, asking for video would reject on a camera-less desktop and
        // leave the waiting room with no preview AND no mic meter.
        video: prefs?.camOn === false
          ? false
          : prefs?.camId
            ? { deviceId: { exact: prefs.camId } }
            : { facingMode: 'user' },
      })
      .then(adopt)
      .catch(() => {
        // Camera busy/absent after all — retry audio-only so the waiting room
        // still holds a live mic, rather than falling back to nothing.
        if (prefs?.camOn === false) return;
        navigator.mediaDevices
          .getUserMedia({ audio, video: false })
          .then(adopt)
          .catch(() => {
            /* mic denied too — the waiting room just shows no local preview */
          });
      });
  }, []);

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
        // [WAITROOM-WEB-3 C9] Only a refusal the waiting room can genuinely
        // recover from goes back to it — everything else was quietly
        // swallowed into "back to waiting" before, which hid a real
        // `needs_ticket`/`not_yours`/`disabled`/`not_found` refusal (or a
        // 410 the session is actually over) behind an endless silent retry.
        if (waitingRoomSupported && phaseRef.current === 'joining') {
          // 425: the join window genuinely hasn't opened yet — re-arm the
          // 5s auto-join timer to wait for `opens_at`.
          if (res.reason === 'too_early') {
            if (typeof res.opens_at === 'number') opensAtRef.current = res.opens_at;
            setPhase('waiting');
            return;
          }
          // A transient network/server hiccup (status 0, or a 5xx the
          // server's own catch-all folds into 'unavailable') — worth one
          // more try, not a hard stop.
          if (res.reason === 'unavailable' && (res.status === 0 || res.status >= 500)) {
            setPhase('waiting');
            return;
          }
          // 410 — the window closed or the session is over (`too_late` /
          // `session_terminal` both land here). There is nothing left to
          // retry: finalize instead of bouncing back to a waiting room for
          // a slot that no longer exists.
          if (res.reason === 'too_late') {
            finalizeEnded('This session has ended.');
            return;
          }
          // needs_ticket / not_yours / disabled / not_found, or a
          // non-transient 'unavailable' — a real refusal, not a hiccup.
          showRefusal(res);
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

        // [WAITROOM-WEB-2 fix 10] Release the waiting-room preview BEFORE
        // `c.join()`, not after — some browsers refuse to hand GetStream's
        // own device managers a camera/mic that this component's preview
        // `getUserMedia()` stream still holds open, and holding two capture
        // sessions across the join call was never necessary anyway. A failed
        // join re-acquires a preview for the waiting room it falls back to
        // (see the `catch` below).
        releasePreview();

        // Keep a ref before any await so a failed join can always release the
        // SDK-owned devices, even when React has not rendered the Call yet.
        callRef.current = c;
        await c.join();
        if (!mountedRef.current || generation !== operationGenerationRef.current) {
          await c.leave().catch(() => {});
          return;
        }
        setCall(c);

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
          setPhase('waiting');
          // [WAITROOM-WEB-2 fix 10] `releasePreview()` above already tore
          // down the waiting-room's own capture session before the (now
          // failed) `c.join()` — re-acquire it so the waiting room this
          // falls back to isn't left with a blank local preview.
          reacquirePreviewIfNeeded();
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
    [booking, bootstrap, finalizeEnded, freshAppJwt, prejoin, reacquirePreviewIfNeeded, releasePreview, teardownCall, waitingRoomSupported],
  );

  // ── waiting-room socket lifecycle ───────────────────────────────────────
  // [WAITROOM-WEB-2 fix 1] Rewritten: this used to be a one-shot
  // "`autoJoinFiredRef` flips true forever" guard fired only from `roster`
  // pushes — a `roster` push lost to a reconnect, or a join refused for a
  // reason other than the socket returning to 'waiting', left the pair
  // stuck facing each other with no way back in short of a reload. Now:
  // `joinInFlightRef` only guards ONE attempt at a time (cleared when it
  // settles), a 5s timer (below) keeps retrying while both are present, and
  // `opensAtRef`/`autoJoinPausedRef` gate WHEN it's allowed to fire.
  const tryAutoJoin = useCallback(
    (r: WaitingRoster) => {
      if (phaseRef.current !== 'waiting') return;
      if (noShowRef.current || autoJoinPausedRef.current || joinInFlightRef.current) return;
      // [WAITROOM-WEB-3 C4] Once the slot's own end time has passed, never
      // auto-join again — the server still accepts `/join` until
      // `ends_at + 2min`, so without this a leave right at `endsAt`
      // ("Time is up.") re-entered waiting, this immediately rejoined, the
      // Countdown fired `onZero` again instantly, and the cycle repeated.
      if (endsAt != null && Date.now() >= endsAt) return;
      const opensAt = opensAtRef.current;
      if (opensAt != null && Date.now() < opensAt) return;
      // [WAITROOM-WEB-3 C11] With no working socket left (`onAuthFailed`
      // gave up on it), there is no roster to wait on — retry by the join
      // window alone. With a live socket, still wait for both parties.
      if (!socketAbandonedRef.current && !(r.host && r.attendee)) return;
      joinInFlightRef.current = true;
      try {
        capture('waitroom_autojoin', { booking_id: booking, role: prejoin?.role ?? null, email });
      } catch {
        /* best-effort */
      }
      void attemptJoin(prefsRef.current ?? { micOn: true, camOn: true, micId: '', camId: '' }).finally(() => {
        joinInFlightRef.current = false;
      });
    },
    [attemptJoin, booking, email, endsAt, prejoin?.role],
  );

  const ensureRoomSocket = useCallback(() => {
    if (roomSocketRef.current || !roomWs) return;
    const myRole = prejoin?.role === 'creator' ? 'host' : 'attendee';
    // [WAITROOM-WEB-3 C11] A FRESH socket gets a fresh chance at reporting
    // roster presence — only a socket that itself gives up 3x should make
    // auto-join stop waiting on it.
    socketAbandonedRef.current = false;
    const sock = new RoomSocket(roomWs, {
      onWelcome: (m) => {
        if (!mountedRef.current) return;
        // [WAITROOM-WEB-3 C3] `welcome` is the first thing the socket ever
        // sends — hearing it at all means the no-show tick can trust
        // `roster.host`/`hostCheckedInAtRef` from now on instead of the
        // pre-connect defaults.
        rosterSeenRef.current = true;
        if (typeof m.ends_at === 'number') setEndsAt(m.ends_at);
        // [WAITROOM-WEB-2 fix 6/7] Prefer the server's own record.
        if (typeof m.host_checked_in_at === 'number') {
          hostCheckedInAtRef.current = m.host_checked_in_at;
        }
      },
      onRoster: (m: RosterMsg) => {
        if (!mountedRef.current) return;
        rosterSeenRef.current = true;
        const next = { host: m.host, attendee: m.attendee };
        const prev = rosterRef.current;
        rosterRef.current = next;
        setRoster(next);
        if (typeof m.host_checked_in_at === 'number') {
          hostCheckedInAtRef.current = m.host_checked_in_at;
        } else if (m.host && hostCheckedInAtRef.current == null) {
          // Fallback (fix 6/7): no server timestamp yet — the first roster
          // push where the host is present IS our own check-in evidence.
          hostCheckedInAtRef.current = Date.now();
        }
        // [WAITROOM-WEB-2 fix 1] A roster CHANGE always lifts a Leave-driven
        // pause — the whole point of pausing was "don't rejoin the exact
        // situation I just walked away from"; once presence has actually
        // moved, that situation is gone.
        if (autoJoinPausedRef.current && (prev.host !== next.host || prev.attendee !== next.attendee)) {
          autoJoinPausedRef.current = false;
          setAutoJoinPaused(false);
        }
        tryAutoJoin(next);
      },
      onChat: (m: ChatMsg) => {
        if (!mountedRef.current) return;
        // [WAITROOM-WEB-2 fix 11] Prefer the DO event's own uid; until the
        // worker adds it to `chat`, fall back to "not the counterparty" —
        // sound in a 1:1 waiting room, where the only two possible senders
        // are me and the one counterparty we already know by name.
        const mine =
          m.uid != null && myRoomUidRef.current != null
            ? m.uid === myRoomUidRef.current
            : counterpartyName != null
              ? m.from !== counterpartyName
              : false;
        setChatLines((prev) => [...prev.slice(-60), { id: `${Date.now()}-${Math.random()}`, from: m.from, text: m.text, mine }]);
      },
      onEvent: (e: RoomEvent) => {
        if (!mountedRef.current) return;
        if (e.type === 'session_ended') finalizeEnded('The session has ended.');
        // [WAITROOM-WEB-2 fix 11] Self-identify our own DO uid off the
        // `presence` echo the DO sends for our own join — role is unique
        // per party in a 1:1 (host XOR attendee), so this is unambiguous.
        if (e.type === 'presence' && e.joined && typeof e.uid === 'string' && e.role === myRole && myRoomUidRef.current == null) {
          myRoomUidRef.current = e.uid;
        }
      },
      onStatus: (s) => {
        if (mountedRef.current) setWsStatus(s);
      },
      onAuthFailed: () => {
        // [WAITROOM-WEB-2 fix 16] The socket gave up after repeatedly
        // failing to open — fall back to a direct join rather than leaving
        // the visitor stuck facing a socket that will never connect.
        // [WAITROOM-WEB-3 C11] There is no socket left to report roster
        // presence from this point on — `tryAutoJoin`'s 5s retry must stop
        // waiting on it and go by the join window alone.
        socketAbandonedRef.current = true;
        if (!mountedRef.current) return;
        closeRoomSocket();
        if (phaseRef.current === 'waiting' && !joinInFlightRef.current) {
          void attemptJoin(prefsRef.current ?? { micOn: true, camOn: true, micId: '', camId: '' });
        }
      },
    });
    roomSocketRef.current = sock;
    sock.connect();
  }, [attemptJoin, closeRoomSocket, counterpartyName, finalizeEnded, prejoin?.role, roomWs, tryAutoJoin]);

  const enterWaitingRoom = useCallback(() => {
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
      // [WAITROOM-WEB-2 fix 11] No local echo — the DO broadcasts `chat` to
      // every socket in the room, sender included, so pushing our own copy
      // here just duplicated the line once the real one arrived.
      roomSocketRef.current?.chat(t);
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
      // [WAITROOM-WEB-2 fix 1] Only the button-press path ("You left the
      // session.", CallStage's own Leave control) is a DELIBERATE leave —
      // the countdown hitting zero or the provider ending the call are not
      // the visitor choosing to walk out, and must not pause auto-join.
      const deliberate = reason === 'You left the session.';
      try {
        const billedMin = joinedAtRef.current != null ? Math.max(1, Math.round((Date.now() - joinedAtRef.current) / 60000)) : 0;
        capture('consult_end', { billed_min: billedMin });
      } catch {
        /* best-effort */
      } finally {
        joinedAtRef.current = null;
      }
      // [WAITROOM-WEB-3 C4] Once the slot's own end time has passed, do not
      // loop back into the waiting room at all — the server still accepts
      // `/join` until `ends_at + 2min`, so returning to waiting here just
      // fed a join/leave loop: "Time is up." (CallStage's Countdown, or the
      // SDK's own CallingState.LEFT) re-entered waiting, auto-join rejoined
      // immediately, the Countdown fired `onZero` again the instant it
      // rendered, repeat. This applies to EVERY `leaveLive` reason,
      // deliberate or not — a slot that is over is over.
      if (endsAt != null && Date.now() >= endsAt) {
        finalizeEnded(reason);
        return;
      }
      teardownCall();
      if (waitingRoomSupported && roomSocketRef.current) {
        if (deliberate) {
          // Both parties are typically still present in the DO room right
          // after this — without a pause, the very next roster push (or the
          // 5s timer) would instantly rejoin the call the visitor just left.
          autoJoinPausedRef.current = true;
          setAutoJoinPaused(true);
        }
        enterWaitingRoom();
      } else {
        closeRoomSocket();
        setEndReason(reason);
        setPhase('ended');
      }
    },
    [closeRoomSocket, endsAt, enterWaitingRoom, finalizeEnded, teardownCall, waitingRoomSupported],
  );

  // [WAITROOM-WEB-2 fix 1] "Rejoin call" — the manual escape hatch from a
  // deliberate-Leave pause. Lifts the pause and asks `tryAutoJoin` to try
  // immediately; if the roster or join window isn't ready yet, the 5s timer
  // (below) picks it back up exactly as it would for any other visitor.
  const rejoinCall = useCallback(() => {
    autoJoinPausedRef.current = false;
    setAutoJoinPaused(false);
    tryAutoJoin(rosterRef.current);
  }, [tryAutoJoin]);

  // [WAITROOM-WEB-2 fix 1] The 5s auto-join retry timer — the actual fix for
  // "auto-join must not get stuck". Runs only while waiting; every tick is a
  // no-op unless both are present, no join is in flight, we're not paused
  // after a deliberate Leave, and the join window (`opensAtRef`) has opened.
  useEffect(() => {
    if (phase !== 'waiting') return;
    const id = window.setInterval(() => tryAutoJoin(rosterRef.current), 5000);
    return () => window.clearInterval(id);
  }, [phase, tryAutoJoin]);

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
      // [WAITROOM-WEB-2 fix 6] The host is a no-show only if `check_in_by`
      // passed with no evidence it EVER checked in — `!roster.host` alone
      // (the current instant) would flip back to "not a no-show" the moment
      // a late host connects, even though that's still a no-show for
      // billing purposes. `hostCheckedInAtRef` is the durable record: the
      // server's `host_checked_in_at` when present, else this client's own
      // first observed `roster.host === true` (roster-history fallback).
      const hostCheckedInAt = hostCheckedInAtRef.current;
      const onTimeCheckIn = checkInBy != null && hostCheckedInAt != null && hostCheckedInAt <= checkInBy;
      // [WAITROOM-WEB-3 C3] `roster.host === false` and `hostCheckedInAtRef
      // === null` are ALSO this tick's pre-connect defaults — without
      // `rosterSeenRef`, the very first tick right after `phase` flips to
      // 'waiting' (before the socket has even opened) read exactly like a
      // no-show and, with nothing to ever clear it, got stuck there even
      // once the real roster arrived a moment later.
      const isNoShow =
        rosterSeenRef.current &&
        prejoin?.role === 'buyer' &&
        checkInBy != null &&
        now > checkInBy &&
        !roster.host &&
        !onTimeCheckIn;
      // [WAITROOM-WEB-3 C3] New evidence that the host actually DID check
      // in on time (a delayed `host_checked_in_at`, or this client's own
      // roster-history fallback recording it) always wins over an earlier,
      // premature no-show call — clear it and let auto-join resume.
      if (noShowRef.current && onTimeCheckIn) {
        noShowRef.current = false;
        setNoShow(false);
      }
      if (isNoShow && !noShowShownRef.current) {
        noShowShownRef.current = true;
        try {
          capture('waitroom_noshow_shown', { booking_id: booking, role: prejoin?.role ?? null, email });
        } catch {
          /* best-effort */
        }
      }
      // [WAITROOM-WEB-2 fix 6] Terminal: stop auto-join for good and start
      // polling the server for the refund/cancellation outcome. Re-derived
      // every tick from `noShowShownRef`, so a late-arriving `roster.host`
      // before `checkInBy` (a genuine, on-time check-in) never gets here.
      if (isNoShow && !noShowRef.current) {
        noShowRef.current = true;
        setNoShow(true);
      }
      if (endsAt != null && now > endsAt + END_GRACE_MS) {
        finalizeEnded('The session has ended.');
      }
    };
    tick();
    const id = window.setInterval(tick, NOSHOW_CHECK_MS);
    return () => window.clearInterval(id);
  }, [booking, checkInBy, email, endsAt, finalizeEnded, phase, prejoin?.role, roster.host]);

  // [WAITROOM-WEB-2 fix 6] Once in the terminal no-show state, poll the
  // server consult state so the visitor's screen reflects the refund the
  // server settles (cancelled) rather than sitting on the client's own
  // guess forever.
  useEffect(() => {
    if (!noShow || phase !== 'waiting') return;
    let disposed = false;
    const sync = async () => {
      try {
        const token = await freshAppJwt();
        const state = await commercialSessionState('consult', booking, token);
        if (disposed) return;
        if (state.state === 'cancelled') finalizeEnded('This booking was cancelled and refunded.');
        else if (state.state === 'ended') finalizeEnded('The session has ended.');
      } catch {
        // A transient poll failure just tries again on the next tick.
      }
    };
    void sync();
    const id = window.setInterval(() => void sync(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(id);
    };
  }, [booking, finalizeEnded, freshAppJwt, noShow, phase]);

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
        hostCheckedInAt={hostCheckedInAtRef.current}
        noShow={noShow}
        chat={chatLines}
        onSendChat={sendWaitingChat}
        onLeave={leaveFromWaiting}
        autoJoinPaused={autoJoinPaused}
        onRejoin={rejoinCall}
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
