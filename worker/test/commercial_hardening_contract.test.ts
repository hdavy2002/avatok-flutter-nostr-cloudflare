import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const telemetry = readFileSync(resolve(root, "src/lib/commercial_telemetry.ts"), "utf8");
const diagnostics = readFileSync(resolve(root, "src/routes/commercial_diagnostics.ts"), "utf8");
const sessions = readFileSync(resolve(root, "src/routes/commercial_stream_sessions.ts"), "utf8");
const settlement = readFileSync(resolve(root, "src/commercial_settlement.ts"), "utf8");
const checkout = readFileSync(resolve(root, "src/routes/commercial_checkout.ts"), "utf8");
const router = readFileSync(resolve(root, "src/index.ts"), "utf8");

describe("Phase 2F commercial hardening contracts", () => {
  it("emits scalar-only telemetry with provider-secret redaction", () => {
    expect(telemetry).toContain("commercialEvent");
    expect(telemetry).toContain("token|secret|password");
    expect(telemetry).toContain("api[_-]?key");
    expect(telemetry).toContain("payload");
    expect(telemetry).toContain("SAFE_KEY");
    expect(telemetry).toContain("scalar-only allowlist");
    expect(telemetry).not.toContain("rawJson");
  });

  it("exposes admin-only read diagnostics and scheduled stale-state alarms", () => {
    expect(diagnostics).toContain("requireAdmin");
    expect(diagnostics).toContain("checkout_started_stale");
    expect(diagnostics).toContain("session_reconciliation_pending");
    expect(diagnostics).toContain("settlement_review_pending");
    expect(diagnostics).toContain("settlement_processing_stale");
    expect(diagnostics).toContain("provider_event_unbound");
    expect(diagnostics).not.toContain("payload_json");
    expect(diagnostics).not.toContain("provider_call_id");
    expect(diagnostics).not.toContain("STREAM_VIDEO_API_SECRET");
    expect(router).toContain("/api/admin/commercial/diagnostics");
    expect(router).toContain("scanCommercialHealth(env)");
  });

  it("records duplicate, out-of-order, unbound and provider lifecycle outcomes", () => {
    expect(sessions).toContain("outcome: \"duplicate\"");
    expect(sessions).toContain("event_class: \"out_of_order\"");
    expect(sessions).toContain("event_class: \"unbound\"");
    expect(sessions).toContain("outcome: \"replay_mismatch\"");
    expect(sessions).toContain("provider_lifecycle");
    expect(sessions).toContain("outcome: \"started\"");
    expect(sessions).toContain("outcome: \"ended\"");
    expect(sessions).toContain("commercialEvent");
  });

  it("records join refusal/authorization and settlement states without payloads", () => {
    expect(sessions).toContain("outcome: \"refused\"");
    expect(sessions).toContain("outcome: \"authorized\"");
    expect(settlement).toContain("outcome: \"processing\"");
    expect(settlement).toContain("outcome: \"review_pending\"");
    expect(settlement).toContain("outcome: \"settled\"");
    expect(settlement).toContain("outcome: \"failed\"");
    expect(checkout).toContain("checkout_consent");
    expect(checkout).toContain("checkout_hold");
    expect(checkout).toContain('outcome: ticketRace || slotConflict || collision ? "refused" : "retryable"');
  });
});
