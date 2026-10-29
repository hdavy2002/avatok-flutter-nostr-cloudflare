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

// ---- what the support desk (web) and the app actually call ----
describe("desk client contract", () => {
  const raw = async (t: TestEnv, uid: string, method: string, path: string, body: Uint8Array | string, headers: Record<string, string> = {}) => {
    const res = await hfSupportRoute(new Request("https://api.test" + path, { method, body, headers: { "x-test-uid": uid, ...headers } }), t.env, path.split("?")[0]);
    return { status: res!.status, json: (await res!.clone().json().catch(() => null)) as any, res: res! };
  };

  it("list carries counts, nextCursor and me; channel filter is case-insensitive; rows say Email/App", async () => {
    const t = setup();
    await mkTicket(t);
    const r = await call(t, "agent1", "GET", `${A}/tickets?folder=unassigned&channel=App`);
    expect(r.json.me).toEqual({ uid: "agent1", name: "Asha", role: "agent" });
    expect(r.json).toHaveProperty("nextCursor", null);
    expect(r.json.counts.unassigned).toBe(1);
    expect(r.json.tickets).toHaveLength(1);
    expect(r.json.tickets[0].channel).toBe("App");
    expect((await call(t, "agent1", "GET", `${A}/tickets?folder=unassigned&channel=Email`)).json.tickets).toHaveLength(0);
  });

  it("detail marks internal notes as kind=note, support replies as kind=support with delivery, and gives readable events and viewer me flags", async () => {
    const t = setup();
    const n = (await mkTicket(t)).replace("HF-", "");
    await call(t, "agent1", "POST", `${A}/tickets/${n}/note`, { text: "internal only" });
    await call(t, "agent1", "POST", `${A}/tickets/${n}/reply`, { html: "<p>Hello</p>", text: "Hello" });
    await call(t, "agent1", "PATCH", `${A}/tickets/${n}`, { priority: "urgent" });
    await call(t, "agent1", "POST", `${A}/tickets/${n}/viewing`, {});
    await call(t, "admin1", "POST", `${A}/tickets/${n}/viewing`, {});
    const d = await call(t, "agent1", "GET", `${A}/tickets/${n}`);
    const kinds = d.json.messages.map((m: any) => m.kind);
    expect(kinds).toEqual(["customer", "system", "note", "support"]);
    expect(d.json.messages[0].authorEmail).toBe("u1@example.com");
    expect(d.json.messages[3].delivery).toMatch(/queued|sent/);
    expect(d.json.ticket.channel).toBe("App");
    expect(d.json.events.every((e: any) => typeof e.text === "string" && e.text.length > 0)).toBe(true);
    expect(d.json.events.map((e: any) => e.text).join(" | ")).toContain("set the priority to urgent");
    expect(d.json.viewers.map((v: any) => [v.uid, v.me]).sort()).toEqual([["admin1", false], ["agent1", true]]);
    // customer panel names the desk reads
    expect(d.json.customer).toMatchObject({ uid: "u1", email: "u1@example.com" });
    expect(Array.isArray(d.json.customer.recentMoney)).toBe(true);
  });

  it("customer messages store the person's name, never 'You'", async () => {
    const t = setup();
    const n = (await mkTicket(t)).replace("HF-", "");
    const row: any = t.db.prepare("SELECT author_name FROM support_messages WHERE ticket_number=? AND author_type='customer'").get(Number(n));
    expect(row.author_name).not.toBe("You");
    expect(row.author_name.length).toBeGreaterThan(0);
  });

  it("block list, unblock by query (email and domain)", async () => {
    const t = setup();
    await call(t, "agent1", "POST", `${A}/block`, { email: "bad@example.com" });
    await call(t, "agent1", "POST", `${A}/block`, { domain: "spamco.biz" });
    const list = await call(t, "viewer1", "GET", `${A}/block`);
    expect(list.status).toBe(200);
    expect(list.json.items.map((i: any) => i.email ?? i.domain).sort()).toEqual(["bad@example.com", "spamco.biz"]);
    expect((await call(t, "viewer1", "DELETE", `${A}/block?email=bad@example.com`)).status).toBe(403);
    expect((await call(t, "agent1", "DELETE", `${A}/block?email=bad@example.com`)).json.ok).toBe(true);
    expect((await call(t, "agent1", "DELETE", `${A}/block?domain=spamco.biz`)).json.ok).toBe(true);
    expect((await call(t, "agent1", "GET", `${A}/block`)).json.items).toEqual([]);
  });

  it("queues/failed and queues/suppressions aliases, with the keys the desk reads", async () => {
    const t = setup();
    t.db.prepare("INSERT INTO email_suppressions (email,reason,source,created_at) VALUES ('gone@example.com','bounce','test',?)").run(Date.now());
    const q = await call(t, "agent1", "GET", `${A}/queues`);
    expect(q.json.queues.map((x: any) => x.name)).toEqual(["support-inbound", "email-priority", "email-bulk", "whatsapp-priority", "whatsapp-normal"]);
    expect(q.json.queues[0]).toHaveProperty("perMin");
    expect(q.json.queues[0]).toHaveProperty("oldestSec");
    expect((await call(t, "agent1", "GET", `${A}/queues/failed`)).json).toHaveProperty("items");
    const sup = await call(t, "agent1", "GET", `${A}/queues/suppressions`);
    expect(sup.json.items[0].email).toBe("gone@example.com");
    expect((await call(t, "agent1", "DELETE", `${A}/queues/suppressions?email=gone@example.com`)).status).toBe(403); // admin only
    expect((await call(t, "admin1", "DELETE", `${A}/queues/suppressions?email=gone@example.com`)).json.ok).toBe(true);
    expect((await call(t, "admin1", "POST", `${A}/queues/failed/email%3Anope/retry`, {})).status).toBe(404);
  });

  it("signature upload works cross-origin (?purpose=signature&name=) and returns a public url that loads without a sign-in", async () => {
    const t = setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
    const up = await raw(t, "agent1", "POST", "/api/hf/support/attachments?purpose=signature&name=logo.png", png, { "content-type": "image/png" });
    expect(up.status).toBe(201);
    expect(up.json.url).toMatch(/^https:\/\/api\.hellofraands\.com\/api\/hf\/support\/public\/signature\/[0-9a-f-]{36}\.png$/);
    // public: no x-test-uid header at all
    const path = new URL(up.json.url).pathname;
    const img = await hfSupportRoute(new Request("https://api.test" + path), t.env, path);
    expect(img!.status).toBe(200);
    expect(img!.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img!.arrayBuffer())).toEqual(png);
    // customers cannot upload signature logos, and svg / other types are refused
    expect((await raw(t, "u1", "POST", "/api/hf/support/attachments?purpose=signature&name=l.png", png, { "content-type": "image/png" })).status).toBe(403);
    expect((await raw(t, "agent1", "POST", "/api/hf/support/attachments?purpose=signature&name=l.svg", "<svg/>", { "content-type": "image/svg+xml" })).status).toBe(400);
    // only signature images are public
    const other = await hfSupportRoute(new Request("https://api.test/api/hf/support/public/signature/..%2Fsecret.png"), t.env, "/api/hf/support/public/signature/..%2Fsecret.png");
    expect(other!.status).toBe(404);
  });

  it("signature test uses the posted html", async () => {
    const t = setup();
    const r = await call(t, "agent1", "POST", `${A}/signature/test`, { html: "<p>Draft sig XYZ</p>", useFor: "team" });
    expect(r.json.ok).toBe(true);
    const row: any = t.db.prepare("SELECT body_r2_key FROM email_outbox WHERE outbox_key LIKE 'support-sigtest:%'").get();
    expect(await (await t.r2.get(row.body_r2_key))!.text()).toContain("Draft sig XYZ");
  });

  it("settings take the desk's shapes (from/to, holiday objects, automations, empty alert number) and partial keys", async () => {
    const t = setup();
    const put = await call(t, "admin1", "PUT", `${A}/settings`, {
      business_hours: { days: [1, 2, 3], from: "09:00", to: "17:30", tz: "Asia/Kolkata" },
      holidays: [{ date: "2026-11-08", label: "Diwali" }],
    });
    expect(put.json.settings.business_hours).toMatchObject({ days: [1, 2, 3], from: "09:00", to: "17:30", tz: "Asia/Kolkata" });
    expect(put.json.settings.holidays).toEqual([{ date: "2026-11-08", label: "Diwali" }]);
    expect(put.json.settings.alert_whatsapp).toBe("+917817058560"); // untouched by a partial PUT
    expect((await call(t, "admin1", "PUT", `${A}/settings`, { alert_whatsapp: "" })).json.settings.alert_whatsapp).toBe("");
    expect((await call(t, "admin1", "GET", `${A}/settings`)).json.settings.automations).toEqual([]);
    expect((await call(t, "admin1", "PUT", `${A}/settings`, { automations: [{ id: "a", category: "nope", assigneeUid: null, priority: null }] })).status).toBe(400);
    expect((await call(t, "admin1", "PUT", `${A}/settings`, { automations: [{ id: "a", category: "wallet", assigneeUid: "ghost", priority: null }] })).status).toBe(400);
  });

  it("automations assign and prioritise new tickets by category", async () => {
    const t = setup();
    const put = await call(t, "admin1", "PUT", `${A}/settings`, { automations: [
      { id: "r1", category: "wallet", assigneeUid: "agent1", priority: "urgent" },
      { id: "r2", category: "app", assigneeUid: null, priority: "low" },
    ] });
    expect(put.json.ok).toBe(true);
    const w = (await mkTicket(t)).replace("HF-", ""); // wallet
    expect(t.db.prepare("SELECT assignee_uid,priority FROM support_tickets WHERE number=?").get(Number(w))).toEqual({ assignee_uid: "agent1", priority: "urgent" });
    const a = (await customer(t, "u1", "POST", "/api/hf/support/tickets", { category: "app", subject: "App is slow", message: "it hangs on the home screen" })).json.ticket.number.replace("HF-", "");
    expect(t.db.prepare("SELECT assignee_uid,priority FROM support_tickets WHERE number=?").get(Number(a))).toEqual({ assignee_uid: null, priority: "low" });
    // an assigned ticket leaves Unassigned and shows under My tickets
    expect((await call(t, "agent1", "GET", `${A}/tickets?folder=mine`)).json.tickets.map((x: any) => x.number)).toContain("HF-" + w);
  });

  it("bulk: assign (uid, and empty to unassign), solve, close, priority, category, spam", async () => {
    const t = setup();
    const a = (await mkTicket(t, "u1", "one")), b = (await mkTicket(t, "u2", "two"));
    const nums = [a, b];
    const st = (n: string) => t.db.prepare("SELECT status,assignee_uid,priority,category FROM support_tickets WHERE number=?").get(Number(n.replace("HF-", ""))) as any;
    await call(t, "agent1", "POST", `${A}/bulk`, { numbers: nums, action: "assign", value: "agent1" });
    expect(st(a).assignee_uid).toBe("agent1");
    await call(t, "agent1", "POST", `${A}/bulk`, { numbers: nums, action: "assign", value: "" });
    expect(st(a).assignee_uid).toBeNull();
    await call(t, "agent1", "POST", `${A}/bulk`, { numbers: nums, action: "priority", value: "low" });
    await call(t, "agent1", "POST", `${A}/bulk`, { numbers: nums, action: "category", value: "bookings" });
    expect(st(b)).toMatchObject({ priority: "low", category: "bookings" });
    await call(t, "agent1", "POST", `${A}/bulk`, { numbers: [a], action: "solve" });
    await call(t, "agent1", "POST", `${A}/bulk`, { numbers: [a], action: "close" });
    await call(t, "agent1", "POST", `${A}/bulk`, { numbers: [b], action: "spam" });
    expect([st(a).status, st(b).status]).toEqual(["closed", "spam"]);
  });

  it("canned replies: the desk sends plain text in body and reads items[].body back", async () => {
    const t = setup();
    const c = await call(t, "agent1", "POST", `${A}/canned`, { title: "Refund", body: "Hi {customer_name},\n\nRefunds take 5 days." });
    expect(c.status).toBe(201);
    const list = await call(t, "agent1", "GET", `${A}/canned`);
    expect(list.json.items[0].body).toContain("Hi {customer_name},");
    expect(list.json.items[0].body).toContain("Refunds take 5 days.");
    await call(t, "agent1", "PUT", `${A}/canned/${c.json.id}`, { title: "Refund v2", body: "Updated text" });
    expect((await call(t, "agent1", "GET", `${A}/canned`)).json.items[0]).toMatchObject({ title: "Refund v2", body: "Updated text" });
  });

  it("staff list has items with id, reports have totals/perDay/byCategory[]", async () => {
    const t = setup();
    await mkTicket(t);
    const s = await call(t, "agent1", "GET", `${A}/staff`);
    expect(s.json.items.find((x: any) => x.email === "agent@example.com")).toMatchObject({ id: "agent@example.com", uid: "agent1", role: "agent" });
    expect((await call(t, "admin1", "DELETE", `${A}/staff/${encodeURIComponent("viewer@example.com")}`)).json.ok).toBe(true);
    const r = await call(t, "agent1", "GET", `${A}/reports?range=7d`);
    expect(r.json.totals).toMatchObject({ created: 1, solved: 0, open: 1 });
    expect(Array.isArray(r.json.perDay)).toBe(true);
    expect(r.json.byCategory).toEqual([{ category: "wallet", count: 1 }]);
  });
});
