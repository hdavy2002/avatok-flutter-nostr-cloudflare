import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Messenger runtime status route", () => {
  it("mounts an authenticated, flag-dark GET endpoint", () => {
    const route = read("src/routes/messenger_call_billing.ts");
    const index = read("src/index.ts");
    expect(index).toContain('p === "/api/messenger-calls/status" && req.method === "GET"');
    expect(index).toContain("messengerCallBillingStatus");
    const start = route.indexOf("export async function messengerCallBillingStatus");
    const end = route.indexOf("/** GET one immutable final receipt", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const status = route.slice(start, end);
    expect(status).toContain("requireUser(req, env)");
    expect(status).toContain("messengerCallBillingEnabled !== true");
  });

  it("binds requester to payer or callee and projects only safe runtime fields", () => {
    const route = read("src/routes/messenger_call_billing.ts");
    const start = route.indexOf("export async function messengerCallBillingStatus");
    const end = route.indexOf("/** GET one immutable final receipt", start);
    const status = route.slice(start, end);
    expect(status).toContain("(payer_uid=?2 OR callee_uid=?2)");
    expect(status).toContain("messengerCallBillingStub");
    for (const field of [
      "status", "free_participant_seconds_remaining", "reserved_tokens",
      "paid_runway_wall_seconds", "low_balance", "renewal_failed",
      "exhausted", "end_reason", "receipt_available",
    ]) expect(status, field).toContain(field);
    // Internal presence generations and reservation references must never be
    // returned to a client polling the call HUD.
    expect(status).not.toContain("billing_participants");
    expect(status).not.toContain("generation:");
    expect(status).not.toContain("reservation_ref:");
  });

  it("uses the frozen Stream rate for paid runway and keeps free Cloudflare at zero", () => {
    const route = read("src/routes/messenger_call_billing.ts");
    const start = route.indexOf("export async function messengerCallBillingStatus");
    const end = route.indexOf("/** GET one immutable final receipt", start);
    const status = route.slice(start, end);
    expect(status).toContain('row.provider === "stream" && rate > 0');
    expect(status).toContain("paidRunwayWallSeconds");
    expect(status).toContain(": 0;");
    expect(status).toContain("messengerCallReservationStatus");
  });
});
