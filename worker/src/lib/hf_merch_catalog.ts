// [HF-MERCH-CORE-1 2026-10-23] Catalogue, base-price quoting and partner listing for influencer merch. The ONLY partner contact is through lib/pod
// (getPodProvider / ensurePodCatalog / computeSizeCosts); no partner field name appears here.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { trackException } from "../hooks";
import { ensurePodCatalog, getPodProvider, referenceShippingRupees, loadStoredCatalog, syncCatalogToDb, PRINT_SPECS } from "./pod";
import type { CatalogProduct, PodProvider } from "./pod";
import { computeSizeCosts, partnerPlacement, sortSizes, variantSku, type Placement } from "./studio_logic";
import { baseUnitPaise, splitBase, profitRow, youEarnUnitPaise, type MerchCfg, type ProfitRow } from "./hf_merch_math";
import { categoryOf, categoryRank, familyOf, type Family } from "./hf_merch_families";
import { parseJson, type MerchSnapshot, type ProductMerch } from "./hf_merch_types";

const TEE_KIND = /_tee$/;
/** Kept for callers that still ask "is this a T-shirt kind"; the merch shop now sells every printable kind (isMerchKind). */
export const isTeeKind = (k: string): boolean => TEE_KIND.test(k);
/** [HF-MERCH-STUDIO-2] Any kind except the unclassified `other` is sellable. */
export const isMerchKind = (k: string): boolean => !!k && k !== "other";
/** A live re-quote older than this triggers a catalogue refresh first. */
export const LIVE_QUOTE_MAX_AGE_MS = 60 * 60 * 1000;

export type PrintAreas = { front?: { wIn: number; hIn: number }; back?: { wIn: number; hIn: number } };
export type CatalogItem = {
  id: string; kind: string; name: string; category: string; categoryLabel: string; family: Family;
  /** Only the sides this product has a print area for. */
  side: Array<"front" | "back">; printAreas: PrintAreas; /** The first side's area. */ printArea: { wIn: number; hIn: number };
  colours: Array<{ name: string; hex: string }>; sizes: Array<{ size: string; basePaise: number; baseRupees: number; printingPaise: number; shippingPaise: number }>; mockupUrl?: string; imageUrl?: string;
};

function colourList(p: CatalogProduct): Array<{ name: string; hex: string }> {
  const seen = new Map<string, string>();
  for (const v of p.variants) if (!seen.has(v.colour.toLowerCase())) seen.set(v.colour.toLowerCase(), v.colour_hex ?? "#cccccc");
  return [...new Map(p.variants.map((v) => [v.colour.toLowerCase(), { name: v.colour, hex: v.colour_hex ?? "#cccccc" }])).values()];
}
/** The print area [w, h] in inches for a side, or null when the product has none there. The partner's own area wins; a product whose partner
 *  data lists areas for some side only offers those sides; PRINT_SPECS is the fallback for the legacy garment kinds with no partner area. */
export const areaOrNull = (p: Pick<CatalogProduct, "kind" | "print_area_in">, side: "front" | "back"): [number, number] | null => {
  const own = p.print_area_in?.[side];
  if (own && own[0] > 0 && own[1] > 0) return [own[0], own[1]];
  if (p.print_area_in && (p.print_area_in.front || p.print_area_in.back)) return null;
  const spec = (PRINT_SPECS.areas as Record<string, { front: readonly [number, number]; back: readonly [number, number] } | undefined>)[p.kind];
  return spec ? [spec[side][0], spec[side][1]] : null;
};
export const areaOf = (p: Pick<CatalogProduct, "kind" | "print_area_in">, side: "front" | "back"): [number, number] => areaOrNull(p, side) ?? [12, 14];
export const sidesOf = (p: Pick<CatalogProduct, "kind" | "print_area_in">): Array<"front" | "back"> => (["front", "back"] as const).filter((s) => areaOrNull(p, s) !== null);

export type BaseQuote =
  | { ok: true; sizes: Array<{ size: string; baseUnitPaise: number; printingPaise: number; shippingPaise: number; bufferPaise: number }>; shippingRupees: number | null }
  | { ok: false; error: "catalog_unavailable" | "unknown_product" | "no_sizes"; message: string };

/** Per-size base price (paise, whole rupees, buffer included) for printing w x h inches on `side` in the chosen colours. */
export async function quoteBases(
  env: Env, cfg: MerchCfg, a: { catalogId: string; colours: string[]; side: "front" | "back"; wIn: number; hIn: number; sizes?: string[] },
): Promise<BaseQuote & { product?: CatalogProduct }> {
  const info = await ensurePodCatalog(env);
  if (info.source !== "printrove") return { ok: false, error: "catalog_unavailable", message: "Prices are not available right now. Please try again in a little while." };
  const prod = info.products.find((p) => p.provider_product_id === a.catalogId && isMerchKind(p.kind));
  if (!prod) return { ok: false, error: "unknown_product", message: "That product is not available." };
  const shipping = await referenceShippingRupees(env);
  const costs = computeSizeCosts(prod, a.colours, a.side, a.wIn, a.hIn, shipping);
  const want = a.sizes ? new Set(a.sizes.map((s) => s.toLowerCase())) : null;
  const sizes: Array<{ size: string; baseUnitPaise: number; printingPaise: number; shippingPaise: number; bufferPaise: number }> = [];
  for (const c of costs) {
    if (!c.in_stock || c.total_rupees == null || (want && !want.has(c.size.toLowerCase()))) continue;
    const parts = splitBase(c.total_rupees, shipping, cfg.baseBufferRupees);
    if (parts) sizes.push({ size: c.size, ...parts });
  }
  if (!sizes.length) return { ok: false, error: "no_sizes", message: "That product cannot be priced in those colours." };
  return { ok: true, sizes, shippingRupees: shipping, product: prod };
}

export async function merchCatalog(env: Env, cfg: MerchCfg): Promise<{ ok: true; items: CatalogItem[]; shippingPaise: number; bufferPaise: number } | { ok: false; error: string; message: string }> {
  const info = await ensurePodCatalog(env);
  if (info.source !== "printrove") return { ok: false, error: "catalog_unavailable", message: "The product catalogue is not available right now." };
  const shipping = await referenceShippingRupees(env);
  const items: CatalogItem[] = [];
  for (const p of info.products) {
    if (!isMerchKind(p.kind)) continue;
    const sides = sidesOf(p);
    if (!sides.length) continue; // no print area on any side: cannot be printed
    const printAreas: PrintAreas = {};
    for (const s of sides) { const a = areaOrNull(p, s) as [number, number]; printAreas[s] = { wIn: a[0], hIn: a[1] }; }
    const first = sides[0];
    const [w, h] = areaOrNull(p, first) as [number, number];
    // "Up to" price: the biggest print the product takes (first side). The wizard re-quotes the real size through /quote as the art is placed.
    const costs = computeSizeCosts(p, [], first, w, h, shipping);
    const sizes = costs.filter((c) => c.in_stock && c.total_rupees != null).map((c) => {
      const parts = splitBase(c.total_rupees as number, shipping, cfg.baseBufferRupees);
      const base = parts?.baseUnitPaise ?? 0;
      return { size: c.size, basePaise: base, baseRupees: Math.round(base / 100), printingPaise: parts?.printingPaise ?? 0, shippingPaise: parts?.shippingPaise ?? 0 };
    }).filter((s) => s.basePaise > 0);
    if (!sizes.length) continue;
    const cat = categoryOf(p.kind);
    items.push({
      id: p.provider_product_id, kind: p.kind, name: p.name, category: cat.slug, categoryLabel: cat.label, family: familyOf(p.kind, p.name),
      side: sides, printAreas, printArea: { wIn: w, hIn: h }, colours: colourList(p), sizes, ...(p.image_url ? { imageUrl: p.image_url } : {}),
    });
  }
  items.sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.name.localeCompare(b.name));
  return { ok: true, items, shippingPaise: Math.max(0, Math.round((shipping ?? 0) * 100)), bufferPaise: cfg.baseBufferRupees * 100 };
}

/** Today's reference shipping in paise (0 when unavailable): the stand-in for products made before the breakdown was frozen. */
export async function legacyShippingPaise(env: Env): Promise<number> {
  try { return Math.max(0, Math.round(((await referenceShippingRupees(env)) ?? 0) * 100)); } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Live re-quote at approval
// ---------------------------------------------------------------------------
export type LiveBase = { ok: true; liveBaseUnitPaise: number; stale: boolean; source: string } | { ok: false; error: "quote_unavailable"; message: string };

export async function liveBaseUnitForOrder(env: Env, snap: Partial<MerchSnapshot>, pincode: string | null): Promise<LiveBase> {
  const fail = (message: string): LiveBase => ({ ok: false, error: "quote_unavailable", message });
  try {
    if (!snap.catalogId || !snap.colour || !snap.size || !snap.side || !snap.printWIn || !snap.printHIn) return fail("This order has no price snapshot to compare with.");
    let stored = await loadStoredCatalog(env, "printrove");
    let stale = false;
    const age = stored.synced_at == null ? Infinity : Date.now() - stored.synced_at;
    if (!stored.products.length || age > LIVE_QUOTE_MAX_AGE_MS) {
      try { await syncCatalogToDb(env, "printrove"); stored = await loadStoredCatalog(env, "printrove"); }
      catch (e) { stale = true; await trackException(env, e, { route: "hf_merch:live_quote_sync", handled: true, app_name: "hf_merch" }); }
    }
    const prod = stored.products.find((p) => p.provider_product_id === snap.catalogId);
    if (!prod) return fail("The product is no longer in the catalogue.");
    let shipping = await referenceShippingRupees(env);
    let source = "reference_shipping";
    if (pincode) {
      try {
        const provider = await getPodProvider(env, "printrove");
        const s = await provider.serviceability(pincode, 300 * Math.max(1, Number(snap.qty ?? 1)));
        if (!s.ok) return fail("The print partner cannot deliver to this pincode right now.");
        if (typeof s.shipping_cost_rupees === "number") { shipping = s.shipping_cost_rupees; source = "pincode_quote"; }
      } catch { stale = true; }
    }
    const row = computeSizeCosts(prod, [snap.colour], snap.side, snap.printWIn, snap.printHIn, shipping).find((c) => c.size.toLowerCase() === String(snap.size).toLowerCase());
    if (!row || !row.in_stock || row.total_rupees == null) return fail("The partner does not quote this size and colour right now.");
    const base = baseUnitPaise(row.total_rupees, Number(snap.bufferRupees ?? 0));
    if (base == null) return fail("The partner returned no price.");
    return { ok: true, liveBaseUnitPaise: base, stale, source };
  } catch (e) {
    await trackException(env, e, { route: "hf_merch:live_quote", handled: true, app_name: "hf_merch" });
    return fail("The live price could not be fetched.");
  }
}

// ---------------------------------------------------------------------------
// Partner listing (done when the product is approved / goes live)
// ---------------------------------------------------------------------------
export type ProvisionResult = { ok: true; skipped: boolean; designRef: string | null; listingRef: string | null } | { ok: false; message: string };

async function upsertListing(env: Env, productId: string, provider: string, designId: string, version: number, designRef: string, status: string): Promise<void> {
  await metaDb(env).prepare(
    `INSERT INTO pod_listings (product_id, provider, design_id, design_version, provider_design_ref, provider_listing_ref, status, error, published_at)
     VALUES (?1,?2,?3,?4,?5,NULL,?6,NULL,NULL)
     ON CONFLICT(product_id, provider) DO UPDATE SET design_id=excluded.design_id, design_version=excluded.design_version, provider_design_ref=excluded.provider_design_ref,
       status=CASE WHEN pod_listings.status='listed' AND pod_listings.design_version=excluded.design_version THEN pod_listings.status ELSE excluded.status END, error=NULL`,
  ).bind(productId, provider, designId, version, designRef, status).run();
}

/** Upload the print file and create the partner listing for an influencer product. Idempotent (a listed product is left alone). */
export async function provisionPartnerListing(
  env: Env, productId: string, designId: string, merch: ProductMerch, title: string,
): Promise<ProvisionResult> {
  try {
    const db = metaDb(env);
    const info = await ensurePodCatalog(env);
    const provider: PodProvider | null = info.source === "printrove" ? await getPodProvider(env).catch(() => null) : null;
    const d = await db.prepare("SELECT id, version, print_key FROM studio_designs WHERE id=?1").bind(designId).first<{ id: string; version: number; print_key: string | null }>();
    if (!d || !d.print_key) return { ok: false, message: "The print file is missing." };
    if (!provider || !provider.supportsApi) {
      await upsertListing(env, productId, provider?.id ?? "manual", d.id, d.version, d.id, "manual");
      return { ok: true, skipped: true, designRef: d.id, listingRef: null };
    }
    const existing = await db.prepare("SELECT status, provider_listing_ref AS l, provider_design_ref AS d, design_version AS v FROM pod_listings WHERE product_id=?1 AND provider=?2").bind(productId, provider.id)
      .first<{ status: string; l: string | null; d: string | null; v: number | null }>();
    if (existing?.status === "listed" && existing.l && Number(existing.v) === d.version) return { ok: true, skipped: true, designRef: existing.d, listingRef: existing.l };
    const prod = info.products.find((p) => p.provider_product_id === merch.catalogId);
    if (!prod) return { ok: false, message: "The product is no longer in the partner catalogue." };
    const obj = await env.DIGITAL.get(d.print_key);
    if (!obj) return { ok: false, message: "The print file is missing from storage." };
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const { design_ref } = await provider.uploadDesign(bytes, `${d.id}-v${d.version}.png`);
    await upsertListing(env, productId, provider.id, d.id, d.version, design_ref, "design_uploaded");
    const placement = merch.placement as unknown as Placement;
    const maps = (await db.prepare("SELECT colour, size, provider_variant_id, sku FROM pod_variant_map WHERE product_id=?1 AND provider=?2 AND active=1").bind(productId, provider.id)
      .all<{ colour: string; size: string; provider_variant_id: string; sku: string | null }>()).results ?? [];
    if (!maps.length) return { ok: false, message: "No sizes or colours are linked to this product." };
    const out = await provider.createListing({
      name: title.slice(0, 80), provider_product_id: merch.catalogId, design_ref, placement: partnerPlacement(placement),
      variants: maps.map((m) => ({ provider_variant_id: m.provider_variant_id, sku: variantSku(d.id, d.version, m.colour, m.size, m.sku ?? undefined) })),
    });
    await db.prepare("UPDATE pod_listings SET provider_listing_ref=?3, status='listed', error=NULL, published_at=?4 WHERE product_id=?1 AND provider=?2").bind(productId, provider.id, out.listing_ref, Date.now()).run();
    return { ok: true, skipped: false, designRef: design_ref, listingRef: out.listing_ref };
  } catch (e) {
    await trackException(env, e, { route: "hf_merch:provision", handled: true, app_name: "hf_merch", extra: { product_id: productId } });
    return { ok: false, message: (e instanceof Error ? e.message : String(e)).slice(0, 240) };
  }
}

export const sizesOf = (merch: ProductMerch | null): string[] => sortSizes((merch?.sizes ?? []).map((s) => s.size));
export const parseProductMerch = (raw: string | null): ProductMerch | null => { const m = parseJson<ProductMerch | null>(raw, null); return m && m.v === 1 ? m : null; };

// ---------------------------------------------------------------------------
// [HF-MERCH-PROFIT-VIEW-1] Admin profit table
// ---------------------------------------------------------------------------
export type ProfitBlock = { shippingPaise: number; rows: ProfitRow[]; live: boolean; note?: string };
const toPaise = (rupees: number): number => Math.round(rupees * 100);

/** Live catalogue + reference shipping, fetched ONCE per admin request. products is null when the live catalogue is unavailable. */
export type ProfitCtx = { products: CatalogProduct[] | null; shippingRupees: number | null };
export async function profitContext(env: Env): Promise<ProfitCtx> {
  try {
    const info = await ensurePodCatalog(env);
    const shippingRupees = await referenceShippingRupees(env);
    return { products: info.source === "printrove" ? info.products : null, shippingRupees };
  } catch (e) {
    await trackException(env, e, { route: "hf_merch:profit_ctx", handled: true, app_name: "hf_merch" });
    return { products: null, shippingRupees: null };
  }
}

/** Per frozen size: Printrove cost TODAY (garment + print + Printrove GST, no shipping; max across the chosen colours) against the frozen fan price. */
export function buildProductProfit(ctx: ProfitCtx, cfg: MerchCfg, merch: ProductMerch | null, markupRupees: number): ProfitBlock {
  const shipPaise = toPaise(ctx.shippingRupees ?? 0);
  const markup = Math.trunc(markupRupees) * 100;
  const inf = youEarnUnitPaise(markup, cfg.platformShareBps);
  if (!merch) return { shippingPaise: shipPaise, rows: [], live: false, note: "This product has no price data." };
  const prod = ctx.products?.find((p) => p.provider_product_id === merch.catalogId);
  const pl = merch.placement as { print_w_in?: number; print_h_in?: number };
  const costs = prod && pl.print_w_in && pl.print_h_in
    ? computeSizeCosts(prod, merch.colours.map((c) => c.name), merch.side, pl.print_w_in, pl.print_h_in, null) : [];
  let allLive = !!prod && costs.length > 0;
  const rows = merch.sizes.map((s) => {
    const c = costs.find((x) => x.size.toLowerCase() === s.size.toLowerCase());
    const liveOk = !!c && c.in_stock && c.total_rupees != null;
    if (!liveOk) allLive = false;
    const cost = liveOk ? toPaise(c!.total_rupees as number) : Math.max(0, s.baseUnitPaise - shipPaise - cfg.baseBufferRupees * 100);
    return profitRow({ size: s.size, printroveCostPaise: cost, shippingPaise: shipPaise, fanPaysPaise: s.baseUnitPaise + markup, markupPaise: markup, influencerPaise: inf, gstRateBps: cfg.gstRateBps, cashfreeFeeBps: cfg.cashfreeFeeBps });
  });
  const notes: string[] = [];
  if (!allLive) notes.push("Printrove's live prices could not be read, so the Printrove cost is worked back from the price set when the product was made.");
  if (ctx.shippingRupees == null) notes.push("Printrove's shipping quote could not be checked, so shipping is shown as Rs 0.");
  return { shippingPaise: shipPaise, rows, live: allLive, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

/** One order: the ordered size x qty. Money is the order's frozen snapshot; Printrove cost and shipping are today's quote (falls back to the frozen base). */
export async function buildOrderProfit(env: Env, snap: Partial<MerchSnapshot>, pincode: string | null): Promise<ProfitBlock | null> {
  const m = snap.money;
  if (!m) return null;
  const qty = Math.max(1, m.qty);
  const ctx = await profitContext(env);
  let shipRupees = ctx.shippingRupees;
  let note: string | undefined;
  if (pincode) {
    try {
      const provider = await getPodProvider(env, "printrove");
      const s = await provider.serviceability(pincode, 300 * qty);
      if (s.ok && typeof s.shipping_cost_rupees === "number") shipRupees = s.shipping_cost_rupees;
    } catch { /* reference shipping stands */ }
  }
  const shipPaise = toPaise(shipRupees ?? 0);
  const prod = ctx.products?.find((p) => p.provider_product_id === snap.catalogId);
  let costPaise: number | null = null;
  if (prod && snap.colour && snap.side && snap.printWIn && snap.printHIn) {
    const c = computeSizeCosts(prod, [snap.colour], snap.side, snap.printWIn, snap.printHIn, null).find((x) => x.size.toLowerCase() === String(snap.size).toLowerCase());
    if (c && c.in_stock && c.total_rupees != null) costPaise = toPaise(c.total_rupees) * qty;
  }
  const live = costPaise != null;
  if (!live) {
    costPaise = Math.max(0, m.basePaise - shipPaise - Number(snap.bufferRupees ?? 0) * 100 * qty);
    note = "Printrove's live price could not be read, so the Printrove cost is worked back from the price frozen when the fan ordered.";
  }
  const row = profitRow({ size: String(snap.size ?? ""), printroveCostPaise: costPaise as number, shippingPaise: shipPaise, fanPaysPaise: m.totalPaise, markupPaise: m.markupPaise, influencerPaise: m.influencerPaise, gstRateBps: typeof m.gstRateBps === "number" ? m.gstRateBps : undefined, legacyGstBps: m.gstBps, cashfreeFeeBps: m.payMethod === "cashfree" ? m.cashfreeFeeBps : 0 });
  return { shippingPaise: shipPaise, rows: [row], live, ...(note ? { note } : {}) };
}
