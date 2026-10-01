// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] The "All T-shirts" body: sticky filter sidebar, toolbar (count + sort),
// active-filter chips and the 3-column grid — exact port of the filters block in Specs/shop-mockup/shop.js
// (opt(), priceSync(), applyFilters()). One island so sidebar, chips and grid share state.
//
// NOTE FOR AI:
//  - Server-rendered from the URL's filters (SEO + shareable), hydrated `client:idle`; afterwards every change
//    re-queries GET /api/shop/products through listProducts() and rewrites the URL with history.replaceState.
//  - URL params == API params: collection, colour, size, fit, print, for, min, max, sort (comma-separated multi).
//    On /shop/c/<slug> the collection defaults to <slug>; `collection=` appears in the URL only when it differs.
//  - Facet counts come from the server over ALL live products (mockup behaviour), never from the filtered set.
//  - <=1100px: the sidebar becomes a full-screen sheet (Filters button, "Show results").
import { useEffect, useRef, useState } from 'react';
import type { ShopCard, ShopFacets, ShopListParams } from '../../lib/shopApi';
import { listProducts } from '../../lib/shopApi';
import { inr } from '../../lib/shopUi';
import { FILTER_GROUPS as GROUPS, type FilterGroup as Group, type FilterSort as Sort, type FilterState } from '../../lib/shopFilters';
import { capture, captureException } from '../../lib/analytics';
import { ProductCard } from './ProductCard';
import '../../styles/shop.css';


export default function ShopFilters({ initialItems, initialTotal, facets, initial, baseCollection }: {
  initialItems: ShopCard[]; initialTotal: number; facets: ShopFacets; initial: FilterState; baseCollection?: string;
}) {
  const pMin = facets.price?.min ?? 0;
  const pMax = facets.price?.max ?? 0;
  const [f, setF] = useState<FilterState>(initial);
  const [items, setItems] = useState(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [sheet, setSheet] = useState(false);
  const [minTxt, setMinTxt] = useState(String(initial.min ?? pMin));
  const [maxTxt, setMaxTxt] = useState(String(initial.max ?? pMax));
  const first = useRef(true);

  const lo = f.min ?? pMin;
  const hi = f.max ?? pMax;
  const priceActive = lo > pMin || hi < pMax;

  useEffect(() => { setMinTxt(String(lo)); setMaxTxt(String(hi)); }, [lo, hi]);
  useEffect(() => { capture('shop_list_viewed', { filters: describe(f) }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-query + rewrite the URL whenever a filter changes (not on first paint: the server already rendered it).
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      listProducts(toParams(f, pMin, pMax), ctrl.signal)
        .then((r) => { if (!ctrl.signal.aborted) { setItems(r.items); setTotal(r.total); } })
        .catch((err) => { if (!ctrl.signal.aborted) captureException(err, { surface: 'shop_filters' }); });
    }, 200);
    try {
      const qs = toQuery(f, pMin, pMax, baseCollection);
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    } catch { /* history unavailable: the page still works, the URL just is not updated */ }
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [f]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (g: Group, v: string, label?: string) => {
    setF((s) => {
      const on = !s[g].includes(v);
      capture('shop_filter_changed', { group: g, value: label ?? v, on });
      return { ...s, [g]: on ? [...s[g], v] : s[g].filter((x) => x !== v) };
    });
  };
  const setPrice = (a: number, b: number) => {
    if (a > b) [a, b] = [b, a];
    setF((s) => ({ ...s, min: a <= pMin ? null : a, max: b >= pMax ? null : b }));
  };
  const commitPrice = () => setPrice(Number(minTxt) || pMin, Number(maxTxt) || pMax);
  const clearAll = () => setF((s) => ({ ...s, collection: [], colour: [], size: [], fit: [], print: [], for: [], min: null, max: null }));
  const labelOf = (g: Group, v: string) => (g === 'collection' ? facets.collections.find((c) => c.slug === v)?.name ?? v : v);

  const opt = (g: Group, v: string, count: number, label: string, sw?: string) => (
    <label className="sh-opt" key={v}>
      <input type="checkbox" checked={f[g].includes(v)} onChange={() => toggle(g, v, label)} />
      {sw ? <i style={{ background: sw }} /> : null}{label}<em>{count}</em>
    </label>
  );

  const chips: { key: string; label: string; g?: Group; v?: string }[] = [];
  GROUPS.forEach((g) => f[g].forEach((v) => chips.push({ key: `${g}|${v}`, label: labelOf(g, v), g, v })));
  const noFilters = !priceActive && GROUPS.every((g) => f[g].length === 0);

  return (
    <div className="sh-list">
      <aside className={'sh-filters' + (sheet ? ' is-on' : '')} id="shFilters" aria-label="Filters">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Filters</h2>
          <button className="sh-x sh-filter-close" type="button" style={{ display: sheet ? '' : 'none' }} aria-label="Close filters" onClick={() => setSheet(false)}>×</button>
        </div>
        <details className="sh-fg" open hidden={pMax <= pMin}><summary>Price</summary><div className="sh-fg-body">
          <div className="sh-range">
            <input type="range" id="fMin" min={pMin} max={pMax} step={10} value={lo} onChange={(e) => setPrice(Number(e.target.value), hi)} aria-label="Minimum price" />
            <input type="range" id="fMax" min={pMin} max={pMax} step={10} value={hi} onChange={(e) => setPrice(lo, Number(e.target.value))} aria-label="Maximum price" />
          </div>
          <div className="sh-minmax">
            <label>Min<input id="fMinN" inputMode="numeric" value={minTxt} onChange={(e) => setMinTxt(e.target.value)} onBlur={commitPrice} onKeyDown={(e) => { if (e.key === 'Enter') commitPrice(); }} /></label>–
            <label>Max<input id="fMaxN" inputMode="numeric" value={maxTxt} onChange={(e) => setMaxTxt(e.target.value)} onBlur={commitPrice} onKeyDown={(e) => { if (e.key === 'Enter') commitPrice(); }} /></label>
          </div>
          <small id="fPriceLbl" style={{ font: '700 14px Nunito', color: '#6b4a2b' }}>{inr(lo)} – {inr(hi)}</small>
        </div></details>
        <details className="sh-fg" open><summary>Collection</summary><div className="sh-fg-body" id="fColl">{facets.collections.map((c) => opt('collection', c.slug, c.count, c.name))}</div></details>
        <details className="sh-fg" open><summary>Colour</summary><div className="sh-fg-body" id="fColour">{facets.colours.map((c) => opt('colour', c.name, c.count, c.name, c.hex))}</div></details>
        <details className="sh-fg" open><summary>Size</summary><div className="sh-fg-body"><div className="sh-sizes" id="fSize">
          {facets.sizes.map((s) => <label key={s.size}><input type="checkbox" checked={f.size.includes(s.size)} onChange={() => toggle('size', s.size)} /><span>{s.size}</span></label>)}
        </div></div></details>
        <details className="sh-fg"><summary>Fit</summary><div className="sh-fg-body" id="fFit">{facets.fits.map((x) => opt('fit', x.value, x.count, x.value))}</div></details>
        <details className="sh-fg"><summary>Print type</summary><div className="sh-fg-body" id="fPrint">{facets.prints.map((x) => opt('print', x.value, x.count, x.value))}</div></details>
        <details className="sh-fg"><summary>For</summary><div className="sh-fg-body" id="fFor">{facets.audiences.map((x) => opt('for', x.value, x.count, x.value))}</div></details>
        <div style={{ padding: '14px 0 10px', display: 'flex', gap: 8 }}>
          <button className="sh-btn sh-btn--ghost" type="button" style={{ flex: 1 }} id="fClear" onClick={clearAll}>Clear all</button>
          <button className="sh-btn sh-btn--red sh-filter-close" type="button" style={{ flex: 1, display: sheet ? '' : 'none' }} onClick={() => setSheet(false)}>Show results</button>
        </div>
      </aside>

      <div>
        <div className="sh-toolbar">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="sh-btn sh-btn--ghost sh-filter-btn" id="fOpen" type="button" style={{ minHeight: 44 }} onClick={() => setSheet(true)}>Filters</button>
            <b id="fCount">{total} product{total === 1 ? '' : 's'}</b>
          </div>
          <label style={{ font: '800 14px Nunito', color: '#6b4a2b' }}>Sort&nbsp;
            <select id="fSort" value={f.sort} onChange={(e) => { const sort = e.target.value as Sort; capture('shop_filter_changed', { group: 'sort', value: sort }); setF((s) => ({ ...s, sort })); }}>
              <option value="feat">Featured</option><option value="new">Newest</option><option value="lo">Price: low to high</option><option value="hi">Price: high to low</option><option value="best">Bestselling</option>
            </select>
          </label>
        </div>
        <div className="sh-chips" id="fChips" style={{ marginBottom: 16 }}>
          {chips.map((c) => <button key={c.key} className="sh-chip" type="button" onClick={() => toggle(c.g!, c.v!, c.label)}>{c.label} ×</button>)}
          {priceActive && <span className="sh-chip">{inr(lo)}–{inr(hi)}</span>}
        </div>
        <div className="sh-grid" id="shAll">
          {items.length
            ? items.map((p) => <ProductCard key={p.id} p={p} source="card" />)
            : noFilters
              ? <div className="sh-empty"><b>New T-shirts are coming soon</b><p>We are printing our first designs. Please check back shortly.</p><a className="sh-btn sh-btn--ghost" href="/shop">Back to the shop</a></div>
              : <div className="sh-empty"><b>No T-shirts match these filters</b><p>Try a wider price range or fewer filters.</p><button className="sh-btn sh-btn--ghost" type="button" onClick={clearAll}>Clear filters</button></div>}
        </div>
      </div>
    </div>
  );
}

function describe(f: FilterState): string {
  const parts: string[] = [];
  GROUPS.forEach((g) => { if (f[g].length) parts.push(`${g}=${f[g].join(',')}`); });
  if (f.min != null) parts.push(`min=${f.min}`);
  if (f.max != null) parts.push(`max=${f.max}`);
  if (f.sort !== 'feat') parts.push(`sort=${f.sort}`);
  return parts.join('&');
}

function toParams(f: FilterState, pMin: number, pMax: number): ShopListParams {
  return {
    collection: f.collection, colour: f.colour, size: f.size, fit: f.fit, print: f.print, for: f.for,
    min: f.min != null && f.min > pMin ? f.min : undefined,
    max: f.max != null && f.max < pMax ? f.max : undefined,
    sort: f.sort !== 'feat' ? f.sort : undefined,
  };
}

function toQuery(f: FilterState, pMin: number, pMax: number, baseCollection?: string): string {
  const u = new URLSearchParams();
  GROUPS.forEach((g) => {
    if (g === 'collection') {
      const same = baseCollection ? f.collection.length === 1 && f.collection[0] === baseCollection : f.collection.length === 0;
      if (!same) u.set('collection', f.collection.join(','));
    } else if (f[g].length) u.set(g, f[g].join(','));
  });
  if (f.min != null && f.min > pMin) u.set('min', String(f.min));
  if (f.max != null && f.max < pMax) u.set('max', String(f.max));
  if (f.sort !== 'feat') u.set('sort', f.sort);
  return u.toString();
}
