/* [HF-HOST-ONBOARD-1] Host onboarding shell: step routing (?step=), draft state, top bar,
 * sticky action bar, live card preview. Step screens live in ./steps and only talk to StepProps. */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { BRAND } from '../../lib/brand';
import { publicImage } from '../../lib/config';
import { capture } from '../../lib/analytics';
import { EMPTY_DRAFT, GROUP_LABEL, STEPS } from './data';
import { mockApi } from './api';
import { loadDraft, saveDraft } from './storage';
import PreviewCard from './PreviewCard';
import Icon from './Icon';
import type { Avatar, Draft, StepAction, StepGroup, StepKey, StepProps } from './types';

const LAZY: Record<StepKey, React.LazyExoticComponent<ComponentType<StepProps>>> = {
  welcome: lazy(() => import('./steps/WelcomeStep')),
  phone: lazy(() => import('./steps/PhoneStep')),
  kyc: lazy(() => import('./steps/KycStep')),
  aadhaar: lazy(() => import('./steps/AadhaarStep')),
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

const KEYS = STEPS.map(s => s.key);
const DEFAULT_ACTION: StepAction = { label: 'Continue' };
const NO_PREVIEW: StepKey[] = ['welcome', 'generating', 'done'];
const NO_BACK: StepKey[] = ['welcome', 'generating', 'done'];
const BAR_GROUPS: StepGroup[] = ['verify', 'profile', 'voice', 'finish'];

function isComplete(key: StepKey, d: Draft): boolean {
  switch (key) {
    case 'welcome': return true;
    case 'phone': return d.phoneVerified;
    case 'kyc': return d.kycDone;
    case 'aadhaar': return d.aadhaarDone;
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
  const [draft, setDraft] = useState<Draft>(() => loadDraft() ?? EMPTY_DRAFT);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [step, setStep] = useState<StepKey>(() => stepFromUrl(draftRef.current));
  const [action, setAction] = useState<StepAction>(DEFAULT_ACTION);
  const [busy, setBusy] = useState(false);
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [sheet, setSheet] = useState(false);
  const pushed = useRef(0);
  const mainRef = useRef<HTMLDivElement>(null);

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft(prev => { const next = { ...prev, ...patch }; saveDraft(next); return next; });
  }, []);

  // Keep the URL in step with the initial (possibly corrected) step.
  useEffect(() => {
    try { window.history.replaceState({ hob: 1 }, '', `?step=${step}`); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    mockApi.listAvatars().then(a => { if (live) setAvatars(a); }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (pushed.current > 0) pushed.current -= 1;
      setAction(DEFAULT_ACTION);
      setBusy(false);
      setSheet(false);
      setStep(stepFromUrl(draftRef.current));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    track('host_onboarding_step_view', { step });
    try { window.scrollTo(0, 0); mainRef.current?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }, [step]);

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

  const stepProps: StepProps = { draft, update, api: mockApi, setAction, goNext, goTo, avatars };

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
            <p className="hob-notice">Preview — nothing is sent to us yet</p>
            {showPreview && <button type="button" className="hob-seecard" onClick={() => setSheet(true)}><Icon name="user" size={20} />See my card</button>}
          </div>
        </div>
      </header>

      <div className="hob-body hob-wrap">
        <main className="hob-main" ref={mainRef} tabIndex={-1} aria-label={meta.title}>
          <Suspense fallback={<p className="hob-loading" role="status">Loading…</p>}>
            <StepView key={step} {...stepProps} />
          </Suspense>
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
