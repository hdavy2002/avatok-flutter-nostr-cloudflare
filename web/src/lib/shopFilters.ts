// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] Filter state <-> URL for /shop/all and /shop/c/<slug>.
// The URL params are the API params (see shopApi.listProducts): collection, colour, size, fit, print, for, min, max, sort.
// Used by the Astro pages (server render from the URL) and the ShopFilters island (client).
import type { ShopListParams } from './shopApi';

export type FilterGroup = 'collection' | 'colour' | 'size' | 'fit' | 'print' | 'for';
export type FilterSort = 'feat' | 'new' | 'lo' | 'hi' | 'best';
export interface FilterState {
  collection: string[]; colour: string[]; size: string[]; fit: string[]; print: string[]; for: string[];
  min: number | null; max: number | null; sort: FilterSort;
  /** [SAATHUM-SHOP-EDITOR-2] ?tag= — the shop home's "View all" lists: new = New arrivals, best = Bestsellers, sale. '' = none. */
  tag: FilterTag;
}
export type FilterTag = '' | 'new' | 'best' | 'sale';
export const TAG_LABEL: Record<Exclude<FilterTag, ''>, string> = { new: 'New arrivals', best: 'Bestsellers', sale: 'On sale' };
export const FILTER_GROUPS: FilterGroup[] = ['collection', 'colour', 'size', 'fit', 'print', 'for'];
const SORTS: FilterSort[] = ['feat', 'new', 'lo', 'hi', 'best'];

const list = (v: string | null): string[] => (v ?? '').split(',').map((s) => s.trim().slice(0, 60)).filter(Boolean).slice(0, 20);
const num = (v: string | null): number | null => {
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n) : null;
};

/** Reads the filters from a URL. On /shop/c/<slug> the collection defaults to the slug unless `collection=` is present. */
export function parseFilters(sp: URLSearchParams, baseCollection?: string): FilterState {
  const sort = sp.get('sort') as FilterSort | null;
  const tag = (sp.get('tag') ?? '').toLowerCase();
  return {
    collection: sp.has('collection') ? list(sp.get('collection')) : baseCollection ? [baseCollection] : [],
    colour: list(sp.get('colour')), size: list(sp.get('size')), fit: list(sp.get('fit')),
    print: list(sp.get('print')), for: list(sp.get('for')),
    min: num(sp.get('min')), max: num(sp.get('max')),
    sort: sort && SORTS.includes(sort) ? sort : 'feat',
    tag: tag === 'new' || tag === 'best' || tag === 'sale' ? tag : '',
  };
}

export function filterParams(f: FilterState): ShopListParams {
  return {
    collection: f.collection, colour: f.colour, size: f.size, fit: f.fit, print: f.print, for: f.for,
    min: f.min ?? undefined, max: f.max ?? undefined, sort: f.sort !== 'feat' ? f.sort : undefined,
    tag: f.tag || undefined,
  };
}
