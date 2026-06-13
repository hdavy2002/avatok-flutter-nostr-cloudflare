// MarketplaceGrid — the AvaVision discovery island for /vision.
//
// Mirrors the Phase-A ExploreGrid shape (search box + responsive ListingTile
// grid + request-race guard) but reads the AvaVision marketplace and renders
// VisionCard. Availability is polled in the background so the Call-Now / Busy
// chip stays live without blocking first paint.
//
// PUBLIC read — no auth (the gate fires later, on the agent/session page).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '../../components/Spinner';
import { getMarketplace, getAvailability, type VisionAgent } from './avavisionApi';
import { VisionCard } from './VisionCard';

const POLL_MS = 20_000; // availability refresh cadence
const DEBOUNCE_MS = 300;

export interface MarketplaceGridProps {
  /** Initial query from the URL (?q=). */
  initialQuery?: string;
}

export function MarketplaceGrid({ initialQuery = '' }: MarketplaceGridProps) {
  const [q, setQ] = useState(initialQuery);
  const [items, setItems] = useState<VisionAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
  const reqId = useRef(0);

  const fetchAgents = useCallback(async (query: string) => {
    const mine = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const agents = await getMarketplace(query.trim() || undefined);
      if (mine !== reqId.current) return;
      setItems(agents);
      setBusyMap(
        Object.fromEntries(agents.map((a) => [a.id, (a.activeCalls ?? 0) >= 10])),
      );
    } catch (e) {
      if (mine !== reqId.current) return;
      if ((e as Error)?.name !== 'AbortError') setError('Could not load vision agents. Please try again.');
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, []);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => void fetchAgents(q), q === initialQuery ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Background availability poll — best-effort, never surfaces errors.
  useEffect(() => {
    if (items.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        items.map(async (a) => {
          try {
            const av = await getAvailability(a.id);
            return [a.id, av.busy] as const;
          } catch {
            return [a.id, busyMap[a.id] ?? false] as const;
          }
        }),
      );
      if (!cancelled) setBusyMap(Object.fromEntries(entries));
    };
    const h = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const empty = !loading && items.length === 0 && !error;

  return (
    <div className="flex flex-col gap-6">
      {/* search */}
      <label className="block">
        <span className="mb-2 block font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">
          Search vision agents
        </span>
        <input
          type="search"
          inputMode="search"
          placeholder="form coach, guitar, yoga, cooking…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full rounded-zineField border-zine border-ink bg-card px-4 py-3.5 font-body font-extrabold text-[17px] text-ink shadow-zine-sm outline-none placeholder:font-bold placeholder:text-placeholder focus:-translate-x-[1px] focus:-translate-y-[1px] focus:shadow-zine-focus transition-transform duration-zine"
        />
      </label>

      {error && (
        <div className="rounded-zine border-zine border-coral bg-card p-4 font-body font-bold text-[15px] text-ink shadow-zine-error">
          {error}{' '}
          <button type="button" className="underline text-blueInk" onClick={() => void fetchAgents(q)}>
            Retry
          </button>
        </div>
      )}

      {empty && (
        <div className="rounded-zine border-zine border-ink bg-paper2 p-8 text-center">
          <p className="font-display font-semibold text-[20px] text-ink">No vision agents yet</p>
          <p className="mt-1 font-body font-bold text-[14px] text-inkSoft">
            Try a different search — or build the first one in the studio.
          </p>
          <a
            href="/vision/studio"
            className="mt-4 inline-flex items-center justify-center rounded-full border-zine border-ink bg-lime px-5 py-3 font-display font-semibold text-[17px] text-ink shadow-zine-sm no-underline transition-transform duration-zine active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed"
          >
            Create a vision agent
          </a>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((a) => (
          <VisionCard key={a.id} agent={a} busy={busyMap[a.id]} />
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-6 text-inkSoft">
          <Spinner size={20} /> <span className="font-body font-bold text-[14px]">Loading…</span>
        </div>
      )}
    </div>
  );
}

export default MarketplaceGrid;
