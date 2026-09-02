import { useEffect } from 'react';
import { VERTICALS, VERTICALS_WITHOUT_A_SOURCE, type VerticalId } from '../../lib/verticals';

/** Price buckets, in tokens (₹1 = 1 token). `max: null` means "and up". */
export const PRICE_BANDS: { id: string; label: string; min: number; max: number | null }[] = [
  { id: 'all', label: 'Sab', min: 0, max: null },
  { id: 'under100', label: 'Under ₹100', min: 0, max: 99 },
  { id: '100_199', label: '₹100–199', min: 100, max: 199 },
  { id: '200plus', label: '₹200+', min: 200, max: null },
];

export interface RailState {
  vertical?: VerticalId;
  price: string;
  /** ISO date (yyyy-mm-dd) or undefined for "any day". */
  date?: string;
  /** Server sort key; '' is the default order. See SORTS below. */
  sort?: string;
}

/**
 * [MARKET-SECTION-1] Sort is BACK. It was removed in [MARKET-BAZAAR-2] because
 * filtering happened in the browser, so a sort could only reorder the ~24 rows
 * already fetched while looking like it had ordered the catalogue. The ORDER BY
 * is the database's now, so the control tells the truth.
 *
 * These ids are the worker's vocabulary (exploreBrowse / exploreSearch) — rename
 * one here and it silently falls back to the default order.
 */
export const SORTS: { id: string; label: string }[] = [
  { id: '', label: 'Top' },
  { id: 'newest', label: 'Newest' },
  { id: 'cheapest', label: 'Cheapest' },
  { id: 'popular', label: 'Popular' },
  { id: 'rating', label: 'Rated' },
];

export interface FilterRailProps {
  value: RailState;
  onChange: (next: RailState) => void;
  /** Catalogue-wide count per section, from the worker's `section_counts`. */
  counts: Record<VerticalId, number>;
  /**
   * False when the worker sent no counts. The rail then shows NO number rather
   * than a zero — "0" and "we could not count" are different claims, and only
   * one of them is safe to print next to a filter someone is about to click.
   */
  countsKnown: boolean;
  /** Catalogue total, for the "Everything" row. */
  total: number;
  onClear: () => void;
  /** True when anything is actually narrowed — drives SAB HATAO. */
  narrowed: boolean;
  /** Drawer visibility. The rail is closed by default at every width. */
  open: boolean;
  onClose: () => void;
}

/**
 * How many filters are actually applied. The rail is COLLAPSED by default now,
 * so this number is the only thing standing between a visitor and "why are
 * there only two listings?" — it rides on the Filters button and must count
 * exactly what narrows the grid, nothing else. Sort is excluded on purpose: it
 * reorders, it never hides a card.
 */
export function activeFilterCount(value: RailState): number {
  let n = 0;
  if (value.vertical) n++;
  if (value.date) n++;
  if (value.price && value.price !== 'all') n++;
  return n;
}

/**
 * The bazaar FILTERS rail — the comp's left sidebar
 * (design/marketplace/avaTOK Marketplace.dc.html).
 *
 * [MARKET-BAZAAR-2 2026-08-31, owner decision] This REPLACES the three rows of
 * Type / Category / Sort chips. The page was saying the same thing twice: 25
 * category tiles under the hero and 25 category chips again above the grid, on
 * one screen.
 *
 * Three honesty rules the comp does not have, because the comp has no data:
 *
 *  1. THE COUNTS ARE THE CATALOGUE'S, not this page's. They come from the
 *     worker's `section_counts`, computed over every published listing.
 *     [MARKET-SECTION-1] fixed this: they used to count the rows the browser
 *     happened to have fetched, so "Consulting 0" meant "none on this page" —
 *     a different claim from "none exist", and one that starts lying the moment
 *     pagination kicks in. The comp prints a flat "8" beside every row.
 *  2. WHEN THE COUNT IS UNKNOWN, NOTHING IS PRINTED. `countsKnown` is false if
 *     the worker could not compute them; the rail then shows a blank rather
 *     than a zero, because "0" is a claim and "we do not know" is not.
 *  3. A SECTION NOTHING CAN REACH IS MARKED, not silently empty. Three of the
 *     seven have no (kind, category) that resolves to them (see
 *     VERTICALS_WITHOUT_A_SOURCE and its worker twin), so they can never have a
 *     count. They stay listed — they are real products the owner wants visible —
 *     but they are not clickable filters leading to a dead end.
 */
export function FilterRail({ value, onChange, counts, countsKnown, total, onClear, narrowed, open, onClose }: FilterRailProps) {
  const set = (patch: Partial<RailState>) => onChange({ ...value, ...patch });

  const label = 'font-label text-[0.75rem] font-extrabold uppercase tracking-[0.14em] text-inkMute';

  // [MARKET-FILTER-DRAWER-1] Escape closes, and the page behind stops scrolling
  // while the drawer is up. Both effects are unconditional hooks with an early
  // return inside — a `if (!open) return null` ABOVE a hook would change the
  // hook count between renders, which React treats as a bug, not a shortcut.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex"
      style={{ background: 'rgba(35,27,20,0.45)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Filters"
    >
      <aside
        className="h-full w-full max-w-[330px] overflow-y-auto overscroll-contain bg-paper p-4 shadow-zine"
        onClick={(e) => e.stopPropagation()}
      >
      <div className="overflow-hidden rounded-zine border-zine border-ink bg-card shadow-zine">
        {/* The comp's lotus strip. Rendered here as markup rather than the
            TruckBorder Astro component because this is a React island. */}
        <div className="border-b-zine border-ink" aria-hidden="true">
          <div className="flex h-[30px] items-end justify-center gap-3 overflow-hidden bg-mintInk pb-1 [box-shadow:inset_0_-3px_0_var(--zine-lime)]">
            {Array.from({ length: 30 }, (_, i) => (
              <span key={i} className="relative block h-5 w-6 flex-none">
                <span className="absolute bottom-0 left-px block h-3.5 w-[9px] -rotate-[30deg] rounded-t-full bg-coral" />
                <span className="absolute bottom-0 right-px block h-3.5 w-[9px] rotate-[30deg] rounded-t-full bg-coral" />
                <span className="absolute bottom-px left-1/2 block h-[18px] w-[9px] -translate-x-1/2 rounded-t-full bg-lime" />
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-baseline justify-between gap-2.5 px-5 pb-1.5 pt-4">
          <h2 className="font-display text-[1.5rem] font-normal uppercase tracking-[0.05em] text-ink">Filters</h2>
          <div className="flex items-center gap-3">
            {narrowed && (
              <button
                type="button"
                onClick={onClear}
                className="font-label text-[0.75rem] font-extrabold uppercase tracking-[0.08em] text-coral underline"
              >
                Sab hatao
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close filters"
              className="grid h-7 w-7 flex-none place-items-center self-center rounded-full border-2 border-ink bg-card font-label text-[0.875rem] font-extrabold leading-none text-ink"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="px-5 pb-4 pt-2">
          <p className={`${label} mb-2.5`}>Category</p>
          <ul className="m-0 flex list-none flex-col p-0">
            <RailRadio
              label="Everything"
              count={countsKnown ? total : null}
              selected={!value.vertical}
              onSelect={() => set({ vertical: undefined })}
            />
            {VERTICALS.map((v) => {
              const unreachable = VERTICALS_WITHOUT_A_SOURCE.has(v.id);
              return (
                <RailRadio
                  key={v.id}
                  label={v.label}
                  count={unreachable || !countsKnown ? null : counts[v.id]}
                  // "Soon", not "Coming soon": the rail is 248px and the right
                  // column shares the row with the label. The longer string
                  // pushed "Live friends", "Adda rooms" and "Glow-up studio"
                  // onto two lines each, which made a tidy radio list look ragged.
                  note={unreachable ? 'Soon' : undefined}
                  disabled={unreachable}
                  selected={value.vertical === v.id}
                  onSelect={() => set({ vertical: value.vertical === v.id ? undefined : v.id })}
                />
              );
            })}
          </ul>
        </div>

        <div className="border-t-2 border-dashed border-ink/35 px-5 pb-4 pt-3.5">
          <label htmlFor="rail-date" className={`${label} mb-2.5 block`}>
            Available on
          </label>
          {/* The comp draws a bespoke calendar popover. A native date input is
              used instead: it is keyboard- and screen-reader-complete, it opens
              the platform picker people already know, and it cannot disagree
              with the value the grid filters on. */}
          <input
            id="rail-date"
            type="date"
            value={value.date ?? ''}
            onChange={(e) => set({ date: e.currentTarget.value || undefined })}
            className="w-full rounded-zineBadge border-2 border-ink bg-paper px-3.5 py-2.5 font-label text-[0.8125rem] font-bold uppercase tracking-[0.04em] text-ink shadow-zine-sm outline-none focus:shadow-zine-focus"
          />
          {value.date && (
            <button
              type="button"
              onClick={() => set({ date: undefined })}
              className="mt-2 font-label text-[0.75rem] font-extrabold uppercase tracking-[0.08em] text-coral underline"
            >
              Koi bhi din
            </button>
          )}
        </div>

        <div className="border-t-2 border-dashed border-ink/35 px-5 pb-5 pt-4">
          <p className={`${label} mb-3`}>Price</p>
          <div className="flex flex-wrap gap-2">
            {PRICE_BANDS.map((p) => {
              const on = (value.price || 'all') === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ price: p.id })}
                  className={`rounded-full border-2 border-ink px-3.5 py-2 font-label text-[0.75rem] font-extrabold uppercase tracking-[0.05em] ${
                    on ? 'bg-coral text-card' : 'bg-card text-ink'
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t-2 border-dashed border-ink/35 px-5 pb-5 pt-4">
          <p className={`${label} mb-3`}>Sort</p>
          <div className="flex flex-wrap gap-2">
            {SORTS.map((o) => {
              const on = (value.sort ?? '') === o.id;
              return (
                <button
                  key={o.id || 'default'}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ sort: o.id })}
                  className={`rounded-full border-2 border-ink px-3.5 py-2 font-label text-[0.75rem] font-extrabold uppercase tracking-[0.05em] ${
                    on ? 'bg-lime text-ink' : 'bg-card text-ink'
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="mt-4 w-full rounded-full border-zine border-ink bg-coral px-6 py-3 font-display text-[0.9375rem] font-normal uppercase tracking-[0.06em] text-card shadow-zine-sm"
      >
        {/* No count on this button: `total` is the CATALOGUE total, not the
            filtered result count, so printing it here would promise a number
            the grid is about to contradict. */}
        Dikhao
      </button>

      <p className="mx-2.5 mt-4 -rotate-2 font-hand text-[1.125rem] leading-[1.35] text-coral">
        Jo dhoondoge, wahi milega.
        <br />— Bazaar rule #1
      </p>
      </aside>
    </div>
  );
}

function RailRadio({
  label,
  count,
  note,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  count: number | null;
  note?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
        className={`flex w-full items-center gap-2.5 py-1 text-left ${disabled ? 'cursor-default opacity-55' : ''}`}
      >
        <span className="grid h-[15px] w-[15px] flex-none place-items-center rounded-full border-2 border-ink bg-card">
          {selected && <span className="block h-[7px] w-[7px] rounded-full bg-coral" />}
        </span>
        <span
          className={`min-w-0 flex-1 truncate font-body text-[0.875rem] text-ink ${selected ? 'font-bold' : 'font-medium'}`}
        >
          {label}
        </span>
        <span className="flex-none whitespace-nowrap font-label text-[0.75rem] font-bold uppercase tracking-[0.06em] text-inkMute">
          {note ?? count ?? ''}
        </span>
      </button>
    </li>
  );
}

export default FilterRail;
