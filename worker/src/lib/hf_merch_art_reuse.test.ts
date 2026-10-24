// @ts-nocheck -- uses node:sqlite via the shared D1 shim
// [HF-MERCH-ART-REUSE-1] The same art on a second product: a used design is copied, never changed; the product uses the copy.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb } from "./hf_token_d1_shim";

const tracked: Array<{ event: string; props: any }> = [];
vi.mock("./hf_merch_notify", () => ({
  merchTrack: async (_e: any, _u: string, event: string, props: any) => { tracked.push({ event, props }); },
  merchFail: async () => {}, merchPush: async () => {},
}));
vi.mock("./saathum_upi3", () => ({ sendAdminAlert: async () => {} }));
import { saveMerchPrintFile, forkMerchDesign, designInUse, resolveArtForPrint } from "./hf_merch_products";

/** A PNG header the image sniffer accepts: w x h, RGBA (has alpha). */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13); b.set([73, 72, 68, 82], 12); dv.setUint32(16, w); dv.setUint32(20, h); b[24] = 8; b[25] = 6;
  return b;
}
const row = (env: any, id: string) => env.DB_META._raw.prepare("SELECT * FROM studio_designs WHERE id=?").get(id);
const rows = (env: any) => env.DB_META._raw.prepare("SELECT * FROM studio_designs ORDER BY created_at, id").all();

let env: any; let puts: string[];
beforeEach(() => {
  tracked.length = 0; puts = [];
  const bucket = { put: async (k: string) => { puts.push(k); } };
  env = { DB_META: makeDb(["2026-10-01-aumfe-pod.sql"]), DIGITAL: bucket, BLOBS: bucket, BLOSSOM_BASE_URL: "https://media.example" };
  const ins = env.DB_META._raw.prepare(
    `INSERT INTO studio_designs (id, name, status, step, art_key, art_w, art_h, art_bytes, art_mime, art_checks_json, art_preview_url, print_key, print_w, print_h, print_sha256, print_preview_url, version, locked_at, product_id, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,2048,2048,5000000,'image/png',?,?,?,?,?,?,?,?,?,?,?,1,1)`);
  // AI picture already on a product (deleted later, but the row keeps product_id): its print file must never change.
  ins.run("dsn-aaaaaaaa", "Lion tee", "ready", "merch", "merch/u1/dsn-aaaaaaaa/art-1.png", JSON.stringify({ moderation: "ok", has_alpha: false }), "https://media.example/u/u1/public/merch/dsn-aaaaaaaa/art-1.png",
    "merch/u1/dsn-aaaaaaaa/print-v1-old.png", 2793, 2793, "oldsha", "https://media.example/old-print.png", 1, null, "prd-11111111", "u1");
  // A fresh picture, never used.
  ins.run("dsn-bbbbbbbb", "Merch art", "draft", "merch", "merch/u1/dsn-bbbbbbbb/art-2.png", "{}", "https://media.example/u/u1/public/merch/dsn-bbbbbbbb/art-2.png", null, null, null, null, null, 1, null, null, "u1");
  // Someone else's used design, and an admin studio (non-merch) design.
  ins.run("dsn-cccccccc", "Theirs", "ready", "merch", "merch/u2/dsn-cccccccc/art.png", "{}", "https://media.example/c.png", "k", 10, 10, "s", null, 1, null, "prd-22222222", "u2");
  ins.run("dsn-dddddddd", "Admin", "live", "publish", "studio/x.png", "{}", "https://media.example/d.png", "k", 10, 10, "s", null, 1, 5, "prd-33333333", "u1");
});

describe("designInUse", () => {
  it("is true for a product or a lock", () => {
    expect(designInUse({ product_id: "prd-1", locked_at: null })).toBe(true);
    expect(designInUse({ product_id: null, locked_at: 5 })).toBe(true);
    expect(designInUse({ product_id: null, locked_at: null })).toBe(false);
  });
});

describe("print file on art already used", () => {
  it("copies the design, saves the print on the copy, and leaves the used row untouched", async () => {
    const before = row(env, "dsn-aaaaaaaa");
    const r = await saveMerchPrintFile(env, "u1", "dsn-aaaaaaaa", png(1000, 1000));
    expect(r.ok).toBe(true);
    expect(r.printFileId).toMatch(/^dsn-[a-f0-9]{8}$/);
    expect(r.printFileId).not.toBe("dsn-aaaaaaaa");
    expect(r.forkedFrom).toBe("dsn-aaaaaaaa");
    expect(row(env, "dsn-aaaaaaaa")).toEqual(before);
    const f = row(env, r.printFileId);
    expect(f).toMatchObject({
      created_by: "u1", step: "merch", status: "draft", name: "Lion tee", version: 1, product_id: null, locked_at: null,
      art_key: before.art_key, art_preview_url: before.art_preview_url, art_w: 2048, art_h: 2048, art_mime: "image/png", print_w: 1000, print_h: 1000,
    });
    const checks = JSON.parse(f.art_checks_json);
    expect(checks).toMatchObject({ moderation: "ok", has_alpha: false, forked_from: "dsn-aaaaaaaa" });
    expect(f.print_key).toMatch(new RegExp(`^merch/u1/${r.printFileId}/print-v1-`));
    expect(puts.every((k) => !k.includes("dsn-aaaaaaaa/print"))).toBe(true);
    expect(tracked.some((t) => t.event === "merch_art_forked" && t.props.from_design_id === "dsn-aaaaaaaa")).toBe(true);
  });
  it("each reuse of a used design makes its own copy; the copy, once free, is saved in place", async () => {
    const a = await saveMerchPrintFile(env, "u1", "dsn-aaaaaaaa", png(800, 800));
    const again = await saveMerchPrintFile(env, "u1", a.printFileId, png(900, 900));
    expect(again).toMatchObject({ ok: true, printFileId: a.printFileId });
    expect(again.forkedFrom).toBeUndefined();
    expect(row(env, a.printFileId).print_w).toBe(900);
    expect(rows(env)).toHaveLength(5);
  });
  it("a copy that is itself put on a product is copied again", async () => {
    const a = await saveMerchPrintFile(env, "u1", "dsn-aaaaaaaa", png(800, 800));
    env.DB_META._raw.prepare("UPDATE studio_designs SET product_id='prd-44444444' WHERE id=?").run(a.printFileId);
    const b = await saveMerchPrintFile(env, "u1", a.printFileId, png(800, 800));
    expect(b.ok && b.printFileId !== a.printFileId && b.forkedFrom === a.printFileId).toBe(true);
    expect(JSON.parse(row(env, b.printFileId).art_checks_json).forked_from).toBe(a.printFileId);
  });
  it("unused art is saved in place with no copy", async () => {
    const r = await saveMerchPrintFile(env, "u1", "dsn-bbbbbbbb", png(1000, 1000));
    expect(r).toMatchObject({ ok: true, printFileId: "dsn-bbbbbbbb" });
    expect(r.forkedFrom).toBeUndefined();
    expect(rows(env)).toHaveLength(4);
  });
  it("a bad print file never makes a copy", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const r = await saveMerchPrintFile(env, "u1", "dsn-aaaaaaaa", jpeg);
    expect(r.ok).toBe(false);
    expect(rows(env)).toHaveLength(4);
  });
  it("other people's art and admin designs are not found and never copied", async () => {
    expect(await saveMerchPrintFile(env, "u1", "dsn-cccccccc", png(800, 800))).toMatchObject({ ok: false, status: 404 });
    expect(await saveMerchPrintFile(env, "u1", "dsn-dddddddd", png(800, 800))).toMatchObject({ ok: false, status: 404 });
    expect(await forkMerchDesign(env, "u1", "dsn-cccccccc")).toBeNull();
    expect(rows(env)).toHaveLength(4);
  });
});

describe("create-product id pair from an older page or app", () => {
  it("the picture id plus its copy's print file resolves to the copy; anything else stays as sent", async () => {
    const a = await saveMerchPrintFile(env, "u1", "dsn-aaaaaaaa", png(800, 800));
    expect(await resolveArtForPrint(env, "u1", "dsn-aaaaaaaa", a.printFileId)).toBe(a.printFileId);
    expect(await resolveArtForPrint(env, "u1", a.printFileId, a.printFileId)).toBe(a.printFileId);
    expect(await resolveArtForPrint(env, "u1", "dsn-bbbbbbbb", a.printFileId)).toBe("dsn-bbbbbbbb"); // not its source
    expect(await resolveArtForPrint(env, "u2", "dsn-aaaaaaaa", a.printFileId)).toBe("dsn-aaaaaaaa"); // not the owner
    expect(await resolveArtForPrint(env, "u1", "dsn-aaaaaaaa", "dsn-bbbbbbbb")).toBe("dsn-aaaaaaaa");
  });
});
