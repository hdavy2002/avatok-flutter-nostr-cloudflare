// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] The header cart button (.avh-cart, markup from the approved mockup).
// Mounted by SiteHeader.astro as `client:idle` (owner rule WEB-PERF: non-critical things load later).
// The count is read from localStorage after mount, so the server HTML and the first client render match.
import { useEffect, useState } from 'react';
import { cartCount, onCartChange, openCart } from '../../lib/shopCart';

export default function CartButton() {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(cartCount());
    return onCartChange(() => setN(cartCount()));
  }, []);
  return (
    <button className="avh-cart" type="button" aria-label={n ? `Open cart, ${n} item${n === 1 ? '' : 's'}` : 'Open cart'} onClick={openCart}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 7h12l-1.2 12.2a1 1 0 0 1-1 .8H8.2a1 1 0 0 1-1-.8z" />
        <path d="M9 9V6a3 3 0 0 1 6 0v3" />
      </svg>
      <b>{n || ''}</b>
    </button>
  );
}
