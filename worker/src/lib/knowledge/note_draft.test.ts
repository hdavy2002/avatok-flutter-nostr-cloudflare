// [AUMFE-DESIGN-MATCH-1] Validators, precedence, wear-day support, banned words, sync decisions, draftNote with fakes.
import { describe, it, expect } from 'vitest';
import {
  validateDraft, sortReasons, supportedWearDays, findBannedWords, lockedFrom, groundingQueries, parseModelJson, draftNote, DraftError,
  type Passage, type Subject,
} from './note_draft';
import { decideSync, designChanged, onShopProductChanged, type ProductSnapshot } from './product_sync';
import type { MatchReason, NoteRow } from './catalog';
import { normKey } from './common';

const P = (o: Partial<Passage> & { id: string }): Passage => ({ title: 'T', text: 'text', weekday: null, deity: null, ...o });
const hanuman = P({ id: 'deity-hanuman', title: 'Hanuman', text: 'Hanuman is traditionally worshipped on Tuesday and Saturday. Devotees chant Om Hanumate Namah.', deity: 'hanuman' });
const mangal = P({ id: 'graha-mangal', title: 'Mangal', text: 'Mangal (Mars) is associated with red and Tuesday.', weekday: 'tuesday' });
const ctx = { passages: [hanuman, mangal], subjectText: 'Product name: Hanuman print tee\nShirt colours offered: White' };

const goodRaw = () => ({
  design_type: 'deity', design_elements: ['Hanuman'], print_colours: ['Red'], shirt_colour: 'white', deity: 'Hanuman', graha: 'mangal', chakra: null,
  wear_days: ['saturday', 'tuesday', 'friday'], occasions: ['Hanuman Jayanti'], mantra: 'Om Hanumate Namah',
  tradition_note: 'Traditionally Hanuman is worshipped on Tuesday and Saturday.', story: 'A tee for devotees.',
  match_reasons: [
    { step: 'shirt_colour', fact: 'White is neutral.' },
    { step: 'print_colour', fact: 'Red is linked to Mangal and Tuesday.', source_id: 'graha-mangal' },
    { step: 'deity', fact: 'Hanuman is on the design.', source_id: 'deity-hanuman' },
    { step: 'chakra', fact: 'Made up', source_id: 'not-retrieved' },
  ],
  sources: ['deity-hanuman', 'graha-mangal', 'ghost'],
});

describe('validateDraft', () => {
  it('drops unknown sources and reasons citing them, keeps shirt_colour without a source', () => {
    const r = validateDraft(goodRaw(), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.sources).toEqual(['deity-hanuman', 'graha-mangal']);
    expect(r.fields.match_reasons.map((m) => m.step)).toEqual(['deity', 'print_colour', 'shirt_colour']);
    expect(r.dropped).toEqual(expect.arrayContaining(['source:ghost', 'reason:chakra:not-retrieved']));
  });
  it('orders wear days Monday..Sunday and drops a day no source supports', () => {
    const r = validateDraft(goodRaw(), ctx);
    if (!r.ok) throw new Error('x');
    expect(r.fields.wear_days).toEqual(['tuesday', 'saturday']);
    expect(r.dropped).toContain('wear_day:friday');
  });
  it('empties wear_days when nothing supports them', () => {
    const r = validateDraft({ ...goodRaw(), wear_days: ['monday'] }, ctx);
    if (!r.ok) throw new Error('x');
    expect(r.fields.wear_days).toEqual([]);
  });
  it('never invents a deity or mantra', () => {
    const r = validateDraft({ ...goodRaw(), deity: 'Ganesha', mantra: 'Om Gam Ganapataye' }, ctx);
    if (!r.ok) throw new Error('x');
    expect(r.fields.deity).toBeNull();
    expect(r.fields.mantra).toBeNull();
  });
  it('rejects promise wording anywhere in the copy', () => {
    for (const bad of ['This will definitely help.', 'A 100% remedy.', 'It will remove obstacles.', 'We guarantee peace.', 'It can cure worry.']) {
      const r = validateDraft({ ...goodRaw(), story: bad }, ctx);
      expect(r.ok).toBe(false);
    }
    const r2 = validateDraft({ ...goodRaw(), match_reasons: [{ step: 'deity', fact: 'Will fix luck', source_id: 'deity-hanuman' }] }, ctx);
    expect(r2.ok).toBe(false);
  });
  it('does not flag ordinary words that contain a banned stem', () => {
    expect(findBannedWords('A secure, procured fit. Traditionally observed.')).toEqual([]);
  });
  it('bad shape', () => {
    expect(validateDraft(null, ctx)).toMatchObject({ ok: false, reason: 'bad_shape' });
    expect(validateDraft([], ctx)).toMatchObject({ ok: false, reason: 'bad_shape' });
  });
  it('admin-locked facts win over the model', () => {
    const r = validateDraft(goodRaw(), { ...ctx, locked: { deity: 'Shiva', print_colours: ['black'], wear_days: ['monday'] } });
    if (!r.ok) throw new Error('x');
    expect(r.fields.deity).toBe('shiva');
    expect(r.fields.print_colours).toEqual(['black']);
    expect(r.fields.wear_days).toEqual(['monday']);
  });
});

describe('vision evidence', () => {
  const generic = { ...ctx, subjectText: 'Product name: Classic Tee' };
  const seenRaw = () => ({ ...goodRaw(), match_reasons: [{ step: 'deity', fact: 'Hanuman ji shown on the print', seen_in_image: true }, { step: 'print_colour', fact: 'Red print is linked to Mangal and Tuesday.', source_id: 'graha-mangal' }] });
  it('a deity seen in the image is subject evidence even when the product text never names it', () => {
    const noImage = validateDraft(seenRaw(), { ...generic, passages: [mangal] });
    if (!noImage.ok) throw new Error('x');
    expect(noImage.fields.deity).toBeNull();                       // seen_in_image ignored without an image
    expect(noImage.fields.match_reasons.map((r) => r.step)).toEqual(['print_colour']);
    const withImage = validateDraft(seenRaw(), { ...generic, passages: [mangal], imageProvided: true });
    if (!withImage.ok) throw new Error('x');
    expect(withImage.fields.deity).toBe('hanuman');
    expect(withImage.fields.match_reasons[0]).toMatchObject({ step: 'deity', seen_in_image: true });
  });
  it('the image scan result also counts, but an unseen deity still does not', () => {
    const raw = { ...goodRaw(), match_reasons: [] };
    const a = validateDraft(raw, { ...generic, passages: [mangal], imageProvided: true, observedDeity: 'Hanuman' });
    if (!a.ok) throw new Error('x');
    expect(a.fields.deity).toBe('hanuman');
    const b = validateDraft(raw, { ...generic, passages: [mangal], imageProvided: true, observedDeity: 'shiva' });
    if (!b.ok) throw new Error('x');
    expect(b.fields.deity).toBeNull();
  });
});

describe('sortReasons / supportedWearDays', () => {
  it('sorts design-first, stable within a step', () => {
    const rs: MatchReason[] = [
      { step: 'shirt_colour', fact: 's' }, { step: 'print_colour', fact: 'p1' }, { step: 'deity', fact: 'd' }, { step: 'print_colour', fact: 'p2' }, { step: 'chakra', fact: 'c' },
    ];
    expect(sortReasons(rs).map((r) => r.fact)).toEqual(['d', 'c', 'p1', 'p2', 's']);
  });
  it('supports a day via weekday metadata, passage text or a reason', () => {
    expect(supportedWearDays(['tuesday'], [mangal], [])).toEqual(['tuesday']);
    expect(supportedWearDays(['saturday'], [hanuman], [])).toEqual(['saturday']);
    expect(supportedWearDays(['monday'], [P({ id: 'x' })], [{ step: 'deity', fact: 'Shiva is for Monday', source_id: 'x' }])).toEqual(['monday']);
    expect(supportedWearDays(['sunday'], [P({ id: 'x' })], [])).toEqual([]);
  });
});

describe('helpers', () => {
  it('parseModelJson handles fences and junk', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('nope')).toBeNull();
  });
  it('lockedFrom locks only what the admin sent in hints, lower-cased', () => {
    expect(lockedFrom(undefined)).toEqual({});
    expect(lockedFrom({})).toEqual({});
    expect(lockedFrom({ deity: ' Hanuman ', wear_days: ['Tuesday', 'funday'], print_colours: ['Red'] })).toEqual({ deity: 'hanuman', wear_days: ['tuesday'], print_colours: ['red'] });
  });
  it('normKey', () => {
    expect(normKey(' Tuesday ')).toBe('tuesday');
    expect(normKey(null)).toBe('');
    expect(normKey(5)).toBe('');
  });
  it('groundingQueries goes deity, chakra, colours', () => {
    const s: Subject = { kind: 'shop_product', id: 'p', name: 'Hanuman tee', text: '', shirtColours: ['White'], imageUrls: [] };
    const q = groundingQueries(s, { deity: 'hanuman', print_colours: ['red'] });
    expect(groundingQueries({ ...s, name: 'Classic Tee' }, {}, { deity: 'hanuman' })[0]).toContain('hanuman');
    expect(q).toHaveLength(3);
    expect(q[0]).toContain('deity');
    expect(q[1]).toContain('chakra');
    expect(q[2]).toContain('red');
  });
});

// ---- product sync decisions ----
const snap = (o: Partial<ProductSnapshot> = {}): ProductSnapshot => ({ name: 'A', images_json: '[]', colours_json: '[]', print_type: 'Chest print', status: 'live', archived_at: null, ...o });
describe('decideSync', () => {
  const approved = { status: 'approved', vector_id: 'cat:shop_product:p' };
  it('no note -> nothing', () => expect(decideSync(snap(), snap(), null)).toBe('none'));
  it('no longer live -> remove', () => {
    expect(decideSync(snap(), snap({ status: 'hidden' }), approved)).toBe('remove');
    expect(decideSync(snap(), snap({ status: 'archived', archived_at: 5 }), approved)).toBe('remove');
    expect(decideSync(snap(), null, approved)).toBe('remove');
  });
  it('draft note that is not live and has no vector -> nothing', () => {
    expect(decideSync(snap(), snap({ status: 'hidden' }), { status: 'draft', vector_id: null })).toBe('none');
  });
  it('live + approved, unchanged design -> reindex', () => expect(decideSync(snap(), snap(), approved)).toBe('reindex'));
  it('live + approved, name/images/colours/print changed -> revert_draft', () => {
    for (const c of [{ name: 'B' }, { images_json: '[1]' }, { colours_json: '["x"]' }, { print_type: 'Back print' }]) {
      expect(decideSync(snap(), snap(c), approved)).toBe('revert_draft');
    }
    expect(designChanged(null, snap())).toBe(false);
  });
  it('live + draft note -> nothing', () => expect(decideSync(snap(), snap({ name: 'B' }), { status: 'draft', vector_id: null })).toBe('none'));
});

// ---- fake D1 / Vectorize ----
function fakeDb(state: { product: ProductSnapshot | null; note: Partial<NoteRow> | null }) {
  const calls: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (..._a: unknown[]) => ({
        first: async () => {
          if (/FROM shop_products WHERE id/.test(sql)) return state.product;
          if (/FROM product_tradition_notes/.test(sql)) return state.note;
          return null;
        },
        run: async () => { calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' ')); return {}; },
        all: async () => ({ results: [] }),
      }),
    }),
  };
  return { db, calls };
}

describe('onShopProductChanged', () => {
  it('unlisting an approved product deletes its vector', async () => {
    const deleted: string[][] = [];
    const { db } = fakeDb({ product: snap({ status: 'hidden' }), note: { status: 'approved', vector_id: 'v' } });
    const env: any = { DB_META: db, VEC_CATALOG: { deleteByIds: async (ids: string[]) => { deleted.push(ids); } } };
    expect(await onShopProductChanged(env, 'p', { prev: snap() })).toBe('remove');
    expect(deleted).toEqual([['cat:shop_product:p']]);
  });
  it('a design edit on an approved note reverts it to draft and removes the vector', async () => {
    const deleted: string[][] = [];
    const { db, calls } = fakeDb({ product: snap({ name: 'B' }), note: { status: 'approved', vector_id: 'v' } });
    const env: any = { DB_META: db, VEC_CATALOG: { deleteByIds: async (ids: string[]) => { deleted.push(ids); } } };
    expect(await onShopProductChanged(env, 'p', { prev: snap() })).toBe('revert_draft');
    expect(calls.some((c) => c.startsWith("UPDATE product_tradition_notes"))).toBe(true);
    expect(deleted).toHaveLength(1);
  });
  it('never throws: a D1 failure comes back as "error"', async () => {
    const env: any = { DB_META: { prepare: () => { throw new Error('boom'); } } };
    expect(await onShopProductChanged(env, 'p', { prev: snap() })).toBe('error');
  });
});

// ---- draftNote with fakes ----
describe('draftNote', () => {
  const product = { id: 'p', slug: 's', name: 'Hanuman print tee', description: 'Red Hanuman on a white tee', print_type: 'Big front print', colours_json: '[{"name":"White","hex":"#fff"}]', images_json: '[]', status: 'live', archived_at: null };
  function envFor(existing: Partial<NoteRow> | null) {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    let saved: any = existing;
    const env: any = {
      DB_META: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => {
              if (/FROM shop_products WHERE id/.test(sql)) return product;
              if (/studio_designs/.test(sql)) return null;
              if (/FROM product_tradition_notes/.test(sql)) return saved;
              return null;
            },
            run: async () => { writes.push({ sql, args }); if (/INSERT INTO product_tradition_notes/.test(sql)) saved = { id: 'ptn-1', status: 'draft', subject_kind: 'shop_product', subject_id: 'p', deity: args[7], wear_days_json: args[10] }; return {}; },
            all: async () => ({ results: [] }),
          }),
        }),
      },
      VEC_CATALOG: { deleteByIds: async () => {} },
    };
    return { env, writes };
  }
  const retrieve = async () => [hanuman, mangal];

  it('saves a draft from a valid model answer', async () => {
    const { env, writes } = envFor(null);
    const note = await draftNote(env, 'shop_product', 'p', { deps: { retrieve, generate: async () => ({ text: JSON.stringify(goodRaw()), inTok: 1, outTok: 1, model: 'm', ms: 1 }) } });
    expect(note.status).toBe('draft');
    const ins = writes.find((w) => /INSERT INTO product_tradition_notes/.test(w.sql))!;
    expect(ins.sql).toContain("'draft'");
    expect(JSON.parse(ins.args[10] as string)).toEqual(['tuesday', 'saturday']);
  });
  it('retries once with a stricter prompt, then succeeds', async () => {
    const { env } = envFor(null);
    const prompts: string[] = [];
    let n = 0;
    const generate = async (_e: any, sys: string) => {
      prompts.push(sys); n++;
      return { text: JSON.stringify(n === 1 ? { ...goodRaw(), story: 'Definitely brings luck.' } : goodRaw()), inTok: 1, outTok: 1, model: 'm', ms: 1 };
    };
    await draftNote(env, 'shop_product', 'p', { deps: { retrieve, generate } });
    expect(prompts[1]).toContain('STRICT');
    expect(prompts[0]).not.toContain('STRICT');
  });
  it('fails with a clear error after the retry still uses promise words', async () => {
    const { env, writes } = envFor(null);
    const generate = async () => ({ text: JSON.stringify({ ...goodRaw(), story: 'A 100% cure.' }), inTok: 1, outTok: 1, model: 'm', ms: 1 });
    await expect(draftNote(env, 'shop_product', 'p', { deps: { retrieve, generate } })).rejects.toMatchObject({ code: 'promise_wording' });
    expect(writes.some((w) => /INSERT INTO product_tradition_notes/.test(w.sql))).toBe(false);
  });
  it('fails when the library returns no passages', async () => {
    const { env } = envFor(null);
    await expect(draftNote(env, 'shop_product', 'p', { deps: { retrieve: async () => [], generate: async () => { throw new Error('unused'); } } })).rejects.toBeInstanceOf(DraftError);
  });
  it('pulls the vector of a previously approved note', async () => {
    const deleted: string[][] = [];
    const { env } = envFor({ id: 'ptn-0', status: 'approved', design_elements_json: '[]', print_colours_json: '[]' } as any);
    env.VEC_CATALOG = { deleteByIds: async (ids: string[]) => { deleted.push(ids); } };
    await draftNote(env, 'shop_product', 'p', { deps: { retrieve, generate: async () => ({ text: JSON.stringify(goodRaw()), inTok: 1, outTok: 1, model: 'm', ms: 1 }) } });
    expect(deleted).toEqual([['cat:shop_product:p']]);
  });

  it('sends the design image, drafts deity from it for a generic product name, and puts image tokens in the cost event', async () => {
    const { env, writes } = envFor(null);
    const calls: Array<{ system: string; image: unknown }> = [];
    const generate = async (_e: any, system: string, _u: string, image?: unknown) => {
      calls.push({ system, image });
      const scan = system.includes('report ONLY what is clearly visible');
      return { text: JSON.stringify(scan ? { design_type: 'deity', deity: 'hanuman', print_colours: ['red'] } : { ...goodRaw(), match_reasons: [{ step: 'deity', fact: 'Hanuman ji shown on the print', seen_in_image: true }] }), inTok: 1500, outTok: 200, model: 'm', ms: 1 };
    };
    const queries: string[][] = [];
    const image = async () => ({ mime: 'image/png', b64: 'AAAA', source: 'studio_art' as const, bytes: 3 });
    await draftNote(env, 'shop_product', 'p', { deps: { generate, image, retrieve: async (_e, q) => { queries.push(q); return [mangal, hanuman]; } } });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => !!c.image)).toBe(true);
    expect(calls[1].system).toContain('STRONGEST evidence');
    expect(queries[0][0]).toContain('hanuman');                     // retrieval used the scan, not just the name
    const ins = writes.find((w) => /INSERT INTO product_tradition_notes/.test(w.sql))!;
    expect(ins.args[7]).toBe('hanuman');
  });
  it('drafts without vision when there is no usable image', async () => {
    const { env } = envFor(null);
    const calls: unknown[] = [];
    const generate = async (_e: any, _s: string, _u: string, image?: unknown) => { calls.push(image); return { text: JSON.stringify(goodRaw()), inTok: 1, outTok: 1, model: 'm', ms: 1 }; };
    await draftNote(env, 'shop_product', 'p', { deps: { generate, retrieve, image: async () => null } });
    expect(calls).toEqual([null]);
  });
  it('re-drafting does not lock the previous values; only hints lock', async () => {
    const prev = { id: 'ptn-0', status: 'draft', deity: 'shiva', design_type: 'deity', design_elements_json: '[]', print_colours_json: '[]' } as any;
    const a = envFor(prev);
    await draftNote(a.env, 'shop_product', 'p', { deps: { retrieve, image: async () => null, generate: async () => ({ text: JSON.stringify(goodRaw()), inTok: 1, outTok: 1, model: 'm', ms: 1 }) } });
    expect(a.writes.find((w) => /INSERT INTO product_tradition_notes/.test(w.sql))!.args[7]).toBe('hanuman');
    const b = envFor(prev);
    await draftNote(b.env, 'shop_product', 'p', { hints: { deity: 'Shiva' }, deps: { retrieve, image: async () => null, generate: async () => ({ text: JSON.stringify(goodRaw()), inTok: 1, outTok: 1, model: 'm', ms: 1 }) } });
    expect(b.writes.find((w) => /INSERT INTO product_tradition_notes/.test(w.sql))!.args[7]).toBe('shiva');
  });
});
