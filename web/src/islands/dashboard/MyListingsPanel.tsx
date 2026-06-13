/* MyListingsPanel — the creator's listings pipeline (app: My Listings).
 * GET /api/listings/mine → { listings: Card[] } (drafts + published + live,
 * newest first). Empty state offers the create CTA. Never shows fake data.
 */
import { useEffect, useState } from 'react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import { ListingTile } from '../../components/ListingTile';
import type { Card as ListingCard } from '../../lib/types';

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [listings, setListings] = useState<ListingCard[] | null>(null);

  useEffect(() => {
    void (async () => {
      setToken(await getActiveToken());
      setChecked(true);
    })();
  }, []);

  useEffect(() => {
    if (!token) {
      if (checked) setListings([]);
      return;
    }
    void (async () => {
      try {
        const r = await request<{ listings: ListingCard[] }>('/api/listings/mine', { auth: token });
        setListings(r.listings ?? []);
      } catch {
        setListings([]);
      }
    })();
  }, [token, checked]);

  if (!checked || !listings) return <div className="flex items-center gap-3 p-6"><Spinner size={22} /></div>;

  if (!listings.length) {
    return (
      <Card fillClassName="bg-paper2" shadow="sm">
        <div className="flex flex-col items-start gap-3 p-2">
          <h2 className="font-display font-semibold text-[20px] text-ink">No listings yet</h2>
          <p className="font-body font-bold text-[15px] text-inkSoft">
            Publish a live event, a 1:1 consult, a class or an AI agent — fans book and pay right from the web.
          </p>
          <a href="/dashboard/listings/new" className="rounded-full border-zine border-ink bg-lime px-5 py-2.5 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink no-underline shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">
            Create your first listing
          </a>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {listings.map((l) => (
        <ListingTile key={l.id} listing={l} />
      ))}
    </div>
  );
}

export function MyListingsPanel() {
  return (
    <ClerkIsland>
      <Inner />
    </ClerkIsland>
  );
}

export default MyListingsPanel;
