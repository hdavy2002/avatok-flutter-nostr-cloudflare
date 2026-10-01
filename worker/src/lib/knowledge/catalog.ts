// [AUMFE-KNOWLEDGE-VECTOR-1 2026-10-01] Products + events with an APPROVED tradition note -> Vectorize
// `aumfe-catalog`. D1 is the truth: a hit is returned only when its note is still approved AND the live
// product/event row is still on sale. Vectorize metadata (active/in_stock) is a prefilter, not a verdict.
import type { Env } from "../../types";
import { BRAND } from "../brand";
import { embedOne, embedTexts } from "./embed";
import { CATALOG_INDEX } from "./indexes";
import {
  APP, buildFilter, cleanMeta, clampK, logIndex, normKey, parseStrings, parseJsonArray,
  trackSearchFail, trackSearchOk, trackSearchUnbound,
} from "./common";
import { trackException } from "../../hooks";
import { parseImages, type ProductRow } from "../shop_logic";
// Read-only imports of Preeti's event helpers (no Preeti file is modified).
import { loadEventRow, eventState, resolveEventCard } from "../preeti/cards";
import type { BrandRuntime } from "../preeti/contracts";

export type SubjectKind = "shop_product" | "event";
export const SUBJECT_KINDS: readonly SubjectKind[] = ["shop_product", "event"];
export const isSubjectKind = (v: unknown): v is SubjectKind => v === "shop_product" || v === "event";

export interface NoteRow {
  id: string; subject_kind: SubjectKind; subject_id: string; design_type: string | null;
  design_elements_json: string; print_colours_json: string; shirt_colour: string | null;
  deity: string | null; graha: string | null; chakra: string | null; wear_days_json: string; occasions_json: string;
  mantra: string | null; tradition_note: string; story: string; sources_json: string; match_reasons_json: string;
  status: string; drafted_at: number | null; approved_by: string | null; approved_at: number | null;
  vector_id: string | null; updated_at: number;
}

export interface MatchReason { step: "deity" | "chakra" | "print_colour" | "shirt_colour"; fact: string; source_id?: string; seen_in_image?: boolean }

export interface CatalogFilters { kind?: SubjectKind; deity?: string; graha?: string; chakra?: string; design_type?: string; wear_day?: string }
export interface CatalogQuery { query: string; filters?: CatalogFilters; k?: number }
export interface CatalogHit {
  subject_kind: SubjectKind; subject_id: string; title: string; price_inr: number | null; image_url: string | null;
  url: string; wear_days: string[]; deity: string | null; chakra: string | null; tradition_note: string;
  why: MatchReason[]; score: number;
}

/** What the live D1 row says right now; null => not on sale, drop the hit. */
export interface LiveSubject { title: string; price_inr: number | null; image_url: string | null; url: string }

export const catVectorId = (kind: SubjectKind, id: string) => `cat:${kind}:${id}`;
export function parseCatVectorId(vid: string): { kind: SubjectKind; id: string } | null {
  const m = /^cat:(shop_product|event):(.+)$/.exec(vid);
  return m ? { kind: m[1] as SubjectKind, id: m[2] } : null;
}
const key = (kind: string, id: string) => `${kind}:${id}`;

/** Text that gets embedded: title + design elements + deity + chakra + wear days + occasions + mantra + note. */
export function noteEmbedText(title: string, n: NoteRow): string {
  const parts = [
    title,
    parseStrings(n.design_elements_json).join(", "),
    n.deity ? `Deity: ${n.deity}` : "",
    n.chakra ? `Chakra: ${n.chakra}` : "",
    parseStrings(n.wear_days_json).length ? `Wear on: ${parseStrings(n.wear_days_json).join(", ")}` : "",
    parseStrings(n.occasions_json).length ? `Occasions: ${parseStrings(n.occasions_json).join(", ")}` : "",
    n.mantra ? `Mantra: ${n.mantra}` : "",
    n.tradition_note,
  ];
  return parts.filter((p) => p && p.trim()).join("\n");
}

export function catalogMetadata(n: NoteRow, live: { active: boolean; in_stock: boolean }) {
  const wear = parseStrings(n.wear_days_json).map((d) => normKey(d));
  const colours = parseStrings(n.print_colours_json);
  return cleanMeta({
    subject_id: n.subject_id, kind: n.subject_kind, deity: normKey(n.deity), graha: normKey(n.graha), chakra: normKey(n.chakra),
    design_type: normKey(n.design_type), wear_day: wear[0], wear_days: wear.join(","), print_colour: colours[0],
    in_stock: live.in_stock, active: live.active,
  });
}

export function catalogFilter(f: CatalogFilters = {}) {
  return buildFilter({
    active: true, in_stock: true,
    kind: f.kind, deity: normKey(f.deity), graha: normKey(f.graha), chakra: normKey(f.chakra), design_type: normKey(f.design_type), wear_day: normKey(f.wear_day),
  });
}

export function parseReasons(s: unknown): MatchReason[] {
  const out: MatchReason[] = [];
  for (const r of parseJsonArray(s)) {
    const o = r as Record<string, unknown>;
    if (o && typeof o.fact === "string" && ["deity", "chakra", "print_colour", "shirt_colour"].includes(String(o.step))) {
      out.push({ step: o.step as MatchReason["step"], fact: o.fact, ...(typeof o.source_id === "string" ? { source_id: o.source_id } : {}), ...(o.seen_in_image === true ? { seen_in_image: true } : {}) });
    }
  }
  return out;
}

/** Pure merge: approved note AND live subject, best score per subject, ordered by score. */
export function hydrateCatalog(
  matches: Array<{ id: string; score: number }>, notes: Map<string, NoteRow>, live: Map<string, LiveSubject | null>, k: number,
): CatalogHit[] {
  const out: CatalogHit[] = [];
  const seen = new Set<string>();
  for (const m of [...matches].sort((a, b) => b.score - a.score)) {
    const p = parseCatVectorId(m.id);
    if (!p) continue;
    const kk = key(p.kind, p.id);
    if (seen.has(kk)) continue;
    const note = notes.get(kk);
    const subj = live.get(kk);
    if (!note || note.status !== "approved" || !subj) continue;
    seen.add(kk);
    out.push({
      subject_kind: p.kind, subject_id: p.id, title: subj.title, price_inr: subj.price_inr, image_url: subj.image_url, url: subj.url,
      wear_days: parseStrings(note.wear_days_json).map((d) => normKey(d)), deity: note.deity ? normKey(note.deity) : null, chakra: note.chakra ? normKey(note.chakra) : null,
      tradition_note: note.tradition_note, why: parseReasons(note.match_reasons_json), score: m.score,
    });
    if (out.length >= k) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live-row readers
// ---------------------------------------------------------------------------
const shopUrl = (slug: string) => `${BRAND.webOrigin}/shop/p/${encodeURIComponent(slug)}`;
const brandRuntime = (): BrandRuntime => ({ name: BRAND.name, domain: BRAND.domain, site: BRAND.webOrigin, former: [] });

/** shop_products has no per-variant stock column: "in stock" == status 'live'. */
export function liveShopProduct(row: ProductRow | null | undefined): LiveSubject | null {
  if (!row || row.status !== "live" || row.archived_at) return null;
  return { title: row.name, price_inr: Number(row.price_rupees), image_url: parseImages(row.images_json)[0]?.url ?? null, url: shopUrl(row.slug) };
}

async function loadLiveSubject(env: Env, kind: SubjectKind, id: string): Promise<LiveSubject | null> {
  if (kind === "shop_product") {
    const row = await env.DB_META.prepare(`SELECT * FROM shop_products WHERE id=?1`).bind(id).first<ProductRow>();
    return liveShopProduct(row);
  }
  const card: any = await resolveEventCard(env, brandRuntime(), id);
  if (!card) return null;
  const upcoming = card.starts_at_ms != null && card.starts_at_ms > Date.now();
  if (!(card.booking_open || card.live_now || upcoming)) return null;
  return { title: card.title, price_inr: card.price_rupees ?? null, image_url: card.image ?? null, url: card.read_more_url };
}

async function loadNotes(env: Env, pairs: Array<{ kind: SubjectKind; id: string }>): Promise<Map<string, NoteRow>> {
  const map = new Map<string, NoteRow>();
  for (const p of pairs) {
    const r = await env.DB_META.prepare(`SELECT * FROM product_tradition_notes WHERE subject_kind=?1 AND subject_id=?2`)
      .bind(p.kind, p.id).first<NoteRow>();
    if (r) map.set(key(p.kind, p.id), r);
  }
  return map;
}

export async function getNote(env: Env, kind: SubjectKind, id: string): Promise<NoteRow | null> {
  return (await env.DB_META.prepare(`SELECT * FROM product_tradition_notes WHERE subject_kind=?1 AND subject_id=?2`)
    .bind(kind, id).first<NoteRow>()) ?? null;
}

// ---------------------------------------------------------------------------
// Index / remove / search
// ---------------------------------------------------------------------------
export async function indexSubjectNote(env: Env, kind: SubjectKind, id: string): Promise<{ ok: boolean; reason?: string }> {
  const idx = env.VEC_CATALOG;
  const t0 = Date.now();
  const vid = catVectorId(kind, id);
  try {
    const note = await getNote(env, kind, id);
    if (!note) return { ok: false, reason: "no_note" };
    if (note.status !== "approved") return { ok: false, reason: "not_approved" };
    if (!idx) return { ok: false, reason: "unbound" };
    let title = "";
    let active = false;
    let inStock = false;
    if (kind === "shop_product") {
      const row = await env.DB_META.prepare(`SELECT * FROM shop_products WHERE id=?1`).bind(id).first<ProductRow>();
      if (!row) return { ok: false, reason: "subject_missing" };
      title = row.name;
      active = inStock = row.status === "live" && !row.archived_at;
    } else {
      const row = await loadEventRow(env, id);
      if (!row) return { ok: false, reason: "subject_missing" };
      title = row.title;
      const st = eventState(row);
      active = ["published", "live"].includes(String(row.status));
      inStock = active && (st.booking_open || st.live_now);
    }
    const [values] = await embedTexts(env, [noteEmbedText(title, note)], "catalog");
    await idx.upsert([{ id: vid, values, metadata: catalogMetadata(note, { active, in_stock: inStock }) }]);
    await env.DB_META.prepare(`UPDATE product_tradition_notes SET vector_id=?1 WHERE id=?2`).bind(vid, note.id).run();
    await logIndex(env, CATALOG_INDEX, vid, "upsert", true, Date.now() - t0);
    return { ok: true };
  } catch (err) {
    await logIndex(env, CATALOG_INDEX, vid, "upsert", false, Date.now() - t0, err);
    void trackException(env, err, { route: "knowledge.indexSubjectNote", handled: true, app_name: APP, extra: { kind, id } });
    return { ok: false, reason: "error" };
  }
}

export async function removeSubject(env: Env, kind: SubjectKind, id: string): Promise<{ ok: boolean }> {
  const idx = env.VEC_CATALOG;
  const t0 = Date.now();
  const vid = catVectorId(kind, id);
  try {
    if (!idx) return { ok: false };
    await idx.deleteByIds([vid]);
    await env.DB_META.prepare(`UPDATE product_tradition_notes SET vector_id=NULL WHERE subject_kind=?1 AND subject_id=?2`).bind(kind, id).run();
    await logIndex(env, CATALOG_INDEX, vid, "delete", true, Date.now() - t0);
    return { ok: true };
  } catch (err) {
    await logIndex(env, CATALOG_INDEX, vid, "delete", false, Date.now() - t0, err);
    void trackException(env, err, { route: "knowledge.removeSubject", handled: true, app_name: APP, extra: { kind, id } });
    return { ok: false };
  }
}

export async function searchCatalog(env: Env, q: CatalogQuery): Promise<CatalogHit[]> {
  const idx = env.VEC_CATALOG;
  if (!idx) { trackSearchUnbound(env, CATALOG_INDEX); return []; }
  const query = String(q.query ?? "").trim();
  if (!query) return [];
  const t0 = Date.now();
  try {
    const k = clampK(q.k);
    const vec = await embedOne(env, query, "catalog_query");
    const res = await idx.query(vec, { topK: Math.min(20, k * 3), filter: catalogFilter(q.filters) as any, returnMetadata: "none" });
    const matches = (res.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
    const pairs = matches.map((m) => parseCatVectorId(m.id)).filter((p): p is { kind: SubjectKind; id: string } => !!p);
    const notes = await loadNotes(env, pairs);
    const live = new Map<string, LiveSubject | null>();
    for (const p of pairs) {
      const kk = key(p.kind, p.id);
      if (notes.get(kk)?.status === "approved" && !live.has(kk)) live.set(kk, await loadLiveSubject(env, p.kind, p.id));
    }
    const hits = hydrateCatalog(matches, notes, live, k);
    trackSearchOk(env, CATALOG_INDEX, Date.now() - t0, hits.length, hits[0]?.score ?? null);
    return hits;
  } catch (err) {
    trackSearchFail(env, CATALOG_INDEX, Date.now() - t0, err);
    return [];
  }
}
