/* [HF-HOST-ONBOARD-1] Host onboarding shell: step routing (?step=), draft state, top bar,
 * sticky action bar, live card preview. Step screens live in ./steps and only talk to StepProps. */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { BRAND } from '../../lib/brand';
import { publicImage } from '../../lib/config';
import { capture } from '../../lib/analytics';
import { EMPTY_DRAFT, GROUP_LABEL, STEPS } from './data';
import { mockApi } from './api';
import { realApi } from './api_real';
import { request } from '../../lib/apiClient';
import { loadDraft, saveDraft } from './storage';
import PreviewCard from './PreviewCard';
import Icon from './Icon';
import type { Avatar, Draft, OnboardingApi, StepAction, StepGroup, StepKey, StepProps } from './types';

const LAZY: Record<StepKey, React.LazyExoticComponent<ComponentType<StepProps>>> = {
  welcome: lazy(() => import('./steps/WelcomeStep')),
  phone: lazy(() => import('./steps/PhoneStep')),
  aadhaar: lazy(() => import('./steps/AadhaarStep')),
  selfie: lazy(() => import('./steps/SelfieStep')),
  payout: lazy(() => import('./steps/PayoutStep')),
  avatar: lazy(() => import('./steps/AvatarStep')),
  about: lazy(() => import('./steps/AboutStep')),
  languages: lazy(() => import('./steps/LanguagesStep')),
  topics: lazy(() => import('./steps/TopicsStep')),
  price: lazy(() => import('./steps/PriceStep')),
  hours: lazy(() => import('./steps/HoursStep')),
  voice: lazy(() => import('./steps/VoiceStep')),
  review: lazy(() => import('./steps/ReviewStep')),
  generating: lazy(() => import('./steps/GeneratingStep')),
  preview: lazy(() => import('./steps/PreviewStep')),
  done: lazy(() => import('./steps/DoneStep')),
};

// Real mode needs the Clerk session; load it only then (the mock preview stays light).
const LazyClerkBridge = lazy(() => import('../../lib/clerk').then(m => ({ default: m.ClerkSessionBridge })));

type Phase = 'boot' | 'auth' | 'gate' | 'error' | 'ready';
const SIGN_IN_URL = `/sign-in?redirect_url=${encodeURIComponent('/hosts/onboarding')}`;

/** Real mode only when the worker says both flags are on (cache-busted) and the URL does not ask for ?mock=1. */
async function pickApi(): Promise<OnboardingApi> {
  try { if (new URLSearchParams(window.location.search).get('mock') === '1') return mockApi; } catch { /* ignore */ }
  try {
    const cfg = await request<{ hostOnboardingEnabled?: boolean; hostKycEnabled?: boolean }>('/api/config', { query: { _: Date.now() }, timeoutMs: 8000 });
    return cfg && cfg.hostOnboardingEnabled === true && cfg.hostKycEnabled === true ? realApi : mockApi;
  } catch { return mockApi; }
}

const KEYS = STEPS.map(s => s.key);
const DEFAULT_ACTION: StepAction = { label: 'Continue' };
const NO_PREVIEW: StepKey[] = ['welcome', 'generating', 'done'];
const NO_BACK: StepKey[] = ['welcome', 'generating', 'done'];
const BAR_GROUPS: StepGroup[] = ['verify', 'profile', 'voice', 'finish'];

function isComplete(key: StepKey, d: Draft): boolean {
  switch (key) {
    case 'welcome': return true;
    case 'phone': return d.phoneVerified;
    case 'aadhaar': return d.aadhaarDone;
    case 'selfie': return d.selfie.recorded && d.selfie.consent;
    case 'payout': return d.payout.verified;
    case 'avatar': return !!d.avatarId;
    case 'about': return !!d.displayName.trim() && d.about.trim().length >= 40;
    case 'languages': return d.languages.length > 0 && !!d.style;
    case 'topics': return d.topics.length >= 1;
    case 'price': return true;
    case 'hours': return true;
    case 'voice': return d.voice.recorded && d.voice.consent;
    case 'review': return d.agreements.rules && d.agreements.agreement && d.agreements.welfare;
    case 'generating': return !!d.generated;
    case 'preview': return d.submitted;
    case 'done': return false;
  }
}

/** Index of the furthest step the draft allows (first incomplete one). */
function maxAllowed(d: Draft): number {
  for (let i = 0; i < KEYS.length; i++) if (!isComplete(KEYS[i], d)) return i;
  return KEYS.length - 1;
}

function stepFromUrl(d: Draft): StepKey {
  let key: StepKey = 'welcome';
  try {
    const q = new URLSearchParams(window.location.search).get('step');
    if (q && (KEYS as string[]).includes(q)) key = q as StepKey;
  } catch { /* ignore */ }
  const i = Math.min(KEYS.indexOf(key), maxAllowed(d));
  return KEYS[i];
}

const track = (event: string, props: Record<string, unknown>) => { try { capture(event, props as never); } catch { /* telemetry must never break the flow */ } };

export default function HostOnboarding() {
  const [api, setApi] = useState<OnboardingApi>(mockApi);
  const [phase, setPhase] = useState<Phase>('boot');
  const [loadError, setLoadError] = useState('');
  const [tryNo, setTryNo] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const touched = useRef(false);
  const [step, setStep] = useState<StepKey>('welcome');
  const [action, setAction] = useState<StepAction>(DEFAULT_ACTION);
  const [busy, setBusy] = useState(false);
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [sheet, setSheet] = useState(false);
  const pushed = useRef(0);
  const mainRef = useRef<HTMLDivElement>(null);

  const apiRef = useRef(api);
  apiRef.current = api;
  const update = useCallback((patch: Partial<Draft>) => {
    touched.current = true;
    setDraft(prev => { const next = { ...prev, ...patch }; if (apiRef.current.mode === 'mock') saveDraft(next); return next; });
  }, []);

  const finishBoot = useCallback((d: Draft) => {
    setDraft(d);
    draftRef.current = d;
    const k = stepFromUrl(d);
    setStep(k);
    try { window.history.replaceState({ hob: 1 }, '', `?step=${k}`); } catch { /* ignore */ }
    setPhase('ready');
  }, []);

  // 1) Decide mock or real.
  useEffect(() => {
    let live = true;
    void pickApi().then(chosen => {
      if (!live) return;
      setApi(chosen);
      apiRef.current = chosen;
      if (chosen.mode === 'mock') finishBoot(loadDraft() ?? EMPTY_DRAFT);
      else setPhase('auth');
    });
    return () => { live = false; };
  }, [finishBoot]);

  // 2) Real mode: sign-in check, then the server's copy of the draft wins over anything stored locally.
  useEffect(() => {
    if (phase !== 'auth') return;
    let live = true;
    (async () => {
      try {
        // [HF-ONBOARD-GATE-1] The head script already knows when nobody is signed in: show the gate at once
        // instead of waiting up to 10 s for a Clerk token that will never come.
        if (document.documentElement.getAttribute('data-site-auth') === 'out') { setPhase('gate'); return; }
        const { getActiveTokenWaited } = await import('../../lib/clerk');
        const t = await getActiveTokenWaited(10000);
        if (!live) return;
        if (!t) { setPhase('gate'); return; }
        const server = await realApi.loadServerDraft();
        if (!live || !server) return;
        finishBoot({
          ...EMPTY_DRAFT,
          ...server.draft,
          hours: { ...EMPTY_DRAFT.hours, ...(server.draft.hours || {}) },
          selfie: { ...EMPTY_DRAFT.selfie, ...(server.draft.selfie || {}) },
          payout: { ...EMPTY_DRAFT.payout, ...(server.draft.payout || {}) },
          voice: { ...EMPTY_DRAFT.voice, ...(server.draft.voice || {}) },
          agreements: { ...EMPTY_DRAFT.agreements, ...(server.draft.agreements || {}) },
        });
      } catch (e) {
        if (!live) return;
        setLoadError(e instanceof Error && e.message ? e.message : 'We could not load your details.');
        setPhase('error');
      }
    })();
    return () => { live = false; };
  }, [phase, tryNo, finishBoot]);

  // Real mode autosave of profile fields (debounced inside the client).
  useEffect(() => {
    if (phase !== 'ready' || api.mode !== 'real' || !touched.current) return;
    api.saveServerDraft(draft, setErrors);
  }, [draft, phase, api]);

  useEffect(() => {
    if (phase !== 'ready') return;
    let live = true;
    api.listAvatars().then(a => { if (live) setAvatars(a); }).catch(() => {});
    return () => { live = false; };
  }, [phase, api]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const onPop = () => {
      if (pushed.current > 0) pushed.current -= 1;
      setAction(DEFAULT_ACTION);
      setBusy(false);
      setSheet(false);
      setStep(stepFromUrl(draftRef.current));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'ready') return;
    track('host_onboarding_step_view', { step });
    try { window.scrollTo(0, 0); mainRef.current?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }, [step, phase]);

  const stepRef = useRef(step);
  stepRef.current = step;

  const goTo = useCallback((key: StepKey) => {
    setAction(DEFAULT_ACTION);
    setSheet(false);
    try { window.history.pushState({ hob: 1 }, '', `?step=${key}`); pushed.current += 1; } catch { /* ignore */ }
    setStep(key);
  }, []);

  const goNext = useCallback(() => {
    const cur = stepRef.current;
    track('host_onboarding_step_done', { step: cur });
    const i = KEYS.indexOf(cur);
    if (i < KEYS.length - 1) goTo(KEYS[i + 1]);
  }, [goTo]);

  const goBack = useCallback(() => {
    if (pushed.current > 0) { window.history.back(); return; }
    const i = KEYS.indexOf(stepRef.current);
    if (i <= 0) return;
    setAction(DEFAULT_ACTION);
    try { window.history.replaceState({ hob: 1 }, '', `?step=${KEYS[i - 1]}`); } catch { /* ignore */ }
    setStep(KEYS[i - 1]);
  }, []);

  const onPrimary = async () => {
    if (busy || action.disabled) return;
    setBusy(true);
    let ok = true;
    try { ok = action.run ? await action.run() : true; } catch { ok = false; }
    setBusy(false);
    if (ok) goNext();
  };

  // Close the phone preview sheet with Escape.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheet(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  const index = KEYS.indexOf(step);
  const meta = STEPS[index];
  const avatar = useMemo(() => avatars.find(a => a.id === draft.avatarId) ?? null, [avatars, draft.avatarId]);
  const showPreview = !NO_PREVIEW.includes(step);
  const showBack = !NO_BACK.includes(step) && index > 0;
  const curGroup = BAR_GROUPS.indexOf(meta.group);
  const StepView = LAZY[step];

  const stepProps: StepProps = { draft, update, api, setAction, goNext, goTo, avatars, errors };
  const otherErrors = Object.entries(errors).filter(([k]) => !(step === 'about' && (k === 'displayName' || k === 'about')));

  if (phase !== 'ready') {
    return (
      <div className="hob">
        <div className="hob-body hob-wrap">
          <main className="hob-main" aria-label="Become a host">
            {phase === 'auth' && <Suspense fallback={null}><LazyClerkBridge /></Suspense>}
            {phase === 'gate' ? (
              <div className="hob-v-welcome">
                <p className="hob-v-eyebrow">{BRAND.name} hosts</p>
                <h1 className="hob-h1">Sign in with your WhatsApp number to start</h1>
                <p className="hob-lead">We check your WhatsApp number first. It is the number your calls will come to, and we never show it to anyone.</p>
                <a className="hob-btn hob-btn-primary hob-v-start" href={SIGN_IN_URL}>Sign in to start</a>
                <p className="hob-v-rules"><a href="/hosts/join">Back to host info</a></p>
              </div>
            ) : phase === 'error' ? (
              <div>
                <h1 className="hob-h1">We could not open your details</h1>
                <p className="hob-error" role="alert">{loadError}</p>
                <button type="button" className="hob-btn hob-btn-primary" onClick={() => { setLoadError(''); setPhase('auth'); setTryNo(n => n + 1); }}>Try again</button>
              </div>
            ) : (
              <p className="hob-loading" role="status">Loading…</p>
            )}
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className={`hob${showPreview ? ' hob-has-preview' : ''}`}>
      <header className="hob-top">
        <div className="hob-wrap">
          <div className="hob-top-row">
            <a className="hob-brand" href="/"><img src={publicImage('/assets/branding/friendship-wordmark.png', { width: 640, fit: 'scale-down' })} alt={BRAND.name} height={40} /></a>
            <p className="hob-stepcount">Step {index + 1} of {KEYS.length}</p>
            <a className="hob-exit" href="/hosts/join">Exit</a>
          </div>
          <ol className="hob-progress" aria-label="Progress">
            {BAR_GROUPS.map((g, i) => (
              <li key={g} className={i < curGroup ? 'is-done' : i === curGroup ? 'is-current' : ''} aria-current={i === curGroup ? 'step' : undefined}>
                <span className="hob-seg" aria-hidden="true" />
                <span className="hob-seg-label">{GROUP_LABEL[g]}</span>
              </li>
            ))}
          </ol>
          <div className="hob-notice-row">
            {api.mode === 'mock' ? <p className="hob-notice">Preview — nothing is sent to us yet</p> : <p className="hob-notice" />}
            {showPreview && <button type="button" className="hob-seecard" onClick={() => setSheet(true)}><Icon name="user" size={20} />See my card</button>}
          </div>
        </div>
      </header>

      <div className="hob-body hob-wrap">
        <main className="hob-main" ref={mainRef} tabIndex={-1} aria-label={meta.title}>
          <Suspense fallback={<p className="hob-loading" role="status">Loading…</p>}>
            <StepView key={step} {...stepProps} />
          </Suspense>
          {otherErrors.length > 0 && (
            <div className="hob-card" role="alert" aria-live="polite">
              {otherErrors.map(([k, m]) => <p key={k} className="hob-error">{m}</p>)}
            </div>
          )}
        </main>
        {showPreview && (
          <aside className="hob-aside" aria-label="Card preview">
            <p className="hob-aside-title">Your card, as callers will see it</p>
            <PreviewCard draft={draft} avatar={avatar} />
          </aside>
        )}
      </div>

      {!action.hidden && (
        <div className="hob-bar">
          <div className="hob-wrap hob-bar-row">
            {showBack && <button type="button" className="hob-btn hob-btn-ghost hob-back" onClick={goBack} disabled={busy}><Icon name="arrowLeft" size={20} />Back</button>}
            <button type="button" className="hob-btn hob-btn-primary hob-next" onClick={onPrimary} disabled={!!action.disabled || busy} aria-busy={busy}>
              {busy ? <><span className="hob-spin" aria-hidden="true" />Please wait…</> : action.label}
            </button>
          </div>
        </div>
      )}

      {sheet && showPreview && (
        <div className="hob-sheet-wrap">
          <div className="hob-sheet-backdrop" onClick={() => setSheet(false)} />
          <div className="hob-sheet" role="dialog" aria-modal="true" aria-label="Your card preview">
            <div className="hob-sheet-head">
              <strong>Your card</strong>
              <button type="button" className="hob-sheet-close" onClick={() => setSheet(false)} aria-label="Close preview"><Icon name="x" size={22} /></button>
            </div>
            <PreviewCard draft={draft} avatar={avatar} />
          </div>
        </div>
      )}
    </div>
  );
}
