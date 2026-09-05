// [LISTING-BLOCKERS-1 2026-09-05] What publish will refuse, shown BEFORE the
// reviewer approves.
//
// The queue used to show a reviewer nothing at all about publishability. They
// approved a listing that looked complete, hit Publish, and got a 400 naming a
// field they had never been shown — on a listing whose schedule the creator
// could no longer edit, because editing a start time was blocked once a listing
// left draft. The owner lost one that way on 2026-09-05 and made the point that
// matters at scale: with four thousand listings arriving, nobody can work out
// what is wrong with each one by hand.
//
// This renders the SERVER's list, verbatim. It deliberately holds no rules of
// its own — a second copy of the rules in the browser is the original bug.
import type { ListingBlocker } from './adminListingsShared';

export default function BlockerPanel({ blockers, publishable, onFix }: {
  blockers: ListingBlocker[] | undefined;
  publishable: boolean | undefined;
  /** Jump the admin to the editor, focused on the offending field. */
  onFix: (field: string | null) => void;
}) {
  // `publishable` absent means the server predates this panel — say nothing
  // rather than claiming the listing is fine, which is the failure mode this
  // whole change exists to remove.
  if (publishable === undefined) return null;

  if (publishable) {
    return (
      <div className="rounded-zine border-zine border-ink bg-mint px-4 py-3 font-body text-[14px] font-bold text-mintInk shadow-zine-sm">
        Ready to publish — the server has no blockers on this listing.
      </div>
    );
  }

  const items = blockers ?? [];
  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <h3 className="font-display text-[18px] font-semibold text-ink">
        Cannot publish — {items.length} {items.length === 1 ? 'problem' : 'problems'}
      </h3>
      <p className="mt-1 font-body text-[13px] font-bold text-inkSoft">
        This is the exact list Publish enforces. Fix these here, or reject the listing back to the creator.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((b) => (
          <li key={b.code + (b.field ?? '')}
            className="flex flex-wrap items-center justify-between gap-2 rounded-zineField border-zine border-ink bg-paper2 px-3 py-2">
            <span className="font-body text-[14px] font-bold text-ink">{b.message}</span>
            {b.field && (
              <button type="button" onClick={() => onFix(b.field)}
                className="rounded-full border-zine border-ink bg-paper px-3 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs">
                Fix {b.field}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
