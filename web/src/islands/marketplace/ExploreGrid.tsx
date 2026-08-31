import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getExplore } from '../../lib/apiClient';
import { searchListings } from './api';
import type { Card, CardPage } from '../../lib/types';
import { ListingTile, Button, Spinner } from '../../components';
import { SearchBox } from './SearchBox';
import { Filters, type FilterState } from './Filters';
import { LiveNowRail } from './LiveNowRail';

export interface ExploreGridProps {
  /** Initial search query from the URL (?q=), set by the hero search strip. */
  initialQ?: string;
  /** Render the grid's own search field. False when the page has the hero strip. */
  showSearch?: boolean;
  /** Initial category from the URL (?category=). */
  initialCategory?: string;
  /** Initial kind from the URL (?kind=). */
  initialKind?: string;
  /** Page size for each fetch. */
  pageSize?: number;
  /** Render the live rail above the grid (default true). */
  showLiveRail?: boolean;
  /** Prefix for listing links, e.g. "/dashboard" to keep authed users in the dashboard. */
  hrefBase?: string;
}

const PAGE = 24;

/**
 * The marketplace browse island. Owns the search query + filter state, fetches
 * /api/explore (browse) or /api/explore/search (query), paginates via the
 * `cursor` field, and renders a responsive ListingTile grid. A query switches
 * the fetch to the search endpoint; clearing it returns to browse.
 */
export function ExploreGrid({ initialQ, initialCategory, initialKind, pageSize = PAGE, showLiveRail = true, showSearch = true, hrefBase = '' }: ExploreGridProps) {
  const [q, setQ] = useState(initialQ?.trim() ?? '');
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

  /**
   * Whether a fetch has ever COMPLETED. Not the same as `!loading`, and the
   * difference is a real bug this guards.
   *
   * [MARKET-BAZAAR-1 2026-08-31] This island is mounted `client:visible`, so
   * Astro server-renders it and only hydrates once it scrolls into view. At
   * first render `items` is empty and `loading` is false, so the old
   * `!loading && items.length === 0` test was TRUE in the SSR output — the
   * server shipped the empty state as static HTML. Every visitor saw "nothing
   * here" below the fold before a request had been made, and a visitor arriving
   * on ?q=… got "Koi nahi mila, boss." for their own search before it ran.
   * Nothing looked broken while the box read "Nothing here yet"; in the bazaar
   * copy it reads as a definitive answer to a question nobody had asked yet.
   */
  const [loaded, setLoaded] = useState(false);

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
        if (mine === reqId.current) {
          setLoading(false);
          setLoaded(true);
        }
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

  const empty = loaded && !loading && items.length === 0 && !error;

  /** True when the visitor narrowed the results themselves — the only case
   *  where offering to clear filters is a real fix rather than a dead button. */
  const narrowed = Boolean(q.trim() || filters.category || filters.kind);

  const clearAll = useCallback(() => {
    setQ('');
    setFilters({ sort: 'relevance' });
    // The query and the category arrive in the URL (the hero search strip is a
    // plain GET form), so clearing only the React state would leave ?q= in the
    // address bar — and a reload or a shared link would silently re-apply the
    // filters the visitor just cleared. replaceState rather than pushState:
    // clearing is a correction, not a step worth putting in the Back history.
    if (typeof window !== 'undefined' && window.location.search) {
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {showLiveRail && <LiveNowRail />}

      <div className="flex flex-col gap-4">
        {showSearch && (
          <div className="flex items-center gap-5">
            <SearchBox value={q} onChange={setQ} />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1"><Filters value={filters} onChange={setFilters} /></div>
          {narrowed && (
            <button
              type="button"
              onClick={clearAll}
              className="flex-none font-label text-[12px] font-extrabold uppercase tracking-[0.08em] text-coral underline"
            >
              Sab hatao
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-zine border-zine border-coral bg-card p-4 font-body font-bold text-[15px] text-ink shadow-zine-error">
          {error}{' '}
          <button type="button" className="underline text-blueInk" onClick={() => void fetchPage(null, false)}>
            Retry
          </button>
        </div>
      )}

      {/* [MARKET-BAZAAR-1 2026-08-31] The comp's empty state, and it is TWO
          states, not one.

          The comp only draws the filtered case ("Koi nahi mila, boss" + a "Sab
          dikhao" button). But production has zero published listings, so the
          state a real visitor actually lands on is the UNFILTERED one — and
          there, "Sab dikhao" is a button that clears nothing and reloads the
          same emptiness, which reads as a broken page. So a narrowed search
          gets the comp's copy and a working clear button, and a genuinely empty
          bazaar gets its own honest copy and a route to the thing a visitor CAN
          do. Same chrome either way, so it still looks deliberate. */}
      {empty && (
        <div className="flex flex-wrap items-center justify-center gap-6 rounded-[22px] border-zine border-dashed border-ink bg-card px-7 py-10 text-center">
          <div className="grid h-[104px] w-[104px] flex-none -rotate-[8deg] place-items-center rounded-full border-zine border-dashed border-coral">
            <span className="font-label text-[11px] font-extrabold uppercase leading-[1.7] tracking-[0.06em] text-coral">
              {narrowed ? (<>Buri nazar<br />lag gayi<br />· 404 ·</>) : (<>Bazaar<br />khul raha<br />hai</>)}
            </span>
          </div>
          <div className="max-w-[40ch] text-left">
            <p className="font-display text-[24px] font-normal uppercase tracking-[0.055em] [word-spacing:0.2em] text-ink">
              {narrowed ? 'Koi nahi mila, boss.' : 'Abhi dukaan saj rahi hai.'}
            </p>
            <p className="mt-2 font-body text-[15px] font-medium leading-[1.5] text-inkSoft">
              {narrowed
                ? 'Is filter combination mein full sannata hai. Thoda filter loosen karo.'
                : 'No listings are published yet. Creators are still setting up their stalls — check back soon, or open your own.'}
            </p>
            <div className="mt-4">
              {narrowed ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="rounded-full border-zine border-ink bg-coral px-7 py-3 font-display text-[14px] font-normal uppercase tracking-[0.06em] text-card transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px]"
                >
                  Sab dikhao
                </button>
              ) : (
                <a
                  href="/sign-up"
                  className="inline-flex rounded-full border-zine border-ink bg-lime px-7 py-3 font-display text-[14px] font-normal uppercase tracking-[0.06em] text-ink no-underline shadow-zine-sm transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
                >
                  Become a creator
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* [CARD-BAZAAR-1] The comp uses auto-fill/minmax(14.5rem) rather than fixed
          breakpoints, and the card's 6x7px hard shadow needs gutter room — a tight
          4-column grid clipped it. gap-6 keeps the shadows clear of each other. */}
      <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(14.5rem, 1fr))' }}>
        {items.map((l) => (
          <ListingTile key={l.id} listing={l} href={hrefBase ? `${hrefBase}/l/${encodeURIComponent(l.id)}` : undefined} />
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
