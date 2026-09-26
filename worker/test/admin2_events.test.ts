// [ADMIN2-EVENTS 2026-09-26] Pure rules behind the Admin 2 Events screens
// (lib/admin2_events_logic.ts) and the route table (routes/admin2_events.ts).
// tabSql() is run against real SQLite (node:sqlite) and checked row-for-row
// against tabOf(), so the list's SQL and the JS classifier cannot drift.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  tabOf, tabSql, parseTab, istToMs, msToIst, normalizeEventInput, splitPatch, nextCoverMedia,
  manualCoverUrl, coverUrlOf, posterPlan, likeContains, MIN_PRICE_RUPEES, EVENT_TABS,
} from "../src/lib/admin2_events_logic";
import { matchAdmin2 } from "../src/routes/admin2";
import { ADMIN2_EVENT_ROUTES } from "../src/routes/admin2_events";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };

const NOW = Date.UTC(2026, 8, 26, 6, 30); // 26 Sep 2026 12:00 IST
const H = 3_600_000;

describe("tabOf", () => {
  const ev = (status: string, startOffsetH: number | null, dur = 60) =>
    ({ kind: "live_event", status, starts_at: startOffsetH === null ? null : NOW + startOffsetH * H, duration_min: dur });
  it("files statuses into the five tabs", () => {
    expect(tabOf(ev("draft", 5), NOW)).toBe("drafts");
    expect(tabOf(ev("pending_review", 5), NOW)).toBe("drafts");
    expect(tabOf(ev("approved", 5), NOW)).toBe("drafts");
    expect(tabOf(ev("rejected", 5), NOW)).toBe("drafts");
    expect(tabOf(ev("cancelled", 5), NOW)).toBe("cancelled");
    expect(tabOf(ev("completed", -5), NOW)).toBe("past");
    expect(tabOf(ev("live", -0.5), NOW)).toBe("live");
  });
  it("uses the clock for published events", () => {
    expect(tabOf(ev("published", 2), NOW)).toBe("upcoming");
    expect(tabOf(ev("published", -0.5, 60), NOW)).toBe("live"); // started, not ended
    expect(tabOf(ev("published", -2, 60), NOW)).toBe("past");   // ended, cron not run yet
    expect(tabOf(ev("published", null), NOW)).toBe("upcoming");
  });
  it("reads second-precision historical starts", () => {
    expect(tabOf({ kind: "live_event", status: "published", starts_at: Math.floor((NOW + 2 * H) / 1000), duration_min: 60 }, NOW)).toBe("upcoming");
  });
  it("parseTab falls back to upcoming", () => {
    expect(parseTab("past")).toBe("past");
    expect(parseTab("nope")).toBe("upcoming");
    expect(parseTab(null)).toBe("upcoming");
  });
});

describe("tabSql agrees with tabOf (SQLite)", () => {
  it("row for row", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE listings (id TEXT, kind TEXT, status TEXT, starts_at INTEGER, duration_min INTEGER)");
    const rows: any[] = [];
    let n = 0;
    for (const status of ["draft", "pending_review", "approved", "rejected", "published", "live", "completed", "cancelled"]) {
      for (const off of [null, -3, -0.5, -0.01, 0.5, 48]) {
        for (const dur of [null, 30, 120]) {
          const starts = off === null ? null : Math.round(NOW + off * H);
          rows.push({ id: `r${n++}`, kind: "live_event", status, starts_at: starts, duration_min: dur });
        }
      }
    }
    const ins = db.prepare("INSERT INTO listings VALUES ($id,$kind,$status,$starts_at,$duration_min)");
    for (const r of rows) ins.run({ $id: r.id, $kind: r.kind, $status: r.status, $starts_at: r.starts_at, $duration_min: r.duration_min });
    const out = db.prepare(`SELECT id, ${tabSql("l", "$now")} AS tab FROM listings l`).all({ $now: NOW }) as { id: string; tab: string }[];
    const byId = new Map(out.map((r) => [r.id, r.tab]));
    for (const r of rows) expect([r.id, byId.get(r.id)]).toEqual([r.id, tabOf(r, NOW)]);
    expect(new Set(out.map((r) => r.tab))).toEqual(new Set(EVENT_TABS));
  });
});

describe("IST date/time", () => {
  it("round-trips and rejects impossible dates", () => {
    const ms = istToMs("2026-10-04", "18:30");
    expect(ms).toBe(Date.UTC(2026, 9, 4, 13, 0));
    expect(msToIst(ms!)).toEqual({ date: "2026-10-04", time: "18:30" });
    expect(istToMs("2026-02-30", "10:00")).toBeNull();
    expect(istToMs("2026-10-04", "24:00")).toBeNull();
    expect(istToMs("04-10-2026", "10:00")).toBeNull();
    expect(msToIst(Date.UTC(2026, 9, 4, 20, 0))).toEqual({ date: "2026-10-05", time: "01:30" }); // crosses midnight IST
  });
});

describe("normalizeEventInput", () => {
  const good = {
    title: "  Ganesh   Chaturthi Puja ", category: "live_puja", deity: "Ganesha", blurb: "Blessings for new beginnings",
    description: "A full puja.", start_date: "2026-10-04", start_time: "07:00", duration_min: 90, price_rupees: 501,
    capacity: 50, cover_url: "https://blossom.example/u/public/abc", performed_by: "Pandit Sharma",
  };
  it("accepts a full create body and converts IST", () => {
    const { patch, errors } = normalizeEventInput(good, { partial: false, now: NOW });
    expect(errors).toEqual([]);
    expect(patch.title).toBe("Ganesh Chaturthi Puja");
    expect(patch.starts_at).toBe(istToMs("2026-10-04", "07:00"));
    expect(patch.price).toBe(501);
    expect(patch.capacity).toBe(50);
    expect(patch.cover_url).toBe(good.cover_url);
  });
  it("requires title and category on create but not on edit", () => {
    expect(normalizeEventInput({}, { partial: false, now: NOW }).errors.map((e) => e.field)).toEqual(["title", "category"]);
    expect(normalizeEventInput({ price_rupees: 600 }, { partial: true, now: NOW })).toEqual({ patch: { price: 600 }, errors: [] });
  });
  it("enforces the money and schedule rules the server enforces", () => {
    const f = (b: Record<string, unknown>) => normalizeEventInput(b, { partial: true, now: NOW }).errors.map((e) => e.field);
    expect(f({ price_rupees: MIN_PRICE_RUPEES - 1 })).toEqual(["price"]);
    expect(f({ price_rupees: 99.5 })).toEqual(["price"]);
    expect(f({ price_rupees: MIN_PRICE_RUPEES })).toEqual([]);
    expect(f({ duration_min: 4 })).toEqual(["duration_min"]);
    expect(f({ duration_min: 481 })).toEqual(["duration_min"]);
    expect(f({ start_date: "2026-09-26", start_time: "11:00" })).toEqual(["starts_at"]); // past (IST)
    expect(f({ starts_at: NOW - 1 })).toEqual(["starts_at"]);
    expect(f({ capacity: 0 })).toEqual([]);
    expect(f({ capacity: -2 })).toEqual(["capacity"]);
    expect(f({ cover_url: "http://insecure/x.png" })).toEqual(["cover_url"]);
    expect(f({ blurb: "x".repeat(121) })).toEqual(["blurb"]);
    expect(f({ performed_by: "x".repeat(81) })).toEqual(["performed_by"]);
  });
  it("treats empty values as clears", () => {
    const { patch } = normalizeEventInput({ capacity: "", cover_url: "", deity: "  ", start_date: "", start_time: "" }, { partial: true, now: NOW });
    expect(patch).toEqual({ capacity: null, cover_url: null, deity: null, starts_at: null });
  });
  it("splitPatch routes fields to their owner", () => {
    const { patch } = normalizeEventInput(good, { partial: false, now: NOW });
    const s = splitPatch(patch);
    expect(Object.keys(s.edit).sort()).toEqual(["blurb", "capacity", "category", "description", "duration_min", "performed_by", "price", "starts_at", "title"]);
    expect(s.cover).toBe(good.cover_url);
    expect(s.deity).toBe("Ganesha");
  });
});

describe("cover media and poster plan", () => {
  const ai = { type: "image", url: "https://x/ai.png", source: "ai_poster" };
  const up = { type: "image", url: "https://x/up.png" };
  it("a new upload replaces manual photos and keeps the AI poster", () => {
    expect(nextCoverMedia(JSON.stringify([up, ai]), "https://x/new.png")).toEqual([
      { type: "image", url: "https://x/new.png", source: "admin_upload" }, ai,
    ]);
    expect(nextCoverMedia(JSON.stringify([up, ai]), null)).toEqual([ai]);
    expect(nextCoverMedia(null, null)).toEqual([]);
    expect(manualCoverUrl(JSON.stringify([ai, up]))).toBe(up.url);
    expect(coverUrlOf(JSON.stringify([ai, up]))).toBe(ai.url);
    expect(coverUrlOf("not json")).toBeNull();
  });
  it("decides what publish must do about attrs.poster", () => {
    expect(posterPlan({}, JSON.stringify([up]))).toEqual({ kind: "use_cover", url: up.url });
    expect(posterPlan({ poster: { status: "approved", provider: "admin_cover", url: up.url } }, JSON.stringify([up]))).toEqual({ kind: "ready" });
    expect(posterPlan({ poster: { status: "approved", provider: "admin_cover", url: "https://x/old.png" } }, JSON.stringify([up]))).toEqual({ kind: "use_cover", url: up.url });
    expect(posterPlan({ poster: { status: "approved", url: ai.url } }, JSON.stringify([ai]))).toEqual({ kind: "ready" });
    expect(posterPlan({ poster: { status: "draft", url: ai.url } }, JSON.stringify([ai]))).toEqual({ kind: "approve_ai" });
    expect(posterPlan({ poster: { status: "generating" } }, null).kind).toBe("needs_image");
    expect(posterPlan({}, null).kind).toBe("needs_image");
  });
  it("likeContains escapes wildcards", () => {
    expect(likeContains(" 50%_off ")).toBe("%50\\%\\_off%");
  });
});

describe("route table", () => {
  const m = (method: string, p: string) => {
    const hit = matchAdmin2(method, p, ADMIN2_EVENT_ROUTES);
    return hit && "route" in hit ? { path: String(hit.route.path), params: hit.params } : hit;
  };
  it("matches every events route and decodes ids", () => {
    expect(m("GET", "/api/admin/v2/events")).toEqual({ path: "/api/admin/v2/events", params: [] });
    expect(m("POST", "/api/admin/v2/events")).toEqual({ path: "/api/admin/v2/events", params: [] });
    expect((m("GET", "/api/admin/v2/events/meta") as any).path).toBe("/api/admin/v2/events/meta");
    expect((m("GET", "/api/admin/v2/events/abc%2D1") as any).params).toEqual(["abc-1"]);
    expect((m("PUT", "/api/admin/v2/events/abc") as any).params).toEqual(["abc"]);
    for (const a of ["publish", "unpublish", "cancel", "poster"]) {
      expect((m("POST", `/api/admin/v2/events/abc/${a}`) as any).params).toEqual(["abc"]);
    }
  });
  it("refuses wrong methods and unknown sub-paths", () => {
    expect(m("DELETE", "/api/admin/v2/events/abc")).toEqual({ methodNotAllowed: true });
    expect(m("POST", "/api/admin/v2/events/abc/delete")).toBeNull();
    expect(m("GET", "/api/admin/v2/events/abc/publish")).toEqual({ methodNotAllowed: true });
  });
});
