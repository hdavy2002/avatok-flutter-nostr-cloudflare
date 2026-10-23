/* [HF-CLOSE-UPI-1] /verify/id?next=/dashboard/... : the one-time ID check before a first withdrawal, for ANYONE signed in (fans too).
 * It is the host-onboarding Aadhaar step (OTP first, DigiLocker as the fallback) on its own page, without the influencer wizard around it:
 * /hosts/onboarding is for becoming an influencer and would push a fan into creating a profile. Role is "host" for an influencer (so her
 * onboarding sees the check as done) and "lane_caller" for everyone else. The Aadhaar number stays in the step's own state (see AadhaarStep). */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND } from '../../lib/brand';
import { publicImage } from '../../lib/config';
import { capture } from '../../lib/analytics';
import { request } from '../../lib/apiClient';
import { call, kycGender, otpFailure, realApi } from '../host-onboarding/api_real';
import { EMPTY_DRAFT } from '../host-onboarding/data';
import type { Draft, OnboardingApi, StepAction, StepProps } from '../host-onboarding/types';
import { fetchPayoutSummary } from '../../lib/hfPayoutApi';

const AadhaarStep = lazy(() => import('../host-onboarding/steps/AadhaarStep'));
const LazyClerkBridge = lazy(() => import('../../lib/clerk').then(m => ({ default: m.ClerkSessionBridge })));

type Phase = 'boot' | 'auth' | 'gate' | 'off' | 'error' | 'ready' | 'done';
const track = (event: string, props: Record<string, unknown>) => { try { capture(event, props as never); } catch { /* telemetry must never break the flow */ } };

/** Only paths inside the account area are allowed, so this page can never be used as an open redirect. */
export function safeNext(v: string | null | undefined): string {
  if (typeof v !== 'string' || !v.startsWith('/dashboard') || v.startsWith('//') || /[\\\s\u0000-\u001f]/.test(v) || v.length > 120) return '/dashboard/wallet';
  return v;
}
function looksSignedOut(): boolean {
  try {
    const m = document.cookie.match(/(?:^|;\s*)__client_uat(?:_[A-Za-z0-9]+)?=([^;]*)/);
    if (m && m[1] && m[1] !== '0') return false;
    try { if (localStorage.getItem('saathum_guest_jwt')) return false; } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

/** Aadhaar client with the right role and a return path back to this page (DigiLocker leaves the site and comes back). */
function makeApi(role: 'host' | 'lane_caller', returnPath: string): OnboardingApi {
  return {
    ...realApi,
    async aadhaarSendOtp(aadhaar, consent) {
      const r = await call<{ ok: boolean; already_verified?: boolean; gender?: string | null; last4?: string }>(
        'POST', '/api/hosts/kyc/aadhaar/otp', { aadhaar: aadhaar.replace(/\D/g, ''), consent, role }, 'We could not send the OTP. Please check the number.');
      if (!r.ok) return otpFailure(r);
      if (r.data.already_verified) return { ok: true, alreadyVerified: { gender: kycGender(r.data.gender ?? null), last4: r.data.last4 || '' } };
      return { ok: true };
    },
    async digilockerStart(consent, rp) {
      const r = await call<{ ok: boolean; url?: string; already_verified?: boolean; gender?: string | null; last4?: string }>(
        'POST', '/api/hosts/kyc/digilocker/start', { consent, role, returnPath: rp || returnPath }, 'We could not open DigiLocker right now. Please try again.');
      if (!r.ok) return { ok: false, error: r.error };
      if (r.data.already_verified) return { ok: true, alreadyVerified: { gender: kycGender(r.data.gender ?? null), last4: r.data.last4 || '' } };
      if (!r.data.url) return { ok: false, error: 'We could not open DigiLocker right now. Please try again.' };
      return { ok: true, url: r.data.url };
    },
  };
}

export default function IdCheck() {
  const next = useMemo(() => { try { return safeNext(new URLSearchParams(window.location.search).get('next')); } catch { return '/dashboard/wallet'; } }, []);
  const [phase, setPhase] = useState<Phase>('boot');
  const [role, setRole] = useState<'host' | 'lane_caller'>('lane_caller');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [action, setAction] = useState<StepAction>({ label: 'Continue', hidden: true });
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [tryNo, setTryNo] = useState(0);
  const api = useMemo(() => makeApi(role, `/verify/id?dl=return&next=${encodeURIComponent(next)}`), [role, next]);
  const update = useCallback((patch: Partial<Draft>) => setDraft(prev => ({ ...prev, ...patch })), []);
  const noop = useCallback(() => {}, []);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const cfg = await request<{ hostKycEnabled?: boolean }>('/api/config', { query: { _: Date.now() }, timeoutMs: 8000 });
        if (!live) return;
        if (cfg?.hostKycEnabled !== true) { setPhase('off'); return; }
      } catch { if (live) setPhase('off'); return; }
      if (live) setPhase('auth');
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (phase !== 'auth') return;
    let live = true;
    (async () => {
      if (looksSignedOut()) { setPhase('gate'); return; }
      const { getActiveTokenWaited } = await import('../../lib/clerk');
      const t = await getActiveTokenWaited(10000);
      if (!live) return;
      if (!t) { setPhase('gate'); return; }
      const s = await fetchPayoutSummary();
      if (!live) return;
      setRole(s.isInfluencer ? 'host' : 'lane_caller');
      if (s.kycStatus === 'verified') { track('hf_payout_idcheck_already_done', {}); setPhase('done'); return; }
      track('hf_payout_idcheck_opened', { role: s.isInfluencer ? 'host' : 'lane_caller' });
      setPhase('ready');
    })().catch(e => { if (live) { setLoadError(e instanceof Error && e.message ? e.message : 'We could not load your details.'); setPhase('error'); } });
    return () => { live = false; };
  }, [phase, tryNo]);

  // The Aadhaar step drives its own button; once the check is done its "Continue" brings the person back where they came from.
  const stepAction = useCallback((a: StepAction) => {
    if (a.label === 'Continue' && a.run) setAction({ label: 'Back to where I was', run: () => { track('hf_payout_idcheck_done', {}); window.location.assign(next); return false; } });
    else setAction(a);
  }, [next]);

  const onPrimary = async () => {
    if (busy || action.disabled || !action.run) return;
    setBusy(true);
    try { await action.run(); } finally { setBusy(false); }
  };

  const wrap = (body: React.ReactNode, showBar = false) => (
    <div className="hob">
      <header className="hob-top"><div className="hob-wrap"><div className="hob-top-row">
        <a className="hob-brand" href="/"><img src={publicImage('/assets/branding/hf-logo.png', { width: 192, fit: 'scale-down' })} alt={BRAND.name} width={56} height={56} /></a>
        <p className="hob-stepcount" />
        <a className="hob-exit" href={next}>Exit</a>
      </div></div></header>
      <div className="hob-body hob-wrap"><main className="hob-main" ref={mainRef} tabIndex={-1} aria-label="One-time ID check">{body}</main></div>
      {showBar && !action.hidden && (
        <div className="hob-bar"><div className="hob-wrap hob-bar-row">
          <button type="button" className="hob-btn hob-btn-primary hob-next" onClick={onPrimary} disabled={!!action.disabled || busy} aria-busy={busy}>
            {busy ? <><span className="hob-spin" aria-hidden="true" />Please wait…</> : action.label}
          </button>
        </div></div>
      )}
    </div>
  );

  if (phase === 'boot' || phase === 'auth') return wrap(<>{phase === 'auth' && <Suspense fallback={null}><LazyClerkBridge /></Suspense>}<p className="hob-loading" role="status">Loading…</p></>);
  if (phase === 'off') return wrap(<><h1 className="hob-h1">This is not open yet</h1><p className="hob-lead">The ID check opens soon. Please check back.</p><p className="hob-v-rules"><a href={next}>Go back</a></p></>);
  if (phase === 'gate') return wrap(<div className="hob-v-welcome"><p className="hob-v-eyebrow">{BRAND.name}</p><h1 className="hob-h1">Sign in to continue</h1><p className="hob-lead">Sign in first. Then we do a short, private ID check, once.</p>
    <a className="hob-btn hob-btn-primary hob-v-start" href={`/sign-in?redirect_url=${encodeURIComponent(`/verify/id?next=${encodeURIComponent(next)}`)}`}>Sign in</a></div>);
  if (phase === 'error') return wrap(<div><h1 className="hob-h1">We could not open your details</h1><p className="hob-error" role="alert">{loadError}</p>
    <button type="button" className="hob-btn hob-btn-primary" onClick={() => { setLoadError(''); setPhase('auth'); setTryNo(n => n + 1); }}>Try again</button></div>);
  if (phase === 'done') return wrap(<div><h1 className="hob-h1">Your ID check is done</h1><p className="hob-lead">We do not ask again.</p><a className="hob-btn hob-btn-primary hob-v-start" href={next}>Back to where I was</a></div>);
  const props: StepProps = { draft, update, api, setAction: stepAction, goNext: noop, goTo: noop, avatars: [], errors: {} };
  return wrap(<Suspense fallback={<p className="hob-loading" role="status">Loading…</p>}><AadhaarStep {...props} /></Suspense>, true);
}
