// [COPY-PIPELINE-1 2026-09-05] What the AI rewrote, and what the creator wrote.
//
// The copy pass now runs automatically when a creator submits, so by the time a
// listing reaches this queue its title, one-liner and description may not be the
// words the creator typed. A reviewer approving text has to be able to see that
// — otherwise the platform is quietly publishing sentences nobody wrote under a
// creator's name.
//
// Two actions, matching the owner's request: ask the AI to write it again, or
// put the creator's own words back. Regenerating works from the ORIGINAL, not
// from the current polished text, so repeated presses do not drift further from
// what the creator meant.
import type { ListingDetail } from './adminListingsShared';

type Original = { title?: string; blurb?: string; description?: string };
type PolishMeta = { at?: number; source?: string; changed?: string[]; by_admin?: string };

const FIELDS: { key: 'title' | 'blurb' | 'description'; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'blurb', label: 'One-liner' },
  { key: 'description', label: 'Description' },
];

export default function CopyPanel({ listing, busy, onRegenerate, onRestore }: {
  listing: ListingDetail;
  busy: boolean;
  onRegenerate: () => void;
  onRestore: () => void;
}) {
  const attrs = (listing.attrs ?? {}) as Record<string, unknown>;
  const original = (attrs.copy_original ?? null) as Original | null;
  const meta = (attrs.copy_polish ?? null) as PolishMeta | null;

  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[18px] font-semibold text-ink">Listing copy</h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={onRegenerate}
            className="rounded-full border-zine border-ink bg-paper px-3 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">
            Rewrite with AI
          </button>
          {original && (
            <button type="button" disabled={busy} onClick={onRestore}
              className="rounded-full border-zine border-ink bg-paper2 px-3 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50">
              Use the creator's words
            </button>
          )}
        </div>
      </div>

      {!original ? (
        <p className="mt-2 font-body text-[13px] font-bold text-inkSoft">
          This is the creator's own text — nothing has been rewritten.
        </p>
      ) : (
        <>
          <p className="mt-2 font-body text-[13px] font-bold text-inkSoft">
            {/* Naming the source matters: a "rules" pass only trimmed length, and
                calling that an AI rewrite would be the same overclaim the review
                checklist used to make. */}
            {meta?.source === 'ai'
              ? 'Rewritten by AI on submit. The creator’s original is kept below.'
              : 'Shortened to fit the card (the AI writer was unavailable, so only the length rules ran).'}
            {meta?.by_admin && ' Last rewritten by an admin.'}
          </p>
          <div className="mt-4 flex flex-col gap-4">
            {FIELDS.map((f) => {
              const now = String((listing as any)[f.key] ?? '');
              const was = String(original[f.key] ?? '');
              const changed = now !== was;
              return (
                <div key={f.key}>
                  <span className="mb-1 block font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkSoft">
                    {f.label}{changed ? '' : ' — unchanged'}
                  </span>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded-zineField border-zine border-ink bg-paper2 p-3">
                      <span className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-inkMute">Creator wrote</span>
                      <p className="font-body text-[13px] font-bold text-inkSoft">{was || <em>empty</em>}</p>
                    </div>
                    <div className={`rounded-zineField border-zine border-ink p-3 ${changed ? 'bg-lime' : 'bg-paper2'}`}>
                      <span className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-inkMute">Live on the listing</span>
                      <p className="font-body text-[13px] font-bold text-ink">{now || <em>empty</em>}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
