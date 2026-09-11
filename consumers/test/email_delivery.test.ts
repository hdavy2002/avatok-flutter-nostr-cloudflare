import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmailDurably } from "../src/email_delivery";

function fakeEnv() {
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: (..._args: unknown[]) => statement,
      first: async () => sql.includes("SELECT state") ? null : null,
      run: async () => ({ meta: { changes: 1 } }),
    };
    return statement;
  });
  return { DB_META: { prepare }, BREVO_API_KEY: "test-key", EMAIL_PROVIDER: "brevo" } as any;
}

/** Builds an env for the cloudflare_then_brevo policy and records every bound UPDATE/INSERT call. */
function trackingCfEnv(overrides: Record<string, unknown> = {}) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const prepare = vi.fn((sql: string) => {
    let boundArgs: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => { boundArgs = args; return statement; },
      first: async () => null,
      run: async () => {
        calls.push({ sql, args: boundArgs });
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  });
  const env = {
    DB_META: { prepare },
    EMAIL_PROVIDER: "cloudflare_then_brevo",
    BREVO_API_KEY: "test-key",
    EMAIL: { send: vi.fn() },
    ...overrides,
  } as any;
  return { env, calls };
}

describe("durable Brevo email delivery", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("claims a durable row and records provider acceptance without calling text twice", async () => {
    const env = fakeEnv();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "<brevo-1>" }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({
      to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>",
      outboxKey: "commercial-email:order-1:buyer-1:commercial-confirmation.v1",
      orderId: "order-1", recipientId: "buyer-1", messageVersion: "commercial-confirmation.v1",
    }, env);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).to).toEqual([{ email: "buyer@example.test" }]);
    expect(env.DB_META.prepare).toHaveBeenCalledWith(expect.stringContaining("provider_message_id"));
  });

  it("leaves provider errors failed and retries only transient responses", async () => {
    const env = fakeEnv();
    const body = vi.fn(async () => "gateway unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: body })));
    await expect(sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:test" }, env)).rejects.toThrow("email send failed: Brevo 503");
    expect(body).toHaveBeenCalledOnce();
  });

  it("does not call Brevo when the durable claim is lost", async () => {
    const prepare = vi.fn((sql: string) => {
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: async () => null,
        run: async () => ({ meta: { changes: sql.includes("state='sending'") ? 0 : 1 } }),
      };
      return statement;
    });
    const env = { DB_META: { prepare }, BREVO_API_KEY: "test-key", EMAIL_PROVIDER: "brevo" } as any;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:race" }, env);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces claim loss and bounced terminal state to strict cron callers", async () => {
    const claimEnv = fakeEnv();
    const claimFetch = vi.fn();
    vi.stubGlobal("fetch", claimFetch);
    const claimPrepare = (claimEnv.DB_META.prepare as ReturnType<typeof vi.fn>);
    claimPrepare.mockImplementation((sql: string) => {
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: async () => sql.includes("SELECT state") ? { state: "pending", delivery_status: "queued", attempts: 0, max_attempts: 5, next_attempt_at: Date.now() } : null,
        run: async () => ({ meta: { changes: sql.includes("state='sending'") ? 0 : 1 } }),
      };
      return statement;
    });
    await expect(sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:strict-claim" }, claimEnv, { throwOnPermanent: true })).rejects.toThrow("claim unavailable");
    expect(claimFetch).not.toHaveBeenCalled();

    const bouncedEnv = fakeEnv();
    (bouncedEnv.DB_META.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: async () => sql.includes("SELECT state") ? { state: "failed", delivery_status: "bounced", attempts: 1, max_attempts: 5, next_attempt_at: null } : null,
        run: async () => ({ meta: { changes: 1 } }),
      };
      return statement;
    });
    await expect(sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:strict-bounce" }, bouncedEnv, { throwOnPermanent: true })).rejects.toThrow("bounced");
  });

  it("surfaces the final transport failure after the retry budget", async () => {
    const env = fakeEnv();
    (env.DB_META.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: async () => sql.includes("SELECT state") ? { state: "failed", delivery_status: "failed", attempts: 4, max_attempts: 5, next_attempt_at: Date.now() } : null,
        run: async () => ({ meta: { changes: 1 } }),
      };
      return statement;
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:strict-final" }, env, { throwOnPermanent: true })).rejects.toThrow("retry budget exhausted");
  });

  it("does not leave an expired exhausted lease in sending", async () => {
    const env = fakeEnv();
    const statements: string[] = [];
    (env.DB_META.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      statements.push(sql);
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: async () => sql.includes("SELECT state") ? { state: "failed", delivery_status: "failed", attempts: 5, max_attempts: 5, next_attempt_at: null } : null,
        run: async () => ({ meta: { changes: sql.includes("retry budget exhausted") ? 1 : 0 } }),
      };
      return statement;
    });
    await expect(sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:expired" }, env, { throwOnPermanent: true })).rejects.toThrow("claim unavailable");
    expect(statements.some((sql) => sql.includes("retry budget exhausted"))).toBe(true);
  });

  it("acks a redelivered accepted attempt without sending again", async () => {
    const prepare = vi.fn((sql: string) => {
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: async () => sql.includes("SELECT state")
          ? { state: "sent", delivery_status: "provider_accepted", attempts: 1, max_attempts: 5 }
          : null,
        run: async () => ({ meta: { changes: 1 } }),
      };
      return statement;
    });
    const env = { DB_META: { prepare }, BREVO_API_KEY: "test-key", EMAIL_PROVIDER: "brevo" } as any;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:resend" }, env);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("cloudflare_then_brevo policy (email_provider.ts sendWithPolicy)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends via Cloudflare and records provider/messageId without calling Brevo", async () => {
    const { env, calls } = trackingCfEnv();
    (env.EMAIL.send as ReturnType<typeof vi.fn>).mockResolvedValue({ messageId: "cf-msg-1" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:cf-ok" }, env);
    expect(fetch).not.toHaveBeenCalled();
    expect(env.EMAIL.send).toHaveBeenCalledOnce();
    const accepted = calls.find((c) => c.sql.includes("provider_message_id"));
    expect(accepted).toBeDefined();
    // .bind(key, Date.now(), messageId, attempts, provider, fallback_used)
    expect(accepted!.args[2]).toBe("cf-msg-1");
    expect(accepted!.args[4]).toBe("cloudflare");
    expect(accepted!.args[5]).toBe(0);
  });

  it("falls back to Brevo when Cloudflare returns a retryable error", async () => {
    const { env, calls } = trackingCfEnv();
    (env.EMAIL.send as ReturnType<typeof vi.fn>).mockRejectedValue({ code: "E_RATE_LIMIT_EXCEEDED", message: "rate limited" });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "<brevo-fallback-1>" }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:cf-fallback" }, env);
    expect(env.EMAIL.send).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const accepted = calls.find((c) => c.sql.includes("provider_message_id"));
    expect(accepted).toBeDefined();
    expect(accepted!.args[4]).toBe("brevo");
    expect(accepted!.args[5]).toBe(1);
  });

  it("marks a Cloudflare-suppressed recipient bounced without calling Brevo, honoring throwOnPermanent", async () => {
    const { env, calls } = trackingCfEnv();
    (env.EMAIL.send as ReturnType<typeof vi.fn>).mockRejectedValue({ code: "E_RECIPIENT_SUPPRESSED", message: "suppressed" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:cf-suppressed" }, env);
    expect(fetch).not.toHaveBeenCalled();
    const bounced = calls.find((c) => c.sql.includes("delivery_status='bounced'"));
    expect(bounced).toBeDefined();

    const { env: strictEnv } = trackingCfEnv();
    (strictEnv.EMAIL.send as ReturnType<typeof vi.fn>).mockRejectedValue({ code: "E_RECIPIENT_SUPPRESSED", message: "suppressed" });
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:cf-suppressed-strict" }, strictEnv, { throwOnPermanent: true }),
    ).rejects.toThrow("email delivery bounced");
  });

  it("does not fall back to Brevo on a non-retryable Cloudflare validation error", async () => {
    const { env, calls } = trackingCfEnv();
    (env.EMAIL.send as ReturnType<typeof vi.fn>).mockRejectedValue({ code: "E_VALIDATION_ERROR", message: "bad payload" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:cf-validation" }, env);
    expect(fetch).not.toHaveBeenCalled();
    const failed = calls.find((c) => c.sql.includes("SET state='failed',delivery_status='failed',error_message=?2"));
    expect(failed).toBeDefined();
  });

  it("records a failure mentioning \"not configured\" when neither provider is configured", async () => {
    const { env, calls } = trackingCfEnv({ BREVO_API_KEY: undefined, EMAIL: undefined });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:cf-none-configured" }, env);
    expect(fetch).not.toHaveBeenCalled();
    const failed = calls.find((c) => c.sql.includes("SET state='failed',delivery_status='failed',error_message=?2"));
    expect(failed).toBeDefined();
    expect(String(failed!.args[1])).toMatch(/not configured/i);
  });

  it("falls back to Brevo on an unrecognised Cloudflare error (fail-open, not a permanent drop)", async () => {
    const { env, calls } = trackingCfEnv();
    (env.EMAIL.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("binding exploded"));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "<brevo-2>" }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:cf-unknown" }, env);
    expect(fetch).toHaveBeenCalledOnce();
    expect(calls.find((c) => c.sql.includes("provider_message_id"))!.args[4]).toBe("brevo");
  });

  it("never falls back to Brevo for a staging allowlist rejection", async () => {
    const { env } = trackingCfEnv();
    (env.EMAIL.send as ReturnType<typeof vi.fn>).mockRejectedValue({ code: "E_RECIPIENT_NOT_ALLOWED", message: "not allowed" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "real-user@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:cf-allowlist" }, env);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not call either provider for a locally suppressed recipient", async () => {
    const { env, calls } = trackingCfEnv();
    const base = env.DB_META.prepare;
    env.DB_META.prepare = vi.fn((sql: string) => {
      const statement = base(sql);
      if (sql.includes("email_suppressions")) statement.first = async () => ({ 1: 1 });
      return statement;
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "Dead@Example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:local-suppressed" }, env);
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(calls.find((c) => c.sql.includes("delivery_status='bounced'"))).toBeDefined();
  });

  it("records acceptance with legacy columns if the provider columns are missing (no re-send via lease expiry)", async () => {
    const { env, calls } = trackingCfEnv();
    const base = env.DB_META.prepare;
    env.DB_META.prepare = vi.fn((sql: string) => {
      const statement = base(sql);
      if (sql.includes("fallback_used=?6")) statement.run = async () => { throw new Error("D1_ERROR: no such column: provider"); };
      return statement;
    });
    (env.EMAIL.send as ReturnType<typeof vi.fn>).mockResolvedValue({ messageId: "cf-msg-legacy" });
    vi.stubGlobal("fetch", vi.fn());
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:cf-legacy" }, env);
    const accepted = calls.find((c) => c.sql.includes("provider_accepted"));
    expect(accepted).toBeDefined();
    expect(accepted!.sql).not.toContain("fallback_used");
    expect(accepted!.args[2]).toBe("cf-msg-legacy");
  });

  it("maps ICS attachments to the Cloudflare shape without a contradicting method param", async () => {
    const { env } = trackingCfEnv();
    (env.EMAIL.send as ReturnType<typeof vi.fn>).mockResolvedValue({ messageId: "cf-ics" });
    vi.stubGlobal("fetch", vi.fn());
    await sendEmailDurably({
      to: "buyer@example.test", subject: "Cancelled", html: "<p>x</p>", outboxKey: "mail:cf-ics",
      attachments: [{ name: "cancel.ics", content: "QkVHSU4=" }],
    }, env);
    const payload = (env.EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.attachments).toEqual([{ filename: "cancel.ics", content: "QkVHSU4=", type: "text/calendar", disposition: "attachment" }]);
  });
});
