// [REVIEW-MOD-1 2026-09-06] Admin queue for buyer reviews.
//
// A review written on a listing page lands 'pending' and is invisible to
// everyone — the public list route filters to approved, and the rating average
// counts approved rows only. This screen is where a human decides.
//
// Deliberately a flat list, not the rail+detail workbench next door: a review is
// four lines of text and a star rating. Everything needed to judge one fits on
// its own card, so making an admin click a row to see the words would be pure
// ceremony. What DOES have to be on the card is the context — which listing,
// who wrote it, and whether they actually attended — because a queue that sends
// you elsewhere to answer "is this real?" is a queue nobody works.
//
// The auth dance (read the token per request, force one fresh mint on a 401) is
// copied verbatim from AdminListings.tsx and is not optional: a Clerk session
// JWT lives about a minute, this is a page left open, and Clerk will hand back
// a CACHED already-expired token unless skipCache forces a new one. That is the
// "auth: expired" the owner hit on 2026-09-05.
import { useCallback, useEffect, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { capture } from '../../lib/analytics';
import { Spinner } from '../../components/Spinner';

type ReviewRow = {
  id: string;
  listing: { id: string; title: string; kind: string | null; status: string | null };
  author: { uid: string; name: string; handle: string | null; avatar_url: string | null };
  creator: { uid: string; name: string };
  rating: number;
  body: string;
  verified_attendee: boolean;
  status: string;
  moderation_reason: string | null;
  moderated_at: number | null;
  moderated_by_name: string | null;
  helpful_count: number;
  creator_reply: string | null;
  created_at: number;
};

type QueueResponse = { items: ReviewRow[]; counts: Record<string, number>; statuses: string[] };

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'pending', label: 'Waiting for you' },
  { key: 'approved', label: 'Published' },
  { key: 'rejected', label: 'Turned down' },
  { key: 'all', label: 'Everything' },
];

function when(ms: number | null | undefined): string {
  if (!ms) return '';
  try { return new Date(ms).toLocaleString(); } catch { return ''; }
}

export default function AdminReviews() {
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Which review has its "why not?" box open, and what has been typed in it.
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const withAuth = useCallback(async <T,>(run: (token: string) => Promise<T>): Promise<T> => {
    const first = await getActiveToken();
    if (!first) throw new ApiError(401, 'Your session ended. Reload the page to sign in again.');
    try {
      return await run(first);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      const fresh = await getActiveToken(5000, { skipCache: true });
      if (!fresh || fresh === first) {
        capture('admin_auth_retry', { outcome: fresh ? 'same_token' : 'no_token', surface: 'reviews' });
        throw new ApiError(401, 'Your session ended. Reload the page to sign in again.');
      }
      const out = await run(fresh);
      capture('admin_auth_retry', { outcome: 'recovered', surface: 'reviews' });
      return out;
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await withAuth((t) => request<QueueResponse>('/api/admin/reviews', { auth: t, query: { status: filter } }));
      setRows(r.items ?? []);
      setCounts(r.counts ?? {});
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not load reviews.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filter, withAuth]);

  useEffect(() => { void load(); }, [load]);

  async function act(id: string, action: 'approve' | 'reject', why?: string) {
    setBusy(id); setError(null);
    try {
      await withAuth((t) => request(`/api/admin/reviews/${encodeURIComponent(id)}`, {
        method: 'POST', auth: t, body: { action, reason: why },
      }));
      capture('admin_review_action', { action, review_id: id });
      setRejecting(null); setReason('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.error : `Could not ${action} that review.`);
    } finally {
      setBusy(null);
    }
  }

  const pending = counts.pending ?? 0;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full border-zine border-ink px-4 py-2 font-body text-[13px] font-bold shadow-zine-xs ${
              filter === f.key ? 'bg-lime text-ink' : 'bg-card text-inkSoft'
            }`}
          >
            {f.label}
            {f.key !== 'all' && counts[f.key] != null ? ` (${counts[f.key]})` : ''}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded-full border-zine border-ink bg-card px-4 py-2 font-body text-[13px] font-bold text-inkSoft shadow-zine-xs"
        >
          Refresh
        </button>
      </div>

      {pending > 0 && filter !== 'pending' && (
        <p className="font-body text-[14px] font-bold text-inkSoft">
          {pending} review{pending === 1 ? '' : 's'} still waiting for you.
        </p>
      )}

      {error && (
        <div role="alert" className="rounded-zine border-zine border-ink bg-coral p-4 font-body text-[14px] font-bold text-ink shadow-zine-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center p-10"><Spinner /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-zine border-zine border-ink bg-card p-6 font-body text-[15px] font-bold text-inkSoft shadow-zine-sm">
          {filter === 'pending' ? 'Nothing waiting. Every review has been dealt with.' : 'Nothing here.'}
        </div>
      ) : (
        <div className="grid gap-4">
          {rows.map((r) => (
            <article key={r.id} className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-display text-[20px] font-semibold text-ink">
                    {'★'.repeat(Math.max(0, Math.min(5, r.rating)))}
                    <span className="text-inkSoft">{'★'.repeat(Math.max(0, 5 - r.rating))}</span>
                    <span className="ml-2 font-body text-[14px] text-inkSoft">{r.rating} out of 5</span>
                  </div>
                  <div className="mt-1 font-body text-[14px] font-bold text-inkSoft">
                    {r.author.name} on <a className="underline" href={`/l/${r.listing.id}`} target="_blank" rel="noreferrer">{r.listing.title}</a>
                    {' · '}hosted by {r.creator.name}
                  </div>
                  <div className="mt-1 font-body text-[13px] text-inkSoft">
                    {when(r.created_at)}
                    {r.verified_attendee
                      ? ' · attended the show'
                      : ' · booked and paid, show not marked as attended'}
                  </div>
                </div>
                <span className="rounded-full border-zine border-ink bg-paper2 px-3 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink">
                  {r.status === 'pending' ? 'Waiting' : r.status === 'approved' ? 'Published' : 'Turned down'}
                </span>
              </div>

              {r.body ? (
                <p className="mt-3 whitespace-pre-wrap rounded-zine border-zine border-ink bg-paper2 p-4 font-body text-[15px] leading-relaxed text-ink">
                  {r.body}
                </p>
              ) : (
                <p className="mt-3 font-body text-[14px] font-bold italic text-inkSoft">Rating only — they wrote nothing.</p>
              )}

              {r.moderation_reason && (
                <p className="mt-2 font-body text-[13px] font-bold text-inkSoft">
                  Reason given: {r.moderation_reason}
                  {r.moderated_by_name ? ` — ${r.moderated_by_name}` : ''}
                  {r.moderated_at ? `, ${when(r.moderated_at)}` : ''}
                </p>
              )}

              {/* Both actions stay available on an already-moderated review:
                  approving is how a turned-down review gets a second look, and
                  "take it down" is how a published one is pulled. The server
                  recomputes the rating either way, so neither direction leaves
                  a stale average behind. */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                  {r.status !== 'approved' && (
                    <button
                      type="button"
                      disabled={busy === r.id}
                      onClick={() => void act(r.id, 'approve')}
                      className="rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-60"
                    >
                      {busy === r.id ? 'Working…' : 'Approve & publish'}
                    </button>
                  )}
                  {r.status !== 'rejected' && (
                    <button
                      type="button"
                      disabled={busy === r.id}
                      onClick={() => { setRejecting(rejecting === r.id ? null : r.id); setReason(''); }}
                      className="rounded-full border-zine border-ink bg-card px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-60"
                    >
                      {r.status === 'approved' ? 'Take it down' : 'Turn it down'}
                    </button>
                  )}
              </div>

              {rejecting === r.id && (
                <div className="mt-3 grid gap-2">
                  {/* A reason is required by the server, not just asked for here —
                      the author is told why, and the audit row has to mean
                      something six months from now. */}
                  <label className="font-body text-[13px] font-bold text-inkSoft" htmlFor={`why-${r.id}`}>
                    Why? The person who wrote it will see this.
                  </label>
                  <textarea
                    id={`why-${r.id}`}
                    rows={2}
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                    className="rounded-zine border-zine border-ink bg-paper2 p-3 font-body text-[14px] text-ink"
                    placeholder="e.g. Names another customer, or is about a different show."
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy === r.id || !reason.trim()}
                      onClick={() => void act(r.id, 'reject', reason.trim())}
                      className="rounded-full border-zine border-ink bg-coral px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => { setRejecting(null); setReason(''); }}
                      className="rounded-full border-zine border-ink bg-card px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-inkSoft shadow-zine-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
