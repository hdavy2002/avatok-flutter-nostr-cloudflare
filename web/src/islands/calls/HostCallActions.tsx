/* [HF-CALLS-1] Call button + call flow + Notify-me for one host. Used on Explore/home cards and on /h/<slug> (side rail and mobile bar).
 * hfCallsEnabled off (or still unknown) -> today's disabled "Calls open soon" button, nothing else loads.
 * Flow: confirm sheet -> POST /api/hf/calls -> poll GET /api/hf/calls/:id every 2 s -> summary (+ rate / notify). */
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../host-onboarding/Icon';
import SessionBridge from './SessionBridge';
import ReviewForm from './ReviewForm';
import { API_BASE } from '../../lib/env';
import { isAppMode } from '../../lib/nativeBridge';
import { HF_PLAY_URL, trackWebBlocked } from '../../lib/hfApp';
import {
  callsEnabled, fetchWallet, firstName, hfCall, inr, isTerminal, looksSignedOut, mmss, signInUrl, soFar, toMs,
  type CallInfo, type HostPresence,
} from '../../lib/hfCallsApi';
import '../../styles/hf-calls.css';

export interface CallHost { slug: string; displayName: string; pricePerMin: number; status?: HostPresence; womenOnly?: boolean }
type Variant = 'card' | 'rail' | 'bar';
const POLL_MS = 2000;
const SAFETY = 'This is a friendly chat, not counselling. In crisis, dial 14416. Press # at any time to end the call and block.';

const btnClass = (v: Variant, extra = '') => (v === 'card' ? `sample-call ${extra}` : `cv-call-button ${extra}`).trim();

/* ── Notify me ─────────────────────────────────────────────────────────── */
export function NotifyButton({ host, variant, prefix, initial, big }: { host: CallHost; variant: Variant; prefix?: string; initial?: boolean | null; big?: boolean }) {
  const [on, setOn] = useState<boolean | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [bridge, setBridge] = useState(false);
  const name = firstName(host.displayName);

  useEffect(() => { if (initial === undefined) return; setOn(initial); }, [initial]);

  const click = async () => {
    if (looksSignedOut()) { window.location.assign(signInUrl()); return; }
    setBridge(true); setBusy(true); setMsg('');
    const r = await hfCall<{ ok: boolean; subscribed?: boolean }>(on ? 'DELETE' : 'POST', `/api/hf/hosts/${encodeURIComponent(host.slug)}/notify`);
    setBusy(false);
    if (r.ok) { const next = !on; setOn(next); setMsg(next ? `We’ll WhatsApp you when ${name} is online.` : 'Okay, we won’t message you.'); return; }
    if (r.status === 401) { window.location.assign(signInUrl()); return; }
    if (r.code === 'not_verified') setMsg('Please verify your WhatsApp number first so we can message you.');
    else setMsg(r.message || 'We could not do that. Please try again.');
  };
  const label = on ? 'We’ll WhatsApp you · tap to undo' : `${prefix ? `${prefix} — ` : ''}Notify me`;
  return (
    <>
      <SessionBridge on={bridge} />
      <button type="button" className={`${btnClass(variant, 'hfc-notify')}${on ? ' is-on' : ''}${big ? ' hfc-big' : ''}`} onClick={click} disabled={busy} aria-pressed={!!on}>
        <Icon name={on ? 'check' : 'bell'} size={22} />{busy ? 'Please wait…' : label}
      </button>
      {msg && <p className="hfc-note hfc-tiny" role="status">{msg}</p>}
    </>
  );
}

/* ── The call sheet ────────────────────────────────────────────────────── */
type Phase = 'confirm' | 'starting' | 'live' | 'error';
interface Problem { text: string; link?: { href: string; label: string }; balance?: boolean; notify?: boolean }

function useNow(active: boolean): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setN(Date.now()), 1000); return () => clearInterval(t); }, [active]);
  return n;
}

function CallSheet({ host, open, onClose }: { host: CallHost; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [balance, setBalance] = useState<number | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [rate, setRate] = useState(host.pricePerMin);
  const [maxMin, setMaxMin] = useState<number | null>(null);
  const [info, setInfo] = useState<CallInfo | null>(null);
  const [rating, setRating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const firstSeen = useRef<number | null>(null);
  const name = firstName(host.displayName);

  const terminal = !!info && isTerminal(info.status);
  const connected = info?.status === 'connected';
  const now = useNow(connected);

  const loadWallet = useCallback(async () => {
    // [HF-WALLET-1] what you can spend on a call = paid balance + test credits
    const r = await hfCall<{ balanceRupees: number; spendable?: number }>('GET', '/api/hf/wallet');
    if (r.ok) setBalance(Number(r.data.spendable ?? r.data.balanceRupees) || 0);
    else if (r.status === 401) window.location.assign(signInUrl());
  }, []);

  // open / close the native dialog; fresh state for each opening
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) {
      setPhase('confirm'); setProblem(null); setCallId(null); setInfo(null); setRating(false); setCancelling(false); setMaxMin(null); setRate(host.pricePerMin);
      firstSeen.current = null;
      d.showModal();
      void loadWallet();
    } else if (!open && d.open) d.close();
  }, [open, host.pricePerMin, loadWallet]);

  // Esc must not drop the sheet while a call is ringing
  useEffect(() => {
    const d = ref.current; if (!d) return;
    const onCancel = (e: Event) => { if (phase === 'live' && !terminal && !connected) e.preventDefault(); };
    const onCloseEv = () => onClose();
    d.addEventListener('cancel', onCancel); d.addEventListener('close', onCloseEv);
    return () => { d.removeEventListener('cancel', onCancel); d.removeEventListener('close', onCloseEv); };
  }, [phase, terminal, connected, onClose]);

  // polling
  useEffect(() => {
    if (phase !== 'live' || !callId || terminal) return;
    let alive = true; let fails = 0; let inflight = false;
    const tick = async () => {
      if (inflight) return; inflight = true;
      const r = await hfCall<CallInfo>('GET', `/api/hf/calls/${encodeURIComponent(callId)}`);
      inflight = false;
      if (!alive) return;
      if (r.ok) { fails = 0; setInfo(r.data); if (r.data.status === 'connected' && firstSeen.current == null) firstSeen.current = Date.now(); }
      else if (++fails >= 8) { setProblem({ text: 'We lost touch with the server. If your phone is ringing, you can still pick up.' }); setPhase('error'); }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [phase, callId, terminal]);

  // refresh the balance once a call ends
  useEffect(() => { if (terminal) void loadWallet(); }, [terminal, loadWallet]);

  const start = async () => {
    setPhase('starting'); setProblem(null);
    const r = await hfCall<{ ok: boolean; callId: string; status: string; rate: number; maxMinutes: number }>('POST', '/api/hf/calls', { hostSlug: host.slug });
    if (r.ok) {
      setCallId(r.data.callId); setRate(Number(r.data.rate) || host.pricePerMin); setMaxMin(Number(r.data.maxMinutes) || null);
      setInfo({ id: r.data.callId, status: 'ringing_host', rate: r.data.rate });
      setPhase('live'); return;
    }
    if (r.status === 401) { window.location.assign(signInUrl()); return; }
    const lane = typeof r.body.lane === 'string' ? r.body.lane : host.womenOnly ? 'women' : '';
    let p: Problem;
    if (r.code === 'not_verified') p = { text: 'Please verify your WhatsApp number first. We use it to ring you.', link: { href: '/sign-up?finish=1', label: 'Verify my number' } };
    else if (r.code === 'lane_required') p = { text: lane === 'lgbtq' ? 'This is an LGBTQ+ space host. Verify to call.' : 'This is a women-only space host. Verify to call.', link: { href: `/verify/lane?lane=${encodeURIComponent(lane || 'women')}`, label: 'Verify to call' } };
    else if (r.code === 'low_balance') { const b = Number(r.body.balance); if (Number.isFinite(b)) setBalance(b); p = { text: `You need at least ${inr(Number(r.body.needed) || rate * 2)} to start a call.`, balance: true }; }
    else if (r.code === 'host_unavailable') p = { text: r.message || 'This host isn’t available right now.', notify: true };
    else if (r.code === 'call_in_progress') p = { text: 'You already have a call going. Finish that one first.' };
    else if (r.code === 'calls_not_ready') p = { text: 'Calls open soon. Please check back in a little while.' };
    else p = { text: r.message || 'We could not start the call. Please try again.' };
    setProblem(p); setPhase('error');
  };

  const cancel = async () => {
    if (!callId) return;
    setCancelling(true);
    await hfCall('POST', `/api/hf/calls/${encodeURIComponent(callId)}/cancel`);
    // polling shows the final state
  };

  const need = rate * 2;
  const lowBalance = balance != null && balance < need;
  const canMax = balance != null ? Math.min(60, Math.floor(balance / rate)) : null;
  const connectedMs = toMs(info?.connectedAt) ?? null;
  let sec = 0;
  if (connected) {
    const fromServer = connectedMs != null ? (now - connectedMs) / 1000 : NaN;
    sec = Number.isFinite(fromServer) && fromServer > -5 ? Math.max(0, fromServer) : firstSeen.current ? (now - firstSeen.current) / 1000 : 0;
  }
  const st = info?.status;
  const mins = info?.billedMinutes ?? 0;

  return (
    <dialog ref={ref} className="hfc-dialog" aria-labelledby="hfc-title">
      <div className="hfc-head">
        <h2 id="hfc-title">{phase === 'live' && st === 'completed' ? 'Call ended' : `Call ${name}`}</h2>
        <button type="button" className="hfc-x" aria-label="Close" onClick={onClose} hidden={phase === 'live' && !terminal && !connected}>×</button>
      </div>

      {phase === 'confirm' && (
        <div className="hfc-body">
          <p className="hfc-chip" aria-live="polite">Your balance: <strong>{balance == null ? '…' : inr(balance)}</strong> <span>Test credits only for now</span></p>
          <ul className="hfc-facts">
            <li><Icon name="rupee" size={22} /><span><strong>{inr(rate)}/min</strong> · billed per started minute. Ringing or no answer costs nothing.</span></li>
            {canMax != null && !lowBalance && <li><Icon name="clock" size={22} /><span>You can talk for up to <strong>{canMax} min</strong> with your balance.</span></li>}
            <li><Icon name="lock" size={22} /><span><strong>Your number stays hidden.</strong> We ring your phone and {name}’s phone, then connect you.</span></li>
            <li><Icon name="shield" size={22} /><span>{SAFETY}</span></li>
          </ul>
          {host.womenOnly && <p className="hfc-note">This is a women-only space host. You may be asked to verify.</p>}
          {lowBalance && (
            <div className="hfc-note hfc-warn" role="status">
              <strong>Add balance to call.</strong> You need at least {inr(need)} (2 minutes) to start. <em>Test credits only for now. Real top-up is coming soon.</em>
            </div>
          )}
          <div className="hfc-actions">
            <button type="button" className="hfc-btn hfc-primary" onClick={start} disabled={lowBalance}><Icon name="phone" size={22} />Call now</button>
            <button type="button" className="hfc-btn" onClick={onClose}>Not now</button>
          </div>
        </div>
      )}

      {phase === 'starting' && <div className="hfc-body"><p className="hfc-status" role="status">Starting your call…</p></div>}

      {phase === 'live' && info && (
        <div className="hfc-body" aria-live="polite">
          {st === 'ringing_host' && <><p className="hfc-status hfc-pulse">Ringing {name}…</p><p className="hfc-sub">Keep this page open. If {name} doesn’t pick up, you won’t be charged.</p></>}
          {st === 'ringing_caller' && <><p className="hfc-status hfc-pulse">{name} accepted — we’re calling your phone now. Pick up!</p><p className="hfc-sub">Your number is never shown to {name}.</p></>}
          {connected && <><p className="hfc-status hfc-live">Connected · {mmss(sec)} · {inr(soFar(sec, rate))} so far</p><p className="hfc-sub">Billed per started minute{maxMin ? `, up to ${maxMin} min` : ''}. Press # on your phone to end the call and block.</p></>}
          {st === 'completed' && <>
            <p className="hfc-status">{mins > 0 ? `Call ended · ${mins} min · ${inr(info.chargedRupees ?? mins * rate)}` : 'Call ended · No charge'}</p>
            {info.canReview && !rating && <button type="button" className="hfc-btn hfc-primary" onClick={() => setRating(true)}><Icon name="star" size={22} />Rate your call</button>}
            {info.canReview && rating && <ReviewForm mode="call" callId={info.id} hostName={name} />}
          </>}
          {(st === 'host_declined' || st === 'no_answer') && <>
            <p className="hfc-status">{name} can’t take a call right now.</p>
            <p className="hfc-sub">You weren’t charged. Want us to WhatsApp you when {name} is free?</p>
            <NotifyButton host={host} variant="rail" big />
          </>}
          {st === 'caller_no_answer' && <><p className="hfc-status">We couldn’t reach your phone.</p><p className="hfc-sub">You weren’t charged. Check your phone has signal, then try again.</p></>}
          {st === 'failed' && <><p className="hfc-status">Something went wrong with the call.</p><p className="hfc-sub">You weren’t charged for any part we couldn’t connect. Please try again in a moment.</p></>}
          {st === 'blocked' && <><p className="hfc-status">{name} isn’t available.</p><p className="hfc-sub">You weren’t charged.</p></>}
          <p className="hfc-chip">Balance: <strong>{balance == null ? '…' : inr(balance)}</strong> <span>Test credits only for now</span></p>
          <div className="hfc-actions">
            {(st === 'ringing_host' || st === 'ringing_caller') && <button type="button" className="hfc-btn" onClick={cancel} disabled={cancelling}>{cancelling ? 'Cancelling…' : 'Cancel call'}</button>}
            {connected && <button type="button" className="hfc-btn" onClick={onClose}>Hide</button>}
            {terminal && <button type="button" className="hfc-btn" onClick={onClose}>Close</button>}
          </div>
        </div>
      )}

      {phase === 'error' && problem && (
        <div className="hfc-body">
          <p className="hfc-status" role="alert">{problem.text}</p>
          {problem.balance && <p className="hfc-note hfc-warn">Add balance to call. <em>Test credits only for now.</em></p>}
          {problem.link && <a className="hfc-btn hfc-primary" href={problem.link.href}>{problem.link.label}</a>}
          {problem.notify && <NotifyButton host={host} variant="rail" big />}
          <div className="hfc-actions"><button type="button" className="hfc-btn" onClick={onClose}>Close</button></div>
        </div>
      )}
    </dialog>
  );
}

const freshCache = new Map<string, Promise<{ status?: string; womenOnly?: boolean } | null>>();
/** One no-store fetch per slug per page (the rail and the mobile bar both ask). */
function freshHost(slug: string) {
  let p = freshCache.get(slug);
  if (!p) {
    p = fetch(`${API_BASE}/api/hosts/public/${encodeURIComponent(slug)}`, { cache: 'no-store', headers: { accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    freshCache.set(slug, p);
  }
  return p;
}

/* [HF-APP-3] Web vs app call gate (spec HF-APP-D11 / HF-TOK-D7). Calls paid with Play tokens start only in the app.
 * The client cannot ask "would test credits cover this call?" without starting it, so the plain web uses this rule:
 * show the normal Call button only when the signed-in caller has test credits (GET /api/hf/wallet testBalance > 0);
 * everyone else (signed out, no test credits, wallet unreachable) sees "Open the app to call". App mode is never gated.
 * One wallet request per page; a failed request is not cached, so a later card retries. */
let webCreditsP: Promise<boolean> | null = null;
function webHasTestCredits(): Promise<boolean> {
  if (!webCreditsP) {
    const p = fetchWallet().then(r => {
      if (!r.ok) { if (webCreditsP === p) webCreditsP = null; return false; }
      return Number(r.data.testBalance) > 0;
    }).catch(() => { if (webCreditsP === p) webCreditsP = null; return false; });
    webCreditsP = p;
  }
  return webCreditsP;
}

/* ── Public component ──────────────────────────────────────────────────── */
export default function HostCallActions({ host, variant, refresh }: { host: CallHost; variant: Variant; refresh?: boolean }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [status, setStatus] = useState<HostPresence>(host.status ?? 'offline');
  const [womenOnly, setWomenOnly] = useState(!!host.womenOnly);
  const [open, setOpen] = useState(false);
  const [everOpen, setEverOpen] = useState(false);
  const [bridge, setBridge] = useState(false);
  const [subscribed, setSubscribed] = useState<boolean | undefined>(undefined);
  const [gate, setGate] = useState<'pending' | 'open' | 'app'>('pending'); // [HF-APP-3] starts 'pending' on server and client alike (no hydration mismatch)

  useEffect(() => { let live = true; void callsEnabled().then(v => { if (live) setOn(v); }); return () => { live = false; }; }, []);

  // /h/<slug> is cached for a minute at the edge: ask for the live status, and mirror it on the page badge.
  useEffect(() => {
    if (!on || !refresh) return;
    let live = true;
    void freshHost(host.slug).then(j => {
      if (!live || !j) return;
      if (j.status === 'online' || j.status === 'busy' || j.status === 'offline') setStatus(j.status);
      if (typeof j.womenOnly === 'boolean') setWomenOnly(j.womenOnly);
    });
    return () => { live = false; };
  }, [on, refresh, host.slug]);

  useEffect(() => {
    if (!on || variant !== 'rail') return;
    const badge = document.querySelector<HTMLElement>('.cv-online');
    if (!badge) return;
    badge.className = `cv-online ${status === 'online' ? '' : status === 'busy' ? 'cv-status-busy' : 'cv-status-offline'}`.trim();
    badge.innerHTML = '<span aria-hidden="true"></span>' + (status === 'online' ? 'Online' : status === 'busy' ? 'On a call' : 'Offline');
  }, [on, status, variant]);

  // rail: if signed in and the host can't be called, find out whether we already subscribed
  useEffect(() => {
    if (!on || variant !== 'rail' || status === 'online' || looksSignedOut()) return;
    setBridge(true);
    let live = true;
    void hfCall<{ subscribed: boolean }>('GET', `/api/hf/hosts/${encodeURIComponent(host.slug)}/notify`).then(r => { if (live && r.ok) setSubscribed(!!r.data.subscribed); });
    return () => { live = false; };
  }, [on, variant, status, host.slug]);

  // [HF-APP-3] decide whether this person may start a call from here (see webHasTestCredits)
  useEffect(() => {
    if (!on || status !== 'online') return;
    if (isAppMode()) { setGate('open'); return; }
    if (looksSignedOut()) { setGate('app'); return; }
    setBridge(true); // the wallet request needs the Clerk token bridge
    let live = true;
    void webHasTestCredits().then(ok => { if (live) setGate(ok ? 'open' : 'app'); });
    return () => { live = false; };
  }, [on, status]);

  const h: CallHost = { ...host, status, womenOnly };
  const onClose = useCallback(() => setOpen(false), []);

  if (!on) {
    return (
      <button type="button" className={btnClass(variant, variant === 'card' ? 'hf-call-soon' : 'hf-call-off')} disabled aria-disabled="true">
        <Icon name="bell" size={22} />Calls open soon
      </button>
    );
  }
  if (status !== 'online') {
    return <NotifyButton host={h} variant={variant} prefix={status === 'busy' ? 'Busy' : 'Offline'} initial={subscribed} />;
  }
  if (gate === 'app') {
    return (
      <a className={btnClass(variant, 'hfc-call hf-call-app')} href={HF_PLAY_URL} target="_blank" rel="noopener noreferrer" onClick={() => trackWebBlocked('call')}>
        <Icon name="phone" size={22} />Open the app to call
      </a>
    );
  }
  return (
    <>
      <SessionBridge on={bridge || open} />
      <button type="button" className={btnClass(variant, 'hfc-call')} disabled={gate === 'pending'} onClick={() => {
        if (looksSignedOut()) { window.location.assign(signInUrl()); return; }
        setBridge(true); setEverOpen(true); setOpen(true);
      }}>
        <Icon name="phone" size={22} />Call {inr(host.pricePerMin)}/min
      </button>
      {everOpen && <CallSheet host={h} open={open} onClose={onClose} />}
    </>
  );
}
