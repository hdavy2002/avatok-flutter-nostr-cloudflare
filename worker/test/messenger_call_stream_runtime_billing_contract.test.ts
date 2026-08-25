import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BILLING = readFileSync("src/routes/messenger_call_billing.ts", "utf8");
const STREAM_ROUTE = readFileSync("src/routes/stream_video_calls.ts", "utf8");
const INDEX = readFileSync("src/index.ts", "utf8");
const DO = readFileSync("src/do/messenger_call_billing.ts", "utf8");
const STREAM_SERVICE = readFileSync("../app/lib/streamlane/stream_call_service.dart", "utf8");
const STREAM_SCREEN = readFileSync("../app/lib/streamlane/stream_call_screen.dart", "utf8");
const BILLING_API = readFileSync("../app/lib/features/avatok/call_billing/messenger_call_billing_api.dart", "utf8");
const BILLING_MODELS = readFileSync("../app/lib/features/avatok/call_billing/messenger_call_billing_models.dart", "utf8");
const STATUS_FN = BILLING.includes("export async function messengerCallBillingStatus")
  ? "export async function messengerCallBillingStatus"
  : "export async function messengerCallStatus";

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error(`source boundary not found: ${startMarker}`);
  return source.slice(start, end);
}

describe("Stream paid-call runtime billing authority", () => {
  it("does not transfer stale, expired, or repriced consent", () => {
    const authorize = section(BILLING, "export async function messengerCallAuthorize", "/** GET pricing for the Messenger UI");
    expect(authorize).toContain("authorizationByConsent");
    expect(authorize).toContain("consentCandidate.status === \"pending_consent\"");
    expect(authorize).toContain("consentCandidate.expires_at > consentNow");
    expect(authorize).toContain("consentCandidate.provider === selectedPreview.provider");
    expect(authorize).toContain("consentCandidate.rate_centitokens_per_participant_minute === selectedPreview.rate_centitokens_per_participant_minute");
    expect(authorize).toContain("consentCandidate.price_version === selectedPreview.price_version");
    expect(authorize).toContain('selectedPreview.provider === "stream"');
    expect(authorize).toContain("selectedPreview.rate_centitokens_per_participant_minute > 0");
    // A valid fresh paid attempt supersedes the old pending challenge; an
    // invalid challenge cannot inherit its call id, reservation, or terms.
    expect(authorize).toContain("superseded_by_fresh_paid_attempt");
    expect(authorize).toMatch(/const authorizationId = crypto\.randomUUID\(\);[\s\S]{0,120}const callId = crypto\.randomUUID\(\);/);
  });

  it("exposes authenticated runtime billing status and wires it into dispatch", () => {
    // Runtime state is not the immutable authorization and cannot be inferred
    // from Stream SDK state. It must be a separately authenticated Worker read.
    expect(BILLING).toContain(STATUS_FN);
    expect(INDEX).toContain("/api/messenger-calls/status");
    const status = section(BILLING, STATUS_FN, "/** GET one immutable final receipt");
    expect(status).toContain("requireUser(req, env)");
    for (const field of [
      "free_participant_seconds_remaining",
      "paid_runway_wall_seconds",
      "low_balance",
      "renewal_failed",
      "exhausted",
      "end_reason",
    ]) expect(status, field).toContain(field);
  });

  it("scopes status and receipts to the authenticated participant and rejects strangers", () => {
    const status = section(BILLING, STATUS_FN, "/** GET one immutable final receipt");
    expect(status).toMatch(/payer_uid=\?\d+\s+OR\s+callee_uid=\?\d+/i);
    expect(status).toContain("auth.uid");
    const receipt = section(BILLING, "export async function messengerCallReceipt", "/**");
    expect(receipt).toContain("payer_uid=?2");
    expect(receipt).toContain("auth.uid");
    // The receipt existence probe may use the already-authorized id internally,
    // but it is reached only after the participant-scoped D1 lookup above.
  });

  it("connects Stream placement/webhooks to the billing DO and terminal receipt", () => {
    const place = section(STREAM_ROUTE, "export async function streamCallPlace", "/**\n * POST /api/stream-calls/cancel");
    expect(place).toContain("initializeMessengerCallBilling");
    expect(place).toContain('provider: "stream"');
    expect(place).toContain("rate_centitokens_per_participant_minute");
    expect(STREAM_ROUTE).toContain("forwardMessengerStreamEventByCall");
    expect(STREAM_ROUTE).toContain("billingEvent");
    expect(DO).toContain("billing_low_balance");
    expect(DO).toContain("billing_renewal_failed");
    expect(DO).toContain("billing_exhausted");
    expect(DO).toContain("finalizeInternal");
    expect(BILLING).toContain("messenger_call_receipts");
  });

  it("polls runtime state only while the Stream call is alive and stops on teardown", () => {
    expect(BILLING_API).toContain("fetchRuntimeState");
    expect(STREAM_SCREEN).toMatch(/Timer\??\s+_billing(?:Status|Runtime)Timer/);
    expect(STREAM_SCREEN).toMatch(/Timer\.periodic\([\s\S]{0,500}fetchRuntimeState/);
    expect(STREAM_SCREEN).toMatch(/dispose\(\)[\s\S]{0,1400}_billing(?:Status|Runtime)Timer\?\.cancel\(\)/);
    // Receipt polling must also be bounded and cannot restart after terminal
    // teardown; the API must never treat a missing receipt as authorization.
    expect(BILLING_API).toContain("fetchReceipt");
    expect(BILLING_API).toContain("if (response.statusCode != 200) return null");
  });

  it("keeps provider/rate/duration authority on the server", () => {
    const placeRequest = section(STREAM_SERVICE, "Future<StreamPlaceDecision> authorizePlace", "/// Per-call state subscriptions");
    expect(placeRequest).toContain("authorization_id");
    expect(placeRequest).toContain("quality_sku");
    expect(placeRequest).toContain("price_version");
    expect(placeRequest).not.toMatch(/'rate(?:_centitokens)?'\s*:/);
    expect(placeRequest).not.toMatch(/'duration(?:_seconds|_s)?'\s*:/);
    expect(placeRequest).not.toMatch(/'tokens(?:_charged|_per_minute)?'\s*:/);
    expect(STREAM_ROUTE).toContain("billingAuthorization.rate_centitokens_per_participant_minute");
    expect(STREAM_ROUTE).toContain("billingAuthorization.price_version");
    expect(BILLING_MODELS).toContain("class MessengerCallBillingRuntimeState");
  });
});
