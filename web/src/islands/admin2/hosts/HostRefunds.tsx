/* HostRefunds — [HF-WALLET-EXIT-1] Admin queue for refunds of unused wallet top-ups (and account-closure refunds).
 * Worker: GET /api/admin/hf/refunds?status=, POST /api/admin/hf/refunds/:id/(approve|retry|reject|paid-manually).
 * Approve sends each top-up slice back to the ORIGINAL payment through its gateway. If a slice fails (or the top-up is too old for
 * the gateway) use "Mark paid by hand" after you have paid the person yourself and enter the bank reference (UTR). Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { adminCall } from '../peopleKit';
import { Banner, ConfirmDialog, ConsultShell, Spinner, dateIST, fail } from '../consultants/kit';
import { DesiCard, DesiChip, DesiEmpty, DesiSlip } from '../desi';
import { formatPaise } from '../../../lib/money';

/** [HF-STD-PLAN-1] rupees with paise (the shared helper rounds to whole rupees). */
const rupees = (n: number | null | undefined): string => (n == null ? '—' : formatPaise(Math.round(n * 100)));

const paiseRupees = (p: number) => rupees(p / 100);
const T14 = { fontSize: 14 } as const;
const field = { width: '100%', ...T14, padding: 10, borderRadius: 10, border: '1px solid var(--hf-admin-line)', minHeight: 44 } as const;

type Status = 'requested' | 'processing' | 'failed' | 'refunded' | 'rejected' | 'cancelled';
interface Alloc { topupId: string | null; rupees: number; status: 'pending' | 'submitting' | 'needs_check' | 'refunded' | 'manual' | 'failed'; gatewayRefundId?: string | null; error?: string }
interface Item {
  id: string; uid: string; amount: number; status: Status | 'approved'; exit: boolean; utr: string | null; reason: string | null;
  allocations: Alloc[]; createdAt: number; refundedAt: number | null;
  /* [HF-TOK-EXIT-1] Google Play refund of unused tokens: amountPaise is the unspent share owed; no gateway slices. */
  kind?: 'play_refund'; amountPaise?: number; orderId?: string | null; lotId?: string | null; recordedPaise?: number | null;
  lot?: { status: string; paidPaise: number; tokensBought: string; tokensLeft: string; wholeOrder: boolean; currentSharePaise: number } | null;
}
interface List { items: Item[]; counts: Record<string, { n: number; rupees: number }> }

const TABS: { key: Status; label: string }[] = [
  { key: 'requested', label: 'To approve' }, { key: 'failed', label: 'Needs attention' }, { key: 'processing', label: 'Processing' },
  { key: 'refunded', label: 'Refunded' }, { key: 'rejected', label: 'Rejected' }, { key: 'cancelled', label: 'Cancelled' },
];
const post = <T,>(path: string, body?: unknown) => adminCall<T>(path, { method: 'POST', body: body ?? {} });
const allocLabel: Record<Alloc['status'], string> = {
  pending: 'waiting', submitting: 'sending (interrupted: check before resending)', needs_check: 'NEEDS CHECK: we could not confirm whether the gateway already sent it',
  refunded: 'sent to the original payment', manual: 'paid by hand', failed: 'failed',
};

function Row({ it, onDone }: { it: Item; onDone: () => void }) {
  const [dialog, setDialog] = useState<null | 'manual' | 'reject' | 'playhand'>(null);
  const [recorded, setRecorded] = useState('');
  const [playNote, setPlayNote] = useState('');
  const [slice, setSlice] = useState<null | { topupId: string; mode: 'sent' | 'resend' }>(null);
  const [utr, setUtr] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const base = `/api/admin/hf/refunds/${encodeURIComponent(it.id)}`;
  const open = it.status === 'requested' || it.status === 'approved' || it.status === 'failed';
  const play = it.kind === 'play_refund';
  const owedPaise = it.amountPaise ?? 0;
  const recordedPaise = Math.round(Number(recorded) * 100);
  const recordedOk = Number.isFinite(recordedPaise) && recordedPaise >= 1 && recordedPaise <= owedPaise && (recordedPaise === owedPaise || playNote.trim().length >= 5);
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

  const failed = it.status === 'failed';
  const tone = it.status === 'refunded' ? 'tea' : it.status === 'processing' ? 'lav' : it.status === 'requested' || failed ? 'rani' : 'gold';
  const actions = (open && play) ? (
    <>
      {it.lot?.wholeOrder && (
        <button type="button" className="hfa-btn tea" disabled={busy}
          onClick={() => void run(() => post(`${base}/play-confirm`), 'hf_play_refund')}>{busy ? 'Working…' : 'Refund through Google Play'}</button>
      )}
      <button type="button" className={`hfa-btn${it.lot?.wholeOrder ? ' ghost' : ' tea'}`} disabled={busy} onClick={() => { setRecorded(String(owedPaise / 100)); setPlayNote(''); setDialog('playhand'); }}>I refunded it in the Play Console</button>
      <button type="button" className="hfa-btn danger" disabled={busy} onClick={() => { setReason(''); setDialog('reject'); }}>Reject</button>
    </>
  ) : open ? (
    <>
      <button type="button" className={`hfa-btn ${failed ? 'rani' : 'tea'}`} disabled={busy}
        onClick={() => void run(() => post(`${base}/${failed ? 'retry' : 'approve'}`), 'hf_refund_approve')}>
        {busy ? 'Working…' : failed ? 'Retry' : 'Approve and refund'}
      </button>
      <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => { setUtr(''); setDialog('manual'); }}>Mark paid by hand</button>
      <button type="button" className="hfa-btn danger" disabled={busy} onClick={() => { setReason(''); setDialog('reject'); }}>Reject</button>
    </>
  ) : undefined;

  return (
    <>
      <div style={failed ? { borderRadius: 22, boxShadow: '0 0 0 3px var(--a-bad,#c0262d)' } : undefined}>
      <DesiSlip tone={tone} actions={actions}
        strip={`${play ? 'Google Play refund' : 'Refund'} · asked ${dateIST(it.createdAt)}`}
        stripRight={<span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          {it.exit && <span title="Account closure: the account is deleted once this is settled"><DesiChip tone="plum">Exit</DesiChip></span>}
          <DesiChip tone={failed ? 'red' : it.status === 'refunded' ? 'tea' : it.status === 'requested' ? 'rani' : it.status === 'processing' ? 'lav' : 'grey'}>{it.status}</DesiChip>
        </span>}>
        <div className="hfa-amount">{play ? paiseRupees(owedPaise) : rupees(it.amount)}<small>{play ? 'Refund through Google Play' : 'Refund'}</small></div>
        <div style={{ display: 'grid', gap: 8, minWidth: 0, fontSize: 'var(--fs-small)' }}>
          {it.status === 'refunded' && <span>Settled {dateIST(it.refundedAt)}{it.utr ? ` · paid by hand · UTR ${it.utr}` : ''}</span>}
          {it.status === 'rejected' && <span>Reason: {it.reason}</span>}
          {it.exit && open && <span><strong>Account closure:</strong> the account is deleted automatically after this is settled. Rejecting it also lets the closure finish.</span>}
          {play && it.orderId && <span>Google Play order <span style={{ wordBreak: 'break-all' }}>{it.orderId}</span></span>}
          {play && it.lot && <span>Added ₹{it.lot.tokensBought} to the wallet for {paiseRupees(it.lot.paidPaise)} · ₹{it.lot.tokensLeft} left · {it.lot.wholeOrder ? 'nothing used yet: the whole order can be refunded' : 'part used: refund this share in the Play Console and record it here'}</span>}
          {play && it.status === 'refunded' && it.recordedPaise != null && <span>Recorded refund {paiseRupees(it.recordedPaise)}</span>}
          <span className="hfa-note" style={{ wordBreak: 'break-all' }}>{it.uid}</span>
          {!play && <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
            {it.allocations.map((a, i) => {
              const bad = a.status === 'failed' || a.status === 'needs_check';
              const good = a.status === 'refunded' || a.status === 'manual';
              return (
                <li key={`${a.topupId ?? 'manual'}-${i}`} style={{ padding: '10px 12px', borderRadius: 14, background: bad ? 'var(--a-blush,#ffe6ef)' : good ? 'var(--a-teatint,#e3f5f6)' : 'var(--a-goldtint,#fff1d6)', border: bad ? '1.5px dashed #f2a9c8' : '1px solid var(--a-line,#f1e3d6)' }}>
                  <strong>{rupees(a.rupees)}</strong> {a.topupId ? <>back to the payment <span className="hfa-note" style={{ wordBreak: 'break-all' }}>{a.topupId}</span></> : <strong>no payment to return it to: pay by hand</strong>} · {allocLabel[a.status]}
                  {a.error ? ` (${a.error})` : ''}{a.gatewayRefundId ? ` · ${a.gatewayRefundId}` : ''}
                  {(a.status === 'needs_check' || a.status === 'submitting') && a.topupId && open && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                      <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setSlice({ topupId: a.topupId!, mode: 'sent' })}>I checked: it was sent</button>
                      <button type="button" className="hfa-btn danger" disabled={busy} onClick={() => setSlice({ topupId: a.topupId!, mode: 'resend' })}>Send it again</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>}
          {note && <Banner tone="info">{note}</Banner>}
          {err && <Banner tone="error">{err}</Banner>}
        </div>
      </DesiSlip>
      </div>

      <ConfirmDialog className="hf-admin-operations" open={dialog === 'playhand'} title="Record the Play Console refund" confirmLabel="Record and remove the money" busy={busy} error={err} disabled={!recordedOk}
        body={`Only do this after you refunded the person in the Google Play Console. The unused wallet money is then removed from their account. Owed: ${paiseRupees(owedPaise)}. If you refunded less, write a note.`}
        onConfirm={() => void run(() => post(`${base}/play-confirm`, { manual: true, recordedPaise, note: playNote.trim() || undefined }), 'hf_play_refund_manual')} onCancel={() => setDialog(null)}>
        <input aria-label="Rupees you refunded" style={field} value={recorded} inputMode="decimal" autoComplete="off" placeholder="Rupees you refunded" onChange={(e) => setRecorded(e.target.value.replace(/[^0-9.]/g, ''))} />
        <input aria-label="Note" style={{ ...field, marginTop: 8 }} value={playNote} maxLength={200} placeholder="Note (needed if less than owed)" onChange={(e) => setPlayNote(e.target.value)} />
      </ConfirmDialog>
      <ConfirmDialog className="hf-admin-operations" open={slice?.mode === 'sent'} title="Record this part as already sent" confirmLabel="Yes, it was sent" busy={busy} error={err}
        body="Only do this after you looked in the payment gateway’s dashboard and saw this refund there. The rest of the refund then continues."
        onConfirm={() => void run(() => post(`${base}/mark-sent`, { topupId: slice!.topupId }), 'hf_refund_mark_sent').then(() => setSlice(null))} onCancel={() => setSlice(null)} />
      <ConfirmDialog className="hf-admin-operations" open={slice?.mode === 'resend'} title="Send this part again" confirmLabel="Send again" danger busy={busy} error={err}
        body="Only do this after you looked in the payment gateway’s dashboard and saw NO refund for this part. Sending it when one already exists could pay the person twice."
        onConfirm={() => void run(() => post(`${base}/retry`, { resubmit: [slice!.topupId] }), 'hf_refund_resend').then(() => setSlice(null))} onCancel={() => setSlice(null)} />
      <ConfirmDialog className="hf-admin-operations" open={dialog === 'manual'} title={`Mark ${rupees(it.amount)} as paid by hand`} confirmLabel="Mark as paid" busy={busy} error={err} disabled={!utrOk}
        body="Only do this after the money has reached the person. Every part still waiting is marked as paid by hand. This can’t be undone."
        onConfirm={() => void run(() => post(`${base}/paid-manually`, { utr: utr.trim() }), 'hf_refund_manual')} onCancel={() => setDialog(null)}>
        <input aria-label="Bank reference (UTR)" style={field} value={utr} maxLength={30} autoComplete="off" placeholder="Bank reference (UTR), 6 to 30 letters or numbers" onChange={(e) => setUtr(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} />
      </ConfirmDialog>
      <ConfirmDialog className="hf-admin-operations" open={dialog === 'reject'} title="Reject this refund" confirmLabel="Reject" danger busy={busy} error={err} disabled={reason.trim().length < 3}
        body="The money stays in the person’s wallet. They see your reason. You can’t reject once part of it has already been sent."
        onConfirm={() => void run(() => post(`${base}/reject`, { reason: reason.trim() }), 'hf_refund_reject')} onCancel={() => setDialog(null)}>
        <input aria-label="Reason" style={field} value={reason} maxLength={200} placeholder="Reason (the person sees this)" onChange={(e) => setReason(e.target.value)} />
      </ConfirmDialog>
    </>
  );
}

export default function HostRefunds() {
  const [tab, setTab] = useState<Status>('requested');
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await adminCall<List>(`/api/admin/hf/refunds?status=${tab}`, { onCached: setData })); } catch (e) { setError(fail('hf_refunds_list', e)); setData({ items: [], counts: {} }); }
  }, [tab]);
  useEffect(() => { setData(null); void load(); }, [load]);

  return (
    <ConsultShell className="hf-admin-operations">
      <div className="hfa-stack">
        <div className="hfa-pills" style={{ alignItems: 'center' }}>
          {TABS.map((t) => {
            const c = data?.counts?.[t.key];
            return <button key={t.key} type="button" className="hfa-pill" aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>{t.label}{c ? ` (${c.n})` : ''}</button>;
          })}
          <button type="button" className="hfa-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => void load()}>Refresh</button>
        </div>
        {error && <Banner tone="error">{error}</Banner>}
        {data === null && <Spinner label="Loading refunds…" />}
        {data && data.items.length === 0 && !error && <DesiCard tone="lav" corner="jasmine"><DesiEmpty text="Nothing here." /></DesiCard>}
        <div style={{ display: 'grid', gap: 16 }}>
          {data?.items.map((it) => <Row key={it.id} it={it} onDone={() => void load()} />)}
        </div>
      </div>
    </ConsultShell>
  );
}
