import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import { BRAND } from '../../../lib/brand';
import { VOICE_MAX_SEC, VOICE_MIN_SEC, VOICE_SCRIPT } from '../data';
import type { StepProps } from '../types';

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const canRecord = () => typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof (window as any).MediaRecorder !== 'undefined';

export default function VoiceStep({ draft, update, api, setAction }: StepProps) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [micOk, setMicOk] = useState(() => canRecord());
  const [fallback, setFallback] = useState(() => !canRecord());
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const urlRef = useRef<string | null>(null);

  const clearTimer = () => { if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; } };
  const stopTracks = () => { streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null; };

  useEffect(() => () => {
    clearTimer(); stopTracks();
    try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); } catch { /* ignore */ }
    audioRef.current?.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  const accept = useCallback(async (blob: Blob, sec: number, source: 'mic' | 'upload') => {
    if (sec < VOICE_MIN_SEC) { setError(`Please record at least ${VOICE_MIN_SEC} seconds`); return; }
    setBusy(true);
    try {
      await api.uploadVoice(blob, Math.round(sec));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const u = URL.createObjectURL(blob);
      urlRef.current = u; blobRef.current = blob; setUrl(u); setPlaying(false);
      setError('');
      update({ voice: { recorded: true, durationSec: Math.round(sec), consent: draft.voice.consent, source } });
    } catch {
      setError('We could not save your recording. Please try again.');
    } finally { setBusy(false); }
  }, [api, update, draft.voice.consent]);

  const finish = useCallback(() => {
    clearTimer();
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const start = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream);
      recRef.current = rec;
      rec.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const sec = (Date.now() - startRef.current) / 1000;
        stopTracks(); setRecording(false);
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        void accept(blob, sec, 'mic');
      };
      startRef.current = Date.now();
      rec.start();
      setElapsed(0); setRecording(true);
      timerRef.current = window.setInterval(() => {
        const s = (Date.now() - startRef.current) / 1000;
        setElapsed(s);
        if (s >= VOICE_MAX_SEC) finish();
      }, 250);
    } catch {
      stopTracks(); setRecording(false);
      setFallback(true); setMicOk(false);
      setError('We could not use your microphone. You can allow it in your settings, or upload a recording instead.');
    }
  };

  const reset = () => {
    audioRef.current?.pause(); setPlaying(false);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null; blobRef.current = null; setUrl(null); setElapsed(0); setError('');
    update({ voice: { recorded: false, durationSec: 0, consent: draft.voice.consent, source: null } });
  };

  const togglePlay = () => {
    if (!url) return;
    if (!audioRef.current) {
      const a = new Audio(url);
      a.onended = () => setPlaying(false);
      audioRef.current = a;
    }
    const a = audioRef.current;
    if (a.paused) { void a.play(); setPlaying(true); } else { a.pause(); setPlaying(false); }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError('');
    const u = URL.createObjectURL(f);
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      let d = a.duration;
      URL.revokeObjectURL(u);
      if (!isFinite(d)) d = 0;
      if (d > VOICE_MAX_SEC + 5) { setError(`Please keep it under ${VOICE_MAX_SEC} seconds`); return; }
      void accept(f, d, 'upload');
    };
    a.onerror = () => { URL.revokeObjectURL(u); setError('We could not read that file. Please try another recording.'); };
    a.src = u;
  };

  const recorded = draft.voice.recorded && !!url;
  const ready = draft.voice.recorded && draft.voice.consent;
  useEffect(() => {
    setAction({
      label: 'Continue',
      disabled: !ready,
      run: async () => {
        if (!api.commitVoice) return true;
        const r = await api.commitVoice(draft.voice.consent);
        if (!r.ok) { setError(r.error || 'We could not save your recording. Please try again.'); return false; }
        return true;
      },
    });
  }, [ready, setAction, api, draft.voice.consent]);

  return (
    <div>
      <h1 className="hob-h1">Record your voice</h1>
      <p className="hob-lead">We use your voice to make a short sample conversation for your profile, so callers hear the same voice they'll talk to.</p>

      <div className="hob-card hob-f-script">
        <p className="hob-f-script-label">Read this aloud, slowly</p>
        <p className="hob-f-script-text">{VOICE_SCRIPT}</p>
      </div>

      <div className="hob-card hob-f-rec">
        <div role="status" aria-live="polite" className="hob-f-rec-status">
          {recording ? `Recording… ${mmss(elapsed)}` : recorded ? `Recorded ${mmss(draft.voice.durationSec)}` : busy ? 'Saving…' : 'Tap the microphone to start'}
        </div>
        {!recorded && micOk ? (
          recording ? (
            <button type="button" className="hob-f-mic hob-f-mic-live" onClick={finish} aria-label="Stop recording">
              <Icon name="stop" />
            </button>
          ) : (
            <button type="button" className="hob-f-mic" onClick={start} disabled={busy} aria-label="Start recording">
              <Icon name="mic" />
            </button>
          )
        ) : null}
        {recording && <p className="hob-help">It stops by itself at {mmss(VOICE_MAX_SEC)}.</p>}

        {recorded && (
          <div className="hob-f-rec-actions">
            <button type="button" className="hob-btn hob-btn-primary" onClick={togglePlay}>
              <Icon name={playing ? 'pause' : 'play'} /> {playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" className="hob-btn hob-btn-ghost" onClick={reset}>Record again</button>
          </div>
        )}

        {fallback && !recorded && !recording && (
          <div className="hob-f-upload">
            <label className="hob-btn hob-btn-ghost hob-f-upload-btn">
              <Icon name="upload" /> Upload a recording instead
              <input type="file" accept="audio/*" capture="user" onChange={onFile} className="hob-f-file" />
            </label>
          </div>
        )}
        {!fallback && micOk && !recorded && !recording && (
          <button type="button" className="hob-f-link" onClick={() => setFallback(true)}>Upload a recording instead</button>
        )}

        <div aria-live="assertive">{error && <p className="hob-error">{error}</p>}</div>
      </div>

      <label className="hob-card hob-f-consent">
        <input type="checkbox" checked={draft.voice.consent}
          onChange={e => update({ voice: { ...draft.voice, consent: e.target.checked } })} />
        <span>I agree that {BRAND.name} may create an AI copy of my voice, only to make my profile's sample clip. The copy is deleted after the clip is made.</span>
      </label>
    </div>
  );
}
