// Listing-level moderation actions (approve/reject listing) and Publish,
// with the publish gate made visible instead of firing a 409: publish needs
// the listing approved AND the poster approved.
import RejectControl from './RejectControl';
import type { PosterInfo } from './adminListingsShared';

export default function ModerationBar({
  listingStatus,
  poster,
  busy,
  onApproveListing,
  onRejectListing,
  onPublish,
  onReapprove,
  publishable,
}: {
  listingStatus?: string | null;
  poster: PosterInfo;
  busy: boolean;
  onApproveListing: () => void;
  onRejectListing: (reason: string) => void;
  onPublish: () => void;
  /** [ADMIN-EDIT-2] Re-bind the approval to the content as it stands now. */
  onReapprove: () => void;
  /** From the server's blockers list — see BlockerPanel. */
  publishable?: boolean;
}) {
  const listingOk = listingStatus === 'approved';
  const posterOk = poster?.status === 'approved';
  const publishReason = !listingOk && !posterOk
    ? 'Needs: listing approved and poster approved'
    : !listingOk
      ? 'Needs: listing approved'
      : !posterOk
        ? 'Needs: poster approved'
        : '';

  return (
    <div className="rounded-zine border-zine border-ink bg-paper2 p-5 shadow-zine-sm">
      <h3 className="font-display text-[18px] font-semibold text-ink">Moderation actions</h3>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || listingOk} onClick={onApproveListing} className="rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">
          Approve listing
        </button>
        <RejectControl label="Reject listing" placeholder="What needs to change before this listing can be approved?" busy={busy} onConfirm={onRejectListing} />
        <div className="flex flex-col items-start gap-1">
          <button type="button" disabled={busy || !listingOk || !posterOk} onClick={onPublish} className="rounded-full border-zine border-ink bg-ink px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-paper shadow-zine-xs disabled:opacity-50">
            Publish
          </button>
          {publishReason && <span className="font-body text-[12px] font-bold text-inkMute">{publishReason}</span>}
        </div>
      </div>

      {/* [ADMIN-EDIT-2 2026-09-05] The way out of `review_stale`.
          Publish refuses when the listing no longer matches the content that was
          approved. That guard is right — it stops content being swapped after a
          human judged it — but there was NO admin path back: approved -> approved
          is not a legal status transition, so the only option was to reject the
          listing and make the creator resubmit. Absurd when the admin made the
          change themselves, which is exactly what happened the first time an
          admin edit set a missing start time.
          This writes the same three review-binding columns Approve writes,
          stamped with this admin's id. It is an approval of what is on screen,
          not a bypass — which is why it says so on the button. */}
      {listingOk && (
        <div className="mt-3 border-t border-ink/20 pt-3">
          <button type="button" disabled={busy} onClick={onReapprove}
            className="rounded-full border-zine border-ink bg-paper px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">
            Re-approve current content
          </button>
          <p className="mt-1 font-body text-[12px] font-bold text-inkMute">
            Use this if Publish says the listing changed after approval. It records that you
            have read what is on this page now.
          </p>
        </div>
      )}
    </div>
  );
}
