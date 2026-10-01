// [SAATHUM-SHOP-EDITOR-1 2026-10-01] A rail of product cards (New arrivals, Bestsellers, a collection, a hand-picked list) as a block.
// Markup moved verbatim from the old index.astro sections. `last` = this is the page's last block (the old 60px bottom padding).
// [SAATHUM-SHOP-EDITOR-2 2026-10-02] Editor (ctx.editing): never null — an empty row shows 4 placeholder cards (same markup as a real card) + a hint.
import ProductGrid from '../ProductCard';
import { shade } from '../../../lib/shopUi';
import type { BlockCtx, ProductRailProps } from './types';
import { railDomId, railSourceKey, safeHref, t, has, spaced } from './util';

const TINTS = ['#e07a1f', '#222', '#f1e8d6', '#7a1f24'];

function hintFor(source: string): string {
  return source === 'new_arrivals' || source === 'bestsellers'
    ? 'Mark products as New arrival / Bestseller in Admin → Shop → Products.'
    : 'Choose which products appear here in the right-hand panel.';
}

export default function ProductRailBlock(p: ProductRailProps & { id: string; ctx: BlockCtx }) {
  const items = p.ctx.resolved.rails[p.id] ?? [];
  const editing = !!p.ctx.editing;
  if (items.length === 0 && p.hideWhenEmpty && !editing) return null;
  const showBox = items.length === 0 && !p.hideWhenEmpty;
  return (
    <section className="sh-sec" style={p.ctx.last && items.length > 0 ? { paddingBottom: 60 } : undefined}>
      <div className="sh-sec-head">
        <div><h2><span>✽</span>{spaced(p.title)}</h2><p>{t(p.subtitle)}</p></div>
        {has(p.linkLabel) && <a className="sh-link" href={safeHref(p.linkHref)}>{t(p.linkLabel)}</a>}
      </div>
      {items.length > 0
        ? <div style={editing ? { pointerEvents: 'none' } : undefined}><ProductGrid items={items} source={railSourceKey(p.id, p.source)} id={railDomId(p.id)} /></div>
        : <>
            {editing && (
              <div className="sh-grid" id={railDomId(p.id)}>
                {TINTS.map((tint, i) => (
                  <article className="sh-card" key={i}>
                    <div className="sh-card-art"><div className="sh-ph" style={{ ['--ph' as string]: shade(tint) }}><span>T-shirt photo</span></div></div>
                    <h3><a href="/shop/all">Your T-shirt</a></h3>
                    <div className="sh-price">₹—</div>
                  </article>
                ))}
              </div>
            )}
            {editing && <p className="sh-edit-hint">{hintFor(p.source)}</p>}
            {(!editing || showBox) && (
              <div className="sh-empty">
                <b>{t(p.emptyTitle)}</b>
                <p>{t(p.emptyText)}</p>
                {has(p.emptyButtonLabel) && <a className="sh-btn sh-btn--ghost" href={safeHref(p.emptyButtonHref, '/marketplace')}>{t(p.emptyButtonLabel)}</a>}
              </div>
            )}
          </>}
    </section>
  );
}
