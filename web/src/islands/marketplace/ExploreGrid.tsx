import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getExplore } from '../../lib/apiClient';
import { searchListings } from './api';
import type { Card, CardPage } from '../../lib/types';
import { Button, Spinner } from '../../components';
import { SearchBox } from './SearchBox';
import { FilterRail, PRICE_BANDS, type RailState } from './FilterRail';
import { VerticalSection } from './VerticalSection';
import { LiveNowRail } from './LiveNowRail';
import { groupByVertical, VERTICALS, type VerticalId } from '../../lib/verticals';
import { IslandBoundary } from '../../components/IslandBoundary';
// [WEB-POSTHOG-1] §2.3 market_browse_loaded / market_browse_error / market_search.
import { capture } from '../../lib/analytics';

export interface ExploreGridProps {
  /** Initial search query from the URL (?q=), set by the hero search strip. */
  initialQ?: string;
  /** Render the grid's own search field. False when the page has the hero strip. */
  showSearch?: boolean;
  /** Initial section from the URL (?vertical=). */
  initialVertical?: string;
  /** Page size for each fetch. */
  pageSize?: number;
  /** Render the live rail above the results (default true). */
  showLiveRail?: boolean;
  /** Prefix for listing links, e.g. "/dashboard". */
  hrefBase?: string;
}

const PAGE = 24;

const EMPTY_COUNTS = Object.fromEntries(VERTICALS.map((v) => [v.id, 0])) as Record<VerticalId, number>;

/**
 * The marketplace browse island: the comp's two-column body — FILTERS rail on
 * the left, numbered sections on the right.
 *
 * [MARKET-BAZAAR-2] The Type / Category / Sort chip rows are GONE, replaced by
 * FilterRail. Do not reintroduce them: with the section tiles under the hero,
 * the chips made the page state the same taxonomy twice on one screen.
 *
 * [MARKET-SECTION-1 2026-08-31] FILTERING IS NOW THE SERVER'S JOB. Section,
 * price, date, sort and query all go to /api/explore, and the response is
 * rendered as-is.
 *
 * That is a correctness change, not a tidy-up. Section/price/date used to be
 * applied in this component to the page already fetched, so they narrowed 24
 * loaded rows rather than the catalogue: picking "Consulting" hid everything on
 * screen and showed nothing, while consulting listings sat unfetched on page 2.
 * Sort was dropped entirely at the time because a sort that reorders one page
 * while claiming to order everything is worse than no sort — it is back now
 * that the ORDER BY is the database's.
 *
 * The counts beside each rail row come from `section_counts`, which the worker
 * computes over the whole catalogue rather than the current page.
 */
function ExploreGridInner({
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
    sort: '',
  });

  const [items, setItems] = useState<Card[]>([]);
  const [counts, setCounts] = useState<Record<VerticalId, number> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  /**
   * Whether a fetch has ever COMPLETED. Not the same as `!loading`.
   *
   * [MARKET-BAZAAR-1] This island is mounted `client:visible`, so Astro
   * server-renders it and only hydrates once it scrolls into view. At first
   * render `items` is empty and `loading` is false, so the old
   * `!loading && items.length === 0` test was TRUE in the SSR output — the
   * server shipped the empty state as static HTML, and a visitor arriving on
   * ?q=… was told "Koi nahi mila, boss." about their own search before it ran.
   */
  const [loaded, setLoaded] = useState(false);

  const usingSearch = q.trim().length > 0;

  const band = useMemo(
    () => PRICE_BANDS.find((b) => b.id === (rail.price || 'all')) ?? PRICE_BANDS[0],
    [rail.price],
  );

  /** Every input the SERVER filters on. A change to any of them refetches. */
  const resetKey = useMemo(
    () => JSON.stringify({ q: q.trim(), s: rail.vertical, p: rail.price, d: rail.date, o: rail.sort }),
    [q, rail.vertical, rail.price, rail.date, rail.sort],
  );

  const fetchPage = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      const mine = ++reqId.current;
      setLoading(true);
      setError(null);
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

      // The worker takes an epoch-ms window; the rail gives a local calendar
      // day. Converting here (rather than sending the raw yyyy-mm-dd) keeps
      // "available on the 6th" meaning the viewer's 6th, which is what a person
      // picking a date in their own browser means by it.
      let from: number | undefined;
      let to: number | undefined;
      if (rail.date) {
        const [y, m, d] = rail.date.split('-').map(Number);
        if (y && m && d) {
          from = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
          to = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
        }
      }

      const common = {
        section: rail.vertical,
        minPrice: band.min > 0 ? band.min : undefined,
        maxPrice: band.max != null ? band.max : undefined,
        from,
        to,
        sort: rail.sort || undefined,
        limit: pageSize,
        cursor: nextCursor ?? undefined,
      };

      try {
        const page: CardPage = usingSearch
          ? await searchListings({ q: q.trim(), ...common })
          : await getExplore(common);
        if (mine !== reqId.current) return; // a newer request superseded this one
        const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
        const results = page.listings?.length ?? 0;
        if (usingSearch) {
          capture('market_search', { q_len: q.trim().length, results, ms });
        } else {
          capture('market_browse_loaded', {
            section: rail.vertical ?? null,
            count: results,
            ms,
            cursor: page.cursor ?? null,
          });
        }
        setItems((prev) => (append ? [...prev, ...(page.listings ?? [])] : page.listings ?? []));
        setCursor(page.cursor ?? null);
        // Only overwrite counts when the server actually sent them. A worker that
        // could not compute them sends null, and rendering that as all-zeroes
        // would claim an empty catalogue.
        if (page.section_counts) setCounts(page.section_counts as Record<VerticalId, number>);
      } catch (e) {
        if (mine !== reqId.current) return;
        if ((e as Error)?.name !== 'AbortError') {
          setError('Could not load listings. Please try again.');
          const status = (e as { status?: number })?.status ?? 0;
          capture('market_browse_error', { status, reason: (e as Error)?.message ?? 'unknown' });
        }
      } finally {
        if (mine === reqId.current) {
          setLoading(false);
          setLoaded(true);
        }
      }
    },
    [usingSearch, q, rail.vertical, rail.date, rail.sort, band, pageSize],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    void fetchPage(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const sections = useMemo(() => groupByVertical(items), [items]);

  const narrowed = Boolean(
    q.trim() || rail.vertical || rail.date || rail.sort || (rail.price && rail.price !== 'all'),
  );
  const empty = loaded && !loading && items.length === 0 && !error;

  const clearAll = useCallback(() => {
    setQ('');
    setRail({ price: 'all', sort: '' });
    // The query arrives in the URL (the hero search strip is a plain GET form),
    // so clearing only React state would leave ?q= in the address bar — and a
    // reload or a shared link would silently re-apply what was just cleared.
    // replaceState, not pushState: clearing is a correction, not a history step.
    if (typeof window !== 'undefined' && window.location.search) {
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    }
  }, []);

  const total = useMemo(
    () => (counts ? Object.values(counts).reduce((a, b) => a + b, 0) : items.length),
    [counts, items.length],
  );

  return (
    <div className="flex flex-col gap-8">
      {showLiveRail && <LiveNowRail />}
      {showSearch && <SearchBox value={q} onChange={setQ} />}

      <div className="flex flex-col items-start gap-8 lg:flex-row">
        <FilterRail
          value={rail}
          onChange={(next) => {
            // [WEB-POSTHOG-1] §2.3 market_filter_change / market_sort_change — fire
            // only for the field that actually changed, one capture per real click.
            if (next.sort !== rail.sort) {
              capture('market_sort_change', { value: next.sort || '' });
            } else if (next.vertical !== rail.vertical) {
              capture('market_filter_change', { key: 'vertical', value: next.vertical ?? null });
            } else if (next.price !== rail.price) {
              capture('market_filter_change', { key: 'price', value: next.price });
            } else if (next.date !== rail.date) {
              capture('market_filter_change', { key: 'date', value: next.date ?? null });
            }
            setRail(next);
          }}
          counts={counts ?? EMPTY_COUNTS}
          countsKnown={counts != null}
          total={total}
          onClear={() => {
            capture('market_filter_change', { key: 'clear', value: null });
            clearAll();
          }}
          narrowed={narrowed}
        />

        <main className="min-w-0 flex-1">
          <div className="mb-8 flex items-center gap-3.5">
            <span className="font-label text-[0.8125rem] font-extrabold uppercase tracking-[0.12em] text-ink">
              {loaded
                ? `${items.length} ${items.length === 1 ? 'listing' : 'listings'} · Pura bazaar`
                : 'Loading the bazaar…'}
            </span>
            <span className="h-0.5 min-w-[60px] flex-1 bg-ink/20" />
          </div>

          {error && (
            <div className="rounded-zine border-zine border-coral bg-card p-4 font-body text-[0.9375rem] font-bold text-ink shadow-zine-error">
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
              same emptiness, which reads as a broken page. */}
          {empty && (
            <div className="flex flex-wrap items-center justify-center gap-6 rounded-[22px] border-zine border-dashed border-ink bg-card px-7 py-10 text-center">
              <div className="grid h-[104px] w-[104px] flex-none -rotate-[8deg] place-items-center rounded-full border-zine border-dashed border-coral">
                <span className="font-label text-[0.6875rem] font-extrabold uppercase leading-[1.7] tracking-[0.06em] text-coral">
                  {narrowed ? (<>Buri nazar<br />lag gayi<br />· 404 ·</>) : (<>Bazaar<br />khul raha<br />hai</>)}
                </span>
              </div>
              <div className="max-w-[40ch] text-left">
                <p className="font-display text-[1.5rem] font-normal uppercase tracking-[0.055em] [word-spacing:0.2em] text-ink">
                  {narrowed ? 'Koi nahi mila, boss.' : 'Abhi dukaan saj rahi hai.'}
                </p>
                <p className="mt-2 font-body text-[0.9375rem] font-medium leading-[1.5] text-inkSoft">
                  {narrowed
                    ? 'Is filter combination mein full sannata hai. Thoda filter loosen karo.'
                    : 'No listings are published yet. Creators are still setting up their stalls — check back soon, or open your own.'}
                </p>
                <div className="mt-4">
                  {narrowed ? (
                    <button
                      type="button"
                      onClick={clearAll}
                      className="rounded-full border-zine border-ink bg-coral px-7 py-3 font-display text-[0.875rem] font-normal uppercase tracking-[0.06em] text-card transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px]"
                    >
                      Sab dikhao
                    </button>
                  ) : (
                    <a
                      href="/sign-up"
                      className="inline-flex rounded-full border-zine border-ink bg-lime px-7 py-3 font-display text-[0.875rem] font-normal uppercase tracking-[0.06em] text-ink no-underline shadow-zine-sm transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
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
              <Spinner size={20} /> <span className="font-body text-[0.875rem] font-bold">Loading…</span>
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

export function ExploreGrid(props: ExploreGridProps) {
  return (
    <IslandBoundary island="marketplace-explore-grid">
      <ExploreGridInner {...props} />
    </IslandBoundary>
  );
}

export default ExploreGrid;
