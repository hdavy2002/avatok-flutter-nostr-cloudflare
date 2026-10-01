// [SAATHUM-SHOP-EDITOR-1 2026-10-01] "Shop by collection" as a block (markup moved verbatim from the old index.astro).
// No tiles configured = every active collection in the admin's order with its own photo (the page's old behaviour).
import { photo, shade } from '../../../lib/shopUi';
import type { BlockCtx, CollectionGridProps } from './types';
import { t, spaced } from './util';

const TILE_TINTS = ['#e07a1f', '#222', '#f1e8d6', '#7a1f24', '#127a72', '#d9a62b', '#fafafa', '#1f2a4a'];

export default function CollectionGridBlock(p: CollectionGridProps & { ctx: BlockCtx }) {
  const all = p.ctx.collections;
  const tiles = (p.tiles ?? []).length
    ? p.tiles.map((x) => {
        const c = all.find((k) => k.slug === x.collection);
        return c ? { c, image: x.image || c.image_url, name: x.label || c.name, blurb: x.blurb || c.blurb } : null;
      }).filter((x): x is NonNullable<typeof x> => !!x)
    : all.map((c) => ({ c, image: c.image_url, name: c.name, blurb: c.blurb }));
  if (!tiles.length) return null;
  return (
    <section className="sh-sec">
      <div className="sh-sec-head"><div><h2><span>✽</span>{spaced(p.title)}</h2><p>{t(p.subtitle)}</p></div><a className="sh-link" href="/shop/all">{t(p.linkLabel)}</a></div>
      <div className="sh-cats" id="shCats">
        {tiles.map(({ c, image, name, blurb }, i) => {
          const src = photo(image, 420);
          return (
            <a className="sh-cat" href={`/shop/c/${c.slug}`} key={c.id}>
              {src
                ? <img src={src} alt={name} width={420} height={420} loading="lazy" decoding="async" />
                : <div className="sh-ph" style={{ ['--ph' as string]: shadeTint(i) }}><span>Collection art</span></div>}
              <b>{name}</b>
              <small>{`${c.count} design${c.count === 1 ? '' : 's'}${blurb ? ` · ${blurb}` : ''}`}</small>
            </a>
          );
        })}
      </div>
    </section>
  );
}

const shadeTint = (i: number) => shade(TILE_TINTS[i % TILE_TINTS.length]);
