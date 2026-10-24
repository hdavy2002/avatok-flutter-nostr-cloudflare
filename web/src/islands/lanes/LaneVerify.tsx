/* [HF-LANE-VERIFY-1] /verify/lane?lane=women|lgbtq — caller verification for the protected lanes (rulebook HF-WOM-2, HF-LGBT-3).
 * [HF-CREATOR-SPACES-1] Now the full VIDEO KYC, reused for every space channel:
 * WhatsApp check -> intro (18+ and rules) -> Aadhaar (OTP first, DigiLocker fallback) -> women: must be F / LGBTQ+: private self-declaration + terms
 * -> join -> selfie video (reads the code) -> "under review" (polls) -> approved = verified, then back to ?next=. Resumable from GET /api/hf/lanes/me.
 * The pick on the declare screen is never sent or stored. */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND } from '../../lib/brand';
import { publicImage } from '../../lib/config';
import { capture } from '../../lib/analytics';
import { request } from '../../lib/apiClient';
import { EMPTY_DRAFT } from '../host-onboarding/data';
import { digilockerReturning } from '../host-onboarding/storage';
import type { Draft, StepAction, StepProps } from '../host-onboarding/types';
import { fetchLaneMe, joinLane, laneGranted, leaveLane, makeLaneAadhaarApi, parseLane, safeNext, type Lane, type LaneMe } from './laneApi';

const AadhaarStep = lazy(() => import('../host-onboarding/steps/AadhaarStep'));
const SelfieStep = lazy(() => import('../host-onboarding/steps/SelfieStep'));
const LazyClerkBridge = lazy(() => import('../../lib/clerk').then(m => ({ default: m.ClerkSessionBridge })));

type Phase = 'boot' | 'auth' | 'gate' | 'off' | 'error' | 'ready';
type Step = 'pick' | 'wa' | 'intro' | 'aadhaar' | 'declare' | 'joining' | 'selfie' | 'pending' | 'rejected' | 'done' | 'ineligible';

const track = (event: string, props: Record<string, unknown>) => { try { capture(event, props as never); } catch { /* telemetry must never break the flow */ } };
function looksSignedOut(): boolean {
  try {
    const m = document.cookie.match(/(?:^|;\s*)__client_uat(?:_[A-Za-z0-9]+)?=([^;]*)/);
    if (m && m[1] && m[1] !== '0') return false;
    try { if (localStorage.getItem('saathum_guest_jwt')) return false; } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

const COPY: Record<Lane, { name: string; intro: string; privacy: string; back: string; backHref: string; browse: string; whoCan: string; every: string }> = {
  kyc: {
    name: 'video-KYC creators',
    intro: 'Some creators only take calls from customers who did a video KYC. You verify once with Aadhaar and a short selfie video, and it works for every video-KYC creator.',
    privacy: 'Only you and our verification team see your Aadhaar check and your video. Creators and other callers never see them. We never share any customer’s details with anyone.',
    back: 'How it works', backHref: '/how-it-works',
    browse: 'See video-KYC creators', whoCan: 'video-KYC verified customers', every: 'video-KYC creator',
  },
  women: {
    name: 'Women-only channels',
    intro: 'Only verified women can call a Women-only channel. You verify once with Aadhaar and a short selfie video, and it works for every Women-only channel.',
    privacy: 'Only you and our verification team see your Aadhaar check and your video. Creators and other callers never see them.',
    back: 'How Women-only channels work', backHref: '/women-only',
    browse: 'See Women-only channels', whoCan: 'women', every: 'Women-only channel',
  },
  lgbtq: {
    name: 'LGBTQ+ channels',
    intro: 'Only verified LGBTQ+ members can call an LGBTQ+ channel. You verify once with Aadhaar, a private choice and a short selfie video, and it works for every LGBTQ+ channel.',
    privacy: 'Aadhaar cannot show this, so your choice is a private self-declaration. It is never shown to anyone. Only you and our verification team see your Aadhaar check and your video.',
    back: 'How LGBTQ+ channels work', backHref: '/lgbtq',
    browse: 'See LGBTQ+ channels', whoCan: 'LGBTQ+ members', every: 'LGBTQ+ channel',
  },
};

export default function LaneVerify() {
  const lane = useMemo(() => { try { return parseLane(new URLSearchParams(window.location.search).get('lane')); } catch { return null; } }, []);
  const [phase, setPhase] = useState<Phase>('boot');
  const [step, setStep] = useState<Step>('pick');
  const [me, setMe] = useState<LaneMe | null>(null);
  const [loadError, setLoadError] = useState('');
  const [tryNo, setTryNo] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [action, setAction] = useState<StepAction>({ label: 'Continue', hidden: true });
  const [busy, setBusy] = useState(false);
  const [ack18, setAck18] = useState(false);
  const [ackRules, setAckRules] = useState(false);
  const [fit, setFit] = useState('');
  const [ackTerms, setAckTerms] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const next = useMemo(() => { try { return safeNext(new URLSearchParams(window.location.search).get('next')); } catch { return null; } }, []);
  const [joinError, setJoinError] = useState('');
  const mainRef = useRef<HTMLElement>(null);
  const api = useMemo(() => makeLaneAadhaarApi(lane ?? 'women'), [lane]);
  const update = useCallback((patch: Partial<Draft>) => setDraft(prev => ({ ...prev, ...patch })), []);
  const noop = useCallback(() => {}, []);

  const signInUrl = `/sign-in?redirect_url=${encodeURIComponent(`/verify/lane${lane ? `?lane=${lane}${next ? `&next=${encodeURIComponent(next)}` : ''}` : ''}`)}`;

  const go = useCallback((s: Step) => {
    setStep(s); setAction({ label: 'Continue', hidden: true }); setJoinError('');
    track('hf_lane_verify_step', { lane: lane ?? 'none', step: s });
    try { mainRef.current?.focus(); window.scrollTo(0, 0); } catch { /* ignore */ }
  }, [lane]);

  // 1) Is verification switched on? Then wait for the sign-in token.
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

  // 2) Real session, then what the server already knows about this person.
  useEffect(() => {
    if (phase !== 'auth') return;
    let live = true;
    (async () => {
      if (looksSignedOut()) { setPhase('gate'); return; }
      const { getActiveTokenWaited } = await import('../../lib/clerk');
      const t = await getActiveTokenWaited(10000);
      if (!live) return;
      if (!t) { setPhase('gate'); return; }
      const r = await fetchLaneMe();
      if (!live) return;
      if (!r.ok) {
        if (r.status === 404) { setPhase('off'); return; }
        if (r.status === 401) { setPhase('gate'); return; }
        setLoadError(r.error || 'We could not load your details.'); setPhase('error'); return;
      }
      setMe(r.me);
      setPhase('ready');
      if (!lane) { setStep('pick'); return; }
      if (laneGranted(r.me, lane)) { setStep('done'); return; }
      if (!r.me.whatsappVerified) { setStep('wa'); return; }
      if (!r.me.aadhaarVerified && digilockerReturning()) { setAck18(true); setAckRules(true); setStep('aadhaar'); return; }
      if (!r.me.aadhaarVerified) { setStep('intro'); return; }
      // [HF-CREATOR-SPACES-1] Aadhaar is done: pick up where this person stopped.
      if (lane === 'women' && r.me.gender && r.me.gender !== 'F') { setStep('ineligible'); return; }
      if (lane === 'lgbtq' && !r.me.lanes.lgbtq.declared) { setAck18(true); setAckRules(true); setStep('declare'); return; }
      const sf = r.me.selfie?.status ?? 'none';
      if (sf === 'pending') { setStep('pending'); return; }
      if (sf === 'rejected') { setRejectReason(r.me.selfie?.reason ?? ''); setStep('rejected'); return; }
      setAck18(true); setAckRules(true);
      if (sf === 'approved') { void finishJoinRef.current?.(); return; }
      setStep(lane === 'women' ? 'joining' : 'selfie');
      if (lane === 'women') void finishJoinRef.current?.();
    })().catch(e => { if (live) { setLoadError(e instanceof Error && e.message ? e.message : 'We could not load your details.'); setPhase('error'); } });
    return () => { live = false; };
  }, [phase, tryNo, lane]);

  // Join records the membership (before the selfie is approved), then the selfie video is the next step. Approved + joined = granted.
  const doJoin = useCallback(async (): Promise<void> => {
    if (!lane) return;
    go('joining');
    const r = lane === 'kyc' ? { ok: true as const, error: undefined, code: undefined } : await joinLane(lane); // plain video KYC has no join call
    if (r.ok) {
      const fresh = await fetchLaneMe();
      if (fresh.ok) {
        setMe(fresh.me);
        if (laneGranted(fresh.me, lane)) { go('done'); return; }
        const sf = fresh.me.selfie?.status ?? 'none';
        if (sf === 'pending') { go('pending'); return; }
        if (sf === 'rejected') { setRejectReason(fresh.me.selfie?.reason ?? ''); go('rejected'); return; }
      }
      go('selfie'); return;
    }
    if (r.code === 'not_eligible') { go('ineligible'); return; }
    if (r.code === 'aadhaar_required') { go('aadhaar'); return; }
    go('joining'); setJoinError(r.error || 'We could not open this channel for you. Please try again.');
  }, [lane, go]);
  const finishJoinRef = useRef<(() => Promise<void>) | null>(null);
  finishJoinRef.current = doJoin;

  const afterAadhaar = useCallback((gender: 'F' | 'M' | 'T' | null) => {
    if (!lane) return;
    if (lane === 'kyc') { void doJoin(); return; }
    if (lane === 'women') { if (gender && gender !== 'F') go('ineligible'); else void doJoin(); return; }
    go('declare');
  }, [lane, go, doJoin]);

  // Waiting for the review: check every 15 s (the person also gets a WhatsApp message).
  useEffect(() => {
    if (step !== 'pending' || !lane) return;
    let live = true;
    const tick = async () => {
      const r = await fetchLaneMe();
      if (!live || !r.ok) return;
      setMe(r.me);
      const sf = r.me.selfie?.status ?? 'none';
      if (sf === 'approved') { if (laneGranted(r.me, lane)) go('done'); else await doJoin(); }
      else if (sf === 'rejected') { setRejectReason(r.me.selfie?.reason ?? ''); go('rejected'); }
    };
    const t = window.setInterval(() => { void tick(); }, 15000);
    return () => { live = false; window.clearInterval(t); };
  }, [step, lane, go, doJoin]);

  // Action bar for the steps that have one.
  useEffect(() => {
    if (step === 'intro' && lane) {
      setAction({
        label: 'Continue', disabled: !(ack18 && ackRules),
        run: () => { if (me?.aadhaarVerified) afterAadhaar(me.gender); else go('aadhaar'); return false; },
      });
    } else if (step === 'declare') {
      setAction({ label: 'Continue', disabled: !fit || !ackTerms, run: async () => { await doJoin(); return false; } });
    }
  }, [step, lane, ack18, ackRules, fit, ackTerms, me, afterAadhaar, go, doJoin]);

  // The Aadhaar step drives its own action; once it is done, "Continue" moves on.
  const aadhaarSetAction = useCallback((a: StepAction) => {
    if (a.label === 'Continue' && a.run) {
      setAction({ label: 'Continue', run: () => {
        const g = draft.kycGender === 'woman' ? 'F' : draft.kycGender === 'man' ? 'M' : draft.kycGender === 'transgender' ? 'T' : null;
        afterAadhaar(g);
        return false;
      } });
    } else setAction(a);
  }, [draft.kycGender, afterAadhaar]);

  // The selfie step uploads the video as soon as it is recorded; its "Continue" then moves to the review wait.
  const selfieSetAction = useCallback((a: StepAction) => {
    if (a.label === 'Continue' && a.run) setAction({ label: 'Send for review', disabled: a.disabled, run: () => { go('pending'); return false; } });
    else setAction(a);
  }, [go]);

  const onPrimary = async () => {
    if (busy || action.disabled || !action.run) return;
    setBusy(true);
    try { await action.run(); } finally { setBusy(false); }
  };

  const header = (
    <header className="hob-top">
      <div className="hob-wrap">
        <div className="hob-top-row">
          <a className="hob-brand" href="/"><img src={publicImage('/assets/branding/hf-logo.png', { width: 192, fit: 'scale-down' })} alt={BRAND.name} width={56} height={56} /></a>
          <p className="hob-stepcount" />
          <a className="hob-exit" href={lane ? COPY[lane].backHref : '/marketplace'}>Exit</a>
        </div>
      </div>
    </header>
  );

  const wrap = (body: React.ReactNode, showBar = false) => (
    <div className="hob">
      {header}
      <div className="hob-body hob-wrap">
        <main className="hob-main" ref={mainRef} tabIndex={-1} aria-label="Video KYC">{body}</main>
      </div>
      {showBar && !action.hidden && (
        <div className="hob-bar">
          <div className="hob-wrap hob-bar-row">
            <button type="button" className="hob-btn hob-btn-primary hob-next" onClick={onPrimary} disabled={!!action.disabled || busy} aria-busy={busy}>
              {busy ? <><span className="hob-spin" aria-hidden="true" />Please wait…</> : action.label}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  if (phase === 'boot' || phase === 'auth') return wrap(<>{phase === 'auth' && <Suspense fallback={null}><LazyClerkBridge /></Suspense>}<p className="hob-loading" role="status">Loading…</p></>);
  if (phase === 'off') return wrap(<><h1 className="hob-h1">This is not open yet</h1><p className="hob-lead">Video KYC opens soon. Please check back.</p><p className="hob-v-rules"><a href="/marketplace">Back to browsing</a></p></>);
  if (phase === 'gate') {
    return wrap(
      <div className="hob-v-welcome">
        <p className="hob-v-eyebrow">{BRAND.name}</p>
        <h1 className="hob-h1">Sign in to continue</h1>
        <p className="hob-lead">Sign in with your WhatsApp number first. Then we guide you through a short, private verification.</p>
        <a className="hob-btn hob-btn-primary hob-v-start" href={signInUrl}>Sign in</a>
      </div>,
    );
  }
  if (phase === 'error') {
    return wrap(<div><h1 className="hob-h1">We could not open your details</h1><p className="hob-error" role="alert">{loadError}</p>
      <button type="button" className="hob-btn hob-btn-primary" onClick={() => { setLoadError(''); setPhase('auth'); setTryNo(n => n + 1); }}>Try again</button></div>);
  }

  if (step === 'pick' || !lane) {
    return wrap(
      <div>
        <h1 className="hob-h1">Which channels would you like to call?</h1>
        <p className="hob-lead">Each type needs a short video KYC, once. It works for every channel of that type.</p>
        <p><a className="hob-btn hob-btn-primary hob-v-start" href={`/verify/lane?lane=women${next ? `&next=${encodeURIComponent(next)}` : ''}`}>Women-only channels</a></p>
        <p><a className="hob-btn hob-btn-ghost hob-v-start" href={`/verify/lane?lane=lgbtq${next ? `&next=${encodeURIComponent(next)}` : ''}`}>LGBTQ+ channels</a></p>
        <p><a className="hob-btn hob-btn-ghost hob-v-start" href={`/verify/lane?lane=kyc${next ? `&next=${encodeURIComponent(next)}` : ''}`}>Video-KYC creators</a></p>
      </div>,
    );
  }
  const c = COPY[lane];

  if (step === 'wa') {
    return wrap(
      <div>
        <h1 className="hob-h1">Verify your WhatsApp number first</h1>
        <p className="hob-lead">Every caller verifies a WhatsApp number. It takes a minute, and we never show it to anyone. Then come back here.</p>
        <a className="hob-btn hob-btn-primary hob-v-start" href="/sign-up?finish=1">Verify my WhatsApp number</a>
        <p className="hob-v-rules"><a href={c.backHref}>{c.back}</a></p>
      </div>,
    );
  }

  if (step === 'intro') {
    return wrap(
      <div>
        <p className="hob-v-eyebrow">Video KYC</p>
        <h1 className="hob-h1">{lane === 'kyc' ? 'Verify to call video-KYC creators' : `Verify to call ${c.name}`}</h1>
        <p className="hob-lead">{c.intro}</p>
        <div className="hob-card">
          <p className="hob-v-strong">{c.privacy}</p>
          <p className="hob-help">{lane === 'kyc'
            ? 'Step 1: Aadhaar check with an OTP (or DigiLocker if the OTP does not work). Step 2: a 10-second selfie video where you read a code. We keep only the last 4 digits of your Aadhaar number.'
            : lane === 'women'
            ? 'Step 1: Aadhaar check with an OTP (or DigiLocker if the OTP does not work). Step 2: a 10-second selfie video where you read a code. We keep only the last 4 digits of your Aadhaar number.'
            : 'Step 1: Aadhaar check with an OTP (or DigiLocker if the OTP does not work). Step 2: a private choice. Step 3: a 10-second selfie video where you read a code. We keep only the last 4 digits of your Aadhaar number, and we do not keep which option you choose.'}</p>
        </div>
        <label className="hob-card hob-f-consent">
          <input type="checkbox" checked={ack18} onChange={e => setAck18(e.target.checked)} />
          <span>I am 18 years or older.</span>
        </label>
        <label className="hob-card hob-f-consent">
          <input type="checkbox" checked={ackRules} onChange={e => setAckRules(e.target.checked)} />
          <span>I have read and agree to follow the <a href="/community-guidelines" target="_blank" rel="noopener">community guidelines</a> and the <a href="/safety" target="_blank" rel="noopener">safety rules</a>. This is a place for friendship and conversation.</span>
        </label>
        <p className="hob-v-rules"><a href={c.backHref}>{c.back}</a></p>
      </div>,
      true,
    );
  }

  if (step === 'aadhaar') {
    const props: StepProps = { draft, update, api, setAction: aadhaarSetAction, goNext: noop, goTo: noop, avatars: [], errors: {} };
    return wrap(<Suspense fallback={<p className="hob-loading" role="status">Loading…</p>}><AadhaarStep {...props} /></Suspense>, true);
  }

  if (step === 'declare') {
    return wrap(
      <div>
        <p className="hob-v-eyebrow">Just for you</p>
        <h1 className="hob-h1">Is an LGBTQ+ channel right for you?</h1>
        <p className="hob-lead">Aadhaar cannot show this, so we ask you privately. LGBTQ+ channels are for LGBTQ+ people and allies who want a safer place to talk. Choose what fits you best.</p>
        <fieldset className="hob-field" style={{ border: 0, padding: 0, margin: '0 0 20px' }}>
          <legend className="hob-label">Which fits you best?</legend>
          {[['lgbtq', "I'm LGBTQ+"], ['questioning', "I'm questioning"], ['ally', "I'm an ally who wants this safer space"]].map(([v, label]) => (
            <label key={v} className="hob-card hob-f-consent">
              <input type="radio" name="hf-lane-fit" value={v} checked={fit === v} onChange={() => setFit(v)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <label className="hob-card hob-f-consent">
          <input type="checkbox" checked={ackTerms} onChange={e => setAckTerms(e.target.checked)} />
          <span>I accept the <a href="/lgbtq" target="_blank" rel="noopener">LGBTQ+ channel rules</a>: be kind, no outing anyone, no harassment.</span>
        </label>
        <p className="hob-help">This stays private. We do not save which one you pick and we never show it to anyone, only that you chose to join. You can leave any time.</p>
        <p className="hob-error" role="alert" aria-live="polite">{joinError}</p>
      </div>,
      true,
    );
  }

  if (step === 'joining') {
    return wrap(joinError ? (
      <div>
        <h1 className="hob-h1">We could not finish</h1>
        <p className="hob-error" role="alert">{joinError}</p>
        <button type="button" className="hob-btn hob-btn-primary" onClick={() => { void doJoin(); }}>Try again</button>
      </div>
    ) : <><h1 className="hob-h1">Getting you ready…</h1><p className="hob-lead" role="status">One moment.</p></>);
  }

  if (step === 'ineligible') {
    return wrap(
      <div>
        <h1 className="hob-h1">This channel type is for women only</h1>
        <p className="hob-lead">Women-only channels are open to callers whose Aadhaar shows female. We are sorry this is not open to this account, and thank you for understanding.</p>
        <p className="hob-help">Everything else on {BRAND.name} is open to you.</p>
        <p><a className="hob-btn hob-btn-primary hob-v-start" href="/marketplace">Browse all influencers</a></p>
        <p className="hob-v-rules"><a href="/women-only">How Women-only channels work</a></p>
      </div>,
    );
  }

  if (step === 'selfie') {
    const props: StepProps = { draft, update, api, setAction: selfieSetAction, goNext: noop, goTo: noop, avatars: [], errors: {} };
    return wrap(<Suspense fallback={<p className="hob-loading" role="status">Loading…</p>}><SelfieStep {...props} /></Suspense>, true);
  }

  if (step === 'pending') {
    return wrap(
      <div>
        <span className="hob-v-badge" aria-hidden="true">…</span>
        <h1 className="hob-h1">Under review</h1>
        <p className="hob-lead">Thank you. Our team is checking your video against your Aadhaar photo. We will WhatsApp you as soon as it is done. You can close this page.</p>
        <p className="hob-help">Until then, Call, Book and Join queue stay locked on {c.name}. This page checks again by itself.</p>
        <p><a className="hob-btn hob-btn-primary hob-v-start" href={next ?? '/marketplace'}>{next ? 'Go back' : 'Browse influencers'}</a></p>
      </div>,
    );
  }

  if (step === 'rejected') {
    return wrap(
      <div>
        <h1 className="hob-h1">We could not approve your video</h1>
        <p className="hob-lead">{rejectReason ? `Reason: ${rejectReason}` : 'The video did not match, or the code was not clear.'} You can try again with a new code.</p>
        <p className="hob-help">Hold the phone at eye level, in good light, and read the code out loud.</p>
        <button type="button" className="hob-btn hob-btn-primary hob-v-start" onClick={() => { setDraft(d => ({ ...d, selfie: { recorded: false, consent: false, code: '' } })); go('selfie'); }}>Record again</button>
      </div>,
    );
  }

  // done
  return wrap(
    <div>
      <span className="hob-v-badge" aria-hidden="true">✓</span>
      <h1 className="hob-h1">You're verified</h1>
      <p className="hob-lead">You can now call {c.name}. One verification works for every {c.every}.</p>
      <p><a className="hob-btn hob-btn-primary hob-v-start" href={next ?? (lane === 'kyc' ? '/marketplace?kyc=1' : `/marketplace?space=${lane}`)}>{next ? 'Continue' : c.browse}</a></p>
      {lane !== 'kyc' && <p className="hob-v-rules">
        <button type="button" className="hob-v-link" onClick={async () => {
          if (!window.confirm('Leave these channels? You can verify again any time.')) return;
          if (await leaveLane(lane)) { setMe(m => (m ? { ...m, lanes: { ...m.lanes, [lane]: { ...m.lanes[lane], granted: false } } } : m)); setAck18(false); setAckRules(false); setFit(''); setAckTerms(false); go('intro'); }
        }}>Leave {c.name}</button>
      </p>}
    </div>,
  );
}
