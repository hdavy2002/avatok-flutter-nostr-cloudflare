import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const route = readFileSync(resolve(root, "src/routes/commercial_checkout.ts"), "utf8");
const router = readFileSync(resolve(root, "src/index.ts"), "utf8");
const migration = readFileSync(resolve(root, "migrations/2026-08-25-commercial-checkout.sql"), "utf8");
const client = readFileSync(resolve(root, "../app/lib/core/commercial_checkout_api.dart"), "utf8");

describe("Phase 2C commercial checkout contracts", () => {
  it("uses a dedicated dark checkout lane, never the legacy booking path", () => {
    expect(router).toContain("commercialCheckout");
    expect(route).toContain("/api/commercial/");
    expect(route).toContain("/checkout");
    expect(route).not.toContain("/api/listings/:id/book");
    expect(route).not.toContain("cloudflare");
    expect(route).toContain("commercialLiveCheckoutEnabled");
    expect(route).toContain("commercialConsultCheckoutEnabled");
  });

  it("requires account auth, policy acceptance, and a valid idempotency key", () => {
    expect(route).toContain("requireUser(req, env)");
    expect(route).toContain("valid Idempotency-Key required");
    expect(route).toContain("policy confirmation required");
    expect(route).toContain("account_id");
    expect(route).toContain("idempotency key reused for different checkout");
  });

  it("records a resumable operation before charging and stores replay output", () => {
    expect(route).toContain("commercial_checkout_operations");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS commercial_checkout_operations");
    expect(migration).toContain("request_sha256");
    expect(route).toContain("FROM commercial_checkout_operations LIMIT 1");
    expect(route).not.toContain("CREATE TABLE IF NOT EXISTS commercial_checkout_operations");
    expect(route).toContain("INSERT OR IGNORE INTO commercial_checkout_operations");
    expect(route).toContain("commercial:hold:");
    expect(route).toContain("commercial:checkout-failure:");
    expect(route).toContain("idempotent_replay");
  });

  it("snapshots policy and creator/platform split at checkout", () => {
    expect(route).toContain("commercial_policy_snapshots");
    expect(route).toContain("cancellation_policy_json");
    expect(route).toContain("platformFeeAmount");
    expect(route).toContain("creatorAmount");
    expect(route).toContain("CHECKOUT_POLICY_VERSION");
    expect(route).toContain("auto_release_on_provider_end: true");
  });

  it("supports free tickets and one buyer per 1:1 consultation slot", () => {
    expect(route).toContain("price > 0");
    expect(route).toContain("price > 0 ? \"held\" : \"reserved\"");
    expect(route).toContain("consult_1to1");
    expect(route).toContain("WHERE NOT EXISTS");
    expect(route).toContain("WHERE creator_id=?2");
    expect(route).toContain("starts_at < ?6 AND ends_at > ?5");
    expect(route).not.toContain("WHERE listing_id=?4 AND starts_at=?5");
    expect(route).toContain("consultation slot already booked");
    expect(route).toContain("Number(listing.capacity ?? 1) !== 1");
  });

  it("requires explicit creator policy fields and verifies immutable collisions", () => {
    expect(route).toContain("required.some((key) => !hasAttr(attrs, key))");
    expect(route).toContain("policy snapshot authority mismatch");
    expect(route).toContain("order authority mismatch");
    expect(route).toContain("entitlement authority mismatch");
    expect(route).toContain("commercial checkout retryable");
    expect(route).toContain("Never refund an already-admitted account entitlement");
    expect(route).toContain("ticket already owned");
    expect(route).toContain("const ticketRace");
  });

  it("closes the live-ticket NULL booking race without blocking repurchase", () => {
    expect(migration).toContain("idx_commercial_live_entitlement_active");
    expect(migration).toContain("kind='live_event'");
    expect(migration).toContain("booking_id IS NULL");
    expect(migration).toContain("state IN ('reserved','held','active','consumed')");
    expect(migration).not.toContain("state IN ('reserved','held','active','consumed','refunded')");
  });

  it("keeps the Flutter surface provider-neutral and account-bound", () => {
    expect(client).toContain("CommercialCheckoutResult");
    expect(client).toContain("Idempotency-Key");
    expect(client).toContain("accountBound");
    expect(client).not.toContain("Stream");
    expect(client).not.toContain("cloudflare");
    expect(client).not.toContain("share_token");
  });
});
