import { beforeEach, describe, expect, it, vi } from "vitest";

const astroCall = vi.fn();
const geoLookup = vi.fn();
const tzoneFor = vi.fn();
const getProfile = vi.fn();

vi.mock("../../astrology", async (orig) => {
  const real = await orig<typeof import("../../astrology")>();
  return { ...real, astroCall: (...a: unknown[]) => astroCall(...a), geoLookup: (...a: unknown[]) => geoLookup(...a), tzoneFor: (...a: unknown[]) => tzoneFor(...a) };
});
vi.mock("../../agent_memory/profile", () => ({ getProfile: (...a: unknown[]) => getProfile(...a) }));

import astrologyAgent, { summariseDasha, summarisePlanets } from "./astrology";
import type { VoiceToolCtx } from "../types";

const tool = (name: string) => astrologyAgent.tools.find((t) => t.decl.name === name)!;
const cards: any[] = [];
const ctx: VoiceToolCtx = { env: {} as any, uid: "u1", sessionId: "s1", agentId: "astrology", showCard: (c) => cards.push(c) };

const profile = (o: Record<string, unknown> = {}) => ({
  uid: "u1", name: "Ravi", gender: "male", dob: "1990-02-28", tob: "06:05", tob_unknown: 0, place: "Dehradun",
  lat: 30.3, lon: 78.0, tzone: 5.5, ...o,
});

beforeEach(() => {
  astroCall.mockReset(); geoLookup.mockReset(); tzoneFor.mockReset(); getProfile.mockReset(); cards.length = 0;
});

describe("astrology agent definition", () => {
  it("has the contract fields and a bounded prompt", () => {
    expect(astrologyAgent.id).toBe("astrology");
    expect(astrologyAgent.name).toBe("Meera");
    expect(astrologyAgent.voice).toBe("Aoede");
    const p = astrologyAgent.systemPrompt({ briefing: "BRIEFING-X", brandName: "Brand", nowIst: "now" });
    expect(p).toContain("Brand");
    expect(p.endsWith("BRIEFING-X")).toBe(true);
    expect(p.length - "BRIEFING-X".length).toBeLessThan(5200);
    // [AUMFE-GUIDE-BRAIN-1] one brain: Meera's prompt carries the shared owner rules.
    expect(p).toContain("GUIDE RULES");
    expect(p).toContain("Recommend ONLY items returned by");
    expect(astrologyAgent.tools.map((t) => t.decl.name)).toEqual(
      ["get_my_chart", "get_current_dasha", "check_doshas", "get_remedies", "get_today", "find_muhurta", "match_partner",
        "search_catalog", "search_tradition", "recommend_for_chart"]);
  });
  it("no tool declares a uid parameter", () => {
    for (const t of astrologyAgent.tools) {
      const props = Object.keys(((t.decl.parameters as any)?.properties) ?? {});
      expect(props).not.toContain("uid");
    }
  });
});

describe("no_birth_details path", () => {
  it.each(["get_my_chart", "get_current_dasha", "check_doshas", "get_remedies", "get_today"])("%s", async (n) => {
    getProfile.mockResolvedValue(null);
    expect(await tool(n).run(ctx, {})).toMatchObject({ error: "no_birth_details" });
    getProfile.mockResolvedValue(profile({ dob: null }));
    expect(await tool(n).run(ctx, {})).toMatchObject({ error: "no_birth_details" });
    expect(astroCall).not.toHaveBeenCalled();
  });
});

describe("body building", () => {
  it("builds the natal body from the saved profile and uses the caller uid only", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockResolvedValue({ ok: true, data: { major: { planet: "Jupiter", end: "2030" }, minor: { planet: "Saturn", end: "2027-05-01" } } });
    const r: any = await tool("get_current_dasha").run(ctx, { uid: "attacker" });
    expect(getProfile).toHaveBeenCalledWith(ctx.env, "u1");
    expect(astroCall.mock.calls[0][1]).toBe("current_vdasha");
    expect(astroCall.mock.calls[0][2]).toEqual({ day: 28, month: 2, year: 1990, hour: 6, min: 5, lat: 30.3, lon: 78.0, tzone: 5.5 });
    expect(astroCall.mock.calls[0][3]).toMatchObject({ uid: "u1" });
    expect(r).toMatchObject({ approximate: false, mahadasha: "Jupiter", antardasha: "Saturn", until: "2027-05-01" });
    expect(cards[0].title).toBe("Your dasha");
  });
  it("unknown birth time -> 12:00 and approximate:true", async () => {
    getProfile.mockResolvedValue(profile({ tob: null, tob_unknown: 1 }));
    astroCall.mockResolvedValue({ ok: true, data: {} });
    const r: any = await tool("get_current_dasha").run(ctx, {});
    expect(astroCall.mock.calls[0][2]).toMatchObject({ hour: 12, min: 0 });
    expect(r.approximate).toBe(true);
  });
  it("resolves missing lat/lon/tzone from the place", async () => {
    getProfile.mockResolvedValue(profile({ lat: null, lon: null, tzone: null }));
    geoLookup.mockResolvedValue({ ok: true, data: [{ lat: 19.07, lon: 72.87, place_name: "Mumbai", timezone_id: "", country_code: "IN" }] });
    tzoneFor.mockResolvedValue({ ok: true, data: 5.5 });
    astroCall.mockResolvedValue({ ok: true, data: {} });
    await tool("get_current_dasha").run(ctx, {});
    expect(tzoneFor).toHaveBeenCalledWith(ctx.env, 19.07, 72.87, "28-02-1990", "u1");
    expect(astroCall.mock.calls[0][2]).toMatchObject({ lat: 19.07, lon: 72.87, tzone: 5.5 });
  });
  it("place not found -> error, no astro call", async () => {
    getProfile.mockResolvedValue(profile({ lat: null, lon: null }));
    geoLookup.mockResolvedValue({ ok: true, data: [] });
    expect(await tool("get_my_chart").run(ctx, {})).toMatchObject({ error: "place_not_found" });
    expect(astroCall).not.toHaveBeenCalled();
  });
});

describe("summaries", () => {
  it("get_my_chart picks lagna from planets and shows a card", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockImplementation(async (_e: unknown, ep: string) => {
      if (ep === "astro_details") return { ok: true, data: { sign: "Pisces", Naksahtra: "Revati", Charan: 2 } };
      if (ep === "planets") return { ok: true, data: [{ name: "Ascendant", sign: "Leo", house: 1 }, { name: "Sun", sign: "Aquarius", house: 7 }] };
      return { ok: true, data: { sunrise: "06:40" } };
    });
    const r: any = await tool("get_my_chart").run(ctx, {});
    expect(r).toMatchObject({ lagna: "Leo", rashi: "Pisces", nakshatra: "Revati" });
    expect(r.planets).toHaveLength(2);
    expect(cards[0].title).toBe("Your chart");
  });
  it("check_doshas calls only the requested endpoint", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockResolvedValue({ ok: true, data: { is_present: true, manglik_status: "Mild" } });
    const r: any = await tool("check_doshas").run(ctx, { which: "manglik" });
    expect(astroCall).toHaveBeenCalledTimes(1);
    expect(astroCall.mock.calls[0][1]).toBe("manglik");
    expect(r.manglik.present).toBe(true);
  });
  it("check_doshas all hits four endpoints", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockResolvedValue({ ok: true, data: {} });
    await tool("check_doshas").run(ctx, {});
    expect(astroCall).toHaveBeenCalledTimes(4);
  });
  it("API failure fails soft", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockResolvedValue({ ok: false, error: "astro_not_configured", status: 0 });
    expect(await tool("get_current_dasha").run(ctx, {})).toMatchObject({ error: "astro_unavailable" });
  });
  it("find_muhurta caps at 5 dates and validates input", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockResolvedValue({ ok: true, data: { muhurta: Array.from({ length: 9 }, (_, i) => ({ date: `2026-11-${10 + i}` })) } });
    const r: any = await tool("find_muhurta").run(ctx, { purpose: "marriage", month: 11, year: 2026 });
    expect(r.dates).toHaveLength(5);
    expect(astroCall.mock.calls[0][1]).toBe("monthly_muhurta/marriage");
    expect(await tool("find_muhurta").run(ctx, { purpose: "x", month: 1, year: 2026 })).toMatchObject({ error: "bad_purpose" });
  });
  it("pure summarisers", () => {
    expect(summarisePlanets([{ name: "Sun", sign: "Leo", house: "5" }])).toEqual([{ planet: "Sun", sign: "Leo", house: 5 }]);
    expect(summariseDasha(undefined)).toEqual({ mahadasha: "", antardasha: "", pratyantar: "", until: "" });
  });
});

describe("match_partner", () => {
  const args = { dob: "1992-07-04", tob: "14:30", place: "Pune", partner_name: "Anita" };
  beforeEach(() => {
    geoLookup.mockResolvedValue({ ok: true, data: [{ lat: 18.5, lon: 73.8, place_name: "Pune", timezone_id: "", country_code: "IN" }] });
    tzoneFor.mockResolvedValue({ ok: true, data: 5.5 });
    astroCall.mockResolvedValue({ ok: true, data: { total: { received_points: 27, total_points: 36 }, conclusion: { report: "Good" } } });
  });
  it("male customer is m_, partner f_", async () => {
    getProfile.mockResolvedValue(profile());
    const r: any = await tool("match_partner").run(ctx, args);
    const body = astroCall.mock.calls[0][2];
    expect(astroCall.mock.calls[0][1]).toBe("match_ashtakoot_points");
    expect(body).toMatchObject({ m_day: 28, m_hour: 6, f_day: 4, f_month: 7, f_year: 1992, f_hour: 14, f_min: 30, f_lat: 18.5 });
    expect(r).toMatchObject({ score: "27 out of 36", approximate: false });
  });
  it("female customer is f_, partner m_; missing partner time is approximate", async () => {
    getProfile.mockResolvedValue(profile({ gender: "female" }));
    const r: any = await tool("match_partner").run(ctx, { ...args, tob: undefined });
    const body = astroCall.mock.calls[0][2];
    expect(body).toMatchObject({ f_day: 28, m_day: 4, m_hour: 12 });
    expect(r.approximate).toBe(true);
  });
  it("unknown gender asks first", async () => {
    getProfile.mockResolvedValue(profile({ gender: null }));
    expect(await tool("match_partner").run(ctx, args)).toMatchObject({ error: "gender_unknown" });
    expect(astroCall).not.toHaveBeenCalled();
  });
});
