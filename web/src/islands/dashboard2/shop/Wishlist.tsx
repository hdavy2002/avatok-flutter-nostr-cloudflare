/* Wishlist — [SAATHUM-SHOP-DASH-1] /dashboard/wishlist: grid of the saved products
 * (ids from lib/shopWish via listProducts({ids})), heart toggles, empty state.
 * Telemetry: shop_wish_toggled {product_id,on}; failures -> captureException. */
import { useEffect, useRef, useState } from 'react';
import './shopDash.css';
import { capture, captureException } from '../../../lib/analytics';
import { getWish, onWishChange, toggleWish } from '../../../lib/shopWish';
import { listProducts, type ShopCard } from '../../../lib/shopApi';
import { toast } from '../../../components/ui/sonner';
import { errMessage, isAbort } from '../accountApi';
import ProductCard from './ProductCard';

export default function Wishlist() {
  const [ids, setIds] = useState<string[]>([]);
  const [items, setItems] = useState<ShopCard[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const loaded = useRef('');

  const load = (want: string[]) => {
    if (!want.length) { setItems([]); setPhase('ready'); loaded.current = ''; return; }
    const key = [...want].sort().join(',');
    if (key === loaded.current) { setPhase('ready'); return; }
    const ac = new AbortController();
    setPhase('loading');
    listProducts({ ids: want }, ac.signal)
      .then((r) => { loaded.current = key; setItems(r.items); setPhase('ready'); })
      .catch((e) => {
        if (isAbort(e)) return;
        captureException(e, { where: 'shop_wishlist_load' });
        setError(errMessage(e, 'We could not load your wishlist. Please try again.'));
        setPhase('error');
      });
  };

  useEffect(() => {
    const first = getWish();
    setIds(first);
    load(first);
    return onWishChange((w) => { setIds(w); setItems((cur) => cur.filter((p) => w.includes(p.id))); if (!w.length) setPhase('ready'); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onWish = (p: ShopCard) => {
    const on = toggleWish(p.id);
    capture('shop_wish_toggled', { product_id: p.id, on, source: 'dash_wishlist' });
    toast(on ? 'Saved to your wishlist' : 'Removed from wishlist');
  };

  const shown = items.filter((p) => ids.includes(p.id));

  return (
    <div className="shop-dash">
      {phase === 'loading' && <p className="sh-note">Loading your wishlist…</p>}
      {phase === 'error' && (
        <div className="sh-empty"><b>Something went wrong</b><p style={{ margin: '0 0 16px' }}>{error}</p><button type="button" className="sh-btn sh-btn--red" onClick={() => { loaded.current = ''; load(getWish()); }}>Try again</button></div>
      )}
      {phase === 'ready' && shown.length === 0 && (
        <div className="sh-empty"><b>Your wishlist is empty</b><p style={{ margin: '0 0 16px', font: '600 15px Nunito', color: 'var(--sub)' }}>Tap the heart on any T-shirt to save it here.</p><a className="sh-btn sh-btn--red" href="/shop/all">Browse T-shirts</a></div>
      )}
      {phase === 'ready' && shown.length > 0 && (
        <div className="sh-list"><div className="sh-grid">
          {shown.map((p) => <ProductCard key={p.id} p={p} wished onWish={onWish} />)}
        </div></div>
      )}
    </div>
  );
}
