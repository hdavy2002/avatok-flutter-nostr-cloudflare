// [AUMFE-KNOWLEDGE-VECTOR-1 2026-10-01] Admin 2 — shared knowledge layer (tradition library + product notes).
// Registered by ONE spread line in routes/admin2.ts (ADMIN2_KNOWLEDGE_ROUTES).
//
//   GET  /api/admin/v2/knowledge/tradition?status=&topic=&q=     POST /knowledge/tradition
//   PUT/DELETE /knowledge/tradition/:id                          POST /knowledge/tradition/:id/approve
//   POST /knowledge/tradition/import  {entries:[...]}  (always lands as DRAFT)
//   GET/PUT /knowledge/notes/:kind/:id    POST /knowledge/notes/:kind/:id/approve|reject
//   POST /knowledge/notes/:kind/:id/draft {hints?}   POST /knowledge/notes/draft-missing {exclude?}  (AI draft, DRAFT only)
//   POST /knowledge/reindex {index:'tradition'|'catalog'}        GET /knowledge/search?index=&q=&filters
//
// Approval and indexing run INLINE (no waitUntil: a detached isolate dies on long jobs).
// Editing an approved row sends it back to draft and pulls its vectors, so stale text is never served.
import type { Env } from "../types";
import { json } from "../util";
import type { Admin2RouteDef } from "./admin2";
import { requireAdmin } from "./admin_money";
import { track, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import {
  indexTraditionEntry, removeTraditionEntry, searchTradition, indexSubjectNote, removeSubject, searchCatalog, getNote, isSubjectKind,
} from "../lib/knowledge";
import type { SubjectKind } from "../lib/knowledge";
import { normKey } from "../lib/knowledge/common";
import { draftNote, DraftError, listLiveWithoutNote } from "../lib/knowledge";

const APP = BRAND.slug;
const BASE = "/api/admin/v2/knowledge";
const P = (s: string) => new RegExp(`^${BASE}/${s}$`);
const ID = "([^/]+)";
const PAGE = 100;
const MAX_TEXT = 60_000;

const err = (status: number, error: string, message: string) => json({ error, message }, status);

async function guard(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403 ? err(403, "admin_only", "You don't have admin access.") : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}
async function body(req: Request): Promise<Record<string, any> | null> {
  try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, any>) : null; } catch { return null; }
}
const s = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const sn = (v: unknown, max = 200): string | null => { const t = s(v, max); return t ? t : null; };
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const jsonArr = (v: unknown): string => JSON.stringify(Array.isArray(v) ? v.slice(0, 50) : []);
const newId = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

/** Wraps a handler: auth + a catch that reports (never swallows) and answers 500. */
const wrap = (name: string, fn: (req: Request, env: Env, params: string[], uid: string) => Promise<Response>) =>
  async (req: Request, env: Env, params: string[]): Promise<Response> => {
    const g = await guard(req, env);
    if (g instanceof Response) return g;
    try {
      return await fn(req, env, params, g.uid);
    } catch (e) {
      void trackException(env, e, { uid: g.uid, route: `admin2_knowledge.${name}`, method: req.method, handled: true, app_name: APP });
      return err(500, "server_error", "Something went wrong.");
    }
  };

// ---------------------------------------------------------------------------
// Tradition corpus
// ---------------------------------------------------------------------------
const TRAD_COLS = "id, topic, title, text, source, lang, graha, weekday, deity, status, chunk_count, indexed_at, created_at, updated_at, updated_by";

const traditionList = wrap("traditionList", async (req, env) => {
  const u = new URL(req.url);
  const where: string[] = []; const binds: unknown[] = [];
  const status = s(u.searchParams.get("status")); if (status) { binds.push(status); where.push(`status=?${binds.length}`); }
  const topic = s(u.searchParams.get("topic")); if (topic) { binds.push(topic); where.push(`topic=?${binds.length}`); }
  const q = s(u.searchParams.get("q")); if (q) { binds.push(likeOf(q)); where.push(`(title LIKE ?${binds.length} ESCAPE '\\' OR text LIKE ?${binds.length} ESCAPE '\\')`); }
  const rs = await env.DB_META.prepare(
    `SELECT ${TRAD_COLS} FROM tradition_corpus ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ${PAGE}`,
  ).bind(...binds).all();
  return json({ entries: rs.results ?? [] });
});

type TradFields = { topic: string; title: string; text: string; source: string; lang: string; graha: string | null; weekday: string | null; deity: string | null };
function tradFields(b: Record<string, any>): TradFields {
  return {
    topic: s(b.topic, 80), title: s(b.title, 200), text: typeof b.text === "string" ? b.text.trim().slice(0, MAX_TEXT) : "",
    source: s(b.source, 300), lang: s(b.lang, 10) || "en", graha: normKey(b.graha, 40) || null, weekday: normKey(b.weekday, 20) || null, deity: normKey(b.deity, 60) || null,
  };
}

const traditionCreate = wrap("traditionCreate", async (req, env, _p, uid) => {
  const b = await body(req); if (!b) return err(400, "bad_json", "Send a JSON body.");
  const f = tradFields(b);
  if (!f.title || !f.text) return err(400, "missing_fields", "title and text are required.");
  const id = s(b.id, 80) || newId("trd");
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO tradition_corpus (id, topic, title, text, source, lang, graha, weekday, deity, status, chunk_count, created_at, updated_at, updated_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'draft',0,?10,?10,?11)`,
  ).bind(id, f.topic, f.title, f.text, f.source, f.lang, f.graha, f.weekday, f.deity, now, uid).run();
  void track(env, uid, "knowledge_tradition_saved", APP, { id, action: "create" });
  return json({ id, status: "draft" }, 201);
});

const traditionUpdate = wrap("traditionUpdate", async (req, env, [id], uid) => {
  const b = await body(req); if (!b) return err(400, "bad_json", "Send a JSON body.");
  const cur = await env.DB_META.prepare(`SELECT status FROM tradition_corpus WHERE id=?1`).bind(id).first<{ status: string }>();
  if (!cur) return err(404, "not_found", "No such entry.");
  const f = tradFields(b);
  if (!f.title || !f.text) return err(400, "missing_fields", "title and text are required.");
  // An approved row that changes goes back to draft and leaves the index until re-approved.
  const wasApproved = cur.status === "approved";
  await env.DB_META.prepare(
    `UPDATE tradition_corpus SET topic=?1, title=?2, text=?3, source=?4, lang=?5, graha=?6, weekday=?7, deity=?8,
       status=CASE WHEN status='approved' THEN 'draft' ELSE status END, updated_at=?9, updated_by=?10 WHERE id=?11`,
  ).bind(f.topic, f.title, f.text, f.source, f.lang, f.graha, f.weekday, f.deity, Date.now(), uid, id).run();
  if (wasApproved) await removeTraditionEntry(env, id);
  void track(env, uid, "knowledge_tradition_saved", APP, { id, action: "update", reverted_to_draft: wasApproved });
  return json({ id, status: wasApproved ? "draft" : cur.status });
});

const traditionDelete = wrap("traditionDelete", async (req, env, [id], uid) => {
  const cur = await env.DB_META.prepare(`SELECT id FROM tradition_corpus WHERE id=?1`).bind(id).first();
  if (!cur) return err(404, "not_found", "No such entry.");
  const r = await removeTraditionEntry(env, id);
  await env.DB_META.prepare(`UPDATE tradition_corpus SET status='archived', updated_at=?1, updated_by=?2 WHERE id=?3`).bind(Date.now(), uid, id).run();
  void track(env, uid, "knowledge_tradition_saved", APP, { id, action: "archive", vectors_removed: r.removed });
  return json({ id, status: "archived", vectors_removed: r.removed, vector_ok: r.ok });
});

const traditionApprove = wrap("traditionApprove", async (req, env, [id], uid) => {
  const cur = await env.DB_META.prepare(`SELECT id FROM tradition_corpus WHERE id=?1`).bind(id).first();
  if (!cur) return err(404, "not_found", "No such entry.");
  await env.DB_META.prepare(`UPDATE tradition_corpus SET status='approved', updated_at=?1, updated_by=?2 WHERE id=?3`).bind(Date.now(), uid, id).run();
  const r = await indexTraditionEntry(env, id);
  void track(env, uid, "knowledge_tradition_saved", APP, { id, action: "approve", indexed: r.ok, reason: r.reason ?? null });
  return json({ id, status: "approved", indexed: r.ok, chunks: r.chunks, reason: r.reason ?? null });
});

const traditionImport = wrap("traditionImport", async (req, env, _p, uid) => {
  const b = await body(req);
  const entries = Array.isArray(b?.entries) ? (b!.entries as Record<string, any>[]) : null;
  if (!entries) return err(400, "bad_json", "Send {entries:[...]}.");
  if (entries.length > 200) return err(400, "too_many", "At most 200 entries per import.");
  let imported = 0; const skipped: { index: number; reason: string }[] = [];
  const now = Date.now();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] ?? {};
    const f = tradFields(e);
    if (!f.title || !f.text) { skipped.push({ index: i, reason: "title_and_text_required" }); continue; }
    const id = s(e.id, 80) || newId("trd");
    // Upsert as DRAFT, never auto-approve. Re-importing an approved id pulls it from the index until re-approved.
    const prev = await env.DB_META.prepare(`SELECT status FROM tradition_corpus WHERE id=?1`).bind(id).first<{ status: string }>();
    await env.DB_META.prepare(
      `INSERT INTO tradition_corpus (id, topic, title, text, source, lang, graha, weekday, deity, status, chunk_count, created_at, updated_at, updated_by)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'draft',0,?10,?10,?11)
       ON CONFLICT(id) DO UPDATE SET topic=excluded.topic, title=excluded.title, text=excluded.text, source=excluded.source, lang=excluded.lang,
         graha=excluded.graha, weekday=excluded.weekday, deity=excluded.deity, status='draft', updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    ).bind(id, f.topic, f.title, f.text, f.source, f.lang, f.graha, f.weekday, f.deity, now, uid).run();
    if (prev?.status === "approved") await removeTraditionEntry(env, id);
    imported++;
  }
  void track(env, uid, "knowledge_tradition_imported", APP, { imported, skipped: skipped.length });
  return json({ imported, skipped, status: "draft" });
});

// ---------------------------------------------------------------------------
// Product / event notes
// ---------------------------------------------------------------------------
const DESIGN_TYPES = ["deity", "symbol", "chakra", "mandala", "yantra", "mantra", "other"];

function kindOf(raw: string): SubjectKind | null { return isSubjectKind(raw) ? raw : null; }

const noteGet = wrap("noteGet", async (req, env, [kind, id]) => {
  const k = kindOf(kind); if (!k) return err(400, "bad_kind", "kind must be shop_product or event.");
  const note = await getNote(env, k, id);
  return json({ note: note ?? null });
});

const notePut = wrap("notePut", async (req, env, [kind, id], uid) => {
  const k = kindOf(kind); if (!k) return err(400, "bad_kind", "kind must be shop_product or event.");
  const b = await body(req); if (!b) return err(400, "bad_json", "Send a JSON body.");
  const dt = normKey(b.design_type, 20) || null;
  if (dt && !DESIGN_TYPES.includes(dt)) return err(400, "bad_design_type", `design_type must be one of ${DESIGN_TYPES.join(", ")}.`);
  const cur = await getNote(env, k, id);
  const now = Date.now();
  const vals = [
    dt, jsonArr(b.design_elements), jsonArr(b.print_colours), sn(b.shirt_colour, 60), normKey(b.deity, 60) || null, normKey(b.graha, 40) || null, normKey(b.chakra, 40) || null,
    jsonArr(Array.isArray(b.wear_days) ? b.wear_days.map((d: unknown) => normKey(d, 20)).filter(Boolean) : []), jsonArr(b.occasions), sn(b.mantra, 300), s(b.tradition_note, 4000), s(b.story, 8000), jsonArr(b.sources),
    JSON.stringify(Array.isArray(b.match_reasons) ? b.match_reasons.slice(0, 12) : []),
  ];
  if (cur) {
    await env.DB_META.prepare(
      `UPDATE product_tradition_notes SET design_type=?1, design_elements_json=?2, print_colours_json=?3, shirt_colour=?4, deity=?5, graha=?6, chakra=?7,
         wear_days_json=?8, occasions_json=?9, mantra=?10, tradition_note=?11, story=?12, sources_json=?13, match_reasons_json=?14,
         status=CASE WHEN status='approved' THEN 'draft' ELSE status END, updated_at=?15 WHERE id=?16`,
    ).bind(...vals, now, cur.id).run();
    if (cur.status === "approved") await removeSubject(env, k, id);
  } else {
    await env.DB_META.prepare(
      `INSERT INTO product_tradition_notes (id, subject_kind, subject_id, design_type, design_elements_json, print_colours_json, shirt_colour, deity, graha, chakra,
         wear_days_json, occasions_json, mantra, tradition_note, story, sources_json, match_reasons_json, status, drafted_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'draft',?18,?18)`,
    ).bind(newId("ptn"), k, id, ...vals, now).run();
  }
  void track(env, uid, "knowledge_note_saved", APP, { kind: k, subject_id: id, created: !cur });
  return json({ note: await getNote(env, k, id) });
});

const noteApprove = wrap("noteApprove", async (req, env, [kind, id], uid) => {
  const k = kindOf(kind); if (!k) return err(400, "bad_kind", "kind must be shop_product or event.");
  const cur = await getNote(env, k, id);
  if (!cur) return err(404, "not_found", "Save the note first.");
  const now = Date.now();
  await env.DB_META.prepare(`UPDATE product_tradition_notes SET status='approved', approved_by=?1, approved_at=?2, updated_at=?2 WHERE id=?3`).bind(uid, now, cur.id).run();
  const r = await indexSubjectNote(env, k, id);
  void track(env, uid, "knowledge_note_approved", APP, { kind: k, subject_id: id, indexed: r.ok, reason: r.reason ?? null });
  return json({ status: "approved", approved_by: uid, indexed: r.ok, reason: r.reason ?? null });
});

const noteReject = wrap("noteReject", async (req, env, [kind, id], uid) => {
  const k = kindOf(kind); if (!k) return err(400, "bad_kind", "kind must be shop_product or event.");
  const cur = await getNote(env, k, id);
  if (!cur) return err(404, "not_found", "No such note.");
  await env.DB_META.prepare(`UPDATE product_tradition_notes SET status='rejected', updated_at=?1 WHERE id=?2`).bind(Date.now(), cur.id).run();
  await removeSubject(env, k, id);
  void track(env, uid, "knowledge_note_rejected", APP, { kind: k, subject_id: id });
  return json({ status: "rejected" });
});

// [AUMFE-DESIGN-MATCH-1] AI draft. Runs inline (a detached isolate dies on long jobs). Saves a DRAFT only, never approves.
const hintsOf = (b: Record<string, any> | null) => {
  const h = (b?.hints ?? null) as Record<string, any> | null;
  if (!h || typeof h !== "object" || Array.isArray(h)) return undefined;
  const arr = (v: unknown, n: number, m: number) => (Array.isArray(v) ? v.map((x) => s(x, m)).filter(Boolean).slice(0, n) : undefined);
  return {
    design_type: sn(h.design_type, 20) ?? undefined, design_elements: arr(h.design_elements, 10, 80), print_colours: arr(h.print_colours, 6, 40),
    shirt_colour: sn(h.shirt_colour, 60) ?? undefined, deity: sn(h.deity, 60) ?? undefined, graha: sn(h.graha, 40) ?? undefined,
    chakra: sn(h.chakra, 40) ?? undefined, wear_days: arr(h.wear_days, 7, 20),
  };
};
const draftErr = (e: unknown): Response | null =>
  e instanceof DraftError ? err(e.status, e.code, e.message) : null;

const noteDraft = wrap("noteDraft", async (req, env, [kind, id], uid) => {
  const k = kindOf(kind); if (!k) return err(400, "bad_kind", "kind must be shop_product or event.");
  const b = await body(req); // body is optional
  try {
    const note = await draftNote(env, k, id, { hints: hintsOf(b), uid });
    return json({ note });
  } catch (e) {
    const r = draftErr(e); if (r) return r;
    throw e;
  }
});

const noteDraftMissing = wrap("noteDraftMissing", async (req, env, _p, uid) => {
  const b = await body(req);
  const exclude = Array.isArray(b?.exclude) ? (b!.exclude as unknown[]).map((x) => s(x, 80)).filter(Boolean) : [];
  const { ids, total } = await listLiveWithoutNote(env, 5, exclude);
  const drafted: string[] = []; const failed: Array<{ id: string; error: string; message: string }> = [];
  for (const id of ids) {
    try { await draftNote(env, "shop_product", id, { uid }); drafted.push(id); }
    catch (e) {
      // draftNote already reported it; this row only tells the admin which product failed and why.
      failed.push({ id, error: e instanceof DraftError ? e.code : "error", message: e instanceof DraftError ? e.message : "Drafting failed." });
    }
  }
  void track(env, uid, "knowledge_draft_missing", APP, { drafted: drafted.length, failed: failed.length });
  return json({ drafted, failed, remaining: Math.max(0, total - drafted.length) });
});

// ---------------------------------------------------------------------------
// Reindex + search console
// ---------------------------------------------------------------------------
const reindex = wrap("reindex", async (req, env, _p, uid) => {
  const b = await body(req);
  const index = b?.index;
  if (index !== "tradition" && index !== "catalog") return err(400, "bad_index", "index must be 'tradition' or 'catalog'.");
  const t0 = Date.now();
  let ok = 0; let failed = 0; const reasons: Record<string, number> = {};
  const bump = (r?: string) => { const key = r ?? "error"; reasons[key] = (reasons[key] ?? 0) + 1; };
  if (index === "tradition") {
    const rs = await env.DB_META.prepare(`SELECT id FROM tradition_corpus WHERE status='approved'`).all<{ id: string }>();
    for (const r of rs.results ?? []) { const x = await indexTraditionEntry(env, r.id); if (x.ok) ok++; else { failed++; bump(x.reason); } }
  } else {
    const rs = await env.DB_META.prepare(`SELECT subject_kind, subject_id FROM product_tradition_notes WHERE status='approved'`).all<{ subject_kind: SubjectKind; subject_id: string }>();
    for (const r of rs.results ?? []) { const x = await indexSubjectNote(env, r.subject_kind, r.subject_id); if (x.ok) ok++; else { failed++; bump(x.reason); } }
  }
  void track(env, uid, "knowledge_reindexed", APP, { index, ok, failed, ms: Date.now() - t0 });
  return json({ index, ok, failed, reasons, ms: Date.now() - t0 });
});

const searchConsole = wrap("searchConsole", async (req, env, _p, uid) => {
  const u = new URL(req.url);
  const q = s(u.searchParams.get("q"), 500);
  const index = u.searchParams.get("index");
  const k = Number(u.searchParams.get("k") || 5);
  if (!q) return err(400, "missing_q", "q is required.");
  const g = (n: string) => sn(u.searchParams.get(n), 80) ?? undefined;
  let hits: unknown[];
  if (index === "tradition") hits = await searchTradition(env, { query: q, topic: g("topic"), graha: g("graha"), weekday: g("weekday"), deity: g("deity"), k });
  else if (index === "catalog") {
    const kind = g("kind");
    hits = await searchCatalog(env, {
      query: q, k,
      filters: { kind: isSubjectKind(kind) ? kind : undefined, deity: g("deity"), graha: g("graha"), chakra: g("chakra"), design_type: g("design_type"), wear_day: g("wear_day") },
    });
  } else return err(400, "bad_index", "index must be 'tradition' or 'catalog'.");
  void track(env, uid, "knowledge_search_console", APP, { index, hits: hits.length });
  return json({ index, q, hits });
});

export const ADMIN2_KNOWLEDGE_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: `${BASE}/tradition`, handler: traditionList },
  { method: "POST", path: `${BASE}/tradition`, handler: traditionCreate },
  { method: "POST", path: `${BASE}/tradition/import`, handler: traditionImport },
  { method: "PUT", path: P(`tradition/${ID}`), handler: traditionUpdate },
  { method: "DELETE", path: P(`tradition/${ID}`), handler: traditionDelete },
  { method: "POST", path: P(`tradition/${ID}/approve`), handler: traditionApprove },
  { method: "GET", path: P(`notes/${ID}/${ID}`), handler: noteGet },
  { method: "PUT", path: P(`notes/${ID}/${ID}`), handler: notePut },
  { method: "POST", path: `${BASE}/notes/draft-missing`, handler: noteDraftMissing },
  { method: "POST", path: P(`notes/${ID}/${ID}/draft`), handler: noteDraft },
  { method: "POST", path: P(`notes/${ID}/${ID}/approve`), handler: noteApprove },
  { method: "POST", path: P(`notes/${ID}/${ID}/reject`), handler: noteReject },
  { method: "POST", path: `${BASE}/reindex`, handler: reindex },
  { method: "GET", path: `${BASE}/search`, handler: searchConsole },
];
