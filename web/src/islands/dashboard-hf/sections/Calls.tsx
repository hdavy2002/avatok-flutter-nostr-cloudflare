/* [HF-DASH-SHELL-2] Calls screen. Calls you made come from wallet history (completed, charged calls only, until the
 * caller call-history route lands: HF-DASH-CALLS-1); calls you received come from GET /api/hosts/me/calls. */
import { useEffect, useState } from 'react';
import { fetchWallet, hfCall, relDate, type WalletHistoryItem } from '../../../lib/hfCallsApi';
import { formatPaise } from '../../../lib/money';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { parseCalls, rowText, type Row } from '../hostActivity';

export default function Calls({ account }: { account: DashboardAccount }) {
  const isLive = account.host?.status === 'live' && !account.closing;
  const [tab, setTab] = useState<'made' | 'received'>(() => (new URLSearchParams(location.search).get('role') === 'host' && isLive ? 'received' : 'made'));
  const [made, setMade] = useState<WalletHistoryItem[] | null>(null);
  const [received, setReceived] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    void (async () => {
      try {
        if (tab === 'made') {
          const w = await fetchWallet();
          if (!live) return;
          if (w.ok) setMade(w.data.history.filter(h => h.kind === 'call_spent' || h.kind === 'call_refund'));
          else setError('We could not load your calls. Please try again.');
        } else {
          const r = await hfCall<unknown>('GET', '/api/hosts/me/calls');
          if (!live) return;
          if (r.ok) setReceived(parseCalls(r.data).rows);
          else setError('We could not load your calls. Please try again.');
        }
      } catch { if (live) setError('We could not reach the server. Please try again.'); }
    })();
    return () => { live = false; };
  }, [tab, retry, account.uid]);
  return <div className="hfd-section">
    <header className="hfd-section-head"><h1>Calls</h1><p>Your recent calls. You only ever see a handle, never a phone number. Calls are not recorded.</p></header>
    {isLive && <div className="hfd-tabs" role="tablist" aria-label="Call history">
      <button type="button" role="tab" aria-selected={tab === 'made'} onClick={() => setTab('made')}>Calls you made</button>
      <button type="button" role="tab" aria-selected={tab === 'received'} onClick={() => setTab('received')}>Calls you received</button>
    </div>}
    <section className="hfc-card" aria-live="polite">
      {error ? <p role="alert">{error} <button type="button" className="hfb-text-button" onClick={() => setRetry(n => n + 1)}>Retry</button></p>
        : tab === 'made' ? (made == null ? <p role="status">Loading calls…</p> : made.length === 0 ? <div className="hfd-empty"><span aria-hidden="true">♡</span><p>No calls yet.</p><a href="/marketplace">Explore hosts →</a></div>
          : <ul className="hfc-calls">{made.map((h, i) => <li key={`${h.at}-${h.callId ?? i}`}><strong>{h.kind === 'call_refund' ? 'Call charge corrected' : h.label}</strong><span>{h.amount ?? (h.amountPaise != null ? formatPaise(h.amountPaise) : h.tokens ?? '')}</span><small>{relDate(h.at)}</small></li>)}</ul>)
          : (received == null ? <p role="status">Loading calls…</p> : received.length === 0 ? <div className="hfd-empty"><span aria-hidden="true">♡</span><p>No calls received yet.</p></div>
            : <ul className="hfc-calls">{received.map(r => <li key={r.id}><strong>{r.handle}</strong><span>{rowText(r)}</span>{r.at && <small>{relDate(r.at)}</small>}</li>)}</ul>)}
    </section>
  </div>;
}
