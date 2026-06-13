import { useEffect, useRef, useState } from 'react';
import { getLiveNow } from '../../lib/apiClient';
import type { Card } from '../../lib/types';
import { ListingTile, Pill, Spinner } from '../../components';

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
      .then((r) => setItems(r.listings ?? []))
      .catch((e) => {
        if ((e as Error)?.name !== 'AbortError') setFailed(true);
      });
    return () => ac.current?.abort();
  }, []);

  if (failed) return null;
  if (items && items.length === 0 && hideWhenEmpty) return null;

  return (
    <section aria-label={title} className="w-full">
      <div className="mb-3 flex items-center gap-2.5">
        <Pill kind="no">● {title}</Pill>
        {items && <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-inkSoft">{items.length}</span>}
      </div>

      {!items ? (
        <div className="flex items-center gap-2 py-6 text-inkSoft">
          <Spinner size={18} /> <span className="font-body font-bold text-[14px]">Loading live…</span>
        </div>
      ) : (
        <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((l) => (
            <div key={l.id} className="w-[200px] shrink-0 snap-start sm:w-[220px]">
              <ListingTile listing={l} href={`/watch/${encodeURIComponent(l.id)}`} width={300} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default LiveNowRail;
