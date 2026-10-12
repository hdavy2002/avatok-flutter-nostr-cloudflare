import { useEffect, useRef, useState } from 'react';

/** The host records their own introduction. Capture is local until the explicit upload action. */
export default function CreatorVoiceRecorder({ disabled, onClip, onError }: {
  disabled: boolean;
  onClip: (file: File, seconds: number) => void;
  onError: (message: string) => void;
}) {
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  const blocked = useRef(disabled);
  blocked.current = disabled;
  const [recording, setRecording] = useState(false), [starting, setStarting] = useState(false), [seconds, setSeconds] = useState(0);
  const release = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
  };
  const cancel = () => {
    if (recorder.current) {
      recorder.current.onstop = null;
      if (recorder.current.state !== 'inactive') recorder.current.stop();
    }
    recorder.current = null; release(); setRecording(false); setStarting(false); setSeconds(0);
  };
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recorder.current) {
        recorder.current.onstop = null;
        if (recorder.current.state !== 'inactive') recorder.current.stop();
      }
      release();
    };
  }, []);
  const start = async () => {
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Recording is unavailable in this browser. Upload an MP3 instead.');
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error('This browser has no supported recorder. Upload an MP3 instead.');
      const input = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || blocked.current) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      const capture = new MediaRecorder(input, { mimeType: mime, audioBitsPerSecond: 64000 });
      recorder.current = capture;
      const chunks: Blob[] = [];
      const startedAt = performance.now();
      capture.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      capture.onerror = () => { cancel(); onError('Recording failed. Please try again or upload an MP3.'); };
      capture.onstop = () => {
        const duration = (performance.now() - startedAt) / 1000;
        release(); recorder.current = null;
        if (!mounted.current) return;
        setRecording(false);
        const blob = new Blob(chunks, { type: mime });
        if (duration < 20 || Math.round(duration) > 300 || blob.size < 20 * 1024 || blob.size > 15 * 1024 * 1024) { onError('Record at least 20 seconds, up to 5 minutes and 15 MB.'); return; }
        const ext = mime.startsWith('audio/mp4') ? 'm4a' : mime.startsWith('audio/ogg') ? 'ogg' : 'webm';
        onClip(new File([blob], `voice-introduction.${ext}`, { type: mime }), duration);
      };
      capture.start(1000); setSeconds(0); setRecording(true);
      timer.current = setInterval(() => {
        const elapsed = (performance.now() - startedAt) / 1000;
        setSeconds(Math.floor(elapsed));
        if (elapsed >= 300 && capture.state === 'recording') capture.stop();
      }, 200);
    } catch (error) {
      release();
      if (mounted.current) onError(error instanceof Error ? error.message : 'Microphone permission is needed to record.');
    } finally { if (mounted.current) setStarting(false); }
  };
  return <div style={{ margin: '12px 0', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
    {!recording ? <button className="btn small" disabled={disabled || starting} onClick={() => void start()}>{starting ? 'Opening microphone…' : 'Record voice clip'}</button>
      : <><span role="timer" aria-live="off">Recording · {seconds}s / 300s</span><button className="btn small" disabled={seconds < 20} onClick={() => recorder.current?.stop()}>Stop recording</button><button className="btn small ghost" onClick={cancel}>Cancel recording</button></>}
  </div>;
}
