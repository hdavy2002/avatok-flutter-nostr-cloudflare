// [SAATHUM-SHOP-EDITOR-1 2026-10-01] The shop-home hero as a block. Markup and classes are the old index.astro hero, moved
// verbatim — only the data now comes from props. Shared by the public page (SSR + `client:idle` for the dots) and the editor.
import HeroHotspots from '../HeroHotspots';
import { photo } from '../../../lib/shopUi';
import type { BlockCtx, HeroProps } from './types';
import { has, t, spaced } from './util';

export default function ShopHeroBlock(p: HeroProps & { ctx: BlockCtx }) {
  const { ctx } = p;
  const heroPhoto = p.image ? photo(p.image, 1600) : null;
  const second = ctx.collections.find((c) => c.slug === p.secondCollection) ?? ctx.collections[0] ?? null;
  const spots = (p.hotspots ?? []).map((h) => ({ x: h.x, y: h.y, product: ctx.resolved.products[h.product] })).filter((h) => h.product);
  const heroStyle = heroPhoto ? { background: `#3a2418 url(${JSON.stringify(heroPhoto)}) center/cover no-repeat` } : undefined;
  const emHas = has(p.titleEm);
  return (
    <div className={'sh-hero' + (heroPhoto ? ' sh-hero--photo' : '')} id="shHero" style={heroStyle}>
      <HeroHotspots hotspots={spots} />
      {!heroPhoto && <div className="sh-hero-ph">Hero lifestyle photo<br />(admin-uploaded)</div>}
      <div className="sh-wrap">
        <div className="sh-hero-card">
          <p className="sh-eyebrow">{t(p.eyebrow)}</p>
          <h1>{t(p.title)}{emHas ? ' ' : ''}{emHas ? <em>{t(p.titleEm)}</em> : null}</h1>
          <p>{t(p.lead)}</p>
          <div className="sh-hero-ctas">
            <a className="sh-btn sh-btn--red" href="/shop/all">{t(p.ctaLabel)}</a>
            {second && <a className="sh-btn sh-btn--ghost" href={`/shop/c/${second.slug}`}>{`${second.name} collection`}</a>}
          </div>
          <div className="sh-ticks">{(p.ticks ?? []).map((k, i) => <span key={i}>{k.text}</span>)}</div>
        </div>
      </div>
      <div className="sh-wrap">
        <div className="sh-promise">
          {(p.promise ?? []).map((q, i) => <div key={i}><b>{q.title}</b><small>{q.sub}</small></div>)}
          <a className="sh-link" href="/shop/all">{t(p.promiseLinkLabel)}</a>
        </div>
      </div>
    </div>
  );
}
