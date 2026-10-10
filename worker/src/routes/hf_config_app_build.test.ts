// [HF-NATIVE-S7] hfAppLatestBuild / hfAppMinBuild: default 0, public in /api/config, settable as NUMBERS after deploy (the fake-flag rule).
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../authz", () => ({
  requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "admin" }),
  isFail: (u: any) => !!u?.error,
}));

import { getConfig, putConfig, readConfig, bustConfigMemo } from "./config";

let store: Map<string, unknown>;
const env: any = {
  ADMIN_UIDS: "admin",
  TOKENS: {
    get: async (k: string, t?: string) => { const v = store.get(k); return v === undefined ? null : t === "json" ? JSON.parse(JSON.stringify(v)) : String(v); },
    put: async (k: string, v: string) => { store.set(k, JSON.parse(v)); },
    delete: async (k: string) => { store.delete(k); },
  },
};
const put = (body: unknown, uid = "admin") =>
  putConfig(new Request("https://x/api/admin/config", { method: "PUT", headers: { "content-type": "application/json", "x-test-uid": uid }, body: JSON.stringify(body) }), env);

beforeEach(() => { store = new Map(); bustConfigMemo(); });

describe("HF app build keys [HF-NATIVE-S7]", () => {
  it("default to 0 (never prompt) and are in the PUBLIC config", async () => {
    const pub = await (await getConfig(env)).json();
    expect(pub.hfAppLatestBuild).toBe(0);
    expect(pub.hfAppMinBuild).toBe(0);
  });

  it("an admin can set them after deploy; they come back as numbers in /api/config and server reads", async () => {
    const r = await put({ hfAppLatestBuild: 2007, hfAppMinBuild: 2003 });
    expect(r.status).toBe(200);
    bustConfigMemo();
    const pub = await (await getConfig(env)).json();
    expect(pub.hfAppLatestBuild).toBe(2007);
    expect(pub.hfAppMinBuild).toBe(2003);
    expect(typeof pub.hfAppLatestBuild).toBe("number");
    expect((await readConfig(env)).hfAppMinBuild).toBe(2003);
  });

  it("a string value is refused (numeric key, bad type), so a stray quote cannot make it text", async () => {
    const r = await put({ hfAppLatestBuild: "2010" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/bad type/);
    bustConfigMemo();
    expect((await readConfig(env)).hfAppLatestBuild).toBe(0);
  });

  it("rejects negative, fractional and absurd values", async () => {
    for (const v of [-1, 1.5, 1e12]) {
      const r = await put({ hfAppMinBuild: v });
      expect(r.status).toBe(400);
    }
  });

  it("only admins can set them", async () => {
    expect((await put({ hfAppLatestBuild: 5 }, "someone")).status).toBe(403);
  });
});
