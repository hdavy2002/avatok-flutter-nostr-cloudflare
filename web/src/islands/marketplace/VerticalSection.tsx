import { ListingTile } from '../../components';
import type { Card } from '../../lib/types';
import type { Vertical } from '../../lib/verticals';

/**
 * One numbered results section — the comp's "01 · GROUP SHOWS · TICKETED /
 * LIVE STREAMING & SHOWS." block, with its eyebrow, two-tone Anton heading,
 * handwritten aside, truck-art rule, stub line and card grid.
 *
 * [MARKET-BAZAAR-2 2026-08-31] EMPTY SECTIONS NEVER REACH THIS COMPONENT — the
 * caller filters them out (groupByVertical). That is the owner's decision and
 * it matters more than it looks: the comp draws seven sections because it has
 * eight mock cards for each, while production has two real listings. Rendering
 * all seven would give a visitor five 404 stamps in a row on a page whose job is
 * to make the place look open.
 *
 * The stub line says "SHOWING n OF n" from the real array length rather than the
 * comp's fixed "SHOWING 8 OF 8", and the count is of what is loaded, not of the
 * catalogue — the grid paginates, so claiming a catalogue total here would be a
 * number this component cannot actually know.
 */
export function VerticalSection({
  vertical,
  listings,
  index,
  hrefBase = '',
}: {
  vertical: Vertical;
  listings: Card[];
  /** 0-based; rendered as the comp's zero-padded "01 ·". */
  index: number;
  hrefBase?: string;
}) {
  const n = listings.length;

  return (
    <section className="flex flex-col">
      <div className="flex flex-wrap items-end gap-5">
        <div className="min-w-0 flex-[1_1_300px]">
          <p className="mb-2.5 font-label text-[0.8125rem] font-extrabold uppercase tracking-[0.16em] text-coral">
            {String(index + 1).padStart(2, '0')} · {vertical.eyebrow}
          </p>
          <h2 className="m-0 font-display text-[clamp(30px,3.4vw,44px)] font-normal uppercase leading-[1.08] tracking-[0.055em] [word-spacing:0.2em] text-ink">
            {vertical.title} <span className="text-coral">{vertical.title2}</span>
          </h2>
        </div>
        {vertical.punch && (
          <p className="max-w-[30ch] -rotate-2 pb-1 font-hand text-[1.25rem] leading-[1.3] text-coral">
            “{vertical.punch}”
          </p>
        )}
      </div>

      {/* The comp's per-section truck-art rule. Inline markup rather than the
          TruckBorder Astro component — this is a React island. */}
      <div className="my-4 overflow-hidden rounded-[10px] border-zine border-ink" aria-hidden="true">
        <div className="flex h-[30px] justify-center overflow-hidden bg-blueInk [box-shadow:inset_0_3px_0_var(--zine-lime),inset_0_-3px_0_var(--zine-lime)]">
          {Array.from({ length: 40 }, (_, i) => (
            <span key={i} className="mt-[3px] flex h-4 w-[26px] flex-none justify-center rounded-b-[13px] bg-coral pt-1">
              <span className="block h-[5px] w-[5px] rounded-full bg-lime" />
            </span>
          ))}
        </div>
      </div>

      <div className="mb-5 flex justify-between gap-3">
        <span className="font-label text-[0.75rem] font-bold uppercase tracking-[0.1em] text-inkMute">
          Showing {n} of {n} · Sab haazir
        </span>
        <span className="font-label text-[0.75rem] font-bold uppercase tracking-[0.1em] text-inkMute">
          {vertical.zone}
        </span>
      </div>

      {/* [LIST-TRUST-1 §2 / task item 5] Explicit per-breakpoint columns rather
          than auto-fill/minmax — the owner's ask is a literal 4-up desktop grid
          of ~300px wide-format cards, 2-up tablet, 1-up phone, not "however many
          17rem tracks fit". gap-6 (24px) keeps the cards' 6×7px hard shadows
          clear of each other at every width. */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {listings.map((l, i) => (
          <ListingTile
            key={l.id}
            listing={l}
            href={hrefBase ? `${hrefBase}/l/${encodeURIComponent(l.id)}` : undefined}
            position={i}
            section={vertical.id}
          />
        ))}
      </div>
    </section>
  );
}

export default VerticalSection;
