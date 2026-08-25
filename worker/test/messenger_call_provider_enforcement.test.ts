import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function streamPlacementSource(): string {
  const source = read("src/routes/stream_video_calls.ts");
  const start = source.indexOf("export async function streamCallPlace");
  const end = source.indexOf("/**\n * POST /api/stream-calls/cancel", start);
  if (start < 0 || end <= start) throw new Error("streamCallPlace implementation boundary not found");
  return source.slice(start, end);
}

function streamRouteSource(): string {
  return read("src/routes/stream_video_calls.ts");
}

describe("Messenger billing enforcement at Stream placement", () => {
  it("binds billing-enabled video placement to the server authorization row", () => {
    const source = streamPlacementSource();
    const route = streamRouteSource();

    // The Stream transport is not an authorization authority. When the
    // Messenger billing master is enabled, placement must read the immutable
    // server row and validate every identity/pricing dimension before ringing.
    expect(source).toContain("messengerCallBillingEnabled");
    expect(route).toContain("messenger_call_authorizations");
    for (const field of [
      "attempt_id",
      "payer_uid",
      "callee_uid",
      "media",
      "provider",
      "quality_sku",
      "price_version",
      "expires_at",
      "status",
      "call_id",
    ]) {
      expect(route, `${field} authorization binding`).toContain(field);
    }
    // The route may enforce this either in the SQL predicate or immediately
    // after decoding the immutable row. The current implementation uses the
    // latter shape; assert the actual runtime guard rather than one SQL quote
    // spelling.
    expect(route).toContain('billingAuthorization.status !== "authorized"');
    expect(route).toContain("provider !== \"stream\"");
    expect(route).toContain("expires_at");

    // The server-authored call id is the one sent to Stream and returned to
    // the client. A billing-enabled request cannot substitute a client id.
    expect(source).toContain("billingAuthorization.call_id");
    expect(source).not.toContain("body.call_id");
    expect(source).not.toContain("body.provider");
    expect(source).not.toContain("body.payer_uid");
  });

  it("retains reservation and marks reconciliation_pending on provider failure or cancel", () => {
    const source = read("src/routes/stream_video_calls.ts");
    const place = streamPlacementSource();
    const cancelStart = source.indexOf("export async function streamCallCancel");
    expect(cancelStart).toBeGreaterThanOrEqual(0);
    const cancel = source.slice(cancelStart);
    const createFailureStart = place.indexOf("if (!created.ok)");
    const createFailureEnd = place.indexOf("// Cancellation may land while Stream is processing", createFailureStart);
    expect(createFailureStart).toBeGreaterThanOrEqual(0);
    expect(createFailureEnd).toBeGreaterThan(createFailureStart);
    const createFailure = place.slice(createFailureStart, createFailureEnd);
    const afterProviderCancelStart = place.indexOf("if (await cancelled())");
    const afterProviderCancelEnd = place.indexOf("const approvalProps", afterProviderCancelStart);
    expect(afterProviderCancelStart).toBeGreaterThanOrEqual(0);
    expect(afterProviderCancelEnd).toBeGreaterThan(afterProviderCancelStart);
    const afterProviderCancel = place.slice(afterProviderCancelStart, afterProviderCancelEnd);
    const cancelFailureStart = cancel.indexOf("if (callId && !providerEnded)");
    const cancelFailureEnd = cancel.indexOf("let billingCancelled", cancelFailureStart);
    expect(cancelFailureStart).toBeGreaterThanOrEqual(0);
    expect(cancelFailureEnd).toBeGreaterThan(cancelFailureStart);
    const cancelFailure = cancel.slice(cancelFailureStart, cancelFailureEnd);

    // A provider result can be uncertain: Stream may have accepted the create
    // just as the Worker timed out. Never release escrow on this path. Retain
    // it for reconciliation and mark the durable authorization pending.
    const billing = read("src/routes/messenger_call_billing.ts");
    for (const text of [
      "reconciliation_pending",
      "terminal_reason",
      "reservation_ref",
      "reservation_tokens",
    ]) {
      expect(`${place}\n${cancel}\n${billing}`, `${text} terminal cleanup`).toContain(text);
    }
    expect(place).toContain("provider_failure");
    expect(`${place}\n${cancel}`).toContain("call_cancelled");

    // Known pre-provider validation failures may release. Once Stream creation
    // or Stream end is uncertain, however, the reservation must stay held and
    // the authorization must enter reconciliation_pending. These assertions
    // intentionally inspect each uncertain branch rather than banning the
    // confirmed-success release helper globally.
    expect(createFailure).toContain("providerMayHaveAccepted");
    expect(createFailure).toContain("if (providerEnded)");
    expect(createFailure).toMatch(/if \(providerEnded\) \{[\s\S]*releaseBilling\(/);
    expect(createFailure).toMatch(/else \{[\s\S]*retainBillingForReconciliation\(/);
    expect(afterProviderCancel).toContain("retainBillingForReconciliation");
    expect(afterProviderCancel).toContain("if (providerEnded)");
    expect(afterProviderCancel).toMatch(/if \(providerEnded\) \{[\s\S]*releaseBilling\(/);
    expect(afterProviderCancel).toMatch(/else \{[\s\S]*retainBillingForReconciliation\(/);
    expect(cancelFailure).toContain("markMessengerCallReconciliationPending");
    expect(cancelFailure).not.toContain("cancelMessengerCallAuthorization");
    expect(billing).toContain("providerConfirmed = true");
    expect(billing).toContain("nextStatus = providerConfirmed ? \"cancelled\" : \"reconciliation_pending\"");
    expect(billing).toContain("if (providerConfirmed && row.reservation_ref)");
  });

  it("replays the exact authorized identity for an attempt cache hit", () => {
    const source = streamPlacementSource();
    const cacheStart = source.indexOf("if (attemptKey)");
    const finishStart = source.indexOf("/** Single exit point", cacheStart);
    expect(cacheStart).toBeGreaterThanOrEqual(0);
    expect(finishStart).toBeGreaterThan(cacheStart);
    const cache = source.slice(cacheStart, finishStart);

    // A retry must not mint a new call or let the request body mutate the
    // approved identity. The replay payload must carry every provider-facing
    // identity needed by the client and reconciliation worker.
    expect(cache).toContain("cached.payload");
    for (const field of ["authorization_id", "callee_uid", "video", "provider"]) {
      expect(cache, `${field} replay identity`).toContain(field);
    }
    for (const field of ["call_id", "authorization_id", "callee_uid", "provider"]) {
      expect(cache, `${field} must be bound to cached response`).toMatch(
        new RegExp(`(?:cachedAuthorization\\.${field}\\s*===\\s*cached\\.payload\\.${field}|cached\\.payload\\.${field}\\s*===\\s*cachedAuthorization\\.${field})`),
      );
    }
    expect(cache).toContain("cachedAuthorization.media === \"video\"");
    expect(cache).toContain("cached.payload.video === true");
    expect(cache).toContain("idempotent_replay: true");
  });

  it("keeps the existing Stream lane when Messenger billing is dark", () => {
    const source = streamPlacementSource();

    // The Messenger gate is additive. With its master flag false, the legacy
    // Stream placement policy still decides availability; billing enforcement
    // must not silently become an authorization requirement for old callers.
    expect(source).toContain("messengerCallBillingEnabled === true");
    expect(source).toContain("streamCallsEnabled");
    expect(source).toContain("stream_calls_disabled");
  });
});
