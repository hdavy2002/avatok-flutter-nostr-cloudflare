import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueEmail } from "../src/lib/email_outbox";
import { sendEmailDurably } from "../../consumers/src/email_delivery";

type Row = {
  outbox_key: string;
  state: string;
  delivery_status: string;
  attempts: number;
  max_attempts: number;
  lease_expires_at: number | null;
  next_attempt_at: number | null;
  provider_message_id: string | null;
  queue_accepted_at: number | null;
};

/** Small D1-shaped state machine: enough SQL semantics to exercise the
 * production CAS predicates, including two consumers racing the same row. */
class EmailDb {
  row: Row | null;
  readonly raceClaims: boolean;

  constructor(row: Row | null = null, raceClaims = false) {
    this.row = row;
    this.raceClaims = raceClaims;
  }

  prepare(sql: string) {
    const db = this;
    let args: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        args = values;
        return statement;
      },
      async first() {
        if (!sql.includes("SELECT state")) return null;
        if (!db.row) return null;
        return { ...db.row };
      },
      async run() {
        return await db.run(sql, args);
      },
    };
    return statement;
  }

  private async run(sql: string, args: unknown[]): Promise<{ meta: { changes: number } }> {
    if (sql.includes("INSERT OR IGNORE INTO email_outbox")) {
      if (this.row) return { meta: { changes: 0 } };
      this.row = {
        outbox_key: String(args[0]), state: "pending", delivery_status: "queued", attempts: 0,
        max_attempts: Number(args[6] ?? 5), lease_expires_at: null, next_attempt_at: Number(args[7]),
        provider_message_id: null, queue_accepted_at: null,
      };
      return { meta: { changes: 1 } };
    }
    if (!this.row) return { meta: { changes: 0 } };
    if (sql.includes("state='sending',delivery_status='sending'")) {
      // Let both callers yield after reading attempts=0; only one may then win.
      if (this.raceClaims) await Promise.resolve();
      const expectedAttempts = Number(args[3]);
      if (!(this.row.delivery_status === "queued" || this.row.delivery_status === "failed")
        || this.row.attempts !== expectedAttempts || this.row.attempts >= this.row.max_attempts) {
        return { meta: { changes: 0 } };
      }
      this.row.state = "sending";
      this.row.delivery_status = "sending";
      this.row.attempts++;
      this.row.lease_expires_at = Number(args[1]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("state='failed',delivery_status='failed'")) {
      const attempts = Number(args[2]);
      if (this.row.delivery_status !== "sending" || this.row.attempts !== attempts) return { meta: { changes: 0 } };
      this.row.state = "failed";
      this.row.delivery_status = "failed";
      this.row.next_attempt_at = args[3] == null ? null : Number(args[3]);
      this.row.lease_expires_at = null;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("state='sent',delivery_status='provider_accepted'")) {
      const attempts = Number(args[3]);
      if (this.row.delivery_status !== "sending" || this.row.attempts !== attempts) return { meta: { changes: 0 } };
      this.row.state = "sent";
      this.row.delivery_status = "provider_accepted";
      this.row.provider_message_id = args[2] == null ? null : String(args[2]);
      this.row.lease_expires_at = null;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("queue_accepted_at")) {
      this.row.queue_accepted_at = Number(args[1]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("lease_expires_at=NULL")) {
      return { meta: { changes: 0 } };
    }
    return { meta: { changes: 1 } };
  }
}

function queuedRow(key: string): Row {
  return {
    outbox_key: key, state: "pending", delivery_status: "queued", attempts: 0, max_attempts: 5,
    lease_expires_at: null, next_attempt_at: Date.now(), provider_message_id: null, queue_accepted_at: null,
  };
}

function consumerEnv(db: EmailDb) {
  return { DB_META: db, BREVO_API_KEY: "test-key" } as any;
}

describe("commercial email delivery behavior", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("allows one CAS winner when two consumers claim the same queued row", async () => {
    const db = new EmailDb(queuedRow("mail:race"), true);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "brevo-race" }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await Promise.all([
      sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ok</p>", outboxKey: "mail:race" }, consumerEnv(db)),
      sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ok</p>", outboxKey: "mail:race" }, consumerEnv(db)),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(db.row?.attempts).toBe(1);
    expect(db.row?.delivery_status).toBe("provider_accepted");
  });

  it("stops transient retries at max_attempts and keeps provider acceptance separate", async () => {
    const db = new EmailDb(queuedRow("mail:retry"));
    const fetch = vi.fn(async () => ({ ok: false, status: 503, text: async () => "gateway unavailable" }));
    vi.stubGlobal("fetch", fetch);
    for (let i = 0; i < 6; i++) {
      try {
        await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ok</p>", outboxKey: "mail:retry" }, consumerEnv(db));
      } catch { /* transient queue retries are expected through attempt four */ }
    }
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(db.row?.attempts).toBe(5);
    expect(db.row?.delivery_status).toBe("failed");
    expect(db.row?.provider_message_id).toBeNull();
  });

  it("reports queue acceptance while delivery remains queued", async () => {
    const db = new EmailDb();
    const send = vi.fn(async () => undefined);
    const result = await enqueueEmail({ DB_META: db, Q_EMAIL: { send } } as any, {
      to: "buyer@example.test", subject: "Confirmation", html: "<p>ok</p>",
      outboxKey: "commercial-email:order-1:buyer-1:v1", orderId: "order-1", recipientId: "buyer-1",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ queued: true, status: "queued", durable: true });
    expect(db.row?.delivery_status).toBe("queued");
    expect(db.row?.provider_message_id).toBeNull();
  });
});
