import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const API = readFileSync("src/routes/api.ts", "utf8");
const ROOM = readFileSync("src/do/call_room.ts", "utf8");
const CONFIG = readFileSync("src/routes/config.ts", "utf8");

function callRoute(): string {
  const start = API.indexOf("export async function call(");
  const end = API.indexOf("export async function callNativeDecline", start);
  if (start < 0 || end <= start) throw new Error("/api/call source boundary not found");
  return API.slice(start, end);
}

function method(source: string, signature: string, endMarker: string): string {
  const start = source.indexOf(signature);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end <= start) throw new Error(`method boundary not found: ${signature}`);
  return source.slice(start, end);
}

describe("Cloudflare Messenger audio billing lane", () => {
  it("admits audio only from the exact caller-owned D1 authorization", () => {
    const route = callRoute();
    const participantSideEffect = route.indexOf("callStub.fetch(\"https://call-room/participants\"");
    expect(participantSideEffect).toBeGreaterThan(0);

    // The billing master is provider-neutral, but this media lane must bind to
    // the server-frozen D1 row before creating a CallRoom participant record.
    // Client `to`, callId, provider, rate, and payer claims are not authority.
    const authMatch = route.match(/messenger_call_authorizations|readMessenger[A-Za-z]*Authorization|initializeMessengerCallBilling/);
    const auth = authMatch?.index ?? -1;
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(auth).toBeLessThan(participantSideEffect);
    expect(route).toMatch(/messengerCallBillingEnabled/);
    expect(route).toMatch(/provider[^\n]*(?:cloudflare|CF)/i);
    expect(route).toMatch(/status[^\n]*authorized/);
    expect(route).toMatch(/callee_uid[^\n]*caller|caller[^\n]*callee_uid/);
  });

  it("uses the authorization call_id and never lets the audio client choose identity", () => {
    const route = callRoute();
    expect(route).toMatch(/callId\s*:\s*(?:billingAuthorization|authorization)[._]call_id/);
    expect(route).toMatch(/authorization[._](?:authorization_id|call_id)/);
    // The request may carry a tracing/idempotency hint, but the media call id
    // must not be copied from body.callId once Messenger billing is enabled.
    const participant = route.slice(route.indexOf("callStub.fetch(\"https://call-room/participants\""));
    expect(participant).not.toContain("callId: b.callId");
  });

  it("does not send a Messenger-authorized audio call through Stream", () => {
    const route = callRoute();
    const stream = route.indexOf("prepareStreamCall");
    expect(stream).toBeGreaterThan(0);
    const billingGate = route.indexOf("messengerCallBillingEnabled");
    expect(billingGate).toBeGreaterThanOrEqual(0);
    expect(billingGate).toBeLessThan(stream);
    expect(route.slice(billingGate, stream)).toMatch(/audio/);
    expect(route.slice(billingGate, stream)).toMatch(/cloudflare|skip|bypass|return/i);
  });

  it("starts metering only after a connected two-seat call, never ringing or one-sided media", () => {
    const start = method(ROOM, "private async ensureHumanCallUsageStarted", "  /** Bill one 1:1 seat");
    const join = ROOM.slice(ROOM.indexOf("if (otherIds.length > 0)"), ROOM.indexOf("async webSocketMessage"));

    // Two authenticated WebSockets are necessary, but the second socket can
    // arrive during ringing. The meter must additionally require the FSM's
    // connected state; SDP, ICE, SFU seats, ring receipts, and one-sided WS
    // signals are not billable connection proof.
    expect(start).toMatch(/session\.session_state\s*===\s*["']connected["']/);
    expect(start).toContain("liveSeatCount() >= 2");
    expect(join).not.toMatch(/ensureHumanCallUsageStarted\([^\n]*\{?\s*\/\/.*ring/i);
    expect(ROOM).toContain("both authenticated seats");
  });

  it("uses the Messenger daily allowance/paid transition and caller reservation", () => {
    const roomBilling = method(ROOM, "private async billHumanCallSide", "  private async billHumanCallUsage");
    const route = callRoute();
    const usage = `${roomBilling}\n${ROOM}`;

    // Cloudflare must use the new caller-funded WalletDO operation (28,800
    // participant-seconds/day, then reserved paid seconds), not the retired
    // 200-minute human_call meter.
    expect(`${usage}\n${route}`).toMatch(/consumeMessengerCallUsage|initializeMessengerCallBilling|forwardMessengerStreamEvent/);
    expect(`${usage}\n${route}`).toContain("messengerAudioFreeParticipantSecondsDaily");
    expect(usage).toContain("reservation_ref");
    expect(route).toContain("messengerCallBillingEnabled");
  });

  it("retains the reservation when Cloudflare teardown or billing authority is uncertain", () => {
    const close = method(ROOM, "private async beginAwayOrEnd", "  /** Single alarm");
    const route = callRoute();
    const billing = `${route}\n${close}`;

    // A reconnect gap is unbilled, but an uncertain provider end is not a
    // release opportunity. Keep the caller reservation and reconcile later.
    expect(billing).toContain("markMessengerCallReconciliationPending");
    expect(billing).toContain("reconciliation_pending");
    expect(billing).toContain("reservation_ref");
    expect(billing).toMatch(/provider[^\n]*(?:uncertain|failed)|uncertain[^\n]*provider/i);
    expect(billing).not.toMatch(/provider[^\n]*uncertain[\s\S]{0,400}releaseMessengerCallReservation/);
  });

  it("keeps reconnect gaps and spoofed/replayed credentials outside billable time", () => {
    const reconnect = ROOM.slice(ROOM.indexOf("if (isRejoin)"), ROOM.indexOf("// CALL-GEN-1: fresh join"));
    const close = method(ROOM, "private async beginAwayOrEnd", "  /** Single alarm");
    const websocket = method(ROOM, "async webSocketMessage", "  async webSocketClose");

    // Closing a side stops at the disconnect instant; rejoin starts a fresh
    // interval. The old socket's frames must be dropped by the server generation
    // guard, and a client cannot manufacture a billing event through signaling.
    expect(close).toContain("stopHumanCallSide");
    expect(reconnect).toContain("billed_through[authenticatedSide] = now");
    expect(websocket).toContain("data.gen < cur");
    expect(websocket).toContain("return; // stale artifact");
    expect(websocket).not.toContain("consumeMessengerCallUsage");
  });

  it("leaves the legacy Cloudflare lane byte-for-byte when the Messenger master is false", () => {
    expect(CONFIG).toContain("messengerCallBillingEnabled: false");
    const route = callRoute();
    expect(route).toContain("messengerCallBillingEnabled");
    expect(route).toContain("callStub.fetch(\"https://call-room/participants\"");
    expect(route).toContain("Q_PUSH");
  });
});
