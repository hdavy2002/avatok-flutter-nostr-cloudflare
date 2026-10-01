// [SAATHUM-SHOP-EDITOR-1 2026-10-01] "Shop by collection" as a block (markup moved verbatim from the old index.astro).
// [SAATHUM-SHOP-EDITOR-2 2026-10-02] Live page: only collections with at least one live product (their own photo), hidden when none qualify.
// Editor (ctx.editing): never null — with no collections yet it shows 6 placeholder tiles in the same style plus a hint.
import { photo, shade } from '../../../lib/shopUi';
import type { BlockCtx, CollectionGridProps } from './types';
import { collectionTiles, t, spaced } from './util';

const TILE_TINTS = ['#e07a1f', '#222', '#f1e8d6', '#7a1f24', '#127a72', '#d9a62b', '#fafafa', '#1f2a4a'];

export default function CollectionGridBlock(p: CollectionGridProps & { ctx: BlockCtx }) {
  const editing = !!p.ctx.editing;
  const tiles = collectionTiles(p, p.ctx.collections, editing);
  if (!tiles.length && !editing) return null;
  const empty = tiles.length === 0;
  const hasUnlisted = editing && tiles.some((x) => x.c.count === 0);
  return (
    <section className="sh-sec">
      <div className="sh-sec-head"><div><h2><span>✽</span>{spaced(p.title)}</h2><p>{t(p.subtitle)}</p></div><a className="sh-link" href="/shop/all">{t(p.linkLabel)}</a></div>
      <div className="sh-cats" id="shCats">
        {empty
          ? Array.from({ length: 6 }, (_, i) => (
              <a className="sh-cat" href="/shop/all" key={i}>
                <div className="sh-ph" style={{ ['--ph' as string]: shadeTint(i) }}><span>Collection art</span></div>
                <b>Your collection</b>
                <small>Designs</small>
              </a>
            ))
          : tiles.map(({ c, image, name, blurb }, i) => {
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
      {editing && empty && <p className="sh-edit-hint">Add collections in Admin → Shop → Categories — they appear here once they have products.</p>}
      {hasUnlisted && <p className="sh-edit-hint">Collections with no products yet are hidden on the live page — they appear once a product is added to them.</p>}
    </section>
  );
}

const shadeTint = (i: number) => shade(TILE_TINTS[i % TILE_TINTS.length]);
