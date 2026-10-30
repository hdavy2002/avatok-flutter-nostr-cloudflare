// @ts-nocheck -- reads the migration with node:fs, which the worker tsconfig has no types for (as support_testkit.ts)
// [HF-DESK-CW-1] The Chatwoot-compatible desk API, end to end on in-memory SQLite + fake R2 / queues.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { makeEnv, rawMail, putInbound, type TestEnv } from "../lib/support_testkit";
import { processInbound } from "../lib/support_inbound";
import { sha256Hex, clearStaffMemo } from "../lib/support_core";
import { hfDeskCwRoute, markdownToHtml, cwStatus } from "./hf_desk_cw";

const A = "/cw/api/v1/accounts/1";
let t: TestEnv;

async function call(method: string, path: string, body?: unknown, token = "tok-admin") {
  const req = new Request(`https://api.example.com${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { "access-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await hfDeskCwRoute(req, t.env, new URL(req.url).pathname);
  return { status: res!.status, body: await res!.json() as any };
}

async function mail(from: string, subject: string, body: string, extra: Record<string, string> = {}) {
  const id = `m${Math.random().toString(36).slice(2)}`;
  const job = await putInbound(t, id, rawMail({ From: from, To: "support@hellofraands.com", Subject: subject, "Message-ID": `<${id}@mail.example.com>`, ...extra }, body), from, "support@hellofraands.com");
  return processInbound(t.env, job, Date.now()) as Promise<any>;
}

beforeEach(async () => {
  clearStaffMemo();
  t = makeEnv();
  t.db.exec(readFileSync(new URL("../../migrations/2026-10-30-hf-desk-cw-sessions.sql", import.meta.url), "utf8"));
  t.db.exec("DELETE FROM support_staff");
  t.db.prepare("INSERT INTO support_staff (email,uid,name,role,created_at) VALUES (?,?,?,?,?)").run("owner@example.com", "u-admin", "Davy", "admin", 1);
  t.db.prepare("INSERT INTO support_staff (email,uid,name,role,created_at) VALUES (?,?,?,?,?)").run("priya@example.com", "u-agent", "Priya", "agent", 2);
  t.db.prepare("INSERT INTO support_staff (email,uid,name,role,created_at) VALUES (?,?,?,?,?)").run("view@example.com", "u-view", "Viewer", "viewer", 3);
  const exp = Date.now() + 3600_000;
  t.db.prepare("INSERT INTO support_desk_sessions VALUES (?,?,?,?)").run(await sha256Hex("tok-admin"), "u-admin", 1, exp);
  t.db.prepare("INSERT INTO support_desk_sessions VALUES (?,?,?,?)").run(await sha256Hex("tok-view"), "u-view", 1, exp);
  t.db.prepare("INSERT INTO support_desk_sessions VALUES (?,?,?,?)").run(await sha256Hex("tok-old"), "u-admin", 1, Date.now() - 1);
});

describe("auth", () => {
  it("refuses a missing, unknown or expired token", async () => {
    expect((await call("GET", "/cw/auth/validate_token", undefined, "")).status).toBe(401);
    expect((await call("GET", "/cw/auth/validate_token", undefined, "nope")).status).toBe(401);
    expect((await call("GET", "/cw/auth/validate_token", undefined, "tok-old")).status).toBe(401);
  });
  it("validate_token returns the agent in Chatwoot's shape", async () => {
    const r = await call("GET", "/cw/auth/validate_token");
    expect(r.status).toBe(200);
    expect(r.body.payload.data).toMatchObject({ id: 1, name: "Davy", role: "administrator", accounts: [{ id: 1, role: "administrator" }] });
  });
  it("exchange needs a real sign-in", async () => {
    expect((await call("POST", "/cw/auth/hf_exchange", {}, "")).status).toBe(401);
  });
  it("sign_out removes the session", async () => {
    await call("DELETE", "/cw/auth/sign_out");
    expect((await call("GET", "/cw/auth/validate_token")).status).toBe(401);
  });
  it("a viewer can read but not write", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "hi");
    expect((await call("GET", `${A}/conversations?assignee_type=all`, undefined, "tok-view")).status).toBe(200);
    expect((await call("POST", `${A}/conversations/10001/messages`, { content: "x" }, "tok-view")).status).toBe(403);
  });
});

describe("conversations", () => {
  it("lists tickets with Chatwoot counts, tabs and status filter", async () => {
    await mail("Rahul <rahul@example.com>", "Wallet top-up failed", "money cut");
    await mail("Anita <anita@example.com>", "Call dropped", "dropped");
    t.db.prepare("UPDATE support_tickets SET assignee_uid='u-admin' WHERE number=10002").run();
    const all = await call("GET", `${A}/conversations?assignee_type=all&status=open`);
    expect(all.body.data.meta).toMatchObject({ mine_count: 1, unassigned_count: 1, all_count: 2 });
    expect(all.body.data.payload.map((c: any) => c.id).sort()).toEqual([10001, 10002]);
    const c = all.body.data.payload.find((x: any) => x.id === 10001);
    expect(c).toMatchObject({ status: "open", inbox_id: 1, additional_attributes: { mail_subject: "Wallet top-up failed" } });
    expect(c.meta.sender.email).toBe("rahul@example.com");
    const mine = await call("GET", `${A}/conversations?assignee_type=me&status=open`);
    expect(mine.body.data.payload.map((x: any) => x.id)).toEqual([10002]);
    expect((await call("GET", `${A}/conversations?assignee_type=all&status=resolved`)).body.data.payload).toEqual([]);
  });
  it("hides spam", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "hi");
    t.db.prepare("UPDATE support_tickets SET status='spam'").run();
    expect((await call("GET", `${A}/conversations?assignee_type=all&status=all`)).body.data.meta.all_count).toBe(0);
  });
  it("maps every status", () => {
    expect(["new", "open", "waiting", "on_hold", "solved", "closed"].map(cwStatus)).toEqual(["open", "open", "pending", "snoozed", "resolved", "resolved"]);
  });
});

describe("messages", () => {
  it("shows the email thread and pages backwards around the seed message", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "first");
    const r = await call("GET", `${A}/conversations/10001/messages`);
    const incoming = r.body.payload.filter((m: any) => m.message_type === 0);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ content: "first", content_type: "incoming_email", private: false });
    expect(incoming[0].content_attributes.email.from).toEqual(["rahul@example.com"]);
    const last = r.body.payload[r.body.payload.length - 1].id;
    const before = await call("GET", `${A}/conversations/10001/messages?before=${last}`);
    expect(before.body.payload.length).toBe(r.body.payload.length - 1);
  });
  it("a reply goes through the normal staff reply path: stored, emailed, ticket to pending, auto-assigned", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "first");
    const r = await call("POST", `${A}/conversations/10001/messages`, { content: "Hi **Rahul**, fixed.", private: false, echo_id: "e1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ message_type: 1, private: false, echo_id: "e1", content: "Hi Rahul, fixed." });
    const tk: any = t.db.prepare("SELECT status,assignee_uid FROM support_tickets WHERE number=10001").get();
    expect(tk).toEqual({ status: "waiting", assignee_uid: "u-admin" });
    const out: any = t.db.prepare("SELECT subject,to_email FROM email_outbox WHERE outbox_key LIKE 'support-reply:%'").get();
    expect(out).toEqual({ subject: "[HF-10001] Help", to_email: "rahul@example.com" });
  });
  it("a private note is never emailed", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "first");
    const before = (t.db.prepare("SELECT COUNT(*) AS c FROM email_outbox").get() as any).c;
    const r = await call("POST", `${A}/conversations/10001/messages`, { content: "internal", private: true });
    expect(r.body.private).toBe(true);
    expect((t.db.prepare("SELECT COUNT(*) AS c FROM email_outbox").get() as any).c).toBe(before);
    expect((t.db.prepare("SELECT author_type FROM support_messages WHERE text='internal'").get() as any).author_type).toBe("note");
  });
  it("refuses empty messages and attachments (not supported yet)", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "first");
    expect((await call("POST", `${A}/conversations/10001/messages`, { content: "  " })).status).toBe(422);
  });
});

describe("actions", () => {
  beforeEach(async () => { await mail("Rahul <rahul@example.com>", "Help", "first"); });
  it("resolve, reopen, pending and snooze", async () => {
    const st = () => (t.db.prepare("SELECT status,snooze_until FROM support_tickets WHERE number=10001").get() as any);
    expect((await call("POST", `${A}/conversations/10001/toggle_status`, { status: "resolved" })).body.payload.current_status).toBe("resolved");
    expect(st().status).toBe("solved");
    await call("POST", `${A}/conversations/10001/toggle_status`, { status: "open" });
    expect(st().status).toBe("open");
    await call("POST", `${A}/conversations/10001/toggle_status`, { status: "pending" });
    expect(st().status).toBe("waiting");
    const until = Math.floor(Date.now() / 1000) + 3600;
    const r = await call("POST", `${A}/conversations/10001/toggle_status`, { status: "snoozed", snoozed_until: until });
    expect(r.body.payload).toMatchObject({ current_status: "snoozed", snoozed_until: until });
    expect(st()).toEqual({ status: "on_hold", snooze_until: until * 1000 });
  });
  it("assigns by Chatwoot agent id and unassigns", async () => {
    const agents = (await call("GET", `${A}/agents`)).body;
    expect(agents.map((a: any) => a.name)).toEqual(["Davy", "Priya"]); // viewers are not assignable
    await call("POST", `${A}/conversations/10001/assignments`, { assignee_id: 2 });
    expect((t.db.prepare("SELECT assignee_uid FROM support_tickets").get() as any).assignee_uid).toBe("u-agent");
    await call("POST", `${A}/conversations/10001/assignments`, { assignee_id: 0 });
    expect((t.db.prepare("SELECT assignee_uid FROM support_tickets").get() as any).assignee_uid).toBeNull();
  });
  it("priority and labels map to our priority and category", async () => {
    await call("POST", `${A}/conversations/10001/toggle_priority`, { priority: "urgent" });
    await call("POST", `${A}/conversations/10001/labels`, { labels: ["wallet"] });
    expect(t.db.prepare("SELECT priority,category,money FROM support_tickets").get()).toEqual({ priority: "urgent", category: "wallet", money: 1 });
    await call("POST", `${A}/conversations/10001/toggle_priority`, { priority: null });
    expect((t.db.prepare("SELECT priority FROM support_tickets").get() as any).priority).toBe("normal");
  });
});

describe("live updates", () => {
  it("first poll returns a cursor; later polls carry new tickets and messages", async () => {
    const first = await call("GET", `${A}/hf_updates`);
    expect(first.body.events).toEqual([]);
    await mail("Rahul <rahul@example.com>", "Help", "first");
    const next = await call("GET", `${A}/hf_updates?since=${first.body.cursor}`);
    const kinds = next.body.events.map((e: any) => e.event);
    expect(kinds).toContain("conversation.created");
    expect(kinds).toContain("message.created");
    const msg = next.body.events.find((e: any) => e.event === "message.created").data;
    expect(msg).toMatchObject({ conversation_id: 10001, account_id: 1 });
    expect(msg.conversation.last_activity_at).toBeGreaterThan(0);
  });
});

describe("markdown", () => {
  it("escapes HTML and renders quotes, bold and links", () => {
    expect(markdownToHtml("Hi **A** <b>x</b> [l](https://e.x)\n\n> quoted")).toBe(
      '<p>Hi <b>A</b> &lt;b&gt;x&lt;/b&gt; <a href="https://e.x">l</a></p><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;color:#555"><p>quoted</p></blockquote>',
    );
  });
});

describe("ui settings", () => {
  it("keeps the agent's layout choices (contact panel open by default)", async () => {
    expect((await call("GET", "/cw/auth/validate_token")).body.payload.data.ui_settings.is_contact_sidebar_open).toBe(true);
    const r = await call("PUT", "/cw/api/v1/profile", { profile: { ui_settings: { is_contact_sidebar_open: false, conversation_display_type: "condensed" } } });
    expect(r.body.ui_settings).toMatchObject({ is_contact_sidebar_open: false, conversation_display_type: "condensed" });
    expect((await call("GET", "/cw/auth/validate_token")).body.payload.data.ui_settings.is_contact_sidebar_open).toBe(false);
  });
});

describe("agent identity", () => {
  it("claims the owner's seed row (no uid yet) for an admin who never passed the email lookup, so the user id is never 0", async () => {
    t.db.prepare("UPDATE support_staff SET uid=NULL WHERE email='owner@example.com'").run();
    t.env.ADMIN_UIDS = "u-admin";
    t.db.prepare("INSERT INTO hf_user_email (uid,email,updated_at) VALUES ('u-admin','owner@example.com',1)").run();
    clearStaffMemo();
    const r = await call("GET", "/cw/auth/validate_token");
    expect(r.status).toBe(200);
    expect(r.body.payload.data.id).not.toBe(0);
  });
});
