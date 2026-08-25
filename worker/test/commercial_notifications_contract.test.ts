import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const helper = readFileSync(resolve(root, "src/lib/commercial_notifications.ts"), "utf8");
const notifier = readFileSync(resolve(root, "src/notify.ts"), "utf8");
const checkout = readFileSync(resolve(root, "src/routes/commercial_checkout.ts"), "utf8");
const lifecycle = readFileSync(resolve(root, "src/routes/commercial_lifecycle.ts"), "utf8");
const sessions = readFileSync(resolve(root, "src/routes/commercial_stream_sessions.ts"), "utf8");
const settlement = readFileSync(resolve(root, "src/commercial_settlement.ts"), "utf8");
const consumerCalendar = readFileSync(resolve(root, "../consumers/src/calendar.ts"), "utf8");

describe("commercial notification contracts", () => {
  it("uses stable event identities and an allowlisted account-bound payload", () => {
    expect(notifier).toContain("INSERT OR IGNORE");
    expect(helper).toContain("commercial-notification:");
    expect(helper).toContain("listing_id");
    expect(helper).toContain("booking_id");
    expect(helper).toContain("session_id");
    expect(helper).toContain("Provider call ids, access tokens");
    expect(helper).toContain("LIMIT 200");
    expect(helper).not.toContain("provider_call_id");
    expect(helper).not.toContain("join_url");
  });

  it("covers checkout, lifecycle, settlement and live-audience events", () => {
    expect(checkout).toContain("commercial_checkout_confirmed");
    expect(lifecycle).toContain("commercial_session_rescheduled");
    expect(lifecycle).toContain("commercial_session_cancelled");
    expect(lifecycle).toContain("commercial_refund");
    expect(settlement).toContain("commercial_receipt");
    expect(sessions).toContain("commercial_broadcast_started");
    expect(sessions).toContain("commercial_broadcast_ended");
    expect(sessions).toContain("notifyLiveAudience");
  });

  it("keeps scheduled commercial reminders on stable ids without join credentials", () => {
    expect(consumerCalendar).toContain("commercial_join_window");
    expect(consumerCalendar).toContain("commercial-notification:");
    expect(consumerCalendar).toContain("signed join URL and must not be used for this lane");
  });
});
