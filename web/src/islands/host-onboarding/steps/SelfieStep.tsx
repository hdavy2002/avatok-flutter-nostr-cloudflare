import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import { SELFIE_SEC } from '../data';
import type { StepProps } from '../types';

const canRecord = () => typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof (window as any).MediaRecorder !== 'undefined';
type Phase = 'idle' | 'count' | 'rec';

export default function SelfieStep({ draft, update, api, setAction }: StepProps) {
  const [code, setCode] = useState(draft.selfie.code || '');
  const [codeErr, setCodeErr] = useState('');
  const fetchCode = useCallback(() => {
    setCodeErr('');
    void api.getSelfieCode().then(r => { if (r.ok && r.code) setCode(r.code); else setCodeErr(r.error || 'We could not get your code. Please try again.'); });
  }, [api]);
  useEffect(() => { if (!code) fetchCode(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [fallback, setFallback] = useState(() => !canRecord());
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const liveRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const urlRef = useRef<string | null>(null);
  const aliveRef = useRef(true);

  const clearTimer = () => { if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; } };
  const stopTracks = () => { streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null; };

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimer(); stopTracks();
      try { if (recRef.current && recRef.current.state !== 'inactive') { recRef.current.onstop = null; recRef.current.stop(); } } catch { /* ignore */ }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const accept = useCallback(async (blob: Blob) => {
    setBusy(true); setError('');
    try {
      const r = await api.uploadSelfie(blob, code);
      if (!aliveRef.current) return;
      if (!r.ok) {
        setError(r.error || 'We could not save your video. Please try again.');
        if (r.codeExpired) { setCode(''); fetchCode(); }
        return;
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const u = URL.createObjectURL(blob);
      urlRef.current = u; setUrl(u);
      update({ selfie: { recorded: true, consent: draft.selfie.consent, code } });
    } catch {
      if (aliveRef.current) setError('We could not save your video. Please try again.');
    } finally { if (aliveRef.current) setBusy(false); }
  }, [api, code, update, draft.selfie.consent, fetchCode]);

  const finish = useCallback(() => {
    clearTimer();
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const beginRecording = (stream: MediaStream) => {
    chunksRef.current = [];
    const rec = new MediaRecorder(stream);
    recRef.current = rec;
    rec.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      stopTracks();
      if (!aliveRef.current) return;
      setPhase('idle');
      void accept(new Blob(chunksRef.current, { type: rec.mimeType || 'video/webm' }));
    };
    const t0 = Date.now();
    rec.start();
    setElapsed(0); setPhase('rec');
    timerRef.current = window.setInterval(() => {
      const s = (Date.now() - t0) / 1000;
      setElapsed(Math.min(s, SELFIE_SEC));
      if (s >= SELFIE_SEC) finish();
    }, 200);
  };

  const start = async () => {
    setError('');
    if (!code) { setError('Wait for your code to show, then start.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      streamRef.current = stream;
      setPhase('count'); setCount(3);
      let n = 3;
      timerRef.current = window.setInterval(() => {
        n -= 1;
        if (n > 0) { setCount(n); return; }
        clearTimer();
        if (streamRef.current) beginRecording(streamRef.current);
      }, 1000);
    } catch {
      stopTracks(); setPhase('idle'); setFallback(true);
      setError('We could not use your camera. Allow it in your settings, or record with your phone camera instead.');
    }
  };

  // attach the live stream once the preview element exists
  useEffect(() => {
    if (phase !== 'idle' && liveRef.current && streamRef.current) {
      liveRef.current.srcObject = streamRef.current;
      void liveRef.current.play().catch(() => {});
    }
  }, [phase]);

  const retake = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null; setUrl(null); setError('');
    update({ selfie: { recorded: false, consent: draft.selfie.consent, code } });
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) void accept(f);
  };

  const recorded = draft.selfie.recorded;
  const ready = recorded && draft.selfie.consent;
  useEffect(() => { setAction({ label: 'Continue', disabled: !ready || busy, run: () => true }); }, [ready, busy, setAction]);

  const spaced = code.split('').join(' ');
  const live = phase !== 'idle';

  return (
    <div>
      <h1 className="hob-h1">10-second selfie video</h1>
      <p className="hob-lead">This shows us you are a real person.</p>

      <div className="hob-card hob-v-codecard">
        <p className="hob-v-codelabel">Your code</p>
        <p className="hob-v-bigcode" aria-label={code ? `Your code is ${spaced}` : 'Getting your code'}>{code || '····'}</p>
        {codeErr ? <p className="hob-error" role="alert">{codeErr} <button type="button" className="hob-v-link" onClick={fetchCode}>Try again</button></p>
          : <p className="hob-v-say">Look at the camera and say: <strong>Mera code {spaced} hai</strong></p>}
      </div>

      <div className="hob-card hob-v-cam">
        {live && (
          <div className="hob-v-stage">
            <video ref={liveRef} className="hob-v-video hob-v-mirror" muted playsInline aria-label="Your camera" />
            {phase === 'count' && <div className="hob-v-count" role="status" aria-live="assertive">{count}</div>}
            {phase === 'rec' && <div className="hob-v-recbar" role="status"><span className="hob-v-dot" aria-hidden="true" />Recording {Math.ceil(SELFIE_SEC - elapsed)}s left</div>}
          </div>
        )}
        {!live && recorded && url && (
          <div className="hob-v-stage">
            <video className="hob-v-video" src={url} controls playsInline aria-label="Replay your selfie video" />
          </div>
        )}
        {!live && recorded && !url && <p className="hob-v-strong">Selfie video saved ✓</p>}
        {!live && !recorded && (
          <div className="hob-v-camidle">
            <span className="hob-v-ico" aria-hidden="true"><Icon name="video" /></span>
            <p className="hob-help">{busy ? 'Saving…' : 'Hold the phone at eye level, in good light.'}</p>
          </div>
        )}

        <div className="hob-v-camactions">
          {!live && !recorded && !fallback && (
            <button type="button" className="hob-btn hob-btn-primary" onClick={start} disabled={busy || !code}><Icon name="video" size={20} />Start recording</button>
          )}
          {!live && !recorded && fallback && (
            <label className="hob-btn hob-btn-primary hob-v-filebtn" aria-disabled={!code}>
              <Icon name="video" size={20} />Record with phone camera
              <input type="file" accept="video/*" capture="user" onChange={onFile} className="hob-v-file" disabled={!code} />
            </label>
          )}
          {!live && !recorded && !fallback && (
            <button type="button" className="hob-v-link" onClick={() => setFallback(true)}>Use my phone camera app instead</button>
          )}
          {!live && recorded && <button type="button" className="hob-btn hob-btn-ghost" onClick={retake} disabled={busy}>Retake</button>}
        </div>
        <div aria-live="assertive">{error && <p className="hob-error">{error}</p>}</div>
      </div>

      <label className="hob-card hob-f-consent">
        <input type="checkbox" checked={draft.selfie.consent}
          onChange={e => update({ selfie: { ...draft.selfie, code, consent: e.target.checked } })} />
        <span>I agree to record a short selfie video to prove I am a real person. Only our verification team sees it.</span>
      </label>
    </div>
  );
}
