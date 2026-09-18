import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exampleFilter } from "../src/routes/listings";
import type { PlatformConfig } from "../src/routes/config";

const root = resolve(import.meta.dirname, "..");
const listingsRoute = readFileSync(resolve(root, "src/routes/listings.ts"), "utf8");
const checkoutRoute = readFileSync(resolve(root, "src/routes/commercial_checkout.ts"), "utf8");
const payRoute = readFileSync(resolve(root, "src/routes/pay.ts"), "utf8");
const cashfreeRoute = readFileSync(resolve(root, "src/routes/cashfree.ts"), "utf8");
const lifecycleRoute = readFileSync(resolve(root, "src/routes/commercial_lifecycle.ts"), "utf8");
const sitemapRoute = readFileSync(resolve(root, "src/routes/sitemap.ts"), "utf8");
const configRoute = readFileSync(resolve(root, "src/routes/config.ts"), "utf8");
const migration = readFileSync(resolve(root, "migrations/2026-09-18-listing-is-example.sql"), "utf8");

function cfg(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return { exampleListingsEnabled: true, ...overrides } as PlatformConfig;
}

describe("[WEB-GATEWAY-E] badged example listings", () => {
  describe("exampleFilter (visibility gate)", () => {
    it("hides examples when the caller does not ask for them", () => {
      const where: string[] = [];
      exampleFilter(new Request("https://x/api/explore"), cfg(), where);
      expect(where).toContain("l.is_example=0");
    });

    it("shows examples only when ?examples=1 AND the owner switch is on", () => {
      const where: string[] = [];
      exampleFilter(new Request("https://x/api/explore?examples=1"), cfg({ exampleListingsEnabled: true }), where);
      expect(where).not.toContain("l.is_example=0");
    });

    it("still hides examples on ?examples=1 when the owner switch is off", () => {
      const where: string[] = [];
      exampleFilter(new Request("https://x/api/explore?examples=1"), cfg({ exampleListingsEnabled: false }), where);
      expect(where).toContain("l.is_example=0");
    });

    it("ignores a non-'1' examples value", () => {
      const where: string[] = [];
      exampleFilter(new Request("https://x/api/explore?examples=true"), cfg(), where);
      expect(where).toContain("l.is_example=0");
    });
  });

  it("exposes is_example on every card (explore/browse + listing detail share shapeCard)", () => {
    expect(listingsRoute).toContain("l.is_example");
    expect(listingsRoute).toContain("is_example: !!r.is_example");
  });

  it("gates exploreBrowse and exploreSearch behind exampleFilter, never exploreLiveNow", () => {
    const browseFn = listingsRoute.slice(listingsRoute.indexOf("export async function exploreBrowse"), listingsRoute.indexOf("export async function exploreLiveNow"));
    expect(browseFn).toContain("exampleFilter(req, await readConfig(env), where)");
    const searchFn = listingsRoute.slice(listingsRoute.indexOf("export async function exploreSearch"), listingsRoute.indexOf("export async function getListing"));
    expect(searchFn).toContain("exampleFilter(req, await readConfig(env), where)");
  });

  it("refuses a booking on the legacy /book path before any calendar claim or wallet hold", () => {
    const fn = listingsRoute.slice(listingsRoute.indexOf("export async function bookListing"), listingsRoute.indexOf("export async function createReview"));
    expect(fn).toContain('if (l.is_example) return json({ error: "example_listing" }, 409);');
    const guardAt = fn.indexOf("example_listing");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(fn.indexOf("claimBlock("));
    expect(guardAt).toBeLessThan(fn.indexOf("await hold("));
  });

  it("refuses a commercial slot hold before claimCheckoutAvailability touches the calendar", () => {
    const fn = checkoutRoute.slice(checkoutRoute.indexOf("export async function commercialHold"), checkoutRoute.indexOf("async function sha256Hex"));
    expect(fn).toContain("is_example");
    expect(fn).toContain('return json({ error: "example_listing" }, 409);');
    expect(fn.indexOf("example_listing")).toBeLessThan(fn.indexOf("claimCheckoutAvailability("));
  });

  it("refuses commercial checkout before the checkout-operation row or any charge", () => {
    const fn = checkoutRoute.slice(checkoutRoute.indexOf("export async function commercialCheckout"), checkoutRoute.indexOf("export async function resendCommercialConfirmation"));
    expect(fn).toContain("listing.is_example");
    expect(fn).toContain('"example_listing"');
    const guardAt = fn.indexOf("example_listing");
    expect(guardAt).toBeLessThan(fn.indexOf("commercial_checkout_operations"));
    expect(guardAt).toBeLessThan(fn.indexOf("freeSessionPolicy("));
  });

  it("refuses a Razorpay/HDFC/etc. gateway order before gateway_orders or adapter.createOrder", () => {
    const fn = payRoute.slice(payRoute.indexOf("export async function payCreateOrder"), payRoute.length);
    expect(fn).toContain("is_example");
    expect(fn).toContain('return json({ error: "example_listing" }, 409);');
    const guardAt = fn.indexOf("example_listing");
    expect(guardAt).toBeLessThan(fn.indexOf("INSERT INTO gateway_orders"));
    expect(guardAt).toBeLessThan(fn.indexOf("adapter.createOrder("));
  });

  it("refuses a Cashfree order before direct_purchases or the gateway call", () => {
    const fn = cashfreeRoute.slice(cashfreeRoute.indexOf("export async function cashfreeCreateOrder"), cashfreeRoute.indexOf("export async function cashfreeWebhook"));
    expect(fn).toContain("is_example");
    expect(fn).toContain('return json({ error: "example_listing" }, 409);');
    const guardAt = fn.indexOf("example_listing");
    expect(guardAt).toBeLessThan(fn.indexOf("INSERT INTO direct_purchases"));
  });

  it("skips example listings in the schedule-expiry cron", () => {
    const fn = listingsRoute.slice(listingsRoute.indexOf("export async function expireEndedEventListings"), listingsRoute.indexOf("export async function reconcileListingPublicationEffects"));
    expect(fn).toContain("l.is_example=0");
  });

  it("skips example listings in the orphan no-show sweep", () => {
    expect(lifecycleRoute).toContain("l.is_example=0");
  });

  it("excludes example listings from the public sitemap", () => {
    expect(sitemapRoute).toContain("l.is_example=0");
  });

  it("declares the owner visibility switch, default on, boolean (not numericKeys)", () => {
    expect(configRoute).toContain("exampleListingsEnabled: boolean;");
    expect(configRoute).toContain("exampleListingsEnabled: true,");
  });

  it("ships the migration unapplied, additive, idempotent-tooling-friendly", () => {
    expect(migration).toContain("ALTER TABLE listings ADD COLUMN is_example INTEGER NOT NULL DEFAULT 0;");
    expect(migration).not.toContain("CREATE TABLE");
  });
});
