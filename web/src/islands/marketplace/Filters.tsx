import { useEffect, useState } from 'react';
import { getCategories } from './api';
import type { MarketCategory } from './api';
import { Pill, Spinner } from '../../components';
import type { ListingKind } from '../../lib/types';

/** The filter state ExploreGrid drives its fetches from. */
export interface FilterState {
  category?: string;
  kind?: ListingKind;
  sort?: string;
}

export interface FiltersProps {
  value: FilterState;
  onChange: (next: FilterState) => void;
}

const KINDS: { id: ListingKind; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'consult', label: '1:1' },
  { id: 'event', label: 'Events' },
  { id: 'agent', label: 'AI agents' },
];

const SORTS: { id: string; label: string }[] = [
  { id: 'relevance', label: 'Top' },
  { id: 'newest', label: 'Newest' },
  { id: 'price_asc', label: 'Price ↑' },
  { id: 'price_desc', label: 'Price ↓' },
  { id: 'rating', label: 'Rated' },
];

/**
 * Marketplace filter bar — category chips (from /api/explore/categories), a
 * kind switch, and a sort selector. Fully controlled; emits a new FilterState
 * on every change. A chip already active toggles back off.
 */
export function Filters({ value, onChange }: FiltersProps) {
  const [cats, setCats] = useState<MarketCategory[] | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    getCategories(ac.signal)
      .then(setCats)
      .catch(() => setCats([]));
    return () => ac.abort();
  }, []);

  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-4">
      {/* Kind switch */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkSoft">Type</span>
        <Pill kind={!value.kind ? 'ok' : 'plain'} onClick={() => set({ kind: undefined })}>
          All
        </Pill>
        {KINDS.map((k) => (
          <Pill key={k.id} kind={value.kind === k.id ? 'ok' : 'plain'} onClick={() => set({ kind: value.kind === k.id ? undefined : k.id })}>
            {k.label}
          </Pill>
        ))}
      </div>

      {/* Categories */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkSoft">Category</span>
        {!cats ? (
          <Spinner size={16} />
        ) : (
          cats.map((c) => (
            <Pill
              key={c.id}
              kind={value.category === c.id ? 'ok' : 'plain'}
              onClick={() => set({ category: value.category === c.id ? undefined : c.id })}
            >
              {c.emoji ? `${c.emoji} ` : ''}
              {c.label}
            </Pill>
          ))
        )}
      </div>

      {/* Sort */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkSoft">Sort</span>
        {SORTS.map((s) => (
          <Pill key={s.id} kind={(value.sort ?? 'relevance') === s.id ? 'ok' : 'plain'} onClick={() => set({ sort: s.id })}>
            {s.label}
          </Pill>
        ))}
      </div>
    </div>
  );
}

export default Filters;
