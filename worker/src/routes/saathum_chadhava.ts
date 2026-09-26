// [SAATHUM-CHADHAVA 2026-09-26] The chadhava product catalogue (admin-managed).
// Contract: Specs/SPEC-2026-09-26-SAATHUM-CHECKOUT.md ("Data" / "HTTP contract").
// Migration: worker/migrations/2026-09-26-saathum-chadhava.sql (table saathum_chadhava).
//
//   GET    /api/saathum/chadhava              PUBLIC — active items, sorted (A1 registers
//                                              this export in index.ts; not done here).
//   GET    /api/admin/v2/chadhava              admin — every item, incl. inactive
//   POST   /api/admin/v2/chadhava              admin — create
//   PUT    /api/admin/v2/chadhava/:id          admin — edit
//   DELETE /api/admin/v2/chadhava/:id          admin — soft delete (active=0). A product
//                                              already frozen into a past checkout's quote
//                                              JSON keeps its own row either way, so nothing
//                                              is hard-deleted (routes/admin2.ts, "chadhava
//                                              (agent A2)" section registers the admin routes).
import type { Env } from "../types";
import { json } from "../util";
import type { Admin2RouteDef } from "./admin2";
import { requireAdmin } from "./admin_money";
import { track, trackException } from "../hooks";

const APP = "saathum";

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);

type Admin = { uid: string };

async function admin(req: Request, env: Env): Promise<Admin | Response> {
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

async function readBody(req: Request, max = 16_384): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > max) return null;
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Shape + validation
// ---------------------------------------------------------------------------

export interface ChadhavaRow {
  id: string;
  title: string;
  description: string | null;
  price_rupees: number;
  image_url: string | null;
  active: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface ChadhavaPublic { id: string; title: string; description: string | null; price_rupees: number; image_url: string | null }
export interface ChadhavaAdmin extends ChadhavaPublic { active: boolean; sort: number; updated_at: number }

const LIMITS = { titleMin: 2, titleMax: 80, descriptionMax: 300, priceMin: 1, priceMax: 100_000 } as const;

function shapePublic(r: ChadhavaRow): ChadhavaPublic {
  return { id: r.id, title: r.title, description: r.description ?? null, price_rupees: Number(r.price_rupees), image_url: r.image_url ?? null };
}

function shapeAdmin(r: ChadhavaRow): ChadhavaAdmin {
  return { ...shapePublic(r), active: !!r.active, sort: Number(r.sort ?? 0), updated_at: Number(r.updated_at ?? 0) };
}

/** An https image URL (the /upload/public result), or a site-relative /assets/ path (the seeded photos). */
function isValidImageUrl(v: unknown): v is string {
  if (typeof v !== "string" || !v || v.length > 500) return false;
  if (v.startsWith("/assets/")) return true;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}

type Patch = { title?: string; description?: string | null; price_rupees?: number; image_url?: string | null; active?: boolean; sort?: number };
type FieldError = { field: string; message: string };

function normalize(body: Record<string, unknown>, opts: { partial: boolean }): { patch: Patch; errors: FieldError[] } {
  const patch: Patch = {};
  const errors: FieldError[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const want = (k: string) => has(k) || !opts.partial;

  if (want("title")) {
    const t = String(body.title ?? "").replace(/\s+/g, " ").trim();
    if (t.length < LIMITS.titleMin || t.length > LIMITS.titleMax) {
      errors.push({ field: "title", message: `Title must be ${LIMITS.titleMin}–${LIMITS.titleMax} characters.` });
    } else patch.title = t;
  }
  if (has("description")) {
    const d = String(body.description ?? "").trim();
    if (d.length > LIMITS.descriptionMax) errors.push({ field: "description", message: `Keep the description under ${LIMITS.descriptionMax} characters.` });
    else patch.description = d || null;
  }
  if (want("price_rupees")) {
    const p = Number(body.price_rupees);
    if (!Number.isInteger(p) || p < LIMITS.priceMin || p > LIMITS.priceMax) {
      errors.push({ field: "price_rupees", message: `Price must be a whole number of rupees, ₹${LIMITS.priceMin}–₹${LIMITS.priceMax.toLocaleString("en-IN")}.` });
    } else patch.price_rupees = p;
  }
  if (has("image_url")) {
    if (body.image_url === null || body.image_url === "") patch.image_url = null;
    else if (!isValidImageUrl(body.image_url)) errors.push({ field: "image_url", message: "The image must be an uploaded https image (or a site /assets/ path)." });
    else patch.image_url = String(body.image_url);
  }
  if (has("active")) {
    if (typeof body.active !== "boolean") errors.push({ field: "active", message: "Choose active or not." });
    else patch.active = body.active;
  }
  if (has("sort")) {
    const s = Number(body.sort);
    if (!Number.isInteger(s)) errors.push({ field: "sort", message: "Sort must be a whole number." });
    else patch.sort = s;
  }
  return { patch, errors };
}

// ---------------------------------------------------------------------------
// Public — GET /api/saathum/chadhava
// ---------------------------------------------------------------------------

/** Active chadhava products, sorted (sort, title). Public, short-cached. Every event offers all of them. */
export async function saathumChadhavaPublic(req: Request, env: Env): Promise<Response> {
  try {
    const rows = await env.DB_META.prepare(
      "SELECT id, title, description, price_rupees, image_url, active, sort, created_at, updated_at FROM saathum_chadhava WHERE active=1 ORDER BY sort ASC, title ASC",
    ).all<ChadhavaRow>();
    return json({ items: (rows.results ?? []).map(shapePublic) }, 200, { "cache-control": "public, max-age=60, s-maxage=60" });
  } catch (e) {
    await trackException(env, e, { route: "saathum_chadhava.public", handled: true, app_name: APP });
    return err(500, "internal", "Could not load the chadhava list.");
  }
}

// ---------------------------------------------------------------------------
// Admin CRUD — /api/admin/v2/chadhava
// ---------------------------------------------------------------------------

export async function adminChadhavaList(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const rows = await env.DB_META.prepare(
    "SELECT id, title, description, price_rupees, image_url, active, sort, created_at, updated_at FROM saathum_chadhava ORDER BY sort ASC, title ASC",
  ).all<ChadhavaRow>();
  return json({ items: (rows.results ?? []).map(shapeAdmin) }, 200, { "cache-control": "private, no-store" });
}

export async function adminChadhavaCreate(req: Request, env: Env): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the product as JSON.");
  const { patch, errors } = normalize(b, { partial: false });
  if (errors.length) return err(400, "invalid_chadhava", errors[0].message, { field: errors[0].field, errors });
  const id = `chadhava-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO saathum_chadhava (id, title, description, price_rupees, image_url, active, sort, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,1,?6,?7,?7)`,
  ).bind(id, patch.title, patch.description ?? null, patch.price_rupees, patch.image_url ?? null, patch.sort ?? 0, now).run();
  await audit(env, a.uid, "chadhava_create", id, { title: patch.title, price_rupees: patch.price_rupees });
  safeTrack(env, a.uid, "admin2_chadhava_saved", { action: "create", id });
  const row = await env.DB_META.prepare("SELECT * FROM saathum_chadhava WHERE id=?1").bind(id).first<ChadhavaRow>();
  return json({ ok: true, item: row ? shapeAdmin(row) : null }, 201);
}

async function loadRow(env: Env, id: string): Promise<ChadhavaRow | null> {
  if (!id || id.length > 200) return null;
  return env.DB_META.prepare("SELECT * FROM saathum_chadhava WHERE id=?1").bind(id).first<ChadhavaRow>();
}

export async function adminChadhavaUpdate(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const row = await loadRow(env, id);
  if (!row) return err(404, "not_found", "No such product.");
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the changes as JSON.");
  const { patch, errors } = normalize(b, { partial: true });
  if (errors.length) return err(400, "invalid_chadhava", errors[0].message, { field: errors[0].field, errors });
  if (!Object.keys(patch).length) return json({ ok: true, item: shapeAdmin(row) });
  const next: ChadhavaRow = {
    ...row,
    title: patch.title ?? row.title,
    description: "description" in patch ? patch.description ?? null : row.description,
    price_rupees: patch.price_rupees ?? row.price_rupees,
    image_url: "image_url" in patch ? patch.image_url ?? null : row.image_url,
    active: "active" in patch ? (patch.active ? 1 : 0) : row.active,
    sort: patch.sort ?? row.sort,
    updated_at: Date.now(),
  };
  await env.DB_META.prepare(
    "UPDATE saathum_chadhava SET title=?2, description=?3, price_rupees=?4, image_url=?5, active=?6, sort=?7, updated_at=?8 WHERE id=?1",
  ).bind(id, next.title, next.description, next.price_rupees, next.image_url, next.active, next.sort, next.updated_at).run();
  await audit(env, a.uid, "chadhava_update", id, { changes: patch });
  safeTrack(env, a.uid, "admin2_chadhava_saved", { action: "update", id });
  return json({ ok: true, item: shapeAdmin(next) });
}

/** Soft delete: active=0. A product already frozen into a past checkout's quote JSON is unaffected. */
export async function adminChadhavaDelete(req: Request, env: Env, id: string): Promise<Response> {
  const a = await admin(req, env); if (a instanceof Response) return a;
  const row = await loadRow(env, id);
  if (!row) return err(404, "not_found", "No such product.");
  if (!row.active) return json({ ok: true, item: shapeAdmin(row), already: true });
  const now = Date.now();
  await env.DB_META.prepare("UPDATE saathum_chadhava SET active=0, updated_at=?2 WHERE id=?1").bind(id, now).run();
  await audit(env, a.uid, "chadhava_delete", id, { title: row.title });
  safeTrack(env, a.uid, "admin2_chadhava_saved", { action: "delete", id });
  return json({ ok: true, item: shapeAdmin({ ...row, active: 0, updated_at: now }) });
}

// ---------------------------------------------------------------------------
// Route table — spread into ADMIN2_ROUTES in routes/admin2.ts ("chadhava (agent A2)").
// ---------------------------------------------------------------------------
const ID = "([^/]+)";
export const ADMIN2_CHADHAVA_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: "/api/admin/v2/chadhava", handler: (req, env) => adminChadhavaList(req, env) },
  { method: "POST", path: "/api/admin/v2/chadhava", handler: (req, env) => adminChadhavaCreate(req, env) },
  { method: "PUT", path: new RegExp(`^/api/admin/v2/chadhava/${ID}$`), handler: (req, env, [id]) => adminChadhavaUpdate(req, env, id) },
  { method: "DELETE", path: new RegExp(`^/api/admin/v2/chadhava/${ID}$`), handler: (req, env, [id]) => adminChadhavaDelete(req, env, id) },
];
