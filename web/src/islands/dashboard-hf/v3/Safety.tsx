/* [HF-CALL-SAFETY-WEB] Safety: strikes, appeals, the paused state and the one-time call-rules gate.
 * Artboards: WebHostSafety (this page), AppPaused (paused), AppRules (rules gate). Contract: GET /api/hf/safety/me,
 * POST /api/hf/safety/strikes/:id/appeal, POST /api/hf/safety/rules/accept. Calls are recorded; the page only ever shows the person's OWN words.
 * Also exports: useSafetyMe (menu count), RulesGate + SafetyHomeCard (host dashboard home). */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { capture } from '../../../lib/analytics';
import { BRAND } from '../../../lib/brand';
import { toMs } from '../../../lib/hfCallsApi';
import {
  CALL_RULES_HREF, REASON_TITLE, SAFETY_EVENTS, acceptCallRules, appealStrike, getSafetyMe, rupees, safetyDay,
  type SafetyMe, type SafetyStrike,
} from '../../../lib/hfSafetyApi';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { Dialog, Failed, Hibiscus, Marigold, Skel, useToast } from './ui';
import '../../../styles/hf-safety.css';

/* ── shared snapshot of GET /api/hf/safety/me (menu badge + home card share one request) ───────── */
interface Snap { me: SafetyMe | null; failed: boolean; loaded: boolean }
const FRESH: Snap = { me: null, failed: false, loaded: false };
let snap: Snap = FRESH;
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());
export function loadSafety(force = false): Promise<void> {
  if (inflight && !force) return inflight;
  const p: Promise<void> = getSafetyMe()
    .then(r => { snap = r.ok ? { me: r.data, failed: false, loaded: true } : { me: null, failed: true, loaded: true }; })
    .catch(() => { snap = { me: null, failed: true, loaded: true }; })
    .finally(() => { if (inflight === p) inflight = null; emit(); });
  inflight = p;
  return p;
}
if (typeof window !== 'undefined') {
  window.addEventListener('site:active-session-changed', () => { snap = FRESH; if (subs.size) void loadSafety(true); });
}
export function useSafetyMe() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick(n => n + 1);
    subs.add(f);
    if (!snap.loaded) void loadSafety();
    return () => { subs.delete(f); };
  }, []);
  return { me: snap.me, failed: snap.failed, loaded: snap.loaded, reload: () => loadSafety(true) };
}

export const activeOf = (me: SafetyMe) => me.strikes.filter(s => !s.removedAt && (toMs(s.expiresAt) ?? Infinity) > Date.now());
const ended = (s: SafetyStrike) => !!s.removedAt || (toMs(s.expiresAt) ?? Infinity) <= Date.now();
const titleOf = (s: SafetyStrike) => s.reasonText || REASON_TITLE[s.reason] || 'Strike';
export const rulesNeeded = (me: SafetyMe | null) => !!me && me.recordingEnabled && !me.rulesAccepted;

/* ── the call-rules gate (artboard AppRules) ─────────────────────────────────────────────────── */
const Ico = ({ bg, stroke, children, fill }: { bg: string; stroke?: string; fill?: string; children: ReactNode }) => (
  <span className="hsf-ico" style={{ background: bg }}><svg width="22" height="22" viewBox="0 0 24 24" fill={fill ?? 'none'} stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg></span>
);
export function RulesGate({ me, onAccepted, accept = acceptCallRules }: { me: SafetyMe; onAccepted?: () => void; accept?: typeof acceptCallRules }) {
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { capture(SAFETY_EVENTS.rulesView, { version: me.rulesVersion }); }, [me.rulesVersion]);
  const go = async () => {
    if (!agree || busy) return;
    setBusy(true); setErr('');
    const r = await accept(me.rulesVersion);
    setBusy(false);
    if (r.ok) { capture(SAFETY_EVENTS.rulesAccepted, { version: me.rulesVersion }); void loadSafety(true); onAccepted?.(); return; }
    capture(SAFETY_EVENTS.rulesFailed, { status: r.status, code: r.code });
    setErr(r.message || 'We could not save that. Please check your internet and try again.');
  };
  return (
    <section className="hsf hsf-rules" id="rules" aria-labelledby="hsf-rules-t">
      <span className="ghost" aria-hidden="true">NIYAM</span>
      <span className="fl" aria-hidden="true"><Marigold size={74} /></span>
      <div>
        <div className="hsf-kick">Before you go live</div>
        <h2 id="hsf-rules-t">Our call rules</h2>
        <p className="lede" style={{ marginTop: 6 }}>Calls are recorded for safety. Nobody listens live.</p>
      </div>
      <div className="hsf-list">
        <div className="hsf-li"><Ico bg="#FFE6EF" stroke="#D81B72"><path d="M6 7h12l-1 13H7z" /><path d="M9 7a3 3 0 0 1 6 0" /><path d="M4 4l16 16" /></Ico><div><b>Don’t sell</b><span className="s">Sell merch in the {BRAND.name} Shop</span></div></div>
        <div className="hsf-li"><Ico bg="#FFF1D6" stroke="#B45309"><path d="M7 5h10M7 9h10M9 5c4 0 4 8 0 8H7l7 7" /></Ico><div><b>No outside payment</b><span className="s">No UPI, GPay or cash outside the app</span></div></div>
        <div className="hsf-li"><Ico bg="#E3F6F6" stroke="#0E7C86"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></Ico><div><b>No contact sharing</b><span className="s">No numbers, IDs or addresses</span></div></div>
        <div className="hsf-li"><Ico bg="#F1EBFF" fill="#6D4FD0"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" /></Ico><div><b>Be respectful</b><span className="s">No abuse, threats or sexual talk</span></div></div>
      </div>
      <div className="hsf-warn">Breaking a rule gives a strike. <b style={{ fontWeight: 900 }}>{me.strikesToPause} strikes pause your account</b> until a person checks it.</div>
      <label className="hsf-check" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /><span className="bx" aria-hidden="true">{agree ? '✓' : ''}</span>
        <span>I agree to the call rules and the Influencer Agreement, and that my calls are recorded and checked. <a className="hsf-link" href={CALL_RULES_HREF} target="_blank" rel="noopener noreferrer">Read the call rules</a></span>
      </label>
      {err && <div className="hsf-err" role="alert">{err}</div>}
      <button type="button" className="hsf-btn wide" disabled={!agree || busy} onClick={() => void go()}>{busy ? 'Saving…' : 'I agree · continue'}</button>
    </section>
  );
}

/* ── small card on the host dashboard home ───────────────────────────────────────────────────── */
export function SafetyHomeCard({ me }: { me: SafetyMe }) {
  const n = activeOf(me).length;
  const tone = me.status !== 'active' ? 'rani' : n > 0 ? 'gold' : 'lav';
  const line = me.status === 'banned' ? 'This account is closed.'
    : me.status === 'paused' ? 'Your account is paused while a person checks your calls.'
    : n === 0 ? 'No strikes. Keep calls friendly, and sell only in the Shop.'
    : `${me.strikesToPause - n} more ${me.strikesToPause - n === 1 ? 'strike pauses' : 'strikes pause'} your account.`;
  return (
    <section className="h3-card hsf" aria-label="Your safety standing" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2><Marigold size={20} tone={1} />Your safety</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className={`hsf-chip ${tone}`}>{me.status === 'paused' ? 'Paused' : me.status === 'banned' ? 'Closed' : `${n} of ${me.strikesToPause} strikes`}</span>
        {me.status === 'active' && n === 0 && <span className="hsf-chip tea">All clear</span>}
      </div>
      <p className="small muted">{line}</p>
      <a className="h3-link" href="/dashboard/host/safety" onClick={() => capture('hf_safety_home_card_click', { strikes: n, status: me.status })}>Open Safety →</a>
    </section>
  );
}

/* ── hero ────────────────────────────────────────────────────────────────────────────────────── */
function Hero({ me }: { me: SafetyMe }) {
  const act = activeOf(me);
  const plum = me.status !== 'active';
  const oldest = act.map(s => toMs(s.expiresAt) ?? 0).filter(Boolean).sort((a, b) => a - b)[0];
  const left = Math.max(0, me.strikesToPause - act.length);
  const reply = toMs(me.reviewDueAt);
  let kick = 'Your safety', title: ReactNode, text: ReactNode, ghost = 'SURAKSHA';
  if (me.status === 'banned') {
    kick = 'Account closed'; title = 'This account is closed'; ghost = 'BAND';
    text = 'A person checked your calls and closed this account. If you think this is a mistake, write to support.';
  } else if (me.status === 'paused') {
    kick = 'Account paused'; title = 'We’re checking your calls'; ghost = 'RUKO';
    text = <>You have {act.length} active strike{act.length === 1 ? '' : 's'}. A person will reply on WhatsApp{reply ? <> by <b>{safetyDay(reply)}</b></> : ' soon'}.</>;
  } else {
    title = `${act.length} of ${me.strikesToPause} strikes`;
    text = act.length === 0
      ? <>You’re in good standing. Keep calls friendly, and sell only in the {BRAND.name} Shop.</>
      : <>{left === 1 ? 'One more strike pauses' : `${left} more strikes pause`} your account until a person checks it.{oldest ? <> Your oldest strike ends on <b>{safetyDay(oldest)}</b>.</> : null}</>;
  }
  return (
    <header className={`hsf-hero${plum ? ' plum' : ''}`} role={me.status === 'paused' ? 'status' : undefined}>
      <div className="glow1" /><div className="glow2" />
      <div className="ghost" aria-hidden="true">{ghost}</div>
      <span className="f1" aria-hidden="true"><Marigold size={92} /></span>
      <span className="f2" aria-hidden="true"><Marigold size={48} tone={1} /></span>
      <div className="tx">
        <div className="hsf-kick">{kick}</div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
    </header>
  );
}

/* ── paused: what is off, what still works, the held money (artboard AppPaused) ──────────────── */
function PausedPanel({ me, isHost }: { me: SafetyMe; isHost: boolean }) {
  return (
    <>
      <div className="hsf-pair">
        <div className="hsf-card" style={{ background: 'linear-gradient(135deg,#fff 35%,#FFE6EF)', borderColor: '#F8D3E2' }}>
          <div className="ttl" style={{ fontSize: 17, marginBottom: 6 }}><Marigold size={19} />Off for now</div>
          <div className="it">{isHost ? <>Calls<br />Queue<br />New bookings<br />Your reel</> : <>Calls<br />New bookings</>}</div>
        </div>
        <div className="hsf-card" style={{ background: 'linear-gradient(135deg,#fff 35%,#E3F6F6)', borderColor: '#CFE9EB' }}>
          <div className="ttl" style={{ fontSize: 17, marginBottom: 6 }}><Marigold size={19} tone={1} />Still works</div>
          <div className="it">{isHost ? <>Log in<br />Call history<br />Your strikes<br />Earnings</> : <>Log in<br />Call history<br />Your strikes<br />Withdraw your wallet</>}</div>
        </div>
      </div>
      {isHost && me.heldPaise > 0 && (
        <div className="hsf-slip">
          <div className="zig" /><span className="pu l" aria-hidden="true" /><span className="pu r" aria-hidden="true" />
          <div className="in">
            <div className="l"><span>Earnings held</span><b>{rupees(me.heldPaise)}</b></div>
            <div className="hsf-muted" style={{ lineHeight: 1.45 }}>Held during the review. Your bookings were cancelled and fans got a full refund.</div>
          </div>
        </div>
      )}
      <div className="hsf-acts">
        <a className="hsf-btn" href="#strikes">See my strikes</a>
        <a className="hsf-btn ghost" href="/dashboard/support">Contact support</a>
      </div>
    </>
  );
}

/* ── one strike ──────────────────────────────────────────────────────────────────────────────── */
function StrikeCard({ s, i, due, onAppeal }: { s: SafetyStrike; i: number; due: number | null; onAppeal: (s: SafetyStrike) => void }) {
  const old = ended(s);
  const chip = s.removedAt ? <span className="hsf-chip tea">Removed{s.removedWhy ? ` · ${s.removedWhy}` : ''}</span>
    : old ? <span className="hsf-chip grey">Ended {safetyDay(toMs(s.expiresAt))}</span>
    : <span className="hsf-chip gold">Active · ends {safetyDay(toMs(s.expiresAt))}</span>;
  return (
    <article className={`hsf-strike${old ? ' old' : i % 2 ? ' rose' : ''}`}>
      {!old && <span className="fl" aria-hidden="true">{i % 2 ? <Hibiscus size={62} /> : <Marigold size={64} tone={1} />}</span>}
      {chip}
      <div className="tt"><Marigold size={22} />{titleOf(s)}</div>
      <div className="when">Call on {safetyDay(toMs(s.callAt))} · what you said</div>
      {s.quote ? <div className="hsf-bahi">“{s.quote}”</div> : <div className="hsf-bahi dim">No words are shown for this strike.</div>}
      {s.appealStatus === 'open' && <span className="hsf-chip tea">Appeal under review{due ? ` · reply by ${safetyDay(due)}` : ''}</span>}
      {s.appealStatus === 'accepted' && <span className="hsf-chip tea">Appeal accepted · strike removed</span>}
      {s.appealStatus === 'rejected' && <span className="hsf-chip lav">Appeal rejected</span>}
      {s.canAppeal && !s.appealStatus && !old && (
        <div className="hsf-appeal-row">
          <button type="button" className="hsf-btn" onClick={() => onAppeal(s)}>Appeal this strike</button>
          <span className="hsf-muted">Once per strike</span>
        </div>
      )}
    </article>
  );
}

/* ── appeal form ─────────────────────────────────────────────────────────────────────────────── */
function AppealDialog({ strike, onClose, onSent, appeal }: { strike: SafetyStrike | null; onClose: () => void; onSent: (id: string) => void; appeal: typeof appealStrike }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setMsg(''); setErr(''); setBusy(false); if (strike) capture(SAFETY_EVENTS.appealOpen, { reason: strike.reason }); }, [strike]);
  const send = async () => {
    if (!strike) return;
    if (msg.trim().length < 10) { setErr('Please write a few words about what happened.'); return; }
    setBusy(true); setErr('');
    const r = await appeal(strike.id, msg.trim());
    setBusy(false);
    if (r.ok || r.status === 409) { capture(SAFETY_EVENTS.appealSent, { reason: strike.reason, already: !r.ok }); onSent(strike.id); return; }
    capture(SAFETY_EVENTS.appealFailed, { status: r.status, code: r.code });
    setErr(r.message || 'We could not send that. Please check your internet and try again.');
  };
  return (
    <Dialog open={!!strike} onClose={onClose} label="Appeal this strike">
      {strike && <div className="hsf" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="hsf-kick">Appeal · once per strike</div>
        <h2>{titleOf(strike)}</h2>
        {strike.quote && <div className="hsf-bahi">“{strike.quote}”</div>}
        <label className="f" htmlFor="hsf-appeal">Tell us what happened
          <textarea id="hsf-appeal" rows={4} maxLength={600} value={msg} onChange={e => setMsg(e.target.value)} placeholder="I only said…" />
        </label>
        <p className="hsf-muted">A person reads this and replies on WhatsApp. If we got it wrong, the strike is removed.</p>
        {err && <div className="hsf-err" role="alert">{err}</div>}
        <div className="hsf-acts">
          <button type="button" className="hsf-btn" disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send appeal'}</button>
          <button type="button" className="hsf-btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>}
    </Dialog>
  );
}

/* ── the page ────────────────────────────────────────────────────────────────────────────────── */
export interface SafetyDeps { me?: SafetyMe; appeal?: typeof appealStrike; accept?: typeof acceptCallRules }
export default function Safety({ account, deps }: { account: DashboardAccount; deps?: SafetyDeps }) {
  const toast = useToast();
  const [me, setMe] = useState<SafetyMe | null>(deps?.me ?? null);
  const [failed, setFailed] = useState(false);
  const [appealing, setAppealing] = useState<SafetyStrike | null>(null);
  const isHost = !!account.host && !account.closing;

  const load = useCallback(async () => {
    setFailed(false);
    const r = await getSafetyMe();
    if (r.ok) { setMe(r.data); void loadSafety(true); } else setFailed(true);
  }, []);
  useEffect(() => { if (!deps?.me) void load(); }, [load, deps?.me]);
  useEffect(() => { if (me) capture(SAFETY_EVENTS.page, { status: me.status, active_strikes: activeOf(me).length, host: isHost, rules_needed: rulesNeeded(me) }); }, [!!me]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) return <div className="hsf-page"><Failed onRetry={() => void load()} text="We could not load your safety page." /></div>;
  if (!me) return <div className="hsf-page"><Skel h={190} /><Skel h={260} /></div>;

  const shown = [...me.strikes].sort((a, b) => Number(ended(a)) - Number(ended(b)) || (toMs(b.callAt) ?? 0) - (toMs(a.callAt) ?? 0));
  const live = shown.filter(s => !ended(s));
  const earlier = shown.filter(ended);
  const due = toMs(me.reviewDueAt);
  const sent = (id: string) => {
    setMe(m => m && { ...m, strikes: m.strikes.map(s => s.id === id ? { ...s, appealStatus: 'open', canAppeal: false } : s) });
    setAppealing(null); toast('Appeal sent. A person will reply on WhatsApp.');
    void loadSafety(true);
  };

  return (
    <div className="hsf hsf-page">
      <Hero me={me} />
      {isHost && rulesNeeded(me) && me.status === 'active' && <RulesGate me={me} accept={deps?.accept} onAccepted={() => { setMe(m => m && { ...m, rulesAccepted: true }); toast('Thank you. You can go online now.'); }} />}
      {me.status === 'paused' && <PausedPanel me={me} isHost={isHost} />}

      <div id="strikes" style={{ scrollMarginTop: 80 }}>
        {live.length > 0 ? (
          <div className="hsf-strikes">{live.map((s, i) => <StrikeCard key={s.id} s={s} i={i} due={due} onAppeal={setAppealing} />)}</div>
        ) : (
          <div className="hsf-card" style={{ textAlign: 'center', padding: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}><Marigold size={64} /></div>
            <p style={{ fontWeight: 700, marginTop: 8 }}>No active strikes. Sab badhiya!</p>
          </div>
        )}
      </div>

      {earlier.length > 0 && (
        <>
          <div className="hsf-kick">Earlier strikes</div>
          <div className="hsf-strikes">{earlier.map((s, i) => <StrikeCard key={s.id} s={s} i={i} due={due} onAppeal={setAppealing} />)}</div>
        </>
      )}

      <div className="hsf-note">
        <span className="hsf-ico" style={{ background: '#fff' }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6d4fd0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg></span>
        <div style={{ flex: 1 }}><b style={{ fontFamily: 'var(--head, Nunito)' }}>Calls are recorded for safety.</b> AI checks each call after it ends, and a person checks anything it isn’t sure about. <a href={CALL_RULES_HREF}>Read the call rules</a></div>
      </div>
      {isHost && <div className="hsf-shopnote">Selling? Use the {BRAND.name} Shop, never a call.</div>}

      <AppealDialog strike={appealing} onClose={() => setAppealing(null)} onSent={sent} appeal={deps?.appeal ?? appealStrike} />
    </div>
  );
}
