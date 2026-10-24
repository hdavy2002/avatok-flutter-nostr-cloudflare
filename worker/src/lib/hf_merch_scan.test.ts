// [HF-MERCH-QA-1] Big merch art is scanned from a small copy at product creation; any failure stays 'unscanned' and never throws.
import { describe, it, expect } from "vitest";
import { scanDesignImage, type ScanDeps } from "./hf_merch_scan";

// A minimal JPEG header (SOI + SOF0 with 16x16) that parseImageInfo can read.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
const env: any = {};
const okFetch = (seen: string[] = []) => (async (u: string, init: any) => { seen.push(u); expect(init.cf.image.format).toBe("jpeg"); return new Response(JPEG, { status: 200 }); }) as unknown as typeof fetch;
const deps = (o: Partial<ScanDeps> = {}): ScanDeps => ({ fetcher: okFetch(), scan: async () => ({ ok: true, blocked: false, label: "safe" }), ...o });

describe("scanDesignImage", () => {
  it("scans the print preview first and reports ok", async () => {
    const seen: string[] = [];
    const r = await scanDesignImage(env, "u1", ["https://b/print.png", "https://b/art.png"], deps({ fetcher: okFetch(seen) }));
    expect(r.moderation).toBe("ok");
    expect(seen).toEqual(["https://b/print.png"]);
  });
  it("falls back to the art when the print preview cannot be read", async () => {
    const seen: string[] = [];
    const fetcher = (async (u: string) => { seen.push(u); return u.includes("print") ? new Response("x", { status: 404 }) : new Response(JPEG); }) as unknown as typeof fetch;
    const r = await scanDesignImage(env, "u1", ["https://b/print.png", "https://b/art.png"], deps({ fetcher }));
    expect(r.moderation).toBe("ok");
    expect(seen).toEqual(["https://b/print.png", "https://b/art.png"]);
  });
  it("a blocked picture is reported as blocked", async () => {
    const r = await scanDesignImage(env, "u1", ["https://b/print.png"], deps({ scan: async () => ({ ok: true, blocked: true, label: "nsfw" }) }));
    expect(r).toMatchObject({ moderation: "blocked", blocked: true, label: "nsfw" });
  });
  it("a model failure stays unscanned (never a pass)", async () => {
    const r = await scanDesignImage(env, "u1", ["https://b/print.png"], deps({ scan: async () => ({ ok: false, blocked: true, label: "scan_error" }) }));
    expect(r).toMatchObject({ moderation: "unscanned", blocked: false });
  });
  it("a throwing model or fetch never throws", async () => {
    const boom = (async () => { throw new Error("x"); }) as unknown as typeof fetch;
    expect((await scanDesignImage(env, "u1", ["https://b/p.png"], deps({ fetcher: boom }))).moderation).toBe("unscanned");
    expect((await scanDesignImage(env, "u1", ["https://b/p.png"], deps({ scan: async () => { throw new Error("y"); } }))).moderation).toBe("unscanned");
  });
  it("no usable url, or a copy that is not an image, stays unscanned", async () => {
    expect((await scanDesignImage(env, "u1", [null, undefined, "http://insecure/x.png"], deps())).moderation).toBe("unscanned");
    const notImg = (async () => new Response("hello")) as unknown as typeof fetch;
    expect((await scanDesignImage(env, "u1", ["https://b/p.png"], deps({ fetcher: notImg })))).toMatchObject({ moderation: "unscanned", reason: "no_copy" });
  });
});
