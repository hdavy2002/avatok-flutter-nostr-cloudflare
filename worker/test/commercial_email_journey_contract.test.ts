import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const checkout = readFileSync(resolve(root, "src/routes/commercial_checkout.ts"), "utf8");
const emails = readFileSync(resolve(root, "src/cal/emails.ts"), "utf8");
const outbox = readFileSync(resolve(root, "src/lib/email_outbox.ts"), "utf8");
const migration = readFileSync(resolve(root, "migrations/2026-09-09-commercial-email-delivery.sql"), "utf8");

describe("JOURNEY-04 commercial confirmation contract", () => {
  it("uses stable order/recipient/version keys and exact canonical destinations", () => {
    expect(outbox).toContain("commercialEmailKey(orderId: string, recipientId");
    expect(emails).toContain("/live");
    expect(emails).toContain("/session");
    expect(emails).toContain("icsB64(buildIcs");
    expect(emails).toContain("verified: true");
  });

  it("queues after entitlement authority and exposes honest resend status", () => {
    expect(checkout).toContain("queueCommercialConfirmation");
    expect(checkout).toContain("Entitlements and order authority are already committed");
    expect(checkout).toContain("resendCommercialConfirmation");
    expect(checkout).toContain("delivery_status");
    expect(checkout).toContain("rateLimit(env, `commercial-email-resend:");
    expect(checkout).toContain("WHERE o.id=?1 AND o.buyer_id=?2");
    expect(checkout).toContain("active entitlement");
    expect(checkout).toContain("recoverCommercialConfirmation(env, orderId, auth.uid)");
  });

  it("adds the base table defensively and retains provider uncertainty", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS email_outbox");
    expect(migration).toContain("delivery_status TEXT NOT NULL DEFAULT 'queued'");
    expect(migration).toContain("provider_accepted");
    expect(migration).toContain("WHEN state='sent' AND kind='brevo_send'");
    expect(outbox).toContain("provider_accepted");
    expect(outbox).toContain("recoverEmailOutbox");
  });
});
