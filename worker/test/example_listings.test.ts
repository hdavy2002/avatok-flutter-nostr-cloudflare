import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { exampleFilter, hiddenListingFilter, HIDDEN_LISTING_SQL } from "../src/routes/listings";
import { notStuckLiveSql, STUCK_LIVE_MS } from "../src/lib/listing_schedule";
import type { PlatformConfig } from "../src/routes/config";

const root = resolve(import.meta.dirname, "..");
const listingsRoute = readFileSync(resolve(root, "src/routes/listings.ts"), "utf8");
const checkoutRoute = readFileSync(resolve(root, "src/routes/commercial_checkout.ts"), "utf8");
const payRoute = readFileSync(resolve(root, "src/routes/pay.ts"), "utf8");
const cashfreeRoute = readFileSync(resolve(root, "src/routes/cashfree.ts"), "utf8");
const lifecycleRoute = readFileSync(resolve(root, "src/routes/commercial_lifecycle.ts"), "utf8");
const sitemapRoute = readFileSync(resolve(root, "src/routes/sitemap.ts"), "utf8");
const publicDiscovery = readFileSync(resolve(root, "src/lib/public_discovery.ts"), "utf8");
const configRoute = readFileSync(resolve(root, "src/routes/config.ts"), "utf8");
const liveRoute = readFileSync(resolve(root, "src/routes/live.ts"), "utf8");
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

  it("gates exploreBrowse, exploreSearch and exploreLiveNow behind exampleFilter", () => {
    // [SHV2-S1] exploreBrowse and exploreLiveNow now share ONE guard helper
    // (discoverabilityGuards) so they cannot drift — see its own doc comment.
    const guardFn = listingsRoute.slice(listingsRoute.indexOf("export async function discoverabilityGuards"), listingsRoute.indexOf("export async function exploreBrowse"));
    expect(guardFn).toContain("exampleFilter(req, await readConfig(env), where)");
    expect(guardFn).toContain("hiddenListingFilter(where)");

    const browseFn = listingsRoute.slice(listingsRoute.indexOf("export async function exploreBrowse"), listingsRoute.indexOf("export async function exploreLiveNow"));
    expect(browseFn).toContain("discoverabilityGuards(req, env, where)");

    const liveNowFn = listingsRoute.slice(listingsRoute.indexOf("export async function exploreLiveNow"), listingsRoute.indexOf("export async function exploreSearch"));
    expect(liveNowFn).toContain("discoverabilityGuards(req, env, where)");

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
    expect(sitemapRoute).toContain('publicListingEligibilitySql("l", "?1")');
    expect(publicDiscovery).toContain(".is_example,0)<>0 THEN 'example'");
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

describe("[WEB-GATEWAY-FIX1] closing the remaining example-listing gaps", () => {
  it("refuses a live donation before the donation() ledger call", () => {
    const fn = liveRoute.slice(liveRoute.indexOf("export async function liveDonate"), liveRoute.indexOf("export async function liveMod"));
    expect(fn).toContain('if (l.is_example) return json({ error: "example_listing" }, 409);');
    const guardAt = fn.indexOf("example_listing");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(fn.indexOf("await donation("));
  });

  it("loadListing selects is_example so liveDonate's guard has data to check", () => {
    const fn = liveRoute.slice(liveRoute.indexOf("async function loadListing"), liveRoute.indexOf("export async function liveStart"));
    expect(fn).toContain("is_example");
  });

  it("applies exampleFilter and hiddenListingFilter to the creator profile listings query", () => {
    const fn = listingsRoute.slice(listingsRoute.indexOf("export async function getCreator"), listingsRoute.length);
    expect(fn).toContain("exampleFilter(req, await readConfig(env), creatorWhere)");
    expect(fn).toContain("hiddenListingFilter(creatorWhere)");
  });

  describe("hiddenListingFilter (attrs.hide_from_marketplace gate)", () => {
    it("always pushes the json_extract fragment", () => {
      const where: string[] = [];
      hiddenListingFilter(where);
      expect(where).toContain(HIDDEN_LISTING_SQL);
      expect(HIDDEN_LISTING_SQL).toContain("json_valid(l.attrs)=0 THEN 1");
      expect(HIDDEN_LISTING_SQL).toContain("json_extract(l.attrs,'$.hide_from_marketplace')");
    });
  });

  it("wires hiddenListingFilter into exploreBrowse and exploreLiveNow via discoverabilityGuards", () => {
    const guardFn = listingsRoute.slice(listingsRoute.indexOf("export async function discoverabilityGuards"), listingsRoute.indexOf("export async function exploreBrowse"));
    expect(guardFn).toContain("hiddenListingFilter(where)");
    const browseFn = listingsRoute.slice(listingsRoute.indexOf("export async function exploreBrowse"), listingsRoute.indexOf("export async function exploreLiveNow"));
    expect(browseFn).toContain("discoverabilityGuards(req, env, where)");
    const liveNowFn = listingsRoute.slice(listingsRoute.indexOf("export async function exploreLiveNow"), listingsRoute.indexOf("export async function exploreSearch"));
    expect(liveNowFn).toContain("discoverabilityGuards(req, env, where)");
  });

  it("wires hiddenListingFilter into exploreSearch", () => {
    const fn = listingsRoute.slice(listingsRoute.indexOf("export async function exploreSearch"), listingsRoute.indexOf("export async function getListing"));
    expect(fn).toContain("hiddenListingFilter(where)");
  });

  it("wires hiddenListingFilter into sectionCountsFor", () => {
    const fn = listingsRoute.slice(listingsRoute.indexOf("async function sectionCountsFor"), listingsRoute.indexOf("export async function exploreSearch"));
    expect(fn).toContain("hiddenListingFilter(where)");
  });

  it("uses the shared hidden-listing authority for both sitemap feeds", () => {
    expect(sitemapRoute).toContain('publicListingEligibilitySql("l", "?1")');
    expect(publicDiscovery).toContain("'$.hide_from_marketplace'");
  });

  it("never touches getListing (listing detail) or the HDFC/gateway smoke routes", () => {
    const fn = listingsRoute.slice(listingsRoute.indexOf("export async function getListing"), listingsRoute.indexOf("export async function getListing") + 800);
    expect(fn).not.toContain("hiddenListingFilter");
  });
});

describe("[SHV2-S1] exploreLiveNow gets exploreBrowse's discoverability guards", () => {
  const HOUR = 3_600_000;
  const NOW = 1789084800000; // 11 Sept 2026 00:00 UTC — arbitrary, fixed for reproducibility

  it("excludes a hidden row, an example row, a stuck/ended-while-live row and a cancelled row from the live-now query, leaving only the joinable live row", () => {
    // Exactly the WHERE fragments exploreLiveNow assembles: the status guard,
    // notStuckLiveSql (the pre-existing "ended" guard), then the same
    // discoverabilityGuards fragments exploreBrowse has always applied.
    const where: string[] = ["l.status='live'", notStuckLiveSql("l", String(NOW))];
    exampleFilter(new Request("https://x/api/explore/live-now"), cfg(), where);
    hiddenListingFilter(where);
    const whereSql = where.join(" AND ");

    const rows: [string, string, string, number, number, string | null, number][] = [
      ["live_ok", "live_event", "live", NOW - HOUR, 120, null, 0],
      ["live_hidden", "live_event", "live", NOW - HOUR, 120, JSON.stringify({ hide_from_marketplace: 1 }), 0],
      ["live_example", "live_event", "live", NOW - HOUR, 120, null, 1],
      ["live_stuck", "live_event", "live", NOW - STUCK_LIVE_MS - 2 * HOUR, 60, null, 0],
      ["cancelled", "live_event", "cancelled", NOW - HOUR, 60, null, 0],
    ];
    const script = String.raw`
import json, sqlite3, sys
p = json.load(sys.stdin)
db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE listings (id TEXT, kind TEXT, status TEXT, starts_at INTEGER, duration_min INTEGER, attrs TEXT, is_example INTEGER)")
db.executemany("INSERT INTO listings VALUES (?,?,?,?,?,?,?)", p["rows"])
live_now = [r[0] for r in db.execute("SELECT l.id FROM listings l WHERE " + p["whereSql"] + " ORDER BY l.id")]
print(json.dumps({"live_now": live_now}))
`;
    const out = JSON.parse(execFileSync("python3", ["-c", script], {
      input: JSON.stringify({ rows, whereSql }),
    }).toString());
    expect(out.live_now).toEqual(["live_ok"]);
  });

  it("leaves exploreBrowse's own filters untouched (discoverabilityGuards is additive, not a behaviour change)", () => {
    // Bounded at sectionCountsFor, not exploreLiveNow — that helper function sits
    // between exploreBrowse and exploreLiveNow in the source and keeps its own
    // direct exampleFilter/hiddenListingFilter calls (untouched by this change).
    const browseFn = listingsRoute.slice(listingsRoute.indexOf("export async function exploreBrowse"), listingsRoute.indexOf("async function sectionCountsFor"));
    expect(browseFn).toContain("l.status IN ('published','live')");
    expect(browseFn).toContain("notEndedSql(\"l\"");
    expect(browseFn).not.toContain("exampleFilter(req, await readConfig(env), where)");
    expect(browseFn).not.toContain("hiddenListingFilter(where)");
  });
});
