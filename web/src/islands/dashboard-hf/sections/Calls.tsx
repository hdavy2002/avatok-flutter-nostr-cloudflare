/* [HF-DASH-CALLS-1] Calls screen: calls you made and calls you received, every outcome, paginated, from GET /api/hf/calls. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { hfCall, relDate } from '../../../lib/hfCallsApi';
import { formatPaise } from '../../../lib/money';
import { capture, captureException } from '../../../lib/analytics';
import type { DashboardAccount } from '../../../components/account/DashboardNav';

type Role = 'caller' | 'host';
type Filter = 'all' | 'completed' | 'missed';
interface Item { id: string; status: string; otherHandle: string; hostSlug: string | null; at: number; seconds: number; amountPaise: number | null; endReason: string | null }
interface Page { items: Item[]; nextCursor: string | null }

const FILTERS: { id: Filter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'completed', label: 'Completed' }, { id: 'missed', label: 'Missed' }];

function outcome(i: Item, role: Role): string {
  switch (i.status) {
    case 'completed': {
      const dur = i.seconds > 0 ? `${Math.floor(i.seconds / 60)} min ${i.seconds % 60} s` : 'Very short call';
      return `${dur}${i.amountPaise != null ? ` · ${formatPaise(i.amountPaise)}` : ''}`;
    }
    case 'connected': return 'On a call now';
    case 'ringing_host': case 'ringing_caller': return 'Ringing';
    case 'host_declined': return role === 'host' ? 'You declined' : 'Declined by the influencer';
    case 'no_answer': return role === 'host' ? 'Missed' : 'Not answered';
    case 'caller_no_answer': return role === 'host' ? 'Caller didn’t pick up' : 'You didn’t pick up';
    case 'cancelled': return role === 'host' ? 'Cancelled by the caller' : 'You cancelled';
    case 'blocked': return 'Ended and blocked';
    default: return 'Not connected';
  }
}

export default function Calls({ account }: { account: DashboardAccount }) {
  const isHost = !!account.host && !account.closing;
  const [role, setRole] = useState<Role>(() => (new URLSearchParams(location.search).get('role') === 'host' && isHost ? 'host' : 'caller'));
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<Item[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [off, setOff] = useState(false);
  const [more, setMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const seq = useRef(0);

  const load = useCallback(async (cursor: string | null) => {
    const my = ++seq.current;
    const t0 = Date.now();
    setError('');
    if (cursor) setMore(true); else { setItems(null); setNext(null); }
    try {
      const qs = new URLSearchParams({ role, status: filter, limit: '20' });
      if (cursor) qs.set('cursor', cursor);
      const r = await hfCall<{ items?: Item[]; nextCursor?: string | null }>('GET', `/api/hf/calls?${qs}`);
      if (my !== seq.current) return;
      if (!r.ok) {
        if (r.status === 404 || r.status === 503) { setOff(true); return; }
        captureException(new Error(`hf_calls_list ${r.status} ${r.code}`), { area: 'hf_dashboard', step: 'calls_list', role, status: r.status });
        setError('We could not load your calls. Please try again.');
        if (!cursor) setItems([]);
        return;
      }
      const page: Page = { items: Array.isArray(r.data.items) ? r.data.items : [], nextCursor: r.data.nextCursor ?? null };
      setOff(false);
      setItems(prev => (cursor && prev ? [...prev, ...page.items] : page.items));
      setNext(page.nextCursor);
      capture('hf_calls_list_load', { role, status: filter, count: page.items.length, ms: Date.now() - t0 });
    } catch (e) {
      if (my !== seq.current) return;
      captureException(e, { area: 'hf_dashboard', step: 'calls_list', role });
      setError('We could not reach the server. Please try again.');
      if (!cursor) setItems([]);
    } finally { if (my === seq.current) setMore(false); }
  }, [role, filter]);

  useEffect(() => { void load(null); }, [load, retry, account.uid]);

  const loading = items == null;
  return <div className="hfd-section">
    <header className="hfd-section-head"><h1>Calls</h1><p>Your calls, including ones that did not connect. You only ever see a handle, never a phone number. Calls are not recorded.</p></header>
    {off ? <section className="hfc-card"><p role="status">Calls are not available right now. Please check back soon.</p></section> : <>
      {isHost && <div className="hfd-tabs" role="tablist" aria-label="Call history">
        <button type="button" role="tab" aria-selected={role === 'caller'} onClick={() => setRole('caller')}>Calls you made</button>
        <button type="button" role="tab" aria-selected={role === 'host'} onClick={() => setRole('host')}>Calls you received</button>
      </div>}
      <div className="hfd-tabs hfd-chips" role="group" aria-label="Filter calls" style={{ margin: '12px 0' }}>
        {FILTERS.map(f => <button key={f.id} type="button" aria-pressed={filter === f.id} aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
      </div>
      <section className="hfc-card" aria-live="polite">
        {error && <p role="alert">{error} <button type="button" className="hfb-text-button" onClick={() => (items && items.length ? void load(next) : setRetry(n => n + 1))}>Retry</button></p>}
        {loading ? <p role="status">Loading calls…</p>
          : items.length === 0 && !error ? <div className="hfd-empty"><span aria-hidden="true">♡</span>
            <p>{filter === 'all' ? (role === 'host' ? 'No calls received yet.' : 'No calls yet.') : `No ${filter} calls to show.`}</p>
            {role === 'caller' && <a href="/marketplace">Explore influencers →</a>}</div>
          : <>
            <ul className="hfc-calls">{items.map(i => <li key={i.id}>
              <strong>{role === 'caller' && i.hostSlug ? <a href={`/h/${i.hostSlug}`}>{i.otherHandle}</a> : i.otherHandle}</strong>
              <span>{outcome(i, role)}</span><small>{relDate(i.at)}</small></li>)}</ul>
            {next && <button type="button" className="hfb-text-button" disabled={more} onClick={() => void load(next)}>{more ? 'Loading…' : 'Load more'}</button>}
          </>}
      </section>
    </>}
  </div>;
}
