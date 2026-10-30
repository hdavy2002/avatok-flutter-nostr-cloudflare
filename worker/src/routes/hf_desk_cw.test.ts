// @ts-nocheck -- reads the migration with node:fs, which the worker tsconfig has no types for (as support_testkit.ts)
// [HF-DESK-CW-1] The Chatwoot-compatible desk API, end to end on in-memory SQLite + fake R2 / queues.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { makeEnv, rawMail, putInbound, type TestEnv } from "../lib/support_testkit";
import { processInbound } from "../lib/support_inbound";
import { sha256Hex, clearStaffMemo } from "../lib/support_core";
import { hfDeskCwRoute, markdownToHtml, cwStatus, stripSignature, splitQuote } from "./hf_desk_cw";

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
  t.db.exec(readFileSync(new URL("../../migrations/2026-10-30-hf-desk-cw-labels.sql", import.meta.url), "utf8"));
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
    expect((await call("GET", `${A}/agents`)).body.map((a: any) => a.name)).toEqual(["Davy", "Priya", "Viewer"]);
    const assignable = (await call("GET", `${A}/inboxes/1/assignable_agents`)).body.payload;
    expect(assignable.map((a: any) => a.name)).toEqual(["Davy", "Priya"]); // viewers are not assignable
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

// ---------------------------------------------------------------------------------------------------------------------
// [HF-DESK-CW-3]
// ---------------------------------------------------------------------------------------------------------------------
async function callForm(path: string, fields: Record<string, string | string[]>, files: { name: string; type: string; body: string }[] = [], token = "tok-admin") {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  for (const f of files) fd.append("attachments[]", new File([f.body], f.name, { type: f.type }));
  const req = new Request(`https://api.example.com${path}`, { method: "POST", headers: { "access-token": token }, body: fd });
  const res = await hfDeskCwRoute(req, t.env, new URL(req.url).pathname);
  return { status: res!.status, body: await res!.json() as any };
}
const raw = (path: string) => hfDeskCwRoute(new Request(`https://api.example.com${path}`), t.env, new URL(`https://api.example.com${path}`).pathname);

describe("attachments", () => {
  beforeEach(async () => { await mail("Rahul <rahul@example.com>", "Help", "first"); });
  it("a reply with files stores them, attaches them to the email and shows them with a signed link that only works for a live session", async () => {
    const r = await callForm(`${A}/conversations/10001/messages`, { content: "See the receipt", private: "false" }, [{ name: "receipt.png", type: "image/png", body: "PNGDATA" }]);
    expect(r.status).toBe(200);
    expect(r.body.attachments).toHaveLength(1);
    const a = r.body.attachments[0];
    expect(a).toMatchObject({ file_type: "image", extension: "png", file_name: "receipt.png" });
    const outRow: any = t.db.prepare("SELECT attachments_json FROM email_outbox WHERE outbox_key LIKE 'support-reply:%'").get();
    expect(outRow.attachments_json).toContain("receipt.png");
    const u = new URL(a.data_url);
    const ok = await raw(u.pathname + u.search);
    expect(ok!.status).toBe(200);
    expect(await ok!.text()).toBe("PNGDATA");
    expect((await raw(u.pathname + u.search.replace(/s=[0-9a-f]+/, "s=" + "0".repeat(32))))!.status).toBe(403);
    await call("DELETE", "/cw/auth/sign_out");
    expect((await raw(u.pathname + u.search))!.status).toBe(403);
  });
  it("refuses executables and keeps the message unsent", async () => {
    const r = await callForm(`${A}/conversations/10001/messages`, { content: "x" }, [{ name: "evil.exe", type: "application/octet-stream", body: "MZ" }]);
    expect(r.status).toBe(422);
    expect((t.db.prepare("SELECT COUNT(*) AS c FROM support_messages WHERE author_type='staff'").get() as any).c).toBe(0);
  });
  it("a private note can carry a file", async () => {
    const r = await callForm(`${A}/conversations/10001/messages`, { content: "internal copy", private: "true" }, [{ name: "notes.pdf", type: "application/pdf", body: "%PDF" }]);
    expect(r.body.private).toBe(true);
    expect(r.body.attachments[0].file_type).toBe("file");
  });
  it("customer files show on the thread", async () => {
    const msg: any = t.db.prepare("SELECT id FROM support_messages WHERE author_type='customer'").get();
    t.db.prepare("INSERT INTO support_attachments (id,r2_key,name,size,content_type,ticket_number,message_id,uid,purpose,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("11111111-1111-1111-1111-111111111111", "support/att/10001/x/shot.jpg", "shot.jpg", 10, "image/jpeg", 10001, msg.id, null, "ticket", 1);
    const r = await call("GET", `${A}/conversations/10001/messages`);
    const inc = r.body.payload.find((m: any) => m.message_type === 0);
    expect(inc.attachments[0]).toMatchObject({ file_name: "shot.jpg", file_type: "image" });
  });
});

describe("to / cc / bcc", () => {
  beforeEach(async () => { await mail("Rahul <rahul@example.com>", "Help", "first"); });
  it("Cc and Bcc ride to the consumer as X-HF-Cc / X-HF-Bcc; a new To replaces the recipient", async () => {
    const r = await call("POST", `${A}/conversations/10001/messages`, { content: "hi", to_emails: "boss@example.com", cc_emails: "a@example.com, b@example.com", bcc_emails: "audit@example.com" });
    expect(r.status).toBe(200);
    const row: any = t.db.prepare("SELECT to_email, headers_json FROM email_outbox WHERE outbox_key LIKE 'support-reply:%'").get();
    expect(row.to_email).toBe("boss@example.com");
    const h = JSON.parse(row.headers_json);
    expect(h["X-HF-Cc"]).toBe("a@example.com,b@example.com");
    expect(h["X-HF-Bcc"]).toBe("audit@example.com");
  });
  it("refuses a bad address", async () => {
    expect((await call("POST", `${A}/conversations/10001/messages`, { content: "hi", cc_emails: "not an email" })).status).toBe(422);
  });
});

describe("settings", () => {
  it("agents: admins add, rename, change role and remove; agents cannot", async () => {
    const add = await call("POST", `${A}/agents`, { name: "Sunita", email: "Sunita@Example.com", role: "agent" });
    expect(add.body).toMatchObject({ name: "Sunita", email: "sunita@example.com", role: "agent", confirmed: false });
    const id = add.body.id;
    expect((await call("PATCH", `${A}/agents/${id}`, { role: "administrator" })).body.role).toBe("administrator");
    expect((await call("DELETE", `${A}/agents/1`)).status).toBe(422); // yourself
    expect((await call("DELETE", `${A}/agents/${id}`)).status).toBe(200);
    t.db.prepare("INSERT INTO support_desk_sessions VALUES (?,?,?,?)").run(await sha256Hex("tok-agent"), "u-agent", 1, Date.now() + 3600_000);
    expect((await call("POST", `${A}/agents`, { name: "x", email: "x@example.com" }, "tok-agent")).status).toBe(403);
  });
  it("labels: create, add to a ticket next to its category, filter by it, rename, delete; built-ins are locked", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "first");
    const lab = await call("POST", `${A}/labels`, { title: "VIP Customer", color: "#ff0000" });
    expect(lab.body).toMatchObject({ title: "vip-customer", color: "#ff0000" });
    expect((await call("POST", `${A}/labels`, { title: "wallet" })).status).toBe(422);
    expect((await call("PATCH", `${A}/labels/1`, { title: "x" })).status).toBe(422);
    const set = await call("POST", `${A}/conversations/10001/labels`, { labels: ["wallet", "vip-customer"] });
    expect(set.body.payload).toEqual(["wallet", "vip-customer"]);
    const list = await call("GET", `${A}/conversations?assignee_type=all&labels[]=vip-customer`);
    expect(list.body.data.payload.map((c: any) => c.id)).toEqual([10001]);
    expect(list.body.data.payload[0].labels).toEqual(["wallet", "vip-customer"]);
    await call("PATCH", `${A}/labels/${lab.body.id}`, { title: "vip" });
    expect((await call("GET", `${A}/conversations/10001/labels`)).body.payload).toEqual(["wallet", "vip"]);
    await call("DELETE", `${A}/labels/${lab.body.id}`);
    expect((await call("GET", `${A}/conversations/10001/labels`)).body.payload).toEqual(["wallet"]);
  });
  it("canned responses: create, edit, delete", async () => {
    const c = await call("POST", `${A}/canned_responses`, { canned_response: { short_code: "refund", content: "Your **refund** is on its way." } });
    expect(c.body).toMatchObject({ short_code: "refund", content: "Your refund is on its way." });
    expect((await call("PATCH", `${A}/canned_responses/${c.body.id}`, { short_code: "refund2", content: "Done." })).body).toMatchObject({ short_code: "refund2", content: "Done." });
    await call("DELETE", `${A}/canned_responses/${c.body.id}`);
    expect((await call("GET", `${A}/canned_responses`)).body.find((x: any) => x.id === c.body.id)).toBeUndefined();
  });
  it("personal signature: saved as the agent's signature, and the copy Chatwoot appends is stripped before sending", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "first");
    const p = await call("PUT", "/cw/api/v1/profile", { profile: { message_signature: "Davy\nHello Fraands support" } });
    expect(p.body.message_signature).toBe("Davy\nHello Fraands support");
    const sig: any = t.db.prepare("SELECT html,use_for FROM support_signatures WHERE scope_key='me:u-admin'").get();
    expect(sig.use_for).toBe("personal");
    await call("POST", `${A}/conversations/10001/messages`, { content: "Fixed it.\n\n--\n\nDavy\nHello Fraands support" });
    expect((t.db.prepare("SELECT text FROM support_messages WHERE author_type='staff'").get() as any).text).toBe("Fixed it.");
    expect(stripSignature("hi", "")).toBe("hi");
  });
});

describe("contacts and search", () => {
  beforeEach(async () => {
    await mail("Rahul Sharma <rahul@example.com>", "Wallet top-up failed", "UPI ref 99812 was debited");
    await mail("Anita <anita@example.com>", "Call dropped", "dropped after two minutes");
  });
  it("lists, searches and blocks contacts", async () => {
    const all = await call("GET", `${A}/contacts?page=1&sort=name`);
    expect(all.body.meta.count).toBe(2);
    expect(all.body.payload.map((c: any) => c.name)).toEqual(["Anita", "Rahul Sharma"]);
    const s = await call("GET", `${A}/contacts/search?q=rahul`);
    expect(s.body.payload.map((c: any) => c.email)).toEqual(["rahul@example.com"]);
    const id = s.body.payload[0].id;
    expect((await call("PATCH", `${A}/contacts/${id}`, { blocked: true })).body.payload.blocked).toBe(true);
    expect((t.db.prepare("SELECT value FROM support_blocklist").get() as any).value).toBe("rahul@example.com");
    expect((await call("PATCH", `${A}/contacts/${id}`, { blocked: false })).body.payload.blocked).toBe(false);
    expect((await call("DELETE", `${A}/contacts/${id}`)).status).toBe(422);
  });
  it("search finds message text, customer email and HF numbers", async () => {
    const byText = await call("GET", `${A}/search?q=99812`);
    expect(byText.body.payload.conversations.map((c: any) => c.id)).toEqual([10001]);
    expect(byText.body.payload.messages).toHaveLength(1);
    expect((await call("GET", `${A}/search/conversations?q=anita@example`)).body.payload.conversations.map((c: any) => c.id)).toEqual([10002]);
    expect((await call("GET", `${A}/search/conversations?q=HF-10002`)).body.payload.conversations.map((c: any) => c.id)).toEqual([10002]);
    expect((await call("GET", `${A}/conversations?assignee_type=all&status=all&q=two minutes`)).body.data.payload.map((c: any) => c.id)).toEqual([10002]);
  });
});

describe("spam, block, merge, split", () => {
  it("spam hides the ticket and can block the sender", async () => {
    await mail("Spammer <spam@example.com>", "Win money", "click here");
    const r = await call("POST", `${A}/conversations/10001/hf_spam`, { block: true });
    expect(r.body).toMatchObject({ success: true, blocked: true });
    expect((t.db.prepare("SELECT status FROM support_tickets").get() as any).status).toBe("spam");
    expect((await call("GET", `${A}/conversations?assignee_type=all&status=all`)).body.data.meta.all_count).toBe(0);
  });
  it("block sender keeps the ticket", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "first");
    expect((await call("POST", `${A}/conversations/10001/hf_block`)).body.success).toBe(true);
    expect((t.db.prepare("SELECT status FROM support_tickets").get() as any).status).toBe("new");
  });
  it("merges two tickets from the same customer, refuses other customers", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "first");
    await mail("Rahul <rahul@example.com>", "Another thing", "second");
    await mail("Anita <anita@example.com>", "Mine", "third");
    expect((await call("POST", `${A}/conversations/10001/hf_merge`, { into: "HF-10003" })).status).toBe(422);
    const r = await call("POST", `${A}/conversations/10001/hf_merge`, { into: "HF-10002" });
    expect(r.body).toMatchObject({ success: true, into: 10002 });
    expect((t.db.prepare("SELECT merged_into FROM support_tickets WHERE number=10001").get() as any).merged_into).toBe(10002);
  });
  it("splits a later customer message into a new ticket", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "first");
    await mail("Rahul <rahul@example.com>", "Re: [HF-10001] Help", "a different problem", { "In-Reply-To": "<x@y>" });
    const msgs = (await call("GET", `${A}/conversations/10001/messages`)).body.payload.filter((m: any) => m.message_type === 0);
    expect(msgs).toHaveLength(2);
    expect((await call("POST", `${A}/conversations/10001/messages/${msgs[0].id}/hf_split`)).status).toBe(422); // the first message
    const r = await call("POST", `${A}/conversations/10001/messages/${msgs[1].id}/hf_split`);
    expect(r.body).toMatchObject({ success: true, conversation_id: 10002 });
  });
});

describe("quoted email", () => {
  it("the email keeps Chatwoot's quote, the ticket stores only the new text", async () => {
    await mail("Rahul <rahul@example.com>", "Help", "first");
    await call("POST", `${A}/conversations/10001/messages`, { content: "Done, refunded.\r\n\r\n> On Fri, Oct 30, 2026 at 8:14 AM Rahul <rahul@example.com> wrote:\r\n>\r\n> first" });
    expect((t.db.prepare("SELECT text FROM support_messages WHERE author_type='staff'").get() as any).text).toBe("Done, refunded.");
    const key = (t.db.prepare("SELECT body_r2_key FROM email_outbox WHERE outbox_key LIKE 'support-reply:%'").get() as any).body_r2_key;
    expect(await (await t.r2.get(key) ?? await t.blobs.get(key))?.text()).toContain("<blockquote");
    expect(splitQuote("plain > not a quote").main).toBe("plain > not a quote");
  });
});
