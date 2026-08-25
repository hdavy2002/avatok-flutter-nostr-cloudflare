import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const routes = readFileSync(resolve(root, "src/routes/commercial_stream_sessions.ts"), "utf8");
const router = readFileSync(resolve(root, "src/index.ts"), "utf8");
const appSessionsApi = readFileSync(
  resolve(root, "../app/lib/core/commercial_sessions_api.dart"),
  "utf8",
);

describe("Phase 2C customer session projection", () => {
  it("is an authenticated read-only projection", () => {
    expect(routes).toContain("export async function commercialSessionsMine");
    expect(routes).toContain("requireUser(req, env)");
    expect(routes).toContain("commercial_entitlements");
    expect(routes).toContain("commercial_receipts");
    expect(routes).toContain("commercial_refund_receipts");
    expect(routes).toContain("refund_receipt_id");
    expect(routes).toContain("OR rr.refund_receipt_id IS NOT NULL");
    expect(routes).toContain("server_now");
    expect(routes).toContain("opens_at");
    expect(routes).toContain("closes_at");
    expect(routes).not.toContain("INSERT INTO commercial_entitlements");
    expect(routes).not.toContain("provider_token");
  });

  it("mounts a customer-owned sessions route without exposing admission credentials", () => {
    expect(router).toContain("commercialSessionsMine");
    expect(router).toContain('p === "/api/commercial/sessions/mine"');
    expect(router).toContain('req.method === "GET"');
  });

  it("uses POST for token-bearing admission while allowing signed GET reads", () => {
    expect(routes).toContain("export async function commercialLiveJoin");
    expect(router).toContain('req.method === "POST"');
    // Session projections are non-secret signed reads; only the dedicated
    // admission endpoints return provider credentials and must remain POST.
    expect(appSessionsApi).toContain("ApiAuth.getSigned(_url)");
    expect(appSessionsApi).toContain("ApiAuth.postJson(");
    expect(appSessionsApi).toContain("/commercial/live/");
    expect(appSessionsApi).toContain("/commercial/consult/");
  });
});
