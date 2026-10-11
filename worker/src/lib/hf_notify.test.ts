// @ts-nocheck -- node:sqlite D1 shim
// [HF-NOTIFY-DELIVERY-1] Durable Notify-me materialization and paced delivery contract.
import { beforeEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({
  wa: [] as Array<{ to: string; text: string }>,
  pushes: [] as Array<{ uid: string; host: any }>,
  events: [] as Array<{ uid: string; event: string; props: any }>,
  waResult: { ok: true } as any,
  sendGate: null as Promise<void> | null,
  flag: true,
}));

vi.mock("./whatsapp_send", () => ({
  sendWhatsAppText: async (_env: any, to: string, text: string) => {
    observed.wa.push({ to, text });
    if (observed.sendGate) await observed.sendGate;
    return observed.waResult;
  },
}));
vi.mock("./hf_push", () => ({
  pushNotifyMe: async (_env: any, _ctx: any, uid: string, host: any) => {
    observed.pushes.push({ uid, host });
    return true;
  },
}));
vi.mock("./hf_reviews", () => ({ hfCallsOn: async () => observed.flag }));
vi.mock("../hooks", () => ({
  track: async (_env: any, uid: string, event: string, _app: string, props: any) => {
    observed.events.push({ uid, event, props });
  },
  trackException: async () => {},
}));

import { makeDb } from "./hf_token_d1_shim";
import { notifyHostOnline, runHfNotifyMaterializer } from "./hf_notify";
import { runWhatsAppOutboxDrain } from "./whatsapp_notify";

const NOW = Date.UTC(2026, 9, 11, 12);
const DAY = 86_400_000;
let env: any;

const host = (uid = "host", presence = "online") => {
  env.DB_META._raw.prepare(
    "INSERT INTO hf_hosts (uid,slug,status,display_name,presence,created_at,updated_at) VALUES (?,?, 'live','Priya',?,1,1)",
  ).run(uid, `host-${uid}`, presence);
};
const phone = (uid: string) => {
  const hash = `hash-${uid}`;
  env.DB_META._raw.prepare(
    "INSERT INTO contact_verification (uid,phone_verified,phone_hash,updated_at) VALUES (?,1,?,1)",
  ).run(uid, hash);
  env.DB_META._raw.prepare(
    "INSERT INTO phone_otp (uid,phone_hash,e164,status,created_at,verified_at) VALUES (?,?,?,'verified',1,1)",
  ).run(uid, hash, `+919${uid.padStart(9, "0").slice(-9)}`);
};
const subscribe = (caller: string, createdAt = NOW, hostUid = "host") => {
  env.DB_META._raw.prepare(
    "INSERT OR REPLACE INTO hf_notify (caller_uid,host_uid,created_at,notified_at) VALUES (?,?,?,NULL)",
  ).run(caller, hostUid, createdAt);
};
const scalar = (sql: string) => Number(env.DB_META._raw.prepare(sql).get().n);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  env = {
    WASENDER_API_KEY: "test-key",
    DB_META: makeDb([
      "2026-10-09-hf-hosts.sql",
      "2026-10-09-hf-presence.sql",
      "2026-10-09-hf-calls.sql",
      "2026-10-09-hf-reviews.sql",
      "2026-09-28-whatsapp-outbox.sql",
      "contact_verification.sql",
      "phone_otp.sql",
    ], { alters: true }),
  };
  observed.wa.length = 0;
  observed.pushes.length = 0;
  observed.events.length = 0;
  observed.waResult = { ok: true };
  observed.sendGate = null;
  observed.flag = true;
});

describe("Notify-me outbox materialization", () => {
  it("durably materializes every eligible subscriber beyond the old 25-recipient cap without provider I/O", async () => {
    host();
    for (let i = 0; i < 40; i++) { const uid = `u${i}`; phone(uid); subscribe(uid, NOW + i); }

    await notifyHostOnline(env, undefined, "host");

    expect(scalar("SELECT COUNT(*) n FROM whatsapp_outbox WHERE kind='hf_notify'")).toBe(40);
    expect(scalar("SELECT COUNT(*) n FROM hf_notify")).toBe(0);
    expect(observed.wa).toHaveLength(0);
    expect(observed.pushes).toHaveLength(0);
    expect(observed.events.filter((x) => x.event === "hf_notify_queued")).toHaveLength(40);
  });

  it("duplicate online transitions leave exactly one durable outbox row", async () => {
    host(); phone("u1"); subscribe("u1");
    await notifyHostOnline(env, undefined, "host");
    await notifyHostOnline(env, undefined, "host");
    expect(scalar("SELECT COUNT(*) n FROM whatsapp_outbox WHERE kind='hf_notify'")).toBe(1);
    expect(scalar("SELECT COUNT(*) n FROM hf_notify")).toBe(0);
  });

  it("the safety sweep completes cleanup after an insert-before-delete interruption", async () => {
    host(); phone("u1"); subscribe("u1");
    await notifyHostOnline(env, undefined, "host");
    // Recreate the exact subscription row to model execution stopping after the durable insert.
    subscribe("u1");
    const r = await runHfNotifyMaterializer(env, 10, NOW + 1);
    expect(r.scanned).toBe(1);
    expect(scalar("SELECT COUNT(*) n FROM whatsapp_outbox WHERE kind='hf_notify'")).toBe(1);
    expect(scalar("SELECT COUNT(*) n FROM hf_notify")).toBe(0);
  });

  it("silently terminates blocked and missing-number subscriptions", async () => {
    host(); phone("blocked"); subscribe("blocked"); subscribe("missing", NOW + 1);
    env.DB_META._raw.prepare("INSERT INTO hf_blocks (blocker_uid,blocked_uid,created_at) VALUES ('host','blocked',1)").run();
    await notifyHostOnline(env, undefined, "host");
    expect(scalar("SELECT COUNT(*) n FROM whatsapp_outbox")).toBe(0);
    expect(scalar("SELECT COUNT(*) n FROM hf_notify")).toBe(0);
    expect(observed.events).toHaveLength(0);
  });

  it("enforces the 24-hour window per caller+host, then queues the waiting subscription", async () => {
    host(); phone("u1"); subscribe("u1");
    await notifyHostOnline(env, undefined, "host");
    await runWhatsAppOutboxDrain(env, 1);
    subscribe("u1", NOW + 1000);
    const early = await runHfNotifyMaterializer(env, 10, NOW + DAY - 1);
    expect(early.deferred).toBe(1);
    expect(scalar("SELECT COUNT(*) n FROM whatsapp_outbox WHERE kind='hf_notify'")).toBe(1);
    expect(scalar("SELECT COUNT(*) n FROM hf_notify")).toBe(1);
    expect(env.DB_META._raw.prepare("SELECT notified_at FROM hf_notify").get().notified_at).toBe(NOW);
    await runHfNotifyMaterializer(env, 10, NOW + DAY);
    expect(scalar("SELECT COUNT(*) n FROM whatsapp_outbox WHERE kind='hf_notify'")).toBe(2);
    expect(scalar("SELECT COUNT(*) n FROM hf_notify")).toBe(0);
  });

  it("scopes the 24-hour suppression to the caller+host pair, not the caller globally", async () => {
    host("host-a"); host("host-b"); phone("u1");
    subscribe("u1", NOW, "host-a");
    await notifyHostOnline(env, undefined, "host-a");
    await runWhatsAppOutboxDrain(env, 1);
    subscribe("u1", NOW + 1, "host-b");
    await notifyHostOnline(env, undefined, "host-b");
    expect(scalar("SELECT COUNT(*) n FROM whatsapp_outbox WHERE kind='hf_notify'")).toBe(2);
    expect(scalar("SELECT COUNT(*) n FROM hf_notify")).toBe(0);
  });

  it("does not materialize while the HF calls kill switch is off", async () => {
    host(); phone("u1"); subscribe("u1"); observed.flag = false;
    await notifyHostOnline(env, undefined, "host");
    expect((await runHfNotifyMaterializer(env, 10, NOW)).scanned).toBe(0);
    expect(scalar("SELECT COUNT(*) n FROM whatsapp_outbox")).toBe(0);
    expect(scalar("SELECT COUNT(*) n FROM hf_notify")).toBe(1);
  });
});

describe("Notify-me delivery through the existing paced outbox drain", () => {
  const queueOne = async () => {
    host(); phone("u1"); subscribe("u1");
    await notifyHostOnline(env, undefined, "host");
  };

  it("emits hf_notify_sent only after actual WhatsApp success and adds the FCM supplement", async () => {
    await queueOne();
    await runWhatsAppOutboxDrain(env, 1);
    expect(observed.wa).toHaveLength(1);
    expect(observed.pushes).toEqual([{ uid: "u1", host: { display_name: "Priya", slug: "host-host" } }]);
    expect(env.DB_META._raw.prepare("SELECT status,attempts FROM whatsapp_outbox").get()).toMatchObject({ status: "sent", attempts: 1 });
    expect(observed.events.filter((x) => x.event === "hf_notify_sent")).toHaveLength(1);
  });

  it("atomically claims a row so overlapping drains call the provider only once", async () => {
    await queueOne();
    let release!: () => void;
    observed.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const first = runWhatsAppOutboxDrain(env, 1);
    const second = runWhatsAppOutboxDrain(env, 1);
    await Promise.resolve(); await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(observed.wa).toHaveLength(1);
    expect(observed.pushes).toHaveLength(1);
    expect(env.DB_META._raw.prepare("SELECT status,attempts FROM whatsapp_outbox").get()).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("retries only an explicit known-not-accepted transient failure", async () => {
    await queueOne();
    observed.waResult = { ok: false, reason: "rate_limited", detail: "429" };
    await runWhatsAppOutboxDrain(env, 1);
    expect(env.DB_META._raw.prepare("SELECT status,attempts FROM whatsapp_outbox").get()).toMatchObject({ status: "queued", attempts: 1 });
    expect(observed.events.find((x) => x.event === "hf_notify_failed")?.props).toMatchObject({ reason: "rate_limited", retryable: true, terminal: false, status: "queued" });
    observed.waResult = { ok: true };
    await runWhatsAppOutboxDrain(env, 1);
    expect(env.DB_META._raw.prepare("SELECT status,attempts FROM whatsapp_outbox").get()).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("quarantines an ambiguous provider result instead of risking a duplicate send", async () => {
    await queueOne();
    observed.waResult = { ok: false, reason: "provider_error", detail: "no_response" };
    await runWhatsAppOutboxDrain(env, 1);
    expect(env.DB_META._raw.prepare("SELECT status,attempts FROM whatsapp_outbox").get()).toMatchObject({ status: "manual_reconcile", attempts: 1 });
    await runWhatsAppOutboxDrain(env, 1);
    expect(observed.wa).toHaveLength(1);
    expect(observed.events.find((x) => x.event === "hf_notify_failed")?.props).toMatchObject({
      reason: "ambiguous_provider_result", retryable: false, terminal: true, status: "manual_reconcile", manual_reconcile: true,
    });
  });

  it("quarantines an expired in-flight claim instead of replaying it", async () => {
    await queueOne();
    env.DB_META._raw.prepare(
      "UPDATE whatsapp_outbox SET status='sending', attempts=1, updated_at=? WHERE kind='hf_notify'",
    ).run(NOW - 120_001);
    await runWhatsAppOutboxDrain(env, 1);
    expect(env.DB_META._raw.prepare("SELECT status,error,attempts FROM whatsapp_outbox").get()).toMatchObject({
      status: "manual_reconcile", error: "ambiguous_in_flight", attempts: 1,
    });
    expect(observed.wa).toHaveLength(0);
    expect(observed.pushes).toHaveLength(0);
    expect(observed.events.find((x) => x.event === "hf_notify_failed")?.props).toMatchObject({
      reason: "ambiguous_in_flight", retryable: false, terminal: true, status: "manual_reconcile", manual_reconcile: true,
    });
  });

  it("makes not-on-WhatsApp terminal and never reports a successful send", async () => {
    await queueOne();
    observed.waResult = { ok: false, reason: "not_on_whatsapp", detail: "absent" };
    await runWhatsAppOutboxDrain(env, 1);
    expect(env.DB_META._raw.prepare("SELECT status,attempts FROM whatsapp_outbox").get()).toMatchObject({ status: "failed", attempts: 1 });
    expect(observed.events.filter((x) => x.event === "hf_notify_sent")).toHaveLength(0);
    expect(observed.events.find((x) => x.event === "hf_notify_failed")?.props).toMatchObject({ retryable: false, terminal: true, status: "failed" });
  });

  it("silently cancels when the pair becomes blocked after enqueue", async () => {
    await queueOne();
    env.DB_META._raw.prepare("INSERT INTO hf_blocks (blocker_uid,blocked_uid,created_at) VALUES ('host','u1',1)").run();
    await runWhatsAppOutboxDrain(env, 1);
    expect(env.DB_META._raw.prepare("SELECT status,error FROM whatsapp_outbox").get()).toMatchObject({ status: "cancelled", error: "ineligible_before_send" });
    expect(observed.wa).toHaveLength(0); expect(observed.pushes).toHaveLength(0);
  });

  it("silently cancels when the verified number changes after enqueue", async () => {
    await queueOne();
    env.DB_META._raw.prepare("UPDATE phone_otp SET e164='+919999999999' WHERE uid='u1'").run();
    await runWhatsAppOutboxDrain(env, 1);
    expect(env.DB_META._raw.prepare("SELECT status FROM whatsapp_outbox").get().status).toBe("cancelled");
    expect(observed.wa).toHaveLength(0); expect(observed.pushes).toHaveLength(0);
  });

  it("silently cancels when the HF calls kill switch turns off after enqueue", async () => {
    await queueOne(); observed.flag = false;
    await runWhatsAppOutboxDrain(env, 1);
    expect(env.DB_META._raw.prepare("SELECT status FROM whatsapp_outbox").get().status).toBe("cancelled");
    expect(observed.wa).toHaveLength(0); expect(observed.pushes).toHaveLength(0);
  });
});
