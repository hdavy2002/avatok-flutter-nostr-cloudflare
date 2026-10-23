/* [HF-CHANNEL-WEB-1] Merch section of the channel page: category chips (only categories that exist, with counts), 8 per page with a pager
 * ("Showing 8 of 21"), and a quick "+ Add" on every tile that drops the item in the Bag and slides the drawer in. On phones the pager becomes
 * "Show more (N)" (4 first, then 8 more each time). Every product is in the server HTML as a plain link (search and AI crawlers read them);
 * tiles that are off the current page are only hidden.
 * Telemetry: merch_filter_used, merch_page_changed, bag_added (source quick). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { capture } from '../../lib/analytics';
import { publicImage } from '../../lib/config';
import { addToBag, openBagDrawer, type BagLine } from '../../lib/merchBag';
import { merchCategories, rupees, singularLabel, type PublicProduct } from '../../lib/merchPublic';

const PER_PAGE = 8;
const MOBILE_FIRST = 4;

/** Quick-add defaults: first colour; size M if it is in stock, else the first size in stock. */
export function quickLine(host: { slug: string; displayName: string }, p: PublicProduct): BagLine | null {
  const inStock = p.sizes.filter(s => s.inStock);
  if (p.sizes.length > 0 && inStock.length === 0) return null;
  const pick = inStock.find(s => s.size.toUpperCase() === 'M') ?? inStock[0];
  return {
    productId: p.id, hostSlug: host.slug, hostName: host.displayName, slug: p.slug, title: p.title, imageUrl: p.imageUrl,
    colour: p.colours[0]?.name ?? '', size: pick?.size ?? '', qty: 1, unitPaise: pick?.pricePaise ?? p.fromPricePaise, category: p.category || 'other',
  };
}

export default function MerchGrid({ host, products }: { host: { slug: string; displayName: string }; products: PublicProduct[] }) {
  const cats = useMemo(() => merchCategories(products), [products]);
  const [cat, setCat] = useState('all');
  const [page, setPage] = useState(1);
  const [mobile, setMobile] = useState(false);
  const [shown, setShown] = useState(MOBILE_FIRST);
  const [note, setNote] = useState('');
  const top = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  const filtered = useMemo(() => (cat === 'all' ? products : products.filter(p => (p.category || 'other') === cat)), [products, cat]);
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const visible = useMemo(() => {
    const set = new Set<string>();
    const slice = mobile ? filtered.slice(0, shown) : filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    slice.forEach(p => set.add(p.id));
    return set;
  }, [filtered, page, mobile, shown]);

  // phones: Show more instead of a pager
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)');
    const on = () => setMobile(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  // restore ?cat=&page= (shared links, back button)
  useEffect(() => {
    try {
      const q = new URLSearchParams(location.search);
      const c = q.get('cat'); const pg = Number(q.get('page'));
      if (c && merchCategories(products).some(x => x.slug === c)) setCat(c);
      if (pg >= 1) setPage(Math.trunc(pg));
    } catch { /* optional */ }
  }, [products]);
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages]);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    try {
      const u = new URL(location.href);
      if (cat === 'all') u.searchParams.delete('cat'); else u.searchParams.set('cat', cat);
      if (page === 1) u.searchParams.delete('page'); else u.searchParams.set('page', String(page));
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch { /* optional */ }
  }, [cat, page]);

  const pickCat = (slug: string) => {
    setCat(slug); setPage(1); setShown(MOBILE_FIRST);
    capture('merch_filter_used', { host_slug: host.slug, category: slug, count: slug === 'all' ? products.length : cats.find(c => c.slug === slug)?.count ?? 0 });
  };
  const goPage = (n: number) => {
    const next = Math.min(pages, Math.max(1, n));
    if (next === page) return;
    setPage(next);
    capture('merch_page_changed', { host_slug: host.slug, page: next, category: cat });
    top.current?.scrollIntoView({ block: 'start' });
  };
  const quickAdd = (p: PublicProduct) => {
    const line = quickLine(host, p);
    if (!line) return;
    const r = addToBag(line);
    if (!r.ok) { setNote('Your bag is full (10 items). Open it and check out first.'); return; }
    setNote('');
    capture('bag_added', { source: 'quick', host_slug: host.slug, product_id: p.id, category: line.category, qty: 1, price_paise: line.unitPaise });
    openBagDrawer(r.line);
  };

  const total = filtered.length;
  const from = mobile ? 1 : (page - 1) * PER_PAGE + 1;
  const to = mobile ? Math.min(shown, total) : Math.min(page * PER_PAGE, total);
  const win = (() => { // up to 5 numbered buttons around the current page
    const start = Math.max(1, Math.min(page - 2, pages - 4)); const end = Math.min(pages, start + 4);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  })();

  return <div ref={top}>
    {cats.length > 1 && <div className="cats" role="group" aria-label="Filter merch by type">
      <button type="button" className={`chip${cat === 'all' ? ' on' : ''}`} aria-pressed={cat === 'all'} onClick={() => pickCat('all')}>All · {products.length}</button>
      {cats.map(c => <button key={c.slug} type="button" className={`chip${cat === c.slug ? ' on' : ''}`} aria-pressed={cat === c.slug} onClick={() => pickCat(c.slug)}>{c.label} · {c.count}</button>)}
    </div>}
    <div className="grid">
      {products.map(p => {
        const inCat = cat === 'all' || (p.category || 'other') === cat;
        const show = inCat && visible.has(p.id);
        const sold = p.sizes.length > 0 && !p.sizes.some(s => s.inStock);
        return <div className="card" key={p.id} hidden={!show} data-cat={p.category || 'other'}>
          <span className="img">
            {p.imageUrl && <img src={publicImage(p.imageUrl, { width: 480 })} alt={`${p.title} by ${host.displayName}`} width="240" height="240" loading="lazy" decoding="async" />}
            <button type="button" className="add" disabled={sold} aria-label={sold ? `${p.title} is sold out` : `Add ${p.title} to bag`} onClick={() => quickAdd(p)}>{sold ? 'Sold out' : '+ Add'}</button>
          </span>
          <span className="cat">{singularLabel(p.categoryLabel || 'Merch')}</span>
          <b><a href={`/h/${host.slug}/merch/${p.slug}`} data-hfm-card={p.slug}>{p.title}</a></b>
          <span className="pr">{rupees(p.fromPricePaise)} <small>all incl.</small></span>
        </div>;
      })}
    </div>
    {total === 0 && <p className="empty">Nothing here yet.</p>}
    {mobile
      ? shown < total && <button type="button" className="btn btn-o more" style={{ display: 'inline-flex' }} onClick={() => { setShown(s => s + PER_PAGE); capture('merch_page_changed', { host_slug: host.slug, page: 0, category: cat, mode: 'show_more' }); }}>Show more ({total - shown})</button>
      : pages > 1 && <nav className="pager" aria-label="Merch pages">
        <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => goPage(page - 1)}>‹</button>
        {win.map(n => <button key={n} type="button" className={n === page ? 'on' : ''} aria-current={n === page ? 'page' : undefined} aria-label={`Page ${n}`} onClick={() => goPage(n)}>{n}</button>)}
        <button type="button" disabled={page >= pages} onClick={() => goPage(page + 1)}>Next ›</button>
      </nav>}
    {total > 0 && <p className="showing" role="status" aria-live="polite">{from === 1 ? `Showing ${to} of ${total}` : `Showing ${from}–${to} of ${total}`}</p>}
    {note && <p className="toast" role="alert">{note}</p>}
  </div>;
}
