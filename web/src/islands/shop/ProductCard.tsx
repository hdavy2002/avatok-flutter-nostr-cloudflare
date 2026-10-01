// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] The shop product card — exact port of card() in
// Specs/shop-mockup/shop.js (badge, heart, hover "Quick add · <size>", title, price, MRP strike, −% pill, colour dots).
//
// NOTE FOR AI:
//  - Rendered server-side for SEO (title is a real link) and hydrated by ProductGrid (`client:idle`); the dashboard
//    Wishlist page reuses `ProductCard` / `ProductGrid` as they are.
//  - Wishlist state is read from localStorage AFTER mount, so the server HTML and the first client render match.
//  - Quick add uses the 2nd size (else the 1st) and the first colour, exactly like the mockup, then opens the cart.
//  - A missing photo renders the mockup's striped `.sh-ph` placeholder tinted from the first colour.
import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import type { ShopCard } from '../../lib/shopApi';
import { addToCart, openCart, showToast } from '../../lib/shopCart';
import { getWish, onWishChange, toggleWish } from '../../lib/shopWish';
import { defaultSize, inr, photo, shade } from '../../lib/shopUi';
import { capture } from '../../lib/analytics';
import '../../styles/shop.css';

const BADGE: Record<string, [string, string]> = {
  sale: ['Sale', 'sh-badge'],
  new: ['New', 'sh-badge sh-badge--new'],
  best: ['Bestseller', 'sh-badge sh-badge--best'],
};

export function ProductCard({ p, source = 'card' }: { p: ShopCard; source?: string }) {
  const [wished, setWished] = useState(false);
  useEffect(() => {
    setWished(getWish().includes(p.id));
    return onWishChange((ids) => setWished(ids.includes(p.id)));
  }, [p.id]);

  const src = photo(p.image_url, 640);
  const badge = p.badge ? BADGE[p.badge] : undefined;
  const size = defaultSize(p);
  const href = `/shop/p/${encodeURIComponent(p.slug)}`;
  const off = p.mrp_rupees && p.mrp_rupees > p.price_rupees ? (p.off_pct ?? Math.round((1 - p.price_rupees / p.mrp_rupees) * 100)) : 0;

  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    window.location.href = href;
  };
  const wish = (e: MouseEvent) => {
    e.stopPropagation();
    const on = toggleWish(p.id);
    showToast(on ? 'Saved to your wishlist' : 'Removed from wishlist');
    capture('shop_wish_toggled', { product_id: p.id, on });
  };
  const quick = (e: MouseEvent) => {
    e.stopPropagation();
    const colour = p.colours[0];
    if (!size || !colour) { window.location.href = href; return; }
    addToCart({ product_id: p.id, slug: p.slug, name: p.name, colour: colour.name, colour_hex: colour.hex, size, qty: 1, unit_rupees: p.price_rupees, image_url: p.image_url });
    capture('shop_add_to_cart', { product_id: p.id, size, colour: colour.name, qty: 1, source });
    openCart();
    showToast(`Added: ${p.name} (${size})`);
  };

  return (
    <article className="sh-card" onClick={open}>
      <div className="sh-card-art">
        {src
          ? <img src={src} alt={p.name} loading="lazy" decoding="async" />
          : <div className="sh-ph" style={{ ['--ph' as string]: shade(p.colours[0]?.hex) }}><span>T-shirt photo</span></div>}
        {badge && <span className={badge[1]}>{badge[0]}</span>}
        <button className={'sh-heart' + (wished ? ' is-on' : '')} type="button" aria-label="Save" aria-pressed={wished} onClick={wish}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.2C1 8.3 3.3 5 6.6 5c2 0 3.4 1.1 4.4 2.5C12 6.1 13.4 5 15.4 5 18.7 5 21 8.3 19.5 11.8 17.5 16.4 12 21 12 21z" /></svg>
        </button>
        <button className="sh-btn sh-btn--red sh-quick" type="button" onClick={quick}>Quick add · {size}</button>
      </div>
      <h3><a href={href}>{p.name}</a></h3>
      <div className="sh-price">{inr(p.price_rupees)}{off > 0 && p.mrp_rupees ? <>{' '}<s>{inr(p.mrp_rupees)}</s>{' '}<span className="sh-off">−{off}%</span></> : null}</div>
      <div className="sh-sw">{p.colours.map((c) => <i key={c.name} style={{ background: c.hex }} title={c.name} />)}</div>
    </article>
  );
}

/** A `.sh-grid` of cards. Mounted `client:idle` on the shop home sections and the product page. */
export default function ProductGrid({ items, source = 'card', id }: { items: ShopCard[]; source?: string; id?: string }) {
  return (
    <div className="sh-grid" id={id}>
      {items.map((p) => <ProductCard key={p.id} p={p} source={source} />)}
    </div>
  );
}
