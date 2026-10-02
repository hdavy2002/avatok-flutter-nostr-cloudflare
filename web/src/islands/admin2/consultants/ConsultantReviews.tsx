/* ConsultantReviews — [AUMFE-CONSULT-F4-1] Review moderation (AdminReviews mockup).
 * Worker: GET /api/consultants/admin/reviews?status=pending|approved|rejected|seed&page=N, PATCH /reviews/:id {status}.
 * Only approved reviews count toward a rating and show publicly; seed reviews never show on the public site. */
import { useCallback, useEffect, useState } from 'react';
import { consultAdminApi, type AdminReview, type AdminReviewTab } from '../../../lib/consultAdminApi';
import { Banner, ConsultShell, Spinner, fail, track } from './kit';

const TABS: { key: AdminReviewTab; label: string }[] = [
  { key: 'pending', label: 'Pending' }, { key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' }, { key: 'seed', label: 'Seed' },
];
const dayIST = (ms?: number | null) => (ms ? new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }) : '');

export default function ConsultantReviews() {
  const [tab, setTab] = useState<AdminReviewTab>(() => {
    const t = new URLSearchParams(location.search).get('status');
    return TABS.some((x) => x.key === t) ? (t as AdminReviewTab) : 'pending';
  });
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AdminReview[] | null>(null);
  const [pages, setPages] = useState(1);
  const [counts, setCounts] = useState<Partial<Record<AdminReviewTab, number>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null); setRows(null);
    try {
      const r = await consultAdminApi.reviews(tab, page);
      setRows(r.reviews ?? []); setPages(Math.max(1, r.pages ?? 1));
      setCounts((c) => ({ ...c, ...(r.counts ?? {}) }));
    } catch (e) { setError(fail('reviews_list', e, { tab })); setRows([]); }
  }, [tab, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { track('reviews_view', { tab }); const u = new URL(location.href); tab === 'pending' ? u.searchParams.delete('status') : u.searchParams.set('status', tab); history.replaceState(history.state, '', u.toString()); }, [tab]);

  const decide = async (r: AdminReview, status: 'approved' | 'rejected') => {
    setBusyId(r.id); setError(null);
    try {
      await consultAdminApi.setReview(r.id, status);
      track(status === 'approved' ? 'review_approve' : 'review_reject', { ok: true, seed: !!r.seed });
      setRows((x) => (x ? x.filter((y) => y.id !== r.id) : x));
      setCounts((c) => ({ ...c, [tab]: c[tab] != null ? Math.max(0, (c[tab] ?? 0) - 1) : c[tab], [status]: c[status] != null ? (c[status] ?? 0) + 1 : c[status] }));
    } catch (e) { setError(fail(status === 'approved' ? 'review_approve' : 'review_reject', e)); } finally { setBusyId(null); }
  };

  const go = (t: AdminReviewTab) => { setTab(t); setPage(1); };

  return (
    <ConsultShell>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <div role="tablist" aria-label="Review status" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`slot${tab === t.key ? ' on' : ''}`} style={{ padding: '0 14px' }} onClick={() => go(t.key)}>
              {t.label}{counts[t.key] != null ? ` · ${counts[t.key]}` : ''}
            </button>
          ))}
        </div>
      </div>
      {error && <div style={{ marginBottom: 12 }}><Banner tone="error">{error}</Banner></div>}
      {rows === null && <Spinner label="Loading reviews…" />}
      {rows && rows.length === 0 && !error && <div className="card muted" style={{ fontWeight: 700 }}>Nothing here.</div>}
      {rows && rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'auto', background: '#fff' }}>
          <table className="t">
            <thead><tr><th>Consultant</th><th>Customer · session</th><th>Stars</th><th>Review</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.consultant?.name ?? '—'}</strong>{r.seed && <> <span className="chip gold">Sample</span></>}</td>
                  <td>{r.customer_name ?? '—'}{r.slot_start_ms ? ` · ${dayIST(r.slot_start_ms)}${r.minutes ? `, ${r.minutes} min` : ''}` : ''}{r.verified ? ' ✓' : ''}</td>
                  <td><span className="stars" role="img" aria-label={`${r.stars} out of 5 stars`}>{'★'.repeat(r.stars)}{'☆'.repeat(Math.max(0, 5 - r.stars))}</span></td>
                  <td style={{ maxWidth: 360 }}>{r.text || <span className="muted">No comment</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.status !== 'approved' && <button type="button" className="btn small" disabled={busyId === r.id} onClick={() => void decide(r, 'approved')} aria-label={`Approve review of ${r.consultant?.name ?? 'consultant'}`}>Approve</button>}{' '}
                    {r.status !== 'rejected' && <button type="button" className="btn small ghost" disabled={busyId === r.id} onClick={() => void decide(r, 'rejected')} aria-label={`Reject review of ${r.consultant?.name ?? 'consultant'}`}>Reject</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav aria-label="Pages" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center', marginTop: 14 }}>
          <button type="button" className="btn small ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span style={{ fontWeight: 800 }}>Page {page} of {pages}</span>
          <button type="button" className="btn small ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </nav>
      )}
      <p className="hint" style={{ marginTop: 14 }}>Only approved reviews count toward a consultant's rating and appear on their page, newest first, 5 per page. Seed reviews never show on the public site.</p>
    </ConsultShell>
  );
}
