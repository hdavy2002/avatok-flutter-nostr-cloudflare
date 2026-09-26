// [SAATHUM-CHADHAVA 2026-09-26] Route table for the chadhava catalogue
// (routes/saathum_chadhava.ts), matched the same way admin2_events.test.ts checks
// its own route table (matchAdmin2 against the exported route array).
import { describe, it, expect } from "vitest";
import { matchAdmin2 } from "../src/routes/admin2";
import { ADMIN2_CHADHAVA_ROUTES } from "../src/routes/saathum_chadhava";

describe("chadhava admin route table", () => {
  const m = (method: string, p: string) => {
    const hit = matchAdmin2(method, p, ADMIN2_CHADHAVA_ROUTES);
    return hit && "route" in hit ? { path: String(hit.route.path), params: hit.params } : hit;
  };
  it("matches list, create, update and delete", () => {
    expect(m("GET", "/api/admin/v2/chadhava")).toEqual({ path: "/api/admin/v2/chadhava", params: [] });
    expect(m("POST", "/api/admin/v2/chadhava")).toEqual({ path: "/api/admin/v2/chadhava", params: [] });
    expect((m("PUT", "/api/admin/v2/chadhava/chadhava-abc12345") as any).params).toEqual(["chadhava-abc12345"]);
    expect((m("DELETE", "/api/admin/v2/chadhava/chadhava-abc12345") as any).params).toEqual(["chadhava-abc12345"]);
  });
  it("decodes an encoded id", () => {
    expect((m("PUT", "/api/admin/v2/chadhava/abc%2D1") as any).params).toEqual(["abc-1"]);
  });
  it("refuses a wrong method on a known path", () => {
    expect(m("DELETE", "/api/admin/v2/chadhava")).toEqual({ methodNotAllowed: true });
  });
  it("does not match an unrelated path", () => {
    expect(m("GET", "/api/admin/v2/events")).toBeNull();
  });
});
