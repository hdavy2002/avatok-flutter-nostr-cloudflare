/*
 * ConsultRoomGS — the buyer/creator's side of a paid 1:1 consult on the
 * GetStream commercial lane, at `/session/<booking>` (SPEC-2026-09-01 §4.4,
 * `[WEB-GS-CONSULT-1]`). Sibling to (never a replacement for) the legacy
 * native-WebRTC room at `/consult/<booking>` — that route and its islands
 * under `web/src/islands/consult/` are untouched.
 *
 * Flow:
 *   requireGuestAuth() → GET .../prejoin (who + when, no join yet)
 *     → green room (ported PreJoin: getUserMedia preflight + device choice)
 *     → POST .../join  (joinCommercialSession from lib/getstream.ts — the
 *       ONE place call_type/call_id are minted; never guessed here)
 *     → StreamVideoClient + Call, device prefs applied, call.join()
 *     → CallStage (video, timer, extend, leave)
 *
 * Every refusal `joinCommercialSession`/`consultPrejoin` can return
 * (`JoinRefusalReason`) gets its own screen per §4.2 — no generic toast.
 *
 * Fails closed, per the pivot spec: if the provider join is refused or the
 * commercial lane is dark, this shows the refusal. It never falls back to
 * the legacy Cloudflare/WebRTC room — that would be an unmetered session.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClerkIsland, requireGuestAuth } from '../../lib/clerk';
import { Button, Spinner } from '../../components';
import { PreJoin } from './PreJoin';
import { Countdown } from './Countdown';
import { CallStage } from './CallStage';
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

type Phase = 'loading' | 'refused' | 'prejoin' | 'joining' | 'live' | 'ended';

interface JoinPrefs {
  micOn: boolean;
  camOn: boolean;
  micId: string;
  camId: string;
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toString();
  }
}

function ConsultRoomGSInner({ booking }: { booking: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [refusal, setRefusal] = useState<JoinRefusal | null>(null);
  const [prejoin, setPrejoin] = useState<ConsultPrejoin | null>(null);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [endReason, setEndReason] = useState('Session ended.');
  const [call, setCall] = useState<Call | null>(null);
  const [creds, setCreds] = useState<CommercialJoinCredentials | null>(null);
  const [jwt, setJwt] = useState<string | null>(null);

  const jwtRef = useRef<string | null>(null);
  const prefsRef = useRef<JoinPrefs | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const leavingRef = useRef(false);

  const teardownCall = useCallback(() => {
    const c = call;
    setCall(null);
    if (c) {
      try {
        void c.leave();
      } catch {
        /* already gone */
      }
    }
  }, [call]);

  useEffect(() => () => teardownCall(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const showRefusal = (r: JoinRefusal) => {
    setRefusal(r);
    setPhase('refused');
  };

  // ── bootstrap: auth → prejoin ──────────────────────────────────────────
  const bootstrap = useCallback(async () => {
    setPhase('loading');
    setJoinErr(null);
    let jwt: string;
    try {
      jwt = await requireGuestAuth();
    } catch {
      showRefusal({ ok: false, reason: 'unavailable', status: 0, detail: 'sign-in was cancelled' });
      return;
    }
    jwtRef.current = jwt;
    setJwt(jwt);
    const res = await consultPrejoin(booking, jwt);
    if ('reason' in res) {
      showRefusal(res);
      return;
    }
    setPrejoin(res);
    setPhase('prejoin');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking]);

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
      setJoinErr(null);
      setPhase('joining');

      const res = await joinCommercialSession('consult', booking, jwt);
      if (!res.ok) {
        showRefusal(res);
        return;
      }
      setCreds(res);

      try {
        const rawClient = await streamClientFor(res);
        const client = rawClient as unknown as StreamVideoClient;
        const c = client.call(res.call_type, res.call_id, { reuseInstance: true });

        // Apply the green room's choices to the Call's OWN device managers —
        // the SDK acquires its own tracks on join; the PreJoin preview stream
        // was only ever for permission + device selection.
        if (prefs.micId) await c.microphone.select(prefs.micId).catch(() => {});
        if (prefs.camId) await c.camera.select(prefs.camId).catch(() => {});
        if (!prefs.micOn) await c.microphone.disable().catch(() => {});
        if (!prefs.camOn) await c.camera.disable().catch(() => {});

        await c.join();
        setCall(c);

        // Refresh the authoritative end time at the moment of joining — time
        // may have passed (or a prior extension landed) since the initial
        // /prejoin fetch that seeded the green room.
        try {
          const state = await commercialSessionState('consult', booking, jwt);
          if (state.ends_at) setEndsAt(state.ends_at);
          else if (prejoin) setEndsAt(prejoin.ends_at);
        } catch {
          if (prejoin) setEndsAt(prejoin.ends_at);
        }

        setPhase('live');
      } catch {
        setJoinErr('Could not start your video. Check your connection and try again.');
        setPhase('prejoin');
      }
    },
    [booking, bootstrap, prejoin],
  );

  // ── green room handoff ─────────────────────────────────────────────────
  const onReadyFromPreJoin = (stream: MediaStream, micOn: boolean, camOn: boolean, micId: string, camId: string) => {
    // Release the preview camera immediately — GetStream's device managers
    // acquire their own tracks once we join; holding two capture sessions
    // open at once is pointless and, on some browsers/hardware, contested.
    previewStreamRef.current = stream;
    stream.getTracks().forEach((t) => t.stop());
    previewStreamRef.current = null;
    void attemptJoin({ micOn, camOn, micId, camId });
  };

  // ── leave / end ────────────────────────────────────────────────────────
  const endSession = useCallback(
    (reason: string) => {
      if (leavingRef.current) return;
      leavingRef.current = true;
      setEndReason(reason);
      teardownCall();
      setPhase('ended');
    },
    [teardownCall],
  );

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
        peerName={prejoin?.counterparty_name ?? 'the other participant'}
        title="Your 1:1 session"
        endsAt={endsAt}
        onEndsAtChange={setEndsAt}
        onLeave={endSession}
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
            {prejoin.counterparty_name ? (
              <>
                Meeting <span className="text-ink">{prejoin.counterparty_name}</span> · runs until{' '}
                {fmtTime(prejoin.ends_at)}
              </>
            ) : (
              <>Runs until {fmtTime(prejoin.ends_at)}</>
            )}
          </p>
        )}
        <PreJoin
          title="Your 1:1 session"
          peerName={prejoin?.counterparty_name ?? undefined}
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
    <ClerkIsland>
      <ConsultRoomGSInner booking={booking} />
    </ClerkIsland>
  );
}

export default ConsultRoomGS;
