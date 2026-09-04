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
}: {
  listingStatus?: string | null;
  poster: PosterInfo;
  busy: boolean;
  onApproveListing: () => void;
  onRejectListing: (reason: string) => void;
  onPublish: () => void;
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
    </div>
  );
}
