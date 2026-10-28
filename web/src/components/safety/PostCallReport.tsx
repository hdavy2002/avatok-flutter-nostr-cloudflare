/* [HF-CALL-SAFETY-WEB] "How was the call?" for the fan (artboard AppPostCall): Good, or Something was wrong -> tick what happened -> Send report.
 * POST /api/hf/calls/:callId/report { reasons }. A person checks it; the other side never sees who reported.
 * Shows nothing while hfCallRecordingEnabled is off. `startOpen` jumps straight to the ticks (the "Report this call" button on call records). */
import { useEffect, useState } from 'react';
import { capture } from '../../lib/analytics';
import { REPORT_REASONS, SAFETY_EVENTS, recordingEnabled, reportCall, type ReportReason } from '../../lib/hfSafetyApi';
import { Marigold } from '../../islands/dashboard-hf/v3/ui';
import '../../styles/hf-safety.css';

type Step = 'ask' | 'form' | 'sent' | 'good';

export default function PostCallReport({ callId, hostName, startOpen = false, surface }: { callId: string; hostName: string; startOpen?: boolean; surface: 'call_ended' | 'call_record' }) {
  const [on, setOn] = useState(false);
  const [step, setStep] = useState<Step>(startOpen ? 'form' : 'ask');
  const [picked, setPicked] = useState<Set<ReportReason>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { let live = true; void recordingEnabled().then(v => { if (live) setOn(v); }); return () => { live = false; }; }, []);
  useEffect(() => { if (on) capture(SAFETY_EVENTS.reportOpen, { surface, started_open: startOpen }); }, [on, surface, startOpen]);
  if (!on) return null;

  const toggle = (r: ReportReason) => setPicked(p => { const n = new Set(p); if (n.has(r)) n.delete(r); else n.add(r); return n; });
  const send = async () => {
    if (!picked.size || busy) return;
    setBusy(true); setErr('');
    const reasons = REPORT_REASONS.map(([k]) => k).filter(k => picked.has(k));
    const r = await reportCall(callId, reasons);
    setBusy(false);
    if (r.ok) { capture(SAFETY_EVENTS.reportSent, { surface, reasons: reasons.join(',') }); setStep('sent'); return; }
    capture(SAFETY_EVENTS.reportFailed, { surface, status: r.status, code: r.code });
    setErr(r.status === 409 ? 'You already reported this call. A person is checking it.'
      : r.status === 403 || r.status === 404 ? 'Only the people on this call can report it.'
      : r.message || 'We could not send that. Please check your internet and try again.');
  };
  const first = (hostName || 'them').trim().split(/\s+/)[0];

  if (step === 'sent') return <div className="hsf hsf-card hsf-thanks" role="status"><b>Shukriya. Your report is with our team.</b><br />A person checks it. {first} won’t see who reported.</div>;
  if (step === 'good') return <div className="hsf hsf-card hsf-thanks" role="status"><b>Glad it went well.</b><br />You can always report a call later from your call history.</div>;

  return (
    <div className="hsf hsf-report">
      {step === 'ask' && (
        <div className="hsf-card">
          <div className="ttl"><Marigold size={21} />How was the call?</div>
          <div className="hsf-two">
            <button type="button" className="hsf-pick good" onClick={() => { capture(SAFETY_EVENTS.reportGood, { surface }); setStep('good'); }}>Good</button>
            <button type="button" className="hsf-pick bad" onClick={() => setStep('form')}>Something was wrong</button>
          </div>
        </div>
      )}
      {step === 'form' && (
        <>
          <div className="hsf-card blush" role="group" aria-label="What happened">
            <span className="fl" aria-hidden="true"><Marigold size={56} tone={1} /></span>
            {REPORT_REASONS.map(([k, label]) => (
              <label key={k} className="hsf-tick"><input type="checkbox" checked={picked.has(k)} onChange={() => toggle(k)} /><span className="bx" aria-hidden="true">{picked.has(k) ? '✓' : ''}</span>{label}</label>
            ))}
          </div>
          {err && <div className="hsf-err" role="alert">{err}</div>}
          <button type="button" className="hsf-btn wide" disabled={!picked.size || busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send report'}</button>
          <div className="hsf-muted" style={{ textAlign: 'center' }}>A person checks it. {first} won’t see who reported.</div>
        </>
      )}
    </div>
  );
}
