// @ts-nocheck -- uses node:sqlite via the D1 shim
// [HF-ADMIN-SWEEP-1] The read-only admin desk: a new sign-up shows up, lists join names, money is rupees, only admins get in.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makeDb } from "../lib/hf_token_d1_shim";

let currentUid = "admin1";
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: currentUid }), isFail: (x: any) => x.error !== undefined }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin1" }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async (_e: any, err: any) => { console.error("DESK ERR", String(err)); } }));
import { hfAdminDeskRoute, maskPhone } from "./hf_admin_desk";

const MIGS = [
  "2026-10-09-hf-hosts.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-topups.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-auth-wa.sql",
  "2026-10-10-hf-wallet-exit.sql", "2026-10-10-hf-wallet-limits.sql", "2026-10-12-hf-registration.sql", "2026-10-12-hf-registration-progress.sql",
  "2026-10-16-hf-dash-v3.sql", "2026-10-19-hf-user-email.sql", "2026-10-19-hf-money-audit.sql",
  "2026-10-12-hf-creator-price-alters.sql", "2026-10-15-hf-topups-rupee-wallet.sql",
];
let env: any;
const raw = () => env.DB_META._raw;
const get = async (path: string) => {
  const res = await hfAdminDeskRoute(new Request(`https://x.test${path}`), env, path.split("?")[0]);
  return { status: res!.status, body: await res!.json() };
};
const NOW = Date.now();

beforeEach(() => {
  currentUid = "admin1";
  env = { DB_META: makeDb(MIGS, { alters: true }) };
  // hf_bookings' index reads hf_calls.booking_id, which production adds by ALTER first.
  try { raw().exec("ALTER TABLE hf_calls ADD COLUMN booking_id TEXT"); } catch { /* already there */ }
  for (const f of ["2026-10-13-hf-bookings.sql", "2026-10-19-hf-booking-notes.sql", "2026-10-20-hf-booking-approval-alters.sql"]) {
    const lines = readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8").split("\n");
    try { raw().exec(lines.filter((l) => !l.trim().startsWith("ALTER TABLE")).join("\n")); } catch { /* optional file */ }
    for (const l of lines.filter((x) => x.trim().startsWith("ALTER TABLE"))) { try { raw().exec(l.replace(/--.*$/, "")); } catch { /* column there */ } }
  }
  raw().exec(`CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, created_at INTEGER, updated_at INTEGER, created_via TEXT, private_number TEXT, phone_hash TEXT);
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, email_verified INTEGER);
    CREATE TABLE account_status (clerk_user_id TEXT PRIMARY KEY, status TEXT);`);
  // A brand-new WhatsApp sign-up that has not finished the profile, and a registered caller who topped up and booked.
  raw().prepare("INSERT INTO users (uid, created_at, updated_at, created_via, private_number) VALUES ('u_new', ?, ?, 'web', '+919876543210')").run(NOW - 1000, NOW);
  raw().prepare("INSERT INTO hf_phone_signup (phone_hash, ext_id, uid, state, lease_at, created_at) VALUES ('h1','x1','u_new','done',0,?)").run(NOW);
  raw().prepare("INSERT INTO users (uid, display_name, created_at, updated_at, created_via) VALUES ('u_reg','Asha K',?,?, 'web')").run(NOW - 50_000, NOW);
  raw().prepare("INSERT INTO hf_user_registration (uid, first_name, last_name, username, terms_accepted_at, privacy_accepted_at, disclaimer_accepted_at, community_accepted_at, engagement_accepted_at, created_at) VALUES ('u_reg','Asha','Kumar','asha.k',1,1,1,1,1,?)").run(NOW);
  raw().prepare("INSERT INTO contact_verification (uid, phone_verified, email_verified) VALUES ('u_reg',1,1)").run();
  raw().prepare("INSERT INTO hf_user_email (uid, email, updated_at) VALUES ('u_reg','asha@example.com',?)").run(NOW);
  // an unrelated (Saathum) user must NOT appear in HF sign-ups
  raw().prepare("INSERT INTO users (uid, display_name, created_at, updated_at) VALUES ('u_saathum','Other',?,?)").run(NOW, NOW);
  raw().prepare("INSERT INTO hf_topups (id, uid, amount_rupees, gateway, status, credited, created_at, updated_at, paid_at) VALUES ('hftop_1','u_reg',1000,'cashfree','paid',1,?,?,?)").run(NOW, NOW, NOW);
  raw().prepare("INSERT INTO hf_support_tickets (id, uid, topic, message, status, created_at, updated_at) VALUES ('HF-T-1','u_reg','payment','my money is stuck here',  'open', ?, ?)").run(NOW, NOW);
});

describe("hf admin desk", () => {
  it("lists a brand-new sign-up first, with a masked phone, and leaves non-HF users out", async () => {
    const r = await get("/api/admin/hf/desk/members");
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => x.uid)).toEqual(["u_new", "u_reg"]);
    expect(r.body.items[0].phone).toBe("+91 ••••• 3210");
    expect(r.body.items[0].registeredAt).toBeNull();
    const asha = r.body.items[1];
    expect(asha).toMatchObject({ name: "Asha Kumar", username: "asha.k", email: "asha@example.com", whatsappVerified: true, emailVerified: true, topups: 1, topupRupees: 1000 });
  });
  it("searches by username and by last digits of the WhatsApp number", async () => {
    expect((await get("/api/admin/hf/desk/members?q=asha")).body.items.map((x: any) => x.uid)).toEqual(["u_reg"]);
    expect((await get("/api/admin/hf/desk/members?q=3210")).body.items.map((x: any) => x.uid)).toEqual(["u_new"]);
  });
  it("shows bookings with names and rupees", async () => {
    raw().prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, created_at, updated_at) VALUES ('h_1','priya','live','Priya',?,?)").run(NOW, NOW);
    raw().prepare(`INSERT INTO hf_bookings (id, host_uid, customer_uid, starts_at, ends_at, host_timezone, schedule_version, quote_id, idempotency_key, status, duration_min, reserved_paise, expected_host_net_paise,
      price_snapshot_json, policy_snapshot_json, reservation_snapshot_json, created_at, updated_at) VALUES ('b1','h_1','u_reg',?,?, 'Asia/Kolkata',1,'q1','k1','cancelled',30,45000,20000,'{}','{}','{}',?,?)`).run(NOW, NOW + 1800_000, NOW, NOW);
    const r = await get("/api/admin/hf/desk/bookings");
    expect(r.body.items[0]).toMatchObject({ id: "b1", hostName: "Priya", customerName: "Asha Kumar", reservedRupees: 450, status: "cancelled" });
    expect(r.body.counts.cancelled).toMatchObject({ n: 1, rupees: 450 });
  });
  it("shows top-ups with today/month totals and support tickets with the sender", async () => {
    const t = await get("/api/admin/hf/desk/topups?status=paid");
    expect(t.body.items[0]).toMatchObject({ id: "hftop_1", name: "Asha Kumar", amountRupees: 1000 });
    expect(t.body.today.rupees).toBe(1000);
    const s = await get("/api/admin/hf/desk/support");
    expect(s.body.items[0]).toMatchObject({ id: "HF-T-1", name: "Asha Kumar", email: "asha@example.com", status: "open" });
    expect(s.body.counts.open).toBe(1);
  });
  it("lists reports and blocks, and the summary counts", async () => {
    raw().prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, created_at) VALUES ('call_1','u_reg','u_new',2000,?)").run(NOW);
    raw().prepare("INSERT INTO hf_incidents (id, call_id, reporter_uid, kind, created_at) VALUES ('i1','call_1','u_reg','dash_report:rude',?)").run(NOW);
    raw().prepare("INSERT INTO hf_blocks (blocker_uid, blocked_uid, call_id, created_at) VALUES ('u_reg','u_new','call_1',?)").run(NOW);
    const r = await get("/api/admin/hf/desk/reports");
    expect(r.body.incidents[0]).toMatchObject({ reporterName: "Asha Kumar", otherUid: "u_new", kind: "dash_report:rude" });
    expect(r.body.blocks[0]).toMatchObject({ blockerUid: "u_reg", blockedUid: "u_new" });
    const sum = await get("/api/admin/hf/desk/summary");
    expect(sum.body.members).toMatchObject({ total: 2, last24h: 2, registered: 1 });
    expect(sum.body.ticketsOpen).toBe(1);
  });
  it("refuses non-admins and non-GET", async () => {
    currentUid = "someone";
    expect((await get("/api/admin/hf/desk/members")).status).toBe(403);
    currentUid = "admin1";
    const res = await hfAdminDeskRoute(new Request("https://x.test/api/admin/hf/desk/members", { method: "POST" }), env, "/api/admin/hf/desk/members");
    expect(res!.status).toBe(405);
    expect(await hfAdminDeskRoute(new Request("https://x.test/api/other"), env, "/api/other")).toBeNull();
  });
  it("maskPhone keeps only the last four digits", () => {
    expect(maskPhone("+919876543210")).toBe("+91 ••••• 3210");
    expect(maskPhone(null)).toBeNull();
  });
});
