// Marketplace verticals + category taxonomy.
// Spec: Specs/PLAN-2026-07-17-ai-listing-creation-DRAFT.md §2.0, §2.2, §2.3, §2.4.
// Tables in DB_META (avatok-meta): listing_categories, listing_category_versions,
// marketplace_verticals, listings.
//
// The core idea (§0.1): a CATEGORY IS DATA. A category row carries its own field
// schema, its own agent playbook and its own detail-template id, so adding "Boats
// for sale" is a D1 insert, not a Play release. A VERTICAL is the same idea one
// level up (§2.0) — commerce and connect are two row-sets on one engine, and
// `vertical` is a filter on every query. A listing never crosses verticals.
//
// ROUTES TO REGISTER (index.ts — I do not wire these; the owner does):
//
//   GET /api/marketplace/categories?vertical=commerce      PUBLIC (guests browse)
//     → cached(req, ctx, () => marketplaceCategories(req, env), 300)
//       Matches the /api/explore/categories precedent (index.ts:1041, 300s). The
//       Cache API keys on the full URL, so ?vertical=connect caches separately.
//
//   GET /api/marketplace/categories/proposed?vertical=&limit=   ADMIN ONLY
//     → proposedCategories(req, env)
//       NOT cached — it is an admin queue, and requireAdmin reads the bearer.
//
// NOT A ROUTE (server-internal, imported by the agent runtime + compose loop):
//   resolveCategoryVersion(env, category, pinned)  — §2.4 version resolution
//   validateAttrs(field_schema, attrs)             — pure, no DB
//
// WHY agent_playbook IS NOT IN THE PUBLIC RESPONSE
// -----------------------------------------------
// `agent_playbook` is seller-mandate-adjacent server config: it is the instruction
// set that decides how hard a seller's agent negotiates. Shipping it to the client
// hands every buyer the seller's price floor and tactics before they open the chat.
// It is deliberately absent from CAT_PUBLIC_COLS and must stay absent. `field_schema`
// IS returned — the compose chat needs it to know what to ask.
import type { Env } from "../types";
import { json } from "../util";
import { metaSession } from "../db/shard";
import { requireAdmin } from "./admin_money"; // uid ∈ ADMIN_UIDS — the existing gate

export const DEFAULT_VERTICAL = "commerce";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** The five intents (§2). Every category is one intent + a field schema. */
export type ListingIntent = "SELL" | "RENT" | "BOOK" | "LEAD" | "PROFILE";

export type FieldType = "string" | "text" | "int" | "number" | "bool" | "enum" | "multi" | "date";

/** One field in a category's `field_schema` JSON (§2.2). */
export interface CategoryField {
  k: string;
  label?: string;
  type?: FieldType;
  required?: boolean;
  ask?: string;
  options?: string[];
  unit?: string[];
  min?: number;
  max?: number;
  maxLen?: number;
}

/** The `field_schema` column, parsed. */
export interface FieldSchema {
  fields?: CategoryField[];
  min_required?: string[];
}

/** One violation from validateAttrs. `k` is the attrs key at fault. */
export interface AttrViolation {
  k: string;
  code: "required" | "type" | "enum" | "range" | "length";
  detail: string;
}

export interface AttrsValidation {
  ok: boolean;
  violations: AttrViolation[];
  /** Keys in `min_required` that `attrs` does not satisfy — the compose loop's
   *  "what must I still ask before this can publish". */
  missing: string[];
  /** Keys present in `attrs` with no field in `field_schema`. Informational, NEVER
   *  a violation — §2.4: "removing a field from field_schema doesn't delete it from
   *  attrs — old listings keep rendering". Failing these would break every listing
   *  pinned to an older cat_version the moment a category drops a field. */
  unknown_keys: string[];
}

/** A category resolved AT A PINNED VERSION (§2.4). Never "latest". */
export interface ResolvedCategory {
  category: string;
  version: number;
  field_schema: FieldSchema | null;
  agent_playbook: unknown | null;
  detail_template: string | null;
  /** Where the row actually came from. `live_row` means no version row existed for
   *  `version` and we fell back — useful in telemetry when a pin goes stale. */
  resolved_from: "version_row" | "live_row";
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Verticals are row ids ('commerce' | 'connect'), never free text from a client.
 *  Sanitized to a conservative charset so the value can never reach SQL as anything
 *  but a plain bind (it is bound anyway — this is belt and braces). Anything that
 *  doesn't look like an id falls back to commerce, which keeps existing callers
 *  (who send no ?vertical at all) on exactly today's behaviour. */
function normVertical(raw: string | null): string {
  const v = String(raw ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,31}$/.test(v) ? v : DEFAULT_VERTICAL;
}

// The public projection. agent_playbook is deliberately NOT here (see header).
const CAT_PUBLIC_COLS = `id, label, emoji, sort, vertical, intent, field_schema,
  detail_template, price_semantics, cat_version, playbook_version, template_version`;

// Pre-migration shape (listings.sql:6). The `2026-07-18-marketplace-verticals.sql`
// migration is landing concurrently; until it does, the extended SELECT above throws
// on the missing columns and would take the PUBLIC browse down with it. Same defensive
// posture as favoritesFor() in listings.ts ("table may not be migrated yet").
const CAT_LEGACY_COLS = `id, label, emoji, sort`;

function shapeCategory(r: any) {
  return {
    id: String(r.id),
    label: r.label ?? null,
    emoji: r.emoji ?? null,
    sort: Number(r.sort ?? 0),
    vertical: r.vertical ?? DEFAULT_VERTICAL,
    intent: (r.intent ?? "SELL") as ListingIntent,
    // The compose chat needs the schema to know what to ask (§3.2).
    field_schema: parseJson<FieldSchema | null>(r.field_schema, null),
    detail_template: r.detail_template ?? null,
    price_semantics: r.price_semantics ?? null,
    // The versions a listing born right now would pin (§2.4).
    cat_version: Number(r.cat_version ?? 1),
    playbook_version: Number(r.playbook_version ?? 1),
    template_version: Number(r.template_version ?? 1),
  };
}

// ---------------------------------------------------------------------------
// 1. GET /api/marketplace/categories?vertical=commerce — PUBLIC, no auth
// ---------------------------------------------------------------------------

/**
 * Active categories for a vertical, with the intent/template/versions the compose
 * chat and the detail page need. PUBLIC: guests browse (the A3 precedent — every
 * /api/explore read is unauthenticated), so there is no requireUser here by design.
 *
 * `vertical` defaults to 'commerce' when absent, so existing callers are unaffected.
 */
export async function marketplaceCategories(req: Request, env: Env): Promise<Response> {
  const vertical = normVertical(new URL(req.url).searchParams.get("vertical"));
  try {
    const rs = await metaSession(env).prepare(
      `SELECT ${CAT_PUBLIC_COLS} FROM listing_categories
        WHERE active=1 AND vertical=?1 ORDER BY sort, id`,
    ).bind(vertical).all();
    return json({ vertical, categories: ((rs.results ?? []) as any[]).map(shapeCategory) });
  } catch {
    // Pre-migration fallback: serve the legacy taxonomy, which is entirely commerce
    // (`vertical` defaults to 'commerce' in the migration). A connect request before
    // the migration correctly returns nothing rather than leaking commerce rows into
    // the other vertical — a listing never crosses verticals (§2.0).
    if (vertical !== DEFAULT_VERTICAL) return json({ vertical, categories: [] });
    const rs = await metaSession(env).prepare(
      `SELECT ${CAT_LEGACY_COLS} FROM listing_categories WHERE active=1 ORDER BY sort, id`,
    ).all();
    return json({ vertical, categories: ((rs.results ?? []) as any[]).map(shapeCategory) });
  }
}

// ---------------------------------------------------------------------------
// 2. Version resolution (§2.4)
// ---------------------------------------------------------------------------

/**
 * Resolve a category AT THE VERSION A LISTING PINNED — the function the agent
 * runtime (buildAgentContext) and the compose loop call.
 *
 * §2.4, and this is the whole point of the function: **a listing renders and
 * negotiates at its pinned version, ALWAYS. Never "latest".** A seller published a
 * flat in July under a given playbook; if an admin tightens that playbook in
 * September, the seller's agent must not start negotiating differently on their
 * behalf under rules they never saw. So we read `listing_category_versions` at the
 * exact `version` passed in.
 *
 * Fallback is the LIVE ROW, never MAX(version). If no version row exists for the
 * pin, "latest" would be precisely the silent behaviour change this pinning exists
 * to prevent — but the live row is the only other thing that can be true (it is
 * what version 1 was born as, before anyone versioned anything), and returning null
 * would break rendering for every listing created before the migration. The caller
 * can tell the two apart via `resolved_from`.
 *
 * @param version the listing's pinned cat_version/playbook_version. Callers that
 *                genuinely want current config (the admin editor) should read the
 *                live row directly rather than pass a sentinel here.
 */
export async function resolveCategoryVersion(
  env: Env, category: string, version: number,
): Promise<ResolvedCategory | null> {
  const cat = String(category ?? "").trim();
  if (!cat) return null;
  const v = Math.max(1, Math.trunc(Number(version) || 1));

  // 1) The pinned version row — the authoritative answer.
  try {
    const row = await metaSession(env).prepare(
      `SELECT field_schema, agent_playbook, detail_template
         FROM listing_category_versions WHERE category=?1 AND version=?2`,
    ).bind(cat, v).first<any>();
    if (row) {
      return {
        category: cat,
        version: v,
        field_schema: parseJson<FieldSchema | null>(row.field_schema, null),
        agent_playbook: parseJson<unknown | null>(row.agent_playbook, null),
        detail_template: row.detail_template ?? null,
        resolved_from: "version_row",
      };
    }
  } catch { /* table not migrated yet — fall through to the live row */ }

  // 2) No version row → the live row. NOT MAX(version).
  try {
    const row = await metaSession(env).prepare(
      `SELECT field_schema, agent_playbook, detail_template
         FROM listing_categories WHERE id=?1`,
    ).bind(cat).first<any>();
    if (!row) return null;
    return {
      category: cat,
      version: v,
      field_schema: parseJson<FieldSchema | null>(row.field_schema, null),
      agent_playbook: parseJson<unknown | null>(row.agent_playbook, null),
      detail_template: row.detail_template ?? null,
      resolved_from: "live_row",
    };
  } catch {
    return null; // columns not migrated yet
  }
}

// ---------------------------------------------------------------------------
// 3. GET /api/marketplace/categories/proposed — ADMIN ONLY (§2.3)
// ---------------------------------------------------------------------------

/**
 * The proposal queue: the AI proposes a category, a human approves.
 *
 * §2.3 — an LLM inventing categories at runtime creates an unbounded, unmoderated
 * taxonomy that fragments search within a week. So when nothing fits, the compose
 * AI picks the closest intent, files the listing under `category='other'` with a
 * `proposed_category` string, and **the listing publishes normally — the user is
 * never blocked**. This endpoint is the other half of that bargain: it aggregates
 * those proposals by volume so an admin can see what people are actually trying to
 * list. Promoting one to a real category is one INSERT (§0.1: category = data).
 *
 * Grouped case-insensitively on the trimmed string, because "Boats", "boats " and
 * "BOATS" are one proposal and three rows would hide the signal that they're the
 * top request.
 *
 * Admin gate: requireAdmin (uid ∈ ADMIN_UIDS) — the same gate as /api/admin/config
 * and the money console. Not a new scheme.
 */
export async function proposedCategories(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env);
  if (a instanceof Response) return a;
  const u = new URL(req.url).searchParams;
  const vertical = normVertical(u.get("vertical"));
  const limit = Math.min(200, Math.max(1, Number(u.get("limit") || 100)));

  try {
    const rs = await metaSession(env).prepare(
      `SELECT LOWER(TRIM(proposed_category))        AS key,
              MIN(TRIM(proposed_category))          AS proposed_category,
              COUNT(*)                              AS listing_count,
              COUNT(DISTINCT creator_id)            AS seller_count,
              MIN(created_at)                       AS first_seen,
              MAX(created_at)                       AS last_seen,
              GROUP_CONCAT(id)                      AS sample_ids
         FROM listings
        WHERE proposed_category IS NOT NULL
          AND TRIM(proposed_category) <> ''
          AND vertical=?1
        GROUP BY LOWER(TRIM(proposed_category))
        ORDER BY listing_count DESC, last_seen DESC
        LIMIT ?2`,
    ).bind(vertical, limit).all();

    const proposals = ((rs.results ?? []) as any[]).map((r) => ({
      proposed_category: String(r.proposed_category ?? ""),
      vertical,
      listing_count: Number(r.listing_count ?? 0),
      seller_count: Number(r.seller_count ?? 0),
      first_seen: r.first_seen != null ? Number(r.first_seen) : null,
      last_seen: r.last_seen != null ? Number(r.last_seen) : null,
      // GROUP_CONCAT has no LIMIT in SQLite — cap in JS so a popular proposal can't
      // return a multi-megabyte id blob to the admin console.
      sample_listing_ids: String(r.sample_ids ?? "").split(",").filter(Boolean).slice(0, 5),
    }));
    return json({ vertical, proposals });
  } catch (e: any) {
    // proposed_category / vertical not migrated yet.
    return json({ vertical, proposals: [], detail: String(e?.message ?? e) });
  }
}

// ---------------------------------------------------------------------------
// 4. validateAttrs — pure, no DB (§2.2)
// ---------------------------------------------------------------------------

const isBlank = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0);

/** Tolerant numeric coercion. `attrs` is filled by an LLM calling tools, so "3" for
 *  an int is the common case, not an error — reject only what can't be a number. */
function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 0 || v === 1) return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes" || s === "1") return true;
    if (s === "false" || s === "no" || s === "0") return false;
  }
  return null;
}

function checkOne(f: CategoryField, v: unknown, out: AttrViolation[]): void {
  const k = f.k;
  const type: FieldType = f.type ?? "string";
  const push = (code: AttrViolation["code"], detail: string) => out.push({ k, code, detail });

  const range = (n: number) => {
    if (typeof f.min === "number" && n < f.min) push("range", `${k} must be >= ${f.min}`);
    if (typeof f.max === "number" && n > f.max) push("range", `${k} must be <= ${f.max}`);
  };

  switch (type) {
    case "int": {
      const n = toNum(v);
      if (n === null) { push("type", `${k} must be a whole number`); return; }
      if (!Number.isInteger(n)) { push("type", `${k} must be a whole number, got ${n}`); return; }
      range(n);
      return;
    }
    case "number": {
      const n = toNum(v);
      if (n === null) { push("type", `${k} must be a number`); return; }
      range(n);
      return;
    }
    case "bool": {
      if (toBool(v) === null) push("type", `${k} must be true or false`);
      return;
    }
    case "enum": {
      const opts = Array.isArray(f.options) ? f.options : [];
      if (typeof v !== "string") { push("type", `${k} must be one of: ${opts.join(", ")}`); return; }
      // Case-insensitive: an LLM writes "freehold" for the option "Freehold".
      if (opts.length && !opts.some((o) => String(o).toLowerCase() === v.trim().toLowerCase())) {
        push("enum", `${k}="${v}" is not one of: ${opts.join(", ")}`);
      }
      return;
    }
    case "multi": {
      if (!Array.isArray(v)) { push("type", `${k} must be a list`); return; }
      const opts = Array.isArray(f.options) ? f.options : [];
      if (!opts.length) return;
      const lc = opts.map((o) => String(o).toLowerCase());
      for (const item of v) {
        if (typeof item !== "string" || !lc.includes(item.trim().toLowerCase())) {
          push("enum", `${k} contains "${String(item)}", not one of: ${opts.join(", ")}`);
        }
      }
      return;
    }
    case "date": {
      if (typeof v === "number" && Number.isFinite(v)) return;   // epoch ms
      if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return;
      push("type", `${k} must be a date`);
      return;
    }
    case "string":
    case "text":
    default: {
      if (typeof v !== "string") { push("type", `${k} must be text`); return; }
      if (typeof f.maxLen === "number" && v.length > f.maxLen) {
        push("length", `${k} must be at most ${f.maxLen} characters`);
      }
      return;
    }
  }
}

/**
 * Type/enum/range check a listing's `attrs` against its category's `field_schema`.
 * PURE — no DB, no env, no I/O. Callers pass the schema they already resolved (at
 * the listing's PINNED version, via resolveCategoryVersion — validating new answers
 * against a newer schema than the listing pinned would re-introduce exactly the
 * silent drift §2.4 exists to stop).
 *
 * Two deliberate asymmetries, both from the spec:
 *
 * - **Unknown keys are not violations.** §2.4: a schema bump must not orphan data —
 *   removing a field from `field_schema` doesn't delete it from `attrs`. They come
 *   back as `unknown_keys` for telemetry only.
 * - **`missing` and `required` are different questions.** `missing` is the subset of
 *   `min_required` that isn't answered — the compose loop's "what do I still have to
 *   ask before this can publish". A field marked `required:true` that's absent is
 *   reported as a `required` VIOLATION. A schema can mark ten fields required while
 *   only two are `min_required`; conflating them would either block publish on all
 *   ten or silently stop enforcing the other eight.
 *
 * A null/absent schema validates anything (`ok:true`) — a category with no schema
 * yet must not block its own listings.
 */
export function validateAttrs(
  field_schema: FieldSchema | null | undefined,
  attrs: Record<string, unknown> | null | undefined,
): AttrsValidation {
  const a: Record<string, unknown> =
    attrs && typeof attrs === "object" && !Array.isArray(attrs) ? attrs : {};
  const fields = Array.isArray(field_schema?.fields) ? field_schema!.fields! : [];
  const violations: AttrViolation[] = [];

  const known = new Set<string>();
  for (const f of fields) {
    if (!f || typeof f.k !== "string" || !f.k) continue;
    known.add(f.k);
    const v = a[f.k];
    if (isBlank(v)) {
      if (f.required) violations.push({ k: f.k, code: "required", detail: `${f.k} is required` });
      continue; // absent-and-optional is fine; don't type-check undefined
    }
    checkOne(f, v, violations);
  }

  const minReq = Array.isArray(field_schema?.min_required) ? field_schema!.min_required! : [];
  const missing = minReq.filter((k) => typeof k === "string" && isBlank(a[k]));

  const unknown_keys = Object.keys(a).filter((k) => !known.has(k));

  return { ok: violations.length === 0 && missing.length === 0, violations, missing, unknown_keys };
}
