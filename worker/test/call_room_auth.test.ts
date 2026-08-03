import { describe, expect, it } from "vitest";
import {
  CALL_ROOM_TOKEN_LIFETIME_MS,
  authenticatedSideTag,
  roomSeatIsFull,
  roomTokenExpired,
  sameRoomSeat,
  socketSeatKey,
} from "../src/lib/call_room_auth";

describe("CallRoom credential lifetime", () => {
  it("outlives ringing and the reconnect grace", () => {
    expect(CALL_ROOM_TOKEN_LIFETIME_MS).toBeGreaterThan(45_000);
    expect(roomTokenExpired(1_000 + CALL_ROOM_TOKEN_LIFETIME_MS, 1_000 + 20_000)).toBe(false);
  });

  it("still expires stale credentials", () => {
    expect(roomTokenExpired(2_000, 2_001)).toBe(true);
  });
});

describe("CallRoom authenticated seat identity", () => {
  const caller = authenticatedSideTag("caller");
  const callee = authenticatedSideTag("callee");

  it("treats different peer ids with one token as the same seat", () => {
    expect(sameRoomSeat(["peer-a", caller], caller, "peer-new")).toBe(true);
    expect(sameRoomSeat(["peer-b", callee], caller, "peer-new")).toBe(false);
  });

  it("counts authenticated sides instead of client-controlled ids", () => {
    const keys = new Set([
      socketSeatKey(["peer-a", caller]),
      socketSeatKey(["peer-b", caller]),
      socketSeatKey(["peer-c", callee]),
    ]);
    expect(keys.size).toBe(2);
  });

  it("allows one opposite seat and rejects a third identity", () => {
    expect(roomSeatIsFull(caller, 0)).toBe(false);
    expect(roomSeatIsFull(caller, 1)).toBe(false);
    expect(roomSeatIsFull(caller, 2)).toBe(true);
  });
});
