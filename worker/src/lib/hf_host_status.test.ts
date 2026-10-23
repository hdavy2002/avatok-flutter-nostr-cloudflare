// [HF-CALL-MODES-P0] publicCallState: the spec 2.1 table, row by row.
import { describe, expect, it } from "vitest";
import { canBook, canQueue, derivePresence, publicCallState, refusalReason } from "./hf_host_status";

const base = { mode: "online", onCallSince: null, lockCallId: null, waiting: 0 } as const;

describe("publicCallState", () => {
  it("available: online, no lock, no waiters", () => expect(publicCallState(base)).toBe("available"));
  it("on_call: on_call_since set (even with waiters and a lock)", () => {
    expect(publicCallState({ ...base, onCallSince: 1, lockCallId: "c1" })).toBe("on_call");
    expect(publicCallState({ ...base, onCallSince: 1, lockCallId: "c1", waiting: 3 })).toBe("on_call");
  });
  it("connecting: lock held but not joined (ringing, or the 60-s break lock)", () => {
    expect(publicCallState({ ...base, lockCallId: "c1" })).toBe("connecting");
    expect(publicCallState({ ...base, lockCallId: "q:e1", waiting: 2 })).toBe("connecting");
  });
  it("queue_only: online, idle, waiters > 0", () => expect(publicCallState({ ...base, waiting: 1 })).toBe("queue_only"));
  it("appointments: bookings_only wins over everything", () => {
    expect(publicCallState({ ...base, mode: "bookings_only" })).toBe("appointments");
    expect(publicCallState({ ...base, mode: "bookings_only", onCallSince: 5, lockCallId: "c", waiting: 4 })).toBe("appointments");
  });
  it("offline: offline wins over everything", () => {
    expect(publicCallState({ ...base, mode: "offline", onCallSince: 5, lockCallId: "c", waiting: 4 })).toBe("offline");
  });
  it("unknown / missing mode behaves like the column default 'online'", () => {
    expect(publicCallState({ ...base, mode: null })).toBe("available");
    expect(publicCallState({ ...base, mode: "weird" })).toBe("available");
  });
});

describe("helpers", () => {
  it("derivePresence", () => {
    expect(derivePresence("online", 10)).toBe("busy");
    expect(derivePresence("online", null)).toBe("online");
    expect(derivePresence("bookings_only", null)).toBe("offline");
    expect(derivePresence("offline", null)).toBe("offline");
  });
  it("canQueue only for on_call / connecting / queue_only and not paused", () => {
    expect(canQueue("on_call", false)).toBe(true);
    expect(canQueue("connecting", false)).toBe(true);
    expect(canQueue("queue_only", false)).toBe(true);
    expect(canQueue("on_call", true)).toBe(false);
    expect(canQueue("available", false)).toBe(false);
    expect(canQueue("appointments", false)).toBe(false);
    expect(canQueue("offline", false)).toBe(false);
  });
  it("canBook is false only when offline", () => {
    expect(canBook("offline")).toBe(false);
    for (const s of ["available", "on_call", "connecting", "queue_only", "appointments"] as const) expect(canBook(s)).toBe(true);
  });
  it("refusalReason", () => {
    expect(refusalReason("available")).toBeNull();
    expect(refusalReason("on_call")).toBe("on_call");
  });
});
