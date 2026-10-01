// [AUMFE-KNOWLEDGE-VECTOR-1] Pure logic + small fakes for D1 / Vectorize / AI.
import { describe, it, expect } from 'vitest';
import { chunkText, parseEmbedResponse, EMBED_DIMS } from './embed';
import { buildFilter, cleanMeta, clampK } from './common';
import {
  hydrateTradition, traditionFilter, traditionMetadata, parseTradVectorId, tradChunkIds, searchTradition, type TraditionRow,
} from './tradition';
import {
  hydrateCatalog, catalogFilter, catalogMetadata, liveShopProduct, parseCatVectorId, searchCatalog, type NoteRow, type LiveSubject,
} from './catalog';
import { CATALOG_METADATA_INDEXES, TRADITION_METADATA_INDEXES } from './indexes';
import type { ProductRow } from '../shop_logic';

describe('chunkText', () => {
  it('returns [] for empty and one chunk for short text', () => {
    expect(chunkText('  ')).toEqual([]);
    expect(chunkText('Om namah shivaya.')).toEqual(['Om namah shivaya.']);
  });
  it('splits long text within maxChars and overlaps', () => {
    const para = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about Hanuman and Tuesday.`).join(' ');
    const chunks = chunkText(para, 300, 60);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
    // overlap: the start of chunk n+1 appears in the tail of chunk n
    const head = chunks[1].slice(0, 20);
    expect(chunks[0].includes(head.split(' ')[0])).toBe(true);
  });
  it('splits on paragraphs and hard-slices an unbroken run', () => {
    const chunks = chunkText(`${'a'.repeat(500)}\n\n${'b'.repeat(500)}`, 600, 0);
    expect(chunks).toHaveLength(2);
    expect(chunkText('x'.repeat(2500), 1000, 0).every((c) => c.length <= 1000)).toBe(true);
  });
});

describe('builders', () => {
  it('buildFilter / cleanMeta drop empties', () => {
    expect(buildFilter({ a: 'x', b: '', c: undefined, d: false, e: null })).toEqual({ a: 'x', d: false });
    expect(cleanMeta({ a: 'x', b: '', c: null, d: 0, e: false })).toEqual({ a: 'x', d: 0, e: false });
  });
  it('clampK', () => {
    expect(clampK(undefined)).toBe(5);
    expect(clampK(3)).toBe(3);
    expect(clampK(999)).toBe(20);
  });
  it('parseEmbedResponse validates shape', () => {
    const v = new Array(EMBED_DIMS).fill(0.1);
    expect(parseEmbedResponse({ data: [v] }, 1)).toHaveLength(1);
    expect(() => parseEmbedResponse({ data: [[1, 2]] }, 1)).toThrow();
    expect(() => parseEmbedResponse({}, 1)).toThrow();
  });
  it('metadata index lists stay within the Vectorize limit and cover every filter key', () => {
    expect(CATALOG_METADATA_INDEXES.length).toBeLessThanOrEqual(10);
    const cat = new Set(CATALOG_METADATA_INDEXES.map((m) => m.property));
    for (const k of Object.keys(catalogFilter({ kind: 'event', deity: 'd', graha: 'g', chakra: 'c', design_type: 't', wear_day: 'w' }))) expect(cat.has(k)).toBe(true);
    const trad = new Set(TRADITION_METADATA_INDEXES.map((m) => m.property));
    for (const k of Object.keys(traditionFilter({ topic: 't', graha: 'g', weekday: 'w', deity: 'd' }))) expect(trad.has(k)).toBe(true);
  });
  it('tradition filter always pins status=approved', () => {
    expect(traditionFilter({})).toEqual({ status: 'approved' });
    expect(traditionFilter({ deity: ' Shiva ' })).toEqual({ status: 'approved', deity: 'shiva' });
  });
  it('catalog filter always pins active+in_stock', () => {
    expect(catalogFilter()).toEqual({ active: true, in_stock: true });
    expect(catalogFilter({ chakra: 'heart' })).toEqual({ active: true, in_stock: true, chakra: 'heart' });
  });
  it('catalog metadata stores the FIRST wear day / print colour and all wear days', () => {
    const m = catalogMetadata(note({ wear_days_json: '["Tuesday","Saturday"]', print_colours_json: '["Saffron","Gold"]' }), { active: true, in_stock: false });
    expect(m).toMatchObject({ wear_day: 'tuesday', wear_days: 'tuesday,saturday', deity: 'hanuman', print_colour: 'Saffron', in_stock: false, active: true, kind: 'shop_product' });
    expect(traditionMetadata({ id: 'x', topic: 't', lang: 'en', graha: null, weekday: null, deity: null }, 2)).toMatchObject({ status: 'approved', chunk: 2 });
    expect(traditionMetadata({ id: 'x', topic: 't', lang: 'en', graha: 'Mangal', weekday: 'Tuesday', deity: 'Hanuman' }, 0)).toMatchObject({ graha: 'mangal', weekday: 'tuesday', deity: 'hanuman' });
    expect(catalogFilter({ wear_day: 'Tuesday', deity: 'Hanuman' })).toMatchObject({ wear_day: 'tuesday', deity: 'hanuman' });
  });
  it('id helpers round-trip', () => {
    expect(parseTradVectorId('trad:abc:def:3')).toEqual({ id: 'abc:def', n: 3 });
    expect(parseTradVectorId('cat:event:1')).toBeNull();
    expect(tradChunkIds('x', 2)).toEqual(['trad:x:0', 'trad:x:1']);
    expect(parseCatVectorId('cat:shop_product:prd-1')).toEqual({ kind: 'shop_product', id: 'prd-1' });
  });
});

const trow = (over: Partial<TraditionRow> = {}): TraditionRow => ({
  id: 'e1', topic: 'graha', title: 'Tuesday', text: 'Hanuman is worshipped on Tuesday.', source: 'Book', lang: 'en',
  graha: 'mangal', weekday: 'tuesday', deity: 'hanuman', status: 'approved', chunk_count: 1, ...over,
});
function note(over: Partial<NoteRow> = {}): NoteRow {
  return {
    id: 'ptn-1', subject_kind: 'shop_product', subject_id: 'prd-1', design_type: 'deity', design_elements_json: '[]', print_colours_json: '[]',
    shirt_colour: null, deity: 'hanuman', graha: null, chakra: null, wear_days_json: '["tuesday"]', occasions_json: '[]', mantra: null,
    tradition_note: 'Wear on Tuesday.', story: '', sources_json: '[]', match_reasons_json: '[{"step":"deity","fact":"Hanuman rules Tuesday"}]',
    status: 'approved', drafted_at: 1, approved_by: 'u', approved_at: 1, vector_id: null, updated_at: 1, ...over,
  };
}

describe('hydrateTradition', () => {
  it('keeps approved only, best chunk per entry, ordered by score', () => {
    const rows = new Map([['e1', trow()], ['e2', trow({ id: 'e2', status: 'archived' })], ['e3', trow({ id: 'e3', title: 'Other' })]]);
    const hits = hydrateTradition(
      [{ id: 'trad:e1:0', score: 0.6 }, { id: 'trad:e1:1', score: 0.9 }, { id: 'trad:e2:0', score: 0.95 }, { id: 'trad:e3:0', score: 0.7 }, { id: 'trad:gone:0', score: 0.99 }],
      rows, 5, () => ['c0', 'c1'],
    );
    expect(hits.map((h) => h.id)).toEqual(['e1', 'e3']);
    expect(hits[0].text).toBe('c1');
    expect(hits[0].score).toBe(0.9);
  });
  it('respects k and falls back to full text when the chunk is out of range', () => {
    const rows = new Map([['e1', trow()], ['e3', trow({ id: 'e3' })]]);
    const hits = hydrateTradition([{ id: 'trad:e1:7', score: 0.9 }, { id: 'trad:e3:0', score: 0.8 }], rows, 1, () => ['only']);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe(trow().text);
  });
});

const live = (title: string): LiveSubject => ({ title, price_inr: 499, image_url: null, url: 'https://x/p' });
describe('hydrateCatalog', () => {
  it('drops unapproved notes and subjects that are no longer live', () => {
    const notes = new Map([
      ['shop_product:a', note({ subject_id: 'a' })],
      ['shop_product:b', note({ subject_id: 'b', status: 'draft' })],
      ['shop_product:c', note({ subject_id: 'c' })],
    ]);
    const lv = new Map<string, LiveSubject | null>([['shop_product:a', live('A')], ['shop_product:b', live('B')], ['shop_product:c', null]]);
    const hits = hydrateCatalog(
      [{ id: 'cat:shop_product:a', score: 0.5 }, { id: 'cat:shop_product:b', score: 0.9 }, { id: 'cat:shop_product:c', score: 0.8 }, { id: 'cat:shop_product:zzz', score: 0.7 }],
      notes, lv, 5,
    );
    expect(hits.map((h) => h.subject_id)).toEqual(['a']);
    expect(hits[0]).toMatchObject({ title: 'A', price_inr: 499, wear_days: ['tuesday'], why: [{ step: 'deity', fact: 'Hanuman rules Tuesday' }] });
  });
});

describe('liveShopProduct', () => {
  const base = { id: 'p', slug: 'om-tee', name: 'Om Tee', price_rupees: 499, images_json: '[{"url":"https://i/1.jpg","label":""}]', status: 'live', archived_at: null } as unknown as ProductRow;
  it('maps a live product and drops others', () => {
    expect(liveShopProduct(base)).toMatchObject({ title: 'Om Tee', price_inr: 499, image_url: 'https://i/1.jpg' });
    expect(liveShopProduct(base)!.url.endsWith('/shop/p/om-tee')).toBe(true);
    expect(liveShopProduct({ ...base, status: 'hidden' })).toBeNull();
    expect(liveShopProduct({ ...base, archived_at: 5 })).toBeNull();
    expect(liveShopProduct(null)).toBeNull();
  });
});

// ---- end-to-end with fakes ----
function fakeEnv(opts: { rows?: TraditionRow[]; matches?: Array<{ id: string; score: number }>; withIndex?: boolean }) {
  const queries: any[] = [];
  const vec = new Array(EMBED_DIMS).fill(0.1);
  const idx = {
    query: async (_v: number[], o: any) => { queries.push(o); return { matches: opts.matches ?? [] }; },
  };
  const env: any = {
    AI: { run: async () => ({ data: [vec] }) },
    DB_META: {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: opts.rows ?? [] }), run: async () => ({}), first: async () => null }) }),
    },
    POSTHOG_KEY: undefined,
  };
  if (opts.withIndex !== false) { env.VEC_TRADITION = idx; env.VEC_CATALOG = idx; }
  return { env, queries };
}

describe('search entry points', () => {
  it('return [] when the binding is missing', async () => {
    const { env } = fakeEnv({ withIndex: false });
    expect(await searchTradition(env, { query: 'tuesday' })).toEqual([]);
    expect(await searchCatalog(env, { query: 'tuesday' })).toEqual([]);
  });
  it('searchTradition filters by status=approved and hydrates from D1', async () => {
    const { env, queries } = fakeEnv({ rows: [trow()], matches: [{ id: 'trad:e1:0', score: 0.8 }, { id: 'trad:old:0', score: 0.9 }] });
    const hits = await searchTradition(env, { query: 'what to wear on tuesday', deity: 'Hanuman' });
    expect(queries[0].filter).toEqual({ status: 'approved', deity: 'hanuman' });
    expect(hits.map((h) => h.id)).toEqual(['e1']);
  });
});
