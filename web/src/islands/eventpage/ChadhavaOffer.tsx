// [SAATHUM-EVENT-PAGE 2026-09-26] "Offer chadhava" section on the event page.
// Public, unauthenticated GET — agent A2 builds the endpoint
// (routes/saathum_chadhava.ts). Client-fetched deliberately (SPEC-2026-09-26
// §"Build" item 8) so a slow/unavailable endpoint never blocks the SSR page:
// this island renders nothing until data arrives, and nothing at all if the
// fetch fails or the catalogue is empty. Never invents products or prices.
import { useEffect, useState } from 'react';
import { IslandBoundary } from '../../components/IslandBoundary';
import { API_BASE, cfImage } from '../../lib/config';
import { captureException } from '../../lib/analytics';

interface ChadhavaItem {
  id: string;
  title: string;
  description?: string | null;
  price_rupees: number;
  image_url?: string | null;
}

function ChadhavaImage({ item }: { item: ChadhavaItem }) {
  const [broken, setBroken] = useState(false);
  if (!item.image_url || broken) {
    // [SAATHUM-EVENT-PAGE] Owner: photos are pending, so a 404 must not look broken.
    return <div className="ep-im" aria-hidden="true">🌼</div>;
  }
  return (
    <div className="ep-im">
      <img src={cfImage(item.image_url, { width: 400, fit: 'cover' })} alt="" loading="lazy" onError={() => setBroken(true)} />
    </div>
  );
}

function ChadhavaOfferInner({ listingId }: { listingId: string }) {
  const [items, setItems] = useState<ChadhavaItem[] | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/saathum/chadhava`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`chadhava ${res.status}`);
        const data = (await res.json()) as { items?: ChadhavaItem[] };
        setItems(Array.isArray(data.items) ? data.items : []);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        captureException(err, { surface: 'event_page_chadhava', listing_id: listingId });
        setItems([]);
      }
    })();
    return () => ctrl.abort();
  }, [listingId]);

  if (!items || items.length === 0) return null;

  return (
    <div className="ep-sec" id="chadhava">
      <div className="ep-kick">Offer chadhava</div>
      <h2>Offerings made on your behalf</h2>
      <div className="ep-chad">
        {items.map((item) => (
          <div key={item.id}>
            <ChadhavaImage item={item} />
            <b>{item.title}</b>
            <small>₹{item.price_rupees.toLocaleString('en-IN')}</small>
          </div>
        ))}
      </div>
      <p style={{ marginTop: '10px', fontSize: '13.5px' }}>
        You choose these at checkout. The priest offers them in the havan in your name.
      </p>
    </div>
  );
}

export default function ChadhavaOffer({ listingId }: { listingId: string }) {
  return (
    <IslandBoundary island="event-page-chadhava">
      <ChadhavaOfferInner listingId={listingId} />
    </IslandBoundary>
  );
}
