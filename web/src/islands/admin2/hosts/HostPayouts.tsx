/* HostPayouts — [HF-PAYOUT-1] Admin queue for HF host withdrawals. Manual flow: approve, pay the host yourself (bank transfer / UPI), enter the UTR.
 * Worker: GET /api/admin/hf/payouts?status=, GET /api/admin/hf/payouts/:id/destination, POST /api/admin/hf/payouts/:id/(approve|paid|reject).
 * Full account details are fetched only when you tap "Show payment details" (every view is audit-logged). Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { adminCall } from '../peopleKit';
import { Banner, ConfirmDialog, ConsultShell, Spinner, dateIST, fail, rupees } from '../consultants/kit';

const T14 = { fontSize: 14 } as const;
const field = { width: '100%', ...T14, padding: 10, borderRadius: 10, border: '1px solid #c8afd1', minHeight: 44 } as const;

type Status = 'requested' | 'approved' | 'paid' | 'rejected' | 'cancelled';
interface Item {
  id: string; hostUid: string; hostName: string | null; hostSlug: string | null; amount: number; status: Status;
  accountLast4: string | null; ifsc: string | null; accountName: string | null; withdrawableAtRequest: number | null;
  utr: string | null; reason: string | null; createdAt: number; paidAt: number | null;
}
interface Dest { amount: number; accountName: string | null; account: string | null; ifsc: string | null; upi: string | null; upiVerified: boolean }
interface List { items: Item[]; counts: Record<string, { n: number; rupees: number }> }

const TABS: { key: Status; label: string }[] = [
  { key: 'requested', label: 'To approve' }, { key: 'approved', label: 'To pay' }, { key: 'paid', label: 'Paid' }, { key: 'rejected', label: 'Rejected' }, { key: 'cancelled', label: 'Cancelled' },
];
const post = <T,>(path: string, body?: unknown) => adminCall<T>(path, { method: 'POST', body: body ?? {} });

function Row({ it, onDone }: { it: Item; onDone: () => void }) {
  const [dest, setDest] = useState<Dest | null>(null);
  const [dialog, setDialog] = useState<null | 'paid' | 'reject'>(null);
  const [utr, setUtr] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/admin/hf/payouts/${encodeURIComponent(it.id)}`;

  const run = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true); setErr(null);
    try { await fn(); setDialog(null); onDone(); } catch (e) { setErr(fail(label, e)); }
    setBusy(false);
  };
  const showDest = async () => {
    setErr(null);
    try { setDest(await adminCall<Dest>(`${base}/destination`)); } catch (e) { setErr(fail('hf_payout_destination', e)); }
  };
  const utrOk = /^[A-Za-z0-9]{6,30}$/.test(utr.trim());

  return (
    <div className="card" style={{ background: '#fff', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 16 }}>{it.hostName || it.hostSlug || 'Host'}</strong>
        <strong style={{ fontSize: 18 }}>{rupees(it.amount)}</strong>
      </div>
      <div style={{ ...T14, display: 'grid', gap: 2 }}>
        <span>Asked {dateIST(it.createdAt)} · could withdraw {rupees(it.withdrawableAtRequest)} at the time</span>
        <span>Bank: {it.accountName || 'name not stored'} · account ending {it.accountLast4 || '—'} · {it.ifsc || '—'}</span>
        {it.status === 'paid' && <span>Paid {dateIST(it.paidAt)} · UTR {it.utr}</span>}
        {it.status === 'rejected' && <span>Reason: {it.reason}</span>}
        <span className="muted" style={{ wordBreak: 'break-all' }}>{it.hostUid}</span>
      </div>

      {(it.status === 'requested' || it.status === 'approved') && (
        <>
          {dest ? (
            <div style={{ ...T14, background: '#f8f1fa', borderRadius: 10, padding: 10, display: 'grid', gap: 2, wordBreak: 'break-all' }}>
              <span>Name at bank: <strong>{dest.accountName || '—'}</strong></span>
              <span>Account: <strong>{dest.account || '—'}</strong> · IFSC <strong>{dest.ifsc || '—'}</strong></span>
              <span>UPI: <strong>{dest.upi || '—'}</strong>{dest.upi ? (dest.upiVerified ? ' (verified)' : ' (not verified)') : ''}</span>
              <span>Pay exactly <strong>{rupees(dest.amount)}</strong></span>
            </div>
          ) : (
            <div><button type="button" className="btn ghost small" style={{ ...T14, minHeight: 44 }} onClick={() => void showDest()}>Show payment details</button></div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {it.status === 'requested' && <button type="button" className="btn small" style={{ ...T14, minHeight: 44 }} disabled={busy} onClick={() => void run(() => post(`${base}/approve`), 'hf_payout_approve')}>{busy ? 'Working…' : 'Approve'}</button>}
            {it.status === 'approved' && <button type="button" className="btn small" style={{ ...T14, minHeight: 44 }} disabled={busy} onClick={() => { setUtr(''); setDialog('paid'); }}>Mark as paid</button>}
            <button type="button" className="btn ghost small" style={{ ...T14, minHeight: 44 }} disabled={busy} onClick={() => { setReason(''); setDialog('reject'); }}>Reject</button>
          </div>
        </>
      )}
      {err && <Banner tone="error">{err}</Banner>}

      <ConfirmDialog open={dialog === 'paid'} title={`Mark ${rupees(it.amount)} as paid`} confirmLabel="Mark as paid" busy={busy} error={err} disabled={!utrOk}
        body="Only do this after the money has left your bank. The host is told on WhatsApp. This can’t be undone."
        onConfirm={() => void run(() => post(`${base}/paid`, { utr: utr.trim() }), 'hf_payout_paid')} onCancel={() => setDialog(null)}>
        <input aria-label="Bank reference (UTR)" style={field} value={utr} maxLength={30} autoComplete="off" placeholder="Bank reference (UTR), 6 to 30 letters or numbers" onChange={(e) => setUtr(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} />
      </ConfirmDialog>
      <ConfirmDialog open={dialog === 'reject'} title="Reject this withdrawal" confirmLabel="Reject" danger busy={busy} error={err} disabled={reason.trim().length < 3}
        body="The money goes back to the host’s available balance. The host sees your reason."
        onConfirm={() => void run(() => post(`${base}/reject`, { reason: reason.trim() }), 'hf_payout_reject')} onCancel={() => setDialog(null)}>
        <input aria-label="Reason" style={field} value={reason} maxLength={200} placeholder="Reason (the host sees this)" onChange={(e) => setReason(e.target.value)} />
      </ConfirmDialog>
    </div>
  );
}

export default function HostPayouts() {
  const [tab, setTab] = useState<Status>('requested');
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await adminCall<List>(`/api/admin/hf/payouts?status=${tab}`)); } catch (e) { setError(fail('hf_payouts_list', e)); setData({ items: [], counts: {} }); }
  }, [tab]);
  useEffect(() => { setData(null); void load(); }, [load]);

  return (
    <ConsultShell>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        {TABS.map((t) => {
          const c = data?.counts?.[t.key];
          return <button key={t.key} type="button" className={`btn small${tab === t.key ? '' : ' ghost'}`} style={{ ...T14, minHeight: 44 }} aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>{t.label}{c ? ` (${c.n})` : ''}</button>;
        })}
        <button type="button" className="btn ghost small" style={{ ...T14, minHeight: 44, marginLeft: 'auto' }} onClick={() => void load()}>Refresh</button>
      </div>
      {error && <div style={{ marginBottom: 12 }}><Banner tone="error">{error}</Banner></div>}
      {data === null && <Spinner label="Loading withdrawals…" />}
      {data && data.items.length === 0 && !error && <div className="card muted" style={{ fontWeight: 700, ...T14 }}>Nothing here.</div>}
      <div style={{ display: 'grid', gap: 10 }}>
        {data?.items.map((it) => <Row key={it.id} it={it} onDone={() => void load()} />)}
      </div>
    </ConsultShell>
  );
}
