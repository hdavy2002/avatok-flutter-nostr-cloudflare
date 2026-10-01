// [SAATHUM-SHOP-EDITOR-1 2026-10-01] A rail of product cards (New arrivals, Bestsellers, a collection, a hand-picked list) as a block.
// Markup moved verbatim from the old index.astro sections. `last` = this is the page's last block (the old 60px bottom padding).
import ProductGrid from '../ProductCard';
import type { BlockCtx, ProductRailProps } from './types';
import { railDomId, railSourceKey, safeHref, t, has, spaced } from './util';

export default function ProductRailBlock(p: ProductRailProps & { id: string; ctx: BlockCtx }) {
  const items = p.ctx.resolved.rails[p.id] ?? [];
  if (items.length === 0 && p.hideWhenEmpty) return null;
  return (
    <section className="sh-sec" style={p.ctx.last && items.length > 0 ? { paddingBottom: 60 } : undefined}>
      <div className="sh-sec-head">
        <div><h2><span>✽</span>{spaced(p.title)}</h2><p>{t(p.subtitle)}</p></div>
        {has(p.linkLabel) && <a className="sh-link" href={safeHref(p.linkHref)}>{t(p.linkLabel)}</a>}
      </div>
      {items.length > 0
        ? <div style={p.ctx.editing ? { pointerEvents: 'none' } : undefined}><ProductGrid items={items} source={railSourceKey(p.id, p.source)} id={railDomId(p.id)} /></div>
        : <div className="sh-empty">
            <b>{t(p.emptyTitle)}</b>
            <p>{t(p.emptyText)}</p>
            {has(p.emptyButtonLabel) && <a className="sh-btn sh-btn--ghost" href={safeHref(p.emptyButtonHref, '/marketplace')}>{p.emptyButtonLabel}</a>}
          </div>}
    </section>
  );
}
