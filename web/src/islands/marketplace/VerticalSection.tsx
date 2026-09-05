import { useMemo, useState } from 'react';
import { ListingTile } from '../../components';
import type { Card } from '../../lib/types';
import { blipsForGroup, type GroupDisplay } from '../../lib/marketGroups';
import type { MarketCategory } from './api';
// [WEB-POSTHOG-1] §2.3 market_filter_change — one capture per real blip click.
import { capture } from '../../lib/analytics';

/**
 * One numbered results section — the comp's "01 · GROUP SHOWS · TICKETED /
 * LIVE STREAMING & SHOWS." block, with its eyebrow, two-tone Anton heading,
 * handwritten aside, truck-art rule, sub-category "blips" row, stub line and
 * card grid.
 *
 * [MARKET-BAZAAR-2 2026-08-31] EMPTY SECTIONS NEVER REACH THIS COMPONENT — the
 * caller filters them out (groupByGroupId). That is the owner's decision and
 * it matters more than it looks: rendering every group regardless would give a
 * visitor empty-looking sections on a page whose job is to make the place
 * look open.
 *
 * [MKT-3GROUP-WEB-1 2026-09-05] Renders one of the THREE marketplace GROUPS
 * (Specs/SPEC-2026-09-05-THREE-GROUPS-AND-HOURLY-PRICING.md §1), not one of
 * the old seven bazaar sections — this component used to be keyed on
 * `Vertical`/`VerticalId`. It also now renders the group's sub-category
 * "blips" (§2): tapping one filters the cards BELOW IT, in this section only,
 * to that sub-category — other groups' sections are untouched. Filtering
 * happens against the cards this section already has (the same page ExploreGrid
 * already fetched), the same client-side narrowing this component always did
 * for "which vertical is this card in" — it does not issue a new server
 * request, so a blip with no matching card on the current page reads as "Sab"
 * with fewer results rather than a missing filter.
 */
export function VerticalSection({
  group,
  listings,
  index,
  hrefBase = '',
  categories,
  conferenceEnabled,
}: {
  group: GroupDisplay;
  listings: Card[];
  /** 0-based; rendered as the comp's zero-padded "01 ·". */
  index: number;
  hrefBase?: string;
  /** From GET /api/explore/categories — the server's own group_id answer. */
  categories: MarketCategory[];
  /** [MKT-3GROUP-1] Hides the `adda_rooms` blip while the flag is off. */
  conferenceEnabled: boolean;
}) {
  const blips = useMemo(
    () => blipsForGroup(group.id, categories, conferenceEnabled),
    [group.id, categories, conferenceEnabled],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const shown = selected ? listings.filter((l) => l.category === selected) : listings;
  const n = shown.length;

  return (
    <section className="flex flex-col">
      <div className="flex flex-wrap items-end gap-5">
        <div className="min-w-0 flex-[1_1_300px]">
          <p className="mb-2.5 font-label text-[0.8125rem] font-extrabold uppercase tracking-[0.16em] text-coral">
            {String(index + 1).padStart(2, '0')} · {group.eyebrow}
          </p>
          <h2 className="m-0 font-display text-[clamp(30px,3.4vw,44px)] font-normal uppercase leading-[1.08] tracking-[0.055em] [word-spacing:0.2em] text-ink">
            {group.title} <span className="text-coral">{group.title2}</span>
          </h2>
        </div>
        {group.punch && (
          <p className="max-w-[30ch] -rotate-2 pb-1 font-hand text-[1.25rem] leading-[1.3] text-coral">
            “{group.punch}”
          </p>
        )}
      </div>

      {/* [MKT-3GROUP-WEB-1] The sub-category blips (spec §2). Horizontally
          scrollable, never wrapped — a phone must not need three thumb-scrolls
          of wrapped chips before it reaches the cards. */}
      {blips.length > 0 && (
        <div
          role="group"
          aria-label={`Filter ${group.title} ${group.title2} by category`}
          className="mt-4 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            type="button"
            aria-pressed={selected === null}
            onClick={() => setSelected(null)}
            className={`flex-none whitespace-nowrap rounded-full border-2 border-ink px-3.5 py-2 font-label text-[0.75rem] font-extrabold uppercase tracking-[0.05em] ${
              selected === null ? 'bg-coral text-card' : 'bg-card text-ink'
            }`}
          >
            Sab
          </button>
          {blips.map((b) => (
            <button
              key={b.id}
              type="button"
              aria-pressed={selected === b.id}
              onClick={() => {
                const next = selected === b.id ? null : b.id;
                setSelected(next);
                capture('market_filter_change', { key: 'blip', value: next, group: group.id });
              }}
              className={`flex-none whitespace-nowrap rounded-full border-2 border-ink px-3.5 py-2 font-label text-[0.75rem] font-extrabold uppercase tracking-[0.05em] ${
                selected === b.id ? 'bg-coral text-card' : 'bg-card text-ink'
              }`}
            >
              {b.emoji ? `${b.emoji} ` : ''}
              {b.label}
            </button>
          ))}
        </div>
      )}

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
          Showing {n} of {listings.length} · Sab haazir
        </span>
        <span className="font-label text-[0.75rem] font-bold uppercase tracking-[0.1em] text-inkMute">
          {group.zone}
        </span>
      </div>

      {/* [LIST-TRUST-1 §2 / task item 5] Explicit per-breakpoint columns rather
          than auto-fill/minmax — the owner's ask is a literal 4-up desktop grid
          of ~300px wide-format cards, 2-up tablet, 1-up phone, not "however many
          17rem tracks fit". gap-6 (24px) keeps the cards' 6×7px hard shadows
          clear of each other at every width. */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {shown.map((l, i) => (
          <ListingTile
            key={l.id}
            listing={l}
            href={hrefBase ? `${hrefBase}/l/${encodeURIComponent(l.id)}` : undefined}
            position={i}
            section={group.id}
          />
        ))}
      </div>
    </section>
  );
}

export default VerticalSection;
