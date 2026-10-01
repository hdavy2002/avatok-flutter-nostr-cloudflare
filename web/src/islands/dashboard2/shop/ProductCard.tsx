/* ProductCard — [SAATHUM-SHOP-DASH-1] the shop product card, markup 1:1 with card() in
 * Specs/shop-mockup/shop.js (badge, heart, hover Quick add with default size = 2nd size,
 * title, price, MRP strike, −% pill, colour dots). Own small copy for the Wishlist grid;
 * WEB-STORE owns the storefront card. Classes live in shopDash.css under .shop-dash. */
import { addToCart } from '../../../lib/shopCart';
import type { ShopCard } from '../../../lib/shopApi';
import { capture } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';

export const inr = (n: number) => '₹' + Number(n).toLocaleString('en-IN');

/** Mockup shade(): tint a colour towards chandan for the empty-photo placeholder. */
function shade(h: string): string {
  const n = parseInt(h.replace('#', ''), 16);
  if (!Number.isFinite(n)) return '#efdcbf';
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r * 0.45 + 239 * 0.55); g = Math.round(g * 0.45 + 220 * 0.55); b = Math.round(b * 0.45 + 191 * 0.55);
  return `rgb(${r},${g},${b})`;
}

const BADGE: Record<string, { cls: string; text: string }> = {
  sale: { cls: 'sh-badge', text: 'Sale' },
  new: { cls: 'sh-badge sh-badge--new', text: 'New' },
  best: { cls: 'sh-badge sh-badge--best', text: 'Bestseller' },
};

export default function ProductCard({ p, wished, onWish }: { p: ShopCard; wished: boolean; onWish: (p: ShopCard) => void }) {
  const badge = p.badge ? BADGE[p.badge] : null;
  const quickSize = p.sizes[1] || p.sizes[0];
  const open = () => { location.href = `/shop/p/${encodeURIComponent(p.slug)}`; };
  const quick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const c = p.colours[0];
    if (!quickSize) return;
    addToCart({ product_id: p.id, slug: p.slug, name: p.name, colour: c?.name ?? '', colour_hex: c?.hex ?? '', size: quickSize, qty: 1, unit_rupees: p.price_rupees, image_url: p.image_url });
    capture('shop_add_to_cart', { product_id: p.id, size: quickSize, colour: c?.name ?? '', qty: 1, source: 'card' });
    toast.success(`Added: ${p.name} (${quickSize})`);
  };
  return (
    <article className="sh-card" onClick={open}>
      <div className="sh-card-art">
        {p.image_url
          ? <img src={p.image_url} alt={p.name} loading="lazy" />
          : <div className="sh-ph" style={{ ['--ph' as string]: shade(p.colours[0]?.hex ?? '#efdcbf') }}><span>T-shirt photo</span></div>}
        {badge && <span className={badge.cls}>{badge.text}</span>}
        <button type="button" className={`sh-heart${wished ? ' is-on' : ''}`} aria-label="Save" aria-pressed={wished} onClick={(e) => { e.stopPropagation(); onWish(p); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21s-7.5-4.6-9.5-9.2C1 8.3 3.3 5 6.6 5c2 0 3.4 1.1 4.4 2.5C12 6.1 13.4 5 15.4 5 18.7 5 21 8.3 19.5 11.8 17.5 16.4 12 21 12 21z" /></svg>
        </button>
        {quickSize && <button type="button" className="sh-btn sh-btn--red sh-quick" onClick={quick}>Quick add · {quickSize}</button>}
      </div>
      <h3><a className="sh-card-link" href={`/shop/p/${encodeURIComponent(p.slug)}`} onClick={(e) => e.stopPropagation()}>{p.name}</a></h3>
      <div className="sh-price">{inr(p.price_rupees)}{p.mrp_rupees ? <> <s>{inr(p.mrp_rupees)}</s> <span className="sh-off">−{p.off_pct ?? Math.round((1 - p.price_rupees / p.mrp_rupees) * 100)}%</span></> : null}</div>
      <div className="sh-sw">{p.colours.map((c) => <i key={c.name} style={{ background: c.hex }} title={c.name} />)}</div>
    </article>
  );
}
