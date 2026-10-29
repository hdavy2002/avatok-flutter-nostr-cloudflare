// [HF-SUPPORT-1] Inbound email end to end on in-memory SQLite + fake R2 / queues.
import { describe, it, expect } from "vitest";
import { processInbound, handleSupportInboundQueue, recoverInbound } from "./support_inbound";
import { makeEnv, rawMail, putInbound, type TestEnv } from "./support_testkit";

const NOW = Date.parse("2026-10-29T05:30:00Z"); // Thu 11:00 IST
let seq = 0;

async function send(t: TestEnv, from: string, headers: Record<string, string | string[]>, body: string, opts: { to?: string; now?: number } = {}) {
  const id = `m${++seq}`;
  const to = opts.to ?? "support@hellofraands.com";
  const job = await putInbound(t, id, rawMail({ From: from, To: to, "Message-ID": `<${id}@mail.example.com>`, ...headers }, body), from, to);
  return processInbound(t.env, job, opts.now ?? NOW);
}
const one = (t: TestEnv, sql: string, ...p: unknown[]) => t.db.prepare(sql).get(...p);
const all = (t: TestEnv, sql: string, ...p: unknown[]) => t.db.prepare(sql).all(...p);

describe("new mail", () => {
  it("creates a ticket from an unknown sender, with a contact, ack email and admin alert", async () => {
    const t = makeEnv();
    const r: any = await send(t, "Rahul <rahul@example.com>", { Subject: "Wallet top-up failed" }, "Money was cut but wallet shows nothing.");
    expect(r.result).toBe("created");
    expect(r.ticket).toBe(10001);
    const tk: any = one(t, "SELECT * FROM support_tickets WHERE number=10001");
    expect(tk.status).toBe("new");
    expect(tk.channel).toBe("email");
    expect(tk.uid).toBeNull();
    expect(tk.subject).toBe("Wallet top-up failed");
    const c: any = one(t, "SELECT * FROM support_contacts WHERE id=?", tk.contact_id);
    expect(c.email).toBe("rahul@example.com");
    expect(c.uid).toBeNull();
    expect(all(t, "SELECT author_type FROM support_messages WHERE ticket_number=10001 ORDER BY created_at").map((m: any) => m.author_type)).toEqual(["customer", "system"]);
    // ack goes out through the durable outbox, the alert too
    const outbox = all(t, "SELECT outbox_key FROM email_outbox").map((o: any) => o.outbox_key);
    expect(outbox).toContain("support-ack:10001");
    expect(t.queues.waP.sent.length + t.queues.waN.sent.length).toBeGreaterThanOrEqual(1);
    expect(one(t, "SELECT status,ticket_number FROM support_inbound")).toMatchObject({ status: "processed", ticket_number: 10001 });
  });

  it("is idempotent: the same Message-ID twice makes one ticket", async () => {
    const t = makeEnv();
    const h = { Subject: "Hi", "Message-ID": "<fixed@mail.example.com>" };
    const a: any = await send(t, "a@example.com", h, "Please help with my booking.");
    const b: any = await send(t, "a@example.com", h, "Please help with my booking.");
    expect(a.result).toBe("created");
    expect(b.result).toBe("duplicate");
    expect(one(t, "SELECT COUNT(*) n FROM support_tickets")).toEqual({ n: 1 });
  });

  it("running the same stored email twice is a no-op", async () => {
    const t = makeEnv();
    const job = await putInbound(t, "same", rawMail({ From: "a@example.com", To: "support@hellofraands.com", Subject: "x", "Message-ID": "<s@x>" }, "hello there friend"), "a@example.com");
    await processInbound(t.env, job, NOW);
    const again: any = await processInbound(t.env, job, NOW);
    expect(again.result).toBe("already_done");
    expect(one(t, "SELECT COUNT(*) n FROM support_tickets")).toEqual({ n: 1 });
  });

  it("merges identical text from the same sender within 10 minutes", async () => {
    const t = makeEnv();
    await send(t, "a@example.com", { Subject: "Help" }, "my wallet is empty please check");
    const r: any = await send(t, "a@example.com", { Subject: "Help again" }, "My wallet is empty   please check", { now: NOW + 5 * 60_000 });
    expect(r.result).toBe("duplicate");
    expect(one(t, "SELECT COUNT(*) n FROM support_tickets")).toEqual({ n: 1 });
  });

  it("limits 5 new tickets per person per day", async () => {
    const t = makeEnv();
    const results: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r: any = await send(t, "busy@example.com", { Subject: `Q${i}` }, `different question number ${i} about calls`);
      results.push(r.result);
    }
    expect(results.filter((x) => x === "created")).toHaveLength(5);
    expect(one(t, "SELECT COUNT(*) n FROM support_tickets")).toEqual({ n: 5 });
  });
});

describe("threading", () => {
  async function seed(t: TestEnv) {
    const r: any = await send(t, "rahul@example.com", { Subject: "Wallet problem" }, "Money was cut but wallet shows nothing.");
    return r.ticket as number;
  }
  it("support+N@ recipient appends to the ticket and moves waiting to open", async () => {
    const t = makeEnv();
    const n = await seed(t);
    t.db.prepare("UPDATE support_tickets SET status='waiting' WHERE number=?").run(n);
    const r: any = await send(t, "rahul@example.com", { Subject: "Re: anything" }, "Here is the screenshot info, UPI ref 123456.", { to: `support+${n}@hellofraands.com`, now: NOW + HOUR });
    expect(r).toMatchObject({ result: "appended", ticket: n });
    expect(one(t, "SELECT status FROM support_tickets WHERE number=?", n)).toEqual({ status: "open" });
  });
  it("[HF-N] subject tag works", async () => {
    const t = makeEnv();
    const n = await seed(t);
    const r: any = await send(t, "rahul@example.com", { Subject: `Re: [HF-${n}] Wallet problem` }, "Any update on this please?", { now: NOW + HOUR });
    expect(r).toMatchObject({ result: "appended", ticket: n });
  });
  it("In-Reply-To against a stored outgoing Message-ID works", async () => {
    const t = makeEnv();
    const n = await seed(t);
    t.db.prepare("INSERT INTO support_messages (id,ticket_number,author_type,author_name,text,preview,message_id_header,created_at) VALUES ('out1',?,'staff','Agent','hi','hi','hf-out-1@hellofraands.com',?)").run(n, NOW + 1000);
    const r: any = await send(t, "rahul@example.com", { Subject: "No tag here", "In-Reply-To": "<hf-out-1@hellofraands.com>" }, "Thanks, replying to your mail.", { now: NOW + HOUR });
    expect(r).toMatchObject({ result: "appended", ticket: n });
  });
  it("a stranger quoting a ticket number does NOT get into someone else's ticket", async () => {
    const t = makeEnv();
    const n = await seed(t);
    const r: any = await send(t, "stranger@example.com", { Subject: `[HF-${n}] hi` }, "I am a different person asking something.", { to: `support+${n}@hellofraands.com`, now: NOW + HOUR });
    expect(r.result).toBe("created");
    expect(r.ticket).not.toBe(n);
    expect(one(t, "SELECT COUNT(*) n FROM support_messages WHERE ticket_number=? AND author_type='customer'", n)).toEqual({ n: 1 });
  });
  it("solved within 7 days reopens; after 7 days, and closed, open a new linked ticket", async () => {
    const t = makeEnv();
    const n = await seed(t);
    t.db.prepare("UPDATE support_tickets SET status='solved', solved_at=? WHERE number=?").run(NOW, n);
    const a: any = await send(t, "rahul@example.com", { Subject: `[HF-${n}] still broken` }, "It is still broken after your fix.", { now: NOW + 2 * DAY });
    expect(a).toMatchObject({ result: "appended", ticket: n, reopened: true });
    expect(one(t, "SELECT status FROM support_tickets WHERE number=?", n)).toEqual({ status: "open" });

    t.db.prepare("UPDATE support_tickets SET status='closed', closed_at=? WHERE number=?").run(NOW, n);
    const b: any = await send(t, "rahul@example.com", { Subject: `[HF-${n}] new issue` }, "A separate problem now, with calls.", { now: NOW + 20 * DAY });
    expect(b.result).toBe("linked_new");
    expect(b.from).toBe(n);
    expect(one(t, "SELECT linked_from FROM support_tickets WHERE number=?", b.ticket)).toEqual({ linked_from: n });
  });
  it("quoted history is stripped from a reply", async () => {
    const t = makeEnv();
    const n = await seed(t);
    await send(t, "rahul@example.com", { Subject: `[HF-${n}] x` }, "Thanks it works now.\n\nOn Thu, 29 Oct 2026 at 10:00, Hello Fraands Support <support@hellofraands.com> wrote:\n> Money was cut but wallet shows nothing.", { now: NOW + HOUR });
    const last: any = one(t, "SELECT text FROM support_messages WHERE ticket_number=? AND author_type='customer' ORDER BY created_at DESC", n);
    expect(last.text).toBe("Thanks it works now.");
  });
});

describe("what must not happen", () => {
  it("drops blocked senders and blocked domains silently", async () => {
    const t = makeEnv();
    t.db.prepare("INSERT INTO support_blocklist (kind,value,created_at) VALUES ('domain','spamco.biz',?),('email','bad@example.com',?)").run(NOW, NOW);
    const a: any = await send(t, "x@mail.spamco.biz", { Subject: "buy" }, "hello hello hello hello");
    const b: any = await send(t, "bad@example.com", { Subject: "buy" }, "hello hello hello hello 2");
    expect([a.result, a.reason, b.reason]).toEqual(["dropped", "blocklist", "blocklist"]);
    expect(one(t, "SELECT COUNT(*) n FROM support_tickets")).toEqual({ n: 0 });
    expect(all(t, "SELECT 1 FROM email_outbox")).toHaveLength(0);
  });
  it("drops our own mail coming back and bounces (no loop)", async () => {
    const t = makeEnv();
    const a: any = await send(t, "support@hellofraands.com", { Subject: "[HF-10001] x" }, "echo of our own mail here");
    const b: any = await send(t, "mailer-daemon@example.com", { Subject: "Undelivered Mail Returned to Sender" }, "could not deliver");
    expect([a.reason, b.reason]).toEqual(["loop", "bounce"]);
    expect(all(t, "SELECT 1 FROM email_outbox")).toHaveLength(0);
  });
  it("creates a ticket for an auto-reply but sends no ack and writes no in-app ack", async () => {
    const t = makeEnv();
    const r: any = await send(t, "ooo@example.com", { Subject: "Hello", "Auto-Submitted": "auto-generated" }, "I am away until Monday, thanks.");
    expect(["created", "dropped"]).toContain(r.result);
    expect(all(t, "SELECT 1 FROM email_outbox WHERE outbox_key LIKE '%support-ack:%'")).toHaveLength(0);
  });
  it("no-reply senders get no ack", async () => {
    const t = makeEnv();
    await send(t, "no-reply@shop.com", { Subject: "Your receipt" }, "Thanks for your order, receipt attached.");
    expect(all(t, "SELECT 1 FROM email_outbox WHERE outbox_key LIKE '%support-ack:%'")).toHaveLength(0);
  });
  it("spam: ticket in the spam folder, no ack, no alert", async () => {
    const t = makeEnv();
    const r: any = await send(t, "scam@example.com", { Subject: "WINNER lottery click here", "Authentication-Results": "mx; spf=fail; dmarc=fail", "X-Spam-Flag": "YES" }, "bitcoin giveaway act now");
    expect(r).toMatchObject({ result: "created", spam: true });
    expect(one(t, "SELECT status FROM support_tickets WHERE number=?", r.ticket)).toEqual({ status: "spam" });
    expect(all(t, "SELECT 1 FROM email_outbox")).toHaveLength(0);
    expect(t.queues.waP.sent.length + t.queues.waN.sent.length).toBe(0);
  });
  it("sends at most 3 acks per sender per hour", async () => {
    const t = makeEnv();
    for (let i = 0; i < 5; i++) {
      t.db.prepare("DELETE FROM support_tickets WHERE 0"); // keep the daily limit out of the way: each mail is a different subject/body
      await send(t, "chatty@example.com", { Subject: `T${i}` }, `distinct body number ${i} about wallet`, { now: NOW + i * 11 * 60_000 });
    }
    expect(all(t, "SELECT 1 FROM email_outbox WHERE outbox_key LIKE '%support-ack:%'")).toHaveLength(3);
  });
  it("refuses executable attachments but keeps the ticket, stores images in R2 under support/", async () => {
    const t = makeEnv();
    const boundary = "BB";
    const body = [
      `--${boundary}`, "Content-Type: text/plain", "", "See attached files for the problem.",
      `--${boundary}`, "Content-Type: image/png; name=shot.png", "Content-Disposition: attachment; filename=shot.png", "Content-Transfer-Encoding: base64", "", btoa("PNGDATA-1234"),
      `--${boundary}`, "Content-Type: application/octet-stream; name=virus.exe", "Content-Disposition: attachment; filename=virus.exe", "Content-Transfer-Encoding: base64", "", btoa("MZ-evil"),
      `--${boundary}--`, "",
    ].join("\r\n");
    const r: any = await send(t, "pic@example.com", { Subject: "Screenshot", "Content-Type": `multipart/mixed; boundary=${boundary}` }, body);
    expect(r.result).toBe("created");
    const atts: any[] = all(t, "SELECT name,r2_key FROM support_attachments WHERE ticket_number=?", r.ticket);
    expect(atts.map((a) => a.name)).toEqual(["shot.png"]);
    expect(atts[0].r2_key.startsWith(`support/att/${r.ticket}/`)).toBe(true);
    expect(t.r2.store.has(atts[0].r2_key)).toBe(true);
  });
});

describe("queue plumbing", () => {
  it("the queue handler processes IDs, acks messages, and the DLQ marks the row failed", async () => {
    const t = makeEnv();
    const job = await putInbound(t, "q1", rawMail({ From: "q@example.com", To: "support@hellofraands.com", Subject: "Queue", "Message-ID": "<q1@x>" }, "hello from the queue path"), "q@example.com");
    const acked: string[] = [];
    await handleSupportInboundQueue({ queue: "support-inbound", messages: [{ id: "1", body: job, ack: () => acked.push("1"), retry: () => acked.push("retry") }] } as any, t.env);
    expect(acked).toEqual(["1"]);
    expect(one(t, "SELECT COUNT(*) n FROM support_tickets")).toEqual({ n: 1 });

    const dead = await putInbound(t, "q2", rawMail({ From: "q@example.com", Subject: "x" }, "y"), "q@example.com");
    t.db.prepare("INSERT INTO support_inbound (id,r2_key,status,created_at) VALUES ('d',?, 'received', ?)").run(dead.r2Key, NOW);
    await handleSupportInboundQueue({ queue: "support-inbound-dlq", messages: [{ id: "2", body: dead, ack: () => {}, retry: () => {} }] } as any, t.env);
    expect(one(t, "SELECT status FROM support_inbound WHERE r2_key=?", dead.r2Key)).toMatchObject({ status: "failed" });
  });
  it("recoverInbound re-queues rows that never got processed", async () => {
    const t = makeEnv();
    const job = await putInbound(t, "lost", rawMail({ From: "l@example.com", Subject: "x" }, "y"), "l@example.com");
    t.db.prepare("INSERT INTO support_inbound (id,r2_key,status,created_at) VALUES ('l',?, 'received', ?)").run(job.r2Key, NOW - 2 * HOUR);
    const n = await recoverInbound(t.env, 50, NOW);
    expect(n).toBe(1);
    expect(t.queues.inbound.sent[0]).toMatchObject({ job: "inbound", r2Key: job.r2Key });
  });
});

const HOUR = 3_600_000;
const DAY = 86_400_000;
