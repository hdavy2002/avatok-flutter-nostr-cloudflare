/* CallReviews — [HF-CALLS-1] Moderate caller reviews of hosts. Worker: GET /api/admin/hf/reviews?status=, POST /api/admin/hf/reviews/:id {decision, reason}.
 * A review shows on the host's public page only after "Approve". Rejecting needs a reason (kept for the audit log). Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { hfAdminApi, type AdminReview } from '../../../lib/hfAdminApi';
import { moods } from '../../../lib/callvaalHomeReference';
import { toMs } from '../../../lib/hfCallsApi';
import { Banner, ConfirmDialog, ConsultShell, Spinner, dateIST, fail } from '../consultants/kit';

const T14 = { fontSize: 14 } as const;
type Tab = 'pending' | 'approved' | 'rejected';
const TABS: { key: Tab; label: string }[] = [{ key: 'pending', label: 'Waiting' }, { key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' }];

export default function CallReviews() {
  const [tab, setTab] = useState<Tab>('pending');
  const [rows, setRows] = useState<AdminReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<AdminReview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [dlgErr, setDlgErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null); setRows(null);
    try { setRows(await hfAdminApi.reviews(tab)); } catch (e) { setError(fail('call_reviews_list', e, { tab })); setRows([]); }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);

  const approve = async (r: AdminReview) => {
    setBusy(r.id); setInfo(null); setError(null);
    try { await hfAdminApi.decideReview(r.id, 'approve'); setInfo('Approved. It now shows on the host’s page.'); await load(); } catch (e) { setError(fail('call_review_approve', e)); }
    setBusy(null);
  };
  const reject = async () => {
    if (!rejecting) return;
    setBusy(rejecting.id); setDlgErr(null);
    try { await hfAdminApi.decideReview(rejecting.id, 'reject', reason.trim()); setRejecting(null); setReason(''); setInfo('Rejected.'); await load(); } catch (e) { setDlgErr(fail('call_review_reject', e)); }
    setBusy(null);
  };

  return (
    <ConsultShell>
      <div role="tablist" aria-label="Review status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`slot${tab === t.key ? ' on' : ''}`} style={{ padding: '0 14px', ...T14 }} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>
      {error && <div style={{ marginBottom: 12 }}><Banner tone="error">{error}</Banner></div>}
      {info && <div style={{ marginBottom: 12 }}><Banner tone="info">{info}</Banner></div>}
      {rows === null && <Spinner label="Loading reviews…" />}
      {rows && rows.length === 0 && !error && <div className="card muted" style={{ fontWeight: 700, ...T14 }}>Nothing here.</div>}
      <div style={{ display: 'grid', gap: 12 }}>
        {rows?.map((r) => (
          <article key={r.id} className="card" style={{ background: '#fff', display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', ...T14 }}>
              <strong style={{ color: '#b87d00', letterSpacing: 2, fontSize: 18 }} aria-label={`${r.stars} out of 5`}>{'★'.repeat(r.stars)}{'☆'.repeat(Math.max(0, 5 - r.stars))}</strong>
              <span>for <strong>{r.hostName || r.hostSlug || r.hostUid || 'a host'}</strong></span>
              {r.callerName && <span className="muted">from {r.callerName}</span>}
              {r.minutes ? <span className="muted">{r.minutes} min</span> : null}
              {r.topic && <span className="chip neel">{moods.find((m) => m.slug === r.topic)?.label ?? r.topic}</span>}
              <span className="muted">{dateIST(toMs(r.createdAt))}</span>
            </div>
            <p style={{ margin: 0, ...T14, lineHeight: 1.5 }}>{r.text || <span className="muted">No text, stars only.</span>}</p>
            {r.status === 'rejected' && r.rejectReason && <p className="muted" style={{ margin: 0, ...T14 }}>Reason: {r.rejectReason}</p>}
            {tab !== 'approved' && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {tab === 'pending' && <button type="button" className="btn small" style={T14} disabled={busy === r.id} onClick={() => approve(r)}>Approve</button>}
                <button type="button" className="btn small red" style={T14} disabled={busy === r.id} onClick={() => { setRejecting(r); setReason(''); setDlgErr(null); }}>Reject</button>
              </div>
            )}
          </article>
        ))}
      </div>
      <ConfirmDialog open={!!rejecting} title="Reject this review?" confirmLabel="Reject" danger busy={!!busy} error={dlgErr} disabled={reason.trim().length < 3}
        body="It will not show on the host’s page. Say why, for our records." onConfirm={reject} onCancel={() => setRejecting(null)}>
        <label style={{ ...T14, fontWeight: 800 }} htmlFor="rv-reason">Reason</label>
        <textarea id="rv-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} style={{ width: '100%', ...T14, padding: 10, borderRadius: 10, border: '1px solid #c8afd1' }} />
      </ConfirmDialog>
    </ConsultShell>
  );
}
