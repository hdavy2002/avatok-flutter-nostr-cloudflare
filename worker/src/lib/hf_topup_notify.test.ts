// @ts-nocheck -- uses node:sqlite via the shim
// [HF-TOPUP-NOTIFY-1] WhatsApp + email receipt after a Google Play top-up (rulebook HF-PAY-20).
import { describe, it, expect, beforeEach, vi } from "vitest";

const sent = vi.hoisted(() => ({ wa: [] as any[], mail: [] as any[], events: [] as any[], waResult: { ok: true } as any, phone: "+919876543210" as string | null, email: "buyer@example.com" as string | null, mailStatus: "queued" }));
vi.mock("./whatsapp_send", () => ({ sendWhatsAppText: async (_e: any, to: string, text: string) => { sent.wa.push({ to, text }); return sent.waResult; } }));
vi.mock("./whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => sent.phone }));
vi.mock("./email_outbox", () => ({ enqueueEmail: async (_e: any, m: any) => { sent.mail.push(m); return { outboxKey: m.outboxKey, status: sent.mailStatus, queued: true, durable: true }; } }));
vi.mock("./identity", () => ({ emailFor: async () => sent.email }));
vi.mock("../hooks", () => ({ trackUser: async (_e: any, uid: string, email: any, event: string, _a: any, props: any) => { sent.events.push({ uid, email, event, ...props }); }, trackException: async () => {} }));

import { makeDb } from "./hf_token_d1_shim";
import { creditLot } from "./hf_token_ledger";
import { MICRO } from "./hf_token_math";
import { notifyTopupCredited, topupWhatsAppText, topupEmailHtml, rupeesText } from "./hf_topup_notify";

let env: any;
const notice = { uid: "u1", orderId: "GPA.1234-5678", paidPaise: 12000, creditPaise: 10200, receiptNumber: "HF/R/2026-27/12", at: Date.UTC(2026, 9, 11, 6, 0) };

beforeEach(async () => {
  env = { DB_META: makeDb(["2026-10-10-hf-tokens.sql"]) };
  sent.wa.length = 0; sent.mail.length = 0; sent.events.length = 0;
  sent.waResult = { ok: true }; sent.phone = "+919876543210"; sent.email = "buyer@example.com"; sent.mailStatus = "queued";
  await creditLot(env, "u1", { kind: "purchase", pricingVersion: "gp-r1", valuePaisePerToken: 100, micro: 102 * MICRO, paidPaise: 12000, provider: "google_play", providerRef: "GPA.1234-5678" }, "hfplay:GPA.1234-5678");
});

describe("texts", () => {
  it("rupees are whole when whole, two decimals otherwise", () => {
    expect(rupeesText(12000)).toBe("₹120");
    expect(rupeesText(14720)).toBe("₹147.20");
    expect(rupeesText(102000)).toBe("₹1,020");
  });
  it("WhatsApp says what was added, what was paid with GST, the order and the balance", () => {
    const t = topupWhatsAppText(notice, 10200);
    expect(t).toContain("₹102 has been added to your wallet");
    expect(t).toContain("You paid ₹120 (includes 18% GST) via Google Play");
    expect(t).toContain("GPA.1234-5678");
    expect(t).toContain("balance is now ₹102");
  });
  it("email is a branded payment receipt, not a tax invoice, with no GSTIN", () => {
    const h = topupEmailHtml(notice, 10200);
    expect(h).toContain("Hello Fraands");
    expect(h).toContain("Payment receipt");
    expect(h).toContain("HF/R/2026-27/12");
    expect(h).toContain("Amount paid (includes 18% GST)");
    expect(h).toContain("₹120");
    expect(h).toContain("₹102 added to your wallet");
    expect(h).toContain("not a tax invoice");
    expect(h).not.toMatch(/GSTIN/);
    expect(h).not.toMatch(/<script/i);
  });
});

describe("notifyTopupCredited", () => {
  it("sends one WhatsApp to the verified number and queues one email keyed by the order", async () => {
    const r = await notifyTopupCredited(env, notice);
    expect(r).toMatchObject({ whatsapp: "sent", email: "queued" });
    expect(sent.wa).toHaveLength(1);
    expect(sent.wa[0].to).toBe("+919876543210");
    expect(sent.wa[0].text).toContain("balance is now ₹102");
    expect(sent.mail).toHaveLength(1);
    expect(sent.mail[0]).toMatchObject({ to: "buyer@example.com", outboxKey: "hf-topup:GPA.1234-5678", kind: "hf_topup_receipt" });
    const wa = sent.events.find((e) => e.event === "hf_topup_whatsapp_receipt");
    const em = sent.events.find((e) => e.event === "hf_topup_email_receipt");
    expect(wa).toMatchObject({ result: "sent", email: "buyer@example.com", order_id: "GPA.1234-5678" });
    expect(em).toMatchObject({ result: "queued" });
  });

  it("no verified WhatsApp number: skips WhatsApp, still emails", async () => {
    sent.phone = null;
    const r = await notifyTopupCredited(env, notice);
    expect(r).toMatchObject({ whatsapp: "skipped", whatsappReason: "no_verified_whatsapp", email: "queued" });
    expect(sent.wa).toHaveLength(0);
    expect(sent.mail).toHaveLength(1);
  });

  it("no email on the account: skips email, still sends WhatsApp", async () => {
    sent.email = null;
    const r = await notifyTopupCredited(env, notice);
    expect(r).toMatchObject({ whatsapp: "sent", email: "skipped", emailReason: "no_email" });
    expect(sent.mail).toHaveLength(0);
  });

  it("a provider error is reported as failed and never throws", async () => {
    sent.waResult = { ok: false, reason: "provider_error" };
    sent.mailStatus = "failed";
    const r = await notifyTopupCredited(env, notice);
    expect(r).toMatchObject({ whatsapp: "failed", whatsappReason: "provider_error", email: "failed" });
  });
});
