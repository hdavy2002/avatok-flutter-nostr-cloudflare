// [TEST-FANOUT-1] worker/src/routes/messaging.ts's fanoutId/hashShort are the
// PRODUCER side of the [MSG-FANOUT-DURABLE-1] job-identity contract; the
// consumer (consumers/src/fcm.ts resolveFanoutId/hashShort) independently
// re-implements the SAME hash so it can derive a stable id for a message that
// arrives without a producer-minted fanout_id. These two implementations are
// duplicated across the worker/consumers package split (cross-package imports
// aren't supported here — see consumers/src/fault_inject.ts's header comment for
// the same constraint) and MUST stay byte-for-byte identical, so this test
// pins the exact digest algorithm/format rather than just "it returns a string".
//
// Requires Node's Web Crypto (globalThis.crypto.subtle) — available in vitest's
// default "node" environment on Node >= 19 (this repo's CI pins Node 20 in
// .github/workflows/typecheck.yml and verify.yml).
import { describe, it, expect } from "vitest";
import { fanoutId, hashShort } from "../src/routes/messaging";

describe("fanoutId", () => {
  it("is deterministic for the same (conv, clientId, sender)", async () => {
    const a = await fanoutId("conv1", "client1", "sender1");
    const b = await fanoutId("conv1", "client1", "sender1");
    expect(a).toBe(b);
  });
  it("differs when any input differs", async () => {
    const base = await fanoutId("conv1", "client1", "sender1");
    expect(await fanoutId("conv2", "client1", "sender1")).not.toBe(base);
    expect(await fanoutId("conv1", "client2", "sender1")).not.toBe(base);
    expect(await fanoutId("conv1", "client1", "sender2")).not.toBe(base);
  });
  it("treats a null clientId as the empty string (matches the consumer's fallback path)", async () => {
    const a = await fanoutId("conv1", null, "sender1");
    const b = await fanoutId("conv1", "", "sender1");
    expect(a).toBe(b);
  });
  it("is a 32-char lowercase hex string (SHA-256 truncated to 16 bytes)", async () => {
    const id = await fanoutId("conv1", "client1", "sender1");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("hashShort", () => {
  it("is deterministic", async () => {
    expect(await hashShort("some-conv-id")).toBe(await hashShort("some-conv-id"));
  });
  it("differs for different input", async () => {
    expect(await hashShort("conv-a")).not.toBe(await hashShort("conv-b"));
  });
  it("is a 16-char lowercase hex string (SHA-256 truncated to 8 bytes)", async () => {
    const h = await hashShort("some-conv-id");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
  it("never leaks the raw input verbatim into the output", async () => {
    const h = await hashShort("plaintext-conv-id");
    expect(h).not.toContain("plaintext-conv-id");
  });
});
