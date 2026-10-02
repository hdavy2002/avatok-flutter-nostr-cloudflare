import { describe, it, expect } from "vitest";
import { validateAvailability, validateDeskProfile, validateAdminPatch, ageFromDob, isHM } from "./validate";

const ok = { slot_minutes: 30, buffer_minutes: 0 };
describe("validateAvailability", () => {
  it("accepts a good set", () => {
    const r = validateAvailability({ ...ok, rules: [{ weekday: 1, start: "10:00", end: "13:00" }], exceptions: [{ date: "2026-10-10", off: true }, { date: "2026-10-11", off: false, start: "09:00", end: "10:00" }] });
    expect(r.ok).toBe(true);
  });
  it("rejects bad times, order, weekday, slot, buffer", () => {
    const rule = (o: object) => validateAvailability({ ...ok, rules: [{ weekday: 1, start: "10:00", end: "11:00", ...o }], exceptions: [] });
    expect(rule({ start: "25:00" })).toEqual({ ok: false, error: "bad_time" });
    expect(rule({ start: "11:00", end: "10:00" })).toEqual({ ok: false, error: "start_after_end" });
    expect(rule({ weekday: 7 })).toEqual({ ok: false, error: "bad_weekday" });
    expect(validateAvailability({ ...ok, slot_minutes: 20, rules: [], exceptions: [] })).toEqual({ ok: false, error: "bad_slot_minutes" });
    expect(validateAvailability({ ...ok, buffer_minutes: 31, rules: [], exceptions: [] })).toEqual({ ok: false, error: "bad_buffer_minutes" });
  });
  it("caps counts and rejects bad dates", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ weekday: 1, start: `0${i % 10}:00`, end: "23:00" }));
    expect(validateAvailability({ ...ok, rules: many, exceptions: [] })).toEqual({ ok: false, error: "too_many_rules" });
    expect(validateAvailability({ ...ok, rules: [], exceptions: [{ date: "2026-02-30", off: true }] })).toEqual({ ok: false, error: "bad_date" });
    expect(validateAvailability({ ...ok, rules: [], exceptions: Array.from({ length: 121 }, () => ({ date: "2026-10-10", off: true })) })).toEqual({ ok: false, error: "too_many_exceptions" });
  });
  it("isHM", () => { expect(isHM("09:05")).toBe(true); expect(isHM("9:05")).toBe(false); });
});

describe("validateDeskProfile", () => {
  it("only allows bio/tagline/city/languages", () => {
    const r = validateDeskProfile({ bio: " hi ", languages: ["Hindi", "Hindi", "English"], name: "X" });
    expect(r).toEqual({ ok: true, value: { bio: "hi", languages_json: JSON.stringify(["Hindi", "English"]) } });
    expect(validateDeskProfile({ name: "X" })).toEqual({ ok: false, error: "nothing_to_update" });
    expect(validateDeskProfile({ tagline: "x".repeat(161) })).toEqual({ ok: false, error: "bad_tagline" });
  });
});

describe("validateAdminPatch", () => {
  const cur = { rate_rupees: 500, rate_floor: 300, rate_ceil: 5000 };
  it("validates rate against bounds", () => {
    expect(validateAdminPatch({ rate: 200 }, cur)).toEqual({ ok: false, error: "rate_out_of_bounds" });
    expect(validateAdminPatch({ rate_floor: 100, rate: 150 }, cur)).toMatchObject({ ok: true, value: { rate_floor: 100, rate_rupees: 150 } });
    expect(validateAdminPatch({ rate_floor: 6000 }, cur)).toEqual({ ok: false, error: "bad_rate_bounds" });
  });
  it("status, slug, disciplines", () => {
    expect(validateAdminPatch({ status: "live" }, cur)).toEqual({ ok: true, value: { status: "live" } });
    expect(validateAdminPatch({ status: "gone" }, cur)).toEqual({ ok: false, error: "bad_status" });
    expect(validateAdminPatch({ slug: "Bad Slug" }, cur)).toEqual({ ok: false, error: "bad_slug" });
    expect(validateAdminPatch({ disciplines: ["tarot", "nope"] }, cur)).toEqual({ ok: false, error: "bad_disciplines" });
  });
});

describe("ageFromDob", () => {
  it("computes", () => {
    const now = Date.parse("2026-10-02T00:00:00Z");
    expect(ageFromDob("1990-10-03", now)).toBe(35);
    expect(ageFromDob("1990-10-02", now)).toBe(36);
    expect(ageFromDob("nope", now)).toBeNull();
  });
});
