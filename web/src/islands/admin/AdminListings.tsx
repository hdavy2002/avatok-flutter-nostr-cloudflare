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
import { capture } from '../../lib/analytics';
import { Spinner } from '../../components/Spinner';
import QueueRail from './QueueRail';
import SubmissionPanel from './SubmissionPanel';
import PosterPanel from './PosterPanel';
import ModerationBar from './ModerationBar';
import AuditTimeline from './AuditTimeline';
import BlockerPanel from './BlockerPanel';
import EditPanel from './EditPanel';
import DeletePanel from './DeletePanel';
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
  // [POSTER-PROGRESS-1 2026-09-05] Which action produced `error`, so a poster
  // failure can be shown ON the poster card instead of only in a banner at the
  // top of a tall page the admin may have scrolled past.
  const [errorAct, setErrorAct] = useState<string | null>(null);
  // [ADMIN-EDIT-1] Set when the admin clicks "Fix <field>" on a blocker, so the
  // editor opens scrolled to the field that is actually the problem.
  const [focusField, setFocusField] = useState<string | null>(null);

  const [detail, setDetail] = useState<AdminListingDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);

  // [ADMIN-AUTH-FRESH-1 2026-09-05] Every admin request goes through here, and
  // this is where "auth: expired" was coming from.
  //
  // TWO things were wrong, and only fixing both is enough:
  //
  //  1. The token was read ONCE at mount and reused forever. A Clerk session JWT
  //     lives about a minute, and this is a page an admin leaves open — reading
  //     a submission, watching a 40-60s poster job — so the mount-time string
  //     was long dead before the first moderation click. Hence: read it per
  //     request.
  //  2. Reading it per request is still not enough, because Clerk CACHES the
  //     session JWT, and an idle or backgrounded tab gets handed a cached token
  //     whose `exp` has already passed. The worker verifies the signature
  //     happily and then rejects it on expiry (worker/src/auth.ts:50) — a live
  //     session, refused. The only cure is to make Clerk mint a new one, which
  //     is what `skipCache` does.
  //
  // So: try the cached token, and on a 401 force a fresh mint and go again
  // exactly ONCE. Once, deliberately — a second 401 on a freshly minted token is
  // a real authentication failure (signed out, revoked, not an admin), and
  // retrying that is a loop that hides the actual answer.
  //
  // `token` state survives, but only as the "are we signed in at all" gate.
  const withAuth = useCallback(async <T,>(
    run: (token: string) => Promise<T>,
  ): Promise<T> => {
    const first = await getActiveToken();
    if (!first) throw new ApiError(401, 'Your session ended. Reload the page to sign in again.');
    try {
      return await run(first);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      const fresh = await getActiveToken(5000, { skipCache: true });
      if (!fresh || fresh === first) {
        capture('admin_auth_retry', { outcome: fresh ? 'same_token' : 'no_token' });
        throw new ApiError(401, 'Your session ended. Reload the page to sign in again.');
      }
      // The success value to assert. outcome='recovered' is this fix working:
      // a request that would have shown "auth: expired" instead went through on
      // a freshly minted token. A run of 'same_token' means Clerk handed back
      // the identical expired string despite skipCache, which would mean the
      // session really is dead and the retry is not the answer.
      try {
        const out = await run(fresh);
        capture('admin_auth_retry', { outcome: 'recovered' });
        return out;
      } catch (again) {
        capture('admin_auth_retry', {
          outcome: 'failed_after_refresh',
          status: again instanceof ApiError ? again.status : 0,
        });
        throw again;
      }
    }
  }, []);

  const loadQueue = useCallback(async (keepSelection = true) => {
    setLoading(true);
    setError(null);
    try {
      const r = await withAuth((t) => request<{ listings: ListingRow[] }>(
        '/api/admin/listings',
        { auth: t, query: { status: status === 'all' ? undefined : status } },
      ));
      setRows(r.listings ?? []);
      setSelected((prev) => (keepSelection && prev && (r.listings ?? []).some((row) => row.id === prev) ? prev : (r.listings?.[0]?.id ?? null)));
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not load admin listings.');
      setRows([]);
      setSelected(null);
    } finally {
      setLoading(false);
    }
  }, [status, withAuth]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const d = await withAuth((t) => request<AdminListingDetailResponse>(
        `/api/admin/listings/${encodeURIComponent(id)}`, { auth: t },
      ));
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
  }, [withAuth]);

  useEffect(() => {
    if (!checked || !token) { if (checked) setLoading(false); return; }
    void loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, token, status]);

  useEffect(() => {
    if (!token || !selected) { setDetail(null); return; }
    void loadDetail(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selected]);

  const currentRow = useMemo(() => rows.find((row) => row.id === selected) ?? null, [rows, selected]);

  async function action(id: string, act: string, payload: Record<string, unknown> = {}) {
    setBusy(`${id}:${act}`);
    setError(null);
    setErrorAct(null);
    try {
      await withAuth((t) => request(
        `/api/admin/listings/${encodeURIComponent(id)}`,
        { auth: t, method: 'POST', body: { action: act, ...payload } },
      ));
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Action failed.');
      setErrorAct(act);
    } finally {
      // [POSTER-PROGRESS-1] Re-fetch on BOTH paths, not just success. Poster
      // generation runs synchronously inside this request and takes ~40-60s, so
      // the request can time out or be abandoned while the server goes on to
      // finish and commit. Re-fetching only on success left the admin staring
      // at the pre-action card — on 2026-09-05 a regenerate that had actually
      // succeeded still read "FAILED / Poster generation was interrupted",
      // which is worse than no feedback: it says the opposite of the truth.
      try {
        await loadDetail(id);
      } catch { /* the banner above already carries the real failure */ }
      setBusy(null);
    }
  }

  // [ADMIN-EDIT-1] PUT the dirty fields only. The response carries the fresh
  // blockers list, so the reviewer sees immediately whether the edit actually
  // made the listing publishable rather than having to hit Publish to find out.
  async function saveEdits(id: string, fields: Record<string, unknown>) {
    setBusy(`${id}:edit`);
    setError(null);
    setErrorAct(null);
    try {
      await withAuth((t) => request(`/api/admin/listings/${encodeURIComponent(id)}`, {
        auth: t, method: 'PUT', body: { fields },
      }));
      setFocusField(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not save the edit.');
      setErrorAct('edit');
    } finally {
      try { await loadDetail(id); } catch { /* banner already carries the failure */ }
      setBusy(null);
    }
  }

  // [ADMIN-PURGE-1] Delete, then leave the detail pane empty and requery the
  // queue — the selected listing no longer exists, so re-fetching its detail
  // (which every other action does) would 404 and show "Could not load".
  async function purge(id: string, confirm: string) {
    setBusy(`${id}:delete`);
    setError(null);
    setErrorAct(null);
    try {
      await withAuth((t) => request(`/api/admin/listings/${encodeURIComponent(id)}`, {
        auth: t, method: 'DELETE', body: { confirm },
      }));
      setDetail(null);
      setSelected(null);
      await loadQueue(false);
    } catch (e) {
      // Rethrown so DeletePanel can show the server's refusal INLINE — "this has
      // 3 bookings attached" belongs next to the button, not in a banner at the
      // top of a long page.
      throw new Error(e instanceof ApiError ? (e.body as any)?.message ?? e.error : 'Could not delete this listing.');
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
        onRefresh={() => void loadQueue()}
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
                <BlockerPanel
                  blockers={detail.blockers}
                  publishable={detail.publishable}
                  onFix={(f) => setFocusField(f)}
                />
                <SubmissionPanel listing={detail.listing} creator={detail.creator} category={detail.category} />
                <EditPanel
                  listing={detail.listing}
                  busy={isBusy}
                  focusField={focusField}
                  onSave={(fields) => saveEdits(detail.listing.id, fields)}
                />
              </div>
              <div className="flex flex-col gap-5">
                <ModerationBar
                  listingStatus={detail.listing.status as string | undefined}
                  poster={detail.poster}
                  busy={isBusy}
                  onApproveListing={() => void action(detail.listing.id, 'approve_listing')}
                  onRejectListing={(reason) => void action(detail.listing.id, 'reject_listing', { reason })}
                  onPublish={() => void action(detail.listing.id, 'publish')}
                  onReapprove={() => void action(detail.listing.id, 'reapprove_content')}
                  publishable={detail.publishable}
                />
                <PosterPanel
                  poster={detail.poster}
                  listingTitle={detail.listing.title as string | undefined}
                  busy={isBusy}
                  // [POSTER-PROGRESS-1] The poster job is the one action that
                  // takes a minute, so the panel needs to know it is THIS
                  // action running — a shared `busy` cannot tell an approve
                  // click from a generation.
                  running={
                    busy === `${detail.listing.id}:generate_poster`
                    || busy === `${detail.listing.id}:regenerate_poster`
                  }
                  actionError={
                    errorAct === 'generate_poster' || errorAct === 'regenerate_poster' ? error : null
                  }
                  onGenerate={() => void action(detail.listing.id, 'generate_poster')}
                  onRegenerate={() => void action(detail.listing.id, 'regenerate_poster')}
                  onApprove={() => void action(detail.listing.id, 'approve_poster')}
                  onReject={(feedback) => void action(detail.listing.id, 'reject_poster', { feedback })}
                  onPoll={() => void loadDetail(detail.listing.id)}
                />
                <AuditTimeline history={detail.history} actorNames={detail.actor_names} />
                <DeletePanel
                  title={String(detail.listing.title ?? '')}
                  status={detail.listing.status as string | undefined}
                  busy={isBusy}
                  onDelete={(confirm) => purge(detail.listing.id, confirm)}
                />
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
