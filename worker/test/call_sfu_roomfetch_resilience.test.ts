import { describe, expect, it, vi } from "vitest";
import {
  attemptSfuDependency,
  sfuUnavailableBody,
} from "../src/routes/call_sfu";

describe("CallRoom SFU dependency resilience", () => {
  it("contains a thrown ownership-seat read as a CallRoom failure", async () => {
    const stub = {
      fetch: vi.fn(async () => { throw new Error("ownership storage unavailable"); }),
    };

    const result = await attemptSfuDependency("call_room", async () => {
      const response = await stub.fetch("https://call/sfu-seat-self");
      return response.ok;
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.dependency).toBe("call_room");
    expect(stub.fetch).toHaveBeenCalledOnce();
  });

  it("contains a thrown peer-seat read instead of leaking a generic 500", async () => {
    const stub = {
      fetch: vi.fn(async () => { throw new Error("peer registry unavailable"); }),
    };

    const result = await attemptSfuDependency("call_room", () =>
      stub.fetch("https://call/sfu-peer?callId=call_1&uid=user_1"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.dependency).toBe("call_room");
    expect(sfuUnavailableBody(result.dependency)).toEqual({
      error: "sfu_unavailable",
      reason: "call_room_unavailable",
      fallback: true,
      retry: false,
    });
  });

  it("keeps a negative ownership result distinct from a dependency exception", async () => {
    const result = await attemptSfuDependency("call_room", async () => false);
    expect(result).toEqual({ ok: true, value: false });
  });

  it("distinguishes provider failures from CallRoom failures", async () => {
    const result = await attemptSfuDependency("provider", async () => {
      throw new TypeError("provider fetch failed");
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.dependency).toBe("provider");
    expect(sfuUnavailableBody(result.dependency)).toEqual({
      error: "sfu_unavailable",
      reason: "provider_unavailable",
      fallback: true,
      retry: false,
    });
  });
});
