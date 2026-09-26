// [ADMIN2-EVENTS 2026-09-26] Owner decision: Saa Thum's own (admin-owned) listings
// publish without the creator Google Calendar gates, behind adminListingsSkipCalendar
// (default true). A non-admin creator's listing is still blocked exactly as before.
//
// Runs listingBlockers() and publishListingAuthoritative() against real SQLite
// (node:sqlite). The account has NO Google Calendar (no gcal_accounts row), and the
// availability tables publishFixedListing needs do not exist at all — so if the admin
// path still tried to hold the creator's calendar, the publish would fail.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { listingBlockers } from "../src/lib/listing_blockers";
import { publishListingAuthoritative, reviewedContentHash } from "../src/routes/listings";
import { bustConfigMemo } from "../src/routes/config";
import { calendarExemptFor, isAdminUid } from "../src/lib/admin_calendar_exempt";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };

function d1(db: any): any {
  return {
    prepare(sql: string) {
      let named = "", next = 1; const used = new Set<number>();
      for (let i = 0; i < sql.length; i++) {
        if (sql[i] !== "?") { named += sql[i]; continue; }
        let j = i + 1; while (j < sql.length && /\d/.test(sql[j])) j++;
        if (j > i + 1) { const n = Number(sql.slice(i + 1, j)); named += `$p${n}`; used.add(n); next = Math.max(next, n + 1); i = j - 1; }
        else { named += `$p${next}`; used.add(next); next++; }
      }
      let params: Record<string, unknown> = {};
      const w = {
        bind(...values: unknown[]) { params = {}; for (const n of used) params[`p${n}`] = values[n - 1] === undefined ? null : values[n - 1]; return w; },
        async run() { const r = db.prepare(named).run(params); return { meta: { changes: Number(r.changes ?? 0) } }; },
        async first<T = any>(): Promise<T | null> { return (db.prepare(named).get(params) as T | undefined) ?? null; },
        async all<T = any>(): Promise<{ results: T[] }> { return { results: db.prepare(named).all(params) as T[] }; },
      };
      return w;
    },
    async batch(stmts: any[]) {
      db.exec("BEGIN");
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

const ADMIN = "user_admin_1";
const CREATOR = "user_creator_1";
const DAY = 86_400_000;

function setup(overrides: Record<string, unknown> = {}, envName = "test-cal-exempt") {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listing_categories (id TEXT PRIMARY KEY, label TEXT, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
    INSERT INTO listing_categories (id,label) VALUES ('live_puja','Live puja');
    CREATE TABLE gcal_accounts (user_id TEXT PRIMARY KEY);
    CREATE TABLE gcal_calendars (user_id TEXT, selected INTEGER, last_success_at INTEGER, last_error TEXT);
    CREATE TABLE listings (
      id TEXT PRIMARY KEY, creator_id TEXT, kind TEXT, title TEXT, description TEXT, blurb TEXT, category TEXT,
      price INTEGER, free_entry INTEGER DEFAULT 0, cover_media TEXT, attrs TEXT, starts_at INTEGER, duration_min INTEGER,
      capacity INTEGER, status TEXT, schedule_mode TEXT DEFAULT 'fixed_date', performed_by TEXT, facilitated_by TEXT,
      authority_version INTEGER DEFAULT 0, reviewed_content_hash TEXT, publication_version INTEGER DEFAULT 0,
      updated_at INTEGER, vertical TEXT
    );
    CREATE TABLE creator_profiles (user_id TEXT PRIMARY KEY, updated_at INTEGER);
    CREATE TABLE listings_fts (listing_id TEXT, title TEXT, description TEXT, creator_name TEXT, category TEXT);
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, handle TEXT);
  `);
  // Test-only KV: the identity/KYC switches are relaxed HERE so this test isolates the
  // calendar rule (production values are whatever prod KV holds — not changed by this).
  const kv = { identityGatingEnabled: false, listingPublishKycRequired: false, ...overrides };
  const env: any = {
    ENVIRONMENT_NAME: envName,
    ADMIN_UIDS: ` ${ADMIN} , user_admin_2`,
    DB_META: d1(db),
    TOKENS: { get: async () => kv },
  };
  bustConfigMemo();
  return { db, env };
}

async function insertApproved(db: any, env: any, id: string, creator: string, extra: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id, creator_id: creator, kind: "live_event", title: "Maha Mrityunjaya Havan", description: "A havan.", blurb: null,
    category: "live_puja", price: 501, cover_media: JSON.stringify([{ type: "image", url: "https://x/c.png" }]),
    attrs: JSON.stringify({ poster: { status: "approved", provider: "admin_cover", url: "https://x/c.png" } }),
    starts_at: Date.now() + 3 * DAY, duration_min: 90, capacity: null, status: "approved",
    performed_by: "Pandit Sharma", facilitated_by: null, authority_version: 0, publication_version: 0,
    updated_at: Date.now(), vertical: "commerce", ...extra,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO listings (${cols.join(",")}) VALUES (${cols.map((c) => "$" + c).join(",")})`)
    .run(Object.fromEntries(cols.map((c) => ["$" + c, row[c] as any])));
  // Bind the approval to the row exactly as stored (column defaults included),
  // the way approve_listing does.
  const stored = db.prepare("SELECT * FROM listings WHERE id=$id").get({ $id: id });
  db.prepare("UPDATE listings SET reviewed_content_hash=$h WHERE id=$id").run({ $h: await reviewedContentHash(stored), $id: id });
  return env;
}

const statusOf = (db: any, id: string) => (db.prepare("SELECT status FROM listings WHERE id=$id").get({ $id: id }) as any)?.status;

describe("admin calendar exemption — pure", () => {
  it("isAdminUid reads the comma-separated ADMIN_UIDS", () => {
    const env = { ADMIN_UIDS: " a , b" };
    expect(isAdminUid(env, "a")).toBe(true);
    expect(isAdminUid(env, "b")).toBe(true);
    expect(isAdminUid(env, "c")).toBe(false);
    expect(isAdminUid({ ADMIN_UIDS: undefined }, "a")).toBe(false);
    expect(isAdminUid(env, "")).toBe(false);
  });
  it("is on by default, off only by an explicit false", () => {
    const env = { ADMIN_UIDS: "a" };
    expect(calendarExemptFor({}, env, "a")).toBe(true);
    expect(calendarExemptFor({ adminListingsSkipCalendar: true }, env, "a")).toBe(true);
    expect(calendarExemptFor({ adminListingsSkipCalendar: false }, env, "a")).toBe(false);
    expect(calendarExemptFor({}, env, "not-admin")).toBe(false);
    expect(calendarExemptFor(null, env, "a")).toBe(false);
  });
});

describe("listingBlockers", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("an admin-owned live event with no Google Calendar has no blockers", async () => {
    const { db, env } = setup();
    await insertApproved(db, env, "L-admin", ADMIN);
    const row = db.prepare("SELECT * FROM listings WHERE id='L-admin'").get();
    expect(await listingBlockers(env, row)).toEqual([]);
  });

  it("a non-admin creator's identical listing is still blocked on the calendar", async () => {
    const { db, env } = setup();
    await insertApproved(db, env, "L-creator", CREATOR);
    const row = db.prepare("SELECT * FROM listings WHERE id='L-creator'").get();
    expect((await listingBlockers(env, row)).map((b) => b.code)).toEqual(["calendar_not_ready"]);
  });

  it("with adminListingsSkipCalendar=false the admin is blocked too", async () => {
    const { db, env } = setup({ adminListingsSkipCalendar: false }, "test-cal-exempt-off");
    await insertApproved(db, env, "L-admin-off", ADMIN);
    const row = db.prepare("SELECT * FROM listings WHERE id='L-admin-off'").get();
    expect((await listingBlockers(env, row)).map((b) => b.code)).toEqual(["calendar_not_ready"]);
  });

  it("every other rule still applies to admin listings", async () => {
    const { db, env } = setup();
    await insertApproved(db, env, "L-admin-bad", ADMIN, {
      performed_by: null, starts_at: Date.now() - DAY, description: "Guaranteed marriage within a month.",
    });
    const row = db.prepare("SELECT * FROM listings WHERE id='L-admin-bad'").get();
    const codes = (await listingBlockers(env, row)).map((b) => b.code);
    expect(codes).toContain("guaranteed_outcome");
    expect(codes).toContain("performer_disclosure_required");
    expect(codes).toContain("starts_at_required");
    expect(codes).not.toContain("calendar_not_ready");
  });
});

describe("publishListingAuthoritative", () => {
  it("publishes an admin-owned live event with no calendar and no calendar hold", async () => {
    const { db, env } = setup();
    await insertApproved(db, env, "P-admin", ADMIN);
    const r = await publishListingAuthoritative(env, { listingId: "P-admin", actor: "admin", actorUid: ADMIN });
    // Side effects after the status write (fanout etc.) may be unavailable in this
    // harness; publish reports that as publication_repair_pending with published:true.
    if (!r.ok) expect(r.body).toMatchObject({ error: "publication_repair_pending", published: true });
    expect(statusOf(db, "P-admin")).toBe("published");
    expect(Number((db.prepare("SELECT publication_version v FROM listings WHERE id='P-admin'").get() as any).v)).toBe(1);
  });

  it("refuses a non-admin creator's listing with the calendar blocker and leaves it approved", async () => {
    const { db, env } = setup();
    await insertApproved(db, env, "P-creator", CREATOR);
    const r = await publishListingAuthoritative(env, { listingId: "P-creator", actor: "admin", actorUid: ADMIN });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect((r.body as any).blockers.map((b: any) => b.code)).toEqual(["calendar_not_ready"]);
    expect(statusOf(db, "P-creator")).toBe("approved");
  });

  it("still refuses an admin listing whose poster is not approved", async () => {
    const { db, env } = setup();
    await insertApproved(db, env, "P-admin-poster", ADMIN, { attrs: JSON.stringify({}) });
    const r = await publishListingAuthoritative(env, { listingId: "P-admin-poster", actor: "admin", actorUid: ADMIN });
    expect(r.ok).toBe(false);
    expect((r.body as any).error).toBe("poster_approval_required");
    expect(statusOf(db, "P-admin-poster")).toBe("approved");
  });
});
