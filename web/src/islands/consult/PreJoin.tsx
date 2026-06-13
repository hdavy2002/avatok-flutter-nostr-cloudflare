/*
 * PreJoin — the green-room. Requests camera+mic up front (pre-warms the
 * permission prompt so joining is instant), shows a local self-preview and
 * device pickers, then hands the chosen MediaStream up via `onReady`. The parent
 * (ConsultRoom) runs the auth gate + /join with that stream. No network here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '../../components';

export interface PreJoinProps {
  title?: string;
  peerName?: string;
  joining?: boolean;
  /** Surfaced join/gate error from the parent. */
  error?: string | null;
  /** Called with the ready local stream + initial mic/cam state. */
  onReady: (stream: MediaStream, micOn: boolean, camOn: boolean) => void;
}

interface Dev {
  deviceId: string;
  label: string;
}

export function PreJoin({ title, peerName, joining = false, error, onReady }: PreJoinProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [perm, setPerm] = useState<'idle' | 'asking' | 'granted' | 'denied'>('idle');
  const [permErr, setPermErr] = useState<string | null>(null);
  const [mics, setMics] = useState<Dev[]>([]);
  const [cams, setCams] = useState<Dev[]>([]);
  const [micId, setMicId] = useState<string>('');
  const [camId, setCamId] = useState<string>('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  const attach = (stream: MediaStream) => {
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => {});
    }
  };

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const toDev = (d: MediaDeviceInfo, fallback: string): Dev => ({
        deviceId: d.deviceId,
        label: d.label || fallback,
      });
      setMics(list.filter((d) => d.kind === 'audioinput').map((d, i) => toDev(d, `Microphone ${i + 1}`)));
      setCams(list.filter((d) => d.kind === 'videoinput').map((d, i) => toDev(d, `Camera ${i + 1}`)));
    } catch {
      /* ignore */
    }
  }, []);

  const acquire = useCallback(
    async (constraints?: MediaStreamConstraints) => {
      setPerm('asking');
      setPermErr(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia(
          constraints ?? {
            audio: micId ? { deviceId: { exact: micId } } : true,
            video: camId ? { deviceId: { exact: camId } } : { facingMode: 'user' },
          },
        );
        // Stop a prior stream before swapping (device change).
        streamRef.current?.getTracks().forEach((t) => t.stop());
        attach(stream);
        stream.getAudioTracks().forEach((t) => (t.enabled = micOn));
        stream.getVideoTracks().forEach((t) => (t.enabled = camOn));
        setPerm('granted');
        await refreshDevices();
      } catch (e) {
        setPerm('denied');
        const name = (e as DOMException)?.name;
        setPermErr(
          name === 'NotAllowedError'
            ? 'Camera & mic permission was blocked. Allow access in your browser, then retry.'
            : name === 'NotFoundError'
              ? 'No camera or microphone found.'
              : 'Could not start your camera & mic.',
        );
      }
    },
    [micId, camId, micOn, camOn, refreshDevices],
  );

  // Pre-warm on mount.
  useEffect(() => {
    void acquire();
    return () => {
      // Only stop here if the parent never took ownership of the stream.
      if (perm !== 'granted') streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-acquire when a device is picked.
  useEffect(() => {
    if (perm === 'granted') void acquire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micId, camId]);

  const toggleMic = () => {
    const next = !micOn;
    setMicOn(next);
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
  };
  const toggleCam = () => {
    const next = !camOn;
    setCamOn(next);
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
  };

  const join = () => {
    const stream = streamRef.current;
    if (!stream) return;
    onReady(stream, micOn, camOn);
  };

  const selectClass =
    'rounded-zine-field border-zine border-ink bg-card px-3 py-2 font-body font-bold text-[14px] text-ink ' +
    'focus:outline-none focus:shadow-zine-focus';

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <div>
        <span className="font-mono font-bold uppercase text-[12px] tracking-[0.1em] text-blueInk">Get ready</span>
        <h1 className="mt-2 font-display font-semibold text-[26px] leading-tight text-ink">
          {title ?? 'Your 1:1 session'}
        </h1>
        {peerName && (
          <p className="mt-1 font-body font-bold text-[15px] text-inkSoft">
            with <span className="text-ink">{peerName}</span>
          </p>
        )}
      </div>

      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-zine border-zine border-ink bg-ink shadow-zine">
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
        {perm !== 'granted' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-paper2 text-center">
            {perm === 'asking' ? (
              <>
                <Spinner size={26} />
                <p className="font-body font-bold text-[14px] text-inkSoft">Starting camera & mic…</p>
              </>
            ) : (
              <>
                <p className="px-6 font-body font-bold text-[14px] text-inkSoft">
                  {permErr ?? 'Allow camera & microphone to join.'}
                </p>
                <Button variant="blue" label="Allow & retry" onClick={() => void acquire()} />
              </>
            )}
          </div>
        )}
        {perm === 'granted' && !camOn && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/80 font-display font-semibold text-[16px] text-paper">
            Camera off
          </div>
        )}
      </div>

      {/* device pickers + quick toggles */}
      <div className="flex flex-col gap-2.5">
        <div className="flex gap-2">
          <select
            aria-label="Microphone"
            className={`${selectClass} min-w-0 flex-1`}
            value={micId}
            onChange={(e) => setMicId(e.target.value)}
            disabled={perm !== 'granted'}
          >
            {mics.length === 0 && <option value="">Default microphone</option>}
            {mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                🎙️ {d.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={toggleMic}
            aria-pressed={!micOn}
            className={[
              'shrink-0 rounded-zine-field border-zine border-ink px-3 py-2 font-display font-semibold text-[14px]',
              micOn ? 'bg-card text-ink' : 'bg-coral text-white',
            ].join(' ')}
          >
            {micOn ? 'On' : 'Off'}
          </button>
        </div>

        <div className="flex gap-2">
          <select
            aria-label="Camera"
            className={`${selectClass} min-w-0 flex-1`}
            value={camId}
            onChange={(e) => setCamId(e.target.value)}
            disabled={perm !== 'granted'}
          >
            {cams.length === 0 && <option value="">Default camera</option>}
            {cams.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                📷 {d.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={toggleCam}
            aria-pressed={!camOn}
            className={[
              'shrink-0 rounded-zine-field border-zine border-ink px-3 py-2 font-display font-semibold text-[14px]',
              camOn ? 'bg-card text-ink' : 'bg-coral text-white',
            ].join(' ')}
          >
            {camOn ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-zine border-zine border-coral bg-card p-3 font-body font-bold text-[14px] text-ink shadow-zine-error">
          {error}
        </div>
      )}

      <Button
        variant="lime"
        fullWidth
        loading={joining}
        disabled={perm !== 'granted' || joining}
        label={joining ? 'Joining…' : 'Join session'}
        onClick={join}
      />
      <p className="text-center font-body font-bold text-[12px] text-inkMute">
        You can mute or turn off your camera any time once you're in.
      </p>
    </div>
  );
}

export default PreJoin;
