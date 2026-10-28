import { describe, expect, it, vi } from "vitest";
import { activeCallTopupMinimum, callTopupMinimum } from "./hf_call_topup_minimum";

const now = 1_800_000_000_000;
const base = { caller_uid: "caller", status: "connected", connected_at: now - 60_000, rate_paise: 2000, pricing_snapshot: null as string | null };
const envFor = (row: unknown, info: unknown = { fundedSec: 300, maxSeconds: 3600, hardEndsAt: null }) => ({
  DB_META: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
  HF_CALL: { idFromName: (id: string) => id, get: () => ({ fetch: async () => ({ ok: true, json: async () => info }) }) },
}) as any;
describe("active call top-up minimum", () => {
  it("uses a flat rate, including a booked flat snapshot", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(callTopupMinimum(base)).toBe(10000);
      expect(callTopupMinimum({ ...base, pricing_snapshot: JSON.stringify({ ratePaise: 2000, price: 2000 }) })).toBe(10000);
      expect(callTopupMinimum({ ...base, pricing_snapshot: JSON.stringify({ ratePaise: 3000 }) })).toBeNull();
    } finally { vi.restoreAllMocks(); }
  });
  it("uses the frozen tariff across tier boundaries", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const pricing_snapshot = JSON.stringify({ plan: "std", tariff: { tiers: [{ fromSec: 0, paisePerMin: 2000 }, { fromSec: 180, paisePerMin: 1000 }] } });
      expect(callTopupMinimum({ ...base, pricing_snapshot })).toBe(10000);
    } finally { vi.restoreAllMocks(); }
  });
  it("fails closed on invalid timestamps and pricing", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(callTopupMinimum({ ...base, connected_at: now + 1 })).toBeNull();
      expect(callTopupMinimum({ ...base, connected_at: 0 })).toBeNull();
      expect(callTopupMinimum({ ...base, pricing_snapshot: "bad" })).toBeNull();
    } finally { vi.restoreAllMocks(); }
  });
  it("requires the call DO to confirm chunk billing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(await activeCallTopupMinimum(envFor(base), "caller", "id")).toEqual({ minimum: 10000 });
      expect(await activeCallTopupMinimum(envFor(base, {}), "caller", "id")).toMatchObject({ status: 409, error: "call_topup_unavailable" });
      expect(await activeCallTopupMinimum(envFor(base, { fundedSec: 3400, maxSeconds: 3600 }), "caller", "id")).toMatchObject({ status: 409, error: "call_topup_unavailable" });
      expect(await activeCallTopupMinimum(envFor(base, { fundedSec: 300, maxSeconds: 3600, hardEndsAt: now + 100_000 }), "caller", "id")).toMatchObject({ status: 409, error: "call_topup_unavailable" });
      expect(await activeCallTopupMinimum(envFor(base, { fundedSec: 300, maxSeconds: 600, hardEndsAt: now + 540_000 }), "caller", "id")).toEqual({ minimum: 10000 });
    } finally { vi.restoreAllMocks(); }
  });
  it("requires an owned, connected call", async () => {
    expect(await activeCallTopupMinimum(envFor(null), "caller", "id")).toMatchObject({ status: 404 });
    expect(await activeCallTopupMinimum(envFor(base), "other", "id")).toMatchObject({ status: 404 });
    expect(await activeCallTopupMinimum(envFor({ ...base, status: "completed" }), "caller", "id")).toMatchObject({ status: 409, error: "call_not_active" });
    expect(await activeCallTopupMinimum(envFor(base), "caller", "")).toMatchObject({ status: 400 });
  });
});
