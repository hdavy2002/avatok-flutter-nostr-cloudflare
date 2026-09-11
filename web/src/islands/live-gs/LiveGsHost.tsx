/*
 * Browser creator console for a commercial GetStream live event.
 *
 * The lifecycle is deliberately two-step: camera/mic preview, then the
 * server-authorized private backstage room, then an explicit Start live.
 * Provider identity always comes from prepare-host; this island never mints
 * or derives a call type or call id.
 */
import '@stream-io/video-react-sdk/dist/css/styles.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ParticipantView,
  StreamCall,
  StreamVideo,
  CallingState,
  useCallStateHooks,
  type Call,
} from '@stream-io/video-react-sdk';
import { Button, Spinner } from '../../components';
import { DeviceChecks } from '../../components/DeviceChecks';
import { ClerkIsland, getActiveToken, requireGuestAuth } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { capture, captureException } from '../../lib/analytics';
import { ApiError } from '../../lib/apiClient';
import {
  commercialLiveHostState,
  endCommercialLive,
  goLiveCommercial,
  newHostIdempotencyKey,
  prepareCommercialLiveHost,
  type CommercialHostCredentials,
  type CommercialHostState,
} from '../../lib/commercialHost';
import { streamClientFor } from '../../lib/getstream';

// [LIVE-GRACE-WEB-1] The server contract (Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md
// "Contracts shared by all WPs") adds a `reconnecting` state and
// `reconnect_deadline_ms` to `GET .../live/:id/state`, landing with WP8. Widen
// the shape locally rather than editing the shared lib (owned by another WP) —
// the extra fields are always optional/absent until WP8 ships.

export interface LiveGsHostProps {
  listingId: string;
  title?: string;
  poster?: string | null;
  startsAt?: number | null;
  endsAt?: number | null;
}

type Phase =
  | 'authorizing'
  | 'not_found'
  | 'not_creator'
  | 'rejoin'
  | 'preview'
  | 'preparing'
  | 'backstage'
  | 'starting'
  | 'live'
  | 'ending'
  | 'ended'
  | 'refused';
type JoinPrefs = { micOn: boolean; camOn: boolean; micId: string; camId: string };

/** Widened `CommercialHostState` — see the import-site comment above. */
export type HostServerState = Omit<CommercialHostState, 'state'> & {
  state: CommercialHostState['state'] | 'reconnecting';
  reconnect_deadline_ms?: number;
};

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function safeError(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'error' in e) {
    const message = String((e as { error?: unknown }).error ?? '');
    if (message && message.length < 180) return message;
  }
  return e instanceof Error && e.message ? e.message : fallback;
}

function HostPreview({
  title,
  busy,
  error,
  onReady,
}: {
  title: string;
  busy: boolean;
  error: string | null;
  onReady: (stream: MediaStream, prefs: JoinPrefs) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const acquireGenerationRef = useRef(0);
  const [permission, setPermission] = useState<'asking' | 'granted' | 'denied'>('asking');
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState('');
  const [camId, setCamId] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMics(devices.filter((d) => d.kind === 'audioinput'));
      setCams(devices.filter((d) => d.kind === 'videoinput'));
    } catch {
      /* Permissions or an older browser can reject enumeration. */
    }
  }, []);

  const acquire = useCallback(async () => {
    const generation = ++acquireGenerationRef.current;
    setPermission('asking');
    setPermissionError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micId ? { deviceId: { exact: micId } } : true,
        video: camId ? { deviceId: { exact: camId } } : { facingMode: 'user' },
      });
      if (!mountedRef.current || generation !== acquireGenerationRef.current) {
        stopTracks(stream);
        return;
      }
      stopTracks(streamRef.current);
      streamRef.current = stream;
      setPreviewStream(stream);
      stream.getAudioTracks().forEach((track) => (track.enabled = micOn));
      stream.getVideoTracks().forEach((track) => (track.enabled = camOn));
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {});
      }
      setPermission('granted');
      await refreshDevices();
    } catch (e) {
      setPermission('denied');
      const name = (e as DOMException)?.name;
      setPermissionError(
        name === 'NotAllowedError'
          ? 'Camera and microphone access is blocked. Allow both in your browser, then retry.'
          : name === 'NotFoundError'
            ? 'No camera or microphone was found.'
            : 'Could not start the camera and microphone.',
      );
    }
  }, [camId, camOn, micId, micOn, refreshDevices]);

  useEffect(() => {
    mountedRef.current = true;
    void acquire();
    return () => {
      mountedRef.current = false;
      acquireGenerationRef.current += 1;
      stopTracks(streamRef.current);
      streamRef.current = null;
    };
    // Device changes are handled by the second effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (permission === 'granted') void acquire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micId, camId]);

  const toggle = (kind: 'mic' | 'cam') => {
    if (kind === 'mic') {
      const next = !micOn;
      setMicOn(next);
      streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = next));
    } else {
      const next = !camOn;
      setCamOn(next);
      streamRef.current?.getVideoTracks().forEach((track) => (track.enabled = next));
    }
  };

  const selectClass = 'min-w-0 flex-1 rounded-zine-field border-zine border-ink bg-card px-3 py-2 font-body font-bold text-[14px] focus:outline-none focus:shadow-zine-focus';
  const deviceLabel = (device: MediaDeviceInfo, fallback: string, index: number) => device.label || `${fallback} ${index + 1}`;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-8">
      <div className="max-w-2xl">
        <span className="font-mono font-bold uppercase text-[13px] tracking-[0.1em] text-blueInk">Creator green room</span>
        <h1 className="mt-2 font-display text-[30px] font-semibold leading-tight text-ink">Test your setup before you go live.</h1>
        <p className="mt-2 font-body text-[15px] font-bold leading-relaxed text-inkSoft">
          This preview is private. Ticket holders cannot see or hear you until you confirm Start live.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <div className="relative aspect-video overflow-hidden rounded-zine border-zine border-ink bg-ink shadow-zine">
          <video ref={videoRef} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" />
          {permission !== 'granted' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-paper2 px-6 text-center">
              {permission === 'asking' ? <><Spinner size={28} /><p className="font-body font-bold text-[14px] text-inkSoft">Requesting camera and microphone…</p></> : <>
                <p className="font-body font-bold text-[14px] text-inkSoft">{permissionError ?? 'Allow camera and microphone to continue.'}</p>
                <Button variant="blue" label="Allow & retry" onClick={() => void acquire()} />
              </>}
            </div>
          )}
          {permission === 'granted' && !camOn && <div className="absolute inset-0 flex items-center justify-center bg-ink/80 font-display text-[17px] font-semibold text-paper">Camera off</div>}
        </div>

        <div className="flex flex-col gap-3 rounded-zine border-zine border-ink bg-card p-4 shadow-zine-sm">
          <h2 className="font-display text-[19px] font-semibold text-ink">Devices</h2>
          <DeviceChecks stream={previewStream} micOn={micOn} />
          <label className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkMute" htmlFor="host-mic">Microphone</label>
          <div className="flex gap-2">
            <select id="host-mic" aria-label="Microphone" className={selectClass} value={micId} onChange={(e) => setMicId(e.target.value)} disabled={permission !== 'granted'}>
              {mics.length === 0 && <option value="">Default microphone</option>}
              {mics.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, 'Microphone', index)}</option>)}
            </select>
            <button type="button" onClick={() => toggle('mic')} aria-pressed={micOn} className={`rounded-zine-field border-zine border-ink px-3 py-2 font-display font-semibold text-[14px] ${micOn ? 'bg-lime text-ink' : 'bg-coral text-white'}`}>{micOn ? 'On' : 'Off'}</button>
          </div>
          <label className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkMute" htmlFor="host-cam">Camera</label>
          <div className="flex gap-2">
            <select id="host-cam" aria-label="Camera" className={selectClass} value={camId} onChange={(e) => setCamId(e.target.value)} disabled={permission !== 'granted'}>
              {cams.length === 0 && <option value="">Default camera</option>}
              {cams.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{deviceLabel(device, 'Camera', index)}</option>)}
            </select>
            <button type="button" onClick={() => toggle('cam')} aria-pressed={camOn} className={`rounded-zine-field border-zine border-ink px-3 py-2 font-display font-semibold text-[14px] ${camOn ? 'bg-lime text-ink' : 'bg-coral text-white'}`}>{camOn ? 'On' : 'Off'}</button>
          </div>
          {error && <div className="rounded-zine border-zine border-coral bg-paper2 p-3 font-body text-[13px] font-bold text-ink shadow-zine-error">{error}</div>}
          <Button variant="lime" fullWidth loading={busy} disabled={permission !== 'granted' || busy} label={busy ? 'Opening backstage…' : 'Enter private backstage'} onClick={() => {
            const stream = streamRef.current;
            if (stream) onReady(stream, { micOn, camOn, micId, camId });
          }} />
          <p className="font-body text-[12px] font-bold leading-relaxed text-inkMute">Starting the preview never starts the broadcast. You choose Start live after the private room opens.</p>
        </div>
      </div>
    </div>
  );
}

function HostStage({
  title,
  phase,
  serverState,
  error,
  onStart,
  onEnd,
  onRetry,
}: {
  title: string;
  phase: 'backstage' | 'starting' | 'live' | 'ending';
  serverState: string;
  error: string | null;
  onStart: () => void;
  onEnd: () => void;
  onRetry: () => void;
}) {
  const { useLocalParticipant, useCallCallingState, useCameraState, useMicrophoneState, useParticipantCount } = useCallStateHooks();
  const local = useLocalParticipant();
  const callingState = useCallCallingState();
  const camera = useCameraState();
  const microphone = useMicrophoneState();
  const participantCount = useParticipantCount();
  const reconnecting = callingState === CallingState.RECONNECTING || callingState === CallingState.MIGRATING;
  const connectionLost = phase !== 'ending' && (
    callingState === CallingState.RECONNECTING_FAILED
    || callingState === CallingState.OFFLINE
    || callingState === CallingState.LEFT
  );
  const controlsDisabled = phase === 'ending' || phase === 'starting';

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-5rem)] max-w-6xl flex-col gap-3 px-3 py-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="mr-auto"><span className="font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-blueInk">Creator broadcast</span><h1 className="font-display text-[23px] font-semibold text-ink">{title}</h1></div>
        <span className={`rounded-zine-badge border-zine px-3 py-1.5 font-mono text-[12px] font-bold uppercase ${phase === 'live' ? 'border-coral bg-coral text-white' : 'border-ink bg-card text-ink'}`}>{phase === 'live' ? 'Live' : phase === 'starting' ? 'Starting' : phase === 'ending' ? 'Ending' : 'Private backstage'}</span>
        <span className="rounded-zine-badge border-zine border-ink bg-card px-3 py-1.5 font-mono text-[12px] font-bold text-inkSoft">{participantCount} connected</span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-zine border-zine border-ink bg-ink shadow-zine">
        <div className="relative aspect-video w-full bg-ink">
          {local ? <ParticipantView participant={local} trackType="videoTrack" className="h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-contain" /> : <div className="flex h-full items-center justify-center text-center font-body font-bold text-white">Camera is initializing…</div>}
          {phase === 'backstage' && <div className="absolute left-3 top-3 rounded-zine-badge border-zine border-ink bg-lime px-3 py-1.5 font-mono text-[12px] font-bold uppercase text-ink shadow-zine-xs">Private · viewers waiting</div>}
          {reconnecting && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/65 text-center text-white"><Spinner size={28} color="#fff" /><p className="font-display text-[18px] font-semibold">Reconnecting…</p></div>}
          {connectionLost && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/80 px-6 text-center text-white"><p className="font-display text-[19px] font-semibold">Connection lost</p><p className="font-body text-[14px] font-bold text-white/80">The broadcast is still governed by the server. Rejoin when your connection is ready.</p><button type="button" onClick={onRetry} className="rounded-full border-zine border-ink bg-lime px-5 py-2.5 font-display text-[15px] font-semibold text-ink">Reconnect</button></div>}
        </div>
        {error && <div className="border-t-zine border-coral bg-paper2 px-4 py-3 text-center font-body text-[13px] font-bold text-ink">{error}</div>}
        <div className="flex flex-wrap items-center justify-center gap-3 border-t-zine border-ink bg-paper px-3 py-3">
          <button type="button" aria-label={microphone.isMute ? 'Turn microphone on' : 'Mute microphone'} aria-pressed={!microphone.isMute} disabled={controlsDisabled} onClick={() => void microphone.microphone.toggle()} className={`inline-flex h-12 w-12 items-center justify-center rounded-full border-zine border-ink shadow-zine-sm ${microphone.isMute ? 'bg-coral text-white' : 'bg-card text-ink'}`}>{microphone.isMute ? '🔇' : '🎙️'}</button>
          <button type="button" aria-label={camera.isMute ? 'Turn camera on' : 'Turn camera off'} aria-pressed={!camera.isMute} disabled={controlsDisabled} onClick={() => void camera.camera.toggle()} className={`inline-flex h-12 w-12 items-center justify-center rounded-full border-zine border-ink shadow-zine-sm ${camera.isMute ? 'bg-coral text-white' : 'bg-card text-ink'}`}>{camera.isMute ? '🚫' : '📷'}</button>
          {phase === 'backstage' && <Button variant="lime" label="Start live" onClick={onStart} />}
          {phase === 'starting' && <span className="rounded-full border-zine border-ink bg-blue px-5 py-3 font-display text-[16px] font-semibold text-ink">Waiting for server confirmation…</span>}
          {phase === 'live' && <span className="font-body text-[13px] font-bold text-inkSoft">{serverState === 'live' ? 'Ticket holders can watch now.' : 'Updating live status…'}</span>}
          <Button variant="coral" label={phase === 'ending' ? 'Ending…' : 'End event'} disabled={phase === 'ending'} onClick={onEnd} />
        </div>
      </div>
      <p className="text-center font-body text-[12px] font-bold text-inkMute">Keep this tab open while you host. If your connection drops, the Reconnect control rejoins the same server-issued room.</p>
    </div>
  );
}

function Authorizing() {
  return <div className="flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 py-10"><div className="flex flex-col items-center gap-3 text-center"><Spinner size={28} /><p className="font-body font-bold text-[14px] text-inkSoft">Checking host access…</p></div></div>;
}

function NotFound({ listingId: _listingId }: { listingId: string }) {
  return <div className="flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 py-10"><div className="flex w-full max-w-md flex-col items-center gap-5 text-center"><span className="font-mono text-[13px] font-bold uppercase tracking-[0.1em] text-coral">Host access unavailable</span><h1 className="font-display text-[27px] font-semibold text-ink">Event not found.</h1><p className="font-body text-[15px] font-bold leading-relaxed text-inkSoft">We could not find a live event for this listing. It may have been removed or the link is wrong.</p><a href="/dashboard" className="no-underline"><Button variant="lime" label="Dashboard" /></a></div></div>;
}

function NotCreator({ listingId }: { listingId: string }) {
  return <div className="flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 py-10"><div className="flex w-full max-w-md flex-col items-center gap-5 text-center"><span className="font-mono text-[13px] font-bold uppercase tracking-[0.1em] text-coral">Host access unavailable</span><h1 className="font-display text-[27px] font-semibold text-ink">Not your event.</h1><p className="font-body text-[15px] font-bold leading-relaxed text-inkSoft">This backstage room belongs to a different creator account. Sign in as the creator who scheduled it.</p><div className="flex gap-3"><a href={`/live/${encodeURIComponent(listingId)}`} className="no-underline"><Button variant="ghost" label="View event" /></a><a href="/dashboard" className="no-underline"><Button variant="lime" label="Dashboard" /></a></div></div></div>;
}

function RejoinLive({ title, deadlineMs, onRejoin }: { title: string; deadlineMs?: number; onRejoin: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const remainingS = typeof deadlineMs === 'number' ? Math.max(0, Math.round((deadlineMs - now) / 1000)) : null;
  const mmss = remainingS != null ? `${String(Math.floor(remainingS / 60)).padStart(2, '0')}:${String(remainingS % 60).padStart(2, '0')}` : null;
  return (
    <div className="flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <span className="rounded-zine-badge border-zine border-coral bg-coral px-3 py-1.5 font-mono text-[12px] font-bold uppercase text-white">Reconnecting</span>
        <h1 className="font-display text-[27px] font-semibold text-ink">{title} is waiting for you.</h1>
        <p className="font-body text-[15px] font-bold leading-relaxed text-inkSoft">
          Your stream dropped. Ticket holders are still in their seats{mmss ? ` — you have ${mmss} to rejoin before the event ends for everyone` : ''}.
        </p>
        <Button variant="lime" label="Rejoin your live" onClick={onRejoin} />
      </div>
    </div>
  );
}

function Ended({ title, listingId }: { title: string; listingId: string }) {
  return <div className="flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 py-10"><div className="flex w-full max-w-md flex-col items-center gap-5 text-center"><span className="font-mono text-[13px] font-bold uppercase tracking-[0.1em] text-blueInk">Broadcast complete</span><h1 className="font-display text-[28px] font-semibold text-ink">{title} has ended.</h1><p className="font-body text-[15px] font-bold leading-relaxed text-inkSoft">The server confirmed the event is over. Your ticket holders can find their receipt from their account.</p><div className="flex gap-3"><a href={`/live/${encodeURIComponent(listingId)}`} className="no-underline"><Button variant="ghost" label="View event" /></a><a href="/dashboard" className="no-underline"><Button variant="lime" label="Dashboard" /></a></div></div></div>;
}

function Refused({ listingId, detail, retry }: { listingId: string; detail: string; retry: () => void }) {
  return <div className="flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 py-10"><div className="flex w-full max-w-md flex-col items-center gap-5 text-center"><span className="font-mono text-[13px] font-bold uppercase tracking-[0.1em] text-coral">Host access unavailable</span><h1 className="font-display text-[27px] font-semibold text-ink">We could not open backstage.</h1><p className="font-body text-[15px] font-bold leading-relaxed text-inkSoft">{detail}</p><div className="flex gap-3"><Button variant="lime" label="Try again" onClick={retry} /><a href={`/live/${encodeURIComponent(listingId)}`} className="no-underline"><Button variant="ghost" label="View event" /></a></div></div></div>;
}

function LiveGsHostInner({ listingId, title = 'Live event' }: LiveGsHostProps) {
  const [phase, setPhase] = useState<Phase>('authorizing');
  const [error, setError] = useState<string | null>(null);
  const [serverState, setServerState] = useState<HostServerState | null>(null);
  const [creds, setCreds] = useState<CommercialHostCredentials | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [streamClient, setStreamClient] = useState<unknown>(null);
  const [jwt, setJwt] = useState<string | null>(null);
  const previewRef = useRef<MediaStream | null>(null);
  const callRef = useRef<Call | null>(null);
  const jwtRef = useRef<string | null>(null);
  const goLiveKeyRef = useRef<string>(newHostIdempotencyKey('go-live'));
  const endKeyRef = useRef<string>(newHostIdempotencyKey('end'));
  const pollRef = useRef<number | null>(null);
  const finishingRef = useRef(false);
  const mountedRef = useRef(true);
  const operationGenerationRef = useRef(0);

  const refreshJwt = useCallback(async (openGate: boolean): Promise<string | null> => {
    if (!mountedRef.current) return null;
    try {
      const fresh = await getActiveToken({ skipCache: true });
      if (fresh) {
        if (jwtRef.current !== fresh) {
          jwtRef.current = fresh;
          setJwt((current) => current ?? fresh);
        }
        return fresh;
      }
    } catch {
      /* Fall through to the interactive gate when this is an explicit action. */
    }
    if (!openGate || !mountedRef.current) return null;
    try {
      const token = await requireGuestAuth();
      if (!mountedRef.current) return null;
      jwtRef.current = token;
      setJwt(token);
      return token;
    } catch {
      return null;
    }
  }, []);

  const teardown = useCallback(() => {
    stopTracks(previewRef.current);
    previewRef.current = null;
    const current = callRef.current;
    callRef.current = null;
    if (mountedRef.current) setCall(null);
    if (mountedRef.current) setStreamClient(null);
    if (current) {
      void current.camera.disable().catch(() => {});
      void current.microphone.disable().catch(() => {});
      void current.leave().catch(() => {});
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      teardown();
    };
  }, [teardown]);

  const finish = useCallback(() => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    teardown();
    setPhase('ended');
  }, [teardown]);

  const syncState = useCallback(async () => {
    const token = await refreshJwt(false);
    if (!token) return;
    try {
      const next = (await commercialLiveHostState(listingId, token)) as HostServerState;
      setServerState(next);
      if (next.state === 'ended' || next.state === 'cancelled') finish();
      else if (next.state === 'live' && phase !== 'ending') setPhase('live');
      else if (next.state === 'ending') setPhase('ending');
      else if (next.state === 'backstage' && phase !== 'starting') setPhase('backstage');
    } catch (e) {
      // A transient state poll failure should leave the media room intact.
      setError('Live status is temporarily unavailable. We will keep checking.');
      try { captureException(e, { code: 'commercial_host_state_failed', listing_id: listingId }); } catch { /* best-effort */ }
    }
  }, [finish, listingId, phase, refreshJwt]);

  useEffect(() => {
    if (!jwt || !call) return;
    void syncState();
    pollRef.current = window.setInterval(() => void syncState(), 3000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [call, jwt, syncState]);

  // [LIVE-GRACE-WEB-1] Authorise BEFORE ever requesting the camera/mic.
  // Confirms the listing exists and the signed-in user is its creator via the
  // existing `/state` endpoint (a read — no media credentials minted yet).
  // `reconnecting` (server contract, WP8) routes to a distinct "Rejoin your
  // live" screen instead of the normal preview, since the host already has a
  // live event in flight and only needs to re-enter it.
  const authorize = useCallback(async () => {
    if (!mountedRef.current) return;
    setError(null);
    setPhase('authorizing');
    try {
      const token = await refreshJwt(true);
      if (!token) {
        setPhase('refused');
        setError('Sign-in is required to host this event.');
        return;
      }
      const next = (await commercialLiveHostState(listingId, token)) as HostServerState;
      if (!mountedRef.current) return;
      setServerState(next);
      if (next.state === 'ended' || next.state === 'cancelled') {
        setPhase('ended');
        return;
      }
      if (next.state === 'reconnecting') {
        setPhase('rejoin');
        try { capture('live_reconnecting_shown', { listing_id: listingId, surface: 'host' }); } catch { /* best-effort */ }
        return;
      }
      setPhase('preview');
    } catch (e) {
      if (!mountedRef.current) return;
      if (e instanceof ApiError && e.status === 404) {
        setPhase('not_found');
        try { capture('live_host_authz_refused', { listing_id: listingId, reason: 'not_found', status: e.status }); } catch { /* best-effort */ }
        return;
      }
      if (e instanceof ApiError && e.status === 403) {
        setPhase('not_creator');
        try { capture('live_host_authz_refused', { listing_id: listingId, reason: 'not_creator', status: e.status }); } catch { /* best-effort */ }
        return;
      }
      setPhase('refused');
      setError(safeError(e, 'Could not verify host access. Please try again.'));
      try { capture('live_host_authz_refused', { listing_id: listingId, reason: 'error', status: e instanceof ApiError ? e.status : 0 }); } catch { /* best-effort */ }
      try { captureException(e, { code: 'commercial_host_authz_failed', listing_id: listingId }); } catch { /* best-effort */ }
    }
  }, [listingId, refreshJwt]);

  useEffect(() => {
    void authorize();
    // Runs once on mount only — re-authorization after a rejoin/refusal is
    // triggered explicitly (RejoinLive/Refused retry), never automatically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prepare = useCallback(async (stream: MediaStream, prefs: JoinPrefs) => {
    const generation = ++operationGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === operationGenerationRef.current;
    previewRef.current = stream;
    setError(null);
    setPhase('preparing');
    try {
      const token = await requireGuestAuth();
      if (!isCurrent()) return stopTracks(stream);
      jwtRef.current = token;
      setJwt(token);
      const prepared = await prepareCommercialLiveHost(listingId, token);
      if (!isCurrent()) return stopTracks(stream);
      if (prepared.role !== 'host' || !prepared.call_type || !prepared.call_id) {
        throw new Error('The server did not return host media credentials.');
      }
      setCreds(prepared);
      const client = await streamClientFor(prepared, async () => {
        const freshToken = await refreshJwt(false);
        if (!freshToken || !isCurrent()) throw new Error('Host sign-in expired. Reopen backstage.');
        const fresh = await prepareCommercialLiveHost(listingId, freshToken);
        if (fresh.role !== 'host' || fresh.call_type !== prepared.call_type || fresh.call_id !== prepared.call_id) {
          throw new Error('Host session changed. Reopen backstage.');
        }
        return fresh;
      });
      if (!isCurrent()) return stopTracks(stream);
      setStreamClient(client);
      const videoClient = client as unknown as { call: (type: string, id: string, options?: { reuseInstance?: boolean }) => Call };
      const nextCall = videoClient.call(prepared.call_type, prepared.call_id, { reuseInstance: true });
      callRef.current = nextCall;
      if (prefs.micId) await nextCall.microphone.select(prefs.micId).catch(() => {});
      if (prefs.camId) await nextCall.camera.select(prefs.camId).catch(() => {});
      if (prefs.micOn) await nextCall.microphone.enable().catch(() => {});
      else await nextCall.microphone.disable().catch(() => {});
      if (prefs.camOn) await nextCall.camera.enable().catch(() => {});
      else await nextCall.camera.disable().catch(() => {});
      if (!isCurrent()) {
        await nextCall.leave().catch(() => {});
        return stopTracks(stream);
      }
      await nextCall.join();
      if (!isCurrent()) {
        await nextCall.leave().catch(() => {});
        return stopTracks(stream);
      }
      callRef.current = nextCall;
      setCall(nextCall);
      stopTracks(previewRef.current);
      previewRef.current = null;
      const current = await commercialLiveHostState(listingId, token);
      if (!isCurrent()) return;
      setServerState(current);
      if (current.state === 'ended' || current.state === 'cancelled') finish();
      else if (current.state === 'live') setPhase('live');
      else setPhase('backstage');
      try { capture('commercial_host_backstage', { listing_id: listingId, state: current.state }); } catch { /* best-effort */ }
    } catch (e) {
      teardown();
      stopTracks(previewRef.current);
      previewRef.current = null;
      setPhase('preview');
      setError(safeError(e, 'Could not open the private backstage room. Please try again.'));
      try { captureException(e, { code: 'commercial_host_prepare_failed', listing_id: listingId }); } catch { /* best-effort */ }
    }
  }, [finish, listingId, refreshJwt, teardown]);

  const start = useCallback(async () => {
    const token = await refreshJwt(true);
    if (!token || (serverState?.state !== 'backstage' && phase !== 'backstage')) return;
    setError(null);
    setPhase('starting');
    try {
      await goLiveCommercial(listingId, token, goLiveKeyRef.current);
      try { capture('commercial_host_go_live_requested', { listing_id: listingId }); } catch { /* best-effort */ }
    } catch (e) {
      setPhase('backstage');
      setError(safeError(e, 'The server could not start this broadcast.'));
      try { captureException(e, { code: 'commercial_host_go_live_failed', listing_id: listingId }); } catch { /* best-effort */ }
    }
  }, [listingId, phase, refreshJwt, serverState?.state]);

  const end = useCallback(async () => {
    const token = await refreshJwt(true);
    if (!token || phase === 'ending' || phase === 'ended') return;
    if (!window.confirm('End this live event? Ticket holders will no longer be able to join.')) return;
    setError(null);
    setPhase('ending');
    try {
      await endCommercialLive(listingId, token, endKeyRef.current);
    } catch (e) {
      setError(safeError(e, 'The server could not end this broadcast. Try again.'));
      setPhase(serverState?.state === 'live' ? 'live' : 'backstage');
      try { captureException(e, { code: 'commercial_host_end_failed', listing_id: listingId }); } catch { /* best-effort */ }
    }
  }, [listingId, phase, refreshJwt, serverState?.state]);

  const retry = useCallback(async () => {
    const current = callRef.current;
    if (!current) return;
    setError(null);
    try { await current.join(); } catch { setError('Still could not reconnect. Check your connection and try again.'); }
  }, []);

  if (phase === 'authorizing') return <Authorizing />;
  if (phase === 'not_found') return <NotFound listingId={listingId} />;
  if (phase === 'not_creator') return <NotCreator listingId={listingId} />;
  if (phase === 'rejoin') {
    return (
      <RejoinLive
        title={title}
        deadlineMs={serverState?.reconnect_deadline_ms}
        onRejoin={() => {
          try { capture('live_host_rejoin', { listing_id: listingId }); } catch { /* best-effort */ }
          setPhase('preview');
        }}
      />
    );
  }
  if (phase === 'ended') return <Ended title={title} listingId={listingId} />;
  if (phase === 'refused') return <Refused listingId={listingId} detail={error ?? 'Host access is unavailable.'} retry={() => void authorize()} />;
  if (call && creds && jwt && streamClient && ['backstage', 'starting', 'live', 'ending'].includes(phase)) {
    const stagePhase = phase as 'backstage' | 'starting' | 'live' | 'ending';
    return <StreamVideo client={streamClient as any}><StreamCall call={call}><HostStage title={title} phase={stagePhase} serverState={serverState?.state ?? 'backstage'} error={error} onStart={() => void start()} onEnd={() => void end()} onRetry={() => void retry()} /></StreamCall></StreamVideo>;
  }
  return <HostPreview key={error ? 'preview-error' : 'preview'} title={title} busy={phase === 'preparing'} error={error} onReady={(stream, prefs) => void prepare(stream, prefs)} />;
}

export function LiveGsHost(props: LiveGsHostProps) {
  return <IslandBoundary island="live-gs-host"><ClerkIsland><LiveGsHostInner {...props} /></ClerkIsland></IslandBoundary>;
}

export default LiveGsHost;
