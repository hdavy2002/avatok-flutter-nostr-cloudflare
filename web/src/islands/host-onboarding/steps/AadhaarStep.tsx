import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import { GENDER_LABEL } from '../data';
import { capture } from '../../../lib/analytics';
import { clearDigilockerPending, digilockerReturning, markDigilockerPending, stripDlParam } from '../storage';
import type { KycGender, StepProps } from '../types';

/* [HF-KYC-DIGILOCKER-1] Aadhaar via DigiLocker. The host leaves for DigiLocker (full page, no popup) and comes back to
 * /hosts/onboarding?step=aadhaar&dl=return; on return this step finishes the check once, by itself. */
type Phase = 'idle' | 'starting' | 'checking' | 'pending' | 'error';
const AUTO_RETRY_MS = 3000;

export default function AadhaarStep({ draft, update, api, setAction }: StepProps) {
  const [mockGender, setMockGender] = useState<KycGender>(draft.kycGender ?? 'woman');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [canRecheck, setCanRecheck] = useState(false);
  const [consent, setConsent] = useState(false);
  const real = api.mode === 'real';
  const done = draft.aadhaarDone;
  const ran = useRef(false);
  const autoRetried = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const finish = useCallback((r: { last4?: string; name?: string; gender?: KycGender | null }) => {
    clearDigilockerPending(); stripDlParam();
    update({ aadhaarDone: true, aadhaarLast4: r.last4 || '', aadhaarName: r.name || '', kycGender: r.gender ?? null });
    setPhase('idle'); setError('');
  }, [update]);

  const complete = useCallback(async () => {
    setPhase('checking'); setError('');
    const r = await api.digilockerComplete(mockGender);
    if (!live.current) return;
    if (r.ok) { finish({ last4: r.last4, name: r.name, gender: r.gender ?? null }); return; }
    if (r.pending) {
      setPhase('pending'); setError(r.error || 'DigiLocker is still sending your details.'); setCanRecheck(true);
      if (!autoRetried.current) {
        autoRetried.current = true;
        setTimeout(() => { if (live.current) void complete(); }, AUTO_RETRY_MS);
      }
      return;
    }
    stripDlParam();
    setPhase('error'); setError(r.error || 'We could not finish the check. Please try again.');
    if (r.retry) { clearDigilockerPending(); setCanRecheck(false); } else setCanRecheck(true);
  }, [api, mockGender, finish]);

  const start = useCallback(async (): Promise<boolean> => {
    setError(''); setPhase('starting');
    try { capture('hf_kyc_digilocker_clicked', { mode: api.mode } as never); } catch { /* telemetry must never break the flow */ }
    const r = await api.digilockerStart(true);
    if (!live.current) return false;
    if (!r.ok) { setPhase('error'); setError(r.error || 'We could not open DigiLocker right now. Please try again.'); setCanRecheck(false); return false; }
    if (r.alreadyVerified) {
      finish({ last4: r.alreadyVerified.last4, gender: r.alreadyVerified.gender });
      return false;
    }
    if (r.url) {
      markDigilockerPending();
      window.location.assign(r.url); // full page on purpose: works inside the app wrapper too
      return false;
    }
    // Preview: no page to visit, so pretend the host came back.
    await complete();
    return false;
  }, [api, finish, complete]);

  // Back from DigiLocker: finish the check once. (The shell has already restored the saved draft before this step shows.)
  useEffect(() => {
    if (!real || done || ran.current) return;
    if (!digilockerReturning()) return;
    ran.current = true;
    void complete();
  }, [real, done, complete]);

  useEffect(() => {
    if (done) setAction({ label: 'Continue', run: () => true });
    else if (phase === 'checking' || phase === 'starting') setAction({ label: 'Checking…', disabled: true });
    else if (phase === 'pending' || (phase === 'error' && canRecheck)) setAction({ label: 'Check again', run: async () => { await complete(); return false; } });
    else setAction({
      label: phase === 'error' ? 'Try again' : 'Verify with DigiLocker',
      disabled: !consent,
      run: start,
    });
  }, [done, phase, canRecheck, consent, start, complete, setAction]);

  if (done) {
    return (
      <div>
        <h1 className="hob-h1">Aadhaar verified</h1>
        <p className="hob-lead">Here is what DigiLocker shared with us.</p>
        <div className="hob-card hob-v-done">
          <span className="hob-v-badge" aria-hidden="true"><Icon name="check" /></span>
          <p className="hob-v-strong">Aadhaar ending {draft.aadhaarLast4}</p>
        </div>
        <dl className="hob-card hob-v-read">
          <div><dt>Name</dt><dd>{draft.aadhaarName || '-'}</dd></div>
          <div><dt>Gender</dt><dd>{draft.kycGender ? GENDER_LABEL[draft.kycGender] : '-'}</dd></div>
          <div><dt>Age</dt><dd>18 or older ✓</dd></div>
        </dl>
        <p className="hob-help">Your Aadhaar details and photo are stored encrypted and seen only by our verification team. We never receive or keep your full Aadhaar number — only the last 4 digits.</p>
      </div>
    );
  }

  if (phase === 'checking') {
    return (
      <div>
        <h1 className="hob-h1">Checking with DigiLocker…</h1>
        <p className="hob-lead" role="status">Please wait a moment. We are getting your details.</p>
      </div>
    );
  }

  if (phase === 'pending' || (phase === 'error' && canRecheck)) {
    return (
      <div>
        <h1 className="hob-h1">{phase === 'pending' ? 'Still waiting for DigiLocker' : 'We could not finish yet'}</h1>
        <p className="hob-error" role="alert" aria-live="polite">{error}</p>
        <p className="hob-help">Tap "Check again" in a few seconds.</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="hob-h1">Verify your Aadhaar with DigiLocker</h1>
      <p className="hob-lead">You'll sign in to DigiLocker (a Government of India service), approve sharing your Aadhaar, and come straight back here.</p>
      <p className="hob-error" role="alert" aria-live="polite">{error}</p>
      <label className="hob-card hob-f-consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I agree that DigiLocker can share my Aadhaar details with us: my name, date of birth, gender, address and photo. Only the last 4 digits of my Aadhaar number are kept. This is used only to confirm that I am 18 or older and who I am.</span>
      </label>
      {!real && <div className="hob-v-preview" role="group" aria-labelledby="hob-v-prev">
        <p className="hob-v-tag">Preview only</p>
        <p id="hob-v-prev">For this preview, choose the gender the Aadhaar record would show:</p>
        <div className="hob-v-chips">
          {(['woman', 'man', 'transgender'] as KycGender[]).map((g) => (
            <button key={g} type="button" className="hob-chip" aria-pressed={mockGender === g} onClick={() => setMockGender(g)}>{GENDER_LABEL[g]}</button>
          ))}
        </div>
      </div>}
    </div>
  );
}
