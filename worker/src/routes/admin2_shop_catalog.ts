// [SAATHUM-SHOP-API-CATALOG-1 2026-10-01] Admin shop catalogue: products, collections, slots, settings, coupons.
// Contract: Specs/SPEC-2026-10-01-SAATHUM-SHOP.md section 4.4. Registered by routes/admin2.ts
// (ADMIN2_SHOP_CATALOG_ROUTES). Pattern: routes/saathum_chadhava.ts (guard, audit to DB_WALLET admin_audit, safeTrack).
//
// Every route is under /api/admin/v2/shop/ and behind the admin guard; every write is audited + tracked.
import type { Env } from "../types";
import { json } from "../util";
import type { Admin2RouteDef } from "./admin2"; // type only: admin2.ts imports this file, a value import would be circular
import { requireAdmin } from "./admin_money";
import { track, trackException } from "../hooks";
import {
  SLOTS, isValidImageUrl, normalizeProductInput, parseImages, slugify, toShopCard,
  type FieldError, type ProductRow, type CouponRow,
} from "../lib/shop_logic";

const APP = "saathum";
const BASE = "/api/admin/v2/shop";
const RESTORE_WINDOW_MS = 30 * 86_400_000;

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);
const noStore = { "cache-control": "private, no-store" };

async function adminGuard(req: Request, env: Env): Promise<{ uid: string } | Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) {
    return a.status === 403 ? err(403, "admin_only", "You don't have admin access.") : err(a.status, "unauthorized", "Please sign in again.");
  }
  return a;
}

function safeTrack(env: Env, uid: string, event: string, props: Record<string, unknown>): void {
  try { void track(env, uid, event, APP, props); } catch { /* telemetry is best-effort */ }
}

async function audit(env: Env, adminId: string, action: string, target: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), adminId, action, target, JSON.stringify(meta), Date.now()).run();
  } catch { /* audit is best-effort, matching the other admin routes */ }
}

async function readBody(req: Request, max = 65_536): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > max) return null;
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/** Run a handler behind the guard, turning a missing table / thrown error into a reported JSON error. */
function guarded(route: string, fn: (req: Request, env: Env, a: { uid: string }, params: string[]) => Promise<Response>) {
  return async (req: Request, env: Env, params: string[]): Promise<Response> => {
    const a = await adminGuard(req, env);
    if (a instanceof Response) return a;
    try {
      return await fn(req, env, a, params);
    } catch (e) {
      if (/no such table/i.test(String((e as { message?: string })?.message ?? e))) {
        return err(503, "shop_unavailable", "The shop tables are not set up yet.");
      }
      await trackException(env, e, { uid: a.uid, route, method: req.method, handled: true, app_name: APP });
      return err(500, "internal", "Something went wrong.");
    }
  };
}

const hex8 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const bad = (errors: FieldError[], error = "invalid_input") => err(400, error, errors[0].message, { field: errors[0].field, errors });

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
type CollectionRow = { id: string; slug: string; name: string; blurb: string; image_url: string | null; sort: number; active: number; created_at: number; updated_at: number };

async function allCollections(env: Env): Promise<CollectionRow[]> {
  const r = await env.DB_META.prepare("SELECT * FROM shop_collections ORDER BY sort ASC, name ASC").all<CollectionRow>();
  return r.results ?? [];
}

async function promotedMap(env: Env): Promise<Map<string, string[]>> {
  const r = await env.DB_META.prepare("SELECT slot, product_id FROM shop_slots ORDER BY slot, sort").all<{ slot: string; product_id: string }>();
  const m = new Map<string, string[]>();
  for (const x of r.results ?? []) m.set(x.product_id, [...(m.get(x.product_id) ?? []), x.slot]);
  return m;
}

function adminProduct(p: ProductRow, cols: Map<string, { slug: string; name: string }>, promoted: string[]) {
  return {
    ...toShopCard(p, p.collection_id ? cols.get(p.collection_id) ?? null : null),
    description: p.description,
    fit: p.fit,
    print_type: p.print_type,
    audience: p.audience,
    images: parseImages(p.images_json),
    seo_title: p.seo_title,
    seo_description: p.seo_description,
    status: p.status,
    collection_id: p.collection_id,
    promoted_on: promoted,
    printrove_ref: p.printrove_ref,
    sold_count: Number(p.sold_count),
    updated_at: Number(p.updated_at),
  };
}

async function loadProduct(env: Env, id: string): Promise<ProductRow | null> {
  if (!id || id.length > 100) return null;
  return env.DB_META.prepare("SELECT * FROM shop_products WHERE id=?1").bind(id).first<ProductRow>();
}

async function uniqueSlug(env: Env, base: string, selfId: string | null): Promise<string> {
  const root = base || "tee";
  for (let i = 0; i < 50; i++) {
    const cand = i === 0 ? root : `${root.slice(0, 55)}-${i + 1}`;
    const hit = await env.DB_META.prepare("SELECT id FROM shop_products WHERE slug=?1").bind(cand).first<{ id: string }>();
    if (!hit || hit.id === selfId) return cand;
  }
  return `${root.slice(0, 50)}-${hex8()}`;
}

function seoDefaults(p: { name: string; description: string; fit: string; print_type: string }, collectionName: string | null) {
  const title = collectionName ? `${p.name} – ${collectionName} T-shirt` : `${p.name} – T-shirt`;
  const desc = p.description
    ? p.description.replace(/\s+/g, " ").slice(0, 155)
    : `${p.name}, a ${p.fit.toLowerCase()} T-shirt with a ${p.print_type.toLowerCase()}. Free shipping across India.`;
  return { title: title.slice(0, 120), desc };
}

async function collectionExists(env: Env, id: string): Promise<CollectionRow | null> {
  return env.DB_META.prepare("SELECT * FROM shop_collections WHERE id=?1").bind(id).first<CollectionRow>();
}

const listProducts = guarded("admin2.shop.products.list", async (req, env) => {
  const status = new URL(req.url).searchParams.get("status") ?? "all";
  const [rows, cols, promoted] = await Promise.all([
    env.DB_META.prepare("SELECT * FROM shop_products ORDER BY updated_at DESC").all<ProductRow>(),
    allCollections(env),
    promotedMap(env),
  ]);
  const cmap = new Map(cols.map((c) => [c.id, { slug: c.slug, name: c.name }]));
  const all = rows.results ?? [];
  const counts = { all: 0, live: 0, draft: 0, hidden: 0, archived: 0 };
  for (const p of all) {
    if (p.status in counts) counts[p.status as "live" | "draft" | "hidden" | "archived"]++;
    if (p.status !== "archived") counts.all++; // "all" = everything except the archive
  }
  const shown = all.filter((p) => (status === "all" ? p.status !== "archived" : p.status === status));
  return json({ items: shown.map((p) => adminProduct(p, cmap, promoted.get(p.id) ?? [])), counts }, 200, noStore);
});

// [SAATHUM-SHOP-API-CATALOG-1] Single product, full admin view (the edit modal loads it).
const getProduct = guarded("admin2.shop.products.get", async (_req, env, _a, [id]) => {
  const row = await loadProduct(env, id);
  if (!row) return err(404, "not_found", "No such product.");
  const [cols, promoted] = await Promise.all([allCollections(env), promotedMap(env)]);
  return json({ product: adminProduct(row, new Map(cols.map((c) => [c.id, { slug: c.slug, name: c.name }])), promoted.get(id) ?? []) }, 200, noStore);
});

const createProduct = guarded("admin2.shop.products.create", async (req, env, a) => {
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the product as JSON.");
  const { value: v, errors } = normalizeProductInput(b, { partial: false });
  if (errors.length) return bad(errors, "invalid_product");
  let collectionName: string | null = null;
  if (v.collection_id) {
    const c = await collectionExists(env, v.collection_id);
    if (!c) return bad([{ field: "collection_id", message: "That collection does not exist." }], "invalid_product");
    collectionName = c.name;
  }
  let slug: string;
  if (v.slug) {
    const taken = await env.DB_META.prepare("SELECT id FROM shop_products WHERE slug=?1").bind(v.slug).first();
    if (taken) return err(409, "slug_taken", "Another product already uses that slug.", { field: "slug" });
    slug = v.slug;
  } else slug = await uniqueSlug(env, slugify(v.name!), null);

  const id = `prd-${hex8()}`;
  const now = Date.now();
  const status = v.status ?? "draft";
  const base = { name: v.name!, description: v.description ?? "", fit: v.fit ?? "Regular", print_type: v.print_type ?? "Big front print" };
  const seo = seoDefaults(base, collectionName);
  await env.DB_META.prepare(
    `INSERT INTO shop_products (id, slug, name, collection_id, description, fit, print_type, audience, price_rupees, mrp_rupees,
       colours_json, sizes_json, images_json, badge, status, printrove_ref, sold_count, seo_title, seo_description, archived_at, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,0,?17,?18,?19,?20,?20)`,
  ).bind(
    id, slug, base.name, v.collection_id ?? null, base.description, base.fit, base.print_type, v.audience ?? "Adults",
    v.price_rupees, v.mrp_rupees ?? null, JSON.stringify(v.colours), JSON.stringify(v.sizes), JSON.stringify(v.images ?? []),
    v.badge ?? "", status, v.printrove_ref ?? null, v.seo_title ?? seo.title, v.seo_description ?? seo.desc,
    status === "archived" ? now : null, now,
  ).run();
  await audit(env, a.uid, "shop_product_create", id, { name: base.name, price_rupees: v.price_rupees, status });
  safeTrack(env, a.uid, "admin2_shop_product_saved", { action: "create", product_id: id, status });
  const row = await loadProduct(env, id);
  const cols = await allCollections(env);
  return json({ product: adminProduct(row!, new Map(cols.map((c) => [c.id, { slug: c.slug, name: c.name }])), []) }, 201);
});

const updateProduct = guarded("admin2.shop.products.update", async (req, env, a, [id]) => {
  const row = await loadProduct(env, id);
  if (!row) return err(404, "not_found", "No such product.");
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the changes as JSON.");
  const { value: v, errors } = normalizeProductInput(b, { partial: true });
  if (errors.length) return bad(errors, "invalid_product");
  if (v.collection_id) {
    if (!(await collectionExists(env, v.collection_id))) return bad([{ field: "collection_id", message: "That collection does not exist." }], "invalid_product");
  }
  let slug = row.slug;
  if (v.slug && v.slug !== row.slug) {
    const taken = await env.DB_META.prepare("SELECT id FROM shop_products WHERE slug=?1 AND id<>?2").bind(v.slug, id).first();
    if (taken) return err(409, "slug_taken", "Another product already uses that slug.", { field: "slug" });
    slug = v.slug;
  }
  const mrp = v.mrp_rupees !== undefined ? v.mrp_rupees : row.mrp_rupees;
  const price = v.price_rupees ?? Number(row.price_rupees);
  if (mrp !== null && mrp < price) return bad([{ field: "mrp_rupees", message: "MRP cannot be lower than the price." }], "invalid_product");

  const now = Date.now();
  const next = {
    slug,
    name: v.name ?? row.name,
    collection_id: v.collection_id !== undefined ? v.collection_id : row.collection_id,
    description: v.description ?? row.description,
    fit: v.fit ?? row.fit,
    print_type: v.print_type ?? row.print_type,
    audience: v.audience ?? row.audience,
    price_rupees: price,
    mrp_rupees: mrp,
    colours_json: v.colours ? JSON.stringify(v.colours) : row.colours_json,
    sizes_json: v.sizes ? JSON.stringify(v.sizes) : row.sizes_json,
    images_json: v.images ? JSON.stringify(v.images) : row.images_json,
    badge: v.badge ?? row.badge,
    status: v.status ?? row.status,
    printrove_ref: v.printrove_ref !== undefined ? v.printrove_ref : row.printrove_ref,
    seo_title: v.seo_title !== undefined ? v.seo_title : row.seo_title,
    seo_description: v.seo_description !== undefined ? v.seo_description : row.seo_description,
  };
  if (!next.seo_title || !next.seo_description) {
    const cn = next.collection_id ? (await collectionExists(env, next.collection_id))?.name ?? null : null;
    const seo = seoDefaults(next, cn);
    next.seo_title = next.seo_title || seo.title;
    next.seo_description = next.seo_description || seo.desc;
  }
  const archivedAt = next.status === "archived" ? (row.archived_at ?? now) : null;
  const stmts = [
    env.DB_META.prepare(
      `UPDATE shop_products SET slug=?2, name=?3, collection_id=?4, description=?5, fit=?6, print_type=?7, audience=?8, price_rupees=?9,
         mrp_rupees=?10, colours_json=?11, sizes_json=?12, images_json=?13, badge=?14, status=?15, printrove_ref=?16, seo_title=?17,
         seo_description=?18, archived_at=?19, updated_at=?20 WHERE id=?1`,
    ).bind(id, next.slug, next.name, next.collection_id, next.description, next.fit, next.print_type, next.audience, next.price_rupees,
      next.mrp_rupees, next.colours_json, next.sizes_json, next.images_json, next.badge, next.status, next.printrove_ref, next.seo_title,
      next.seo_description, archivedAt, now),
  ];
  if (next.status === "archived" && row.status !== "archived") stmts.push(env.DB_META.prepare("DELETE FROM shop_slots WHERE product_id=?1").bind(id));
  await env.DB_META.batch(stmts);
  await audit(env, a.uid, "shop_product_update", id, { changes: Object.keys(v) });
  safeTrack(env, a.uid, "admin2_shop_product_saved", { action: "update", product_id: id, status: next.status });
  const [fresh, cols, promoted] = await Promise.all([loadProduct(env, id), allCollections(env), promotedMap(env)]);
  return json({ product: adminProduct(fresh!, new Map(cols.map((c) => [c.id, { slug: c.slug, name: c.name }])), promoted.get(id) ?? []) });
});

const archiveProduct = guarded("admin2.shop.products.archive", async (req, env, a, [id]) => {
  const row = await loadProduct(env, id);
  if (!row) return err(404, "not_found", "No such product.");
  const now = Date.now();
  if (row.status !== "archived") {
    await env.DB_META.batch([
      env.DB_META.prepare("UPDATE shop_products SET status='archived', archived_at=?2, updated_at=?2 WHERE id=?1").bind(id, now),
      env.DB_META.prepare("DELETE FROM shop_slots WHERE product_id=?1").bind(id),
    ]);
    await audit(env, a.uid, "shop_product_archive", id, { name: row.name });
    safeTrack(env, a.uid, "admin2_shop_product_deleted", { product_id: id });
  }
  return json({ ok: true, id, status: "archived", restorable_until: (row.archived_at ?? now) + RESTORE_WINDOW_MS });
});

const restoreProduct = guarded("admin2.shop.products.restore", async (req, env, a, [id]) => {
  const row = await loadProduct(env, id);
  if (!row) return err(404, "not_found", "No such product.");
  if (row.status !== "archived") return err(409, "not_archived", "That product is not archived.");
  const now = Date.now();
  if (now - Number(row.archived_at ?? 0) > RESTORE_WINDOW_MS) return err(409, "restore_window_closed", "Products can only be restored within 30 days of archiving.");
  await env.DB_META.prepare("UPDATE shop_products SET status='draft', archived_at=NULL, updated_at=?2 WHERE id=?1").bind(id, now).run();
  await audit(env, a.uid, "shop_product_restore", id, { name: row.name });
  safeTrack(env, a.uid, "admin2_shop_product_saved", { action: "restore", product_id: id });
  const [fresh, cols] = await Promise.all([loadProduct(env, id), allCollections(env)]);
  return json({ product: adminProduct(fresh!, new Map(cols.map((c) => [c.id, { slug: c.slug, name: c.name }])), []) });
});

const promoteProduct = guarded("admin2.shop.products.promote", async (req, env, a, [id]) => {
  const row = await loadProduct(env, id);
  if (!row) return err(404, "not_found", "No such product.");
  if (row.status === "archived") return err(409, "archived", "Restore the product before promoting it.");
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the slots as JSON.");
  const slots = Array.isArray(b.slots) ? b.slots.map(String) : null;
  if (!slots || slots.some((s) => !(SLOTS as readonly string[]).includes(s))) return bad([{ field: "slots", message: "Choose from the listed slots." }]);
  const badge = b.badge === undefined ? row.badge : String(b.badge ?? "");
  if (!["", "new", "best", "sale"].includes(badge)) return bad([{ field: "badge", message: "Badge must be none, new, best or sale." }]);
  let until: number | null = null;
  if (b.until_at !== undefined && b.until_at !== null && b.until_at !== "") {
    until = Number(b.until_at);
    if (!Number.isFinite(until) || until <= 0) return bad([{ field: "until_at", message: "Show-until must be a valid date." }]);
  }
  const uniq = [...new Set(slots)];
  const now = Date.now();
  const stmts = [env.DB_META.prepare("DELETE FROM shop_slots WHERE product_id=?1").bind(id)];
  for (const s of uniq) {
    stmts.push(env.DB_META.prepare(
      "INSERT INTO shop_slots (slot, product_id, sort, until_at) VALUES (?1,?2,(SELECT COALESCE(MAX(sort),-1)+1 FROM shop_slots WHERE slot=?1),?3)",
    ).bind(s, id, until));
  }
  stmts.push(env.DB_META.prepare("UPDATE shop_products SET badge=?2, updated_at=?3 WHERE id=?1").bind(id, badge, now));
  await env.DB_META.batch(stmts);
  await audit(env, a.uid, "shop_product_promote", id, { slots: uniq, badge });
  safeTrack(env, a.uid, "admin2_shop_product_promoted", { product_id: id, slots: uniq, badge });
  const [fresh, cols] = await Promise.all([loadProduct(env, id), allCollections(env)]);
  return json({ product: adminProduct(fresh!, new Map(cols.map((c) => [c.id, { slug: c.slug, name: c.name }])), uniq) });
});

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------
function collectionInput(b: Record<string, unknown>, partial: boolean): { v: { name?: string; blurb?: string; image_url?: string | null; active?: boolean; slug?: string }; errors: FieldError[] } {
  const v: { name?: string; blurb?: string; image_url?: string | null; active?: boolean; slug?: string } = {};
  const errors: FieldError[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  if (has("name") || !partial) {
    const n = String(b.name ?? "").replace(/\s+/g, " ").trim();
    if (n.length < 2 || n.length > 60) errors.push({ field: "name", message: "Name must be 2–60 characters." });
    else v.name = n;
  }
  if (has("slug") && b.slug) {
    const s = slugify(String(b.slug));
    if (!s) errors.push({ field: "slug", message: "Slug must contain letters or numbers." }); else v.slug = s;
  }
  if (has("blurb")) {
    const t = String(b.blurb ?? "").trim();
    if (t.length > 200) errors.push({ field: "blurb", message: "Keep the blurb under 200 characters." }); else v.blurb = t;
  }
  if (has("image_url")) {
    if (b.image_url === null || b.image_url === "") v.image_url = null;
    else if (!isValidImageUrl(b.image_url)) errors.push({ field: "image_url", message: "The image must be an uploaded https image (or a site /assets/ path)." });
    else v.image_url = String(b.image_url);
  }
  if (has("active")) {
    if (typeof b.active !== "boolean") errors.push({ field: "active", message: "Choose active or not." }); else v.active = b.active;
  }
  return { v, errors };
}

async function uniqueCollectionSlug(env: Env, base: string, selfId: string | null): Promise<string> {
  const root = base || "collection";
  for (let i = 0; i < 50; i++) {
    const cand = i === 0 ? root : `${root.slice(0, 55)}-${i + 1}`;
    const hit = await env.DB_META.prepare("SELECT id FROM shop_collections WHERE slug=?1").bind(cand).first<{ id: string }>();
    if (!hit || hit.id === selfId) return cand;
  }
  return `${root.slice(0, 50)}-${hex8()}`;
}

const collectionShape = (c: CollectionRow, count: number) => ({
  id: c.id, slug: c.slug, name: c.name, blurb: c.blurb, image_url: c.image_url, sort: Number(c.sort), active: !!c.active, count,
});

const listCollections = guarded("admin2.shop.collections.list", async (req, env) => {
  const [cols, counts] = await Promise.all([
    allCollections(env),
    env.DB_META.prepare("SELECT collection_id, COUNT(*) AS n FROM shop_products WHERE status<>'archived' AND collection_id IS NOT NULL GROUP BY collection_id")
      .all<{ collection_id: string; n: number }>(),
  ]);
  const m = new Map((counts.results ?? []).map((r) => [r.collection_id, Number(r.n)]));
  return json({ items: cols.map((c) => collectionShape(c, m.get(c.id) ?? 0)) }, 200, noStore);
});

const createCollection = guarded("admin2.shop.collections.create", async (req, env, a) => {
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the collection as JSON.");
  const { v, errors } = collectionInput(b, false);
  if (errors.length) return bad(errors, "invalid_collection");
  const slug = v.slug ? v.slug : await uniqueCollectionSlug(env, slugify(v.name!), null);
  if (v.slug) {
    const taken = await env.DB_META.prepare("SELECT id FROM shop_collections WHERE slug=?1").bind(slug).first();
    if (taken) return err(409, "slug_taken", "Another collection already uses that slug.", { field: "slug" });
  }
  const id = `col-${hex8()}`;
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO shop_collections (id, slug, name, blurb, image_url, sort, active, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,(SELECT COALESCE(MAX(sort),-1)+1 FROM shop_collections),1,?6,?6)`,
  ).bind(id, slug, v.name, v.blurb ?? "", v.image_url ?? null, now).run();
  await audit(env, a.uid, "shop_collection_create", id, { name: v.name });
  safeTrack(env, a.uid, "admin2_shop_collection_saved", { action: "create", collection_id: id });
  const row = await collectionExists(env, id);
  return json({ collection: collectionShape(row!, 0) }, 201);
});

const updateCollection = guarded("admin2.shop.collections.update", async (req, env, a, [id]) => {
  const row = await collectionExists(env, id);
  if (!row) return err(404, "not_found", "No such collection.");
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the changes as JSON.");
  const { v, errors } = collectionInput(b, true);
  if (errors.length) return bad(errors, "invalid_collection");
  let slug = row.slug;
  if (v.slug && v.slug !== row.slug) {
    const taken = await env.DB_META.prepare("SELECT id FROM shop_collections WHERE slug=?1 AND id<>?2").bind(v.slug, id).first();
    if (taken) return err(409, "slug_taken", "Another collection already uses that slug.", { field: "slug" });
    slug = v.slug;
  }
  const now = Date.now();
  await env.DB_META.prepare("UPDATE shop_collections SET slug=?2, name=?3, blurb=?4, image_url=?5, active=?6, updated_at=?7 WHERE id=?1")
    .bind(id, slug, v.name ?? row.name, v.blurb ?? row.blurb, v.image_url !== undefined ? v.image_url : row.image_url,
      v.active !== undefined ? (v.active ? 1 : 0) : row.active, now).run();
  await audit(env, a.uid, "shop_collection_update", id, { changes: Object.keys(v) });
  safeTrack(env, a.uid, "admin2_shop_collection_saved", { action: "update", collection_id: id });
  const fresh = await collectionExists(env, id);
  const n = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM shop_products WHERE collection_id=?1 AND status<>'archived'").bind(id).first<{ n: number }>();
  return json({ collection: collectionShape(fresh!, Number(n?.n ?? 0)) });
});

const deleteCollection = guarded("admin2.shop.collections.delete", async (req, env, a, [id]) => {
  const row = await collectionExists(env, id);
  if (!row) return err(404, "not_found", "No such collection.");
  const n = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM shop_products WHERE collection_id=?1 AND status<>'archived'").bind(id).first<{ n: number }>();
  if (Number(n?.n ?? 0) > 0) return err(409, "collection_not_empty", "Move or archive this collection's T-shirts first.", { count: Number(n?.n) });
  await env.DB_META.batch([
    env.DB_META.prepare("UPDATE shop_products SET collection_id=NULL WHERE collection_id=?1").bind(id), // archived rows only
    env.DB_META.prepare("DELETE FROM shop_collections WHERE id=?1").bind(id),
  ]);
  await audit(env, a.uid, "shop_collection_delete", id, { name: row.name });
  safeTrack(env, a.uid, "admin2_shop_collection_saved", { action: "delete", collection_id: id });
  return json({ ok: true, id });
});

const reorderCollections = guarded("admin2.shop.collections.reorder", async (req, env, a) => {
  const b = await readBody(req);
  const ids = b && Array.isArray(b.ids) ? b.ids.map(String) : null;
  if (!ids || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) return bad([{ field: "ids", message: "Send the collection ids in the new order." }]);
  const now = Date.now();
  await env.DB_META.batch(ids.map((id, i) => env.DB_META.prepare("UPDATE shop_collections SET sort=?2, updated_at=?3 WHERE id=?1").bind(id, i, now)));
  await audit(env, a.uid, "shop_collection_reorder", "all", { ids });
  safeTrack(env, a.uid, "admin2_shop_collection_saved", { action: "reorder", count: ids.length });
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------
const getSlots = guarded("admin2.shop.slots.get", async (req, env) => {
  const r = await env.DB_META.prepare("SELECT slot, product_id FROM shop_slots ORDER BY slot, sort ASC").all<{ slot: string; product_id: string }>();
  const slots: Record<string, string[]> = Object.fromEntries(SLOTS.map((s) => [s, [] as string[]]));
  for (const x of r.results ?? []) (slots[x.slot] ??= []).push(x.product_id);
  return json({ slots }, 200, noStore);
});

const putSlot = guarded("admin2.shop.slots.put", async (req, env, a, [slot]) => {
  if (!(SLOTS as readonly string[]).includes(slot)) return err(404, "not_found", "No such slot.");
  const b = await readBody(req);
  const ids = b && Array.isArray(b.product_ids) ? b.product_ids.map(String) : null;
  if (!ids || ids.length > 50 || new Set(ids).size !== ids.length) return bad([{ field: "product_ids", message: "Send up to 50 distinct product ids." }]);
  if (ids.length) {
    const r = await env.DB_META.prepare(
      `SELECT id FROM shop_products WHERE status<>'archived' AND id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
    ).bind(...ids).all<{ id: string }>();
    const found = new Set((r.results ?? []).map((x) => x.id));
    const missing = ids.filter((i) => !found.has(i));
    if (missing.length) return err(400, "unknown_product", "One of those products does not exist.", { field: "product_ids", missing });
  }
  const prev = await env.DB_META.prepare("SELECT product_id, until_at FROM shop_slots WHERE slot=?1").bind(slot).all<{ product_id: string; until_at: number | null }>();
  const until = new Map((prev.results ?? []).map((x) => [x.product_id, x.until_at]));
  const stmts = [env.DB_META.prepare("DELETE FROM shop_slots WHERE slot=?1").bind(slot)];
  ids.forEach((id, i) => stmts.push(env.DB_META.prepare("INSERT INTO shop_slots (slot, product_id, sort, until_at) VALUES (?1,?2,?3,?4)").bind(slot, id, i, until.get(id) ?? null)));
  await env.DB_META.batch(stmts);
  await audit(env, a.uid, "shop_slot_set", slot, { product_ids: ids });
  safeTrack(env, a.uid, "admin2_shop_product_promoted", { slot, count: ids.length });
  return json({ slot, product_ids: ids });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const SETTING_KEYS = ["hero", "featured_banner", "policy"] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

const DEFAULT_POLICY = { delivery_text: "5–8 days", report_window_hours: 48, print_partner: "Printrove", alerts_whatsapp: true };
const DEFAULT_HERO = {
  image_url: null, eyebrow: "", title: "", title_em: "", lead: "", cta_label: "", second_cta_collection: "",
  ticks: [] as string[], promise: [] as Array<{ title: string; sub: string }>, hotspots: [] as Array<{ product_id: string; x: number; y: number }>,
};
const DEFAULT_BANNER = { product_id: null, eyebrow: "", title: "", text: "", cta_label: "", image_url: null };

const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

async function validateSetting(env: Env, key: SettingKey, raw: unknown): Promise<{ value: unknown } | { errors: FieldError[] }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: [{ field: "value", message: "Send the settings as an object." }] };
  const o = raw as Record<string, unknown>;
  const errors: FieldError[] = [];
  const img = (field: string, v: unknown): string | null => {
    if (v === null || v === undefined || v === "") return null;
    if (!isValidImageUrl(v)) { errors.push({ field, message: "The image must be an uploaded https image (or a site /assets/ path)." }); return null; }
    return String(v);
  };
  const productExists = async (field: string, id: unknown): Promise<string | null> => {
    if (id === null || id === undefined || id === "") return null;
    const hit = typeof id === "string" ? await env.DB_META.prepare("SELECT id FROM shop_products WHERE id=?1 AND status<>'archived'").bind(id).first() : null;
    if (!hit) { errors.push({ field, message: "That product does not exist." }); return null; }
    return String(id);
  };

  if (key === "policy") {
    const hours = Number(o.report_window_hours ?? DEFAULT_POLICY.report_window_hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) errors.push({ field: "report_window_hours", message: "Report window must be 1–720 hours." });
    const delivery = str(o.delivery_text ?? DEFAULT_POLICY.delivery_text, 40);
    if (!delivery) errors.push({ field: "delivery_text", message: "Delivery text is required." });
    const partner = str(o.print_partner ?? DEFAULT_POLICY.print_partner, 40);
    if (!partner) errors.push({ field: "print_partner", message: "Print partner is required." });
    if (o.alerts_whatsapp !== undefined && typeof o.alerts_whatsapp !== "boolean") errors.push({ field: "alerts_whatsapp", message: "Choose on or off." });
    if (errors.length) return { errors };
    return { value: { delivery_text: delivery, report_window_hours: hours, print_partner: partner, alerts_whatsapp: o.alerts_whatsapp !== false } };
  }

  if (key === "featured_banner") {
    const product_id = await productExists("product_id", o.product_id);
    const out = {
      product_id, eyebrow: str(o.eyebrow, 60), title: str(o.title, 120), text: str(o.text, 300),
      cta_label: str(o.cta_label, 40), image_url: img("image_url", o.image_url),
    };
    return errors.length ? { errors } : { value: out };
  }

  // hero
  const ticks = Array.isArray(o.ticks) ? o.ticks.map((t) => str(t, 80)).filter(Boolean) : [];
  if (ticks.length > 6) errors.push({ field: "ticks", message: "Up to 6 ticks." });
  const promise = Array.isArray(o.promise)
    ? o.promise.map((p) => ({ title: str((p as Record<string, unknown>)?.title, 60), sub: str((p as Record<string, unknown>)?.sub, 120) })).filter((p) => p.title)
    : [];
  if (promise.length > 3) errors.push({ field: "promise", message: "Up to 3 promise items." });
  const hotspots: Array<{ product_id: string; x: number; y: number }> = [];
  if (Array.isArray(o.hotspots)) {
    if (o.hotspots.length > 8) errors.push({ field: "hotspots", message: "Up to 8 hotspots." });
    for (const h of o.hotspots.slice(0, 8)) {
      const r = (h ?? {}) as Record<string, unknown>;
      const x = Number(r.x), y = Number(r.y);
      const pid = await productExists("hotspots", r.product_id);
      if (!pid || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
        errors.push({ field: "hotspots", message: "Each hotspot needs a product and x/y between 0 and 100." });
        break;
      }
      hotspots.push({ product_id: pid, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    }
  }
  const out = {
    image_url: img("image_url", o.image_url), eyebrow: str(o.eyebrow, 60), title: str(o.title, 120), title_em: str(o.title_em, 60),
    lead: str(o.lead, 300), cta_label: str(o.cta_label, 40), second_cta_collection: str(o.second_cta_collection, 80),
    ticks, promise, hotspots,
  };
  return errors.length ? { errors } : { value: out };
}

const getSettings = guarded("admin2.shop.settings.get", async (req, env) => {
  const r = await env.DB_META.prepare("SELECT key, value_json FROM shop_settings").all<{ key: string; value_json: string }>();
  const m = new Map((r.results ?? []).map((x) => [x.key, x.value_json]));
  const read = <T>(k: string, fb: T): T => { try { const v = m.get(k) ? JSON.parse(m.get(k)!) : null; return v && typeof v === "object" ? { ...fb, ...v } : fb; } catch { return fb; } };
  return json({ hero: read("hero", DEFAULT_HERO), featured_banner: read("featured_banner", DEFAULT_BANNER), policy: read("policy", DEFAULT_POLICY) }, 200, noStore);
});

const putSetting = guarded("admin2.shop.settings.put", async (req, env, a, [key]) => {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) return err(404, "not_found", "No such setting.");
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the settings as JSON.");
  const res = await validateSetting(env, key as SettingKey, b.value);
  if ("errors" in res) return bad(res.errors, "invalid_setting");
  const now = Date.now();
  await env.DB_META.prepare(
    "INSERT INTO shop_settings (key, value_json, updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
  ).bind(key, JSON.stringify(res.value), now).run();
  await audit(env, a.uid, "shop_settings_save", key, {});
  safeTrack(env, a.uid, "admin2_shop_settings_saved", { key });
  return json({ key, value: res.value });
});

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------
const CODE_RE = /^[A-Z0-9_-]{3,20}$/;

function couponShape(c: CouponRow) {
  return {
    code: c.code, kind: c.kind, value: Number(c.value), min_order_rupees: Number(c.min_order_rupees), max_uses: c.max_uses === null ? null : Number(c.max_uses),
    used_count: Number(c.used_count), valid_until: c.valid_until === null ? null : Number(c.valid_until), active: !!c.active,
  };
}

function couponInput(b: Record<string, unknown>, partial: boolean): { v: Partial<{ kind: string; value: number; min_order_rupees: number; max_uses: number | null; valid_until: number | null; active: boolean }>; errors: FieldError[] } {
  const v: Partial<{ kind: string; value: number; min_order_rupees: number; max_uses: number | null; valid_until: number | null; active: boolean }> = {};
  const errors: FieldError[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  if (has("kind") || !partial) {
    if (b.kind !== "pct" && b.kind !== "flat") errors.push({ field: "kind", message: "Kind must be pct or flat." }); else v.kind = b.kind;
  }
  if (has("value") || !partial) {
    const n = Number(b.value);
    const kind = (v.kind ?? b.kind) as string | undefined;
    const max = kind === "pct" ? 100 : 100_000;
    if (!Number.isInteger(n) || n < 1 || n > max) errors.push({ field: "value", message: kind === "pct" ? "Percent must be 1–100." : "Amount must be a whole number of rupees." });
    else v.value = n;
  }
  if (has("min_order_rupees")) {
    const n = Number(b.min_order_rupees);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) errors.push({ field: "min_order_rupees", message: "Minimum order must be a whole number of rupees." }); else v.min_order_rupees = n;
  }
  if (has("max_uses")) {
    if (b.max_uses === null || b.max_uses === "") v.max_uses = null;
    else {
      const n = Number(b.max_uses);
      if (!Number.isInteger(n) || n < 1 || n > 1_000_000) errors.push({ field: "max_uses", message: "Max uses must be a whole number, or empty for unlimited." }); else v.max_uses = n;
    }
  }
  if (has("valid_until")) {
    if (b.valid_until === null || b.valid_until === "") v.valid_until = null;
    else {
      const n = Number(b.valid_until);
      if (!Number.isFinite(n) || n <= 0) errors.push({ field: "valid_until", message: "Valid-until must be a valid date." }); else v.valid_until = Math.trunc(n);
    }
  }
  if (has("active")) {
    if (typeof b.active !== "boolean") errors.push({ field: "active", message: "Choose active or not." }); else v.active = b.active;
  }
  return { v, errors };
}

const listCoupons = guarded("admin2.shop.coupons.list", async (req, env) => {
  const r = await env.DB_META.prepare("SELECT * FROM shop_coupons ORDER BY created_at DESC").all<CouponRow>();
  return json({ items: (r.results ?? []).map(couponShape) }, 200, noStore);
});

const createCoupon = guarded("admin2.shop.coupons.create", async (req, env, a) => {
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the coupon as JSON.");
  const code = String(b.code ?? "").trim().toUpperCase();
  if (!CODE_RE.test(code)) return bad([{ field: "code", message: "Code must be 3–20 letters, numbers, - or _." }], "invalid_coupon");
  const { v, errors } = couponInput(b, false);
  if (errors.length) return bad(errors, "invalid_coupon");
  const exists = await env.DB_META.prepare("SELECT code FROM shop_coupons WHERE code=?1").bind(code).first();
  if (exists) return err(409, "coupon_exists", "That code already exists.", { field: "code" });
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO shop_coupons (code, kind, value, min_order_rupees, max_uses, used_count, valid_until, active, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,0,?6,?7,?8,?8)`,
  ).bind(code, v.kind, v.value, v.min_order_rupees ?? 0, v.max_uses ?? null, v.valid_until ?? null, v.active === false ? 0 : 1, now).run();
  await audit(env, a.uid, "shop_coupon_create", code, { kind: v.kind, value: v.value });
  safeTrack(env, a.uid, "admin2_shop_coupon_saved", { action: "create", code });
  const row = await env.DB_META.prepare("SELECT * FROM shop_coupons WHERE code=?1").bind(code).first<CouponRow>();
  return json({ coupon: couponShape(row!) }, 201);
});

const updateCoupon = guarded("admin2.shop.coupons.update", async (req, env, a, [rawCode]) => {
  const code = rawCode.trim().toUpperCase();
  const row = await env.DB_META.prepare("SELECT * FROM shop_coupons WHERE code=?1").bind(code).first<CouponRow>();
  if (!row) return err(404, "not_found", "No such coupon.");
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the changes as JSON.");
  const { v, errors } = couponInput({ kind: row.kind, ...b }, true);
  if (errors.length) return bad(errors, "invalid_coupon");
  const next = {
    kind: v.kind ?? row.kind,
    value: v.value ?? Number(row.value),
    min_order_rupees: v.min_order_rupees ?? Number(row.min_order_rupees),
    max_uses: v.max_uses !== undefined ? v.max_uses : row.max_uses,
    valid_until: v.valid_until !== undefined ? v.valid_until : row.valid_until,
    active: v.active !== undefined ? (v.active ? 1 : 0) : Number(row.active),
  };
  if (next.kind === "pct" && next.value > 100) return bad([{ field: "value", message: "Percent must be 1–100." }], "invalid_coupon");
  await env.DB_META.prepare("UPDATE shop_coupons SET kind=?2, value=?3, min_order_rupees=?4, max_uses=?5, valid_until=?6, active=?7, updated_at=?8 WHERE code=?1")
    .bind(code, next.kind, next.value, next.min_order_rupees, next.max_uses, next.valid_until, next.active, Date.now()).run();
  await audit(env, a.uid, "shop_coupon_update", code, { changes: Object.keys(v) });
  safeTrack(env, a.uid, "admin2_shop_coupon_saved", { action: "update", code });
  const fresh = await env.DB_META.prepare("SELECT * FROM shop_coupons WHERE code=?1").bind(code).first<CouponRow>();
  return json({ coupon: couponShape(fresh!) });
});

// ---------------------------------------------------------------------------
// Route table — spread into ADMIN2_ROUTES in routes/admin2.ts
// ---------------------------------------------------------------------------
const ID = "([^/]+)";
const re = (suffix: string) => new RegExp(`^${BASE}/${suffix}$`);

export const ADMIN2_SHOP_CATALOG_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: `${BASE}/products`, handler: listProducts },
  { method: "POST", path: `${BASE}/products`, handler: createProduct },
  { method: "GET", path: re(`products/${ID}`), handler: getProduct },
  { method: "PUT", path: re(`products/${ID}`), handler: updateProduct },
  { method: "DELETE", path: re(`products/${ID}`), handler: archiveProduct },
  { method: "POST", path: re(`products/${ID}/restore`), handler: restoreProduct },
  { method: "PUT", path: re(`products/${ID}/promote`), handler: promoteProduct },
  { method: "GET", path: `${BASE}/collections`, handler: listCollections },
  { method: "POST", path: `${BASE}/collections`, handler: createCollection },
  { method: "POST", path: `${BASE}/collections/reorder`, handler: reorderCollections },
  { method: "PUT", path: re(`collections/${ID}`), handler: updateCollection },
  { method: "DELETE", path: re(`collections/${ID}`), handler: deleteCollection },
  { method: "GET", path: `${BASE}/slots`, handler: getSlots },
  { method: "PUT", path: re(`slots/${ID}`), handler: putSlot },
  { method: "GET", path: `${BASE}/settings`, handler: getSettings },
  { method: "PUT", path: re(`settings/${ID}`), handler: putSetting },
  { method: "GET", path: `${BASE}/coupons`, handler: listCoupons },
  { method: "POST", path: `${BASE}/coupons`, handler: createCoupon },
  { method: "PUT", path: re(`coupons/${ID}`), handler: updateCoupon },
];
