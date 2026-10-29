// @ts-nocheck -- reads source files with node:fs (no node types in the worker tsconfig)
// [HF-SUPPORT-1] Scheduled lifecycle: reminders, auto-solve, auto-close, unsnooze, retention (3y / 8y), alert summaries.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { runSupportJobs, sendWaitingReminders, solveStaleWaiting, closeSolved, unsnoozeDue, purgeTickets, runRetention } from "./support_jobs";
import { createTicket } from "./support_ops";
import { upsertContact, DAY_MS, RETENTION_NORMAL_MS, RETENTION_MONEY_MS } from "./support_core";
import { alertAdmin } from "./support_alerts";
import { makeEnv, type TestEnv } from "./support_testkit";

const NOW = Date.parse("2026-10-29T05:30:00Z");

async function ticket(t: TestEnv, over: { category?: string; email?: string } = {}) {
  const email = over.email ?? `c${Math.random().toString(36).slice(2)}@example.com`;
  const contactId = await upsertContact(t.env, { email }, NOW);
  const r = await createTicket(t.env, {
    uid: null, contactId, subject: "Help me", category: over.category ?? "app", channel: "email", now: NOW,
    message: { text: "please help " + Math.random() }, writeAck: true,
  } as any);
  return r.number;
}
const row = (t: TestEnv, n: number): any => t.db.prepare("SELECT * FROM support_tickets WHERE number=?").get(n);

describe("lifecycle", () => {
  it("waiting 5 days -> one reminder (once); 7 days after the reminder -> solved; solved 7 days -> closed", async () => {
    const t = makeEnv();
    const n = await ticket(t);
    t.db.prepare("UPDATE support_tickets SET status='waiting', waiting_since=? WHERE number=?").run(NOW - 5 * DAY_MS - 1000, n);

    expect(await sendWaitingReminders(t.env, NOW)).toBe(1);
    expect(await sendWaitingReminders(t.env, NOW + 1000)).toBe(0); // not twice
    expect(t.db.prepare("SELECT COUNT(*) c FROM email_outbox WHERE outbox_key LIKE '%reminder%'").get()).toEqual({ c: 1 });
    expect(row(t, n).status).toBe("waiting");

    expect(await solveStaleWaiting(t.env, NOW + 6 * DAY_MS)).toBe(0);
    expect(await solveStaleWaiting(t.env, NOW + 7 * DAY_MS + 1)).toBe(1);
    expect(row(t, n)).toMatchObject({ status: "solved", unread_customer: 1 });
    const solvedAt = row(t, n).solved_at;
    expect(solvedAt).toBeGreaterThan(0);

    expect(await closeSolved(t.env, solvedAt + 6 * DAY_MS)).toBe(0);
    expect(await closeSolved(t.env, solvedAt + 7 * DAY_MS)).toBe(1);
    expect(row(t, n).status).toBe("closed");
  });

  it("a customer reply (waiting -> open) cancels the pending auto-solve", async () => {
    const t = makeEnv();
    const n = await ticket(t);
    t.db.prepare("UPDATE support_tickets SET status='waiting', waiting_since=?, reminder_sent_at=? WHERE number=?").run(NOW - 20 * DAY_MS, NOW - 10 * DAY_MS, n);
    t.db.prepare("UPDATE support_tickets SET status='open' WHERE number=?").run(n);
    expect(await solveStaleWaiting(t.env, NOW)).toBe(0);
  });

  it("snoozed on_hold tickets come back as open when the time is up", async () => {
    const t = makeEnv();
    const n = await ticket(t);
    t.db.prepare("UPDATE support_tickets SET status='on_hold', snooze_until=? WHERE number=?").run(NOW - 1, n);
    expect(await unsnoozeDue(t.env, NOW)).toBe(1);
    expect(row(t, n)).toMatchObject({ status: "open", snooze_until: null, unread_staff: 1 });
  });

  it("runSupportJobs runs every step and reports no errors", async () => {
    const t = makeEnv();
    await ticket(t);
    const res = await runSupportJobs(t.env, NOW);
    expect(res.errors).toEqual([]);
    expect(res.retention).not.toBeNull(); // 11:00 IST is after 02:00 IST
    const again = await runSupportJobs(t.env, NOW + 5 * 60_000);
    expect(again.retention).toBeNull(); // nightly work runs once per IST day
  });
});

describe("retention", () => {
  it("deletes normal tickets after 3 years and money tickets after 8, with their R2 objects", async () => {
    const t = makeEnv();
    const normal = await ticket(t, { category: "app" });
    const money = await ticket(t, { category: "wallet" });
    const open = await ticket(t, { category: "app" });
    const old3 = NOW - RETENTION_NORMAL_MS - DAY_MS;
    t.db.prepare("UPDATE support_tickets SET status='closed', updated_at=? WHERE number IN (?,?)").run(old3, normal, money);
    t.db.prepare("UPDATE support_tickets SET updated_at=? WHERE number=?").run(old3, open); // not finished: kept
    await t.r2.put(`support/att/${normal}/a1/shot.png`, new Uint8Array([1]));
    await t.r2.put(`support/html/${normal}/m1.html`, "<p>x</p>");
    await t.r2.put(`support/att/${money}/a2/shot.png`, new Uint8Array([1]));

    const r = await runRetention(t.env, NOW);
    expect(r.done).toBe(true);
    expect(row(t, normal)).toBeUndefined();
    expect(row(t, money)).toBeDefined();           // money category: 8 years
    expect(row(t, open)).toBeDefined();            // still open
    expect(t.r2.store.has(`support/att/${normal}/a1/shot.png`)).toBe(false);
    expect(t.r2.store.has(`support/html/${normal}/m1.html`)).toBe(false);
    expect(t.r2.store.has(`support/att/${money}/a2/shot.png`)).toBe(true);
    expect(t.db.prepare("SELECT COUNT(*) c FROM support_messages WHERE ticket_number=?").get(normal)).toEqual({ c: 0 });

    t.db.prepare("UPDATE support_tickets SET updated_at=? WHERE number=?").run(NOW - RETENTION_MONEY_MS - DAY_MS, money);
    await runRetention(t.env, NOW);
    expect(row(t, money)).toBeUndefined();
    expect(t.r2.store.has(`support/att/${money}/a2/shot.png`)).toBe(false);
  });

  it("purgeTickets keeps the row when R2 deletion fails (so the next night retries)", async () => {
    const t = makeEnv();
    const n = await ticket(t);
    t.env.BACKUP_R2.list = async () => { throw new Error("r2 down"); };
    expect((await purgeTickets(t.env, [n])).tickets).toBe(0);
    expect(row(t, n)).toBeDefined();
  });
});

describe("admin alerts", () => {
  it("first 10 per minute go out individually, the rest become ONE summary; urgent is always individual", async () => {
    const t = makeEnv();
    const waCount = () => t.queues.waP.sent.length + t.queues.waN.sent.length;
    const tickets: number[] = [];
    for (let i = 0; i < 14; i++) tickets.push(await ticket(t));
    const rows = tickets.map((n) => row(t, n));
    for (let i = 0; i < 14; i++) await alertAdmin(t.env, "new", rows[i], `m${i}`, NOW);
    const individual = t.db.prepare("SELECT COUNT(*) c FROM whatsapp_queue_outbox").get() as any;
    expect(individual.c).toBe(10);
    // urgent breaks through
    t.db.prepare("UPDATE support_tickets SET priority='urgent' WHERE number=?").run(tickets[13]);
    await alertAdmin(t.env, "new", row(t, tickets[13]), "urgent-1", NOW);
    expect((t.db.prepare("SELECT COUNT(*) c FROM whatsapp_queue_outbox").get() as any).c).toBe(11);
    // next minute: the summary of the overflow (4 held back) is sent once
    await alertAdmin(t.env, "new", rows[0], "later", NOW + 61_000);
    const all: any[] = t.db.prepare("SELECT * FROM whatsapp_queue_outbox").all();
    const summaries = all.filter((r) => JSON.stringify(r).includes("support-alert:sum:"));
    expect(summaries.length).toBe(1);
    expect(waCount()).toBeGreaterThan(0);
  });
});

describe("static guarantees", () => {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir).filter((f) => /^support_(alerts|core|inbound|jobs|mail|ops|reply)\.ts$/.test(f));
  it("support modules enqueue only through safeQueueSend / enqueueEmail / enqueueWhatsApp (no raw queue .send)", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), "utf8").replace(/\/\/.*$/gm, "");
      expect(src.match(/\bQ_[A-Z_]+\??\.send\(/g) ?? [], f).toEqual([]);
    }
  });
  it("no hard-coded brand domain in support modules (brand.ts is the only source)", () => {
    for (const f of [...files, "support_mime.ts"]) {
      const src = readFileSync(new URL(f, dir), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, f).not.toMatch(/hellofraands\.com/);
    }
  });
});
