import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const routeSource = readFileSync(resolve(root, "src/routes/commercial_stream_sessions.ts"), "utf8");

// Keep this regression tied to the SQL executed by commercialSessionsMine. If
// the route query is moved or split, the test must be updated with it instead
// of silently exercising a copied query that can drift from production.
const queryTemplates = [...routeSource.matchAll(
  /rows = await db\.prepare\(\s*`([\s\S]*?)`\s*,?\s*\)\.bind/g,
)].map((match) => match[1]);
const cursorSql = `(?3 IS NULL OR sort_rank > ?3
      OR (sort_rank = ?3 AND (sort_start > ?4
        OR (sort_start = ?4 AND product_key > ?5))))`;

function routeSql(template: string, filter: string): string {
  return template.replaceAll("${filterSql}", filter).replaceAll("${cursorSql}", cursorSql);
}

const SQLITE_HARNESS = String.raw`
import json, sqlite3, sys

payload = json.load(sys.stdin)
db = sqlite3.connect(":memory:")
db.row_factory = sqlite3.Row
db.executescript("""
CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, handle TEXT, avatar_url TEXT);
CREATE TABLE listings (
  id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, starts_at INTEGER, duration_min INTEGER, price INTEGER,
  currency_display TEXT, free_entry INTEGER, attrs TEXT, capacity INTEGER
);
CREATE TABLE bookings (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, creator_id TEXT NOT NULL, buyer_id TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, starts_at INTEGER, ends_at INTEGER, price INTEGER, order_id TEXT
);
CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT);
CREATE TABLE commercial_entitlements (
  entitlement_id TEXT PRIMARY KEY, kind TEXT NOT NULL, listing_id TEXT NOT NULL,
  booking_id TEXT, order_id TEXT, account_id TEXT NOT NULL, role TEXT NOT NULL,
  state TEXT NOT NULL, starts_at INTEGER, ends_at INTEGER
);
CREATE TABLE commercial_sessions (
  commercial_session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, listing_id TEXT NOT NULL,
  booking_id TEXT, state TEXT, settlement_state TEXT, session_version INTEGER,
  updated_at INTEGER
);
CREATE TABLE commercial_receipts (
  receipt_id TEXT PRIMARY KEY, commercial_session_id TEXT, order_id TEXT,
  settlement_state TEXT, issued_at INTEGER
);
CREATE TABLE commercial_refund_receipts (
  refund_receipt_id TEXT PRIMARY KEY, order_id TEXT, refunded_amount INTEGER,
  remaining_amount INTEGER, reason TEXT, settlement_state TEXT, issued_at INTEGER
);
""")

NOW = 1_800_000_000_000
BUYER = "buyer-a"
CREATOR = "creator-a"

def execute(sql, args):
    return [dict(row) for row in db.execute(sql, args).fetchall()]

def listing(lid, creator=CREATOR, kind="live_event", status="published", start=None, duration=60):
    db.execute(
        "INSERT INTO listings (id,creator_id,kind,title,status,starts_at,duration_min,price,currency_display) VALUES (?,?,?,?,?,?,?,?,?)",
        (lid, creator, kind, f"Title {lid}", status, start if start is not None else NOW + 7_200_000, duration, 100, "AVA"),
    )

def order(oid, status="confirmed"):
    db.execute("INSERT INTO orders (id,status) VALUES (?,?)", (oid, status))

def entitlement(eid, lid, oid, state="reserved", role="viewer", account=BUYER, booking=None, start=None, end=None):
    start = start if start is not None else NOW + 7_200_000
    end = end if end is not None else start + 3_600_000
    db.execute(
        "INSERT INTO commercial_entitlements (entitlement_id,kind,listing_id,booking_id,order_id,account_id,role,state,starts_at,ends_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (eid, "consult_1to1" if booking else "live_event", lid, booking, oid, account, role, state, start, end),
    )

for uid in (BUYER, CREATOR, "buyer-b", "creator-b"):
    db.execute("INSERT INTO users (uid,display_name,handle,avatar_url) VALUES (?,?,?,?)", (uid, uid, uid, None))

# More than two pages of actionable customer rows, with strictly ordered keys.
for i in range(123):
    lid = f"page-{i:03d}"
    start = NOW + 7_200_000 + i * 60_000
    listing(lid, start=start)
    oid = f"order-page-{i:03d}"
    order(oid)
    entitlement(f"ent-page-{i:03d}", lid, oid, start=start, end=start + 3_600_000)

# One currently live customer ticket and one row owned by another account.
listing("live-ticket", start=NOW - 600_000, duration=60)
order("order-live")
entitlement("ent-live", "live-ticket", "order-live", state="active", start=NOW - 600_000, end=NOW + 3_000_000)
db.execute("INSERT INTO commercial_sessions (commercial_session_id,kind,listing_id,state,settlement_state,session_version,updated_at) VALUES (?,?,?,?,?,?,?)", ("session-live", "live_event", "live-ticket", "live", "not_ready", 1, NOW))

for i, status in enumerate(("canceled_user", "canceled_creator", "refunded", "no_show_user", "no_show_creator")):
    lid = f"terminal-{i}"
    listing(lid, start=NOW + 7_200_000 + 300_000 + i * 60_000)
    oid = f"order-terminal-{i}"
    order(oid, status)
    entitlement(f"ent-terminal-{i}", lid, oid, start=NOW + 7_200_000 + 300_000 + i * 60_000)
    if status == "refunded":
        db.execute("INSERT INTO commercial_refund_receipts (refund_receipt_id,order_id,refunded_amount,remaining_amount,reason,settlement_state,issued_at) VALUES (?,?,?,?,?,?,?)", (f"refund-{i}", oid, 100, 0, "refund", "refunded", NOW))

listing("other-account", creator=CREATOR)
order("order-other")
entitlement("ent-other", "other-account", "order-other", account="buyer-b")

# Creator projection must include an event with no room/session and a booked
# consultation, while excluding a listing and booking owned by another creator.
listing("creator-event", creator=CREATOR, start=NOW + 4_000_000)
listing("foreign-event", creator="creator-b", start=NOW + 4_000_000)
listing("creator-consult", creator=CREATOR, kind="consult_1to1", start=NOW + 5_000_000)
listing("foreign-consult", creator="creator-b", kind="consult_1to1", start=NOW + 5_000_000)
order("order-creator-consult")
db.execute("INSERT INTO bookings (id,listing_id,creator_id,buyer_id,kind,status,starts_at,ends_at,price,order_id) VALUES (?,?,?,?,?,?,?,?,?,?)", ("booking-creator", "creator-consult", CREATOR, BUYER, "consult_1to1", "confirmed", NOW + 5_000_000, NOW + 8_600_000, 100, "order-creator-consult"))
order("order-foreign-consult")
db.execute("INSERT INTO bookings (id,listing_id,creator_id,buyer_id,kind,status,starts_at,ends_at,price,order_id) VALUES (?,?,?,?,?,?,?,?,?,?)", ("booking-foreign", "foreign-consult", "creator-b", BUYER, "consult_1to1", "confirmed", NOW + 5_000_000, NOW + 8_600_000, 100, "order-foreign-consult"))

def page(sql, account, filter_sql, limit=50):
    cursor = (None, None, None)
    keys = []
    pages = 0
    while True:
        rows = execute(sql, (account, NOW, cursor[0], cursor[1], cursor[2], limit + 1))
        visible = rows[:limit]
        keys.extend(row["product_key"] for row in visible)
        pages += 1
        if len(rows) <= limit:
            break
        last = visible[-1]
        cursor = (last["sort_rank"], last["sort_start"], last["product_key"])
        if pages > 20:
            raise AssertionError("cursor did not advance")
    return keys

customer = payload["customer_sql"]
creator = payload["creator_sql"]
all_customer = page(customer, BUYER, "1=1")
cancelled_customer = page(customer.replace("WHERE 1=1 AND", "WHERE cancelled_flag=1 AND"), BUYER, "cancelled_flag=1")
creator_rows = execute(creator, (CREATOR, NOW, None, None, None, 101))

print(json.dumps({
    "customer_keys": all_customer,
    "customer_unique": len(set(all_customer)),
    "cancelled_keys": cancelled_customer,
    "creator_keys": [row["product_key"] for row in creator_rows],
    "creator_rows": creator_rows,
}))
`;

function runSqlHarness(): {
  customer_keys: string[];
  customer_unique: number;
  cancelled_keys: string[];
  creator_keys: string[];
  creator_rows: Array<Record<string, unknown>>;
} {
  if (queryTemplates.length !== 2) throw new Error(`expected customer + creator query templates, got ${queryTemplates.length}`);
  const output = execFileSync("python3", ["-c", SQLITE_HARNESS], {
    cwd: root,
    input: JSON.stringify({
      customer_sql: routeSql(queryTemplates[0], "1=1"),
      creator_sql: routeSql(queryTemplates[1], "1=1"),
    }),
    encoding: "utf8",
  });
  return JSON.parse(output) as ReturnType<typeof runSqlHarness>;
}

describe("commercial schedule projection SQL", () => {
  it("executes both creator UNION arms and keeps account ownership boundaries", () => {
    const result = runSqlHarness();
    expect(result.creator_keys).toContain("live_event:creator-event");
    expect(result.creator_keys).toContain("consult_1to1:booking-creator");
    expect(result.creator_keys).not.toContain("live_event:foreign-event");
    expect(result.creator_keys).not.toContain("consult_1to1:booking-foreign");
    expect(result.creator_rows.find((row) => row.product_key === "consult_1to1:booking-creator")?.counterparty_id).toBe("buyer-a");
  });

  it("pages every customer row beyond the 50-row page size without duplicates", () => {
    const result = runSqlHarness();
    expect(result.customer_keys.length).toBeGreaterThan(125);
    expect(result.customer_unique).toBe(result.customer_keys.length);
    expect(result.customer_keys).not.toContain("live_event:other-account");
    expect(result.customer_keys.every((key) => key.includes("page-") || key === "live_event:live-ticket:" || key.startsWith("live_event:terminal-"))).toBe(true);
  });

  it("groups canceled and refunded spellings into the terminal view", () => {
    const result = runSqlHarness();
    expect(result.cancelled_keys).toEqual(expect.arrayContaining([
      "live_event:terminal-0:",
      "live_event:terminal-1:",
      "live_event:terminal-2:",
      "live_event:terminal-3:",
      "live_event:terminal-4:",
    ]));
  });
});
