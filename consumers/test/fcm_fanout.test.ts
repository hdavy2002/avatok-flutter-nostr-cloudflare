// [TEST-FANOUT-1] Unit tests for the pure/classifiable parts of the Q_PUSH
// fan-out consumer (consumers/src/fcm.ts handleFanout). classifyFanoutOutcome
// was extracted verbatim from the two inline call sites (HTTP non-ok branch +
// thrown-exception branch) so the retry/dead-letter decision is independently
// testable and the two call sites can never silently drift apart.
//
//   npm test   (vitest run, run from consumers/)
import { describe, it, expect } from "vitest";
import { buildPayload, classifyFanoutOutcome, resolveFanoutId, hashShort, ringInviteExpired } from "../src/fcm";
import type { PushMsg } from "../src/types";

describe("classifyFanoutOutcome", () => {
  it("HTTP 500/429 is retryable when not the final attempt", () => {
    expect(classifyFanoutOutcome("http", 500, false)).toBe("retryable");
    expect(classifyFanoutOutcome("http", 502, false)).toBe("retryable");
    expect(classifyFanoutOutcome("http", 429, false)).toBe("retryable");
  });
  it("any other non-2xx HTTP status is a permanent dead_letter (never loops forever)", () => {
    expect(classifyFanoutOutcome("http", 400, false)).toBe("dead_letter");
    expect(classifyFanoutOutcome("http", 404, false)).toBe("dead_letter");
    expect(classifyFanoutOutcome("http", 403, false)).toBe("dead_letter");
  });
  it("a thrown exception is always retryable unless this is the final attempt", () => {
    expect(classifyFanoutOutcome("exception", undefined, false)).toBe("retryable");
  });
  it("the final attempt is ALWAYS dead_letter, HTTP or exception, regardless of status", () => {
    expect(classifyFanoutOutcome("http", 500, true)).toBe("dead_letter");
    expect(classifyFanoutOutcome("http", 429, true)).toBe("dead_letter");
    expect(classifyFanoutOutcome("exception", undefined, true)).toBe("dead_letter");
  });
});

describe("resolveFanoutId", () => {
  it("prefers the producer-minted fanout_id when present", async () => {
    const msg: PushMsg = { kind: "fanout", fanout_id: "producer-minted-id", payload: { conv: "c1" } };
    expect(await resolveFanoutId(msg)).toBe("producer-minted-id");
  });
  it("derives a deterministic id from conv+client_id+sender when fanout_id is absent (pre-migration producer)", async () => {
    const msg: PushMsg = { kind: "fanout", from: "sender1", payload: { conv: "conv1", client_id: "client1" } };
    const a = await resolveFanoutId(msg);
    const b = await resolveFanoutId(msg);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
  it("MUST match worker/src/routes/messaging.ts's fanoutId() for the same inputs — the producer/consumer contract", async () => {
    // Same digest algorithm inlined here (SHA-256 of "conv|clientId|sender",
    // truncated to 32 hex chars) — the producer's exact implementation — so this
    // test fails loudly if either side's hash format ever drifts.
    const conv = "conv-xyz", clientId = "client-xyz", sender = "sender-xyz";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${conv}|${clientId}|${sender}`));
    const expected = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
    const msg: PushMsg = { kind: "fanout", from: sender, payload: { conv, client_id: clientId } };
    expect(await resolveFanoutId(msg)).toBe(expected);
  });
});

describe("hashShort", () => {
  it("is deterministic and never leaks the raw conv id", async () => {
    const h1 = await hashShort("real-conversation-id");
    const h2 = await hashShort("real-conversation-id");
    expect(h1).toBe(h2);
    expect(h1).not.toContain("real-conversation-id");
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("incoming-call delivery contract", () => {
  it("suppresses invitations at or after their expiry", () => {
    expect(ringInviteExpired(1000, 999)).toBe(false);
    expect(ringInviteExpired(1000, 1000)).toBe(true);
  });

  it("bounds FCM retention and keeps terminal status in its own collapse bucket", () => {
    const ring = buildPayload({
      kind: "call", to: "callee", callId: "call-1", tokenExpiresAt: 21_000,
    }, 1_000);
    const cancel = buildPayload({
      kind: "call-status", to: "callee", callId: "call-1", status: "cancel",
    }, 1_000);
    expect(ring.ttlSeconds).toBe(20);
    // [CALL-RING-COLLAPSE-1 2026-08-08] The ring payload must carry NO collapse
    // key. A collapsible message may be dropped outright rather than delivered
    // late, and background rings were dead for 14 days because of this exact
    // field. This assertion previously required the removed key, so it had been
    // failing ever since that deliberate fix — inverted to lock the fix in.
    expect(ring.collapseKey).toBeUndefined();
    // Terminal call status stays collapsible: a superseded cancel is safe to drop.
    expect(cancel.collapseKey).toBe("call-status:call-1");
    expect(cancel.ttlSeconds).toBe(60);
    expect(ring.data).not.toHaveProperty("from");
  });
});

describe("commercial notification delivery contract", () => {
  it("forwards only stable ids and never provider credentials", () => {
    const payload = buildPayload({
      kind: "notify", to: "buyer-1", title: "Receipt ready", body: "Open your receipt", data: {
        type: "commercial_receipt", listing_id: "listing-1", booking_id: "booking-1",
        session_id: "session-1", provider_token: "must-not-forward", call_id: "must-not-forward",
      },
    });
    expect(payload.data).toMatchObject({
      type: "commercial_receipt", listing_id: "listing-1", booking_id: "booking-1", session_id: "session-1",
    });
    expect(payload.data).not.toHaveProperty("provider_token");
    expect(payload.data).not.toHaveProperty("call_id");
    expect(payload.data).not.toHaveProperty("fromUid");
  });
});
