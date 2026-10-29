// [HF-SUPPORT-ENGINE-2] provider Message-ID threading and the email outbox recovery / Retry path.
import { describe, it, expect } from "vitest";
import { processInbound } from "./support_inbound";
import { enqueueEmail, recoverEmailOutbox, retryEmailOutboxRow } from "./email_outbox";
import { makeEnv, rawMail, putInbound } from "./support_testkit";

const NOW = Date.parse("2026-10-29T05:30:00Z");

describe("threading on the provider's Message-ID", () => {
  it("a reply quoting the id the provider returned lands on the ticket, even without the [HF-N] tag", async () => {
    const t = makeEnv();
    const j1 = await putInbound(t, "a1", rawMail({ From: "rahul@example.com", To: "support@hellofraands.com", Subject: "Wallet", "Message-ID": "<c1@mail.example.com>" }, "Money cut, wallet empty."), "rahul@example.com");
    await processInbound(t.env, j1, NOW);
    // the provider accepted our ack and told us its own id
    t.db.prepare("UPDATE email_outbox SET provider_message_id='0100019abc-def@email.cloudflare.net', delivery_status='provider_accepted', state='sent' WHERE outbox_key='support-ack:10001'").run();
    const j2 = await putInbound(t, "a2", rawMail({
      From: "rahul@example.com", To: "support@hellofraands.com", Subject: "Re: We got your message",
      "Message-ID": "<c2@mail.example.com>", "In-Reply-To": "<0100019abc-def@email.cloudflare.net>",
    }, "Still nothing, please check."), "rahul@example.com");
    const r: any = await processInbound(t.env, j2, NOW + 60_000);
    expect(r.ticket).toBe(10001);
    expect(t.db.prepare("SELECT COUNT(*) n FROM support_tickets").get()).toEqual({ n: 1 });
  });

  it("another sender cannot ride the id into someone else's ticket", async () => {
    const t = makeEnv();
    const j1 = await putInbound(t, "b1", rawMail({ From: "rahul@example.com", To: "support@hellofraands.com", Subject: "Wallet", "Message-ID": "<d1@x>" }, "Money cut, wallet empty."), "rahul@example.com");
    await processInbound(t.env, j1, NOW);
    t.db.prepare("UPDATE email_outbox SET provider_message_id='prov-1' WHERE outbox_key='support-ack:10001'").run();
    const j2 = await putInbound(t, "b2", rawMail({ From: "other@example.com", To: "support@hellofraands.com", Subject: "Hello", "Message-ID": "<d2@x>", "In-Reply-To": "<prov-1>" }, "I am someone else entirely."), "other@example.com");
    const r: any = await processInbound(t.env, j2, NOW + 1000);
    expect(r.ticket).not.toBe(10001);
  });
});

async function seedRows(t: ReturnType<typeof makeEnv>, n: number) {
  for (let i = 0; i < n; i++) {
    await enqueueEmail(t.env, { to: `u${i}@example.com`, subject: `s${i}`, html: "<p>x</p>", outboxKey: `bulk-${i}`, kind: "test" }, { lane: "bulk" });
  }
}

describe("recoverEmailOutbox", () => {
  it("old slow rows cannot starve a newer failed row out of the sweep window", async () => {
    const t = makeEnv();
    const now = Date.now();
    await seedRows(t, 60);
    // 60 old rows whose jobs are still waiting for the consumer
    t.db.prepare("UPDATE email_outbox SET created_at=?1, next_attempt_at=?1 WHERE outbox_key LIKE 'bulk-%'").run(now - 3_600_000);
    await enqueueEmail(t.env, { to: "rahul@example.com", subject: "ack", html: "<p>ack</p>", outboxKey: "support-ack:10001", kind: "support" }, { lane: "priority" });
    t.db.prepare("UPDATE email_outbox SET state='pending',delivery_status='failed',attempts=0,next_attempt_at=?1,lease_expires_at=NULL WHERE outbox_key='support-ack:10001'").run(now - 1000);
    t.queues.bulk.sent.length = 0; t.queues.priority.sent.length = 0;
    await recoverEmailOutbox(t.env, 50);
    await recoverEmailOutbox(t.env, 50);
    expect(t.queues.priority.sent.filter((j: any) => j.key === "support-ack:10001").length).toBe(1);
    expect((t.db.prepare("SELECT delivery_status s FROM email_outbox WHERE outbox_key='support-ack:10001'").get() as any).s).toBe("queued");
  });

  it("does not re-push the same rows every sweep (cooldown)", async () => {
    const t = makeEnv();
    await seedRows(t, 3);
    t.db.prepare("UPDATE email_outbox SET next_attempt_at=?1 WHERE outbox_key LIKE 'bulk-%'").run(Date.now() - 1000);
    t.queues.bulk.sent.length = 0;
    expect(await recoverEmailOutbox(t.env)).toBe(3);
    expect(await recoverEmailOutbox(t.env)).toBe(0);
  });
});

describe("Admin Queues Retry", () => {
  it("re-sends one specific failed row immediately, whatever else is waiting", async () => {
    const t = makeEnv();
    const now = Date.now();
    await seedRows(t, 60);
    t.db.prepare("UPDATE email_outbox SET created_at=?1, next_attempt_at=?1 WHERE outbox_key LIKE 'bulk-%'").run(now - 3_600_000);
    await enqueueEmail(t.env, { to: "rahul@example.com", subject: "ack", html: "<p>ack</p>", outboxKey: "support-ack:10001", kind: "support" }, { lane: "priority" });
    t.db.prepare("UPDATE email_outbox SET state='failed',delivery_status='failed',attempts=5,next_attempt_at=NULL,error_message='E_VALIDATION_ERROR' WHERE outbox_key='support-ack:10001'").run();
    t.queues.priority.sent.length = 0;
    const r = await retryEmailOutboxRow(t.env, "support-ack:10001");
    expect(r).toEqual({ requeued: true });
    expect(t.queues.priority.sent).toHaveLength(1);
    expect(t.queues.priority.sent[0]).toMatchObject({ job: "send", key: "support-ack:10001" });
    expect(t.db.prepare("SELECT delivery_status s, attempts a, error_message e FROM email_outbox WHERE outbox_key='support-ack:10001'").get()).toEqual({ s: "queued", a: 0, e: null });
  });

  it("reports why it did not re-send", async () => {
    const t = makeEnv();
    expect(await retryEmailOutboxRow(t.env, "nope")).toEqual({ requeued: false, reason: "not_found" });
    await seedRows(t, 1);
    t.db.prepare("UPDATE email_outbox SET delivery_status='delivered',state='sent' WHERE outbox_key='bulk-0'").run();
    expect(await retryEmailOutboxRow(t.env, "bulk-0")).toEqual({ requeued: false, reason: "status_delivered" });
  });
});
