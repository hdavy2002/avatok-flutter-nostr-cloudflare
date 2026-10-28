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
import { RateLines } from './RateCard';
import { capture } from '../../lib/analytics';
import { formatPaise } from '../../lib/money';
import { chargeForSeconds, stdRateLabel, type PriceTier } from '../../lib/hfStdPlan';
import {
  callsEnabled, fetchWallet, firstName, hfCall, inr, isTerminal, looksSignedOut, mmss, signInUrl, soFar, toMs,
  type CallInfo, type HostPresence,
} from '../../lib/hfCallsApi';
import '../../styles/hf-calls.css';
import { bookingsEnabled } from '../../lib/hfBookingsApi';
import QueueSheet from './QueueSheet'; // [HF-CALL-MODES-E1]
import SpaceLock from '../../components/hosts/SpaceLock'; // [HF-CREATOR-SPACES-1]
import { LOCK_TEXT, gateFromError, gateOf, trackGate, useSpaceGate } from '../../lib/hfSpaces';
import { useSafetyNotice } from '../../components/safety/SafetyNotice'; // [HF-CALL-SAFETY-WEB]
import PostCallReport from '../../components/safety/PostCallReport';
import { safetyBlock } from '../../lib/hfSafetyApi';
import { NO_FLAGS, callModeFlags, deriveCallState, fanButtons, minutesLeft, refusalText, type CallModeFlags, type PublicCallState } from '../../lib/hfCallModes';

/** [HF-STD-PLAN-1] pricePerMin may be fractional (3.99); pricePaisePerMin / priceTiers come from the worker's host card. */
export interface CallHost { slug: string; displayName: string; pricePerMin: number; pricePaisePerMin?: number; priceTiers?: PriceTier[]; plan?: string; status?: HostPresence; womenOnly?: boolean; space?: 'women' | 'lgbtq' | null; callerLevel?: 'everyone' | 'video_kyc' }
const hostRateLabel = (h: CallHost): string => h.plan === 'standard'
  ? stdRateLabel(h.pricePaisePerMin ?? Math.round(Number(h.pricePerMin) * 100))
  : `₹${Number(h.pricePerMin).toLocaleString('en-IN', { maximumFractionDigits: 2 })}/min`;
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
    else if (r.code === 'video_kyc_required_caller') { trackGate('kyc', 'server_403'); setMsg('This creator only takes calls from video-KYC verified customers. Open the creator page and tap Verify to call.'); }
    else if (r.code === 'lane_required') setMsg(r.body.lane === 'lgbtq' ? 'Only verified LGBTQ+ members can call this channel. Open the channel page to verify.' : 'Only verified women can call this channel. Open the channel page to verify.');
    else setMsg(r.message || 'We could not do that. Please try again.');
  };
  // [HF-CHANNEL-QA-1] The phone bar is narrow: the status is already on the photo, so the bar says just "Notify me" (owner: the 3-line pill was ugly).
  const label = variant === 'bar' ? (on ? 'Notifying ✓' : 'Notify me') : on ? 'We’ll WhatsApp you · tap to undo' : `${prefix ? `${prefix} — ` : ''}Notify me`;
  return (
    <>
      <SessionBridge on={bridge} />
      <button type="button" className={`${btnClass(variant, 'hfc-notify')}${on ? ' is-on' : ''}${big ? ' hfc-big' : ''}`} onClick={click} disabled={busy} aria-pressed={!!on} aria-label={variant === 'bar' ? label : undefined}>
        <Icon name={on ? 'check' : 'bell'} size={22} />{busy ? 'Please wait…' : label}
      </button>
      {msg && <p className="hfc-note hfc-tiny" role="status">{msg}</p>}
    </>
  );
}

/* ── The call sheet ────────────────────────────────────────────────────── */
type Phase = 'confirm' | 'starting' | 'live' | 'error';
interface Problem { text: string; link?: { href: string; label: string }; balance?: boolean; notify?: boolean; addMoney?: boolean; queue?: boolean; book?: boolean; waiting?: number }
/** [HF-STD-PLAN-1] Rupee wallet: the caller's balance and what the Standard plan lets them do with it (GET /api/hf/wallet/estimate). */
interface StdEstimate { plan?: string; ratePerMinRupees?: string; tokensPerMinute?: string; aboutText: string; affordableSeconds: number; canStart: boolean; startNeed?: string; startNeedPaise?: number; balance?: string; tiers?: PriceTier[] }
interface TokView { balance: string; hasDebt: boolean; standard: boolean; own?: boolean; est?: StdEstimate }
const capFirst = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

function useNow(active: boolean): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setN(Date.now()), 1000); return () => clearInterval(t); }, [active]);
  return n;
}

/** [HF-INTRO-B3] exported so the reels page reuses the one call flow. `onLane` (optional): a 403 lane_required hands over to the caller's own pop-up (need = 'aadhaar' | 'female_only') instead of the inline text. */
export function CallSheet({ host, open, onClose, flags = NO_FLAGS, bookingOn = false, onLane }: { host: CallHost; open: boolean; onClose: () => void; flags?: CallModeFlags; bookingOn?: boolean; onLane?: (need: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [balance, setBalance] = useState<number | null>(null);
  const [tok, setTok] = useState<TokView | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [rate, setRate] = useState(host.pricePerMin);
  const [maxMin, setMaxMin] = useState<number | null>(null);
  const [info, setInfo] = useState<CallInfo | null>(null);
  const [rating, setRating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const firstSeen = useRef<number | null>(null);
  const name = firstName(host.displayName);
  const notice = useSafetyNotice(); // [HF-CALL-SAFETY-WEB]

  const terminal = !!info && isTerminal(info.status);
  const connected = info?.status === 'connected';
  const now = useNow(connected);

  const loadWallet = useCallback(async () => {
    // [HF-WALLET-1] what you can spend on a call = paid balance + test credits
    const r = await hfCall<{ balanceRupees: number; spendable?: number; mode?: string; wallet?: { balance: string; debtOpen: boolean }; tokens?: { balance: string; debt: { open: boolean } } }>('GET', '/api/hf/wallet');
    if (r.ok) {
      if ((r.data.mode === 'rupees' && r.data.wallet) || (r.data.mode === 'tokens' && r.data.tokens)) {
        const e = await hfCall<StdEstimate>('GET', `/api/hf/wallet/estimate?host=${encodeURIComponent(host.slug)}`);
        const standard = r.data.mode === 'rupees' && !!r.data.wallet && e.ok && e.data.plan === 'standard';
        // [HF-WIRE-18] HF-REEL-37: the influencer's own rate on the rupee wallet (plan creator / host_rate) is priced per minute, not by the Standard rate card
        const own = r.data.mode === 'rupees' && !!r.data.wallet && e.ok && (e.data.plan === 'creator' || e.data.plan === 'host_rate');
        const bal = standard || own ? r.data.wallet!.balance : `${r.data.tokens?.balance ?? '0.00'} tokens`;
        setTok({ balance: bal, hasDebt: standard || own ? !!r.data.wallet!.debtOpen : !!r.data.tokens?.debt?.open, standard, own, est: e.ok ? e.data : undefined });
        if (standard) capture('hf_std_rate_card_viewed', { surface: 'call_confirm', host: host.slug, can_start: e.data.canStart });
      } else setBalance(Number(r.data.spendable ?? r.data.balanceRupees) || 0);
    } else if (r.status === 401) window.location.assign(signInUrl());
  }, [host.slug]);

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
    // [HF-CALL-SAFETY-WEB] the recorded-for-safety notice, until the fan ticks "Don't show this again" (only while hfCallRecordingEnabled is on)
    if (!(await notice.ask({ name, cta: `OK, call now · ${hostRateLabel(host)}`, surface: 'call' }))) return;
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
    if (r.code === 'lane_required' && onLane) { onLane(typeof r.body.need === 'string' ? r.body.need : 'aadhaar'); onClose(); return; } // [HF-INTRO-B3]
    if (r.code === 'not_verified') p = { text: 'Please verify your WhatsApp number first. We use it to ring you.', link: { href: '/sign-up?finish=1', label: 'Verify my number' } };
    else if (r.code === 'lane_required' || r.code === 'video_kyc_required_caller') { // [HF-CREATOR-SPACES-1] [HF-CREATOR-BADGES-1]
      const ln = gateFromError(r.code, { ...r.body, lane: lane || r.body.lane }, gateOf(host)) ?? 'women';
      trackGate(ln, 'server_403');
      p = { text: LOCK_TEXT[ln], link: { href: `/verify/lane?lane=${ln}&next=${encodeURIComponent(location.pathname + location.search)}`, label: 'Verify to call' } };
    }
    else if (r.code === 'low_balance' && (typeof r.body.shortfallRupees === 'string' || typeof r.body.shortfallTokens === 'string')) {
      const short = typeof r.body.shortfallRupees === 'string' ? r.body.shortfallRupees : typeof r.body.shortfallPaise === 'number' ? formatPaise(r.body.shortfallPaise) : '';
      p = { text: short ? `You need ${short} more to start this call.` : (r.message || 'You need more money in your wallet to start this call.'), addMoney: true };
    }
    else if (r.code === 'account_paused') { const sb = safetyBlock(r.code, 'fan')!; p = { text: sb.text, link: { href: sb.href, label: sb.label } }; }
    else if (r.code === 'debt_open') p = { text: r.message || 'Please clear the amount owed before calling' };
    else if (r.code === 'low_balance') { const b = Number(r.body.balance); if (Number.isFinite(b)) setBalance(b); p = { text: `You need at least ${inr(Number(r.body.needed) || rate * 2)} to start a call.`, balance: true }; }
    else if (r.code === 'host_unavailable' && flags.modes && typeof r.body.reason === 'string') {
      // [HF-CALL-MODES-E1] spec 2.5: the refusal says why and what the fan can do instead.
      const canQueue = flags.queue && r.body.canQueue === true, canBook = bookingOn && r.body.canBook === true;
      p = { text: refusalText(r.body.reason, name) || r.message || 'This influencer isn’t available right now.', queue: canQueue, book: canBook, notify: !canQueue && !canBook,
        waiting: typeof r.body.queueWaiting === 'number' ? r.body.queueWaiting : undefined };
    }
    else if (r.code === 'host_unavailable') p = { text: r.message || 'This influencer isn’t available right now.', notify: true };
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
  const lowBalance = tok ? tok.hasDebt || tok.est?.canStart === false : balance != null && balance < need;
  const canMax = tok ? null : balance != null ? Math.min(60, Math.floor(balance / rate)) : null;
  const startNeedText = tok?.est?.startNeed ?? (tok?.est?.startNeedPaise != null ? formatPaise(tok.est.startNeedPaise) : null);
  const tiers = tok?.est?.tiers ?? host.priceTiers;
  const balanceText = tok ? tok.balance : balance == null ? '…' : inr(balance);
  const connectedMs = toMs(info?.connectedAt) ?? null;
  let sec = 0;
  if (connected) {
    const fromServer = connectedMs != null ? (now - connectedMs) / 1000 : NaN;
    sec = Number.isFinite(fromServer) && fromServer > -5 ? Math.max(0, fromServer) : firstSeen.current ? (now - firstSeen.current) / 1000 : 0;
  }
  const st = info?.status;
  const mins = info?.billedMinutes ?? 0;

  return (
    <>
    <dialog ref={ref} className="hfc-dialog" aria-labelledby="hfc-title">
      <div className="hfc-head">
        <h2 id="hfc-title">{phase === 'live' && st === 'completed' ? 'Call ended' : `Call ${name}`}</h2>
        <button type="button" className="hfc-x" aria-label="Close" onClick={onClose} hidden={phase === 'live' && !terminal && !connected}>×</button>
      </div>

      {phase === 'confirm' && (
        <div className="hfc-body">
          <p className="hfc-chip" aria-live="polite">Your balance: <strong>{balanceText}</strong>{!tok && <> <span>Test credits only for now</span></>}</p>
          <ul className="hfc-facts">
            {tok?.standard ? (
              <li><Icon name="rupee" size={22} /><span><strong>Standard plan · {hostRateLabel(host)}</strong> to start. <RateLines tiers={tiers} />Same rate for every influencer · billed per second. Ringing or no answer costs nothing.</span></li>
            ) : tok?.own ? (
              <li><Icon name="rupee" size={22} /><span><strong>{hostRateLabel(host)}</strong> · set by {name} · billed per second. Ringing or no answer costs nothing.</span></li>
            ) : tok ? (
              <li><Icon name="rupee" size={22} /><span><strong>{tok.est?.tokensPerMinute ?? '—'} tokens/min</strong> · billed per started minute. Ringing or no answer costs nothing.</span></li>
            ) : (
              <li><Icon name="rupee" size={22} /><span><strong>{inr(rate)}/min</strong> · billed per started minute. Ringing or no answer costs nothing.</span></li>
            )}
            {tok?.est && tok.est.affordableSeconds < 24 * 60 * 60 && !lowBalance && <li><Icon name="clock" size={22} /><span><strong>{capFirst(tok.est.aboutText)}</strong> with your balance. The call runs until you hang up or your balance is used up.</span></li>}
            {canMax != null && !lowBalance && <li><Icon name="clock" size={22} /><span>You can talk for up to <strong>{canMax} min</strong> with your balance.</span></li>}
            <li><Icon name="lock" size={22} /><span><strong>Your number stays hidden.</strong> We ring your phone and {name}’s phone, then connect you.</span></li>
            <li><Icon name="shield" size={22} /><span>{SAFETY}</span></li>
          </ul>
          {lowBalance && tok && (
            <div className="hfc-note hfc-warn" role="status">
              {tok.hasDebt
                ? <strong>Please clear the amount owed before calling.</strong>
                : <><strong>Add money to call.</strong> You need at least 2 minutes of balance{startNeedText ? ` (${startNeedText})` : ''} to start. Add money in the app.</>}
            </div>
          )}
          {lowBalance && !tok && (
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
          {connected && (tok?.standard
            ? <><p className="hfc-status hfc-live">Connected · {mmss(sec)} · about {formatPaise(chargeForSeconds(tiers, sec))} so far</p><p className="hfc-sub">Billed per second. Press # on your phone to end the call and block.</p></>
            : <><p className="hfc-status hfc-live">Connected · {mmss(sec)} · {inr(soFar(sec, rate))} so far</p><p className="hfc-sub">Billed per started minute{maxMin ? `, up to ${maxMin} min` : ''}. Press # on your phone to end the call and block.</p></>)}
          {connected && flags.chunk && info.short && (() => {
            // [HF-CALL-MODES-E1] The wallet cannot fund the next 5 minutes: say when the call ends and let the caller top up without leaving the call.
            const left = minutesLeft(info.capAt ?? info.fundedUntil, now);
            return <div className="hfc-note hfc-warn" role="status">
              <strong>Your wallet balance has run out.</strong> This call will end{left ? ` in about ${left} minute${left === 1 ? '' : 's'}` : ' soon'}. Please top up while you are speaking.
              <a className="hfc-btn hfc-primary" style={{ marginTop: 8 }} href="/dashboard/wallet#add" target="_blank" rel="noopener noreferrer" onClick={() => capture('hf_web_topup_in_call', { host: host.slug })}><Icon name="rupee" size={22} />Top up now — your call continues</a>
            </div>;
          })()}
          {st === 'completed' && <>
            <p className="hfc-status">{info.charged !== undefined || info.chargedPaise !== undefined
              ? ((info.billableSeconds ?? 0) > 0 ? `Call ended · ${mmss(info.billableSeconds ?? 0)} · ${info.charged ?? formatPaise(info.chargedPaise ?? 0)}` : 'Call ended · No charge')
              : info.earning !== undefined || info.earningPaise !== undefined
              ? ((info.billableSeconds ?? 0) > 0 ? `Call ended · ${mmss(info.billableSeconds ?? 0)} · You earned ${info.earning ?? formatPaise(info.earningPaise ?? 0)}` : 'Call ended · No earnings')
              : tok || info.tokensSpent !== undefined
              ? ((info.billableSeconds ?? 0) > 0 ? `Call ended · ${mmss(info.billableSeconds ?? 0)}` : 'Call ended · No charge')
              : mins > 0 ? `Call ended · ${mins} min · ${inr(info.chargedRupees ?? mins * rate)}` : 'Call ended · No charge'}</p>
            {info.tiers && info.tiers.some(t => t.seconds > 0) && info.charged !== undefined && (
              <ul className="hfc-calls" aria-label="How your call was charged">
                {info.tiers.filter(t => t.seconds > 0).map(t => (
                  <li key={t.fromMin}><strong>{formatPaise(t.paisePerMin)}/min</strong><span>{formatPaise(t.amountPaise)}</span><small>{mmss(t.seconds)} at this rate</small></li>
                ))}
              </ul>
            )}
            {info.canReview && !rating && <button type="button" className="hfc-btn hfc-primary" onClick={() => setRating(true)}><Icon name="star" size={22} />Rate your call</button>}
            {info.canReview && rating && <ReviewForm mode="call" callId={info.id} hostName={name} />}
            {(info.billableSeconds ?? mins * 60) > 0 && <PostCallReport callId={info.id} hostName={name} surface="call_ended" />}
          </>}
          {(st === 'host_declined' || st === 'no_answer') && <>
            <p className="hfc-status">{name} can’t take a call right now.</p>
            <p className="hfc-sub">You weren’t charged. Want us to WhatsApp you when {name} is free?</p>
            <NotifyButton host={host} variant="rail" big />
          </>}
          {st === 'caller_no_answer' && <><p className="hfc-status">We couldn’t reach your phone.</p><p className="hfc-sub">You weren’t charged. Check your phone has signal, then try again.</p></>}
          {st === 'failed' && <><p className="hfc-status">Something went wrong with the call.</p><p className="hfc-sub">You weren’t charged for any part we couldn’t connect. Please try again in a moment.</p></>}
          {st === 'blocked' && <><p className="hfc-status">{name} isn’t available.</p><p className="hfc-sub">You weren’t charged.</p></>}
          <p className="hfc-chip">Balance: <strong>{balanceText}</strong>{!tok && <> <span>Test credits only for now</span></>}</p>
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
          {problem.addMoney && <p className="hfc-note hfc-warn">Add money in the app to call.</p>}
          {problem.link && <a className="hfc-btn hfc-primary" href={problem.link.href}>{problem.link.label}</a>}
          {problem.notify && <NotifyButton host={host} variant="rail" big />}
          {problem.queue && <QueueSheet host={host} variant="rail" waiting={problem.waiting} bookingHref={`/bookings?host=${encodeURIComponent(host.slug)}`} bookingOn={bookingOn} />}
          {problem.book && <a className="hfc-btn" href={`/bookings?host=${encodeURIComponent(host.slug)}`}>Book a time</a>}
          <div className="hfc-actions"><button type="button" className="hfc-btn" onClick={onClose}>Close</button></div>
        </div>
      )}
    </dialog>
    {notice.node}
    </>
  );
}

const freshCache = new Map<string, Promise<{ status?: string; womenOnly?: boolean; callState?: string; queue?: { open?: boolean; waiting?: number } } | null>>();
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
export function webHasTestCredits(): Promise<boolean> {
  if (!webCreditsP) {
    const p = fetchWallet().then(r => {
      if (!r.ok) { if (webCreditsP === p) webCreditsP = null; return false; }
      return Number(r.data.testBalance) > 0 || (r.data.wallet?.testPaise ?? 0) > 0; // [HF-STD-PLAN-1] rupee wallet reports testPaise
    }).catch(() => { if (webCreditsP === p) webCreditsP = null; return false; });
    webCreditsP = p;
  }
  return webCreditsP;
}

/* ── Public component ──────────────────────────────────────────────────── */
/** [HF-CHANNEL-WEB-1] callLabel replaces the "Call ₹x/min" text on the call button (the channel page shows the rate beside it: "Call now"); bookHref points "Book a time" at the page's own calendar. Both optional: other pages are unchanged. */
type ActionsProps = { host: CallHost; variant: Variant; refresh?: boolean; callLabel?: string; bookHref?: string };
/** [HF-CREATOR-SPACES-1] On a Women-only / LGBTQ+ channel, Call / Book / Queue / Notify stay locked until the viewer's video KYC is approved. The server enforces it too (403 lane_required). */
export default function HostCallActions(props: ActionsProps) {
  const space = gateOf(props.host);
  const gate = useSpaceGate(space);
  if (!space) return <HostCallActionsInner {...props} />;
  return (
    <>
      <SessionBridge on={gate.needsBridge} />
      {gate.state === 'ok' ? <HostCallActionsInner {...props} />
        : <SpaceLock lane={space} compact={props.variant === 'bar'} wait={gate.state === 'loading'} signedOut={gate.state === 'signedout'} missing={gate.missing} />}
    </>
  );
}

function HostCallActionsInner({ host, variant, refresh, callLabel, bookHref }: ActionsProps) {
  const [on, setOn] = useState<boolean | null>(null);
  const [bookingOn, setBookingOn] = useState(false);
  const [status, setStatus] = useState<HostPresence>(host.status ?? 'offline');
  const [womenOnly, setWomenOnly] = useState(!!host.womenOnly);
  const [open, setOpen] = useState(false);
  const [everOpen, setEverOpen] = useState(false);
  const [bridge, setBridge] = useState(false);
  const [subscribed, setSubscribed] = useState<boolean | undefined>(undefined);
  const [gate, setGate] = useState<'pending' | 'open' | 'app'>('pending'); // [HF-APP-3] starts 'pending' on server and client alike (no hydration mismatch)

  // [HF-CALL-MODES-E1] the four call-mode flags (all off = today's behaviour) and the live callState / queue size from the fresh host card
  const [flags, setFlags] = useState<CallModeFlags>(NO_FLAGS);
  const [callState, setCallState] = useState<string | null>(null);
  const [queueWaiting, setQueueWaiting] = useState(0);
  useEffect(() => { let live = true; void callModeFlags().then(f => { if (live) setFlags(f); }); return () => { live = false; }; }, []);

  useEffect(() => { let live = true; void callsEnabled().then(v => { if (live) setOn(v); }); void bookingsEnabled().then(v => { if (live) setBookingOn(v); }); return () => { live = false; }; }, []);

  // /h/<slug> is cached for a minute at the edge: ask for the live status, and mirror it on the page badge.
  useEffect(() => {
    if (!on || !refresh) return;
    let live = true;
    void freshHost(host.slug).then(j => {
      if (!live || !j) return;
      if (j.status === 'online' || j.status === 'busy' || j.status === 'offline') setStatus(j.status);
      if (typeof j.womenOnly === 'boolean') setWomenOnly(j.womenOnly);
      if (typeof j.callState === 'string') setCallState(j.callState);
      if (typeof j.queue?.waiting === 'number') setQueueWaiting(j.queue.waiting);
    });
    return () => { live = false; };
  }, [on, refresh, host.slug]);

  // With the modes flag on, callState (not the legacy status) decides what a fan sees. Off: exactly the old status logic.
  const cs: PublicCallState | null = flags.modes ? deriveCallState(status, callState) : null;
  const fb = cs ? fanButtons(cs, bookingOn, flags.queue) : null;
  const callable = cs ? cs === 'available' : status === 'online';

  useEffect(() => {
    if (!on || variant !== 'rail') return;
    const badge = document.querySelector<HTMLElement>('.cv-online');
    if (!badge) return;
    if (fb && cs) {
      badge.className = `cv-online ${cs === 'available' || cs === 'connecting' || cs === 'queue_only' ? '' : cs === 'on_call' || cs === 'appointments' ? 'cv-status-busy' : 'cv-status-offline'}`.trim();
      badge.innerHTML = '<span aria-hidden="true"></span>' + fb.badge;
      return;
    }
    badge.className = `cv-online ${status === 'online' ? '' : status === 'busy' ? 'cv-status-busy' : 'cv-status-offline'}`.trim();
    badge.innerHTML = '<span aria-hidden="true"></span>' + (status === 'online' ? 'Online' : status === 'busy' ? 'On a call' : 'Offline');
  }, [on, status, variant, cs, fb?.badge]);

  // rail: if signed in and the host can't be called, find out whether we already subscribed
  useEffect(() => {
    if (!on || variant !== 'rail' || callable || looksSignedOut()) return;
    setBridge(true);
    let live = true;
    void hfCall<{ subscribed: boolean }>('GET', `/api/hf/hosts/${encodeURIComponent(host.slug)}/notify`).then(r => { if (live && r.ok) setSubscribed(!!r.data.subscribed); });
    return () => { live = false; };
  }, [on, variant, callable, host.slug]);

  // [HF-APP-3] decide whether this person may start a call from here (see webHasTestCredits)
  useEffect(() => {
    if (!on || !callable) return;
    if (isAppMode()) { setGate('open'); return; }
    if (looksSignedOut()) { setGate('app'); return; }
    setBridge(true); // the wallet request needs the Clerk token bridge
    let live = true;
    void webHasTestCredits().then(ok => { if (live) setGate(ok ? 'open' : 'app'); });
    return () => { live = false; };
  }, [on, callable]);

  const h: CallHost = { ...host, status, womenOnly };
  const bookingHref = bookHref ?? `/bookings?host=${encodeURIComponent(host.slug)}`;
  const onClose = useCallback(() => setOpen(false), []);

  if (!on) {
    return <>
      <button type="button" className={btnClass(variant, variant === 'card' ? 'hf-call-soon' : 'hf-call-off')} disabled aria-disabled="true"><Icon name="bell" size={22} />Calls open soon</button>
      {bookingOn && <a className={`${btnClass(variant)} hfc-book-time`} href={bookingHref}>Book a time</a>}
    </>;
  }
  if (fb && !fb.callNow) {
    // [HF-CALL-MODES-E1] spec 2.1: on a call / queue only / appointments / offline
    return <>
      {fb.queue && <QueueSheet host={h} variant={variant} waiting={queueWaiting} bookingHref={bookingHref} bookingOn={bookingOn} />}
      {fb.notify && <NotifyButton host={h} variant={variant} prefix={fb.badge} initial={subscribed} />}
      {fb.book && <a className={`${btnClass(variant)} hfc-book-time`} href={bookingHref}>Book a time</a>}
    </>;
  }
  if (!callable) {
    return <><NotifyButton host={h} variant={variant} prefix={status === 'busy' ? 'On a call' : 'Offline'} initial={subscribed} />{bookingOn && <a className={`${btnClass(variant)} hfc-book-time`} href={bookingHref}>Book a time</a>}</>;
  }
  if (gate === 'app') {
    return <>
      <a className={btnClass(variant, 'hfc-call hf-call-app')} href={HF_PLAY_URL} target="_blank" rel="noopener noreferrer" onClick={() => trackWebBlocked('call')}><Icon name="phone" size={22} />{variant === 'bar' ? 'Call in app' : 'Open the app to call'}</a>
      {bookingOn && <a className={`${btnClass(variant)} hfc-book-time`} href={bookingHref}>Book a time</a>}
    </>;
  }
  return (
    <>
      <SessionBridge on={bridge || open} />
      <button type="button" className={btnClass(variant, 'hfc-call')} disabled={gate === 'pending'} onClick={() => {
        if (looksSignedOut()) { window.location.assign(signInUrl()); return; }
        setBridge(true); setEverOpen(true); setOpen(true);
      }}><Icon name="phone" size={22} />{callLabel ?? <>Call {hostRateLabel(host)}</>}</button>
      {bookingOn && <a className={`${btnClass(variant)} hfc-book-time`} href={bookingHref}>Book a time</a>}
      {everOpen && <CallSheet host={h} open={open} onClose={onClose} flags={flags} bookingOn={bookingOn} />}
    </>
  );
}
