import { useEffect, useRef, useState } from 'react';
import { getLiveNow } from '../../lib/apiClient';
import type { Card } from '../../lib/types';
import { ListingTile, Pill, Spinner } from '../../components';
// [WEB-POSTHOG-1] §2.3 market_live_rail_loaded.
import { capture } from '../../lib/analytics';

export interface LiveNowRailProps {
  /** Section heading. */
  title?: string;
  /** Hide entirely when nothing is live (default true). */
  hideWhenEmpty?: boolean;
}

/**
 * Horizontal "live now" rail — fetches /api/explore/live-now and renders a
 * scrollable row of listing tiles. Used on the landing and at the top of
 * /explore. Self-contained island; safe to drop in with `client:visible`.
 */
export function LiveNowRail({ title = 'Live now', hideWhenEmpty = true }: LiveNowRailProps) {
  const [items, setItems] = useState<Card[] | null>(null);
  const [failed, setFailed] = useState(false);
  const ac = useRef<AbortController | null>(null);

  useEffect(() => {
    ac.current = new AbortController();
    getLiveNow(ac.current.signal)
      .then((r) => {
        const listings = r.listings ?? [];
        setItems(listings);
        capture('market_live_rail_loaded', { count: listings.length });
      })
      .catch((e) => {
        if ((e as Error)?.name !== 'AbortError') setFailed(true);
      });
    return () => ac.current?.abort();
  }, []);

  if (failed) return null;
  if (items && items.length === 0 && hideWhenEmpty) return null;

  return (
    <section aria-label={title} className="w-full pb-8">
      <div className="mb-3 flex items-center gap-2.5">
        <Pill kind="no">● {title}</Pill>
        {items && <span className="font-label text-[0.8125rem] font-extrabold uppercase tracking-[0.08em] text-inkMute">{items.length}</span>}
      </div>

      {!items ? (
        <div className="flex items-center gap-2 py-6 text-inkSoft">
          <Spinner size={18} /> <span className="font-body font-bold text-[0.875rem]">Loading live…</span>
        </div>
      ) : (
        <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* [CARD-BAZAAR-1] 232/248px, not 200/220: the bazaar card carries two chips
              and two CTAs side by side and the comp's grid never goes below 14.5rem
              (232px); narrower than that the buttons wrap. pb-3 is shadow clearance. */}
          {items.map((l, i) => (
            <div key={l.id} className="w-[232px] shrink-0 snap-start sm:w-[248px]">
              <ListingTile listing={l} href={`/watch/${encodeURIComponent(l.id)}`} width={520} position={i} section="live_now" />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default LiveNowRail;
