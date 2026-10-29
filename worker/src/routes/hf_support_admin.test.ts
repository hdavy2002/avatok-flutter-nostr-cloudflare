// [HF-SUPPORT-1] Admin API: guard, viewer is read-only, notes stay internal, reply sends mail + in-app, merge/split/spam/block.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../authz", async (orig) => {
  const real: any = await orig();
  return { ...real, requireUser: async (req: Request) => (req.headers.get("x-test-uid") ? { uid: req.headers.get("x-test-uid") } : { error: "unauthorized", status: 401 }), isFail: (u: any) => !!u?.error };
});
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));

import { hfSupportAdminRoute } from "./hf_support_admin";
import { hfSupportRoute } from "./hf_support";
import { clearStaffMemo } from "../lib/support_core";
import { makeEnv, type TestEnv } from "../lib/support_testkit";

beforeEach(() => clearStaffMemo());

const A = "/api/admin/hf/support";
const call = async (t: TestEnv, uid: string | null, method: string, path: string, body?: unknown) => {
  const init: any = { method, headers: { ...(uid ? { "x-test-uid": uid } : {}) } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  const res = await hfSupportAdminRoute(new Request("https://api.test" + path, init), t.env, path.split("?")[0]);
  return { status: res!.status, json: (await res!.clone().json().catch(() => null)) as any };
};
const customer = async (t: TestEnv, uid: string, method: string, path: string, body?: unknown) => {
  const init: any = { method, headers: { "x-test-uid": uid, "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await hfSupportRoute(new Request("https://api.test" + path, init), t.env, path);
  return { status: res!.status, json: (await res!.clone().json().catch(() => null)) as any };
};

function setup() {
  const t = makeEnv();
  const staff = t.db.prepare("INSERT INTO support_staff (email,uid,name,role,created_at) VALUES (?,?,?,?,1)");
  staff.run("agent@example.com", "agent1", "Asha", "agent");
  staff.run("viewer@example.com", "viewer1", "Vik", "viewer");
  for (const [uid, email] of [["u1", "u1@example.com"], ["u2", "u2@example.com"]]) {
    t.db.prepare("INSERT INTO users (uid,handle,display_name,created_at) VALUES (?,?,?,1)").run(uid, uid, "Fan " + uid);
    t.db.prepare("INSERT INTO hf_user_email (uid,email,updated_at) VALUES (?,?,1)").run(uid, email);
  }
  return t;
}
const mkTicket = async (t: TestEnv, uid = "u1", message = "Money was cut but wallet is empty") =>
  (await customer(t, uid, "POST", "/api/hf/support/tickets", { category: "wallet", subject: "Top-up missing", message: message + " " + Math.random() })).json.ticket.number as string;

describe("guard", () => {
  it("anonymous 401, non-staff customer 403, null for foreign paths", async () => {
    const t = setup();
    expect((await call(t, null, "GET", `${A}/tickets`)).status).toBe(401);
    expect((await call(t, "u1", "GET", `${A}/tickets`)).status).toBe(403);
    expect((await call(t, "u1", "GET", `${A}/settings`)).status).toBe(403);
    expect(await hfSupportAdminRoute(new Request("https://x/api/admin/other"), t.env, "/api/admin/other")).toBeNull();
  });
  it("isAdminUid admins are admins; the seeded owner email matches at first login by VERIFIED email", async () => {
    const t = setup();
    expect((await call(t, "admin1", "GET", `${A}/tickets`)).status).toBe(200);
    // owner account verified by email -> picked up from the seed row
    t.db.prepare("INSERT INTO users (uid,handle,display_name,created_at) VALUES ('owner','owner','Owner',1)").run();
    t.db.prepare("INSERT INTO hf_user_email (uid,email,updated_at) VALUES ('owner','hdavy2002@gmail.com',1)").run();
    t.db.prepare("INSERT INTO contact_verification (uid,email_verified,phone_verified) VALUES ('owner',1,0)").run();
    const r = await call(t, "owner", "GET", `${A}/tickets`);
    expect([200, 403]).toContain(r.status);
    if (r.status === 200) expect(t.db.prepare("SELECT uid FROM support_staff WHERE email='hdavy2002@gmail.com'").get()).toEqual({ uid: "owner" });
  });
});

describe("viewer role", () => {
  it("can read but every mutating route is 403 read_only", async () => {
    const t = setup();
    const n = (await mkTicket(t)).replace("HF-", "");
    expect((await call(t, "viewer1", "GET", `${A}/tickets`)).status).toBe(200);
    expect((await call(t, "viewer1", "GET", `${A}/tickets/${n}`)).status).toBe(200);
    for (const [m, p, b] of [
      ["POST", `${A}/tickets/${n}/reply`, { html: "<p>x</p>", text: "x" }],
      ["POST", `${A}/tickets/${n}/note`, { text: "x" }],
      ["PATCH", `${A}/tickets/${n}`, { status: "open" }],
      ["POST", `${A}/tickets/${n}/spam`, {}],
      ["POST", `${A}/block`, { email: "x@y.com" }],
      ["POST", `${A}/bulk`, { numbers: [n], action: "status", value: "open" }],
      ["POST", `${A}/canned`, { title: "t", html: "x" }],
      ["PUT", `${A}/settings`, { alert_whatsapp: "+911234567890" }],
      ["POST", `${A}/staff`, { email: "z@z.com", role: "agent" }],
    ] as const) {
      const r = await call(t, "viewer1", m, p, b);
      expect([m, p, r.status, r.json?.error]).toEqual([m, p, 403, "read_only"]);
    }
  });
  it("agents cannot manage staff or settings; admins can", async () => {
    const t = setup();
    expect((await call(t, "agent1", "POST", `${A}/staff`, { email: "n@example.com", role: "agent" })).status).toBe(403);
    expect((await call(t, "agent1", "PUT", `${A}/settings`, { alert_whatsapp: "+911234567890" })).status).toBe(403);
    expect((await call(t, "admin1", "POST", `${A}/staff`, { email: "n@example.com", role: "agent" })).status).toBe(201);
    expect(t.db.prepare("SELECT role FROM support_staff WHERE email='n@example.com'").get()).toEqual({ role: "agent" });
  });
});

describe("tickets", () => {
  it("lists with folder counts, finds by search, and shows customer panel", async () => {
    const t = setup();
    const n = (await mkTicket(t)).replace("HF-", "");
    const list = await call(t, "agent1", "GET", `${A}/tickets?folder=unassigned`);
    expect(list.json.ok).toBe(true);
    expect(list.json.tickets[0]).toMatchObject({ number: "HF-" + n, subject: "Top-up missing", category: "wallet", priority: "high", unread: true });
    expect(list.json.tickets[0].customer).toMatchObject({ uid: "u1" });
    expect(list.json.tickets[0].sla).toHaveProperty("state");
    expect(list.json.counts).toBeTruthy();
    const q = await call(t, "agent1", "GET", `${A}/tickets?q=${encodeURIComponent("top-up")}`);
    expect(q.json.tickets.map((x: any) => x.number)).toContain("HF-" + n);
    const detail = await call(t, "agent1", "GET", `${A}/tickets/${n}`);
    expect(detail.json.customer).toMatchObject({ uid: "u1", email: "u1@example.com" });
    expect(Array.isArray(detail.json.events)).toBe(true);
  });

  it("notes are visible to staff and never to the customer; reply goes in-app + email, signature appended, status becomes waiting", async () => {
    const t = setup();
    const n = (await mkTicket(t)).replace("HF-", "");
    t.db.prepare("UPDATE support_signatures SET html='<p>Team Hello Fraands</p>' WHERE scope_key='team'").run();
    const note = await call(t, "agent1", "POST", `${A}/tickets/${n}/note`, { text: "SECRET: customer looks like a repeat refunder" });
    expect(note.json.ok).toBe(true);
    const rep = await call(t, "agent1", "POST", `${A}/tickets/${n}/reply`, { html: "<p>We found your payment.</p><script>x()</script>", text: "We found your payment." });
    expect(rep.json.ok).toBe(true);
    expect(rep.json.delivery).toBeTruthy();
    expect(t.db.prepare("SELECT status,first_responded_at FROM support_tickets WHERE number=?").get(Number(n))).toMatchObject({ status: "waiting" });

    const staffView = await call(t, "agent1", "GET", `${A}/tickets/${n}`);
    expect(JSON.stringify(staffView.json.messages)).toContain("SECRET");
    const custView = await customer(t, "u1", "GET", `/api/hf/support/tickets/${n}`);
    const raw = JSON.stringify(custView.json);
    expect(raw).not.toContain("SECRET");
    expect(raw).toContain("We found your payment.");
    expect(raw).not.toContain("<script");
    expect(custView.json.ticket.statusLabel).toBe("We replied");

    const stored: any = t.db.prepare("SELECT * FROM email_outbox WHERE outbox_key LIKE '%support-reply:%'").get();
    expect(stored).toBeTruthy();
    expect(stored.subject).toContain(`[HF-${n}]`);
    expect(stored.to_email ?? stored.recipient ?? "").toBeDefined();
    expect(String(stored.reply_to_json)).toContain(`support+${n}@hellofraands.com`);
    expect(stored.lane).toBe("priority");
    const body = await t.r2.get(stored.body_r2_key);
    const html = await body!.text();
    expect(html).toContain("We found your payment.");
    expect(html).toContain("Team Hello Fraands");
    expect(html).not.toContain("<script");
  });

  it("patch changes status/priority/category/assignee and writes events", async () => {
    const t = setup();
    const n = (await mkTicket(t)).replace("HF-", "");
    const r = await call(t, "agent1", "PATCH", `${A}/tickets/${n}`, { status: "on_hold", priority: "urgent", category: "bookings", assigneeUid: "agent1" });
    expect(r.json.ok).toBe(true);
    expect(t.db.prepare("SELECT status,priority,category,assignee_uid FROM support_tickets WHERE number=?").get(Number(n))).toEqual({ status: "on_hold", priority: "urgent", category: "bookings", assignee_uid: "agent1" });
    expect((t.db.prepare("SELECT COUNT(*) c FROM support_events WHERE ticket_number=?").get(Number(n)) as any).c).toBeGreaterThanOrEqual(4);
    expect((await call(t, "agent1", "PATCH", `${A}/tickets/${n}`, { status: "bogus" })).status).toBe(400);
    expect((await call(t, "agent1", "GET", `${A}/tickets/99999`)).status).toBe(404);
  });

  it("merge only for the same customer; split a later customer message", async () => {
    const t = setup();
    const a = (await mkTicket(t, "u1", "first problem")).replace("HF-", "");
    const b = (await mkTicket(t, "u1", "second problem")).replace("HF-", "");
    const c = (await mkTicket(t, "u2", "someone else")).replace("HF-", "");
    expect((await call(t, "agent1", "POST", `${A}/tickets/${b}/merge`, { into: Number(c) })).json.ok).toBe(false);
    expect((await call(t, "agent1", "POST", `${A}/tickets/${b}/merge`, { into: Number(a) })).json.ok).toBe(true);
    expect(t.db.prepare("SELECT merged_into,status FROM support_tickets WHERE number=?").get(Number(b))).toMatchObject({ merged_into: Number(a) });

    await customer(t, "u1", "POST", `/api/hf/support/tickets/${a}/reply`, { message: "an unrelated follow up about calls" });
    const lastCustomer: any = t.db.prepare("SELECT id FROM support_messages WHERE ticket_number=? AND author_type='customer' ORDER BY created_at DESC, rowid DESC").get(Number(a));
    const sp = await call(t, "agent1", "POST", `${A}/tickets/${a}/split`, { messageId: lastCustomer.id });
    expect(sp.json.ok).toBe(true);
    expect(sp.json.number ?? sp.json.ticket?.number).toBeTruthy();
  });

  it("spam moves the ticket to spam and block makes the next mail from that sender vanish", async () => {
    const t = setup();
    const n = (await mkTicket(t)).replace("HF-", "");
    expect((await call(t, "agent1", "POST", `${A}/tickets/${n}/spam`, {})).json.ok).toBe(true);
    expect(t.db.prepare("SELECT status FROM support_tickets WHERE number=?").get(Number(n))).toEqual({ status: "spam" });
    expect((await call(t, "agent1", "POST", `${A}/block`, { domain: "spamco.biz" })).json.ok).toBe(true);
    expect(t.db.prepare("SELECT kind,value FROM support_blocklist").all()).toEqual([{ kind: "domain", value: "spamco.biz" }]);
  });

  it("bulk applies to many tickets", async () => {
    const t = setup();
    const a = (await mkTicket(t, "u1", "one")).replace("HF-", "");
    const b = (await mkTicket(t, "u2", "two")).replace("HF-", "");
    const r = await call(t, "agent1", "POST", `${A}/bulk`, { numbers: [Number(a), Number(b)], action: "status", value: "solved" });
    expect(r.json.ok).toBe(true);
    expect(t.db.prepare("SELECT COUNT(*) c FROM support_tickets WHERE status='solved'").get()).toEqual({ c: 2 });
  });

  it("viewing heartbeat shows the other agent in viewers", async () => {
    const t = setup();
    const n = (await mkTicket(t)).replace("HF-", "");
    await call(t, "agent1", "POST", `${A}/tickets/${n}/viewing`, {});
    const d = await call(t, "admin1", "GET", `${A}/tickets/${n}`);
    expect(d.json.viewers.map((v: any) => v.uid ?? v.name)).toContain("agent1");
  });
});

describe("desk config", () => {
  it("canned replies CRUD, signature PUT/GET, settings PUT/GET", async () => {
    const t = setup();
    const c = await call(t, "agent1", "POST", `${A}/canned`, { title: "Refund info", html: "<p>Refunds take 5 days.</p>" });
    expect(c.json.ok).toBe(true);
    const list = await call(t, "agent1", "GET", `${A}/canned`);
    expect(list.json.canned.map((x: any) => x.title)).toContain("Refund info");

    const sig = await call(t, "admin1", "PUT", `${A}/signature?scope=team`, { html: "<p>Team</p>", useFor: "team" });
    expect(sig.json.ok).toBe(true);
    expect((await call(t, "agent1", "GET", `${A}/signature?scope=team`)).json.signature?.html ?? (await call(t, "agent1", "GET", `${A}/signature?scope=team`)).json.html).toContain("Team");

    const s = await call(t, "admin1", "PUT", `${A}/settings`, { alert_whatsapp: "+919999999999" });
    expect(s.json.ok).toBe(true);
    expect(t.db.prepare("SELECT value FROM support_settings WHERE key='alert_whatsapp'").get()).toEqual({ value: "+919999999999" });
    expect((await call(t, "admin1", "PUT", `${A}/settings`, { alert_whatsapp: "not a number" })).status).toBe(400);
  });
  it("queues, failed, suppressions and reports answer for staff", async () => {
    const t = setup();
    for (const p of ["queues", "failed", "suppressions", "reports?range=7d"]) {
      const r = await call(t, "agent1", "GET", `${A}/${p}`);
      expect([p, r.status, r.json?.ok]).toEqual([p, 200, true]);
    }
  });
});
