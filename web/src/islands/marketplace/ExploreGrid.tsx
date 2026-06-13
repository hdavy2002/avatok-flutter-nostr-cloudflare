import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getExplore } from '../../lib/apiClient';
import { searchListings } from './api';
import type { Card, CardPage } from '../../lib/types';
import { ListingTile, Button, Spinner } from '../../components';
import { SearchBox } from './SearchBox';
import { Filters, type FilterState } from './Filters';
import { LiveNowRail } from './LiveNowRail';

export interface ExploreGridProps {
  /** Initial category from the URL (?category=). */
  initialCategory?: string;
  /** Initial kind from the URL (?kind=). */
  initialKind?: string;
  /** Page size for each fetch. */
  pageSize?: number;
  /** Render the live rail above the grid (default true). */
  showLiveRail?: boolean;
}

const PAGE = 24;

/**
 * The marketplace browse island. Owns the search query + filter state, fetches
 * /api/explore (browse) or /api/explore/search (query), paginates via the
 * `cursor` field, and renders a responsive ListingTile grid. A query switches
 * the fetch to the search endpoint; clearing it returns to browse.
 */
export function ExploreGrid({ initialCategory, initialKind, pageSize = PAGE, showLiveRail = true }: ExploreGridProps) {
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<FilterState>({
    category: initialCategory,
    kind: initialKind,
    sort: 'relevance',
  });

  const [items, setItems] = useState<Card[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const usingSearch = q.trim().length > 0;

  // Stable key that resets the result set whenever the query/filters change.
  const resetKey = useMemo(
    () => JSON.stringify({ q: q.trim(), c: filters.category, k: filters.kind, s: filters.sort }),
    [q, filters.category, filters.kind, filters.sort],
  );

  const fetchPage = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      const mine = ++reqId.current;
      setLoading(true);
      setError(null);
      try {
        let page: CardPage;
        if (usingSearch) {
          page = await searchListings({
            q: q.trim(),
            category: filters.category,
            kind: filters.kind,
            sort: filters.sort,
            limit: pageSize,
            cursor: nextCursor ?? undefined,
          });
        } else {
          page = await getExplore({
            category: filters.category,
            kind: filters.kind,
            limit: pageSize,
            cursor: nextCursor ?? undefined,
          });
        }
        if (mine !== reqId.current) return; // a newer request superseded this one
        setItems((prev) => (append ? [...prev, ...(page.listings ?? [])] : page.listings ?? []));
        setCursor(page.cursor ?? null);
      } catch (e) {
        if (mine !== reqId.current) return;
        if ((e as Error)?.name !== 'AbortError') setError('Could not load listings. Please try again.');
      } finally {
        if (mine === reqId.current) setLoading(false);
      }
    },
    [usingSearch, q, filters.category, filters.kind, filters.sort, pageSize],
  );

  // Re-run from scratch on any query/filter change.
  useEffect(() => {
    setItems([]);
    setCursor(null);
    void fetchPage(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const empty = !loading && items.length === 0 && !error;

  return (
    <div className="flex flex-col gap-6">
      {showLiveRail && <LiveNowRail />}

      <div className="flex flex-col gap-4">
        <SearchBox value={q} onChange={setQ} />
        <Filters value={filters} onChange={setFilters} />
      </div>

      {error && (
        <div className="rounded-zine border-zine border-coral bg-card p-4 font-body font-bold text-[15px] text-ink shadow-zine-error">
          {error}{' '}
          <button type="button" className="underline text-blueInk" onClick={() => void fetchPage(null, false)}>
            Retry
          </button>
        </div>
      )}

      {empty && (
        <div className="rounded-zine border-zine border-ink bg-paper2 p-8 text-center">
          <p className="font-display font-semibold text-[20px] text-ink">Nothing here yet</p>
          <p className="mt-1 font-body font-bold text-[14px] text-inkSoft">
            Try a different category or search term.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((l) => (
          <ListingTile key={l.id} listing={l} />
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-6 text-inkSoft">
          <Spinner size={20} /> <span className="font-body font-bold text-[14px]">Loading…</span>
        </div>
      )}

      {!loading && cursor && (
        <div className="flex justify-center pt-2">
          <Button variant="blue" onClick={() => void fetchPage(cursor, true)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

export default ExploreGrid;
