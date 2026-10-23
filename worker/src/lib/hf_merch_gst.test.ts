import { describe, it, expect } from "vitest";
import { DEFAULT_GST_TABLE, GST_CATEGORY_SLUGS, frozenOrFallback, gstRowFor, needsHsnConfirm, parseGstTable, validateGstTable } from "./hf_merch_gst";
import { CATEGORY_ORDER } from "./hf_merch_families";
import { readMerchCfg } from "./hf_merch_math";

describe("[HF-MERCH-GST-1] per-category GST table", () => {
  it("has a default row for every STUDIO-2 category", () => {
    expect([...GST_CATEGORY_SLUGS].sort()).toEqual(CATEGORY_ORDER.map((c) => c.slug).sort());
  });
  it("clothing is 5% with the cap, everything else 18% with no cap and a blank HSN", () => {
    expect(DEFAULT_GST_TABLE.tshirts).toEqual({ hsn: "6109", rateBps: 500, capApplies: true });
    expect(DEFAULT_GST_TABLE.hoodies).toEqual({ hsn: "6110", rateBps: 500, capApplies: true });
    for (const s of ["bottoms", "jackets"]) expect(DEFAULT_GST_TABLE[s]).toMatchObject({ rateBps: 500, capApplies: true });
    for (const s of ["accessories", "home", "phone", "other"]) { expect(DEFAULT_GST_TABLE[s]).toEqual({ hsn: "", rateBps: 1800, capApplies: false }); expect(needsHsnConfirm(DEFAULT_GST_TABLE[s])).toBe(true); }
  });
  it("an empty, missing or junk setting gives the defaults", () => {
    for (const raw of [undefined, null, "", "not json", "[]", "42", {}]) expect(parseGstTable(raw)).toEqual(DEFAULT_GST_TABLE);
  });
  it("valid rows overlay the defaults, bad rows are ignored", () => {
    const t = parseGstTable(JSON.stringify({ home: { hsn: "6912", rateBps: 1200, capApplies: false }, phone: { hsn: "abc", rateBps: 1800, capApplies: false }, tshirts: { hsn: "6109", rateBps: 9999, capApplies: true }, extra: { hsn: "", rateBps: 0, capApplies: false } }));
    expect(t.home).toEqual({ hsn: "6912", rateBps: 1200, capApplies: false });
    expect(t.phone).toEqual(DEFAULT_GST_TABLE.phone);
    expect(t.tshirts).toEqual(DEFAULT_GST_TABLE.tshirts);
    expect(t.extra).toEqual({ hsn: "", rateBps: 0, capApplies: false });
  });
  it("the admin PUT validation refuses a bad row and fills missing categories", () => {
    expect(validateGstTable("{")).toMatchObject({ ok: false });
    expect(validateGstTable([])).toMatchObject({ ok: false });
    expect(validateGstTable({ home: { hsn: "12", rateBps: 1800, capApplies: false } })).toMatchObject({ ok: false });
    expect(validateGstTable({ home: { hsn: "", rateBps: 3000, capApplies: false } })).toMatchObject({ ok: false });
    expect(validateGstTable({ home: { hsn: "", rateBps: 1800, capApplies: "no" } })).toMatchObject({ ok: false });
    const ok = validateGstTable({ home: { hsn: "6912", rateBps: 1200, capApplies: false } });
    expect(ok.ok && ok.table.home.rateBps).toBe(1200);
    expect(ok.ok && ok.table.tshirts).toEqual(DEFAULT_GST_TABLE.tshirts);
  });
  it("an unknown category falls back to the flat rate + HSN with the cap; a frozen block wins over the settings", () => {
    expect(gstRowFor(DEFAULT_GST_TABLE, "zzz", { rateBps: 500, hsn: "6109" })).toEqual({ hsn: "6109", rateBps: 500, capApplies: true });
    expect(gstRowFor(DEFAULT_GST_TABLE, null, { rateBps: 500, hsn: "6109" })).toEqual({ hsn: "6109", rateBps: 500, capApplies: true });
    expect(frozenOrFallback({ rateBps: 1800, hsn: "", capApplies: false }, { rateBps: 500, hsn: "6109" })).toEqual({ rateBps: 1800, hsn: "", capApplies: false });
    expect(frozenOrFallback(undefined, { rateBps: 500, hsn: "6109" })).toEqual({ hsn: "6109", rateBps: 500, capApplies: true });
    expect(frozenOrFallback({ rateBps: 99999 }, { rateBps: 500, hsn: "6109" })).toEqual({ hsn: "6109", rateBps: 500, capApplies: true });
  });
  it("readMerchCfg parses hfMerchGstTable and keeps the flat fallback", () => {
    const c = readMerchCfg({ hfMerchGstRateBps: 1200, hfMerchHsn: "6110", hfMerchGstTable: JSON.stringify({ home: { hsn: "6912", rateBps: 1200, capApplies: false } }) });
    expect(c.gstTable.home.rateBps).toBe(1200);
    expect(c.gstRateBps).toBe(1200);
    expect(c.hsn).toBe("6110");
    expect(readMerchCfg({}).gstTable).toEqual(DEFAULT_GST_TABLE);
  });
});
