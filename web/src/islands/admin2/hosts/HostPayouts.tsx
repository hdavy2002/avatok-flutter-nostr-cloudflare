/* HostPayouts — [HF-PAYOUT-1] Admin queue for HF host withdrawals. Manual flow: approve, pay the host yourself (bank transfer / UPI), enter the UTR.
 * Worker: GET /api/admin/hf/payouts?status=, GET /api/admin/hf/payouts/:id/destination, POST /api/admin/hf/payouts/:id/(approve|paid|reject).
 * Full account details are fetched only when you tap "Show payment details" (every view is audit-logged). Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { adminCall } from '../peopleKit';
import { Banner, ConfirmDialog, ConsultShell, Spinner, dateIST, fail, rupees } from '../consultants/kit';
import { DesiCard, DesiChip, DesiEmpty, DesiJourney, DesiSays, DesiSlip } from '../desi';
import { formatPaise } from '../../../lib/money';

const T14 = { fontSize: 14 } as const;
const field = { width: '100%', ...T14, padding: 10, borderRadius: 10, border: '1px solid var(--hf-admin-line)', minHeight: 44 } as const;

type Status = 'requested' | 'approved' | 'paid' | 'rejected' | 'cancelled';
interface Item {
  id: string; hostUid: string; hostName: string | null; hostSlug: string | null; amount: number; status: Status;
  accountLast4: string | null; ifsc: string | null; accountName: string | null; withdrawableAtRequest: number | null;
  utr: string | null; reason: string | null; createdAt: number; paidAt: number | null; exit?: boolean; walletPaise?: number;
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

  const slipTone = it.status === 'requested' ? 'gold' : it.status === 'approved' ? 'lav' : it.status === 'paid' ? 'tea' : 'rani';
  const open = it.status === 'requested' || it.status === 'approved';
  const actions = open ? (
    <>
      {!dest && <button type="button" className="hfa-btn ghost" onClick={() => void showDest()}>Show payment details</button>}
      {it.status === 'requested' && <button type="button" className="hfa-btn tea" disabled={busy} onClick={() => void run(() => post(`${base}/approve`), 'hf_payout_approve')}>{busy ? 'Working…' : 'Approve'}</button>}
      {it.status === 'approved' && <button type="button" className="hfa-btn tea" disabled={busy} onClick={() => { setUtr(''); setDialog('paid'); }}>Mark as paid</button>}
      <button type="button" className="hfa-btn danger" disabled={busy} onClick={() => { setReason(''); setDialog('reject'); }}>Reject</button>
    </>
  ) : undefined;

  return (
    <>
      <DesiSlip tone={slipTone} actions={actions}
        strip={`${TABS.find((t) => t.key === it.status)?.label ?? it.status} · asked ${dateIST(it.createdAt)}`}
        stripRight={<span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          {it.exit && <span title="Final payout: this person is closing their account"><DesiChip tone="plum">Exit</DesiChip></span>}
          <DesiChip tone={it.status === 'paid' ? 'tea' : it.status === 'requested' ? 'gold' : it.status === 'approved' ? 'lav' : 'rani'}>{it.status}</DesiChip>
        </span>}>
        <div className="hfa-amount">{rupees(it.amount)}<small>{it.hostName || it.hostSlug || 'Account holder'}</small></div>
        <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <div className="hfa-note">Could withdraw {rupees(it.withdrawableAtRequest)} at the time</div>
          {(it.walletPaise ?? 0) > 0 && <div style={{ fontSize: 'var(--fs-small)' }}><strong>Includes {formatPaise(it.walletPaise ?? 0)} from their own wallet balance</strong> (money they topped up), the rest {formatPaise(Math.round(it.amount * 100) - (it.walletPaise ?? 0))} is earnings. Pay the full {rupees(it.amount)}.</div>}
          {it.exit && <div style={{ fontSize: 'var(--fs-small)' }}><strong>Account closure:</strong> the account is deleted automatically once this is paid. Rejecting it also lets the closure finish, so give a clear reason.</div>}
          <div className="hfa-says-grid">
            <DesiSays k="Influencer's UPI/bank" tone="lav"
              v={dest ? <>{dest.accountName || '—'}<br />Account {dest.account || '—'} · IFSC {dest.ifsc || '—'}<br />UPI {dest.upi || '—'}{dest.upi ? (dest.upiVerified ? ' (verified)' : ' (not verified)') : ''}</> : <>{it.accountName || 'name not stored'}<br />account ending {it.accountLast4 || '—'} · {it.ifsc || '—'}</>}
              note={dest ? <>Pay exactly <strong>{rupees(dest.amount)}</strong></> : undefined} />
            <DesiSays k="Your bank reference" tone={it.utr ? 'tea' : 'none'}
              v={it.status === 'paid' ? <>UTR {it.utr}</> : 'Not entered yet'}
              note={it.status === 'paid' ? `Paid ${dateIST(it.paidAt)}` : it.status === 'rejected' ? `Reason: ${it.reason}` : undefined} />
          </div>
          <div className="hfa-note" style={{ wordBreak: 'break-all' }}>{it.hostUid}</div>
          {err && <Banner tone="error">{err}</Banner>}
        </div>
      </DesiSlip>

      <ConfirmDialog className="hf-admin-operations" open={dialog === 'paid'} title={`Mark ${rupees(it.amount)} as paid`} confirmLabel="Mark as paid" busy={busy} error={err} disabled={!utrOk}
        body="Only do this after the money has left your bank. The host is told on WhatsApp. This can’t be undone."
        onConfirm={() => void run(() => post(`${base}/paid`, { utr: utr.trim() }), 'hf_payout_paid')} onCancel={() => setDialog(null)}>
        <input aria-label="Bank reference (UTR)" style={field} value={utr} maxLength={30} autoComplete="off" placeholder="Bank reference (UTR), 6 to 30 letters or numbers" onChange={(e) => setUtr(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} />
      </ConfirmDialog>
      <ConfirmDialog className="hf-admin-operations" open={dialog === 'reject'} title="Reject this withdrawal" confirmLabel="Reject" danger busy={busy} error={err} disabled={reason.trim().length < 3}
        body="The money goes back to the host’s available balance. The host sees your reason."
        onConfirm={() => void run(() => post(`${base}/reject`, { reason: reason.trim() }), 'hf_payout_reject')} onCancel={() => setDialog(null)}>
        <input aria-label="Reason" style={field} value={reason} maxLength={200} placeholder="Reason (the host sees this)" onChange={(e) => setReason(e.target.value)} />
      </ConfirmDialog>
    </>
  );
}

export default function HostPayouts() {
  const [tab, setTab] = useState<Status>('requested');
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await adminCall<List>(`/api/admin/hf/payouts?status=${tab}`, { onCached: setData })); } catch (e) { setError(fail('hf_payouts_list', e)); setData({ items: [], counts: {} }); }
  }, [tab]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const n = (k: Status) => data?.counts?.[k]?.n ?? 0;
  const idx = ['requested', 'approved', 'paid'].indexOf(tab);
  return (
    <ConsultShell className="hf-admin-operations">
      <div className="hfa-stack">
        <DesiCard tone="cream" corner="marigold" title="The payout road" note="Every withdrawal walks these four steps. You pay the influencer yourself, then enter the bank reference.">
          <DesiJourney label="Withdrawal steps" steps={[
            { title: 'Requested', note: `${n('requested')} waiting`, tone: 'gold', done: idx >= 0 },
            { title: 'Approved', note: `${n('approved')} to pay`, tone: 'lav', done: idx >= 1 },
            { title: 'Paid by you', note: `${n('paid')} paid`, tone: 'tea', done: idx >= 2 },
            { title: 'UTR entered', note: 'Bank reference saved', tone: 'plum', done: idx >= 2 },
          ]} />
        </DesiCard>
        <div className="hfa-pills" style={{ alignItems: 'center' }}>
          {TABS.map((t) => {
            const c = data?.counts?.[t.key];
            return <button key={t.key} type="button" className="hfa-pill" aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>{t.label}{c ? ` (${c.n})` : ''}</button>;
          })}
          <button type="button" className="hfa-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => void load()}>Refresh</button>
        </div>
        {error && <Banner tone="error">{error}</Banner>}
        {data === null && <Spinner label="Loading withdrawals…" />}
        {data && data.items.length === 0 && !error && <DesiCard tone="lav"><DesiEmpty text="Nothing here." /></DesiCard>}
        <div style={{ display: 'grid', gap: 16 }}>
          {data?.items.map((it) => <Row key={it.id} it={it} onDone={() => void load()} />)}
        </div>
      </div>
    </ConsultShell>
  );
}
