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
  return { DB_META: { prepare }, BREVO_API_KEY: "test-key" } as any;
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
    await expect(sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:test" }, env)).rejects.toThrow("Brevo send failed: 503");
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
    const env = { DB_META: { prepare }, BREVO_API_KEY: "test-key" } as any;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:race" }, env);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restarts an accepted row only for an explicit resend", async () => {
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
    const env = { DB_META: { prepare }, BREVO_API_KEY: "test-key" } as any;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "<brevo-resend>" }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await sendEmailDurably({ to: "buyer@example.test", subject: "Confirmation", html: "<p>ready</p>", outboxKey: "mail:resend", force: true }, env);
    expect(fetch).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("delivery_status IN ('provider_accepted','delivered')"));
  });
});
