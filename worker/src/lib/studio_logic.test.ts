// [AUMFE-POD-STUDIO-API-1] Unit tests for the Shop Studio pure logic.
import { describe, it, expect } from "vitest";
import { PRINT_SPECS } from "./pod";
import {
  artChecksFromInfo, audienceFor, buildFits, checkPrintFile, cleanBrowserChecks, cleanColours, cleanPrices, cleanProducts, cleanSlots,
  contrastRatio, fallbackBestText, fallbackCopy, looksFaded, orderPhotosForShop, parseCopyReply, parseImageInfo, partnerPlacement,
  pendingSteps, photoChecks, photoCoverage, pickBest, printTypeFor, resolveVariants, resumeSteps, shopPrice, sizeRank, sniffImageMime,
  summariseCatalog, validatePlacement, variantSku, STEP_KEYS, type Placement,
} from "./studio_logic";

// --- tiny image builders ----------------------------------------------------
function png(w: number, h: number, colourType: number, extra: Array<[string, number[]]> = []): Uint8Array {
  const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: number[]) => { out.push(...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0); };
  chunk("IHDR", [...u32(w), ...u32(h), 8, colourType, 0, 0, 0]);
  for (const [t, d] of extra) chunk(t, d);
  chunk("IDAT", [0]);
  chunk("IEND", []);
  return new Uint8Array(out);
}
function jpeg(w: number, h: number, comps: number): Uint8Array {
  const sof = [0xff, 0xc0, 0, 8 + comps * 3, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, comps, ...Array(comps * 3).fill(0)];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, ...sof, 0xff, 0xd9]);
}
function webpVp8x(w: number, h: number, alpha: boolean): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0], 0);
  b[20] = alpha ? 0x10 : 0;
  const w1 = w - 1, h1 = h - 1;
  b[24] = w1 & 255; b[25] = (w1 >> 8) & 255; b[26] = (w1 >> 16) & 255;
  b[27] = h1 & 255; b[28] = (h1 >> 8) & 255; b[29] = (h1 >> 16) & 255;
  return b;
}

describe("image headers", () => {
  it("reads PNG size and alpha", () => {
    expect(parseImageInfo(png(3300, 3300, 6))).toMatchObject({ mime: "image/png", w: 3300, h: 3300, has_alpha: true, rgb: true });
    expect(parseImageInfo(png(10, 20, 2))).toMatchObject({ w: 10, h: 20, has_alpha: false });
    expect(parseImageInfo(png(10, 20, 3, [["tRNS", [0]]]))?.has_alpha).toBe(true);
  });
  it("reads JPEG size and flags CMYK", () => {
    expect(parseImageInfo(jpeg(3000, 4000, 3))).toMatchObject({ mime: "image/jpeg", w: 3000, h: 4000, rgb: true, has_alpha: false });
    expect(parseImageInfo(jpeg(100, 100, 4))?.rgb).toBe(false);
  });
  it("reads WebP VP8X", () => {
    expect(parseImageInfo(webpVp8x(1200, 800, true))).toMatchObject({ mime: "image/webp", w: 1200, h: 800, has_alpha: true });
  });
  it("rejects junk and truncated files", () => {
    expect(sniffImageMime(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(parseImageInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull();
    expect(parseImageInfo(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("print file check", () => {
  it("accepts a PNG with alpha within limits", () => {
    expect(checkPrintFile(parseImageInfo(png(3300, 3300, 6)), 1_000_000)).toEqual({ ok: true });
  });
  it("rejects no-alpha, oversized pixels, oversized bytes, and non-PNG", () => {
    expect(checkPrintFile(parseImageInfo(png(100, 100, 2)), 10)).toMatchObject({ ok: false, code: "no_alpha" });
    expect(checkPrintFile(parseImageInfo(png(5001, 100, 6)), 10)).toMatchObject({ ok: false, code: "too_big_px" });
    expect(checkPrintFile(parseImageInfo(png(100, 100, 6)), 16 * 1024 * 1024)).toMatchObject({ ok: false, status: 413 });
    expect(checkPrintFile(parseImageInfo(jpeg(100, 100, 3)), 10)).toMatchObject({ ok: false, status: 415 });
    expect(checkPrintFile(null, 10)).toMatchObject({ ok: false, status: 415 });
  });
});

describe("contrast / faded", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(contrastRatio("nope", "#fff")).toBeNull();
  });
  it("gold art looks faded on white and yellow, not on black or navy", () => {
    const gold = ["#d4a017"];
    expect(looksFaded(gold, "#ffffff")).toBe(true);
    expect(looksFaded(gold, "#f5d90a")).toBe(true);
    expect(looksFaded(gold, "#000000")).toBe(false);
    expect(looksFaded(gold, "#1f2a44")).toBe(false);
  });
  it("never claims faded when a colour is unknown", () => {
    expect(looksFaded([], "#ffffff")).toBe(false);
    expect(looksFaded(["#d4a017"], null)).toBe(false);
  });
});

const catalogProduct = {
  provider_product_id: "p1", name: "Round neck tee", kind: "mens_tee",
  variants: [
    { provider_variant_id: "v1", colour: "Black", colour_hex: "#000000", size: "M", base_cost_paise: 18000 },
    { provider_variant_id: "v2", colour: "Black", colour_hex: "#000000", size: "XL", base_cost_paise: 19000 },
    { provider_variant_id: "v3", colour: "White", colour_hex: "#ffffff", size: "M", base_cost_paise: null },
    { provider_variant_id: "v4", colour: "Black", colour_hex: "#000000", size: "2XL", base_cost_paise: 20000, sku: "SKU-4" },
  ],
};

describe("catalogue + fits", () => {
  it("summarises colours, sorted sizes and the lowest cost", () => {
    const s = summariseCatalog(catalogProduct);
    expect(s.colours.map((c) => c.name)).toEqual(["Black", "White"]);
    expect(s.sizes).toEqual(["M", "XL", "2XL"]);
    expect(s.cost_from_paise).toBe(18000);
  });
  it("orders sizes S..3XL and kids sizes", () => {
    expect(["3XL", "S", "XL", "M", "2XL", "L"].sort((a, b) => sizeRank(a) - sizeRank(b))).toEqual(["S", "M", "L", "XL", "2XL", "3XL"]);
    expect(sizeRank("2-3Y")).toBeLessThan(sizeRank("5-6Y"));
  });
  it("builds a fit row per kind and side with faded flags and picks the best", () => {
    const fits = buildFits(3300, 3300, [summariseCatalog(catalogProduct)], ["#d4a017"]);
    expect(fits).toHaveLength(Object.keys(PRINT_SPECS.areas).length * 2); // every kind x front/back
    const men = fits.find((f) => f.kind === "mens_tee" && f.side === "front")!;
    expect(men.area_in).toEqual([15.6, 19.6]);
    expect(men.catalog?.colours.find((c) => c.name === "White")?.faded).toBe(true);
    expect(men.catalog?.colours.find((c) => c.name === "Black")?.faded).toBe(false);
    expect(fits.find((f) => f.kind === "hoodie")!.catalog).toBeNull();
    const best = pickBest(fits)!;
    expect(["great", "good"]).toContain(best.verdict);
  });
  it("pickBest returns null when everything is too small and the fallback text says so", () => {
    const fits = buildFits(200, 200, [], []);
    expect(pickBest(fits)).toBeNull();
    expect(fallbackBestText(null, 200, 200, [])).toMatch(/too small/);
  });
  it("fallback text names the product and the faded colours", () => {
    const fits = buildFits(3300, 3300, [summariseCatalog(catalogProduct)], ["#d4a017"]);
    const t = fallbackBestText(pickBest(fits), 3300, 3300, ["White"]);
    expect(t).toMatch(/square/);
    expect(t).toMatch(/White/);
  });
});

const goodPlacement = {
  kind: "mens_tee", side: "front", shape: "circle", frame_w_in: 11, frame_h_in: 11, frame_top_in: 2.5, zoom_pct: 100,
  nudge_x_in: 0, nudge_y_in: 0, print_w_in: 11, print_h_in: 11, dpi: 300,
};
describe("placement validation", () => {
  it("accepts a good placement and rounds values", () => {
    const r = validatePlacement({ ...goodPlacement, frame_w_in: 11.004, frame_h_in: 11.004 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.placement.frame_w_in).toBe(11);
  });
  it("rejects a frame outside the print area", () => {
    expect(validatePlacement({ ...goodPlacement, frame_w_in: 17, frame_h_in: 17 })).toMatchObject({ ok: false, code: "outside_print_area" });
    expect(validatePlacement({ ...goodPlacement, frame_top_in: 12 })).toMatchObject({ ok: false, code: "outside_print_area" });
  });
  it("rejects dpi under 150 as too_blurry but allows 150", () => {
    expect(validatePlacement({ ...goodPlacement, dpi: 149 })).toMatchObject({ ok: false, status: 400, code: "too_blurry" });
    expect(validatePlacement({ ...goodPlacement, dpi: 150 }).ok).toBe(true);
  });
  it("rejects bad shapes, kinds, zoom and non-square circle", () => {
    expect(validatePlacement({ ...goodPlacement, shape: "star" }).ok).toBe(false);
    expect(validatePlacement({ ...goodPlacement, kind: "cape" }).ok).toBe(false);
    expect(validatePlacement({ ...goodPlacement, zoom_pct: 20 }).ok).toBe(false);
    expect(validatePlacement({ ...goodPlacement, frame_h_in: 9 })).toMatchObject({ ok: false });
    expect(validatePlacement({ ...goodPlacement, dpi: "x" }).ok).toBe(false);
    expect(validatePlacement(null).ok).toBe(false);
  });
  it("keeps print_left_in / print_top_in and defaults them when absent", () => {
    const withPos = validatePlacement({ ...goodPlacement, print_left_in: 1.5, print_top_in: 3 });
    if (!withPos.ok) throw new Error("setup");
    expect(withPos.placement).toMatchObject({ print_left_in: 1.5, print_top_in: 3 });
    expect(partnerPlacement(withPos.placement)).toEqual({ side: "front", width_in: 11, height_in: 11, top_in: 3, left_in: 1.5 });
    const dflt = validatePlacement(goodPlacement);
    if (!dflt.ok) throw new Error("setup");
    expect(dflt.placement).toMatchObject({ print_left_in: 2.3, print_top_in: 2.5 });
  });
  it("rejects a print position that is negative, not a number, or runs off the area", () => {
    expect(validatePlacement({ ...goodPlacement, print_left_in: -1 })).toMatchObject({ ok: false, field: "print_left_in" });
    expect(validatePlacement({ ...goodPlacement, print_top_in: "a" })).toMatchObject({ ok: false, field: "print_top_in" });
    expect(validatePlacement({ ...goodPlacement, print_left_in: 5 })).toMatchObject({ ok: false, code: "outside_print_area", field: "print_left_in" });
    expect(validatePlacement({ ...goodPlacement, print_top_in: 9 })).toMatchObject({ ok: false, code: "outside_print_area", field: "print_top_in" });
    expect(validatePlacement({ ...goodPlacement, print_left_in: 4.6, print_top_in: 8.6 }).ok).toBe(true);
  });
  it("partnerPlacement falls back to centred / frame_top for old stored placements", () => {
    const old = { ...(goodPlacement as unknown as Placement) };
    expect(partnerPlacement(old)).toEqual({ side: "front", width_in: 11, height_in: 11, top_in: 2.5, left_in: 2.3 });
  });
  it("centres the print file on the area for the partner", () => {
    const p = validatePlacement(goodPlacement);
    if (!p.ok) throw new Error("setup");
    expect(partnerPlacement(p.placement)).toEqual({ side: "front", width_in: 11, height_in: 11, top_in: 2.5, left_in: 2.3 });
  });
});

describe("browser art checks", () => {
  it("whitelists and clamps", () => {
    const r = cleanBrowserChecks({ trimmed_px: 12.4, soft_edge_pct: 140, dominant_colours: ["#D4A017", "bad", "#000000"], cmyk_converted: true, evil: 1 });
    expect(r).toEqual({ ok: true, value: { trimmed_px: 12, soft_edge_pct: 100, dominant_colours: ["#d4a017", "#000000"], cmyk_converted: true } });
  });
  it("rejects empty and wrong types", () => {
    expect(cleanBrowserChecks({}).ok).toBe(false);
    expect(cleanBrowserChecks({ cmyk_converted: "yes" }).ok).toBe(false);
    expect(cleanBrowserChecks([]).ok).toBe(false);
  });
  it("art checks from header info", () => {
    expect(artChecksFromInfo(parseImageInfo(png(10, 10, 6))!, 99, "a.png")).toMatchObject({ w: 10, h: 10, bytes: 99, mime: "image/png", has_alpha: true, rgb: true, file_name: "a.png" });
  });
});

describe("photos", () => {
  it("checks short side and sold colour", () => {
    expect(photoChecks(3000, 4000, "Black", ["black", "Maroon"])).toEqual({ size_ok: true, colour_sold: true });
    expect(photoChecks(900, 1200, "Navy", ["Black"])).toEqual({ size_ok: false, colour_sold: false });
    expect(photoChecks(1200, 5000, null, ["Black"])).toEqual({ size_ok: true, colour_sold: false });
    expect(photoChecks(null, null, "Black", ["Black"]).size_ok).toBe(false);
  });
  it("coverage counts only kept model photos for the headline and flats separately", () => {
    const cov = photoCoverage(["Black", "Maroon", "Off-white"], [
      { kind: "model", colour: "black", status: "kept" }, { kind: "model", colour: "Black", status: "kept" },
      { kind: "model", colour: "Maroon", status: "removed" }, { kind: "flat", colour: "Maroon", status: "kept" },
    ]);
    expect(cov).toEqual([{ colour: "Black", photos: 2, flat: 0 }, { colour: "Maroon", photos: 0, flat: 1 }, { colour: "Off-white", photos: 0, flat: 0 }]);
  });
  it("orders shop images: model main first, then models, then flats, then close-up; drops removed", () => {
    const mk = (id: string, kind: string, sort: number, is_main = 0, status = "kept") => ({ id, kind, colour: null, url: id, sort, is_main, status });
    const out = orderPhotosForShop([mk("c", "closeup", 5), mk("f", "flat", 4), mk("m2", "model", 1), mk("m1", "model", 2, 1), mk("gone", "model", 0, 0, "removed")]);
    expect(out.map((p) => p.id)).toEqual(["m1", "m2", "f", "c"]);
  });
});

describe("input cleaners", () => {
  it("colours: unique, hex required, names resolve hex from the catalogue", () => {
    const map = new Map<string, string | null>([["black", "#000000"]]);
    expect(cleanColours(["Black"], map)).toEqual({ ok: true, value: [{ name: "Black", hex: "#000000" }] });
    expect(cleanColours([{ name: "Maroon", hex: "#800000" }, { name: "maroon", hex: "#800000" }]).ok).toBe(false);
    expect(cleanColours([{ name: "Teal", hex: "teal" }]).ok).toBe(false);
    expect(cleanColours("x").ok).toBe(false);
  });
  it("prices: whole rupees only", () => {
    expect(cleanPrices({ S: 799, XL: 799 })).toEqual({ ok: true, value: { S: 799, XL: 799 } });
    expect(cleanPrices({ S: 79.5 }).ok).toBe(false);
    expect(cleanPrices({ S: 0 }).ok).toBe(false);
    expect(cleanPrices([]).ok).toBe(false);
  });
  it("products: kind/side/id required and unique", () => {
    expect(cleanProducts([{ kind: "mens_tee", provider_product_id: "p1", side: "front" }]).ok).toBe(true);
    expect(cleanProducts([{ kind: "cape", provider_product_id: "p1", side: "front" }]).ok).toBe(false);
    expect(cleanProducts([{ kind: "hoodie", provider_product_id: "p", side: "front" }, { kind: "hoodie", provider_product_id: "p", side: "front" }]).ok).toBe(false);
  });
  it("slots: subset of the allowed list, deduped", () => {
    expect(cleanSlots(["new_arrivals", "new_arrivals"], ["new_arrivals", "sale"])).toEqual({ ok: true, value: ["new_arrivals"] });
    expect(cleanSlots(["hero"], ["sale"]).ok).toBe(false);
    expect(cleanSlots(undefined, ["sale"])).toEqual({ ok: true, value: [] });
  });
});

describe("copy draft", () => {
  it("parses a fenced JSON reply and rejects junk", () => {
    expect(parseCopyReply('```json\n{"name":"Gold Trishul","description":"A calm print. [FABRIC]","seo_title":"Gold Trishul tee"}\n```')).toEqual({ name: "Gold Trishul", description: "A calm print. [FABRIC]", seo_title: "Gold Trishul tee" });
    expect(parseCopyReply("sorry")).toBeNull();
    expect(parseCopyReply('{"name":"x","description":"y"}')).toBeNull();
  });
  it("fallback keeps a [FABRIC] gap and never invents facts", () => {
    const f = fallbackCopy("Trishul gold", "Men's T-shirt", ["Black", "Maroon"]);
    expect(f.description).toContain("[FABRIC]");
    expect(f.description).toContain("Black, Maroon");
    expect(f.name).toBe("Trishul gold");
  });
});

describe("publish planning", () => {
  const chosen = [{ name: "Black", hex: "#000000" }, { name: "Navy", hex: "#1f2a44" }];
  it("maps chosen colours x priced sizes and reports what the catalogue lacks", () => {
    const r = resolveVariants(chosen, catalogProduct, { M: 799, XL: 799, "2XL": 850, S: 799 });
    expect(r.colours.map((c) => c.name)).toEqual(["Black"]);
    expect(r.sizes).toEqual(["M", "XL", "2XL"]);
    expect(r.rows).toHaveLength(3);
    expect(r.missing).toContain("Navy M");
    expect(r.missing).toContain("Black S");
  });
  it("shop price = lowest S-XL price, flags non-uniform sizes", () => {
    expect(shopPrice({ S: 799, M: 799, XL: 849, "2XL": 899 }, ["S", "M", "XL", "2XL"])).toEqual({ price: 799, uniform: false });
    expect(shopPrice({ M: 799, "2XL": 799 }, ["M", "2XL"])).toEqual({ price: 799, uniform: true });
    expect(shopPrice({ "2XL": 900, "3XL": 950 }, ["2XL", "3XL"]).price).toBe(900);
    expect(shopPrice({}, []).price).toBe(0);
  });
  it("print type and audience", () => {
    const p = (o: Partial<Placement>) => ({ ...(goodPlacement as unknown as Placement), ...o });
    expect(printTypeFor(p({ side: "back" }))).toBe("Back print");
    expect(printTypeFor(p({ print_w_in: 11 }))).toBe("Big front print");
    expect(printTypeFor(p({ print_w_in: 4 }))).toBe("Chest print");
    expect(audienceFor("kids_tee")).toBe("Kids");
    expect(audienceFor("mens_tee")).toBe("Adults");
  });
  it("resume ignores progress from another print-file version", () => {
    const saved = { version: 1, steps: { upload_design: { status: "done", note: "x", ref: "d1" } } };
    expect(resumeSteps(saved, 1).steps.upload_design?.ref).toBe("d1");
    expect(resumeSteps(saved, 2)).toEqual({ version: 2, steps: {} });
    expect(resumeSteps(null, 1)).toEqual({ version: 1, steps: {} });
  });
  it("pendingSteps fills the steps that did not run, in order", () => {
    const labels = Object.fromEntries(STEP_KEYS.map((k) => [k, k])) as Record<(typeof STEP_KEYS)[number], string>;
    const out = pendingSteps([{ key: "upload_design", label: "u", status: "done", note: "" }, { key: "create_listing", label: "c", status: "failed", note: "boom" }], labels);
    expect(out.map((s) => `${s.key}:${s.status}`)).toEqual(["upload_design:done", "create_listing:failed", "variant_map:pending", "shop_product:pending", "slots:pending"]);
  });
  it("sku keeps the partner's, else is deterministic", () => {
    expect(variantSku("dsn-1", 2, "Off-white", "2XL", "SKU-9")).toBe("SKU-9");
    expect(variantSku("dsn-1", 2, "Off-white", "2XL")).toBe("dsn-1-v2-off-white-2xl");
  });
});
