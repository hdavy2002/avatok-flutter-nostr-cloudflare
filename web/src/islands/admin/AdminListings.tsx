// Admin review workbench for marketplace listings (MKT-ADMIN-UI-1). Three
// regions: the queue rail, "what the creator submitted", and the poster +
// moderation actions — so an admin can see everything a creator wrote and
// preview/approve the auto-generated poster in one screen.
//
// Split across web/src/islands/admin/*.tsx because a single ~200-line file
// was the problem this task exists to fix:
//   AdminListings.tsx     — this file: auth, queue+detail fetching, actions, layout
//   adminListingsShared.tsx — shared types, formatters, Field/Group/Badge primitives
//   QueueRail.tsx          — the 360px queue rail (filter/refresh/list)
//   SubmissionPanel.tsx    — "what the creator submitted" (the heart of the task)
//   PosterPanel.tsx        — poster preview/state machine + polling while generating
//   ModerationBar.tsx      — approve/reject listing + gated Publish
//   AuditTimeline.tsx      — per-listing history (fixes the a.items/entries bug)
//   RejectControl.tsx      — shared inline "reason required" control
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { Spinner } from '../../components/Spinner';
import QueueRail from './QueueRail';
import SubmissionPanel from './SubmissionPanel';
import PosterPanel from './PosterPanel';
import ModerationBar from './ModerationBar';
import AuditTimeline from './AuditTimeline';
import type { AdminListingDetailResponse, ListingRow } from './adminListingsShared';

export default function AdminListings() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ListingRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [detail, setDetail] = useState<AdminListingDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);

  const loadQueue = useCallback(async (t: string, keepSelection = true) => {
    setLoading(true);
    setError(null);
    try {
      const r = await request<{ listings: ListingRow[] }>('/api/admin/listings', { auth: t, query: { status: status === 'all' ? undefined : status } });
      setRows(r.listings ?? []);
      setSelected((prev) => (keepSelection && prev && (r.listings ?? []).some((row) => row.id === prev) ? prev : (r.listings?.[0]?.id ?? null)));
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not load admin listings.');
      setRows([]);
      setSelected(null);
    } finally {
      setLoading(false);
    }
  }, [status]);

  const loadDetail = useCallback(async (t: string, id: string) => {
    setDetailLoading(true);
    try {
      const d = await request<AdminListingDetailResponse>(`/api/admin/listings/${encodeURIComponent(id)}`, { auth: t });
      setDetail(d);
      // Patch the queue row's status/title from the freshly-fetched detail so
      // the rail badge stays truthful without a full requery.
      setRows((prev) => prev.map((row) => (row.id === id ? { ...row, status: d.listing.status ?? row.status, title: (d.listing.title as string | undefined) ?? row.title } : row)));
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not load listing detail.');
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!checked || !token) { if (checked) setLoading(false); return; }
    void loadQueue(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, token, status]);

  useEffect(() => {
    if (!token || !selected) { setDetail(null); return; }
    void loadDetail(token, selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selected]);

  const currentRow = useMemo(() => rows.find((row) => row.id === selected) ?? null, [rows, selected]);

  async function action(id: string, act: string, payload: Record<string, unknown> = {}) {
    if (!token) return;
    setBusy(`${id}:${act}`);
    setError(null);
    try {
      await request(`/api/admin/listings/${encodeURIComponent(id)}`, { auth: token, method: 'POST', body: { action: act, ...payload } });
      // Re-fetch detail (truth for this listing) and patch the queue row —
      // spec item 7: keep status badges truthful after every action.
      await loadDetail(token, id);
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  if (!checked || loading) {
    return <div className="flex items-center gap-3 p-8"><Spinner size={22} /> <span className="font-body font-bold text-inkSoft">Loading admin queue…</span></div>;
  }

  const isBusy = busy !== null;

  return (
    <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <QueueRail
        rows={rows}
        selected={selected}
        status={status}
        onStatusChange={setStatus}
        onSelect={setSelected}
        onRefresh={() => token && void loadQueue(token)}
      />

      <section className="flex flex-col gap-5">
        {error && <div className="rounded-zine border-zine border-ink bg-coral px-4 py-3 font-body text-[14px] font-bold text-paper">{error}</div>}

        {!currentRow ? (
          <div className="rounded-zine border-zine border-ink bg-card p-6 shadow-zine-sm">
            <h2 className="font-display text-[22px] font-semibold text-ink">No listing selected</h2>
            <p className="mt-2 font-body text-[14px] font-bold text-inkSoft">Pick a listing from the queue to inspect the submission, poster state and audit history.</p>
          </div>
        ) : detailLoading && !detail ? (
          <div className="flex items-center gap-3 rounded-zine border-zine border-ink bg-card p-6 shadow-zine-sm"><Spinner size={20} /> <span className="font-body font-bold text-inkSoft">Loading listing…</span></div>
        ) : !detail ? (
          <div className="rounded-zine border-zine border-ink bg-card p-6 shadow-zine-sm font-body text-[14px] font-bold text-inkSoft">Could not load this listing.</div>
        ) : (
          <>
            <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-display text-[26px] font-semibold text-ink">{(detail.listing.title as string) ?? 'Untitled listing'}</h2>
                  <div className="mt-2 font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkSoft">Listing {detail.listing.id}</div>
                </div>
              </div>
            </div>

            {/* At this file's max-w-6xl (1152px) container, a true 3-column
                layout (rail + submission + poster) is too cramped below the
                2xl breakpoint — the submission panel in particular needs
                room for two-column field rows. Poster + moderation stack
                under the submission panel until 2xl, where they move beside
                it. See report for the recommendation to widen the Dashboard
                shell's max-width for this page if a true 3-up is wanted. */}
            <div className="grid gap-5 2xl:grid-cols-[1.3fr_0.9fr]">
              <div className="flex flex-col gap-5">
                <SubmissionPanel listing={detail.listing} creator={detail.creator} category={detail.category} />
              </div>
              <div className="flex flex-col gap-5">
                <ModerationBar
                  listingStatus={detail.listing.status as string | undefined}
                  poster={detail.poster}
                  busy={isBusy}
                  onApproveListing={() => void action(detail.listing.id, 'approve_listing')}
                  onRejectListing={(reason) => void action(detail.listing.id, 'reject_listing', { reason })}
                  onPublish={() => void action(detail.listing.id, 'publish')}
                />
                <PosterPanel
                  poster={detail.poster}
                  listingTitle={detail.listing.title as string | undefined}
                  busy={isBusy}
                  onGenerate={() => void action(detail.listing.id, 'generate_poster')}
                  onRegenerate={() => void action(detail.listing.id, 'regenerate_poster')}
                  onApprove={() => void action(detail.listing.id, 'approve_poster')}
                  onReject={(feedback) => void action(detail.listing.id, 'reject_poster', { feedback })}
                  onPoll={() => token && void loadDetail(token, detail.listing.id)}
                />
                <AuditTimeline history={detail.history} />
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
