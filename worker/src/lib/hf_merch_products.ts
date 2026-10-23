// [HF-MERCH-CORE-1 2026-10-23] Influencer product pipeline: art upload, print file, mockups, create / edit / delete, and the admin review.
// Reuses studio_designs (one row per influencer design, created_by = the influencer, step='merch' so Admin > Studio does not list it),
// shop_products (status always 'hidden'; review_status carries visibility), pod_variant_map and pod_listings. No partner field name here.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { sha256Hex } from "../util";
import { moderate, moderateGeneratedImage } from "./moderation";
import { ensurePodCatalog, isApparelKind } from "./pod";
import { IMAGE_EXT, LIMITS, checkPrintFile, parseImageInfo, validatePlacement, variantSku, type Placement } from "./studio_logic";
import { checkMarkup, type MerchCfg } from "./hf_merch_math";
import { areaOrNull, isMerchKind, provisionPartnerListing, quoteBases } from "./hf_merch_catalog";
import {
  getProduct, openOrdersForProduct, productMerch, shopSlugFor, type MerchHost, type MerchProductRow,
} from "./hf_merch_store";
import type { ProductMerch } from "./hf_merch_types";
import { merchFail, merchPush, merchTrack } from "./hf_merch_notify";
import { sendAdminAlert } from "./saathum_upi3";
import { BRAND } from "./brand";

export type PFail = { ok: false; status: number; error: string; message: string; extra?: Record<string, unknown> };
const fail = (status: number, error: string, message: string, extra?: Record<string, unknown>): PFail => ({ ok: false, status, error, message, extra });
const hex8 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

export const MERCH_ART_MAX_BYTES = 15 * 1024 * 1024;
export const MERCH_PRINT_MAX_BYTES = LIMITS.printBytes; // 15 MB; the spec's 5000 px cap is enforced by checkPrintFile
export const MERCH_MOCKUP_MAX_BYTES = 3 * 1024 * 1024;
export const MERCH_MAX_PRODUCTS = 100;
/** Moderation reads the image inline; bigger files are admin-reviewed instead of scanned. */
const SCAN_MAX_BYTES = 4 * 1024 * 1024;
const FULL_WIDTH_IN = 15.6;

async function putPublic(env: Env, uid: string, sub: string, bytes: Uint8Array, mime: string): Promise<string> {
  const hash = (await sha256Hex(bytes)).slice(0, 16);
  const ext = IMAGE_EXT[mime as keyof typeof IMAGE_EXT] ?? "bin";
  const key = `u/${uid}/public/merch/${sub}${hash}.${ext}`;
  await env.BLOBS.put(key, bytes, { httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" } });
  return `${env.BLOSSOM_BASE_URL}/${key}`;
}

// ---------------------------------------------------------------------------
// Art
// ---------------------------------------------------------------------------
export type ArtResult = { ok: true; artId: string; url: string; width: number; height: number; checks: { ok: boolean; dpiAtFullWidth: number; warnings: string[] } };

export async function saveMerchArt(env: Env, uid: string, bytes: Uint8Array, declaredMime: string, fileName: string): Promise<ArtResult | PFail> {
  if (declaredMime !== "image/png" && declaredMime !== "image/jpeg") return fail(415, "unsupported_type", "Upload your art as a PNG or JPEG.");
  if (!bytes.byteLength) return fail(400, "empty", "No file received.");
  if (bytes.byteLength > MERCH_ART_MAX_BYTES) return fail(413, "too_large", "The art must be 15 MB or smaller.");
  const info = parseImageInfo(bytes);
  if (!info || (info.mime !== "image/png" && info.mime !== "image/jpeg")) return fail(415, "unsupported_type", "That file is not a readable PNG or JPEG.");
  if (info.mime !== declaredMime) return fail(415, "type_mismatch", "The file is not the type it says it is.");
  if (info.w < 300 || info.h < 300) return fail(400, "too_small", "The art is too small to print well. Use at least 300 x 300 pixels.");
  let moderation: "ok" | "unscanned" = "unscanned";
  if (bytes.byteLength <= SCAN_MAX_BYTES) {
    const scan = await moderateGeneratedImage(env, uid, bytes);
    if (scan.ok && scan.blocked) {
      await merchTrack(env, uid, "merch_art_blocked", { label: scan.label, nsfw: scan.nsfw, violence: scan.violence });
      return fail(422, "art_blocked", "We cannot print this image. Please use different art.");
    }
    if (scan.ok) moderation = "ok";
  }
  const id = `dsn-${hex8()}`;
  const sha8 = (await sha256Hex(bytes)).slice(0, 8);
  const ext = IMAGE_EXT[info.mime];
  const key = `merch/${uid}/${id}/art-${sha8}.${ext}`;
  await env.DIGITAL.put(key, bytes, { httpMetadata: { contentType: info.mime }, customMetadata: { file_name: encodeURIComponent(fileName.slice(0, 200)) } });
  const url = await putPublic(env, uid, `${id}/art-`, bytes, info.mime);
  const now = Date.now();
  const dpiAtFullWidth = Math.round(info.w / FULL_WIDTH_IN);
  const warnings: string[] = [];
  if (dpiAtFullWidth < 150) warnings.push("At full size this may look blurry. Keep the art smaller on the product or upload a bigger file.");
  if (info.mime === "image/jpeg" || info.has_alpha === false) warnings.push("This image has a solid background, and it will print too. Use a PNG with a see-through background to print only your art.");
  if (info.rgb === false) warnings.push("This file is not RGB, so colours may print differently.");
  if (moderation === "unscanned") warnings.push("This image will be checked by our team before it goes on sale.");
  await metaDb(env).prepare(
    `INSERT INTO studio_designs (id, name, status, step, art_key, art_w, art_h, art_bytes, art_mime, art_checks_json, art_preview_url, products_json, version, colours_json, created_by, created_at, updated_at)
     VALUES (?1,?2,'draft','merch',?3,?4,?5,?6,?7,?8,?9,'[]',1,'[]',?10,?11,?11)`,
  ).bind(id, "Merch art", key, info.w, info.h, bytes.byteLength, info.mime, JSON.stringify({ w: info.w, h: info.h, bytes: bytes.byteLength, mime: info.mime, has_alpha: info.has_alpha, rgb: info.rgb, moderation }), url, uid, now).run();
  await merchTrack(env, uid, "merch_art_uploaded", { design_id: id, w: info.w, h: info.h, bytes: bytes.byteLength, moderation });
  return { ok: true, artId: id, url, width: info.w, height: info.h, checks: { ok: warnings.length === 0 || (warnings.length === 1 && moderation === "unscanned"), dpiAtFullWidth, warnings } };
}

type DesignRow = {
  id: string; name: string; step: string; art_key: string | null; art_preview_url: string | null; art_checks_json: string | null; print_key: string | null;
  print_w: number | null; print_h: number | null; print_preview_url: string | null; version: number; product_id: string | null; created_by: string | null; locked_at: number | null;
};
async function myDesign(env: Env, uid: string, id: string): Promise<DesignRow | null> {
  const d = await metaDb(env).prepare(
    "SELECT id, name, step, art_key, art_preview_url, art_checks_json, print_key, print_w, print_h, print_preview_url, version, product_id, created_by, locked_at FROM studio_designs WHERE id=?1",
  ).bind(id).first<DesignRow>();
  return d && d.created_by === uid && d.step === "merch" ? d : null;
}

export type PrintResult = { ok: true; printFileId: string; url: string; width: number; height: number };
export async function saveMerchPrintFile(env: Env, uid: string, artId: string, bytes: Uint8Array): Promise<PrintResult | PFail> {
  const d = await myDesign(env, uid, artId);
  if (!d) return fail(404, "not_found", "That art was not found. Upload it again.");
  if (d.locked_at || d.product_id) return fail(409, "locked", "This art is already on a product. Upload it again to make a new product.");
  if (bytes.byteLength > MERCH_PRINT_MAX_BYTES) return fail(413, "too_large", "The print file must be 15 MB or smaller.");
  const info = parseImageInfo(bytes);
  const check = checkPrintFile(info, bytes.byteLength);
  if (!check.ok || !info) { const c = check as Extract<typeof check, { ok: false }>; return fail(c.status, c.code, c.message); }
  const sha = await sha256Hex(bytes);
  const key = `merch/${uid}/${artId}/print-v${d.version}-${sha.slice(0, 8)}.png`;
  await env.DIGITAL.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  const url = bytes.byteLength <= 6 * 1024 * 1024 ? await putPublic(env, uid, `${artId}/print-`, bytes, "image/png") : (d.art_preview_url ?? "");
  await metaDb(env).prepare("UPDATE studio_designs SET print_key=?2, print_w=?3, print_h=?4, print_sha256=?5, print_preview_url=?6, updated_at=?7 WHERE id=?1")
    .bind(artId, key, info.w, info.h, sha, url || null, Date.now()).run();
  await merchTrack(env, uid, "merch_studio_step", { step: "print_file", design_id: artId, w: info.w, h: info.h });
  return { ok: true, printFileId: artId, url, width: info.w, height: info.h };
}

export async function saveMerchMockup(env: Env, uid: string, bytes: Uint8Array): Promise<{ ok: true; url: string } | PFail> {
  if (!bytes.byteLength) return fail(400, "empty", "No file received.");
  if (bytes.byteLength > MERCH_MOCKUP_MAX_BYTES) return fail(413, "too_large", "The picture must be 3 MB or smaller.");
  const info = parseImageInfo(bytes);
  if (!info) return fail(415, "unsupported_type", "The picture must be a PNG, JPEG or WebP image.");
  return { ok: true, url: await putPublic(env, uid, "mockup-", bytes, info.mime) };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
const slugify = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "merch";
const cleanText = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const ownMockup = (env: Env, uid: string, u: unknown): string | null =>
  typeof u === "string" && u.startsWith(`${env.BLOSSOM_BASE_URL}/u/${uid}/public/merch/`) && u.length < 400 ? u : null;

export type CreateInput = Record<string, unknown>;
export async function createMerchProduct(env: Env, cfg: MerchCfg, flags: { productReview: boolean }, host: MerchHost, b: CreateInput): Promise<{ ok: true; product: MerchProductRow } | PFail> {
  const uid = host.uid;
  const db = metaDb(env);
  if (b.ownArtConfirmed !== true) return fail(400, "own_art_required", "Please confirm the art is yours to use.", { field: "ownArtConfirmed" });
  const title = cleanText(b.title, 80);
  if (title.length < 2) return fail(400, "invalid_title", "Give your product a name (2 to 80 letters).", { field: "title" });
  const description = cleanText(b.description, 600);
  const mk = checkMarkup(b.markupRupees, cfg);
  if (!mk.ok) return fail(400, mk.error, mk.message, { field: "markupRupees" });
  const side = b.side === "back" ? "back" : b.side === "front" ? "front" : null;
  if (!side) return fail(400, "invalid_side", "Pick front or back.", { field: "side" });
  const catalogId = cleanText(b.catalogId, 80);
  const artId = cleanText(b.artId, 40), printFileId = cleanText(b.printFileId, 40);
  if (!artId || !printFileId || artId !== printFileId) return fail(400, "art_required", "Upload your art and save the print file first.", { field: "artId" });
  const count = await db.prepare("SELECT COUNT(*) AS c FROM shop_products WHERE seller_uid=?1 AND deleted_at IS NULL").bind(uid).first<{ c: number }>();
  if (Number(count?.c ?? 0) >= MERCH_MAX_PRODUCTS) return fail(409, "too_many_products", `You can have up to ${MERCH_MAX_PRODUCTS} products. Delete one to add another.`);
  const design = await myDesign(env, uid, artId);
  if (!design || !design.print_key || !design.print_w || !design.print_h) return fail(404, "art_not_found", "We could not find your art or print file. Upload them again.");
  if (design.product_id || design.locked_at) return fail(409, "art_used", "This art is already on a product. Upload it again for a new one.");

  const text = await moderate(env, { text: `${title}. ${description}`.trim(), field: "listing_title" }).catch(() => null);
  if (text && text.ok && !text.safe) return fail(422, "text_blocked", text.reason || "Please change the name or description.", { field: "title" });

  const info = await ensurePodCatalog(env);
  if (info.source !== "printrove") return fail(503, "catalog_unavailable", "Products are not available to add right now. Please try again in a little while.");
  const prod = info.products.find((p) => p.provider_product_id === catalogId && isMerchKind(p.kind));
  if (!prod) return fail(400, "unknown_product", "Pick one of the products shown.", { field: "catalogId" });
  const wantColours = Array.isArray(b.colours) ? (b.colours as unknown[]).map((c) => cleanText(c, 40).toLowerCase()).filter(Boolean) : [];
  const wantSizes = Array.isArray(b.sizes) ? (b.sizes as unknown[]).map((c) => cleanText(c, 12).toLowerCase()).filter(Boolean) : [];
  if (!wantColours.length || wantColours.length > 8) return fail(400, "invalid_colours", "Pick 1 to 8 colours.", { field: "colours" });
  if (!wantSizes.length) return fail(400, "invalid_sizes", "Pick at least one size.", { field: "sizes" });
  const colours = [...new Map(prod.variants.filter((v) => wantColours.includes(v.colour.toLowerCase())).map((v) => [v.colour.toLowerCase(), { name: v.colour, hex: v.colour_hex ?? "#cccccc" }])).values()];
  if (colours.length !== new Set(wantColours).size) return fail(400, "invalid_colours", "One of those colours is not made for this product.", { field: "colours" });

  // Where the print sits on the product. x / y / w / h are inches on the print area (top-left origin), the print file is w x h inches.
  const pl = (b.placement && typeof b.placement === "object" ? b.placement : {}) as Record<string, unknown>;
  const n = (k: string): number => Number(pl[k]);
  const frame = pl.frame === "square" || pl.frame === "circle" || pl.frame === "rect" ? pl.frame : "none";
  const w = n("w"), h = n("h"), x = n("x"), y = n("y");
  if (![w, h, x, y].every(Number.isFinite) || w <= 0 || h <= 0) return fail(400, "invalid_placement", "Place your art on the product first.", { field: "placement" });
  // The frame is the SHAPE the art is clipped to; the print rectangle (w x h) may be larger than a square/circle frame. Validate the frame box, not the print box.
  const boxed = frame === "square" || frame === "circle";
  const frameSide = Math.min(w, h);
  const area = areaOrNull(prod, side);
  if (!area) return fail(400, "invalid_side", `This product has no ${side} print area. Pick the other side.`, { field: "side" });
  const pv = validatePlacement({
    kind: prod.kind, side, shape: frame, frame_w_in: boxed ? frameSide : w, frame_h_in: boxed ? frameSide : h, frame_top_in: boxed ? y + (h - frameSide) / 2 : y, zoom_pct: Number.isFinite(n("zoom")) && n("zoom") > 0 ? n("zoom") : 100,
    nudge_x_in: 0, nudge_y_in: 0, print_w_in: w, print_h_in: h, dpi: design.print_w / w, print_left_in: x, print_top_in: y,
  }, area);
  if (!pv.ok) return fail(400, pv.code, pv.message, { field: "placement" });
  if (pv.placement.print_w_in > area[0] + 0.05 || pv.placement.print_h_in > area[1] + 0.05) return fail(400, "outside_print_area", "The print is bigger than this product's print area.", { field: "placement" });

  const quote = await quoteBases(env, cfg, { catalogId, colours: colours.map((c) => c.name), side, wIn: pv.placement.print_w_in, hIn: pv.placement.print_h_in, sizes: wantSizes });
  if (!quote.ok) return fail(quote.error === "catalog_unavailable" ? 503 : 400, quote.error, quote.message);
  if (quote.sizes.length !== new Set(wantSizes).size) return fail(400, "invalid_sizes", "One of those sizes is not made in these colours.", { field: "sizes" });

  const mockups = (Array.isArray(b.mockupUrls) ? (b.mockupUrls as unknown[]) : []).map((u) => ownMockup(env, uid, u)).filter((u): u is string => !!u).slice(0, 6);
  const artChecks = (() => { try { return JSON.parse(design.art_checks_json ?? "{}") as { moderation?: string }; } catch { return {}; } })();
  const moderation = artChecks.moderation === "ok" ? "ok" : "unscanned";
  // Review ON (default) or an unscanned image: wait for an admin. Review OFF and scanned: live at once.
  const goLive = !flags.productReview && moderation === "ok";

  const base = slugify(title);
  let productSlug = base;
  for (let i = 2; i < 10; i++) {
    const taken = await db.prepare("SELECT 1 AS x FROM shop_products WHERE slug=?1").bind(shopSlugFor(host.slug, productSlug)).first();
    if (!taken) break;
    productSlug = `${base}-${i}`;
  }
  if (await db.prepare("SELECT 1 AS x FROM shop_products WHERE slug=?1").bind(shopSlugFor(host.slug, productSlug)).first()) productSlug = `${base}-${hex8()}`;

  const merch: ProductMerch = {
    v: 1, productSlug, provider: "printrove", catalogId, catalogName: prod.name, kind: prod.kind, side, sizes: quote.sizes, bufferRupees: cfg.baseBufferRupees, colours,
    placement: pv.placement as unknown as Record<string, unknown>, mockups, printPreviewUrl: design.print_preview_url, artUrl: design.art_preview_url, moderation, approvedAt: null, hiddenBy: null, listing: null,
  };
  const pid = `prd-${hex8()}`;
  const now = Date.now();
  const minPriceRupees = Math.min(...quote.sizes.map((s) => s.baseUnitPaise)) / 100 + mk.markupRupees;
  const image = mockups[0] ?? design.print_preview_url ?? design.art_preview_url ?? "";
  const stmts = [
    db.prepare(
      `INSERT INTO shop_products (id, slug, name, description, fit, print_type, audience, price_rupees, colours_json, sizes_json, images_json, badge, status, sold_count, created_at, updated_at,
         seller_uid, review_status, review_note, markup_rupees, design_id, deleted_at, merch_json)
       VALUES (?1,?2,?3,?4,'Regular',?5,'Adults',?6,?7,?8,?9,'','hidden',0,?10,?10,?11,?12,NULL,?13,?14,NULL,?15)`,
    ).bind(pid, shopSlugFor(host.slug, productSlug), title, description, !isApparelKind(prod.kind) ? "Printed" : side === "back" ? "Back print" : pv.placement.print_w_in >= 8 ? "Big front print" : "Chest print",
      Math.max(1, Math.min(100000, Math.round(minPriceRupees))), JSON.stringify(colours), JSON.stringify(quote.sizes.map((s) => s.size)),
      JSON.stringify(image ? [{ url: image, label: "Front" }] : []), now, uid, goLive ? "live" : "pending", mk.markupRupees, artId, JSON.stringify(merch)),
    db.prepare(
      "UPDATE studio_designs SET name=?2, status='ready', products_json=?3, placement_json=?4, colours_json=?5, product_id=?6, updated_at=?7 WHERE id=?1",
    ).bind(artId, title, JSON.stringify([{ kind: prod.kind, provider_product_id: catalogId, side }]), JSON.stringify(pv.placement), JSON.stringify(colours), pid, now),
  ];
  for (const c of colours) for (const s of quote.sizes) {
    const v = prod.variants.find((x) => x.colour.toLowerCase() === c.name.toLowerCase() && x.size.toLowerCase() === s.size.toLowerCase());
    if (!v) continue;
    stmts.push(db.prepare(
      `INSERT INTO pod_variant_map (product_id, colour, size, provider, provider_variant_id, base_cost_paise, sku, active) VALUES (?1,?2,?3,'printrove',?4,?5,?6,1)
       ON CONFLICT(product_id, colour, size, provider) DO UPDATE SET provider_variant_id=excluded.provider_variant_id, base_cost_paise=excluded.base_cost_paise, sku=excluded.sku, active=1`,
    ).bind(pid, c.name, s.size, v.provider_variant_id, v.base_cost_paise ?? null, variantSku(artId, design.version, c.name, s.size, v.sku)));
  }
  await db.batch(stmts);

  let row = (await getProduct(env, pid)) as MerchProductRow;
  if (goLive) {
    const prov = await provisionPartnerListing(env, pid, artId, merch, title);
    if (!prov.ok) {
      await db.prepare("UPDATE shop_products SET review_status='pending', review_note=?2, updated_at=?3 WHERE id=?1").bind(pid, `The print partner listing failed: ${prov.message}`.slice(0, 280), Date.now()).run();
    } else {
      merch.approvedAt = now; merch.listing = { designRef: prov.designRef, listingRef: prov.listingRef, error: null };
      await db.prepare("UPDATE shop_products SET merch_json=?2 WHERE id=?1").bind(pid, JSON.stringify(merch)).run();
    }
    row = (await getProduct(env, pid)) as MerchProductRow;
  }
  await merchTrack(env, uid, "merch_product_created", { product_id: pid, catalog_id: catalogId, kind: prod.kind, side, markup_rupees: mk.markupRupees, status: row.review_status, moderation, sizes: quote.sizes.length, colours: colours.length });
  if (row.review_status === "pending") {
    try { await sendAdminAlert(env, `${BRAND.nameCompact} merch: new product to review - "${title}" by ${host.displayName}\nOpen admin > Merch > Products.`); } catch (e) { await merchFail(env, e, "review_alert", uid); }
  }
  return { ok: true, product: row };
}

// ---------------------------------------------------------------------------
// Edit / delete (influencer)
// ---------------------------------------------------------------------------
export async function patchMerchProduct(env: Env, cfg: MerchCfg, host: MerchHost, id: string, b: Record<string, unknown>): Promise<{ ok: true; product: MerchProductRow } | PFail> {
  const row = await getProduct(env, id);
  if (!row || row.seller_uid !== host.uid || row.deleted_at) return fail(404, "not_found", "No such product.");
  const sets: string[] = [], binds: unknown[] = [id];
  const add = (col: string, v: unknown) => { binds.push(v); sets.push(`${col}=?${binds.length}`); };
  if (b.markupRupees !== undefined) {
    const mk = checkMarkup(b.markupRupees, cfg);
    if (!mk.ok) return fail(400, mk.error, mk.message, { field: "markupRupees" });
    const m = productMerch(row);
    const lowest = Math.min(...(m?.sizes ?? [{ baseUnitPaise: 0 }]).map((s) => s.baseUnitPaise));
    add("markup_rupees", mk.markupRupees);
    add("price_rupees", Math.max(1, Math.min(100000, Math.round(lowest / 100) + mk.markupRupees)));
  }
  if (b.title !== undefined || b.description !== undefined) {
    const title = b.title === undefined ? row.name : cleanText(b.title, 80);
    const desc = b.description === undefined ? row.description : cleanText(b.description, 600);
    if (title.length < 2) return fail(400, "invalid_title", "Give your product a name (2 to 80 letters).", { field: "title" });
    const text = await moderate(env, { text: `${title}. ${desc}`, field: "listing_title" }).catch(() => null);
    if (text && text.ok && !text.safe) return fail(422, "text_blocked", text.reason || "Please change the name or description.", { field: "title" });
    add("name", title); add("description", desc);
  }
  if (b.hidden !== undefined) {
    const m = productMerch(row);
    if (b.hidden === true) {
      if (row.review_status === "live") { add("review_status", "hidden"); if (m) { m.hiddenBy = "seller"; add("merch_json", JSON.stringify(m)); } }
    } else if (row.review_status === "hidden") {
      if (m?.hiddenBy === "admin" || !m?.approvedAt) return fail(409, "hidden_by_admin", "This product was hidden by our team. Write to support to get it back.");
      add("review_status", "live"); m.hiddenBy = null; add("merch_json", JSON.stringify(m));
    }
  }
  if (!sets.length) return { ok: true, product: row };
  binds.push(Date.now());
  await metaDb(env).prepare(`UPDATE shop_products SET ${sets.join(", ")}, updated_at=?${binds.length} WHERE id=?1`).bind(...binds).run();
  return { ok: true, product: (await getProduct(env, id)) as MerchProductRow };
}

export async function deleteMerchProduct(env: Env, host: MerchHost, id: string): Promise<{ ok: true } | PFail> {
  const row = await getProduct(env, id);
  if (!row || row.seller_uid !== host.uid || row.deleted_at) return fail(404, "not_found", "No such product.");
  if ((await openOrdersForProduct(env, id)) > 0) return fail(409, "open_orders", "This product has orders that are not delivered yet. You can hide it instead.");
  await metaDb(env).prepare("UPDATE shop_products SET deleted_at=?2, review_status='hidden', updated_at=?2 WHERE id=?1 AND seller_uid=?3").bind(id, Date.now(), host.uid).run();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin review
// ---------------------------------------------------------------------------
export async function reviewMerchProduct(env: Env, adminUid: string, id: string, decision: string, note: string): Promise<{ ok: true; product: MerchProductRow } | PFail> {
  const row = await getProduct(env, id);
  if (!row || row.deleted_at) return fail(404, "not_found", "No such product.");
  const m = productMerch(row);
  if (!m) return fail(409, "bad_product", "This product has no merch details.");
  const db = metaDb(env), now = Date.now();
  const n = note.trim().slice(0, 280);
  if (decision === "approve") {
    const prov = await provisionPartnerListing(env, row.id, row.design_id ?? "", m, row.name);
    if (!prov.ok) {
      await db.prepare("UPDATE shop_products SET review_note=?2, updated_at=?3 WHERE id=?1").bind(id, `The print partner listing failed: ${prov.message}`.slice(0, 280), now).run();
      await merchFail(env, new Error(prov.message), "review_provision", adminUid, { product_id: id });
      return fail(502, "listing_failed", `The print partner would not list this product: ${prov.message}`);
    }
    m.approvedAt = now; m.hiddenBy = null; m.listing = { designRef: prov.designRef, listingRef: prov.listingRef, error: null };
    await db.prepare("UPDATE shop_products SET review_status='live', review_note=?2, merch_json=?3, updated_at=?4 WHERE id=?1").bind(id, n || null, JSON.stringify(m), now).run();
  } else if (decision === "reject") {
    if (!n) return fail(400, "note_required", "Tell the creator what to change.", { field: "note" });
    await db.prepare("UPDATE shop_products SET review_status='rejected', review_note=?2, updated_at=?3 WHERE id=?1").bind(id, n, now).run();
  } else if (decision === "hide") {
    m.hiddenBy = "admin";
    await db.prepare("UPDATE shop_products SET review_status='hidden', review_note=?2, merch_json=?3, updated_at=?4 WHERE id=?1").bind(id, n || null, JSON.stringify(m), now).run();
  } else return fail(400, "invalid_decision", "Decision must be approve, reject or hide.", { field: "decision" });
  const after = (await getProduct(env, id)) as MerchProductRow;
  await merchTrack(env, adminUid, "merch_product_reviewed", { product_id: id, seller_uid: row.seller_uid, decision, has_note: !!n });
  if (row.seller_uid) {
    const msg = decision === "approve" ? ["Your product is live", `${row.name} is on sale on your page.`] : decision === "reject" ? ["Your product needs a change", n] : ["Your product was hidden", n || `${row.name} is no longer on sale.`];
    await merchPush(env, row.seller_uid, "merch_update", msg[0], msg[1] || "Open the app to see more.", "/dashboard/merch");
  }
  return { ok: true, product: after };
}
