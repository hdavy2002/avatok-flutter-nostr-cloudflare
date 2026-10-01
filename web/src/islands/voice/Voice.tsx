/* [AUMFE-VOICE-WEB-1] /talk — the voice guides: choose a guide, tell her about you (first time), talk, see the
 * summary. One component, CSS breakpoints (phone < 768px, two columns from 768px). Built to the approved
 * "Aum Fe Voice Agent Call" mockup. Wire protocol: islands/voice/types.ts (copy of worker voice_agents/types.ts).
 *
 * Auth: ClerkIsland provides the single Clerk provider; a signed-out visitor is sent to /sign-in and brought
 * back here (same rule as Dashboard 2). The page is unlisted until launch (noindex, no nav links).
 * Brand name only through BRAND. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/env';
import { signInUrlForHere } from '../../lib/authRedirect';
import { capture, captureException } from '../../lib/analytics';
import { getPhoneStatus, finishUrl } from '../auth/passwordless';
import { BRAND } from '../../lib/brand';
import {
  deleteMemory, errMessage, getAgents, getMemories, getProfile, getSessions, saveConsent, saveProfile,
} from './api';
import { useVoiceCall } from './useVoiceCall';
import type { CallError, VoiceCall } from './useVoiceCall';
import type { AgentSessionRow, AgentsResponse, AstroProfile, MemoryItem, VoiceAgentPublic } from './types';
import './voice.css';

const GUEST_JWT_KEY = 'saathum_guest_jwt';
const DEFAULT_FREE_SECONDS = 180; // spec voiceAgentFreeSeconds default; only used if the agents API omits it
const DEFAULT_PRICE_PAISE = 2000; // spec voiceAgentPricePerMinPaise default; same rule
const RECENT_MS = 30 * 24 * 3600 * 1000;

/* ── small helpers ─────────────────────────────────────────────────────── */

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }

function rupees(paise: number): string {
  const r = paise / 100;
  return `₹${Number.isInteger(r) ? r : r.toFixed(2)}`;
}

function mmss(total: number): string {
  const s = Math.max(0, Math.floor(total));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function minutesLeft(sec: number): string {
  const m = Math.max(0, Math.ceil(sec / 60));
  return `${m} min left`;
}

function minutesText(sec: number): string {
  const m = sec / 60;
  return Number.isInteger(m) ? `${m} minute${m === 1 ? '' : 's'}` : `${Math.round(sec)} seconds`;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function useReducedMotionFlag(): boolean {
  const [v, setV] = useState(prefersReducedMotion);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setV(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return v;
}

function timeAgo(ms: number): string {
  const d = Date.now() - ms;
  const h = d / 3600000;
  if (h < 1) return 'a little while ago';
  if (h < 24) return 'earlier today';
  const days = Math.floor(h / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/* ── guard + names (hooks chosen once per build: with or without a Clerk key) ───────────── */

/** WhatsApp gate — same rule as Dashboard 2 (DashNav.phoneGate): a signed-in account that still owes a verified
 * WhatsApp number finishes sign-up first and comes back here. A failed status read lets the person in
 * (account bootstrap still refuses an unverified phone server-side). */
async function whatsappGate(): Promise<boolean> {
  try {
    const st = await getPhoneStatus();
    if (st.needs_phone) {
      capture('whatsapp_gate_shown', { surface: 'voice' });
      location.replace(finishUrl(location.pathname + location.search));
      return false;
    }
    capture('whatsapp_gate_passed', { surface: 'voice' });
  } catch (err) {
    captureException(err, { where: 'voice_phone_gate' });
  }
  return true;
}

function useGuardClerk(): boolean {
  const { isLoaded, isSignedIn } = useAuth();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!isLoaded) return undefined;
    if (!isSignedIn && !lsGet(GUEST_JWT_KEY)) { location.replace(signInUrlForHere()); return undefined; }
    let cancelled = false;
    void (async () => {
      if (isSignedIn && !(await whatsappGate())) return;
      if (!cancelled) setOk(true);
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn]);
  return ok;
}
function useGuardGuest(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (lsGet(GUEST_JWT_KEY)) setOk(true); else location.replace(signInUrlForHere());
  }, []);
  return ok;
}
const useGuard = CLERK_PUBLISHABLE_KEY ? useGuardClerk : useGuardGuest;

function useClerkFirstName(): string | null {
  const { user } = useUser();
  return user?.firstName ?? null;
}
const useFirstName = CLERK_PUBLISHABLE_KEY ? useClerkFirstName : (): string | null => null;

/* ── pricing read tolerantly from the agents API ───────────────────────── */

interface Pricing { paisePerMin: number; freeSeconds: number }

function pricingFor(data: AgentsResponse | null, agentId?: string): Pricing {
  const a = data?.agents?.find((x) => x.id === agentId);
  return {
    paisePerMin: a?.price_per_min_paise ?? data?.price_per_min_paise ?? DEFAULT_PRICE_PAISE,
    freeSeconds: a?.free_seconds ?? data?.free_seconds ?? DEFAULT_FREE_SECONDS,
  };
}

/* ── shared bits ───────────────────────────────────────────────────────── */

function Avatar({ agent, size }: { agent: Pick<VoiceAgentPublic, 'initial' | 'tint' | 'name'>; size: 'sm' | 'md' | 'lg' | 'xl' }) {
  return (
    <span className={`vc-avatar vc-avatar-${size}`} style={{ background: agent.tint } as CSSProperties} aria-hidden="true">
      {agent.initial}
    </span>
  );
}

function micHelp(kind: CallError['kind']): { title: string; body: string } | null {
  switch (kind) {
    case 'mic_denied':
      return {
        title: 'We could not use your microphone',
        body: 'To talk, your browser needs permission to use the microphone. Tap the lock or settings icon next to the web address, switch Microphone to Allow, then try again.',
      };
    case 'mic_missing':
      return { title: 'No microphone found', body: 'We could not find a microphone on this device. Plug one in or check your headphones, then try again.' };
    case 'mic_unsupported':
      return { title: 'This browser cannot do voice calls', body: 'Please open this page in the latest Chrome, Safari or Edge and try again.' };
    case 'mic_failed':
      return { title: 'The call could not start', body: 'Something went wrong while setting up your microphone. Please close other apps that use it and try again.' };
    default:
      return null;
  }
}

function ErrorNote({ error }: { error: CallError | null }) {
  if (!error) return null;
  const help = micHelp(error.kind);
  const title = help?.title ?? (error.kind === 'closed' ? 'The call did not connect' : 'Something went wrong');
  const body = help?.body ?? (error.message || 'The connection dropped before the call began. Please try again in a moment.');
  return (
    <div className="vc-note vc-note-error" role="alert">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

/* ── 1. Choose your guide ──────────────────────────────────────────────── */

function Guides({ agents, firstName, last, onTalk, error }: {
  agents: AgentsResponse; firstName: string | null; last: { agent: VoiceAgentPublic; session: AgentSessionRow } | null;
  onTalk: (a: VoiceAgentPublic) => void; error: CallError | null;
}) {
  const list = agents.agents ?? [];
  const canUse = agents.can_use !== false;
  return (
    <section className="vc-guides" aria-labelledby="vc-h">
      <p className="vc-eyebrow">{BRAND.name} guides</p>
      <h1 id="vc-h" className="vc-title">Namaste{firstName ? ` ${firstName} ji` : ' ji'}</h1>
      <p className="vc-lede">Choose a guide to talk with. Each one is an AI guide who listens, answers by voice, and remembers you next time.</p>
      <ErrorNote error={error} />
      {!canUse && (
        <div className="vc-note" role="status">
          <strong>Coming soon</strong>
          <p>Our voice guides are almost ready. We will open them to you very soon.</p>
        </div>
      )}
      {canUse && last && (
        <button type="button" className="vc-continue" onClick={() => onTalk(last.agent)}>
          <Avatar agent={last.agent} size="md" />
          <span className="vc-continue-text">
            <span className="vc-continue-title">Continue with {last.agent.name}</span>
            <span className="vc-continue-sub">{last.session.summary ? last.session.summary : `You last talked ${timeAgo(last.session.started_at)}.`}</span>
          </span>
          <span className="vc-continue-go" aria-hidden="true">›</span>
        </button>
      )}
      {list.length === 0 && canUse && <p className="vc-lede">No guides are available right now. Please check back soon.</p>}
      <ul className="vc-cards">
        {list.map((a) => {
          const p = pricingFor(agents, a.id);
          return (
            <li key={a.id} className="vc-card">
              <Avatar agent={a} size="lg" />
              <div className="vc-card-body">
                <h2 className="vc-card-name">{a.name}</h2>
                <p className="vc-card-subject">{a.subject}</p>
                <p className="vc-card-blurb">{a.blurb}</p>
                <p className="vc-card-price">{rupees(p.paisePerMin)}/min</p>
              </div>
              <button type="button" className="vc-btn vc-btn-red" disabled={!canUse} onClick={() => onTalk(a)}>Talk</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ── 2. Before first talk ──────────────────────────────────────────────── */

function Prep({ agent, profile, firstName, pricing, busy, error, onBack, onStart }: {
  agent: VoiceAgentPublic; profile: AstroProfile | null; firstName: string | null; pricing: Pricing; busy: boolean;
  error: CallError | null; onBack: () => void;
  onStart: (v: { name: string; dob: string; tob: string | null; tobUnknown: boolean; place: string; consent: boolean }) => void;
}) {
  const [name, setName] = useState(profile?.name ?? firstName ?? '');
  const [dob, setDob] = useState(profile?.dob ?? '');
  const [tob, setTob] = useState(profile?.tob ?? '');
  const [tobUnknown, setTobUnknown] = useState(!!profile?.tob_unknown);
  const [place, setPlace] = useState(profile?.place ?? '');
  const [consent, setConsent] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setProblem('Please tell us your name.');
    if (!dob) return setProblem('Please add your date of birth.');
    if (!tobUnknown && !tob) return setProblem('Please add your time of birth, or tick “I don’t know my birth time”.');
    if (!place.trim()) return setProblem('Please add your place of birth, for example “Dehradun, India”.');
    setProblem(null);
    onStart({ name: name.trim(), dob, tob: tobUnknown ? null : tob, tobUnknown, place: place.trim(), consent });
  };

  return (
    <section className="vc-prep" aria-labelledby="vc-prep-h">
      <button type="button" className="vc-back" onClick={onBack}>‹ All guides</button>
      <div className="vc-prep-grid">
        <div className="vc-prep-who">
          <Avatar agent={agent} size="xl" />
          <p className="vc-eyebrow">{agent.subject} · AI guide</p>
          <h1 id="vc-prep-h" className="vc-title vc-title-sm">{agent.name} would like to know you</h1>
          <p className="vc-lede">Her answers come from your birth details, so they are about you and not about everyone. You only do this once.</p>
        </div>
        <form className="vc-form" onSubmit={submit} noValidate>
          <label className="vc-field"><span>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" maxLength={80} />
          </label>
          <label className="vc-field"><span>Date of birth</span>
            <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} max={new Date().toISOString().slice(0, 10)} autoComplete="bday" />
          </label>
          <label className="vc-field"><span>Time of birth</span>
            <input type="time" value={tobUnknown ? '' : tob} onChange={(e) => setTob(e.target.value)} disabled={tobUnknown} />
          </label>
          <label className="vc-check">
            <input type="checkbox" checked={tobUnknown} onChange={(e) => setTobUnknown(e.target.checked)} />
            <span>I don’t know my birth time</span>
          </label>
          <label className="vc-field"><span>Place of birth</span>
            <input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="City, state or country" maxLength={120} autoComplete="off" />
          </label>
          <label className="vc-check vc-check-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>Let my guides remember our talks so they know me next time. I can ask them to forget anytime.</span>
          </label>
          {problem && <p className="vc-problem" role="alert">{problem}</p>}
          <ErrorNote error={error} />
          <p className="vc-price-line">First {minutesText(pricing.freeSeconds)} free, then {rupees(pricing.paisePerMin)}/min</p>
          <button type="submit" className="vc-btn vc-btn-red vc-btn-block" disabled={busy}>{busy ? 'Getting ready…' : 'Start talking'}</button>
          <p className="vc-fine">Your browser will ask to use your microphone.</p>
        </form>
      </div>
    </section>
  );
}

/* ── 3. On the call ────────────────────────────────────────────────────── */

const BARS = 23;

function Wave({ call, reduced }: { call: VoiceCall; reduced: boolean }) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(call.agentState);
  stateRef.current = call.agentState;

  useEffect(() => {
    if (reduced) return undefined;
    let raf = 0;
    let smooth = 0;
    const tick = (t: number) => {
      const c = call.clientRef.current;
      const st = stateRef.current;
      const raw = st === 'speaking' ? (c?.outLevel ?? 0) : st === 'listening' ? (c?.micLevel ?? 0) * 0.7 : 0;
      const target = Math.min(1, raw * 5);
      smooth += (target - smooth) * 0.35;
      wrapRef.current?.style.setProperty('--lvl', smooth.toFixed(3));
      for (let i = 0; i < BARS; i++) {
        const el = barsRef.current[i];
        if (!el) continue;
        const env = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2) * 0.7;
        const wob = 0.65 + 0.35 * Math.sin(t / 140 + i * 0.9);
        const idle = st === 'thinking' ? 0.1 + 0.06 * Math.sin(t / 300 + i * 0.5) : 0.1;
        el.style.transform = `scaleY(${Math.max(idle, smooth * env * wob).toFixed(3)})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [call.clientRef, reduced]);

  const label = call.agentState === 'speaking' ? 'speaking' : call.agentState === 'thinking' ? 'thinking' : call.agentState === 'listening' ? 'listening' : 'connecting';
  return (
    <div className={`vc-wavewrap vc-st-${call.agentState}${reduced ? ' vc-still' : ''}`} ref={wrapRef}>
      <div className="vc-rings" aria-hidden="true"><i /><i /><i /></div>
      {call.agent && <Avatar agent={call.agent} size="xl" />}
      <div className="vc-wave" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <span key={i} ref={(el) => { barsRef.current[i] = el; }} style={reduced ? { transform: `scaleY(${call.agentState === 'speaking' ? 0.55 : 0.15})` } : undefined} />
        ))}
      </div>
      <p className="vc-state" aria-live="polite">{stateText(label, call.agent?.name ?? 'She', call.muted)}</p>
    </div>
  );
}

function stateText(s: string, name: string, muted: boolean): string {
  if (s === 'connecting') return 'Connecting…';
  if (muted && s === 'listening') return 'You are muted';
  if (s === 'listening') return 'Listening…';
  if (s === 'thinking') return 'Thinking…';
  return `${name} is speaking`;
}

function CallScreen({ call }: { call: VoiceCall }) {
  const reduced = useReducedMotionFlag();
  const [captionsOn, setCaptionsOn] = useState(true);
  const capRef = useRef<HTMLOListElement | null>(null);
  const agent = call.agent;

  useEffect(() => {
    const el = capRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [call.captions, captionsOn]);

  if (!agent) return null;
  const seconds = call.meter?.seconds ?? call.elapsed;
  const live = call.phase === 'live';
  const cost = call.meter ? rupees(call.meter.costPaise) : '₹0';
  const left = call.meter ? minutesLeft(call.meter.remainingSeconds) : call.ready ? minutesLeft(call.ready.maxSeconds) : '';

  return (
    <section className="vc-call" aria-label={`Call with ${agent.name}`}>
      <div className="vc-stage">
        <header className="vc-call-head">
          <div>
            <h1 className="vc-call-name">{agent.name} · {agent.subject}</h1>
            <p className="vc-call-ai">AI guide</p>
          </div>
          <div className="vc-meter" aria-live="off">
            <span className="vc-timer">{mmss(seconds)}</span>
            {live && <span className="vc-meter-sub">{cost} so far{left ? ` · ${left}` : ''}</span>}
          </div>
        </header>

        {call.endingSoon !== null && (
          <div className="vc-banner" role="status">Our time is almost up — about {Math.max(1, Math.ceil(call.endingSoon / 60))} min left. Let us wrap up gently.</div>
        )}
        {call.error?.kind === 'server' && <div className="vc-banner vc-banner-error" role="alert">{call.error.message}</div>}

        {call.ready && call.ready.remembers.length > 0 && (
          <p className="vc-remembers"><b>Remembers:</b> {call.ready.remembers.join(' · ')}</p>
        )}

        <Wave call={call} reduced={reduced} />

        <div className="vc-controls">
          <button type="button" className={`vc-ctl${call.muted ? ' is-on' : ''}`} onClick={call.toggleMute} aria-pressed={call.muted} disabled={!live}>
            <span className="vc-ctl-ico" aria-hidden="true">{call.muted ? '🔇' : '🎙'}</span>
            <span>{call.muted ? 'Unmute' : 'Mute'}</span>
          </button>
          <button type="button" className="vc-ctl" disabled aria-disabled="true" title="Camera is coming soon">
            <span className="vc-ctl-ico" aria-hidden="true">📷</span>
            <span>Camera</span>
          </button>
          <button type="button" className={`vc-ctl${captionsOn ? ' is-on' : ''}`} onClick={() => setCaptionsOn((v) => !v)} aria-pressed={captionsOn}>
            <span className="vc-ctl-ico" aria-hidden="true">💬</span>
            <span>Captions</span>
          </button>
          <button type="button" className="vc-ctl vc-ctl-end" onClick={call.end} disabled={call.ending}>
            <span className="vc-ctl-ico" aria-hidden="true">✕</span>
            <span>{call.ending ? 'Ending…' : 'End'}</span>
          </button>
        </div>
      </div>

      <aside className="vc-side" aria-label="Notes and captions">
        {call.toolBusy && <p className="vc-toolbusy" role="status">Looking this up for you…</p>}
        {call.cards.map((c, i) => (
          <div className="vc-toolcard" key={`${c.title}-${i}`}>
            <h2>{c.title}</h2>
            <dl>{c.items.map((it) => (<div key={it.label}><dt>{it.label}</dt><dd>{it.value}</dd></div>))}</dl>
          </div>
        ))}
        {captionsOn ? (
          <ol className="vc-captions" ref={capRef} aria-label="Live captions">
            {call.captions.length === 0 && <li className="vc-cap-empty">Captions will appear here as you talk.</li>}
            {call.captions.map((c) => (
              <li key={c.id} className={`vc-cap vc-cap-${c.who}${c.final ? '' : ' is-live'}`}>
                <span className="vc-cap-who">{c.who === 'agent' ? agent.name : 'You'}</span>
                <span>{c.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="vc-cap-empty">Captions are off.</p>
        )}
      </aside>
    </section>
  );
}

/* ── 4. After the call ─────────────────────────────────────────────────── */

function After({ call, onAgain, onBack }: { call: VoiceCall; onAgain: () => void; onBack: () => void }) {
  const agent = call.agent;
  const s = call.summary;
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [showMem, setShowMem] = useState(false);
  const [memErr, setMemErr] = useState<string | null>(null);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  // The real summary is written a little after the call ends: look a few times.
  useEffect(() => {
    if (!s?.sessionId) { setGaveUp(true); return undefined; }
    let cancelled = false;
    let tries = 0;
    const look = async () => {
      tries += 1;
      try {
        const rows = await getSessions();
        const row = rows.find((r) => r.id === s.sessionId);
        if (!cancelled && row?.summary) { setSummaryText(row.summary); return; }
      } catch (e) { captureException(e, { where: 'voice_summary_poll' }); }
      if (cancelled) return;
      if (tries >= 5) setGaveUp(true); else timer = window.setTimeout(() => void look(), 4000);
    };
    let timer = window.setTimeout(() => void look(), 2500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [s?.sessionId]);

  const loadMemories = useCallback(async () => {
    try { setMemories(await getMemories()); setMemErr(null); }
    catch (e) { setMemErr(errMessage(e, 'We could not load your memories just now.')); }
  }, []);

  const toggleMem = () => {
    const next = !showMem;
    setShowMem(next);
    if (next && memories === null) void loadMemories();
  };

  const forget = async (id: string) => {
    const before = memories;
    setMemories((m) => (m ? m.filter((x) => x.id !== id) : m));
    try { await deleteMemory(id); }
    catch (e) { setMemories(before); setMemErr(errMessage(e, 'We could not remove that just now.')); }
  };

  if (!agent || !s) return null;
  const remembers = s.remembers;

  return (
    <section className="vc-after" aria-labelledby="vc-after-h">
      <div className="vc-after-card">
        <Avatar agent={agent} size="lg" />
        <h1 id="vc-after-h" className="vc-title vc-title-sm">Thank you for talking with {agent.name}</h1>
        <dl className="vc-facts">
          <div><dt>Time</dt><dd>{mmss(s.seconds)}</dd></div>
          <div><dt>Cost</dt><dd>{s.billing === 'test' ? 'Test call — no charge' : rupees(s.costPaise)}</dd></div>
        </dl>
        <div className="vc-summary">
          <h2>Your summary</h2>
          {summaryText ? <p>{summaryText}</p> : <p className="vc-muted">{gaveUp ? 'Your summary is still being written. You will find it here the next time you visit.' : 'Your summary will appear here shortly…'}</p>}
        </div>
        <div className="vc-memory">
          <h2>{agent.name} will remember</h2>
          <p>{remembers.length ? remembers.join(' · ') : 'The things you told her today, so she knows you next time.'}</p>
          <button type="button" className="vc-link" onClick={toggleMem} aria-expanded={showMem}>{showMem ? 'Hide what is remembered' : 'See or remove what is remembered'}</button>
          {showMem && (
            <div className="vc-memlist">
              {memErr && <p className="vc-problem" role="alert">{memErr}</p>}
              {memories === null && !memErr && <p className="vc-muted">Loading…</p>}
              {memories && memories.length === 0 && <p className="vc-muted">Nothing is remembered right now.</p>}
              {memories && memories.length > 0 && (
                <ul>
                  {memories.map((m) => (
                    <li key={m.id}>
                      <span>{m.text}</span>
                      <button type="button" className="vc-mini" onClick={() => void forget(m.id)} aria-label={`Remove: ${m.text}`}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="vc-after-actions">
          <button type="button" className="vc-btn vc-btn-red" onClick={onAgain}>Talk again</button>
          <button type="button" className="vc-btn vc-btn-ghost" onClick={onBack}>Back to guides</button>
        </div>
      </div>
    </section>
  );
}

/* ── the page ──────────────────────────────────────────────────────────── */

type Step = 'guides' | 'prep';

function Talk() {
  const firstClerk = useFirstName();
  const call = useVoiceCall();
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [profile, setProfile] = useState<AstroProfile | null>(null);
  const [sessions, setSessions] = useState<AgentSessionRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('guides');
  const [picked, setPicked] = useState<VoiceAgentPublic | null>(null);
  const [starting, setStarting] = useState(false);
  const deepLinked = useRef(false);

  const firstName = useMemo(() => {
    const p = profile?.name?.trim().split(/\s+/)[0];
    return firstClerk || p || null;
  }, [firstClerk, profile?.name]);

  const loadAll = useCallback(async () => {
    setLoadErr(null);
    try {
      const [a, p, s] = await Promise.all([
        getAgents(),
        getProfile().catch(() => null),
        getSessions().catch(() => [] as AgentSessionRow[]),
      ]);
      setAgents(a); setProfile(p); setSessions(s);
    } catch (e) {
      captureException(e, { where: 'voice_load' });
      setLoadErr(errMessage(e, 'We could not load the guides just now. Please try again.'));
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const needsPrep = !profile || !profile.dob || profile.consent_at == null;

  const begin = useCallback(async (agent: VoiceAgentPublic, pre?: () => Promise<void>) => {
    setStarting(true);
    await call.start(agent, pre);
    setStarting(false);
  }, [call]);

  const onTalk = useCallback((a: VoiceAgentPublic) => {
    setPicked(a);
    if (needsPrep) { setStep('prep'); return; }
    void begin(a);
  }, [begin, needsPrep]);

  // /talk?guide=astrology jumps straight to that guide
  useEffect(() => {
    if (deepLinked.current || !agents?.agents) return;
    deepLinked.current = true;
    const want = new URLSearchParams(location.search).get('guide');
    const a = want ? agents.agents.find((x) => x.id === want) : null;
    if (a && agents.can_use !== false) { setPicked(a); setStep(needsPrep ? 'prep' : 'guides'); }
  }, [agents, needsPrep]);

  const afterCall = useCallback(() => {
    call.reset();
    setStep('guides');
    void loadAll(); // fresh "Continue with ..." card and the consent the person just chose
  }, [call, loadAll]);

  const talkAgain = useCallback(() => {
    const a = call.agent;
    call.reset();
    if (a) void begin(a);
  }, [begin, call]);

  const last = useMemo(() => {
    if (!agents?.agents) return null;
    const row = sessions.find((s) => s.channel === 'voice' && s.ended_at != null && Date.now() - s.started_at < RECENT_MS);
    const ag = row ? agents.agents.find((x) => x.id === row.agent) : undefined;
    return row && ag ? { agent: ag, session: row } : null;
  }, [agents, sessions]);

  let body: ReactNode;
  if (call.phase === 'connecting' || call.phase === 'live') {
    body = <CallScreen call={call} />;
  } else if (call.phase === 'ended') {
    body = <After call={call} onAgain={talkAgain} onBack={afterCall} />;
  } else if (loadErr) {
    body = (
      <section className="vc-guides">
        <div className="vc-note vc-note-error" role="alert"><strong>Something went wrong</strong><p>{loadErr}</p></div>
        <button type="button" className="vc-btn vc-btn-red" onClick={() => void loadAll()}>Try again</button>
      </section>
    );
  } else if (!agents) {
    body = <section className="vc-guides" aria-busy="true"><p className="vc-lede">Opening your guides…</p></section>;
  } else if (step === 'prep' && picked) {
    body = (
      <Prep
        agent={picked} profile={profile} firstName={firstName} pricing={pricingFor(agents, picked.id)} busy={starting}
        error={call.error} onBack={() => { setStep('guides'); }}
        onStart={(v) => void begin(picked, async () => {
          await saveProfile({ name: v.name, dob: v.dob, tob: v.tob, tob_unknown: v.tobUnknown, place: v.place });
          const r = await saveConsent(v.consent);
          setProfile(r.profile);
        })}
      />
    );
  } else {
    body = <Guides agents={agents} firstName={firstName} last={last} onTalk={onTalk} error={call.error} />;
  }

  return <div className={`vc vc-phase-${call.phase === 'idle' ? 'idle' : call.phase}`}>{body}</div>;
}

function Gate() {
  const ok = useGuard();
  if (!ok) return <div className="vc"><section className="vc-guides" aria-busy="true"><p className="vc-lede">Opening your guides…</p></section></div>;
  return <Talk />;
}

export default function VoiceApp() {
  return (
    <IslandBoundary island="voice">
      <ClerkIsland>
        <Gate />
      </ClerkIsland>
    </IslandBoundary>
  );
}
