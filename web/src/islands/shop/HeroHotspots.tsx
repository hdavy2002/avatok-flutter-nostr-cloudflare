// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] The dots on the shop-home hero photo and the white pop card they open
// (port of the .sh-dot / .sh-pop behaviour in Specs/shop-mockup/shop.js). Positions are % of the hero (admin-set).
// Mounted inside `.sh-hero` (the Astro island wrapper is display:contents), `client:idle`.
// On phones (<=640px) the CSS hides dots and pop entirely, exactly like the mockup.
import { useEffect, useState } from 'react';
import type { ShopHotspot } from '../../lib/shopApi';
import { inr, photo, shade } from '../../lib/shopUi';
import '../../styles/shop.css';

export default function HeroHotspots({ hotspots }: { hotspots: ShopHotspot[] }) {
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (active == null) return;
    const away = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.sh-dot, .sh-pop')) setActive(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setActive(null); };
    document.addEventListener('click', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', away); document.removeEventListener('keydown', esc); };
  }, [active]);

  const h = active != null ? hotspots[active] : null;
  const p = h?.product;
  const src = p ? photo(p.image_url, 160) : null;
  return (
    <>
      {hotspots.map((s, i) => (
        <button key={s.product.id} className="sh-dot" type="button" style={{ left: `${s.x}%`, top: `${s.y}%` }} aria-label={s.product.name} aria-expanded={active === i}
          onClick={(e) => { e.stopPropagation(); setActive(active === i ? null : i); }} />
      ))}
      <a className={'sh-pop' + (h ? ' is-on' : '')} id="shPop" href={p ? `/shop/p/${encodeURIComponent(p.slug)}` : '/shop/all'} tabIndex={h ? 0 : -1}
        style={h ? { left: `calc(${h.x}% - 270px)`, top: `calc(${h.y}% - 30px)` } : undefined}>
        {p && (src
          ? <img src={src} alt="" width="58" height="58" />
          : <div className="sh-ph" style={{ ['--ph' as string]: shade(p.colours[0]?.hex) }}><span>T-shirt photo</span></div>)}
        {p && <div><b>{p.name}</b><small>{inr(p.price_rupees)} · tap to view →</small></div>}
      </a>
    </>
  );
}
