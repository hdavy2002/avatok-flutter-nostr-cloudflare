import { describe, expect, it } from "vitest";
import { CallRoom } from "../src/do/call_room";

function fakeRoom(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed));
  const state = {
    id: { name: "avatok-test" },
    storage: {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") data.set(key, value);
        else for (const [k, v] of Object.entries(key)) data.set(k, v);
      },
    },
  };
  return { room: new CallRoom(state as any, {} as any), data };
}

describe("CallRoom real credential classifier", () => {
  it("accepts reconnect credentials after the ring deadline", async () => {
    const now = Date.now();
    const { room } = fakeRoom({
      room_token_caller: "caller-token",
      room_token_callee: "callee-token",
      token_expires_at: now - 1, // ring/native action lease is already over
      room_token_expires_at: now + 60_000,
    });
    await expect((room as any).classifyRoomToken("caller-token"))
      .resolves.toEqual({ ok: true, side: "caller" });
  });

  it("rejects a credential after its independent room expiry", async () => {
    const { room } = fakeRoom({
      room_token_caller: "caller-token",
      room_token_callee: "callee-token",
      room_token_expires_at: Date.now() - 1,
    });
    await expect((room as any).classifyRoomToken("caller-token"))
      .resolves.toEqual({ ok: false, reason: "expired" });
  });
});

describe("CallRoom real receptionist ownership storage", () => {
  it("persists one winner across object re-instantiation", async () => {
    const first = fakeRoom();
    await expect((first.room as any).claimReceptionistSession("sid-a"))
      .resolves.toEqual({ already: false, sid: "sid-a" });

    const second = fakeRoom(Object.fromEntries(first.data));
    await expect((second.room as any).claimReceptionistSession("sid-b"))
      .resolves.toEqual({ already: true, sid: "sid-a" });
  });
});
