// [SAATHUM-SHOP-EDITOR-1 2026-10-01] The red featured banner as a block (markup moved verbatim from the old index.astro).
// [SAATHUM-SHOP-EDITOR-2 2026-10-02] Renders whenever it has a title (no product needed). The button shows when it has a label and goes to the
// chosen product's page, else to its own link. The photo is the banner's own upload, else the chosen product's first photo, else the striped placeholder.
import { photo } from '../../../lib/shopUi';
import type { BlockCtx, FeaturedBannerProps } from './types';
import { has, safeHref, t } from './util';

export default function FeaturedBannerBlock(p: FeaturedBannerProps & { ctx: BlockCtx }) {
  if (!has(p.title) && !p.ctx.editing) return null;
  const product = p.product ? p.ctx.resolved.products[p.product] : undefined;
  const src = photo(p.image || product?.image_url, 900);
  const href = product ? `/shop/p/${encodeURIComponent(product.slug)}` : safeHref(p.ctaHref, '/shop/all');
  return (
    <section className="sh-sec">
      <div className="sh-banner">
        <div className="sh-banner-copy">
          <p className="sh-eyebrow">{t(p.eyebrow)}</p>
          <h2>{t(p.title)}</h2>
          <p>{t(p.text)}</p>
          {has(p.ctaLabel) && <div><a className="sh-btn sh-btn--teal" href={href}>{t(p.ctaLabel)}</a></div>}
        </div>
        {src
          ? <div className="sh-banner-art"><img src={src} alt={typeof p.title === 'string' ? p.title : ''} width={900} height={900} loading="lazy" decoding="async" /></div>
          : <div className="sh-ph sh-ph--banner"><span>Feature banner photo</span></div>}
      </div>
    </section>
  );
}
