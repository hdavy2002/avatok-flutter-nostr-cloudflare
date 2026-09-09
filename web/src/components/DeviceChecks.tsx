import { useCallback, useEffect, useRef, useState } from 'react';
import { capture } from '../lib/analytics';
import { rmsLevel, SpeakerTone, type SpeakerState } from './audioDeviceChecks';

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
}

export function AudioMeter({ stream, disabled = false }: { stream: MediaStream | null; disabled?: boolean }) {
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState<'idle' | 'checking' | 'active' | 'unavailable'>('idle');
  const cleanupRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const start = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    const track = stream?.getAudioTracks()[0];
    const Ctor = getAudioContextCtor();
    if (!track || disabled) { setLevel(0); setStatus('idle'); return; }
    if (!Ctor) { setStatus('unavailable'); return; }
    const generation = ++generationRef.current;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      context = new Ctor();
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source = context.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
    } catch {
      source?.disconnect(); analyser?.disconnect(); void context?.close().catch(() => {});
      setStatus('unavailable'); return;
    }
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let active = true;
    const cleanup = () => {
      active = false; window.cancelAnimationFrame(frame);
      source?.disconnect(); analyser?.disconnect(); void context?.close().catch(() => {});
    };
    cleanupRef.current = cleanup;
    setStatus('checking');
    const tick = () => {
      if (!active || generation !== generationRef.current) return;
      analyser?.getByteTimeDomainData(samples);
      if (mountedRef.current) { setLevel(rmsLevel(samples)); setStatus('active'); }
      frame = window.requestAnimationFrame(tick);
    };
    const resumed = context.resume();
    void resumed.then(() => {
      if (!active || generation !== generationRef.current) return;
      if (context?.state === 'running') tick();
      else if (mountedRef.current) setStatus('unavailable');
    }).catch(() => { if (active && mountedRef.current) setStatus('unavailable'); });
  }, [disabled, stream]);

  useEffect(() => {
    mountedRef.current = true;
    start();
    return () => { mountedRef.current = false; generationRef.current += 1; cleanupRef.current?.(); cleanupRef.current = null; };
  }, [start]);

  const message = disabled ? 'Microphone is muted.' : !stream?.getAudioTracks().length ? 'Allow microphone access to check sound.' : status === 'unavailable'
    ? 'Microphone check is unavailable. Retry to allow audio playback.'
    : status === 'active' && level > 0.04 ? 'Microphone input detected.' : 'No microphone input detected yet.';
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label={message}>
      <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkMute">Mic level</span>
      <span className="flex h-3 min-w-[100px] flex-1 gap-0.5" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level} aria-valuetext={message} aria-label="Microphone input level">
        {Array.from({ length: 12 }, (_, index) => <span key={index} className={`h-3 min-w-[3px] flex-1 rounded-sm ${index / 12 < level ? 'bg-lime' : 'bg-ink/15'}`} />)}
      </span>
      {status === 'unavailable' && <button type="button" onClick={start} className="rounded-zine-field border-zine border-ink bg-card px-2 py-1 font-display text-[12px] font-semibold text-ink">Retry mic check</button>}
      <span className="sr-only">{message}</span>
    </div>
  );
}

export function SpeakerTest() {
  const tone = useRef<SpeakerTone | null>(null);
  const [state, setState] = useState<SpeakerState>({ playing: false, tested: false, error: null });
  useEffect(() => {
    const controller = new SpeakerTone(() => {
      const Constructor = getAudioContextCtor();
      if (!Constructor) throw new Error('unsupported');
      return new Constructor();
    }, setState, (result) => capture('commercial_speaker_test', { result }));
    tone.current = controller;
    return () => { tone.current = null; controller.dispose(); };
  }, []);
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" onClick={() => state.playing ? tone.current?.stop() : tone.current?.start()}
        className="rounded-zine-field border-zine border-ink bg-card px-3 py-2 font-display text-[13px] font-semibold text-ink">
        {state.playing ? 'Stop test' : 'Test speaker'}
      </button>
      {state.error && <span role="status" className="font-body text-[12px] font-bold text-coral">{state.error}</span>}
      {(state.playing || state.tested) && <span className="font-body text-[12px] text-inkMute">Did you hear the sound? Check your volume and connected headphones.</span>}
    </div>
  );
}

export function DeviceChecks({ stream, micOn = true }: { stream: MediaStream | null; micOn?: boolean }) {
  return <div className="flex flex-wrap items-center gap-3 rounded-zine border-zine border-ink bg-paper2 px-3 py-2"><AudioMeter stream={stream} disabled={!micOn} /><SpeakerTest /></div>;
}
