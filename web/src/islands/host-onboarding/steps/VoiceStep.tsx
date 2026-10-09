/* [HF-VOICE-INTRO-1] The host records their OWN voice introduction (30 s minimum, about 1 min suggested, 5 min max).
 * No voice copying, no AI voice. An admin listens before it goes live on the card and profile. */
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import { VOICE_DONTS, VOICE_MAX_SEC, VOICE_MIN_SEC, VOICE_SCRIPTS, VOICE_SUGGEST_SEC, VOICE_TIPS } from '../data';
import type { StepProps, VoiceStatus } from '../types';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const canRecord = () => typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof (window as any).MediaRecorder !== 'undefined';

/** First recording format this browser supports. MP4 first: it plays on every phone and browser. */
const MIME_CHOICES = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm'];
export function pickMime(): string | undefined {
  try {
    const MR = (window as any).MediaRecorder;
    return MIME_CHOICES.find(m => MR?.isTypeSupported?.(m));
  } catch { return undefined; }
}

const STATUS_TEXT: Record<Exclude<VoiceStatus, null>, string> = {
  pending: 'Waiting for our team to listen',
  approved: 'Approved. It is live on your profile',
  rejected: 'Please record it again',
};

export default function VoiceStep({ draft, update, api, setAction }: StepProps) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [canMic] = useState(() => canRecord());
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [replacing, setReplacing] = useState(false);
  const [local, setLocal] = useState<{ url: string; sec: number; source: 'mic' | 'upload' } | null>(null);
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [lang, setLang] = useState<'hi' | 'en'>('hi');
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef(0);
  const blobRef = useRef<Blob | null>(null);
  const urlsRef = useRef<string[]>([]);

  const clearTimer = () => { if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; } };
  const stopTracks = () => { streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null; };
  const track = (u: string) => { urlsRef.current.push(u); return u; };

  useEffect(() => () => {
    clearTimer(); stopTracks();
    try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); } catch { /* ignore */ }
    urlsRef.current.forEach(u => URL.revokeObjectURL(u));
  }, []);

  // After a reload: the saved introduction (real mode) so the host can hear it again.
  useEffect(() => {
    if (!draft.voice.recorded || !api.fetchMyVoice) return;
    let live = true;
    void api.fetchMyVoice().then(u => { if (u && live) setSavedUrl(track(u)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keep = useCallback((blob: Blob, sec: number, source: 'mic' | 'upload') => {
    if (sec < VOICE_MIN_SEC - 0.5) { setError(`That is only ${Math.round(sec)} seconds. Please record at least ${VOICE_MIN_SEC} seconds.`); return; }
    if (sec > VOICE_MAX_SEC + 1) { setError(`That is longer than ${mmss(VOICE_MAX_SEC)}. Please keep it under 5 minutes.`); return; }
    blobRef.current = blob;
    setLocal({ url: track(URL.createObjectURL(blob)), sec: Math.round(sec), source });
    setError('');
  }, []);

  const finish = useCallback(() => {
    clearTimer();
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const start = async () => {
    setError('');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setDenied(true);
      setError('We could not use your microphone. Allow the microphone for this site in your browser or phone settings, then try again. Or upload a recording instead.');
      return;
    }
    try {
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = pickMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recRef.current = rec;
      rec.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const sec = (Date.now() - startRef.current) / 1000;
        stopTracks(); setRecording(false);
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || mime || 'audio/webm' });
        keep(blob, sec, 'mic');
      };
      startRef.current = Date.now();
      rec.start(1000);
      setElapsed(0); setRecording(true);
      timerRef.current = window.setInterval(() => {
        const s = (Date.now() - startRef.current) / 1000;
        setElapsed(s);
        if (s >= VOICE_MAX_SEC) finish();
      }, 250);
    } catch {
      stopTracks(); setRecording(false);
      setError('Recording does not work in this browser. Please upload a recording instead.');
    }
  };

  const discard = () => {
    blobRef.current = null; setLocal(null); setElapsed(0); setError(''); setProgress(0);
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
      const d = a.duration;
      URL.revokeObjectURL(u);
      if (!isFinite(d) || d <= 0) { setError('We could not read how long that file is. Please try another recording.'); return; }
      keep(f, d, 'upload');
    };
    a.onerror = () => { URL.revokeObjectURL(u); setError('We could not read that file. Please try another recording.'); };
    a.src = u;
  };

  const save = async () => {
    if (!local || !blobRef.current || !draft.voice.consent) return;
    setSaving(true); setError(''); setProgress(0);
    const r = await api.uploadVoice(blobRef.current, local.sec, draft.voice.consent, setProgress);
    setSaving(false);
    if (!r.ok) { setError(r.error || 'We could not save your recording. Please try again.'); return; }
    setSavedUrl(local.url);
    update({ voice: { recorded: true, durationSec: local.sec, consent: true, source: local.source, status: r.status ?? 'pending' } });
    blobRef.current = null; setLocal(null); setReplacing(false); setElapsed(0);
  };

  const hasSaved = draft.voice.recorded;
  const showRecorder = !hasSaved || replacing || recording || !!local;
  const unsaved = recording || !!local;
  const ready = hasSaved && draft.voice.consent && !unsaved;
  useEffect(() => {
    setAction({ label: 'Continue', disabled: !ready });
  }, [ready, setAction]);

  const scripts = VOICE_SCRIPTS.find(s => s.lang === lang)!;
  const tooShort = recording && elapsed < VOICE_MIN_SEC;

  return (
    <div>
      <h1 className="hob-h1">Record your introduction</h1>
      <p className="hob-lead">Say hello in your own voice. About a minute is perfect (at least {VOICE_MIN_SEC} seconds, at most 5 minutes). Callers can hear it on your card and your profile, labelled “Recorded by the host”.</p>

      <details className="hob-card hob-f-ideas">
        <summary>What can I say?</summary>
        <div className="hob-f-ideas-body">
          <div className="hob-f-tabs" role="group" aria-label="Example language">
            {VOICE_SCRIPTS.map(s => (
              <button key={s.lang} type="button" className="hob-chip" aria-pressed={lang === s.lang} onClick={() => setLang(s.lang)}>{s.label}</button>
            ))}
          </div>
          {scripts.items.map((t, i) => (
            <blockquote key={i} className="hob-f-script-text hob-f-example" lang={lang === 'hi' ? 'hi' : 'en'}>{t}</blockquote>
          ))}
          <h2 className="hob-f-h3">Tips</h2>
          <ul className="hob-f-tips">{VOICE_TIPS.map(t => <li key={t}>{t}</li>)}</ul>
          <p className="hob-f-donts"><strong>Please don't:</strong> {VOICE_DONTS.replace(/^Please do not /, '')}</p>
        </div>
      </details>

      {hasSaved && !showRecorder && (
        <div className="hob-card hob-f-rec">
          <div className="hob-f-rec-status" role="status">Saved. Our team will listen before it goes live.</div>
          {draft.voice.status && <span className={`hob-f-pill hob-f-vstatus hob-f-vstatus-${draft.voice.status}`}>{STATUS_TEXT[draft.voice.status]}</span>}
          <p className="hob-help">Length {mmss(draft.voice.durationSec)}</p>
          {savedUrl && <audio className="hob-f-audio" controls preload="metadata" src={savedUrl} aria-label="Your recorded introduction" />}
          <button type="button" className="hob-btn hob-btn-ghost" onClick={() => { setReplacing(true); setError(''); }}>Record again</button>
        </div>
      )}

      {showRecorder && (
        <div className="hob-card hob-f-rec">
          {!local && (
            <>
              <div role="status" aria-live="polite" className="hob-f-rec-status">
                {recording ? `Recording… ${mmss(elapsed)}` : canMic && !denied ? 'Tap the microphone to start' : 'Upload a recording of your voice'}
              </div>
              {canMic && !denied && (recording ? (
                <button type="button" className="hob-f-mic hob-f-mic-live" onClick={finish} disabled={tooShort} aria-label="Stop recording">
                  <Icon name="stop" />
                </button>
              ) : (
                <button type="button" className="hob-f-mic" onClick={start} aria-label="Start recording">
                  <Icon name="mic" />
                </button>
              ))}
              {recording && (
                <>
                  <div className="hob-f-meter" role="progressbar" aria-valuemin={0} aria-valuemax={VOICE_MAX_SEC} aria-valuenow={Math.round(elapsed)} aria-label="Recording length">
                    <span style={{ width: `${Math.min(100, (elapsed / VOICE_MAX_SEC) * 100)}%` }} />
                  </div>
                  <p className="hob-help">
                    {tooShort ? `Keep going — at least ${VOICE_MIN_SEC} seconds.` : elapsed < VOICE_SUGGEST_SEC ? 'Nice. You can stop any time now, or keep talking.' : 'You can stop now.'} It stops by itself at {mmss(VOICE_MAX_SEC)}.
                  </p>
                </>
              )}
              {!recording && (
                <label className={`hob-btn ${canMic && !denied ? 'hob-btn-ghost' : 'hob-btn-primary'} hob-f-upload-btn`}>
                  <Icon name="upload" /> Upload a file instead
                  <input type="file" accept="audio/*" onChange={onFile} className="hob-f-file" aria-label="Upload an audio file" />
                </label>
              )}
              {hasSaved && !recording && (
                <button type="button" className="hob-f-link" onClick={() => { setReplacing(false); setError(''); }}>Keep my saved introduction</button>
              )}
            </>
          )}

          {local && (
            <>
              <div className="hob-f-rec-status" role="status">Listen to it first ({mmss(local.sec)})</div>
              <audio className="hob-f-audio" controls preload="metadata" src={local.url} aria-label="Your new recording" />
              {saving && (
                <div className="hob-f-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Uploading">
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              <div className="hob-f-rec-actions">
                <button type="button" className="hob-btn hob-btn-primary" onClick={() => { void save(); }} disabled={saving || !draft.voice.consent}>
                  {saving ? 'Uploading…' : 'Save my introduction'}
                </button>
                <button type="button" className="hob-btn hob-btn-ghost" onClick={discard} disabled={saving}>Record again</button>
              </div>
              {!draft.voice.consent && <p className="hob-help">Tick the box below to save it.</p>}
            </>
          )}

          <div aria-live="assertive">{error && <p className="hob-error">{error}</p>}</div>
        </div>
      )}
      {!showRecorder && error && <p className="hob-error" role="alert">{error}</p>}

      <label className="hob-card hob-f-consent">
        <input type="checkbox" checked={draft.voice.consent}
          onChange={e => update({ voice: { ...draft.voice, consent: e.target.checked } })} />
        <span>This is my own voice. I agree it will be played on my public profile.</span>
      </label>
    </div>
  );
}
