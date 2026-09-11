// [LISTING-EXPIRY-1] The one module that decides whether a show is over.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bookability, eventWindow, notEndedSql, notStuckLiveSql, scheduleState,
  LATE_BOOKING_GRACE_MS, STUCK_LIVE_MS,
} from "../src/lib/listing_schedule";
import { checkTransition } from "../src/lib/listing_transitions";

const HOUR = 3_600_000;
// The prod listing that started this: Tue 8 Sept 2026 02:42 IST, 60 minutes.
const COOKING = { kind: "live_event", status: "published", starts_at: 1788815520000, duration_min: 60, expires_at: null };
const ELEVENTH = 1789084800000; // 11 Sept 2026 00:00 UTC

describe("scheduleState", () => {
  it("calls the prod Cooking-with-Davy listing ended three days later", () => {
    expect(scheduleState(COOKING, ELEVENTH)).toBe("ended");
    expect(bookability(COOKING, ELEVENTH)).toMatchObject({ ok: false, reason: "event_ended" });
  });

  it("walks a fixed-date show through upcoming → starting → ended", () => {
    const start = COOKING.starts_at;
    expect(scheduleState(COOKING, start - 1)).toBe("upcoming");
    expect(scheduleState(COOKING, start)).toBe("starting");
    expect(scheduleState(COOKING, start + HOUR - 1)).toBe("starting");
    expect(scheduleState(COOKING, start + HOUR)).toBe("ended");
  });

  it("keeps booking open only for the late grace after the start", () => {
    const start = COOKING.starts_at;
    expect(bookability(COOKING, start - 1).ok).toBe(true);
    expect(bookability(COOKING, start + LATE_BOOKING_GRACE_MS - 1).ok).toBe(true);
    expect(bookability(COOKING, start + LATE_BOOKING_GRACE_MS)).toMatchObject({ ok: false, reason: "booking_closed" });
  });

  it("lets a provider-confirmed live show sell until its scheduled end", () => {
    const live = { ...COOKING, status: "live" };
    expect(scheduleState(live, COOKING.starts_at + 2 * HOUR)).toBe("live");
    expect(bookability(live, COOKING.starts_at + 30 * 60_000).ok).toBe(true);
    expect(bookability(live, COOKING.starts_at + HOUR)).toMatchObject({ ok: false, reason: "event_ended" });
  });

  it("maps closed statuses and never time-expires schedule-less listings", () => {
    expect(scheduleState({ ...COOKING, status: "cancelled" })).toBe("cancelled");
    expect(scheduleState({ ...COOKING, status: "completed" })).toBe("ended");
    expect(scheduleState({ ...COOKING, status: "draft" })).toBe("unpublished");
    expect(scheduleState({ kind: "consult", status: "published", starts_at: 1 })).toBe("open");
    expect(bookability({ kind: "consult", status: "published" }).ok).toBe(true);
    expect(scheduleState({ kind: "sell", status: "published", expires_at: ELEVENTH - 1 }, ELEVENTH)).toBe("expired");
    expect(scheduleState({ kind: "sell", status: "published", expires_at: ELEVENTH + 1 }, ELEVENTH)).toBe("open");
  });

  it("reads second-precision legacy starts_at as seconds", () => {
    expect(eventWindow({ ...COOKING, starts_at: COOKING.starts_at / 1000 })).toEqual(eventWindow(COOKING));
  });
});

describe("listing transitions", () => {
  it("lets only the system close a published show by its schedule", () => {
    expect(checkTransition("published", "completed", "system")).toMatchObject({ ok: true, rule: { id: "system_schedule_ended", requires: "schedule_ended" } });
  });
});

describe("notEndedSql / notStuckLiveSql in SQLite", () => {
  it("hides exactly the ended published live events", () => {
    const script = String.raw`
import json, sqlite3, sys
p = json.load(sys.stdin)
db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE listings (id TEXT, kind TEXT, status TEXT, starts_at INTEGER, duration_min INTEGER)")
db.executemany("INSERT INTO listings VALUES (?,?,?,?,?)", p["rows"])
visible = [r[0] for r in db.execute("SELECT l.id FROM listings l WHERE " + p["notEnded"] + " ORDER BY l.id", (p["now"],))]
rail = [r[0] for r in db.execute("SELECT l.id FROM listings l WHERE l.status='live' AND " + p["notStuck"] + " ORDER BY l.id", (p["now"],))]
print(json.dumps({"visible": visible, "rail": rail}))
`;
    const now = ELEVENTH;
    const rows = [
      ["cooking", "live_event", "published", COOKING.starts_at, 60],
      ["cooking_seconds", "live_event", "published", COOKING.starts_at / 1000, 60],
      ["future", "live_event", "published", now + HOUR, 60],
      ["running_late", "live_event", "published", now - 30 * 60_000, 60],
      ["consult", "consult", "published", COOKING.starts_at, 60],
      ["live_ok", "live_event", "live", now - HOUR, 120],
      ["live_stuck", "live_event", "live", now - STUCK_LIVE_MS - 2 * HOUR, 60],
      ["undated", "live_event", "published", null, null],
    ];
    const out = JSON.parse(execFileSync("python3", ["-c", script], {
      input: JSON.stringify({ rows, now, notEnded: notEndedSql("l", "?1"), notStuck: notStuckLiveSql("l", "?1") }),
    }).toString());
    expect(out.visible).toEqual(["consult", "future", "live_ok", "live_stuck", "running_late", "undated"]);
    expect(out.rail).toEqual(["live_ok"]);
  });
});

describe("wiring", () => {
  const src = (f: string) => readFileSync(resolve(import.meta.dirname, "..", f), "utf8");
  it("guards every live-event money entry point with bookability()", () => {
    expect(src("src/routes/commercial_checkout.ts").match(/bookability\(listing, Date\.now\(\)\)/g)?.length).toBe(2);
    expect(src("src/routes/pay.ts")).toContain("bookability(listing, Date.now())");
    expect(src("src/routes/pay.ts")).toContain("provisioned.status===410");
  });
  it("schedules the expiry cron and the orphan no-show sweep", () => {
    const index = src("src/index.ts");
    expect(index).toContain("expireEndedEventListings(env)");
    expect(index).toContain("runCommercialOrphanNoShowSweep(env)");
  });
  it("refunds open orders before a creator or admin takes a listing down", () => {
    expect(src("src/routes/listings.ts").match(/refundOpenOrdersForListing\(/g)?.length).toBe(2);
    expect(src("src/routes/admin_listings.ts")).toContain("refundOpenOrdersForListing(env, id, \"listing_rejected\")");
  });
});
