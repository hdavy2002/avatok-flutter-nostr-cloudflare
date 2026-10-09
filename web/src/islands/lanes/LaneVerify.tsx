/* [HF-LANE-VERIFY-1] /verify/lane?lane=women|lgbtq — caller verification for the protected lanes (rulebook HF-WOM-2, HF-LGBT-3).
 * Steps: WhatsApp check -> intro (18+ and rules) -> Aadhaar (the host-onboarding step: OTP first, DigiLocker fallback) -> [LGBTQ+: private
 * self-declaration] -> join -> done. Nothing about a person's identity is stored beyond "joined"; the pick on the declare screen is never sent. */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND } from '../../lib/brand';
import { publicImage } from '../../lib/config';
import { capture } from '../../lib/analytics';
import { request } from '../../lib/apiClient';
import { EMPTY_DRAFT } from '../host-onboarding/data';
import { digilockerReturning } from '../host-onboarding/storage';
import type { Draft, StepAction, StepProps } from '../host-onboarding/types';
import { fetchLaneMe, joinLane, leaveLane, makeLaneAadhaarApi, parseLane, type Lane, type LaneMe } from './laneApi';

const AadhaarStep = lazy(() => import('../host-onboarding/steps/AadhaarStep'));
const LazyClerkBridge = lazy(() => import('../../lib/clerk').then(m => ({ default: m.ClerkSessionBridge })));

type Phase = 'boot' | 'auth' | 'gate' | 'off' | 'error' | 'ready';
type Step = 'pick' | 'wa' | 'intro' | 'aadhaar' | 'declare' | 'joining' | 'done' | 'ineligible';

const track = (event: string, props: Record<string, unknown>) => { try { capture(event, props as never); } catch { /* telemetry must never break the flow */ } };
function looksSignedOut(): boolean {
  try {
    const m = document.cookie.match(/(?:^|;\s*)__client_uat(?:_[A-Za-z0-9]+)?=([^;]*)/);
    if (m && m[1] && m[1] !== '0') return false;
    try { if (localStorage.getItem('saathum_guest_jwt')) return false; } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

const COPY: Record<Lane, { name: string; intro: string; privacy: string; back: string; backHref: string; doneTitle: string; doneBody: string; browse: string }> = {
  women: {
    name: 'the women-only space',
    intro: 'A calmer place to talk, open to callers whose Aadhaar shows female or transgender. You verify once, and the hosts in this space become visible to you.',
    privacy: 'Only you and our safety team see your verification. Hosts and other callers never see it.',
    back: 'How the women-only space works', backHref: '/women-only',
    doneTitle: "You're in", doneBody: "You'll now see women-only hosts.", browse: 'See women-only hosts',
  },
  lgbtq: {
    name: 'the LGBTQ+ space',
    intro: 'A private space for LGBTQ+ people and allies who want a safer place to talk. You verify once, and the hosts in this space become visible to you.',
    privacy: 'Only you and our safety team see this. It is private by default, and it is never shown on your profile or to hosts.',
    back: 'How the LGBTQ+ space works', backHref: '/lgbtq',
    doneTitle: "You're in", doneBody: "You'll now see LGBTQ+ space hosts.", browse: 'See LGBTQ+ space hosts',
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
  const [joinError, setJoinError] = useState('');
  const mainRef = useRef<HTMLElement>(null);
  const api = useMemo(() => makeLaneAadhaarApi(lane ?? 'women'), [lane]);
  const update = useCallback((patch: Partial<Draft>) => setDraft(prev => ({ ...prev, ...patch })), []);
  const noop = useCallback(() => {}, []);

  const signInUrl = `/sign-in?redirect_url=${encodeURIComponent(`/verify/lane${lane ? `?lane=${lane}` : ''}`)}`;

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
      if (r.me.lanes[lane].granted) { setStep('done'); return; }
      if (!r.me.whatsappVerified) { setStep('wa'); return; }
      if (!r.me.aadhaarVerified && digilockerReturning()) { setAck18(true); setAckRules(true); setStep('aadhaar'); return; }
      setStep('intro');
    })().catch(e => { if (live) { setLoadError(e instanceof Error && e.message ? e.message : 'We could not load your details.'); setPhase('error'); } });
    return () => { live = false; };
  }, [phase, tryNo, lane]);

  const doJoin = useCallback(async (): Promise<void> => {
    if (!lane) return;
    go('joining');
    const r = await joinLane(lane);
    if (r.ok) { setMe(m => (m ? { ...m, lanes: { ...m.lanes, [lane]: { ...m.lanes[lane], granted: true } } } : m)); go('done'); return; }
    if (r.code === 'not_eligible') { go('ineligible'); return; }
    if (r.code === 'aadhaar_required') { go('aadhaar'); return; }
    go('joining'); setJoinError(r.error || 'We could not open this space for you. Please try again.');
  }, [lane, go]);

  const afterAadhaar = useCallback((gender: 'F' | 'M' | 'T' | null) => {
    if (!lane) return;
    if (lane === 'women') { if (gender === 'M') go('ineligible'); else void doJoin(); return; }
    go('declare');
  }, [lane, go, doJoin]);

  // Action bar for the steps that have one.
  useEffect(() => {
    if (step === 'intro' && lane) {
      setAction({
        label: 'Continue', disabled: !(ack18 && ackRules),
        run: () => { if (me?.aadhaarVerified) afterAadhaar(me.gender); else go('aadhaar'); return false; },
      });
    } else if (step === 'declare') {
      setAction({ label: 'Join this space', disabled: !fit, run: async () => { await doJoin(); return false; } });
    }
  }, [step, lane, ack18, ackRules, fit, me, afterAadhaar, go, doJoin]);

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

  const onPrimary = async () => {
    if (busy || action.disabled || !action.run) return;
    setBusy(true);
    try { await action.run(); } finally { setBusy(false); }
  };

  const header = (
    <header className="hob-top">
      <div className="hob-wrap">
        <div className="hob-top-row">
          <a className="hob-brand" href="/"><img src={publicImage('/assets/branding/friendship-wordmark.png', { width: 640, fit: 'scale-down' })} alt={BRAND.name} height={40} /></a>
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
        <main className="hob-main" ref={mainRef} tabIndex={-1} aria-label="Verify to enter a protected space">{body}</main>
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
  if (phase === 'off') return wrap(<><h1 className="hob-h1">This is not open yet</h1><p className="hob-lead">Verification for this space opens soon. Please check back.</p><p className="hob-v-rules"><a href="/marketplace">Back to browsing</a></p></>);
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
        <h1 className="hob-h1">Which space would you like to enter?</h1>
        <p className="hob-lead">Each one is private and needs a short verification, once.</p>
        <p><a className="hob-btn hob-btn-primary hob-v-start" href="/verify/lane?lane=women">The women-only space</a></p>
        <p><a className="hob-btn hob-btn-ghost hob-v-start" href="/verify/lane?lane=lgbtq">The LGBTQ+ space</a></p>
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
        <p className="hob-v-eyebrow">Private verification</p>
        <h1 className="hob-h1">Enter {c.name}</h1>
        <p className="hob-lead">{c.intro}</p>
        <div className="hob-card">
          <p className="hob-v-strong">{c.privacy}</p>
          <p className="hob-help">{lane === 'women'
            ? 'Next, an Aadhaar check with an OTP (or DigiLocker if the OTP does not work). We keep only the last 4 digits of your Aadhaar number.'
            : 'Next, a private choice, then an Aadhaar check with an OTP (or DigiLocker if the OTP does not work). We keep only the last 4 digits of your Aadhaar number, and we do not keep which option you choose.'}</p>
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
        <h1 className="hob-h1">Is this space right for you?</h1>
        <p className="hob-lead">This space is for LGBTQ+ people and allies who want a safer place to talk. Choose what fits you best.</p>
        <fieldset className="hob-field" style={{ border: 0, padding: 0, margin: '0 0 20px' }}>
          <legend className="hob-label">Which fits you best?</legend>
          {[['lgbtq', "I'm LGBTQ+"], ['questioning', "I'm questioning"], ['ally', "I'm an ally who wants this safer space"]].map(([v, label]) => (
            <label key={v} className="hob-card hob-f-consent">
              <input type="radio" name="hf-lane-fit" value={v} checked={fit === v} onChange={() => setFit(v)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <p className="hob-help">This stays private. We do not save which one you pick, only that you chose to join. You can leave the space any time.</p>
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
    ) : <><h1 className="hob-h1">Opening the space for you…</h1><p className="hob-lead" role="status">One moment.</p></>);
  }

  if (step === 'ineligible') {
    return wrap(
      <div>
        <h1 className="hob-h1">This space is not open to this account</h1>
        <p className="hob-lead">The women-only space is open to callers whose Aadhaar shows female or transgender. Thank you for understanding, and for checking.</p>
        <p className="hob-help">Everything else on {BRAND.name} is open to you.</p>
        <p><a className="hob-btn hob-btn-primary hob-v-start" href="/marketplace">Browse all hosts</a></p>
        <p className="hob-v-rules"><a href="/women-only">How the women-only space works</a></p>
      </div>,
    );
  }

  // done
  return wrap(
    <div>
      <span className="hob-v-badge" aria-hidden="true">✓</span>
      <h1 className="hob-h1">{c.doneTitle}</h1>
      <p className="hob-lead">{c.doneBody} Calls are coming soon. We will tell you when they open.</p>
      <p><a className="hob-btn hob-btn-primary hob-v-start" href={`/marketplace?lane=${lane}`}>{c.browse}</a></p>
      <p className="hob-v-rules">
        <button type="button" className="hob-v-link" onClick={async () => {
          if (!window.confirm('Leave this space? You can join again any time.')) return;
          if (await leaveLane(lane)) { setMe(m => (m ? { ...m, lanes: { ...m.lanes, [lane]: { ...m.lanes[lane], granted: false } } } : m)); setAck18(false); setAckRules(false); setFit(''); go('intro'); }
        }}>Leave this space</button>
      </p>
    </div>,
  );
}
