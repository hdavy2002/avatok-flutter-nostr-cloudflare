import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getExplore } from '../../lib/apiClient';
import { searchListings } from './api';
import type { Card, CardPage } from '../../lib/types';
import { Button, Spinner } from '../../components';
import { SearchBox } from './SearchBox';
import { FilterRail, PRICE_BANDS, type RailState } from './FilterRail';
import { VerticalSection } from './VerticalSection';
import { LiveNowRail } from './LiveNowRail';
import { countByVertical, groupByVertical, verticalOf, type VerticalId } from '../../lib/verticals';

export interface ExploreGridProps {
  /** Initial search query from the URL (?q=), set by the hero search strip. */
  initialQ?: string;
  /** Render the grid's own search field. False when the page has the hero strip. */
  showSearch?: boolean;
  /** Initial vertical from the URL (?vertical=). */
  initialVertical?: string;
  /** Page size for each fetch. */
  pageSize?: number;
  /** Render the live rail above the results (default true). */
  showLiveRail?: boolean;
  /** Prefix for listing links, e.g. "/dashboard". */
  hrefBase?: string;
}

const PAGE = 24;

/**
 * The marketplace browse island: the comp's two-column body — FILTERS rail on
 * the left, numbered vertical sections on the right.
 *
 * [MARKET-BAZAAR-2 2026-08-31, owner decision] The Type / Category / Sort chip
 * rows are GONE, replaced by FilterRail. Do not reintroduce them: with the
 * category tiles under the hero, the chips made the page state the same
 * taxonomy twice on one screen.
 *
 * WHERE FILTERING HAPPENS, AND WHY IT IS SPLIT.
 * `q` goes to the server (/api/explore/search) because full-text search has to.
 * Vertical, price and date are applied CLIENT-SIDE to the fetched page, because
 * the API cannot filter on any of them: `vertical` is not a field it has (see
 * lib/verticals.ts — it is derived here from kind+category), and price/date
 * filtering by band is not exposed on /api/explore.
 *
 * That split has a real consequence worth stating plainly rather than hiding:
 * these three filters only narrow WHAT HAS BEEN LOADED, so with pagination they
 * can look like they are hiding results until "Load more" is pressed. It is the
 * honest behaviour available today, and it is the first thing to delete once the
 * worker can filter server-side. Sort was dropped entirely rather than kept as a
 * control that reorders one page and claims to order the catalogue.
 */
export function ExploreGrid({
  initialQ,
  initialVertical,
  pageSize = PAGE,
  showLiveRail = true,
  showSearch = true,
  hrefBase = '',
}: ExploreGridProps) {
  const [q, setQ] = useState(initialQ?.trim() ?? '');
  const [rail, setRail] = useState<RailState>({
    vertical: (initialVertical as VerticalId) || undefined,
    price: 'all',
  });

  const [items, setItems] = useState<Card[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  /**
   * Whether a fetch has ever COMPLETED. Not the same as `!loading`.
   *
   * [MARKET-BAZAAR-1 2026-08-31] This island is mounted `client:visible`, so
   * Astro server-renders it and only hydrates once it scrolls into view. At
   * first render `items` is empty and `loading` is false, so the old
   * `!loading && items.length === 0` test was TRUE in the SSR output — the
   * server shipped the empty state as static HTML. Every visitor saw "nothing
   * here" below the fold before a request had been made, and a visitor arriving
   * on ?q=… got "Koi nahi mila, boss." about their own search before it ran.
   */
  const [loaded, setLoaded] = useState(false);

  const usingSearch = q.trim().length > 0;

  // Only the SERVER-SIDE inputs belong here. Adding vertical/price/date would
  // refetch the whole list every time a local filter is toggled.
  const resetKey = useMemo(() => JSON.stringify({ q: q.trim() }), [q]);

  const fetchPage = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      const mine = ++reqId.current;
      setLoading(true);
      setError(null);
      try {
        let page: CardPage;
        if (usingSearch) {
          page = await searchListings({ q: q.trim(), limit: pageSize, cursor: nextCursor ?? undefined });
        } else {
          page = await getExplore({ limit: pageSize, cursor: nextCursor ?? undefined });
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
    [usingSearch, q, pageSize],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    void fetchPage(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  /** Client-side narrowing. See the note on this component. */
  const visible = useMemo(() => {
    const band = PRICE_BANDS.find((b) => b.id === (rail.price || 'all')) ?? PRICE_BANDS[0];
    return items.filter((l) => {
      if (rail.vertical && verticalOf(l) !== rail.vertical) return false;

      // `price` is in tokens (₹1 = 1 token). A null/undefined price means the
      // listing carries no price yet — treated as free, matching the card, which
      // prints "FREE" for the same value.
      const price = Number(l.effective_price ?? l.price ?? 0);
      if (price < band.min) return false;
      if (band.max != null && price > band.max) return false;

      if (rail.date) {
        // `starts_at` is epoch MILLISECONDS (e.g. 1788148800000), not an ISO
        // string — `new Date('1788148800000')` would be Invalid Date and every
        // listing would silently survive the filter.
        //
        // A listing with no start time is always-available (a 1:1 or an agent),
        // so it survives a date filter rather than being hidden by it. The
        // comparison is on the VIEWER's local calendar day, which is what the
        // date input gives us and what "available on the 6th" means to a person.
        const startsAt = l.starts_at;
        if (startsAt != null) {
          const d = new Date(Number(startsAt));
          if (Number.isFinite(d.getTime())) {
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (iso !== rail.date) return false;
          }
        }
      }
      return true;
    });
  }, [items, rail.vertical, rail.price, rail.date]);

  const counts = useMemo(() => countByVertical(items), [items]);
  const sections = useMemo(() => groupByVertical(visible), [visible]);

  const narrowed = Boolean(q.trim() || rail.vertical || rail.date || (rail.price && rail.price !== 'all'));
  const empty = loaded && !loading && visible.length === 0 && !error;

  const clearAll = useCallback(() => {
    setQ('');
    setRail({ price: 'all' });
    // The query arrives in the URL (the hero search strip is a plain GET form),
    // so clearing only React state would leave ?q= in the address bar — and a
    // reload or a shared link would silently re-apply what was just cleared.
    // replaceState, not pushState: clearing is a correction, not a history step.
    if (typeof window !== 'undefined' && window.location.search) {
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    }
  }, []);

  return (
    <div className="flex flex-col gap-8">
      {showLiveRail && <LiveNowRail />}
      {showSearch && <SearchBox value={q} onChange={setQ} />}

      <div className="flex flex-col items-start gap-8 lg:flex-row">
        <FilterRail
          value={rail}
          onChange={setRail}
          counts={counts}
          total={items.length}
          onClear={clearAll}
          narrowed={narrowed}
        />

        <main className="min-w-0 flex-1">
          <div className="mb-8 flex items-center gap-3.5">
            <span className="font-label text-[13px] font-extrabold uppercase tracking-[0.12em] text-ink">
              {loaded ? `${visible.length} ${visible.length === 1 ? 'listing' : 'listings'} · Pura bazaar` : 'Loading the bazaar…'}
            </span>
            <span className="h-0.5 min-w-[60px] flex-1 bg-ink/20" />
          </div>

          {error && (
            <div className="rounded-zine border-zine border-coral bg-card p-4 font-body text-[15px] font-bold text-ink shadow-zine-error">
              {error}{' '}
              <button type="button" className="text-blueInk underline" onClick={() => void fetchPage(null, false)}>
                Retry
              </button>
            </div>
          )}

          {/* [MARKET-BAZAAR-1] Two empty states, not one. The comp only draws the
              filtered case ("Koi nahi mila, boss" + "Sab dikhao"). But with
              nothing published, the state a real visitor lands on is the
              UNFILTERED one — where "Sab dikhao" clears nothing and reloads the
              same emptiness, which reads as a broken page. So a narrowed search
              gets the comp's copy and a working clear button, and a genuinely
              empty bazaar gets honest copy and the one thing a visitor can do. */}
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

          <div className="flex flex-col gap-14">
            {sections.map((s, i) => (
              <VerticalSection
                key={s.vertical.id}
                vertical={s.vertical}
                listings={s.listings}
                index={i}
                hrefBase={hrefBase}
              />
            ))}
          </div>

          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-inkSoft">
              <Spinner size={20} /> <span className="font-body text-[14px] font-bold">Loading…</span>
            </div>
          )}

          {!loading && cursor && (
            <div className="flex justify-center pt-8">
              <Button variant="blue" onClick={() => void fetchPage(cursor, true)}>
                Load more
              </Button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default ExploreGrid;
