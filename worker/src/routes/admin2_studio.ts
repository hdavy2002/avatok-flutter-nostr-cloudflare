// [AUMFE-POD-STUDIO-API-1 2026-10-01] Admin Shop Studio API: artwork -> product fit -> print file -> owner photos -> publish.
// Contract: Specs/SPEC-2026-10-01-AUMFE-POD-STUDIO.md section 4. Registered by ONE spread in routes/admin2.ts (ADMIN2_STUDIO_ROUTES, added by CORE).
//
// The owner makes the artwork AND the model photos; nothing here generates an image. The print file is the PNG the browser rendered
// (stored as-is, never re-rendered). All print-partner talk goes through lib/pod (getPodProvider); no partner field names here.
// Every route is under /api/admin/v2/shop/studio/, behind the admin guard; every write is audited and tracked admin2_studio_*.
import type { Env } from "../types";
import { CORS, json, sha256Hex, decodeFileNameHeader, geminiRun, GEMINI_MODEL } from "../util";
import type { Admin2RouteDef } from "./admin2"; // type only: admin2.ts imports this file
import { track, trackException } from "../hooks";
import { adminGuard, audit, createProduct, err, readBody, safeTrack, updateProduct } from "./admin2_shop_catalog";
import { presignDigitalReadUrl } from "./media";
import { getPodProvider, ensurePodCatalog, referenceShippingRupees } from "../lib/pod";
import type { CatalogInfo } from "../lib/pod";
import type { CatalogProduct, PodProvider } from "../lib/pod";
import { BADGES, SLOTS } from "../lib/shop_logic";
import {
  IMAGE_EXT, LIMITS, PHOTO_KINDS, STEPS, SHOP_SLOTS_FLAGS,
  artChecksFromInfo, audienceFor, bestColours, buildFits, checkPrintFile, cleanBrowserChecks, cleanColours, cleanCopy, cleanPrices,
  cleanProducts, cleanSlots, fallbackBestText, fallbackCopy, isKind, orderPhotosForShop, parseCopyReply, parseImageInfo,
  parseJson, partnerPlacement, pendingSteps, photoChecks, photoCoverage, pickBest, printTypeFor, productsLabel, resolveVariants,
  resumeSteps, shopPrice, sniffImageMime, summariseCatalog, validatePlacement, variantSku,
  computeSizeCosts, reconcileColours, remapProducts, firstUnavailableColour, type DesignCosts,
  type DesignColour, type FitRow, type Placement, type StepKey, type StepResult, type StoredSteps,
} from "../lib/studio_logic";

const APP = "saathum";
const BASE = "/api/admin/v2/shop/studio";
const ID = "([^/]+)";
const re = (suffix: string) => new RegExp(`^${BASE}/${suffix}$`);
const noStore = { "cache-control": "private, no-store" };
const hex8 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const msgOf = (e: unknown) => String((e as { message?: string })?.message ?? e).slice(0, 240);
const PUBLISH_LOCK_MS = 120_000;

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------
function guarded(route: string, fn: (req: Request, env: Env, a: { uid: string }, params: string[]) => Promise<Response>) {
  return async (req: Request, env: Env, params: string[]): Promise<Response> => {
    const a = await adminGuard(req, env);
    if (a instanceof Response) return a;
    try {
      return await fn(req, env, a, params);
    } catch (e) {
      if (/no such table/i.test(msgOf(e))) return err(503, "studio_unavailable", "The Studio tables are not set up yet.");
      await trackException(env, e, { uid: a.uid, route, method: req.method, handled: true, app_name: APP });
      return err(500, "internal", "Something went wrong.");
    }
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
type DesignRow = {
  id: string; name: string; status: "draft" | "ready" | "live" | "retired"; step: string;
  art_key: string | null; art_w: number | null; art_h: number | null; art_bytes: number | null; art_mime: string | null; art_checks_json: string | null; art_preview_url: string | null;
  products_json: string; placement_json: string | null;
  print_key: string | null; print_w: number | null; print_h: number | null; print_sha256: string | null; print_preview_url: string | null;
  version: number; locked_at: number | null; colours_json: string; copy_json: string | null; prices_json: string | null; product_id: string | null;
  created_by: string | null; created_at: number; updated_at: number;
};
type PhotoRow = {
  id: string; design_id: string; kind: string; colour: string | null; url: string; width: number | null; height: number | null;
  checks_json: string | null; status: "kept" | "removed"; sort: number; is_main: number; created_at: number;
};
type ProductRef = { kind: string; provider_product_id: string; side: string };

async function loadDesign(env: Env, id: string): Promise<DesignRow | null> {
  if (!id || id.length > 64) return null;
  return env.DB_META.prepare("SELECT * FROM studio_designs WHERE id=?1").bind(id).first<DesignRow>();
}
async function loadPhotos(env: Env, designId: string, includeRemoved = false): Promise<PhotoRow[]> {
  const r = await env.DB_META.prepare(
    `SELECT * FROM studio_photos WHERE design_id=?1 ${includeRemoved ? "" : "AND status='kept'"} ORDER BY is_main DESC, sort ASC, created_at ASC`,
  ).bind(designId).all<PhotoRow>();
  return r.results ?? [];
}

function photoShape(p: PhotoRow) {
  return {
    id: p.id, design_id: p.design_id, kind: p.kind, colour: p.colour, url: p.url, width: p.width, height: p.height,
    checks: parseJson<{ size_ok?: boolean; colour_sold?: boolean }>(p.checks_json, {}), status: p.status, sort: Number(p.sort),
    is_main: Number(p.is_main) === 1, created_at: Number(p.created_at),
  };
}

// Catalogue [AUMFE-POD-COST-1]: Printrove's stored rows whenever its login is configured (auto-synced when empty or a day old),
// whatever shopPodProvider says (that flag is only about who places orders). The built-in manual catalogue is a visible fallback
// (source:'builtin' + reason) when Printrove is not connected or the sync fails.
const loadCatalogInfo = (env: Env): Promise<CatalogInfo> => ensurePodCatalog(env);
async function loadCatalog(env: Env, _provider?: PodProvider): Promise<CatalogProduct[]> { return (await loadCatalogInfo(env)).products; }

/**
 * Drafts made on the built-in catalogue move to the partner product of the same kind, and chosen colours the partner product does not
 * sell are flagged unavailable (aliases in studio_logic COLOUR_ALIASES). Persisted; published (locked) designs are never touched.
 */
async function reconcileDesign(env: Env, row: DesignRow, info: CatalogInfo): Promise<DesignRow> {
  if (info.source !== "printrove" || row.locked_at || row.status === "retired") return row;
  const rm = remapProducts(parseJson<ProductRef[]>(row.products_json, []), info.products);
  const primary = rm.products[0];
  const prod = primary ? info.products.find((p) => p.provider_product_id === primary.provider_product_id) : undefined;
  const chosen = parseJson<DesignColour[]>(row.colours_json, []);
  const rc = prod ? reconcileColours(chosen, summariseCatalog(prod).colours) : null;
  if (!rm.changed && !rc?.changed) return row;
  const next = { ...row };
  const stmts = [];
  if (rm.changed) {
    next.products_json = JSON.stringify(rm.products);
    stmts.push(env.DB_META.prepare("UPDATE studio_designs SET products_json=?2 WHERE id=?1").bind(row.id, next.products_json));
  }
  if (rc?.changed) {
    next.colours_json = JSON.stringify(rc.colours);
    stmts.push(env.DB_META.prepare("UPDATE studio_designs SET colours_json=?2 WHERE id=?1").bind(row.id, next.colours_json));
    for (const r of rc.renamed) {
      stmts.push(env.DB_META.prepare("UPDATE studio_photos SET colour=?3 WHERE design_id=?1 AND lower(colour)=lower(?2)").bind(row.id, r.from, r.to));
    }
  }
  try {
    await env.DB_META.batch(stmts);
    if (rc?.changed) await recomputePhotoChecks(env, row.id, rc.colours.filter((c) => !c.unavailable).map((c) => c.name));
  } catch (e) {
    await trackException(env, e, { route: "admin2_studio:reconcile", handled: true, app_name: APP, extra: { design_id: row.id } });
    return row;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Fits + design JSON
// ---------------------------------------------------------------------------
function dominantOf(row: DesignRow): string[] {
  const c = parseJson<{ dominant_colours?: unknown }>(row.art_checks_json, {});
  return Array.isArray(c.dominant_colours) ? (c.dominant_colours as unknown[]).map(String) : [];
}
function computeFits(row: DesignRow, catalog: CatalogProduct[]): FitRow[] {
  if (!row.art_w || !row.art_h) return [];
  return buildFits(row.art_w, row.art_h, catalog.map(summariseCatalog), dominantOf(row));
}

/** Partner costs per size for the chosen product, side and saved print size; null until a partner product + placement exist. */
async function costsFor(env: Env, row: DesignRow, info: CatalogInfo): Promise<DesignCosts | null> {
  if (info.source !== "printrove") return null;
  const primary = parseJson<ProductRef[]>(row.products_json, [])[0];
  const placement = parseJson<Placement | null>(row.placement_json, null);
  const prod = primary ? info.products.find((p) => p.provider_product_id === primary.provider_product_id) : undefined;
  if (!prod || !placement) return null;
  const side = placement.side;
  const shipping = await referenceShippingRupees(env);
  const colours = parseJson<DesignColour[]>(row.colours_json, []).filter((c) => !c.unavailable).map((c) => c.name);
  return {
    provider_product_id: prod.provider_product_id, side, print_w_in: placement.print_w_in, print_h_in: placement.print_h_in, shipping_rupees: shipping,
    sizes: computeSizeCosts(prod, colours, side, placement.print_w_in, placement.print_h_in, shipping),
  };
}

async function designJson(env: Env, inRow: DesignRow) {
  const info = await loadCatalogInfo(env);
  const row = await reconcileDesign(env, inRow, info);
  const catalog = info.products;
  const photos = await loadPhotos(env, row.id);
  let costs: DesignCosts | null = null;
  try { costs = await costsFor(env, row, info); } catch (e) { await trackException(env, e, { route: "admin2_studio:costs", handled: true, app_name: APP, extra: { design_id: row.id } }); }
  const colours = parseJson<DesignColour[]>(row.colours_json, []);
  const copy = parseJson<Record<string, unknown>>(row.copy_json, {});
  delete copy.publish_lock;
  const [artUrl, printUrl] = await Promise.all([
    row.art_key ? presignDigitalReadUrl(env, row.art_key, 900) : Promise.resolve(null),
    row.print_key ? presignDigitalReadUrl(env, row.print_key, 900) : Promise.resolve(null),
  ]);
  const { art_checks_json, products_json, placement_json, colours_json, copy_json, prices_json, ...rest } = row;
  return {
    ...rest,
    art_checks: parseJson<Record<string, unknown>>(art_checks_json, {}),
    products: parseJson<ProductRef[]>(products_json, []),
    placement: parseJson<Placement | null>(placement_json, null),
    colours,
    copy,
    prices: parseJson<Record<string, number>>(prices_json, {}),
    photos: photos.map(photoShape),
    photo_coverage: photoCoverage(colours.map((c) => c.name), photos),
    art_url: artUrl,
    print_url: printUrl,
    fits: computeFits(row, catalog),
    catalog_source: info.source,
    catalog_reason: info.reason,
    costs,
  };
}

const designResponse = async (env: Env, id: string, status = 200) => {
  const row = await loadDesign(env, id);
  return row ? json({ design: await designJson(env, row) }, status, noStore) : err(404, "not_found", "No such design.");
};

// ---------------------------------------------------------------------------
// AI text (Gemini) with deterministic fallback; every call mirrored as a PostHog $ai_generation.
// ---------------------------------------------------------------------------
async function aiText(env: Env, uid: string, span: string, designId: string, system: string, user: string, maxTokens: number): Promise<string> {
  const t0 = Date.now();
  let text = "";
  try { text = await geminiRun(env, system, user, maxTokens, 0.5); }
  catch (e) { await trackException(env, e, { uid, route: `admin2_studio:${span}`, handled: true, app_name: APP }); }
  try {
    await track(env, uid, "$ai_generation", APP, {
      $ai_model: GEMINI_MODEL, $ai_provider: "google",
      $ai_input_tokens: Math.ceil((system.length + user.length) / 4), $ai_output_tokens: Math.ceil(text.length / 4), // estimate: geminiRun does not return usage
      $ai_trace_id: `studio-${designId}`, $ai_span_name: span, $ai_latency: (Date.now() - t0) / 1000, design_id: designId, ok: !!text,
    });
  } catch (e) { await trackException(env, e, { uid, route: `admin2_studio:${span}:telemetry`, handled: true, app_name: APP }); }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Designs: list / create / get / update / retire
// ---------------------------------------------------------------------------
const listDesigns = guarded("admin2.studio.designs.list", async (req, env) => {
  const want = new URL(req.url).searchParams.get("status") ?? "all";
  const r = await env.DB_META.prepare(
    `SELECT d.*, p.slug AS product_slug,
       (SELECT COUNT(*) FROM studio_photos s WHERE s.design_id=d.id AND s.status='kept') AS photo_count
     FROM studio_designs d LEFT JOIN shop_products p ON p.id=d.product_id ORDER BY d.updated_at DESC LIMIT 300`,
  ).all<DesignRow & { product_slug: string | null; photo_count: number }>();
  const all = r.results ?? [];
  const counts = { all: 0, draft: 0, ready: 0, live: 0, retired: 0 };
  for (const d of all) { counts[d.status] = (counts[d.status] ?? 0) + 1; if (d.status !== "retired") counts.all++; }
  const shown = all.filter((d) => (want === "all" ? d.status !== "retired" : d.status === want));
  const items = shown.map((d) => ({
    id: d.id, name: d.name, status: d.status, step: d.step, art_preview_url: d.art_preview_url, print_preview_url: d.print_preview_url,
    products_label: productsLabel(parseJson<ProductRef[]>(d.products_json, [])),
    colours: parseJson<DesignColour[]>(d.colours_json, []).map((c) => c.name),
    updated_at: Number(d.updated_at), product_slug: d.product_slug ?? null, photo_count: Number(d.photo_count ?? 0),
  }));
  return json({ items, counts }, 200, noStore);
});

const createDesign = guarded("admin2.studio.designs.create", async (req, env, a) => {
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the design as JSON.");
  const name = String(b.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 120) return err(400, "invalid_input", "Name must be 2 to 120 characters.", { field: "name" });
  const id = `dsn-${hex8()}`;
  const now = Date.now();
  await env.DB_META.prepare(
    `INSERT INTO studio_designs (id, name, status, step, products_json, version, colours_json, created_by, created_at, updated_at)
     VALUES (?1,?2,'draft','upload','[]',1,'[]',?3,?4,?4)`,
  ).bind(id, name, a.uid, now).run();
  await audit(env, a.uid, "studio_design_create", id, { name });
  safeTrack(env, a.uid, "admin2_studio_design_created", { design_id: id });
  return designResponse(env, id, 201);
});

const getDesign = guarded("admin2.studio.designs.get", async (_req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  const design = await designJson(env, row);
  safeTrack(env, a.uid, "admin2_studio_costs_viewed", { design_id: id, source: design.catalog_source });
  return json({ design }, 200, noStore);
});

const updateDesign = guarded("admin2.studio.designs.update", async (req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  if (row.status === "retired") return err(409, "retired", "This design is retired.");
  const b = await readBody(req, 200_000);
  if (!b) return err(400, "invalid_request", "Send the changes as JSON.");
  const sets: string[] = [];
  const binds: unknown[] = [id];
  const set = (sql: (n: number) => string, v: unknown) => { binds.push(v); sets.push(sql(binds.length)); };
  const changed: string[] = [];
  const bad = (field: string, message: string) => err(400, "invalid_input", message, { field });
  let newStatus: string | null = null;
  let recheckPhotos: DesignColour[] | null = null;

  if ("name" in b) {
    const n = String(b.name ?? "").replace(/\s+/g, " ").trim();
    if (n.length < 2 || n.length > 120) return bad("name", "Name must be 2 to 120 characters.");
    set((n2) => `name=?${n2}`, n); changed.push("name");
  }
  if ("step" in b) {
    if (!(STEPS as readonly unknown[]).includes(b.step)) return bad("step", "Unknown step.");
    set((n2) => `step=?${n2}`, b.step); changed.push("step");
    if (row.status === "draft" && b.step === "publish" && row.print_key) newStatus = "ready";
    else if (row.status === "ready" && b.step !== "publish") newStatus = "draft";
  }
  if ("colours" in b) {
    const hexByName = new Map<string, string | null>();
    for (const p of await loadCatalog(env)) for (const c of summariseCatalog(p).colours) hexByName.set(c.name.toLowerCase(), c.hex);
    const c = cleanColours(b.colours, hexByName);
    if (!c.ok) return bad("colours", c.message);
    set((n2) => `colours_json=?${n2}`, JSON.stringify(c.value)); changed.push("colours");
    recheckPhotos = c.value;
  }
  if ("copy" in b) {
    const c = cleanCopy(b.copy);
    if (!c.ok) return bad("copy", c.message);
    set((n2) => `copy_json=json_patch(COALESCE(copy_json,'{}'),?${n2})`, JSON.stringify(c.value)); changed.push("copy");
  }
  if ("prices" in b) {
    const p = cleanPrices(b.prices);
    if (!p.ok) return bad("prices", p.message);
    set((n2) => `prices_json=?${n2}`, JSON.stringify(p.value)); changed.push("prices");
  }
  if ("art_checks" in b) {
    const c = cleanBrowserChecks(b.art_checks);
    if (!c.ok) return bad("art_checks", c.message);
    set((n2) => `art_checks_json=json_patch(COALESCE(art_checks_json,'{}'),?${n2})`, JSON.stringify(c.value)); changed.push("art_checks");
  }
  if (!changed.length) return bad("body", "Nothing to change.");
  if (newStatus) set((n2) => `status=?${n2}`, newStatus);
  set((n2) => `updated_at=?${n2}`, Date.now());
  await env.DB_META.prepare(`UPDATE studio_designs SET ${sets.join(", ")} WHERE id=?1`).bind(...binds).run();
  if (recheckPhotos) await recomputePhotoChecks(env, id, recheckPhotos.map((c) => c.name));
  await audit(env, a.uid, "studio_design_update", id, { changes: changed });
  safeTrack(env, a.uid, "admin2_studio_design_saved", { design_id: id, changes: changed.join(","), step: String(b.step ?? row.step) });
  return designResponse(env, id);
});

async function recomputePhotoChecks(env: Env, designId: string, sold: string[]): Promise<void> {
  const photos = await loadPhotos(env, designId, true);
  if (!photos.length) return;
  await env.DB_META.batch(photos.map((p) =>
    env.DB_META.prepare("UPDATE studio_photos SET checks_json=?2 WHERE id=?1").bind(p.id, JSON.stringify(photoChecks(p.width, p.height, p.colour, sold)))));
}

const retireDesign = guarded("admin2.studio.designs.retire", async (_req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  if (row.status !== "retired") {
    if (row.status === "live" && row.product_id) {
      const p = await env.DB_META.prepare("SELECT status FROM shop_products WHERE id=?1").bind(row.product_id).first<{ status: string }>();
      if (p && p.status !== "archived") return err(409, "live_product", "This design has a product on the shop. Archive that product first.");
    }
    await env.DB_META.prepare("UPDATE studio_designs SET status='retired', updated_at=?2 WHERE id=?1").bind(id, Date.now()).run();
    await audit(env, a.uid, "studio_design_retire", id, { name: row.name });
    safeTrack(env, a.uid, "admin2_studio_design_retired", { design_id: id });
  }
  return json({ ok: true, id, status: "retired" });
});

// ---------------------------------------------------------------------------
// Uploads: artwork, previews, print file
// ---------------------------------------------------------------------------
async function readBinary(req: Request, max: number): Promise<{ bytes: Uint8Array } | Response> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  const tooLarge = () => err(413, "too_large", `The file must be ${Math.round(max / 1048576)} MB or smaller.`);
  if (declared > max) return tooLarge();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.byteLength) return err(400, "empty", "No file received.");
  if (bytes.byteLength > max) return tooLarge();
  return { bytes };
}

async function putPublic(env: Env, uid: string, designId: string, sub: string, bytes: Uint8Array, mime: string): Promise<string> {
  const hash = (await sha256Hex(bytes)).slice(0, 16);
  const ext = IMAGE_EXT[mime as keyof typeof IMAGE_EXT] ?? "bin";
  const key = `u/${uid}/public/studio/${designId}/${sub}${hash}.${ext}`;
  await env.BLOBS.put(key, bytes, { httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" } });
  return `${env.BLOSSOM_BASE_URL}/${key}`;
}

const uploadArt = guarded("admin2.studio.art", async (req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  if (row.status === "retired") return err(409, "retired", "This design is retired.");
  if (row.locked_at) return err(409, "locked", "This design is published. Start a new version to change the artwork.");
  const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== "image/png" && ct !== "image/jpeg") return err(415, "unsupported_type", "Upload the artwork as a PNG or JPEG.");
  const body = await readBinary(req, LIMITS.artBytes);
  if (body instanceof Response) return body;
  const info = parseImageInfo(body.bytes);
  if (!info || (info.mime !== "image/png" && info.mime !== "image/jpeg")) return err(415, "unsupported_type", "That file is not a readable PNG or JPEG.");
  if (info.mime !== ct) return err(415, "type_mismatch", "The file is not the type it says it is.");
  const fileName = decodeFileNameHeader(req.headers.get("x-file-name"), 200);
  const sha8 = (await sha256Hex(body.bytes)).slice(0, 8);
  const key = `studio/${id}/art-${sha8}.${IMAGE_EXT[info.mime]}`;
  await env.DIGITAL.put(key, body.bytes, { httpMetadata: { contentType: info.mime }, customMetadata: { file_name: encodeURIComponent(fileName) } });
  const checks = artChecksFromInfo(info, body.bytes.byteLength, fileName);
  await env.DB_META.prepare(
    `UPDATE studio_designs SET art_key=?2, art_w=?3, art_h=?4, art_bytes=?5, art_mime=?6, art_checks_json=?7, art_preview_url=NULL,
       step=CASE WHEN step='upload' THEN 'product' ELSE step END, updated_at=?8 WHERE id=?1`,
  ).bind(id, key, info.w, info.h, body.bytes.byteLength, info.mime, JSON.stringify(checks), Date.now()).run();
  if (row.art_key && row.art_key !== key) {
    try { await env.DIGITAL.delete(row.art_key); }
    catch (e) { await trackException(env, e, { uid: a.uid, route: "admin2_studio:art_replace_cleanup", handled: true, app_name: APP }); }
  }
  await audit(env, a.uid, "studio_art_upload", id, { w: info.w, h: info.h, bytes: body.bytes.byteLength });
  safeTrack(env, a.uid, "admin2_studio_art_uploaded", { design_id: id, w: info.w, h: info.h, bytes: body.bytes.byteLength, has_alpha: info.has_alpha, rgb: info.rgb });
  return designResponse(env, id);
});

async function uploadPreview(req: Request, env: Env, a: { uid: string }, id: string, which: "art" | "print"): Promise<Response> {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  const body = await readBinary(req, LIMITS.previewBytes);
  if (body instanceof Response) return body;
  const mime = sniffImageMime(body.bytes);
  if (mime !== "image/webp" && mime !== "image/png") return err(415, "unsupported_type", "The preview must be a WebP or PNG image.");
  const url = await putPublic(env, a.uid, id, `${which}-preview-`, body.bytes, mime);
  await env.DB_META.prepare(`UPDATE studio_designs SET ${which}_preview_url=?2, updated_at=?3 WHERE id=?1`).bind(id, url, Date.now()).run();
  safeTrack(env, a.uid, `admin2_studio_${which}_preview_saved`, { design_id: id, bytes: body.bytes.byteLength });
  return json({ url, [`${which}_preview_url`]: url });
}
const uploadArtPreview = guarded("admin2.studio.art_preview", (req, env, a, [id]) => uploadPreview(req, env, a, id, "art"));
const uploadPrintPreview = guarded("admin2.studio.print_preview", (req, env, a, [id]) => uploadPreview(req, env, a, id, "print"));

const uploadPrint = guarded("admin2.studio.print", async (req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  if (row.status === "retired") return err(409, "retired", "This design is retired.");
  if (row.locked_at) return err(409, "locked", "The print file is locked because this design is published. Start a new version first.");
  const body = await readBinary(req, LIMITS.printBytes);
  if (body instanceof Response) return body;
  const info = parseImageInfo(body.bytes);
  const check = checkPrintFile(info, body.bytes.byteLength);
  if (!check.ok || !info) { const c = check as Extract<typeof check, { ok: false }>; return err(c.status, c.code, c.message); }
  const sha = await sha256Hex(body.bytes);
  const key = `studio/${id}/print-v${row.version}-${sha.slice(0, 8)}.png`;
  await env.DIGITAL.put(key, body.bytes, { httpMetadata: { contentType: "image/png" } });
  await env.DB_META.prepare(
    `UPDATE studio_designs SET print_key=?2, print_w=?3, print_h=?4, print_sha256=?5, print_preview_url=NULL, step='photos', updated_at=?6 WHERE id=?1`,
  ).bind(id, key, info.w, info.h, sha, Date.now()).run();
  await audit(env, a.uid, "studio_print_save", id, { w: info.w, h: info.h, version: row.version });
  safeTrack(env, a.uid, "admin2_studio_print_saved", { design_id: id, w: info.w, h: info.h, bytes: body.bytes.byteLength, version: row.version });
  return designResponse(env, id);
});

// The editor draws these private files into a canvas, which a presigned R2 URL cannot serve (no CORS for the admin origin),
// so the Worker streams the bytes itself behind the admin guard.
const streamFile = (which: "art" | "print") => guarded(`admin2.studio.file.${which}`, async (_req, env, _a, [id]) => {
  const row = await loadDesign(env, id);
  const key = which === "art" ? row?.art_key : row?.print_key;
  if (!row || !key) return err(404, "no_file", which === "art" ? "No artwork has been uploaded yet." : "No print file has been saved yet.");
  const obj = await env.DIGITAL.get(key);
  if (!obj) return err(404, "no_file", "That file is missing from storage.");
  const type = which === "print" ? "image/png" : row.art_mime || obj.httpMetadata?.contentType || "application/octet-stream";
  return new Response(obj.body, { status: 200, headers: { ...CORS, "content-type": type, "cache-control": "private, no-store" } });
});
const streamArt = streamFile("art");
const streamPrint = streamFile("print");

const newVersion = guarded("admin2.studio.new_version", async (_req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  if (!row.locked_at) return err(409, "not_locked", "This design is not published yet, so it can still be edited.");
  await env.DB_META.prepare(
    `UPDATE studio_designs SET version=version+1, locked_at=NULL, print_key=NULL, print_w=NULL, print_h=NULL, print_sha256=NULL, print_preview_url=NULL,
       step='design', updated_at=?2 WHERE id=?1 AND locked_at IS NOT NULL`,
  ).bind(id, Date.now()).run();
  await audit(env, a.uid, "studio_new_version", id, { from: row.version, to: row.version + 1 });
  safeTrack(env, a.uid, "admin2_studio_new_version", { design_id: id, version: row.version + 1 });
  return designResponse(env, id);
});

// ---------------------------------------------------------------------------
// Fits, products, placement
// ---------------------------------------------------------------------------
const getFits = guarded("admin2.studio.fits", async (_req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  if (!row.art_w || !row.art_h) return err(409, "no_art", "Upload the artwork first.");
  const info = await loadCatalogInfo(env);
  const catalog = info.products;
  const items = computeFits(row, catalog);
  const best = pickBest(items);
  const dominant = dominantOf(row);
  const fadedNames = (best?.catalog?.colours ?? []).filter((c) => c.faded).map((c) => c.name);
  const cacheKey = `${row.art_w}x${row.art_h}|${dominant.join(",")}|${best ? `${best.kind}.${best.side}.${best.verdict}` : "none"}|${catalog.length}`;
  const cache = parseJson<{ best_cache?: { key?: string; text?: string } }>(row.art_checks_json, {}).best_cache;
  let text = cache?.key === cacheKey && cache.text ? cache.text : "";
  let ai = false;
  if (!text) {
    const facts = best
      ? `Artwork ${row.art_w}x${row.art_h} px, dominant colours ${dominant.join(", ") || "unknown"}. Best product: ${best.label} ${best.side}, ${best.full_area_dpi} DPI at full width (${best.verdict}). Colours that would look faded: ${fadedNames.join(", ") || "none"}. Other fits: ${items.filter((f) => f !== best && (f.verdict === "great" || f.verdict === "good")).slice(0, 4).map((f) => `${f.label} ${f.side}`).join("; ") || "none"}.`
      : `Artwork ${row.art_w}x${row.art_h} px is too small to print sharp on any product.`;
    text = await aiText(env, a.uid, "studio_best_match", id,
      "You advise a small Indian T-shirt shop owner which garment suits his artwork. Reply with 2 short plain sentences, no markdown. Use only the facts given; never invent fabric, price or brand names.",
      facts, 160);
    ai = !!text;
    if (!text) text = fallbackBestText(best, row.art_w, row.art_h, fadedNames);
    try {
      await env.DB_META.prepare("UPDATE studio_designs SET art_checks_json=json_patch(COALESCE(art_checks_json,'{}'),?2) WHERE id=?1")
        .bind(id, JSON.stringify({ best_cache: { key: cacheKey, text } })).run();
    } catch (e) { await trackException(env, e, { uid: a.uid, route: "admin2_studio:fits_cache", handled: true, app_name: APP }); }
  }
  safeTrack(env, a.uid, "admin2_studio_fits_viewed", { design_id: id, best_kind: best?.kind ?? "none", ai });
  return json({ items, catalog_source: info.source, catalog_reason: info.reason, best: best ? { kind: best.kind, side: best.side, colours: bestColours(best), text } : { kind: null, side: null, colours: [], text } }, 200, noStore);
});

const putProducts = guarded("admin2.studio.products", async (req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  if (row.locked_at) return err(409, "locked", "This design is published. Start a new version to change the product.");
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the products as JSON.");
  const c = cleanProducts(b.products);
  if (!c.ok) return err(400, "invalid_input", c.message, { field: "products" });
  await env.DB_META.prepare(
    `UPDATE studio_designs SET products_json=?2, step=CASE WHEN step IN ('upload','product') THEN 'design' ELSE step END, updated_at=?3 WHERE id=?1`,
  ).bind(id, JSON.stringify(c.value), Date.now()).run();
  await audit(env, a.uid, "studio_products_save", id, { count: c.value.length });
  safeTrack(env, a.uid, "admin2_studio_products_saved", { design_id: id, count: c.value.length, kinds: c.value.map((p) => p.kind).join(",") });
  return designResponse(env, id);
});

const putPlacement = guarded("admin2.studio.placement", async (req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  if (row.locked_at) return err(409, "locked", "This design is published. Start a new version to change the placement.");
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the placement as JSON.");
  const v = validatePlacement(b.placement);
  if (!v.ok) return err(v.status, v.code, v.message, v.field ? { field: v.field } : {});
  await env.DB_META.prepare("UPDATE studio_designs SET placement_json=?2, updated_at=?3 WHERE id=?1").bind(id, JSON.stringify(v.placement), Date.now()).run();
  await audit(env, a.uid, "studio_placement_save", id, { kind: v.placement.kind, shape: v.placement.shape, dpi: v.placement.dpi });
  safeTrack(env, a.uid, "admin2_studio_placement_saved", { design_id: id, shape: v.placement.shape, dpi: v.placement.dpi, kind: v.placement.kind, side: v.placement.side });
  return designResponse(env, id);
});

// ---------------------------------------------------------------------------
// Owner photos
// ---------------------------------------------------------------------------
const uploadPhoto = guarded("admin2.studio.photos.add", async (req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  if (row.status === "retired") return err(409, "retired", "This design is retired.");
  const kind = (req.headers.get("x-kind") ?? "model").trim().toLowerCase();
  if (!(PHOTO_KINDS as readonly string[]).includes(kind)) return err(400, "invalid_input", "x-kind must be model, flat or closeup.", { field: "x-kind" });
  const colour = decodeFileNameHeader(req.headers.get("x-colour"), 40) || null;
  const body = await readBinary(req, LIMITS.photoBytes);
  if (body instanceof Response) return body;
  const info = parseImageInfo(body.bytes);
  if (!info) return err(415, "unsupported_type", "Photos must be JPG, PNG or WebP.");
  const existing = await loadPhotos(env, id, true);
  if (existing.filter((p) => p.status === "kept").length >= LIMITS.maxPhotosPerDesign) return err(409, "too_many", `Up to ${LIMITS.maxPhotosPerDesign} photos per design.`);
  const sold = parseJson<DesignColour[]>(row.colours_json, []).map((c) => c.name);
  const checks = photoChecks(info.w, info.h, colour, sold);
  const url = await putPublic(env, a.uid, id, "photo-", body.bytes, info.mime);
  const pid = `sph-${hex8()}`;
  const now = Date.now();
  const kept = existing.filter((p) => p.status === "kept");
  const hasMain = kept.some((p) => Number(p.is_main) === 1);
  const stmts = [];
  // A regenerated plain-shirt picture replaces the old one for that colour (one flat per colour, one close-up per design).
  if (kind !== "model") {
    for (const p of kept.filter((x) => x.kind === kind && (kind === "closeup" || (x.colour ?? "").toLowerCase() === (colour ?? "").toLowerCase()))) {
      stmts.push(env.DB_META.prepare("UPDATE studio_photos SET status='removed', is_main=0 WHERE id=?1").bind(p.id));
    }
  }
  const sort = existing.reduce((m, p) => Math.max(m, Number(p.sort)), -1) + 1;
  stmts.push(env.DB_META.prepare(
    `INSERT INTO studio_photos (id, design_id, kind, colour, url, width, height, checks_json, status, sort, is_main, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'kept',?9,?10,?11)`,
  ).bind(pid, id, kind, colour, url, info.w, info.h, JSON.stringify(checks), sort, kind === "model" && !hasMain ? 1 : 0, now));
  stmts.push(env.DB_META.prepare("UPDATE studio_designs SET updated_at=?2 WHERE id=?1").bind(id, now));
  await env.DB_META.batch(stmts);
  const saved = await env.DB_META.prepare("SELECT * FROM studio_photos WHERE id=?1").bind(pid).first<PhotoRow>();
  safeTrack(env, a.uid, "admin2_studio_photo_uploaded", { design_id: id, photo_id: pid, kind, size_ok: checks.size_ok, colour_sold: checks.colour_sold, w: info.w, h: info.h });
  return json({ photo: photoShape(saved!) }, 201);
});

const updatePhoto = guarded("admin2.studio.photos.update", async (req, env, a, [pid]) => {
  const p = await env.DB_META.prepare("SELECT * FROM studio_photos WHERE id=?1").bind(pid).first<PhotoRow>();
  if (!p) return err(404, "not_found", "No such photo.");
  const design = await loadDesign(env, p.design_id);
  if (!design) return err(404, "not_found", "No such design.");
  const b = await readBody(req);
  if (!b) return err(400, "invalid_request", "Send the changes as JSON.");
  const bad = (field: string, message: string) => err(400, "invalid_input", message, { field });
  let colour = p.colour, status = p.status, sort = Number(p.sort), isMain = Number(p.is_main) === 1;
  const changed: string[] = [];
  if ("colour" in b) {
    if (b.colour === null || b.colour === "") colour = null;
    else if (typeof b.colour !== "string" || b.colour.length > 40) return bad("colour", "Pick a colour.");
    else colour = b.colour.trim();
    changed.push("colour");
  }
  if ("status" in b) {
    if (b.status !== "kept" && b.status !== "removed") return bad("status", "Status must be kept or removed.");
    status = b.status; changed.push("status");
  }
  if ("sort" in b) {
    const n = Number(b.sort);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) return bad("sort", "Sort must be a whole number.");
    sort = n; changed.push("sort");
  }
  if ("is_main" in b) {
    if (typeof b.is_main !== "boolean") return bad("is_main", "is_main must be true or false.");
    isMain = b.is_main; changed.push("is_main");
  }
  if (!changed.length) return bad("body", "Nothing to change.");
  const sold = parseJson<DesignColour[]>(design.colours_json, []).map((c) => c.name);
  const checks = photoChecks(p.width, p.height, colour, sold);
  if (status === "removed") isMain = false;
  const stmts = [];
  if (isMain) stmts.push(env.DB_META.prepare("UPDATE studio_photos SET is_main=0 WHERE design_id=?1 AND id<>?2").bind(p.design_id, pid));
  stmts.push(env.DB_META.prepare("UPDATE studio_photos SET colour=?2, status=?3, sort=?4, is_main=?5, checks_json=?6 WHERE id=?1")
    .bind(pid, colour, status, sort, isMain ? 1 : 0, JSON.stringify(checks)));
  stmts.push(env.DB_META.prepare("UPDATE studio_designs SET updated_at=?2 WHERE id=?1").bind(p.design_id, Date.now()));
  await env.DB_META.batch(stmts);
  // The main photo was removed (or demoted with no replacement): promote the first kept model photo.
  const after = await loadPhotos(env, p.design_id);
  if (!after.some((x) => Number(x.is_main) === 1)) {
    const next = after.find((x) => x.kind === "model");
    if (next) await env.DB_META.prepare("UPDATE studio_photos SET is_main=1 WHERE id=?1").bind(next.id).run();
  }
  await audit(env, a.uid, "studio_photo_update", pid, { design_id: p.design_id, changes: changed });
  safeTrack(env, a.uid, "admin2_studio_photo_updated", { design_id: p.design_id, photo_id: pid, changes: changed.join(",") });
  const photos = await loadPhotos(env, p.design_id);
  const fresh = await env.DB_META.prepare("SELECT * FROM studio_photos WHERE id=?1").bind(pid).first<PhotoRow>();
  return json({ photo: photoShape(fresh!), photo_coverage: photoCoverage(sold, photos) });
});

// ---------------------------------------------------------------------------
// AI copy
// ---------------------------------------------------------------------------
const copyAi = guarded("admin2.studio.copy_ai", async (_req, env, a, [id]) => {
  const row = await loadDesign(env, id);
  if (!row) return err(404, "not_found", "No such design.");
  const products = parseJson<ProductRef[]>(row.products_json, []);
  const colours = parseJson<DesignColour[]>(row.colours_json, []).map((c) => c.name);
  const provider = await getPodProvider(env);
  const primary = products[0];
  const cat = primary ? (await loadCatalog(env, provider)).find((p) => p.provider_product_id === primary.provider_product_id) : null;
  const productLabel = cat?.name ?? (primary && isKind(primary.kind) ? productsLabel([primary]).replace(/ (front|back)$/, "") : "T-shirt");
  const fallback = fallbackCopy(row.name, productLabel, colours);
  const shape = parseJson<Placement | null>(row.placement_json, null)?.shape ?? "";
  const text = await aiText(env, a.uid, "studio_copy", id,
    "You write product copy for a small Indian shop selling printed Hindu-spiritual T-shirts. Reply with ONLY a JSON object {\"name\":string,\"description\":string,\"seo_title\":string}. " +
    "name: 2-6 words. description: 2-3 plain sentences, under 450 characters, warm and respectful. seo_title: under 60 characters. " +
    "Use ONLY the facts given. Never invent fabric, GSM, fit or care details: where fabric would go write the exact token [FABRIC]. Do not mention any brand or print-partner name.",
    `Design name: ${row.name}. Product: ${productLabel}. Colours: ${colours.join(", ") || "not chosen yet"}. Print frame: ${shape || "not set"}.`,
    380);
  const parsed = text ? parseCopyReply(text) : null;
  const out = parsed ?? fallback;
  safeTrack(env, a.uid, "admin2_studio_copy_drafted", { design_id: id, ai: !!parsed });
  return json({ name: out.name, description: out.description, seo_title: out.seo_title });
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------
type Ctx = {
  env: Env; req: Request; uid: string; row: DesignRow; provider: PodProvider; pid: string; placeholder: string;
  primary: ProductRef; catalogProduct: CatalogProduct | null; placement: Placement; colours: DesignColour[]; prices: Record<string, number>;
  copy: { name: string; description: string; seo_title?: string; seo_description?: string };
  collectionId: string | null; badge: string; slots: string[];
  resolved: ReturnType<typeof resolveVariants>; stored: StoredSteps;
  designRef: string | null; listingRef: string | null; productId: string | null; note: string[];
};
type StepOut = { status: "done" | "skipped"; note: string; ref?: string | null; refs?: Record<string, string> | null };

const stepLabels = (provider: PodProvider): Record<StepKey, string> => ({
  upload_design: `Upload print file to ${provider.label}`,
  create_listing: `Create the product at ${provider.label}`,
  variant_map: "Link sizes and colours",
  shop_product: "Create the shop product",
  slots: "Show on shop sections",
});

async function upsertListing(env: Env, productId: string, provider: string, row: DesignRow, designRef: string, status: string): Promise<void> {
  await env.DB_META.prepare(
    `INSERT INTO pod_listings (product_id, provider, design_id, design_version, provider_design_ref, provider_listing_ref, status, error, published_at)
     VALUES (?1,?2,?3,?4,?5,NULL,?6,NULL,NULL)
     ON CONFLICT(product_id, provider) DO UPDATE SET design_id=excluded.design_id, design_version=excluded.design_version,
       provider_design_ref=excluded.provider_design_ref,
       status=CASE WHEN pod_listings.status='listed' AND pod_listings.design_version=excluded.design_version THEN pod_listings.status ELSE excluded.status END, error=NULL`,
  ).bind(productId, provider, row.id, row.version, designRef, status).run();
}

async function stepUploadDesign(c: Ctx): Promise<StepOut> {
  const { env, row, provider, pid } = c;
  const extra = c.note.length ? ` ${c.note.join(" ")}` : "";
  if (!provider.supportsApi) {
    await upsertListing(env, pid, provider.id, row, row.id, "manual");
    return { status: "skipped", note: `Placed by hand with this partner: nothing to upload. The print file stays here.${extra}`, ref: row.id };
  }
  const prev = c.stored.steps.upload_design;
  if (prev?.status === "done" && prev.ref) {
    await upsertListing(env, pid, provider.id, row, prev.ref, "design_uploaded");
    return { status: "done", note: prev.note, ref: prev.ref };
  }
  const obj = await env.DIGITAL.get(row.print_key!);
  if (!obj) throw new Error("The print file is missing from storage. Save the design on the shirt again.");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const { design_ref } = await provider.uploadDesign(bytes, `${row.id}-v${row.version}.png`);
  await upsertListing(env, pid, provider.id, row, design_ref, "design_uploaded");
  return { status: "done", note: `Design ref ${design_ref}.${extra}`, ref: design_ref };
}

async function stepCreateListing(c: Ctx): Promise<StepOut> {
  const { env, row, provider, pid } = c;
  if (!provider.supportsApi) return { status: "skipped", note: "Nothing to create: this partner is used by hand." };
  const prev = c.stored.steps.create_listing;
  if (prev?.status === "done" && prev.ref) return { status: "done", note: prev.note, ref: prev.ref, refs: prev.refs ?? null };
  if (!c.catalogProduct) throw new Error("This product is not in the partner catalogue. Sync the catalogue and pick the product again.");
  if (!c.designRef) throw new Error("The design was not uploaded yet.");
  if (!c.resolved.rows.length) throw new Error("None of the chosen colours and sizes exist for this product.");
  const out = await provider.createListing({
    name: c.copy.name, provider_product_id: c.primary.provider_product_id, design_ref: c.designRef, placement: partnerPlacement(c.placement),
    variants: c.resolved.rows.map((r) => ({ provider_variant_id: r.variant.provider_variant_id, sku: variantSku(row.id, row.version, r.colour, r.size, r.variant.sku) })),
  });
  await env.DB_META.prepare("UPDATE pod_listings SET provider_listing_ref=?3, status='listed', error=NULL, published_at=?4 WHERE product_id=?1 AND provider=?2")
    .bind(pid, provider.id, out.listing_ref, Date.now()).run();
  return { status: "done", note: `Listing ${out.listing_ref}`, ref: out.listing_ref, refs: out.variant_refs };
}

async function stepVariantMap(c: Ctx): Promise<StepOut> {
  const { env, row, provider, pid, resolved } = c;
  if (!c.catalogProduct) throw new Error("This product is not in the catalogue. Sync the catalogue and pick the product again.");
  if (!resolved.rows.length) throw new Error(`None of the chosen colours and sizes exist for this product${resolved.missing.length ? ` (missing: ${resolved.missing.slice(0, 6).join(", ")})` : ""}.`);
  const stmts = [env.DB_META.prepare("UPDATE pod_variant_map SET active=0 WHERE product_id=?1 AND provider=?2").bind(pid, provider.id)];
  for (const r of resolved.rows) {
    stmts.push(env.DB_META.prepare(
      `INSERT INTO pod_variant_map (product_id, colour, size, provider, provider_variant_id, base_cost_paise, sku, active) VALUES (?1,?2,?3,?4,?5,?6,?7,1)
       ON CONFLICT(product_id, colour, size, provider) DO UPDATE SET provider_variant_id=excluded.provider_variant_id, base_cost_paise=excluded.base_cost_paise, sku=excluded.sku, active=1`,
    ).bind(pid, r.colour, r.size, provider.id, r.variant.provider_variant_id, r.variant.base_cost_paise ?? null, variantSku(row.id, row.version, r.colour, r.size, r.variant.sku)));
  }
  await env.DB_META.batch(stmts);
  const miss = resolved.missing.length ? ` ${resolved.missing.length} combination(s) are not made by the partner and were left out.` : "";
  return { status: "done", note: `${resolved.colours.length} colours x ${resolved.sizes.length} sizes, ${resolved.rows.length} items linked.${miss}` };
}

/** Runs the SAME create/update handlers the shop product admin uses, with the caller's own credentials, so validation, slugs, SEO defaults, audit and telemetry are identical. */
async function callProductHandler(c: Ctx, id: string | null, body: Record<string, unknown>): Promise<{ ok: boolean; product?: { id: string; slug?: string }; message?: string }> {
  const headers = new Headers(c.req.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const url = new URL(c.req.url);
  url.pathname = `/api/admin/v2/shop/products${id ? `/${id}` : ""}`;
  url.search = "";
  const req = new Request(url.toString(), { method: id ? "PUT" : "POST", headers, body: JSON.stringify(body) });
  const res = await (id ? updateProduct(req, c.env, [id]) : createProduct(req, c.env, []));
  const j = (await res.json().catch(() => ({}))) as { product?: { id: string; slug?: string }; message?: string; error?: string };
  if (!res.ok) return { ok: false, message: j.message ?? j.error ?? `The shop rejected the product (${res.status}).` };
  return { ok: true, product: j.product };
}

async function stepShopProduct(c: Ctx): Promise<StepOut> {
  const { env, row } = c;
  const photos = orderPhotosForShop((await loadPhotos(env, row.id)).map((p) => ({ id: p.id, kind: p.kind, colour: p.colour, url: p.url, sort: Number(p.sort), is_main: Number(p.is_main), status: p.status })));
  if (!photos.length) throw new Error("Add at least one photo. The plain-shirt pictures are made when the Your photos step opens.");
  const images = photos.slice(0, 10).map((p) => ({ url: p.url, label: p.kind === "closeup" ? "Print close-up" : p.colour ?? "" }));
  const { price, uniform } = shopPrice(c.prices, c.resolved.sizes);
  const body: Record<string, unknown> = {
    name: c.copy.name, description: c.copy.description, collection_id: c.collectionId, audience: audienceFor(c.primary.kind),
    print_type: printTypeFor(c.placement), price_rupees: price, colours: c.resolved.colours, sizes: c.resolved.sizes, images,
    badge: c.badge, status: "live", printrove_ref: c.listingRef,
  };
  if (c.copy.seo_title) body.seo_title = c.copy.seo_title;
  if (c.copy.seo_description) body.seo_description = c.copy.seo_description;
  let existing: string | null = null;
  if (row.product_id) {
    const p = await env.DB_META.prepare("SELECT id FROM shop_products WHERE id=?1").bind(row.product_id).first<{ id: string }>();
    existing = p?.id ?? null;
  }
  const out = await callProductHandler(c, existing, body);
  if (!out.ok || !out.product) throw new Error(out.message ?? "The shop could not save the product.");
  c.productId = out.product.id;
  await env.DB_META.prepare("UPDATE studio_designs SET product_id=?2, updated_at=?3 WHERE id=?1").bind(row.id, out.product.id, Date.now()).run();
  if (c.pid !== out.product.id) {
    // First publish: steps 1-3 ran before the shop product existed and keyed their rows on a placeholder id. Re-key them.
    for (const t of ["pod_listings", "pod_variant_map"]) {
      await env.DB_META.prepare(`UPDATE OR IGNORE ${t} SET product_id=?1 WHERE product_id=?2`).bind(out.product.id, c.placeholder).run();
      await env.DB_META.prepare(`DELETE FROM ${t} WHERE product_id=?1`).bind(c.placeholder).run();
    }
    c.pid = out.product.id;
  }
  const col = c.collectionId ? await env.DB_META.prepare("SELECT name FROM shop_collections WHERE id=?1").bind(c.collectionId).first<{ name: string }>() : null;
  const nModel = photos.filter((p) => p.kind === "model").length;
  const priceNote = uniform ? "" : ` One price (Rs ${price}) for every size for now: 2XL/3XL priced the same for now.`;
  return { status: "done", note: `Live${col ? ` · ${col.name} collection` : ""} · ${nModel} photo${nModel === 1 ? "" : "s"} + plain-shirt pictures.${priceNote}`, ref: out.product.id };
}

async function stepSlots(c: Ctx): Promise<StepOut> {
  const { env } = c;
  if (!c.slots.length) return { status: "skipped", note: "No shop section chosen." };
  if (!c.productId) throw new Error("The shop product does not exist yet.");
  const done: string[] = [];
  for (const slot of c.slots) {
    const flag = (SHOP_SLOTS_FLAGS as Record<string, string>)[slot];
    if (flag) {
      try { await env.DB_META.prepare(`UPDATE shop_products SET ${flag}=1, updated_at=?2 WHERE id=?1`).bind(c.productId, Date.now()).run(); }
      catch (e) {
        if (/no such column|has no column named/i.test(msgOf(e))) throw new Error("The New arrival / Bestseller flags need the shop-flags database update, which has not been applied yet.");
        throw e;
      }
    } else {
      await env.DB_META.prepare(
        `INSERT OR IGNORE INTO shop_slots (slot, product_id, sort, until_at) VALUES (?1,?2,(SELECT COALESCE(MAX(sort),-1)+1 FROM shop_slots WHERE slot=?1),NULL)`,
      ).bind(slot, c.productId).run();
    }
    done.push(slot.replace(/_/g, " "));
  }
  return { status: "done", note: `Shown on ${done.join(", ")}.` };
}

const STEP_FNS: Array<[StepKey, (c: Ctx) => Promise<StepOut>]> = [
  ["upload_design", stepUploadDesign], ["create_listing", stepCreateListing], ["variant_map", stepVariantMap],
  ["shop_product", stepShopProduct], ["slots", stepSlots],
];

async function saveProgress(env: Env, id: string, stored: StoredSteps): Promise<void> {
  await env.DB_META.prepare("UPDATE studio_designs SET copy_json=json_set(COALESCE(copy_json,'{}'),'$.publish_steps',json(?2)), updated_at=?3 WHERE id=?1")
    .bind(id, JSON.stringify(stored), Date.now()).run();
}

const publish = guarded("admin2.studio.publish", async (req, env, a, [id]) => {
  const b = await readBody(req, 100_000);
  if (!b) return err(400, "invalid_request", "Send the publish details as JSON.");
  const loaded = await loadDesign(env, id);
  if (!loaded) return err(404, "not_found", "No such design.");
  if (loaded.status === "retired") return err(409, "retired", "This design is retired.");
  const catInfo = await loadCatalogInfo(env);
  const row = await reconcileDesign(env, loaded, catInfo); // [AUMFE-POD-COST-1] manual: drafts -> partner product; unsold colours flagged

  // Inputs: body wins, stored values fill the gaps.
  const stored0 = parseJson<Record<string, unknown>>(row.copy_json, {});
  let collectionId: string | null = typeof stored0.collection_id === "string" ? stored0.collection_id : null;
  if ("collection_id" in b) collectionId = b.collection_id === null || b.collection_id === "" ? null : String(b.collection_id);
  if (collectionId) {
    const hit = await env.DB_META.prepare("SELECT id FROM shop_collections WHERE id=?1").bind(collectionId).first();
    if (!hit) return err(400, "invalid_input", "That collection does not exist.", { field: "collection_id" });
  }
  const badge = "badge" in b ? String(b.badge ?? "") : String(stored0.badge ?? "");
  if (!(BADGES as readonly string[]).includes(badge)) return err(400, "invalid_input", "Badge must be none, new, best or sale.", { field: "badge" });
  let prices = parseJson<Record<string, number>>(row.prices_json, {});
  if ("prices" in b) {
    const p = cleanPrices(b.prices);
    if (!p.ok) return err(400, "invalid_input", p.message, { field: "prices" });
    prices = p.value;
  }
  const slotsIn = cleanSlots(b.slots, SLOTS);
  if (!slotsIn.ok) return err(400, "invalid_input", slotsIn.message, { field: "slots" });

  const provider = await getPodProvider(env);
  const products = parseJson<ProductRef[]>(row.products_json, []);
  const placement = parseJson<Placement | null>(row.placement_json, null);
  const colours = parseJson<DesignColour[]>(row.colours_json, []);
  const copyStored = cleanCopy({ name: stored0.name ?? row.name, description: stored0.description ?? "", seo_title: stored0.seo_title, seo_description: stored0.seo_description });
  const copy = copyStored.ok ? copyStored.value : { name: row.name, description: "" };

  const missing: string[] = [];
  if (!row.print_key) missing.push("print file (Design on shirt step)");
  if (!products.length) missing.push("product");
  if (!placement) missing.push("placement");
  else if (products.length && (placement.kind !== products[0].kind || placement.side !== products[0].side)) missing.push(`placement for ${products[0].kind} ${products[0].side} (the saved one is for ${placement.kind} ${placement.side})`);
  if (!colours.length) missing.push("colours");
  if (!Object.keys(prices).length) missing.push("prices");
  if (!copy.name || copy.name.length < 2) missing.push("product name");
  if (missing.length) return err(400, "not_ready", `Not ready to publish: ${missing.join(", ")}.`, { missing });
  const unsold = colours.filter((c) => c.unavailable).map((c) => c.name);
  if (unsold.length) {
    return err(400, "colour_unavailable", `${unsold.join(", ")} ${unsold.length === 1 ? "is" : "are"} not sold by Printrove. Pick the colours again in the Product step.`, { colours: unsold, first: firstUnavailableColour(colours) });
  }

  const catalog = catInfo.products;
  const primary = products[0];
  const catalogProduct = catalog.find((p) => p.provider_product_id === primary.provider_product_id) ?? null;
  const resolved = catalogProduct ? resolveVariants(colours, catalogProduct, prices) : { colours: [], sizes: [], rows: [], missing: [] };

  // One publish at a time per design (a stale lock expires after two minutes).
  const now = Date.now();
  const lock = await env.DB_META.prepare(
    `UPDATE studio_designs SET copy_json=json_set(COALESCE(copy_json,'{}'),'$.publish_lock',?2) WHERE id=?1 AND COALESCE(json_extract(copy_json,'$.publish_lock'),0) < ?3`,
  ).bind(id, now, now - PUBLISH_LOCK_MS).run();
  if (!((lock.meta?.changes ?? 0) > 0)) return err(409, "publish_running", "A publish is already running for this design. Try again in a moment.");

  const results: StepResult[] = [];
  const labels = stepLabels(provider);
  try {
    await env.DB_META.prepare(
      `UPDATE studio_designs SET prices_json=?2, copy_json=json_patch(COALESCE(copy_json,'{}'),?3), updated_at=?4 WHERE id=?1`,
    ).bind(id, JSON.stringify(prices), JSON.stringify({ collection_id: collectionId, badge }), now).run();

    const fresh = (await loadDesign(env, id)) ?? row;
    const stored = resumeSteps(parseJson<Record<string, unknown>>(fresh.copy_json, {}).publish_steps, fresh.version);
    const placeholder = `pending:${id}`;
    const note: string[] = [];
    if (products.length > 1) note.push(`Only the first chosen product (${primary.kind} ${primary.side}) is listed; each shop product needs its own design copy.`);
    const ctx: Ctx = {
      env, req, uid: a.uid, row: fresh, provider, pid: fresh.product_id ?? placeholder, placeholder, primary, catalogProduct, placement: placement!, colours, prices,
      copy: copy as Ctx["copy"], collectionId, badge, slots: slotsIn.value, resolved, stored,
      designRef: stored.steps.upload_design?.ref ?? null, listingRef: stored.steps.create_listing?.ref ?? null, productId: fresh.product_id, note,
    };
    for (const [key, fn] of STEP_FNS) {
      const t0 = Date.now();
      try {
        const out = await fn(ctx);
        if (key === "upload_design") ctx.designRef = out.ref ?? ctx.designRef;
        if (key === "create_listing") ctx.listingRef = out.ref ?? ctx.listingRef;
        stored.steps[key] = { status: out.status, note: out.note, ref: out.ref ?? null, refs: out.refs ?? null };
        results.push({ key, label: labels[key], status: out.status, note: out.note });
        safeTrack(env, a.uid, "admin2_studio_publish_step", { design_id: id, step: key, status: out.status, ms: Date.now() - t0 });
      } catch (e) {
        const message = msgOf(e);
        await trackException(env, e, { uid: a.uid, route: `admin2_studio:publish:${key}`, handled: true, app_name: APP, extra: { design_id: id } });
        stored.steps[key] = { status: "failed", note: message };
        results.push({ key, label: labels[key], status: "failed", note: message });
        safeTrack(env, a.uid, "admin2_studio_publish_step", { design_id: id, step: key, status: "failed", ms: Date.now() - t0 });
        await saveProgress(env, id, stored);
        break;
      }
      await saveProgress(env, id, stored);
    }

    const failed = results.filter((r) => r.status === "failed").length;
    if (!failed) {
      await env.DB_META.prepare(
        `UPDATE studio_designs SET status='live', locked_at=COALESCE(locked_at,?2), product_id=?3, step='publish', updated_at=?2 WHERE id=?1`,
      ).bind(id, Date.now(), ctx.productId).run();
    }
    await audit(env, a.uid, "studio_publish", id, { product_id: ctx.productId, failed, provider: provider.id });
    safeTrack(env, a.uid, "admin2_studio_published", { design_id: id, steps_failed: failed, provider: provider.id, product_id: ctx.productId, version: fresh.version });
  } finally {
    try { await env.DB_META.prepare("UPDATE studio_designs SET copy_json=json_remove(COALESCE(copy_json,'{}'),'$.publish_lock') WHERE id=?1").bind(id).run(); }
    catch (e) { await trackException(env, e, { uid: a.uid, route: "admin2_studio:publish_unlock", handled: true, app_name: APP }); }
  }
  const latest = await loadDesign(env, id);
  return json({ design: await designJson(env, latest!), steps: pendingSteps(results, labels) });
});

// ---------------------------------------------------------------------------
export const ADMIN2_STUDIO_ROUTES: Admin2RouteDef[] = [
  { method: "GET", path: `${BASE}/designs`, handler: listDesigns },
  { method: "POST", path: `${BASE}/designs`, handler: createDesign },
  { method: "GET", path: re(`designs/${ID}`), handler: getDesign },
  { method: "PUT", path: re(`designs/${ID}`), handler: updateDesign },
  { method: "DELETE", path: re(`designs/${ID}`), handler: retireDesign },
  { method: "POST", path: re(`designs/${ID}/art`), handler: uploadArt },
  { method: "POST", path: re(`designs/${ID}/art-preview`), handler: uploadArtPreview },
  { method: "GET", path: re(`designs/${ID}/fits`), handler: getFits },
  { method: "PUT", path: re(`designs/${ID}/products`), handler: putProducts },
  { method: "PUT", path: re(`designs/${ID}/placement`), handler: putPlacement },
  { method: "POST", path: re(`designs/${ID}/print`), handler: uploadPrint },
  { method: "POST", path: re(`designs/${ID}/print-preview`), handler: uploadPrintPreview },
  { method: "GET", path: re(`designs/${ID}/file/art`), handler: streamArt },
  { method: "GET", path: re(`designs/${ID}/file/print`), handler: streamPrint },
  { method: "POST", path: re(`designs/${ID}/new-version`), handler: newVersion },
  { method: "POST", path: re(`designs/${ID}/photos`), handler: uploadPhoto },
  { method: "PUT", path: re(`photos/${ID}`), handler: updatePhoto },
  { method: "POST", path: re(`designs/${ID}/copy-ai`), handler: copyAi },
  { method: "POST", path: re(`designs/${ID}/publish`), handler: publish },
];
