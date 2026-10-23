/* [HF-CALL-MODES-E1] "Join the queue" for a fan: the button, the join sheet and the live position view.
 * Only mounted when hfCallQueueEnabled is on (HostCallActions decides). Polls GET /api/hf/queue/me every 4 s while waiting.
 * Copy promise (spec 2.2): "We'll WhatsApp you just before we call. Nothing is charged until you talk." */
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../host-onboarding/Icon';
import SessionBridge from './SessionBridge';
import { capture } from '../../lib/analytics';
import { firstName, looksSignedOut, signInUrl } from '../../lib/hfCallsApi';
import { QUEUE_PROMISE, joinQueue, leaveQueue, myQueue, queueJoinProblem, type MyQueueResponse } from '../../lib/hfCallModes';

type Variant = 'card' | 'rail' | 'bar';
const btnClass = (v: Variant, extra = '') => (v === 'card' ? `sample-call ${extra}` : `cv-call-button ${extra}`).trim();
const POLL_MS = 4000;
type Entry = NonNullable<MyQueueResponse['entry']>;
type Phase = 'confirm' | 'joining' | 'waiting' | 'ended' | 'error';
interface Problem { text: string; link?: { href: string; label: string }; book?: boolean }

export default function QueueSheet({ host, variant, waiting, bookingHref, bookingOn }: { host: { slug: string; displayName: string }; variant: Variant; waiting?: number; bookingHref: string; bookingOn: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const name = firstName(host.displayName);
  const [open, setOpen] = useState(false);
  const [bridge, setBridge] = useState(false);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [entry, setEntry] = useState<Entry | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const joinedAt = useRef<number | null>(null);
  const wasMine = useRef(false);

  // Resume: a fan who already waits for THIS host sees "You're #N" straight away (after a refresh or on another device).
  useEffect(() => {
    if (looksSignedOut()) return;
    setBridge(true);
    let live = true;
    void myQueue().then(r => {
      if (!live || !r.ok || !r.data.entry || r.data.entry.hostSlug !== host.slug) return;
      wasMine.current = true; setEntry(r.data.entry); setPhase('waiting');
    });
    return () => { live = false; };
  }, [host.slug]);

  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) d.showModal(); else if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    const onCloseEv = () => setOpen(false);
    d.addEventListener('close', onCloseEv); return () => d.removeEventListener('close', onCloseEv);
  }, []);

  // live position
  useEffect(() => {
    if (phase !== 'waiting') return;
    let alive = true; let inflight = false;
    const tick = async () => {
      if (inflight) return; inflight = true;
      const r = await myQueue(); inflight = false;
      if (!alive || !r.ok) return;
      if (r.data.entry && r.data.entry.hostSlug === host.slug) { setEntry(r.data.entry); }
      else if (wasMine.current) { wasMine.current = false; setEntry(null); setPhase('ended'); }
    };
    const t = setInterval(() => { if (document.visibilityState === 'visible') void tick(); }, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [phase, host.slug]);

  const onClose = useCallback(() => setOpen(false), []);
  const openIt = () => {
    if (looksSignedOut()) { window.location.assign(signInUrl()); return; }
    setBridge(true); setProblem(null); if (phase !== 'waiting') setPhase('confirm'); setOpen(true);
  };
  const join = async () => {
    setBusy(true); setPhase('joining'); setProblem(null);
    const r = await joinQueue(host.slug);
    setBusy(false);
    if (r.ok) {
      joinedAt.current = Date.now(); wasMine.current = true;
      setEntry({ entryId: r.data.entryId, hostSlug: host.slug, hostName: host.displayName, position: r.data.position, status: 'waiting' });
      setPhase('waiting'); capture('hf_web_queue_joined', { host: host.slug, position: r.data.position, waiting: r.data.waiting }); return;
    }
    if (r.status === 401) { window.location.assign(signInUrl()); return; }
    const p = queueJoinProblem(r.code, r.body, name, r.message);
    setProblem({ ...p, book: r.code === 'queue_closed' || r.code === 'queue_full' });
    setPhase('error'); capture('hf_web_queue_failed', { host: host.slug, code: r.code || 'unknown', status: r.status });
  };
  const leave = async () => {
    setBusy(true);
    const r = await leaveQueue(host.slug);
    setBusy(false);
    if (!r.ok && r.status !== 404) { setProblem({ text: 'We could not take you out of the queue. Please try again.' }); setPhase('error'); return; }
    capture('hf_web_queue_left', { host: host.slug, wait_s: joinedAt.current ? Math.round((Date.now() - joinedAt.current) / 1000) : null });
    wasMine.current = false; setEntry(null); setOpen(false); setPhase('confirm');
  };

  const mine = phase === 'waiting' && entry;
  const calling = mine && (entry.status === 'offered' || entry.status === 'connected');
  const label = mine ? (calling ? 'Your turn — we’re calling you' : `You’re #${entry.position} in the queue`) : `Join the queue${waiting ? ` · ${waiting} waiting` : ''}`;
  return <>
    <SessionBridge on={bridge || open} />
    <button type="button" className={btnClass(variant, 'hfc-call hfc-queue')} onClick={openIt}><Icon name="clock" size={22} />{label}</button>
    <dialog ref={ref} className="hfc-dialog" aria-labelledby="hfq-title">
      <div className="hfc-head"><h2 id="hfq-title">{mine ? `${name}’s queue` : `Join ${name}’s queue`}</h2><button type="button" className="hfc-x" aria-label="Close" onClick={onClose}>×</button></div>
      {(phase === 'confirm' || phase === 'joining') && <div className="hfc-body">
        <ul className="hfc-facts">
          <li><Icon name="clock" size={22} /><span>{name} is busy right now. Join the queue and you’ll be called in order.{waiting ? ` ${waiting} ${waiting === 1 ? 'person is' : 'people are'} waiting.` : ''}</span></li>
          <li><Icon name="bell" size={22} /><span>{QUEUE_PROMISE}</span></li>
          <li><Icon name="lock" size={22} /><span><strong>Your number stays hidden.</strong> You can leave the queue any time.</span></li>
        </ul>
        <div className="hfc-actions">
          <button type="button" className="hfc-btn hfc-primary" onClick={join} disabled={busy}>{busy ? 'Joining…' : 'Join the queue'}</button>
          <button type="button" className="hfc-btn" onClick={onClose}>Not now</button>
        </div>
      </div>}
      {phase === 'waiting' && entry && <div className="hfc-body" aria-live="polite">
        {calling
          ? <><p className="hfc-status hfc-pulse">Your turn! We’re calling your phone now. Pick up!</p><p className="hfc-sub">Your number is never shown to {name}.</p></>
          : <><p className="hfc-status hfc-pulse">You’re #{entry.position} in {name}’s queue</p><p className="hfc-sub">{QUEUE_PROMISE} Keep your phone nearby. This page updates by itself.</p></>}
        <div className="hfc-actions">
          {!calling && <button type="button" className="hfc-btn" onClick={leave} disabled={busy}>{busy ? 'Leaving…' : 'Leave the queue'}</button>}
          <button type="button" className="hfc-btn" onClick={onClose}>Hide</button>
        </div>
      </div>}
      {phase === 'ended' && <div className="hfc-body">
        <p className="hfc-status">You’re no longer in the queue.</p>
        <p className="hfc-sub">Nothing was charged for waiting. You can join again, or book a time.</p>
        <div className="hfc-actions">
          <button type="button" className="hfc-btn hfc-primary" onClick={() => setPhase('confirm')}>Join again</button>
          {bookingOn && <a className="hfc-btn" href={bookingHref}>Book a time</a>}
        </div>
      </div>}
      {phase === 'error' && problem && <div className="hfc-body">
        <p className="hfc-status" role="alert">{problem.text}</p>
        {problem.link && <a className="hfc-btn hfc-primary" href={problem.link.href}>{problem.link.label}</a>}
        {problem.book && bookingOn && <a className="hfc-btn" href={bookingHref}>Book a time</a>}
        <div className="hfc-actions"><button type="button" className="hfc-btn" onClick={onClose}>Close</button></div>
      </div>}
    </dialog>
  </>;
}
