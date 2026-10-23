/* [HF-CALL-MODES-E1] The influencer's three-way switch (Online / Bookings only / Offline), the live "On a call" state and the queue card.
 * Mounted by Overview's HostPanel only when hfCallModesEnabled is on; the queue card needs hfCallQueueEnabled too.
 * GET/PUT /api/hosts/me/presence {mode}, GET/PUT /api/hosts/me/queue {paused}. Polls every 10 s while the tab is visible (the existing presence beat stays in HostPanel). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { capture } from '../../../lib/analytics';
import {
  HOST_MODES, MODE_HINT, MODE_LABEL, getHostQueue, getMyPresence, offlineWarning, setMyMode, setQueuePaused,
  type HostMode, type HostPresenceResponse, type HostQueueView,
} from '../../../lib/hfCallModes';
import type { HostPresence } from '../../../lib/hfCallsApi';
import { Marigold } from './ui';

const POLL_MS = 10_000;

export default function HostModes({ queueOn, bookedCount, onPresence }: { queueOn: boolean; bookedCount: number; onPresence?: (p: HostPresence) => void }) {
  const [pres, setPres] = useState<HostPresenceResponse | null>(null);
  const [queue, setQueue] = useState<HostQueueView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);

  const load = useCallback(async () => {
    const p = await getMyPresence();
    if (!live.current) return;
    if (p.ok) { setPres(p.data); setFailed(false); onPresence?.(p.data.presence); } else setFailed(true);
    if (queueOn) { const q = await getHostQueue(); if (live.current && q.ok) setQueue(q.data); }
  }, [queueOn, onPresence]);
  useEffect(() => {
    live.current = true; void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => { live.current = false; clearInterval(t); };
  }, [load]);

  const choose = async (mode: HostMode, confirmed = false) => {
    if (!pres || busy || mode === pres.mode) return;
    if (mode === 'offline' && !confirmed && offlineWarning(bookedCount)) { setConfirmOff(true); return; }
    setConfirmOff(false); setBusy(true); setMsg('');
    const from = pres.mode;
    const r = await setMyMode(mode);
    setBusy(false);
    if (r.ok) { setPres(r.data); onPresence?.(r.data.presence); capture('hf_web_mode_changed', { from, to: r.data.mode }); if (queueOn) void getHostQueue().then(q => { if (live.current && q.ok) setQueue(q.data); }); }
    else setMsg(r.message || 'We could not change that. Please try again.');
  };
  const togglePause = async () => {
    if (!queue || busy) return;
    setBusy(true); setMsg('');
    const r = await setQueuePaused(!queue.paused);
    setBusy(false);
    if (r.ok) { setQueue(r.data); capture('hf_web_queue_paused', { paused: r.data.paused }); }
    else setMsg(r.message || 'We could not change the queue. Please try again.');
  };

  const mode = pres?.mode ?? null;
  const warn = offlineWarning(bookedCount);
  const waiting = queue?.waiting ?? pres?.queue.waiting ?? 0;
  return <>
    <section className="h3-card"><h2><Marigold size={20} />Influencer status</h2>
      <div className="h3-modes" role="radiogroup" aria-label="Your call mode" style={{ marginTop: 12 }}>
        {HOST_MODES.map(m => <button key={m} type="button" role="radio" aria-checked={mode === m} className={`h3-mode${mode === m ? ' is-on' : ''}${m === 'offline' ? ' off' : ''}`}
          disabled={busy || !pres} onClick={() => void choose(m)}>{MODE_LABEL[m]}</button>)}
      </div>
      {pres?.onCall && <p style={{ marginTop: 10 }}><span className="h3-chip miss">On a call</span></p>}
      <p className="small muted" style={{ marginTop: 8 }}>{failed && !pres ? 'We could not load your status. It will retry.' : mode ? MODE_HINT[mode] : 'Loading…'}</p>
      {confirmOff && warn && <div className="h3-modewarn" role="alertdialog" aria-label="Go offline">
        <p><b>{warn}</b> You will not get instant calls, queue or new bookings while you are offline.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="h3-btn sm" onClick={() => void choose('offline', true)} disabled={busy}>Go offline</button>
          <button type="button" className="h3-btn sm ghost" onClick={() => setConfirmOff(false)}>Stay as I am</button>
        </div>
      </div>}
      {msg && <p className="small" style={{ color: 'var(--bad)' }} role="alert">{msg}</p>}
    </section>
    {queueOn && <section className="h3-card h3-queue"><h2><Marigold size={20} tone={1} />Your queue</h2>
      <div className="num" style={{ fontSize: '1.8rem', marginTop: 8 }}>{waiting} <span className="small muted" style={{ fontSize: '1rem' }}>{waiting === 1 ? 'person waiting' : 'people waiting'}</span></div>
      {queue && queue.entries.length > 0
        ? <ol className="h3-queue-list">{queue.entries.slice(0, 10).map(e => <li key={`${e.position}-${e.joinedAt}`}><b>{e.firstName || 'A fan'}</b></li>)}</ol>
        : <p className="small muted" style={{ marginTop: 6 }}>{mode === 'online' ? 'Nobody is waiting. When you are on a call, people can join your queue.' : 'The queue is only open while you are Online.'}</p>}
      {queue?.paused && <p className="small" style={{ marginTop: 6 }}><b>Queue paused.</b> No one new can join and no one is called. Waiting people are kept for a short while.</p>}
      <button type="button" className={`h3-btn sm ${queue?.paused ? '' : 'ghost'}`} style={{ marginTop: 10 }} onClick={() => void togglePause()} disabled={busy || !queue}>{queue?.paused ? 'Resume queue' : 'Pause queue'}</button>
      <p className="small muted" style={{ marginTop: 8 }}>After each call there is a 60-second break, then the next person is called. You only see first names.</p>
    </section>}
  </>;
}
