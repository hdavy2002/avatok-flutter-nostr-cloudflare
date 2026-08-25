import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const route = () => read("src/routes/messenger_call_billing.ts");
const client = () => read("../app/lib/features/avatok/call_billing/messenger_call_billing_api.dart");
const models = () => read("../app/lib/features/avatok/call_billing/messenger_call_billing_models.dart");

describe("Messenger authorization/pricing wire contract", () => {
  it("publishes one complete pricing catalog using the Flutter decoder's rates map", () => {
    const source = route();
    const start = source.indexOf("export async function messengerCallPricing");
    const end = source.indexOf("/** GET one immutable final receipt", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const catalogStart = source.indexOf("function pricingCatalog");
    expect(catalogStart).toBeGreaterThanOrEqual(0);
    const pricing = source.slice(catalogStart, end);

    // The UI must receive all five immutable SKUs in one server-owned map;
    // it must not infer pricing by making one request per quality.
    expect(pricing).toContain("rates:");
    for (const sku of ["audio", "video_sd", "video_hd", "video_2k", "video_4k"]) {
      expect(pricing, `${sku} catalog entry`).toContain(sku);
    }
    expect(pricing).toContain("free_participant_seconds_remaining:");
    expect(pricing).toContain("price_version:");
  });

  it("keeps approved authorization nesting and strict field names aligned", () => {
    const server = route();
    const decoder = client();
    const authStart = server.indexOf("function authView");
    const authEnd = server.indexOf("async function existingAuthorization", authStart);
    expect(authStart).toBeGreaterThanOrEqual(0);
    expect(authEnd).toBeGreaterThan(authStart);
    const authView = server.slice(authStart, authEnd);
    const flattenStart = server.indexOf("function flattenAuthorization");
    const flattenEnd = server.indexOf("async function existingAuthorization", flattenStart);
    const wireAuthorization = server.slice(authStart, flattenEnd);

    // These are the names consumed by Flutter's strict authorization decoder.
    for (const field of [
      "authorization_id",
      "call_id",
      "payer",
      "provider",
      "media",
      "quality_sku",
      "status",
      "rate_centitokens_per_participant_minute",
      "price_version",
      "free_participant_seconds_remaining",
      "reserved_tokens",
      "authorization_expires_at",
    ]) {
      expect(wireAuthorization, `${field} authorization field`).toContain(field);
    }

    // The Worker returns both flattened and nested authorization fields. The
    // client explicitly unwraps the nested object, preserving compatibility
    // with the response envelope.
    const approved = decoder.slice(decoder.indexOf("response.statusCode == 200"), decoder.indexOf("final code =", decoder.indexOf("response.statusCode == 200")));
    expect(approved).toContain("_authorizationFromJson(\n        _nestedAuthorization(body),");
    expect(decoder).toContain("static Map<String, dynamic> _nestedAuthorization");
    expect(server).toContain("return { ...authorization, authorization_expires_at:");
    expect(server).toContain("authorization };");
  });

  it("requires a server-issued consent challenge and preserves it across retries", () => {
    const server = route();
    const clientSource = client();
    const authorizeStart = server.indexOf("export async function messengerCallAuthorize");
    const pricingStart = server.indexOf("/** GET pricing for the Messenger UI", authorizeStart);
    const authorize = server.slice(authorizeStart, pricingStart);

    // Retry identity is payer + attempt_id, and a pending row owns the
    // challenge. A client cannot mint a call/consent id or change its price.
    expect(authorize).toContain("existingAuthorization(env, auth.uid, parsed.attempt_id)");
    expect(authorize).toContain("if (existing)");
    expect(authorize).toContain("consentChallenge = needsConsent ? crypto.randomUUID()");
    expect(authorize).toContain("consentSource ? parsed.consent_id : null");
    expect(authorize).toContain("payer_uid: auth.uid");
    expect(authorize).toContain("consent_id: consentChallenge");

    // Video always challenges before approval; paid audio challenges only
    // after the daily allowance is exhausted and a non-zero paid rate exists.
    expect(authorize).toContain("const needsConsent = !consentSource && (parsed.media === \"video\" ||");
    expect(authorize).toContain("allowanceRemaining <= 0 && selectedPreview.rate_centitokens_per_participant_minute > 0");
    const firstChallenge = authorize.slice(authorize.indexOf("if (needsConsent)"), authorize.indexOf("return json({ approved: true", authorize.indexOf("if (needsConsent)")));
    expect(firstChallenge).toContain("approved: false");
    expect(firstChallenge).toContain("consent_id");

    // The Flutter consent result must expose the server challenge so the
    // caller can retry with the exact server challenge, including a fresh paid
    // Stream attempt after free Cloudflare audio has ended.
    const consentBranch = clientSource.slice(clientSource.indexOf("if (code == 'consent_required')"), clientSource.indexOf("return MessengerCallGateResult.refused", clientSource.indexOf("if (code == 'consent_required')")));
    expect(consentBranch).toContain("consentId:");
    expect(server).toContain("consent_id: row.consent_id");
    expect(server).toContain("consentChallenge = needsConsent ? crypto.randomUUID()");
  });

  it("keeps receipt shape, epoch normalization, settlement status, and two-seat seconds consistent", () => {
    const server = route();
    const decoder = client();
    const start = server.indexOf("export async function messengerCallReceipt");
    expect(start).toBeGreaterThanOrEqual(0);
    const receipt = server.slice(start);

    // The receipt endpoint supports both the Flutter top-level decoder and a
    // nested `receipt` object for other clients.
    expect(receipt).toContain("return json({ ...publicReceipt, receipt: publicReceipt });");
    for (const field of [
      "connected_wall_seconds",
      "participant_seconds",
      "free_participant_seconds",
      "paid_participant_seconds",
      "price_version",
      "tokens_charged",
      "ending_reason",
      "created_at",
    ]) expect(receipt, field).toContain(field);
    expect(receipt).toContain('settlement_status: "settled"');
    expect(receipt).toContain("created_at_ms");
    expect(receipt).toContain("new Date(createdAtMs).toISOString()");

    // Server-side receipt integrity is two connected seats, not one caller
    // seat. The migration is the durable constraint; the route returns both
    // values for reconciliation.
    const migration = read("migrations/2026-08-24-messenger-call-billing.sql");
    expect(migration).toContain("CHECK (participant_seconds = connected_wall_seconds * 2)");
    expect(models()).toContain("settlementStatus:");
    expect(models()).toContain("DateTime.tryParse");
  });
});
