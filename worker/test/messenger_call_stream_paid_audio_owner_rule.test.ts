import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BILLING = readFileSync("src/routes/messenger_call_billing.ts", "utf8");
const POLICY = readFileSync("src/lib/messenger_call_billing.ts", "utf8");
const DO = readFileSync("src/do/messenger_call_billing.ts", "utf8");
const WALLET = readFileSync("src/do/wallet.ts", "utf8");
const STREAM = readFileSync("src/routes/stream_video_calls.ts", "utf8");
const PLACE = readFileSync("../app/lib/features/avatok/place_1to1_call.dart", "utf8");
const CONSENT = readFileSync("../app/lib/features/avatok/call_billing/messenger_call_consent_sheets.dart", "utf8");
const FLUTTER_API = readFileSync("../app/lib/features/avatok/call_billing/messenger_call_billing_api.dart", "utf8");
const CALL_SCREEN = readFileSync("../app/lib/features/avatok/call_screen.dart", "utf8");

function method(source: string, signature: string, endMarker: string): string {
  const start = source.indexOf(signature);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error(`source boundary not found: ${signature}`);
  return source.slice(start, end);
}

describe("Owner rule: paid Messenger calls use GetStream", () => {
  it("keeps Cloudflare Messenger audio free-only and routes paid audio to Stream", () => {
    // A provider helper that maps every audio call to Cloudflare is unsafe once
    // the daily allowance is exhausted. Paid continuation needs a distinct
    // Stream provider decision; Cloudflare must not receive paid audio terms.
    expect(POLICY).toContain('media === "audio" && freeAudio ? "cloudflare" : "stream"');

    const authorize = method(BILLING, "export async function messengerCallAuthorize", "export async function messengerCallPricing");
    expect(authorize).toContain("provider: selectedPreview.provider");
    expect(BILLING).toContain("freeParticipantSecondsRemaining");
    expect(BILLING).toContain("freeAudio ? 0 : rate.rateCentitokensPerParticipantMinute");
    expect(BILLING).toContain("authorizationByConsent");
    expect(BILLING).toContain("superseded_by_fresh_paid_attempt");
    expect(BILLING).toContain("consentCandidate.expires_at > consentNow");
    expect(BILLING).toContain("consentCandidate.provider === selectedPreview.provider");
    expect(BILLING).toContain("consentCandidate.rate_centitokens_per_participant_minute === selectedPreview.rate_centitokens_per_participant_minute");
    expect(BILLING).toContain("consentCandidate.price_version === selectedPreview.price_version");
  });

  it("does not reserve or renew paid time on the Cloudflare audio lane", () => {
    const renewal = method(DO, "private async ensureReservationRunway", "  private async handleRenewalFailure");
    const meter = method(DO, "private async meterAt", "  private async appendLedger");

    // Free Cloudflare audio has no paid reservation lifecycle. Renewal and
    // paid debit must be restricted to the Stream paid lane.
    expect(renewal).toMatch(/provider[^\n]*stream|row\.provider\s*!==\s*["']stream["']/i);
    expect(meter).toMatch(/provider[^\n]*stream|row\.provider\s*!==\s*["']stream["']/i);
  });

  it("ends and settles Cloudflare audio at allowance exhaustion without paid seconds", () => {
    const meter = method(DO, "private async meterAt", "  private async appendLedger");
    // WalletDO owns the zero-rate boundary: it records only the accepted free
    // prefix, returns a disconnect for the denied suffix, and never computes
    // paid tokens for a Cloudflare audio authorization.
    expect(WALLET).toMatch(/media === "audio" && rate === 0/);
    const freeBranch = WALLET.slice(WALLET.indexOf('media === "audio" && rate === 0'), WALLET.indexOf("let math", WALLET.indexOf('media === "audio" && rate === 0')));
    expect(freeBranch).toContain("paid_participant_seconds_denied");
    expect(freeBranch).toContain("free_allowance_exhausted");
    expect(freeBranch).toContain("tokens_charged: 0");

    // The DO must persist the accepted prefix before confirmed provider
    // teardown and final receipt settlement.
    expect(meter).toContain("persistDeniedFreeTick");
    expect(meter).toContain("providerEnded");
    expect(meter).toContain("finalizeInternal");
  });

  it("creates a fresh Stream authorization/call attempt for paid-audio consent", () => {
    const start = PLACE.indexOf("if (!video && result.status == MessengerCallGateStatus.consentRequired)");
    const end = PLACE.indexOf("if (video && result.status == MessengerCallGateStatus.consentRequired)", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const audioConsent = PLACE.slice(start, end);

    // Paid continuation is a new Stream call, not an in-place provider switch
    // on the terminal Cloudflare authorization. It must use a fresh attempt
    // identity/call authorization while still proving the server challenge.
    expect(audioConsent).toContain("consentId");
    expect(audioConsent).toMatch(/newAttemptId\(\)|new.*attempt/i);
    expect(audioConsent).not.toContain("attemptId: attemptId");
  });

  it("allows Stream placement for an authorized paid-audio continuation with exact D1 binding", () => {
    const place = method(STREAM, "export async function streamCallPlace", "/**\n * POST /api/stream-calls/cancel");
    // Paid audio is a Stream lane after the free allowance, so this route must
    // validate the frozen row rather than reject all Messenger audio or use a
    // legacy Cloudflare fallback.
    expect(place).not.toContain("Audio calls use the Cloudflare call lane");
    expect(place).toMatch(/media[^\n]*audio[\s\S]{0,1400}provider[^\n]*stream|provider[^\n]*stream[\s\S]{0,1400}media[^\n]*audio/i);
    expect(place).toMatch(/attempt_id[\s\S]{0,1200}payer_uid[\s\S]{0,1200}callee_uid[\s\S]{0,1200}price_version/);
  });

  it("does not silently migrate or reuse a Cloudflare room for paid audio", () => {
    const route = PLACE.slice(PLACE.indexOf("Future<bool> routeToStreamCallIfEnabled"), PLACE.indexOf("Future<MessengerCallAuthorization?> prepareMessengerBillingAuthorization"));
    expect(route).not.toContain("if (!video && billingAuthorization != null) return false");
    expect(route).toMatch(/billingAuthorization[^\n]*(?:provider|stream)/i);
    expect(route).toMatch(/StreamCallService\.instance\.place1to1Staged/);
  });

  it("keeps paid video on Stream with quality SKU enforcement", () => {
    const place = method(STREAM, "export async function streamCallPlace", "/**\n * POST /api/stream-calls/cancel");
    expect(place).toContain("messengerBillingVideo");
    expect(place).toContain('billingAuthorization.provider !== "stream"');
    expect(place).toMatch(/video_sd|video_hd|video_2k|video_4k/);
  });

  it("preserves the legacy lane when the Messenger billing master is dark", () => {
    const place = method(STREAM, "export async function streamCallPlace", "/**\n * POST /api/stream-calls/cancel");
    expect(place).toContain("streamCallsEnabled");
    expect(STREAM).toContain("streamCallPilotEnabled");
    expect(place).toContain("messengerCallBillingEnabled");
  });

  it("shows explicit paid-audio continuation consent with two-participant hourly pricing", () => {
    expect(CONSENT).toContain("Paid audio via GetStream");
    expect(CONSENT).toMatch(/Continue with paid (?:GetStream )?audio\?/);
    expect(CONSENT).toContain("You pay for both participants");
    expect(CONSENT).toContain("tokens/hour");
    expect(CONSENT).toContain("Continue with paid GetStream audio");
  });

  it("lets Flutter decode paid Stream audio while keeping free Cloudflare audio rate-zero", () => {
    // The server-selected provider is authoritative. A client decoder that
    // rejects Stream audio would silently force paid continuation back into
    // the free Cloudflare lane.
    expect(FLUTTER_API).not.toContain(
      "if (media == MessengerCallMedia.audio && provider != 'cloudflare') return null;",
    );
    expect(FLUTTER_API).toMatch(/provider == 'cloudflare' && rateIsPaid\(json\)/);
    expect(FLUTTER_API).toMatch(/provider == 'stream' && !rateIsPaid\(json\)/);
  });

  it("wires the in-call continuation UI imports so the paid prompt is buildable", () => {
    // The continuation offer runs from CallScreen after the free Cloudflare
    // lane ends. Both symbols must be imported in that library; otherwise the
    // UI contract exists only in source and the app cannot compile.
    expect(CALL_SCREEN).toContain("import 'call_billing/messenger_call_billing_gate.dart';");
    expect(CALL_SCREEN).toContain("import 'call_billing/messenger_call_consent_sheets.dart';");
  });
});
