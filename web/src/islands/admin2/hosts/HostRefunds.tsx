/* HostRefunds — [HF-WALLET-EXIT-1] Admin queue for refunds of unused wallet top-ups (and account-closure refunds).
 * Worker: GET /api/admin/hf/refunds?status=, POST /api/admin/hf/refunds/:id/(approve|retry|reject|paid-manually).
 * Approve sends each top-up slice back to the ORIGINAL payment through its gateway. If a slice fails (or the top-up is too old for
 * the gateway) use "Mark paid by hand" after you have paid the person yourself and enter the bank reference (UTR). Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { adminCall } from '../peopleKit';
import { Banner, ConfirmDialog, ConsultShell, Spinner, dateIST, fail, rupees } from '../consultants/kit';

const T14 = { fontSize: 14 } as const;
const field = { width: '100%', ...T14, padding: 10, borderRadius: 10, border: '1px solid #c8afd1', minHeight: 44 } as const;

type Status = 'requested' | 'processing' | 'failed' | 'refunded' | 'rejected' | 'cancelled';
interface Alloc { topupId: string | null; rupees: number; status: 'pending' | 'refunded' | 'manual' | 'failed'; gatewayRefundId?: string | null; error?: string }
interface Item {
  id: string; uid: string; amount: number; status: Status | 'approved'; exit: boolean; utr: string | null; reason: string | null;
  allocations: Alloc[]; createdAt: number; refundedAt: number | null;
}
interface List { items: Item[]; counts: Record<string, { n: number; rupees: number }> }

const TABS: { key: Status; label: string }[] = [
  { key: 'requested', label: 'To approve' }, { key: 'failed', label: 'Needs attention' }, { key: 'processing', label: 'Processing' },
  { key: 'refunded', label: 'Refunded' }, { key: 'rejected', label: 'Rejected' }, { key: 'cancelled', label: 'Cancelled' },
];
const post = <T,>(path: string, body?: unknown) => adminCall<T>(path, { method: 'POST', body: body ?? {} });
const allocLabel: Record<Alloc['status'], string> = { pending: 'waiting', refunded: 'sent to the original payment', manual: 'paid by hand', failed: 'failed' };

function Row({ it, onDone }: { it: Item; onDone: () => void }) {
  const [dialog, setDialog] = useState<null | 'manual' | 'reject'>(null);
  const [utr, setUtr] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const base = `/api/admin/hf/refunds/${encodeURIComponent(it.id)}`;
  const open = it.status === 'requested' || it.status === 'approved' || it.status === 'failed';
  const utrOk = /^[A-Za-z0-9]{6,30}$/.test(utr.trim());

  const run = async (fn: () => Promise<{ status?: string } | unknown>, label: string) => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = (await fn()) as { status?: string };
      setDialog(null);
      if (r?.status === 'failed') setNote('The gateway did not accept every part. See the list below, then retry or mark it paid by hand.');
      onDone();
    } catch (e) { setErr(fail(label, e)); }
    setBusy(false);
  };

  return (
    <div className="card" style={{ background: '#fff', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 16 }}>
          Refund
          {it.exit && <span style={{ ...T14, marginLeft: 8, padding: '2px 8px', borderRadius: 999, background: '#f2ecfc', color: '#46113e' }} title="Account closure: the account is deleted once this is settled">Exit</span>}
        </strong>
        <strong style={{ fontSize: 18 }}>{rupees(it.amount)}</strong>
      </div>
      <div style={{ ...T14, display: 'grid', gap: 2 }}>
        <span>Asked {dateIST(it.createdAt)}</span>
        {it.status === 'refunded' && <span>Settled {dateIST(it.refundedAt)}{it.utr ? ` · paid by hand · UTR ${it.utr}` : ''}</span>}
        {it.status === 'rejected' && <span>Reason: {it.reason}</span>}
        {it.exit && open && <span><strong>Account closure:</strong> the account is deleted automatically after this is settled. Rejecting it also lets the closure finish.</span>}
        <span className="muted" style={{ wordBreak: 'break-all' }}>{it.uid}</span>
      </div>
      <ul style={{ ...T14, margin: 0, paddingLeft: 18, display: 'grid', gap: 2 }}>
        {it.allocations.map((a, i) => (
          <li key={`${a.topupId ?? 'manual'}-${i}`}>
            {rupees(a.rupees)} {a.topupId ? <>back to the payment <span className="muted" style={{ wordBreak: 'break-all' }}>{a.topupId}</span></> : <strong>no payment to return it to: pay by hand</strong>} · {allocLabel[a.status]}
            {a.error ? ` (${a.error})` : ''}{a.gatewayRefundId ? ` · ${a.gatewayRefundId}` : ''}
          </li>
        ))}
      </ul>

      {open && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn small" style={{ ...T14, minHeight: 44 }} disabled={busy}
            onClick={() => void run(() => post(`${base}/${it.status === 'failed' ? 'retry' : 'approve'}`), 'hf_refund_approve')}>
            {busy ? 'Working…' : it.status === 'failed' ? 'Retry' : 'Approve and refund'}
          </button>
          <button type="button" className="btn ghost small" style={{ ...T14, minHeight: 44 }} disabled={busy} onClick={() => { setUtr(''); setDialog('manual'); }}>Mark paid by hand</button>
          <button type="button" className="btn ghost small" style={{ ...T14, minHeight: 44 }} disabled={busy} onClick={() => { setReason(''); setDialog('reject'); }}>Reject</button>
        </div>
      )}
      {note && <Banner tone="info">{note}</Banner>}
      {err && <Banner tone="error">{err}</Banner>}

      <ConfirmDialog open={dialog === 'manual'} title={`Mark ${rupees(it.amount)} as paid by hand`} confirmLabel="Mark as paid" busy={busy} error={err} disabled={!utrOk}
        body="Only do this after the money has reached the person. Every part still waiting is marked as paid by hand. This can’t be undone."
        onConfirm={() => void run(() => post(`${base}/paid-manually`, { utr: utr.trim() }), 'hf_refund_manual')} onCancel={() => setDialog(null)}>
        <input aria-label="Bank reference (UTR)" style={field} value={utr} maxLength={30} autoComplete="off" placeholder="Bank reference (UTR), 6 to 30 letters or numbers" onChange={(e) => setUtr(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} />
      </ConfirmDialog>
      <ConfirmDialog open={dialog === 'reject'} title="Reject this refund" confirmLabel="Reject" danger busy={busy} error={err} disabled={reason.trim().length < 3}
        body="The money stays in the person’s wallet. They see your reason. You can’t reject once part of it has already been sent."
        onConfirm={() => void run(() => post(`${base}/reject`, { reason: reason.trim() }), 'hf_refund_reject')} onCancel={() => setDialog(null)}>
        <input aria-label="Reason" style={field} value={reason} maxLength={200} placeholder="Reason (the person sees this)" onChange={(e) => setReason(e.target.value)} />
      </ConfirmDialog>
    </div>
  );
}

export default function HostRefunds() {
  const [tab, setTab] = useState<Status>('requested');
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await adminCall<List>(`/api/admin/hf/refunds?status=${tab}`)); } catch (e) { setError(fail('hf_refunds_list', e)); setData({ items: [], counts: {} }); }
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
      {data === null && <Spinner label="Loading refunds…" />}
      {data && data.items.length === 0 && !error && <div className="card muted" style={{ fontWeight: 700, ...T14 }}>Nothing here.</div>}
      <div style={{ display: 'grid', gap: 10 }}>
        {data?.items.map((it) => <Row key={it.id} it={it} onDone={() => void load()} />)}
      </div>
    </ConsultShell>
  );
}
