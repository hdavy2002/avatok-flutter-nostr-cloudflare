// @ts-nocheck -- uses node:sqlite via the D1 shim
// [HF-ADMIN-COMPLETE-1] The desk acts: member page, wallets list, support resolve/note/reply, report review, money-alert resolve.
// Every write is admin-only (403 otherwise), leaves an hf_admin_actions row AND an admin_audit row, and emits hf_admin_action.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makeDb } from "../lib/hf_token_d1_shim";

let currentUid = "admin1";
const tracked: any[] = [];
const emails: any[] = [];
const waSent: any[] = [];
let waResult: any = { ok: true };
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: currentUid }), isFail: (x: any) => x.error !== undefined }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin1" }));
vi.mock("../hooks", () => ({ track: (_e: any, uid: string, event: string, _a: string, props: any) => { tracked.push({ uid, event, props }); }, trackException: async (_e: any, err: any) => { console.error("ACTION ERR", String(err)); } }));
vi.mock("../lib/email_outbox", () => ({ enqueueEmail: async (_e: any, m: any) => { emails.push(m); return { status: "queued", queued: true, durable: true, outboxKey: m.outboxKey }; } }));
vi.mock("../lib/whatsapp_send", () => ({ sendWhatsAppText: async (_e: any, to: string, text: string) => { waSent.push({ to, text }); return waResult; } }));
vi.mock("../lib/identity", () => ({ emailFor: async (env: any, uid: string) => (uid === "u_reg" ? "asha@example.com" : null) }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async (_e: any, uid: string) => (uid === "u_reg" ? "+919811122233" : null) }));
vi.mock("./hf_calls", () => ({ walletGetFor: async (_e: any, uid: string) => new Response(JSON.stringify({ mode: "rupees", wallet: { currency: "INR", balancePaise: 123456, availablePaise: 100000, reservedPaise: 23456, paidPaise: 100000, testPaise: 0, debtPaise: 0 }, history: [] })) }));
vi.mock("../lib/hf_token_ledger", () => ({ balanceSummary: async (_e: any, uid: string) => ({ totalPaise: uid === "u_reg" ? 123456 : 5, availablePaise: uid === "u_reg" ? 100000 : 5, debtValuePaise: 0 }) }));
import { hfAdminDeskActionsRoute } from "./hf_admin_desk_actions";
import { hfMoneyAuditRoute } from "./hf_money_audit";

const MIGS = [
  "2026-10-09-hf-hosts.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-topups.sql", "2026-10-09-hf-payouts.sql", "2026-10-10-hf-auth-wa.sql",
  "2026-10-10-hf-wallet-exit.sql", "2026-10-10-hf-wallet-limits.sql", "2026-10-12-hf-registration.sql", "2026-10-12-hf-registration-progress.sql",
  "2026-10-16-hf-dash-v3.sql", "2026-10-19-hf-user-email.sql", "2026-10-19-hf-money-audit.sql", "2026-10-23-hf-reports.sql", "2026-10-23-hf-admin-actions.sql",
  "2026-10-12-hf-creator-price-alters.sql", "2026-10-15-hf-topups-rupee-wallet.sql",
];
let env: any;
const raw = () => env.DB_META._raw;
const NOW = Date.now();
const call = async (method: string, path: string, body?: any) => {
  const res = await hfAdminDeskActionsRoute(new Request(`https://x.test${path}`, { method, body: body ? JSON.stringify(body) : undefined }), env, path.split("?")[0]);
  return { status: res!.status, body: await res!.json() };
};
const actions = (type: string, id: string) => raw().prepare("SELECT * FROM hf_admin_actions WHERE subject_type=? AND subject_id=? ORDER BY rowid").all(type, id);
const audits = () => env.DB_WALLET._raw.prepare("SELECT * FROM admin_audit ORDER BY rowid").all();

beforeEach(() => {
  currentUid = "admin1"; tracked.length = 0; emails.length = 0; waSent.length = 0; waResult = { ok: true };
  env = { DB_META: makeDb(MIGS, { alters: true }), DB_WALLET: makeDb(["wallet_ledger.sql"]) };
  try { raw().exec("ALTER TABLE hf_calls ADD COLUMN booking_id TEXT"); } catch { /* already */ }
  for (const f of ["2026-10-13-hf-bookings.sql", "2026-10-19-hf-booking-notes.sql", "2026-10-20-hf-booking-approval-alters.sql"]) {
    const lines = readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8").split("\n");
    try { raw().exec(lines.filter((l) => !l.trim().startsWith("ALTER TABLE")).join("\n")); } catch { /* optional */ }
    for (const l of lines.filter((x) => x.trim().startsWith("ALTER TABLE"))) { try { raw().exec(l.replace(/--.*$/, "")); } catch { /* there */ } }
  }
  raw().exec(`CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, created_at INTEGER, updated_at INTEGER, created_via TEXT, private_number TEXT, phone_hash TEXT);
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, email_verified INTEGER);
    CREATE TABLE account_status (clerk_user_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE hf_token_lots (id TEXT PRIMARY KEY, uid TEXT);`);
  raw().prepare("INSERT INTO users (uid, display_name, created_at, updated_at, created_via, private_number) VALUES ('u_reg','Asha K',?,?, 'web','+919811122233')").run(NOW - 50_000, NOW);
  raw().prepare("INSERT INTO hf_user_registration (uid, first_name, last_name, username, terms_accepted_at, privacy_accepted_at, disclaimer_accepted_at, community_accepted_at, engagement_accepted_at, created_at) VALUES ('u_reg','Asha','Kumar','asha.k',1,1,1,1,1,?)").run(NOW);
  raw().prepare("INSERT INTO contact_verification (uid, phone_verified, email_verified) VALUES ('u_reg',1,1)").run();
  raw().prepare("INSERT INTO hf_user_email (uid, email, updated_at) VALUES ('u_reg','asha@example.com',?)").run(NOW);
  raw().prepare("INSERT INTO users (uid, display_name, created_at, updated_at, created_via) VALUES ('u_host','Priya',?,?, 'web')").run(NOW - 40_000, NOW);
  raw().prepare("INSERT INTO hf_user_registration (uid, first_name, last_name, username, terms_accepted_at, privacy_accepted_at, disclaimer_accepted_at, community_accepted_at, engagement_accepted_at, created_at) VALUES ('u_host','Priya','S','priya.s',1,1,1,1,1,?)").run(NOW);
  raw().prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, created_at, updated_at) VALUES ('u_host','priya','live','Priya',?,?)").run(NOW, NOW);
  raw().prepare("INSERT INTO hf_topups (id, uid, amount_rupees, gateway, status, credited, created_at, updated_at, paid_at) VALUES ('hftop_1','u_reg',1000,'cashfree','paid',1,?,?,?)").run(NOW, NOW, NOW);
  raw().prepare("INSERT INTO hf_support_tickets (id, uid, topic, message, status, created_at, updated_at) VALUES ('HF-T-1','u_reg','payment','my money is stuck here','open', ?, ?)").run(NOW, NOW);
  raw().prepare("INSERT INTO hf_reports (id, uid, contact, profile, call_ref, details, status, created_at) VALUES ('HF-R-1','u_reg','asha@example.com','@priya','call_1','abusive language on the call','open',?)").run(NOW);
  raw().prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, created_at) VALUES ('call_1','u_reg','u_host',2000,?)").run(NOW);
  raw().prepare("INSERT INTO hf_incidents (id, call_id, reporter_uid, kind, created_at) VALUES ('i1','call_1','u_reg','dash_report:rude',?)").run(NOW);
  raw().prepare("INSERT INTO hf_blocks (blocker_uid, blocked_uid, call_id, created_at) VALUES ('u_reg','u_host','call_1',?)").run(NOW);
  raw().prepare("INSERT INTO hf_money_audit (id, kind, subject_type, subject_id, rule, status, uid, created_at, updated_at) VALUES ('m1','call','call','call_1','charge_mismatch','open','u_reg',?,?)").run(NOW, NOW);
});

describe("hf admin desk: member page and wallets", () => {
  it("shows one member with the rupee wallet (paise kept), top-ups, blocks and tickets", async () => {
    const r = await call("GET", "/api/admin/hf/desk/member?uid=u_reg");
    expect(r.status).toBe(200);
    expect(r.body.member).toMatchObject({ uid: "u_reg", name: "Asha Kumar", username: "asha.k", email: "asha@example.com", whatsappVerified: true });
    expect(r.body.wallet).toMatchObject({ mode: "rupees", balanceRupees: 1234.56, availableRupees: 1000, reservedRupees: 234.56 });
    expect(r.body.topups[0]).toMatchObject({ id: "hftop_1", amountRupees: 1000 });
    expect(r.body.blocks.ofMember[0]).toMatchObject({ uid: "u_host" });
    expect(r.body.tickets[0].id).toBe("HF-T-1");
    expect(r.body.incidents[0].id).toBe("i1");
    expect(r.body.reports[0].id).toBe("HF-R-1");
    // the host sees the report about them (profile text = their slug)
    const h = await call("GET", "/api/admin/hf/desk/member?uid=u_host");
    expect(h.body.reports.map((x: any) => x.id)).toContain("HF-R-1");
    expect(h.body.blocks.byMember[0]).toMatchObject({ uid: "u_reg" });
  });
  it("404s an unknown member and 400s a bad id", async () => {
    expect((await call("GET", "/api/admin/hf/desk/member?uid=nobody")).status).toBe(404);
    expect((await call("GET", "/api/admin/hf/desk/member?uid=a b")).status).toBe(400);
  });
  it("lists wallets with the rupee balance", async () => {
    raw().prepare("INSERT INTO hf_token_lots (id, uid) VALUES ('l1','u_reg')").run();
    const r = await call("GET", "/api/admin/hf/desk/wallets");
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ uid: "u_reg", balanceRupees: 1234.56, availableRupees: 1000, paidTopupRupees: 1000 });
  });
});

describe("hf admin desk: support actions", () => {
  it("adds a note, replies by email and WhatsApp, resolves and reopens, each with an action row, audit row and telemetry", async () => {
    expect((await call("POST", "/api/admin/hf/desk/support/HF-T-1/note", { note: "Checked: top-up is credited" })).status).toBe(200);
    const em = await call("POST", "/api/admin/hf/desk/support/HF-T-1/reply", { channel: "email", message: "Your money is safe." });
    expect(em.status).toBe(200);
    expect(emails[0]).toMatchObject({ to: "asha@example.com", kind: "hf_admin_reply" });
    const wa = await call("POST", "/api/admin/hf/desk/support/HF-T-1/reply", { channel: "whatsapp", message: "Your money is safe." });
    expect(wa.status).toBe(200);
    expect(waSent[0]).toMatchObject({ to: "+919811122233" });
    const rs = await call("POST", "/api/admin/hf/desk/support/HF-T-1/resolve", { note: "answered" });
    expect(rs.body).toMatchObject({ ok: true, status: "closed", audited: true });
    expect(raw().prepare("SELECT status FROM hf_support_tickets WHERE id='HF-T-1'").get().status).toBe("closed");
    await call("POST", "/api/admin/hf/desk/support/HF-T-1/reopen", {});
    expect(raw().prepare("SELECT status FROM hf_support_tickets WHERE id='HF-T-1'").get().status).toBe("open");
    expect(actions("ticket", "HF-T-1").map((a: any) => a.action)).toEqual(["note", "reply_email", "reply_whatsapp", "resolve", "reopen"]);
    expect(audits().map((a: any) => a.action)).toEqual(["hf_desk_ticket_note", "hf_desk_ticket_reply_email", "hf_desk_ticket_reply_whatsapp", "hf_desk_ticket_resolve", "hf_desk_ticket_reopen"]);
    expect(audits()[0].admin_id).toBe("admin1");
    expect(tracked.filter((t) => t.event === "hf_admin_action")).toHaveLength(5);
    // the support list now carries the timeline
    const { hfAdminDeskRoute } = await import("./hf_admin_desk");
    const list = await (await hfAdminDeskRoute(new Request("https://x.test/api/admin/hf/desk/support"), env, "/api/admin/hf/desk/support")).json();
    expect(list.items[0].actions).toHaveLength(5);
  });
  it("reports a delivery problem without logging a reply that never went out", async () => {
    waResult = { ok: false, reason: "not_on_whatsapp", detail: "x" };
    const r = await call("POST", "/api/admin/hf/desk/support/HF-T-1/reply", { channel: "whatsapp", message: "hello there" });
    expect(r.status).toBe(422);
    expect(actions("ticket", "HF-T-1")).toHaveLength(0);
    expect(audits()).toHaveLength(0);
    raw().prepare("INSERT INTO hf_support_tickets (id, uid, topic, message, status, created_at, updated_at) VALUES ('HF-T-2','u_host','other','hi','open',?,?)").run(NOW, NOW);
    expect((await call("POST", "/api/admin/hf/desk/support/HF-T-2/reply", { channel: "email", message: "hello there" })).body.error).toBe("no_email");
  });
  it("validates input and unknown ids", async () => {
    expect((await call("POST", "/api/admin/hf/desk/support/HF-T-1/note", { note: "" })).status).toBe(400);
    expect((await call("POST", "/api/admin/hf/desk/support/HF-T-1/reply", { channel: "sms", message: "hello there" })).status).toBe(400);
    expect((await call("POST", "/api/admin/hf/desk/support/NOPE/resolve", {})).status).toBe(404);
  });
});

describe("hf admin desk: report actions", () => {
  it("marks a /report submission reviewed with a reason, links the reported member, and replies to the reporter", async () => {
    expect((await call("POST", "/api/admin/hf/desk/reports/HF-R-1/review", { status: "actioned" })).status).toBe(400); // reason required
    const r = await call("POST", "/api/admin/hf/desk/reports/HF-R-1/review", { status: "actioned", reason: "Warned the host" });
    expect(r.body).toMatchObject({ ok: true, status: "actioned", audited: true });
    expect(raw().prepare("SELECT status FROM hf_reports WHERE id='HF-R-1'").get().status).toBe("actioned");
    expect(actions("report", "HF-R-1")[0]).toMatchObject({ action: "actioned", body: "Warned the host", admin_uid: "admin1" });
    expect(audits()[0]).toMatchObject({ action: "hf_desk_report_actioned", target: "HF-R-1" });
    await call("POST", "/api/admin/hf/desk/reports/HF-R-1/reply", { channel: "email", message: "Thanks, we acted." });
    expect(emails[0].to).toBe("asha@example.com"); // the typed contact is an email
    const { hfAdminDeskRoute } = await import("./hf_admin_desk");
    const list = await (await hfAdminDeskRoute(new Request("https://x.test/api/admin/hf/desk/reports"), env, "/api/admin/hf/desk/reports")).json();
    expect(list.userReports[0]).toMatchObject({ id: "HF-R-1", status: "actioned", reportedUid: "u_host" });
    expect(list.userReports[0].actions.map((a: any) => a.action)).toEqual(["actioned", "reply_email"]);
  });
  it("reviews a call incident (state derives from the newest review action) and notes a member", async () => {
    await call("POST", "/api/admin/hf/desk/incidents/i1/review", { status: "reviewed", reason: "Looked at it, fine" });
    const { hfAdminDeskRoute } = await import("./hf_admin_desk");
    const list = await (await hfAdminDeskRoute(new Request("https://x.test/api/admin/hf/desk/reports"), env, "/api/admin/hf/desk/reports")).json();
    expect(list.incidents[0]).toMatchObject({ id: "i1", state: "reviewed" });
    const sum = await (await hfAdminDeskRoute(new Request("https://x.test/api/admin/hf/desk/summary"), env, "/api/admin/hf/desk/summary")).json();
    expect(sum.reportsOpen).toBe(1); // the /report form is still open, the incident is reviewed
    expect(sum.moneyAlertsOpen).toBe(1);
    expect((await call("POST", "/api/admin/hf/desk/member/u_reg/note", { note: "Regular caller, polite" })).status).toBe(200);
    expect((await call("GET", "/api/admin/hf/desk/member?uid=u_reg")).body.notes[0].body).toBe("Regular caller, polite");
  });
});

describe("hf admin desk: money alert resolve and permissions", () => {
  it("resolves a money alert with a note, an audit row and telemetry", async () => {
    const res = await hfMoneyAuditRoute(new Request("https://x.test/api/admin/hf/money-audit/m1/resolve", { method: "POST", body: JSON.stringify({ note: "Refunded by hand" }) }), env, "/api/admin/hf/money-audit/m1/resolve");
    expect(res!.status).toBe(200);
    expect(raw().prepare("SELECT status FROM hf_money_audit WHERE id='m1'").get().status).toBe("resolved");
    expect(actions("money", "m1")[0].body).toBe("Refunded by hand");
    expect(audits()[0]).toMatchObject({ action: "hf_desk_money_resolve", target: "m1" });
    expect(tracked.at(-1)).toMatchObject({ event: "hf_admin_action", props: { kind: "money" } });
  });
  it("returns the shape the Money alerts tab reads: cases, counts and a before-cursor", async () => {
    const res = await hfMoneyAuditRoute(new Request("https://x.test/api/admin/hf/money-audit?status=open"), env, "/api/admin/hf/money-audit");
    const j = await res!.json();
    expect(j.cases[0]).toMatchObject({ id: "m1", rule: "charge_mismatch", status: "open", subject_id: "call_1" });
    expect(j.counts.open).toBe(1);
    expect("next" in j).toBe(true);
  });
  it("refuses non-admins on every route and writes nothing", async () => {
    currentUid = "someone";
    for (const [m, p, b] of [["GET", "/api/admin/hf/desk/member?uid=u_reg"], ["GET", "/api/admin/hf/desk/wallets"], ["POST", "/api/admin/hf/desk/support/HF-T-1/resolve", {}],
      ["POST", "/api/admin/hf/desk/reports/HF-R-1/review", { status: "closed", reason: "nope nope" }], ["POST", "/api/admin/hf/desk/incidents/i1/review", { status: "closed", reason: "nope nope" }],
      ["POST", "/api/admin/hf/desk/support/HF-T-1/reply", { channel: "email", message: "hello there" }], ["POST", "/api/admin/hf/desk/member/u_reg/note", { note: "nope" }]] as any) {
      expect((await call(m, p, b)).status).toBe(403);
    }
    const res = await hfMoneyAuditRoute(new Request("https://x.test/api/admin/hf/money-audit/m1/resolve", { method: "POST" }), env, "/api/admin/hf/money-audit/m1/resolve");
    expect(res!.status).toBe(403);
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_admin_actions").get().n).toBe(0);
    expect(audits()).toHaveLength(0);
    expect(emails).toHaveLength(0);
    expect(raw().prepare("SELECT status FROM hf_support_tickets WHERE id='HF-T-1'").get().status).toBe("open");
  });
  it("rejects wrong methods and ignores unrelated paths", async () => {
    expect((await call("GET", "/api/admin/hf/desk/support/HF-T-1/resolve")).status).toBe(405);
    expect((await call("POST", "/api/admin/hf/desk/wallets", {})).status).toBe(405);
    expect(await hfAdminDeskActionsRoute(new Request("https://x.test/api/admin/hf/desk/members"), env, "/api/admin/hf/desk/members")).toBeNull();
  });
});
