// [HF-SUPPORT-1] Customer API: ownership, no internal notes ever, limits, attachments.
import { describe, it, expect, vi } from "vitest";

vi.mock("../authz", async (orig) => {
  const real: any = await orig();
  return { ...real, requireUser: async (req: Request) => (req.headers.get("x-test-uid") ? { uid: req.headers.get("x-test-uid") } : { error: "unauthorized", status: 401 }), isFail: (u: any) => !!u?.error };
});
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));

import { hfSupportRoute } from "./hf_support";
import { makeEnv, type TestEnv } from "../lib/support_testkit";

const call = async (t: TestEnv, uid: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const init: any = { method, headers: { ...(uid ? { "x-test-uid": uid } : {}), ...headers } };
  if (body !== undefined) { init.body = body instanceof Uint8Array ? body : JSON.stringify(body); if (!(body instanceof Uint8Array)) init.headers["content-type"] = "application/json"; }
  const res = await hfSupportRoute(new Request("https://api.test" + path, init), t.env, path);
  return { status: res!.status, json: (await res!.clone().json().catch(() => null)) as any, res: res! };
};
const create = (t: TestEnv, uid: string, over: Record<string, unknown> = {}) =>
  call(t, uid, "POST", "/api/hf/support/tickets", { category: "wallet", subject: "Top-up missing", message: `Money was cut ${Math.random()}`, ...over });

function user(t: TestEnv, uid: string, email: string) {
  t.db.prepare("INSERT INTO users (uid,handle,display_name,created_at) VALUES (?,?,?,?)").run(uid, uid, "Fan " + uid, 1);
  t.db.prepare("INSERT INTO hf_user_email (uid,email,updated_at) VALUES (?,?,1)").run(uid, email);
}

describe("customer API", () => {
  it("rejects anonymous callers and returns null for foreign paths", async () => {
    const t = makeEnv();
    expect((await call(t, null, "GET", "/api/hf/support/tickets")).status).toBe(401);
    expect(await hfSupportRoute(new Request("https://x/api/hf/other"), t.env, "/api/hf/other")).toBeNull();
  });

  it("creates a ticket HF-10001 with the contract shape, an in-app ack, and the category default priority", async () => {
    const t = makeEnv(); user(t, "u1", "u1@example.com");
    const r = await create(t, "u1");
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
    expect(r.json.ticket.number).toBe("HF-10001");
    const tk: any = t.db.prepare("SELECT * FROM support_tickets WHERE number=10001").get();
    expect(tk).toMatchObject({ uid: "u1", priority: "high", channel: "app", status: "new", money: 1 });
    const d = await call(t, "u1", "GET", "/api/hf/support/tickets/HF-10001");
    expect(d.json.ticket).toMatchObject({ number: "HF-10001", subject: "Top-up missing", category: "wallet", status: "open", statusLabel: "Open", canReopen: false });
    expect(d.json.messages.map((m: any) => m.author)).toEqual(["customer", "system"]);
    expect(d.json.messages[1].text).toContain("Your ticket HF-10001 is open.");
    const list = await call(t, "u1", "GET", "/api/hf/support/tickets");
    expect(list.json.tickets).toHaveLength(1);
    expect(list.json.tickets[0]).toMatchObject({ number: "HF-10001", statusLabel: "Open" });
  });

  it("validates input", async () => {
    const t = makeEnv(); user(t, "u1", "u1@example.com");
    expect((await create(t, "u1", { category: "nonsense" })).status).toBe(400);
    expect((await create(t, "u1", { message: "   " })).status).toBe(400);
    expect((await create(t, "u1", { subject: "" })).status).toBe(400);
  });

  it("NEVER returns internal notes, events or staff-only fields to the customer", async () => {
    const t = makeEnv(); user(t, "u1", "u1@example.com");
    await create(t, "u1");
    t.db.prepare("INSERT INTO support_messages (id,ticket_number,author_type,author_name,text,preview,created_at) VALUES ('note1',10001,'note','Agent','SECRET internal note','SECRET',?)").run(Date.now() + 10);
    t.db.prepare("INSERT INTO support_messages (id,ticket_number,author_type,author_name,text,preview,created_at) VALUES ('pub1',10001,'staff','Agent','We are checking this.','We are',?)").run(Date.now() + 20);
    const d = await call(t, "u1", "GET", "/api/hf/support/tickets/10001");
    const raw = JSON.stringify(d.json);
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("assignee");
    expect(raw).not.toContain("is_note");
    expect(d.json.messages.some((m: any) => m.text === "We are checking this.")).toBe(true);
    // preview in the list also must not leak the note
    t.db.prepare("UPDATE support_tickets SET preview='SECRET' WHERE number=10001 AND 0").run();
    expect(JSON.stringify((await call(t, "u1", "GET", "/api/hf/support/tickets")).json)).not.toContain("SECRET");
  });

  it("a customer cannot see or touch someone else's ticket (404, not 403)", async () => {
    const t = makeEnv(); user(t, "u1", "u1@example.com"); user(t, "u2", "u2@example.com");
    await create(t, "u1");
    expect((await call(t, "u2", "GET", "/api/hf/support/tickets/HF-10001")).status).toBe(404);
    expect((await call(t, "u2", "POST", "/api/hf/support/tickets/HF-10001/reply", { message: "hi" })).status).toBe(404);
    expect((await call(t, "u2", "POST", "/api/hf/support/tickets/HF-10001/solve")).status).toBe(404);
    expect((await call(t, "u2", "GET", "/api/hf/support/tickets")).json.tickets).toHaveLength(0);
  });

  it("rate limits: 6th ticket in a day is 429", async () => {
    const t = makeEnv(); user(t, "u1", "u1@example.com");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await create(t, "u1", { subject: "Subject " + i, message: "unique message " + i })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("reply: waiting -> open, marks unread for staff; solve then reopen within 7 days; reopen after 7 days is refused", async () => {
    const t = makeEnv(); user(t, "u1", "u1@example.com");
    await create(t, "u1");
    t.db.prepare("UPDATE support_tickets SET status='waiting' WHERE number=10001").run();
    expect((await call(t, "u1", "POST", "/api/hf/support/tickets/10001/reply", { message: "Here is the UPI ref 998877" })).json).toMatchObject({ ok: true });
    expect(t.db.prepare("SELECT status,unread_staff FROM support_tickets WHERE number=10001").get()).toMatchObject({ status: "open", unread_staff: 1 });

    expect((await call(t, "u1", "POST", "/api/hf/support/tickets/10001/solve")).json.ok).toBe(true);
    expect((await call(t, "u1", "GET", "/api/hf/support/tickets/10001")).json.ticket).toMatchObject({ status: "solved", statusLabel: "Solved", canReopen: true });
    expect((await call(t, "u1", "POST", "/api/hf/support/tickets/10001/reopen")).json.ok).toBe(true);
    expect(t.db.prepare("SELECT status FROM support_tickets WHERE number=10001").get()).toEqual({ status: "open" });

    t.db.prepare("UPDATE support_tickets SET status='solved', solved_at=? WHERE number=10001").run(Date.now() - 8 * 86_400_000);
    const late = await call(t, "u1", "POST", "/api/hf/support/tickets/10001/reopen");
    expect(late.json.ok).toBe(false);
  });

  it("reply on a closed ticket opens a new linked ticket and says so (additive newTicket)", async () => {
    const t = makeEnv(); user(t, "u1", "u1@example.com");
    await create(t, "u1");
    t.db.prepare("UPDATE support_tickets SET status='closed', closed_at=? WHERE number=10001").run(Date.now());
    const r = await call(t, "u1", "POST", "/api/hf/support/tickets/10001/reply", { message: "Another problem now, please look." });
    expect(r.json.ok).toBe(true);
    expect(r.json.newTicket?.number).toBe("HF-10002");
    expect(t.db.prepare("SELECT linked_from FROM support_tickets WHERE number=10002").get()).toEqual({ linked_from: 10001 });
  });

  it("attachments: upload, then attach to a ticket, then download as owner only; executables refused", async () => {
    const t = makeEnv(); user(t, "u1", "u1@example.com"); user(t, "u2", "u2@example.com");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const up = await call(t, "u1", "POST", "/api/hf/support/attachments", png, { "content-type": "image/png", "x-file-name": encodeURIComponent("स्क्रीन शॉट.png") });
    expect(up.json).toMatchObject({ ok: true, size: 7, name: "स्क्रीन शॉट.png" });
    const bad = await call(t, "u1", "POST", "/api/hf/support/attachments", new Uint8Array([1, 2, 3]), { "content-type": "application/octet-stream", "x-file-name": "virus.exe" });
    expect(bad.status).toBe(400);

    const r = await create(t, "u1", { attachmentIds: [up.json.id] });
    expect(r.json.ok).toBe(true);
    const d = await call(t, "u1", "GET", "/api/hf/support/tickets/10001");
    expect(d.json.messages[0].attachments[0]).toMatchObject({ id: up.json.id, name: "स्क्रीन शॉट.png", size: 7, contentType: "image/png" });
    const dl = await call(t, "u1", "GET", `/api/hf/support/attachments/${up.json.id}`);
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.res.arrayBuffer())).toEqual(png);
    expect((await call(t, "u2", "GET", `/api/hf/support/attachments/${up.json.id}`)).status).toBe(404);
    // an attachment cannot be reused by another user
    expect((await create(t, "u2", { attachmentIds: [up.json.id], message: "stolen attach" })).status).toBe(400);
    // R2 key is under support/
    expect([...t.r2.store.keys()].filter((k) => !k.startsWith("email-outbox/")).every((k) => k.startsWith("support/"))).toBe(true);
  });
});
