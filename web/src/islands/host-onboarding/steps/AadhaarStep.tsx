import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import { GENDER_LABEL } from '../data';
import { capture } from '../../../lib/analytics';
import { clearDigilockerPending, digilockerReturning, markDigilockerPending, stripDlParam } from '../storage';
import type { KycGender, StepProps } from '../types';

/* [HF-KYC-OTP-FALLBACK-1] Aadhaar: OTP first, DigiLocker as the fallback.
 * [HF-KYC-DIGILOCKER-1] DigiLocker: the host leaves for DigiLocker (full page, no popup) and comes back to
 * /hosts/onboarding?step=aadhaar&dl=return; on return this step finishes the check once, by itself.
 * The Aadhaar number lives only in this component's state while the host types it. It is never written to storage,
 * the draft, the URL or analytics, and it is cleared as soon as the check succeeds. */
type Phase = 'idle' | 'starting' | 'checking' | 'pending' | 'error';
type Mode = 'otp' | 'digilocker';
type Via = 'fallback' | 'link' | 'direct';
const AUTO_RETRY_MS = 3000;
const RESEND_SECONDS = 30;
const group = (d: string) => d.replace(/(\d{4})(?=\d)/g, '$1 ');
const track = (event: string, props: Record<string, string>) => {
  try { capture(event, props as never); } catch { /* telemetry must never break the flow */ }
};

export default function AadhaarStep({ draft, update, api, setAction }: StepProps) {
  const [mockGender, setMockGender] = useState<KycGender>(draft.kycGender ?? 'woman');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [canRecheck, setCanRecheck] = useState(false);
  const [consent, setConsent] = useState(false); // DigiLocker consent
  const [mode, setMode] = useState<Mode>(() => (digilockerReturning() ? 'digilocker' : 'otp'));
  const [source, setSource] = useState<'otp' | 'digilocker' | null>(null);
  const [otpConsent, setOtpConsent] = useState(false);
  const [stage, setStage] = useState<'number' | 'code'>('number');
  const [aadhaar, setAadhaar] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldErr, setFieldErr] = useState('');
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [fallbackMsg, setFallbackMsg] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const via = useRef<Via>('direct');
  const real = api.mode === 'real';
  const done = draft.aadhaarDone;
  const ran = useRef(false);
  const autoRetried = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const finish = useCallback((r: { last4?: string; name?: string; gender?: KycGender | null }, src: 'otp' | 'digilocker' = 'digilocker') => {
    clearDigilockerPending(); stripDlParam();
    setSource(src); setAadhaar(''); setCode(''); setFallbackMsg(''); setAttemptsLeft(null); setFieldErr('');
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
    track('hf_kyc_digilocker_clicked', { mode: api.mode, via: via.current });
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

  // Resend timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const showFallback = useCallback((msg: string, reason: string) => {
    setFallbackMsg(msg || 'OTP is not working for your Aadhaar right now.');
    track('hf_kyc_fallback_shown', { reason });
  }, []);

  const sendOtp = useCallback(async (): Promise<boolean> => {
    setError(''); setFieldErr(''); setBusy(true);
    track('hf_kyc_otp_clicked', { mode: api.mode });
    const r = await api.aadhaarSendOtp(aadhaar, otpConsent);
    if (!live.current) return false;
    setBusy(false);
    if (r.ok && r.alreadyVerified) { finish({ last4: r.alreadyVerified.last4, gender: r.alreadyVerified.gender }, 'otp'); return false; }
    if (r.ok) { setStage('code'); setCode(''); setAttemptsLeft(null); setCooldown(RESEND_SECONDS); return false; }
    if (r.fallback === 'digilocker') { showFallback(r.error || '', r.code || 'fallback'); return false; }
    if (r.field === 'aadhaar') setFieldErr(r.error || 'Please check your Aadhaar number.');
    else setError(r.error || 'We could not send the OTP. Please try again.');
    return false;
  }, [api, aadhaar, otpConsent, finish, showFallback]);

  const verifyOtp = useCallback(async (): Promise<boolean> => {
    setError(''); setBusy(true);
    const r = await api.aadhaarVerifyOtp(code, mockGender);
    if (!live.current) return false;
    setBusy(false);
    if (r.ok) { finish({ last4: r.last4, name: r.name, gender: r.gender ?? null }, 'otp'); return false; }
    if (r.fallback === 'digilocker') { showFallback(r.error || '', r.code || 'fallback'); return false; }
    setError(r.error || 'That OTP is not right. Please try again.');
    setAttemptsLeft(typeof r.attemptsLeft === 'number' ? r.attemptsLeft : null);
    setCode('');
    return false;
  }, [api, code, mockGender, finish, showFallback]);

  const goDigilocker = useCallback((v: Via) => {
    via.current = v;
    setMode('digilocker'); setError(''); setFieldErr(''); setFallbackMsg(''); setConsent(false); setPhase('idle'); setCanRecheck(false);
    setAadhaar(''); setCode(''); setStage('number'); setAttemptsLeft(null); setCooldown(0);
  }, []);

  const backToOtp = useCallback(() => {
    setMode('otp'); setError(''); setFieldErr(''); setPhase('idle'); setCanRecheck(false);
    clearDigilockerPending(); stripDlParam();
  }, []);

  const changeNumber = useCallback(() => {
    setStage('number'); setCode(''); setError(''); setAttemptsLeft(null); setCooldown(0);
  }, []);

  // Back from DigiLocker: finish the check once. (The shell has already restored the saved draft before this step shows.)
  useEffect(() => {
    if (!real || done || ran.current) return;
    if (!digilockerReturning()) return;
    ran.current = true;
    void complete();
  }, [real, done, complete]);

  useEffect(() => {
    if (done) { setAction({ label: 'Continue', run: () => true }); return; }
    if (mode === 'otp') {
      if (busy) setAction({ label: stage === 'code' ? 'Checking…' : 'Sending…', disabled: true });
      else if (fallbackMsg) setAction({ label: 'Verify with DigiLocker', run: () => { goDigilocker('fallback'); return false; } });
      else if (stage === 'number') setAction({ label: 'Send OTP', disabled: !otpConsent || aadhaar.length !== 12, run: sendOtp });
      else setAction({ label: 'Verify', disabled: code.length !== 6, run: verifyOtp });
      return;
    }
    if (phase === 'checking' || phase === 'starting') setAction({ label: 'Checking…', disabled: true });
    else if (phase === 'pending' || (phase === 'error' && canRecheck)) setAction({ label: 'Check again', run: async () => { await complete(); return false; } });
    else setAction({
      label: phase === 'error' ? 'Try again' : 'Verify with DigiLocker',
      disabled: !consent,
      run: start,
    });
  }, [done, mode, busy, stage, fallbackMsg, otpConsent, aadhaar, code, phase, canRecheck, consent, start, complete, sendOtp, verifyOtp, goDigilocker, setAction]);

  if (done) {
    return (
      <div>
        <h1 className="hob-h1">Aadhaar verified</h1>
        <p className="hob-lead">{source === 'otp' ? 'Here is what we received from UIDAI.' : source === 'digilocker' ? 'Here is what DigiLocker shared with us.' : 'Here is what we received for your Aadhaar.'}</p>
        <div className="hob-card hob-v-done">
          <span className="hob-v-badge" aria-hidden="true"><Icon name="check" /></span>
          <p className="hob-v-strong">Aadhaar ending {draft.aadhaarLast4}</p>
        </div>
        <dl className="hob-card hob-v-read">
          <div><dt>Name</dt><dd>{draft.aadhaarName || '-'}</dd></div>
          <div><dt>Gender</dt><dd>{draft.kycGender ? GENDER_LABEL[draft.kycGender] : '-'}</dd></div>
          <div><dt>Age</dt><dd>18 or older ✓</dd></div>
        </dl>
        <p className="hob-help">Your Aadhaar details and photo are stored encrypted and seen only by our verification team. We never keep your full Aadhaar number — only the last 4 digits. (With OTP, we use the full number only to request the OTP.)</p>
      </div>
    );
  }

  if (mode === 'otp') {
    const preview = !real && (
      <div className="hob-v-preview" role="group" aria-labelledby="hob-v-prev">
        <p className="hob-v-tag">Preview only</p>
        <p id="hob-v-prev">For this preview, choose the gender the Aadhaar record would show:</p>
        <div className="hob-v-chips">
          {(['woman', 'man', 'transgender'] as KycGender[]).map((g) => (
            <button key={g} type="button" className="hob-chip" aria-pressed={mockGender === g} onClick={() => setMockGender(g)}>{GENDER_LABEL[g]}</button>
          ))}
        </div>
        <p>The OTP is 123456. An Aadhaar number ending 0000 shows the DigiLocker fallback.</p>
      </div>
    );

    if (fallbackMsg) {
      return (
        <div>
          <h1 className="hob-h1">Let's try DigiLocker instead</h1>
          <div className="hob-card hob-v-fallback" role="alert" aria-live="polite">
            <p>{fallbackMsg}</p>
            <button type="button" className="hob-btn hob-btn-primary hob-v-start" onClick={() => goDigilocker('fallback')}>Verify with DigiLocker</button>
          </div>
          <button type="button" className="hob-v-link" onClick={() => { setFallbackMsg(''); setError(''); setCode(''); setStage('number'); }}>Try Aadhaar OTP again</button>
          {preview}
        </div>
      );
    }

    return (
      <div>
        {stage === 'number' ? (
          <>
            <h1 className="hob-h1">Verify your Aadhaar with an OTP</h1>
            <p className="hob-lead">We send a 6-digit OTP to the mobile number linked with your Aadhaar.</p>
            <div className="hob-field">
              <label className="hob-label" htmlFor="hob-v-aadhaar">Aadhaar number</label>
              <input
                id="hob-v-aadhaar" className="hob-input hob-v-aadhaar" type="text" inputMode="numeric" pattern="[0-9 ]*"
                autoComplete="off" placeholder="0000 0000 0000" value={group(aadhaar)}
                aria-invalid={!!fieldErr} aria-describedby="hob-v-aadhaar-err"
                onChange={(e) => { setAadhaar(e.target.value.replace(/\D/g, '').slice(0, 12)); setFieldErr(''); setError(''); }}
              />
              <p id="hob-v-aadhaar-err" className="hob-error" role="alert" aria-live="polite">{fieldErr}</p>
            </div>
            <label className="hob-card hob-f-consent">
              <input type="checkbox" checked={otpConsent} onChange={(e) => setOtpConsent(e.target.checked)} />
              <span>I agree to verify my Aadhaar with an OTP. My Aadhaar number is used only to send the OTP and is not stored. UIDAI shares my name, date of birth, gender, address and photo with us. Only the last 4 digits of my Aadhaar number are kept. This is used only to confirm that I am 18 or older and who I am.</span>
            </label>
          </>
        ) : (
          <>
            <h1 className="hob-h1">Enter the OTP</h1>
            <p className="hob-lead">We sent a 6-digit OTP to the mobile linked with your Aadhaar.</p>
            <div className="hob-field">
              <label className="hob-label" htmlFor="hob-v-aotp">6-digit OTP</label>
              <input
                id="hob-v-aotp" className="hob-input hob-v-code" type="text" inputMode="numeric" pattern="[0-9]*"
                autoComplete="one-time-code" maxLength={6} placeholder="······" value={code}
                aria-describedby="hob-v-aotp-err"
                onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
              />
              {attemptsLeft !== null && <p className="hob-v-tries">{attemptsLeft === 1 ? '1 try left.' : `${attemptsLeft} tries left.`}</p>}
            </div>
            <div className="hob-v-resend">
              <button type="button" className="hob-v-link" disabled={cooldown > 0 || busy} onClick={() => { void sendOtp(); }}>
                {cooldown > 0 ? `Send the OTP again in ${cooldown}s` : 'Send the OTP again'}
              </button>
              <button type="button" className="hob-v-link" onClick={changeNumber}>Change Aadhaar number</button>
            </div>
          </>
        )}
        <p className="hob-error" role="alert" aria-live="polite">{error}</p>
        <p className="hob-v-alt">
          No phone linked to your Aadhaar, or OTP not coming?{' '}
          <button type="button" className="hob-v-link" onClick={() => goDigilocker('link')}>Verify with DigiLocker instead</button>
        </p>
        {preview}
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
      <p><button type="button" className="hob-v-link" onClick={backToOtp}>Back to Aadhaar OTP</button></p>
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
