import { describe, expect, it, vi } from "vitest";
import { handleEmailEvent, type EmailSendingEvent } from "../src/email_events";

type Row = Record<string, unknown> | null;

/** Minimal DB_META mock: a script of `first()` results by call order (per SQL
 * prefix bucket) plus a running log of every run() so tests can assert on the
 * exact UPDATE issued. Mirrors the style of email_delivery.test.ts. */
function fakeEnv(opts?: { seenChanges?: number; outboxRow?: Row }) {
  const runs: { sql: string; args: unknown[] }[] = [];
  const seenChanges = opts?.seenChanges ?? 1;
  const outboxRow = opts?.outboxRow === undefined ? null : opts.outboxRow;
  const prepare = vi.fn((sql: string) => {
    let boundArgs: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => { boundArgs = args; return statement; },
      first: async <T>() => {
        if (sql.includes("FROM email_outbox")) return outboxRow as T;
        return null as T;
      },
      run: async () => {
        runs.push({ sql, args: boundArgs });
        if (sql.includes("email_events_seen")) return { meta: { changes: seenChanges } };
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  });
  return { env: { DB_META: { prepare } } as any, runs };
}

function evt(partial: Partial<EmailSendingEvent> & { type: string }): EmailSendingEvent {
  return {
    source: { type: "email.sending", domain: "avatok.ai" },
    metadata: { eventTimestamp: "2026-06-01T02:48:57.132Z" },
    ...partial,
  } as EmailSendingEvent;
}

describe("handleEmailEvent", () => {
  it("ignores a duplicate eventId without touching email_outbox", async () => {
    const { env, runs } = fakeEnv({ seenChanges: 0 });
    await handleEmailEvent(
      evt({ type: "cf.email.sending.message.delivered", payload: { eventId: "e1", messageId: "m1", recipient: "a@b.com" } }),
      env,
    );
    expect(runs).toHaveLength(1); // only the INSERT OR IGNORE into email_events_seen
    expect(runs[0].sql).toContain("email_events_seen");
  });

  it("delivered updates the outbox row to delivered", async () => {
    const { env, runs } = fakeEnv({ outboxRow: { outbox_key: "k1", delivery_status: "provider_accepted" } });
    await handleEmailEvent(
      evt({ type: "cf.email.sending.message.delivered", payload: { eventId: "e2", messageId: "m1", recipient: "a@b.com" } }),
      env,
    );
    const update = runs.find((r) => r.sql.includes("UPDATE email_outbox") && r.sql.includes("delivered_at"));
    expect(update).toBeTruthy();
    expect(update!.args[0]).toBe("k1");
  });

  it("deferred after delivered does nothing to email_outbox", async () => {
    const { env, runs } = fakeEnv({ outboxRow: { outbox_key: "k1", delivery_status: "delivered" } });
    await handleEmailEvent(
      evt({ type: "cf.email.sending.message.deferred", payload: { eventId: "e3", messageId: "m1", recipient: "a@b.com" } }),
      env,
    );
    const outboxUpdate = runs.find((r) => r.sql.includes("UPDATE email_outbox"));
    expect(outboxUpdate).toBeUndefined();
  });

  it("hard bounce marks the row bounced and writes a suppression", async () => {
    const { env, runs } = fakeEnv({ outboxRow: { outbox_key: "k1", delivery_status: "provider_accepted" } });
    await handleEmailEvent(
      evt({
        type: "cf.email.sending.message.bounced",
        payload: {
          eventId: "e4", messageId: "m1", recipient: "bounced@b.com", terminal: true,
          bounce: { type: "hard", reason: "mailbox does not exist" },
        },
      }),
      env,
    );
    const outboxUpdate = runs.find((r) => r.sql.includes("UPDATE email_outbox"));
    expect(outboxUpdate).toBeTruthy();
    expect(outboxUpdate!.sql).toContain("delivery_status='bounced'");
    const suppression = runs.find((r) => r.sql.includes("email_suppressions"));
    expect(suppression).toBeTruthy();
    expect(suppression!.args).toEqual(["bounced@b.com", "hard_bounce", "mailbox does not exist", expect.any(Number)]);
  });

  it("complained after delivered only records last_event but still suppresses", async () => {
    const { env, runs } = fakeEnv({ outboxRow: { outbox_key: "k1", delivery_status: "delivered" } });
    await handleEmailEvent(
      evt({
        type: "cf.email.sending.message.complained",
        payload: { eventId: "e5", messageId: "m1", recipient: "complainer@b.com" },
      }),
      env,
    );
    const outboxUpdate = runs.find((r) => r.sql.includes("UPDATE email_outbox"));
    expect(outboxUpdate).toBeTruthy();
    expect(outboxUpdate!.sql).not.toContain("delivery_status='bounced'");
    expect(outboxUpdate!.sql).toContain("last_event=?2");
    const suppression = runs.find((r) => r.sql.includes("email_suppressions"));
    expect(suppression).toBeTruthy();
    expect(suppression!.args[1]).toBe("complaint");
  });

  it("unknown messageId still writes a suppression for a hard bounce", async () => {
    const { env, runs } = fakeEnv({ outboxRow: null });
    await handleEmailEvent(
      evt({
        type: "cf.email.sending.message.bounced",
        payload: {
          eventId: "e6", messageId: "no-such-message", recipient: "ghost@b.com", terminal: true,
          bounce: { type: "hard", reason: "unknown" },
        },
      }),
      env,
    );
    const outboxUpdate = runs.find((r) => r.sql.includes("UPDATE email_outbox"));
    expect(outboxUpdate).toBeUndefined();
    const suppression = runs.find((r) => r.sql.includes("email_suppressions"));
    expect(suppression).toBeTruthy();
  });

  it("terminal SOFT bounce marks the row bounced but does not write a permanent suppression", async () => {
    const { env, runs } = fakeEnv({ outboxRow: { outbox_key: "k1", delivery_status: "provider_accepted" } });
    await handleEmailEvent(
      evt({
        type: "cf.email.sending.message.bounced",
        payload: { eventId: "e8", messageId: "m1", recipient: "full@b.com", terminal: true, bounce: { type: "soft", reason: "452 mailbox full" } },
      }),
      env,
    );
    expect(runs.find((r) => r.sql.includes("delivery_status='bounced'"))).toBeTruthy();
    expect(runs.find((r) => r.sql.includes("email_suppressions"))).toBeUndefined();
  });

  it("a complaint after a bounce does not overwrite bounced_at", async () => {
    const { env, runs } = fakeEnv({ outboxRow: { outbox_key: "k1", delivery_status: "bounced" } });
    await handleEmailEvent(
      evt({ type: "cf.email.sending.message.complained", payload: { eventId: "e9", messageId: "m1", recipient: "c@b.com" } }),
      env,
    );
    expect(runs.find((r) => r.sql.includes("UPDATE email_outbox"))).toBeUndefined();
  });

  it("releases the idempotency marker when processing fails so the queue retry re-processes", async () => {
    const { env, runs } = fakeEnv({ outboxRow: { outbox_key: "k1", delivery_status: "provider_accepted" } });
    const base = env.DB_META.prepare;
    env.DB_META.prepare = vi.fn((sql: string) => {
      const statement = base(sql);
      if (sql.startsWith("UPDATE email_outbox")) statement.run = async () => { throw new Error("D1 overloaded"); };
      return statement;
    });
    await expect(handleEmailEvent(
      evt({ type: "cf.email.sending.message.delivered", payload: { eventId: "e10", messageId: "m1", recipient: "a@b.com" } }),
      env,
    )).rejects.toThrow("D1 overloaded");
    expect(runs.find((r) => r.sql.startsWith("DELETE FROM email_events_seen"))?.args).toEqual(["e10"]);
  });

  it("malformed event (no type/eventId) makes no DB writes", async () => {
    const { env, runs } = fakeEnv();
    await handleEmailEvent({} as EmailSendingEvent, env);
    await handleEmailEvent(evt({ type: "cf.email.sending.message.unknown_kind", payload: { eventId: "e7" } }), env);
    await handleEmailEvent(evt({ type: "cf.email.sending.message.delivered", payload: {} }), env);
    expect(runs).toHaveLength(0);
  });
});
