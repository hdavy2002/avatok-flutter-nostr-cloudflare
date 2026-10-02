// [AUMFE-CONSULT-F1-1 2026-10-02] "What people said": first page comes with the detail call, later pages from
// /reviews?page=N (5 per page, newest first). The red "Sample reviews" chip shows when the worker says they are seed rows.
import { useState, type CSSProperties } from 'react';
import type { ReviewDTO } from '../../lib/consultTypes';
import { captureException } from '../../lib/analytics';
import { fetchReviews } from './api';
import ReviewCard from './ReviewCard';

interface Props { slug: string; first: ReviewDTO[]; pages: number; sample: boolean; deva: string }

export default function Reviews({ slug, first, pages, sample, deva }: Props) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ReviewDTO[]>(first);
  const [total, setTotal] = useState(Math.max(1, pages));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  const go = async (p: number) => {
    if (busy || p < 1 || p > total) return;
    setBusy(true); setErr(false);
    try {
      if (p === 1) { setRows(first); setPage(1); }
      else {
        const r = await fetchReviews(slug, p);
        setRows(r.reviews); setPage(r.page); setTotal(Math.max(1, r.pages));
      }
    } catch (e) {
      captureException(e, { where: 'consult_reviews', slug, page: p });
      setErr(true);
    } finally { setBusy(false); }
  };

  return (
    <div className="cp-reviews">
      <div className="cp-reviews-head">
        <div className="cp-cardhead" style={{ ['--hs' as string]: '28px' } as CSSProperties}><span className="deva">{deva}</span><h2>What people said</h2></div>
        {sample ? <span className="chip red"><span className="cp-d">Sample reviews</span><span className="cp-m">Sample</span></span> : null}
      </div>
      {rows.length === 0 ? <p className="card cp-review muted">No reviews yet.</p> : rows.map((r) => <ReviewCard key={r.id} r={r} />)}
      {err ? <p role="alert" className="cp-cal-note">We could not load that page of reviews.</p> : null}
      {total > 1 ? (
        <nav aria-label="Review pages" className="cp-pager">
          <button type="button" className="btn small ghost" disabled={busy || page <= 1} onClick={() => void go(page - 1)}>← Newer</button>
          <span>Page {page} of {total}</span>
          <button type="button" className="btn small cat" disabled={busy || page >= total} onClick={() => void go(page + 1)}>Older →</button>
        </nav>
      ) : null}
    </div>
  );
}
