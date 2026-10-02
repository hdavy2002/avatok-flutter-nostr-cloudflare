// [AUMFE-VOICE-PACKS-1] numerology, tarot and marriage tool packs: request bodies, summarisation, error paths.
// Response fixtures are trimmed copies of live AstrologyAPI answers captured 2026-10-02.
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

import { cleanLatinName, summariseNumeroTable } from "./numerology";
import { drawDistinct, inferTopic, randomInt } from "./tarot";
import { buildMatchBody, summariseAshtakoot, summariseManglikMatch } from "./marriage";
import { getToolPack, listToolPacks } from "../tool_packs";
import type { VoiceToolCtx } from "../types";

const cards: any[] = [];
const ctx: VoiceToolCtx = { env: {} as any, uid: "u1", sessionId: "s1", agentId: "x", showCard: (c) => cards.push(c) };
const tool = (pack: string, name: string) => getToolPack(pack)!.tools.find((t) => t.decl.name === name)!;
const ok = (data: unknown) => ({ ok: true, data });
const bad = (error: string) => ({ ok: false, error, status: 200 });
const calls = (path: string) => astroCall.mock.calls.filter((c) => c[1] === path);

const profile = (o: Record<string, unknown> = {}) => ({
  uid: "u1", name: "Rahul Sharma", gender: "male", dob: "1990-08-15", tob: "10:30", tob_unknown: 0, place: "Mumbai",
  lat: 19.07, lon: 72.88, tzone: 5.5, ...o,
});

beforeEach(() => {
  astroCall.mockReset(); geoLookup.mockReset(); tzoneFor.mockReset(); getProfile.mockReset(); cards.length = 0;
});

const TABLE = { name: "Rahul Sharma", date: "15-8-1990", destiny_number: 6, radical_number: 6, name_number: 6, evil_num: "1,8", fav_color: "White", fav_day: "Thursday, Tuesday, Friday", fav_god: "Devi", fav_mantra: "|| Om Shum Shukray Namah ||", fav_metal: "Silver", fav_stone: "Diamond, Opal", friendly_num: "4,3,9", radical_ruler: "Venus" };
const WESTERN = { name: "Rahul Sharma", birth_date: "1990-8-15", lifepath_number: 6, personality_number: 6, expression_number: 3, soul_urge_number: 6, subconscious_self_number: 5, challenge_numbers: [2, 4, 2, 2] };

describe("registration", () => {
  it("the three packs are registered with rules and tools; every tool is a valid declaration without a uid param", () => {
    const ids = listToolPacks().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["astrology", "knowledge_only", "numerology", "tarot", "marriage"]));
    expect(listToolPacks().find((p) => p.id === "numerology")!.tools).toEqual(["my_numbers", "numerology_report", "numerology_today", "search_catalog", "search_tradition"]);
    expect(listToolPacks().find((p) => p.id === "tarot")!.tools).toEqual(["draw_tarot", "search_catalog", "search_tradition"]);
    expect(listToolPacks().find((p) => p.id === "marriage")!.tools).toEqual(["match_partner", "search_catalog", "search_tradition", "recommend_for_chart"]);
    for (const id of ["numerology", "tarot", "marriage"]) {
      const p = getToolPack(id)!;
      const rules = p.baseRules("TestBrand");
      expect(rules).toContain("TestBrand");
      expect(rules).toContain("GUIDE RULES");
      for (const t of p.tools) expect(Object.keys((t.decl.parameters as any)?.properties ?? {})).not.toContain("uid");
    }
  });
});

describe("numerology", () => {
  it("cleanLatinName keeps English names and rejects Devanagari", () => {
    expect(cleanLatinName("  Rahul   Sharma ")).toBe("Rahul Sharma");
    expect(cleanLatinName("राहुल शर्मा")).toBeNull();
    expect(cleanLatinName("")).toBeNull();
    expect(cleanLatinName("A")).toBeNull();
  });

  it("my_numbers builds the verified request bodies and summarises both answers", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockImplementation(async (_e: unknown, path: string) => (path === "numero_table" ? ok(TABLE) : ok(WESTERN)));
    const r: any = await tool("numerology", "my_numbers").run(ctx, {});
    expect(calls("numero_table")[0][2]).toEqual({ name: "Rahul Sharma", day: 15, month: 8, year: 1990 });
    expect(calls("numerological_numbers")[0][2]).toEqual({ full_name: "Rahul Sharma", date: 15, month: 8, year: 1990 });
    expect(calls("numero_table")[0][3]).toMatchObject({ ttl: "forever", uid: "u1" });
    expect(r.destiny_number).toBe(6);
    expect(r.name_number).toBe(6);
    expect(r.lucky).toMatchObject({ colour: "White", days: "Thursday, Tuesday, Friday", numbers: "4,3,9" });
    expect(r.avoid_numbers).toBe("1,8");
    expect(r.western).toMatchObject({ life_path: 6, expression: 3, soul_urge: 6, challenges: [2, 4, 2, 2] });
    expect(JSON.stringify(r).length).toBeLessThan(1500);
    expect(cards[0].title).toBe("Your numbers");
  });

  it("my_numbers survives one endpoint failing, and reports unavailable when both fail", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockImplementation(async (_e: unknown, path: string) => (path === "numero_table" ? ok(TABLE) : bad("boom")));
    const r: any = await tool("numerology", "my_numbers").run(ctx, {});
    expect(r.destiny_number).toBe(6);
    expect(r.western).toBeUndefined();
    astroCall.mockResolvedValue(bad("astro_not_configured"));
    expect(await tool("numerology", "my_numbers").run(ctx, {})).toMatchObject({ error: "astro_unavailable" });
  });

  it("no_birth_details / no_name / non-English name paths never call the API", async () => {
    for (const n of ["my_numbers", "numerology_report", "numerology_today"]) {
      getProfile.mockResolvedValue(null);
      expect(await tool("numerology", n).run(ctx, {})).toMatchObject({ error: "no_birth_details" });
      getProfile.mockResolvedValue(profile({ dob: null }));
      expect(await tool("numerology", n).run(ctx, {})).toMatchObject({ error: "no_birth_details" });
      getProfile.mockResolvedValue(profile({ name: null }));
      expect(await tool("numerology", n).run(ctx, {})).toMatchObject({ error: "no_name" });
      getProfile.mockResolvedValue(profile({ name: "राहुल शर्मा" }));
      expect(await tool("numerology", n).run(ctx, {})).toMatchObject({ error: "name_needs_english_letters" });
    }
    expect(astroCall).not.toHaveBeenCalled();
  });

  it("name_spelling overrides a non-English saved name for this call", async () => {
    getProfile.mockResolvedValue(profile({ name: "राहुल शर्मा" }));
    astroCall.mockResolvedValue(ok(TABLE));
    await tool("numerology", "my_numbers").run(ctx, { name_spelling: "Rahul Sharma" });
    expect(calls("numero_table")[0][2].name).toBe("Rahul Sharma");
  });

  it("numerology_report clips the long description at a sentence", async () => {
    getProfile.mockResolvedValue(profile());
    const description = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about the radical number.`).join(" ");
    astroCall.mockResolvedValue(ok({ title: "What the Number Says About You", description }));
    const r: any = await tool("numerology", "numerology_report").run(ctx, {});
    expect(calls("numero_report")[0][2]).toEqual({ name: "Rahul Sharma", day: 15, month: 8, year: 1990 });
    expect(r.report.length).toBeLessThanOrEqual(700);
    expect(r.report.endsWith(".")).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("numerology_today uses the daily endpoint with a day cache", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockResolvedValue(ok({ prediction: "Today is a good day.", lucky_color: "Dark green", lucky_number: "1", prediction_date: "2-10-2026" }));
    const r: any = await tool("numerology", "numerology_today").run(ctx, {});
    expect(astroCall.mock.calls[0][1]).toBe("numero_prediction/daily");
    expect(astroCall.mock.calls[0][3]).toMatchObject({ ttl: "day" });
    expect(r).toEqual({ date: "2-10-2026", prediction: "Today is a good day.", lucky_colour: "Dark green", lucky_number: "1" });
  });

  it("an API name rejection becomes name_rejected", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockResolvedValue(bad("Please enter a valid name!!"));
    expect(await tool("numerology", "numerology_report").run(ctx, {})).toMatchObject({ error: "name_rejected" });
  });

  it("summariseNumeroTable tolerates an empty answer", () => {
    expect(summariseNumeroTable({}).lucky.colour).toBeUndefined();
  });
});

describe("tarot", () => {
  it("randomInt stays in range and drawDistinct never repeats", () => {
    for (let i = 0; i < 500; i++) { const n = randomInt(1, 22); expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(22); }
    for (let i = 0; i < 200; i++) {
      const d = drawDistinct(3, 78);
      expect(new Set(d).size).toBe(3);
      for (const x of d) { expect(x).toBeGreaterThanOrEqual(1); expect(x).toBeLessThanOrEqual(78); }
    }
    expect(drawDistinct(5, 3).sort()).toEqual([1, 2, 3]);
    let k = 0;
    expect(drawDistinct(3, 78, () => [7, 7, 9, 7, 12][k++])).toEqual([7, 9, 12]);
  });

  it("inferTopic honours the model, then reads the question", () => {
    expect(inferTopic("anything", "career")).toBe("career");
    expect(inferTopic("Will I get the job?", undefined)).toBe("career");
    expect(inferTopic("Should I invest in property?", undefined)).toBe("finance");
    expect(inferTopic("Will he come back?", undefined)).toBe("yes_no");
    expect(inferTopic("Will I find love this year?", undefined)).toBe("love");
    expect(inferTopic("Tell me about my relationship", undefined)).toBe("love");
  });

  it("yes/no draw sends tarot_id in 1..22 uncached and returns the named card", async () => {
    astroCall.mockResolvedValue(ok({ name: "The Hermit", value: "No", description: "Right now you are in the process of self-discovery." }));
    const r: any = await tool("tarot", "draw_tarot").run(ctx, { question: "Should I move cities?", spread: "one", topic: "yes_no" });
    const [, path, body, opts] = astroCall.mock.calls[0];
    expect(path).toBe("yes_no_tarot");
    expect(Object.keys(body)).toEqual(["tarot_id"]);
    expect(body.tarot_id).toBeGreaterThanOrEqual(1);
    expect(body.tarot_id).toBeLessThanOrEqual(22);
    expect(opts.ttl).toBe("none");
    expect(r).toMatchObject({ spread: "one", card: "The Hermit", answer: "No" });
    expect(cards[0].items).toEqual([{ label: "Card", value: "The Hermit" }, { label: "Answer", value: "No" }]);
  });

  it("a yes/no answer that is neither Yes nor No is treated as unavailable", async () => {
    astroCall.mockResolvedValue(ok({ name: "The Hermit", value: "Maybe", description: "x" }));
    expect(await tool("tarot", "draw_tarot").run(ctx, { question: "Will it rain?", topic: "yes_no" })).toMatchObject({ error: "astro_unavailable" });
  });

  it("single-topic draw uses one id (1..78) for all three keys and returns only that area, without naming a card", async () => {
    astroCall.mockResolvedValue(ok({ love: "Love is in the air. " + "x".repeat(900), career: "career text", finance: "finance text" }));
    const r: any = await tool("tarot", "draw_tarot").run(ctx, { question: "What about my love life?", spread: "one", topic: "love" });
    const body = astroCall.mock.calls[0][2];
    expect(astroCall.mock.calls[0][1]).toBe("tarot_predictions");
    expect(body.love).toBe(body.career);
    expect(body.love).toBe(body.finance);
    expect(body.love).toBeGreaterThanOrEqual(1);
    expect(body.love).toBeLessThanOrEqual(78);
    expect(r.topic).toBe("love");
    expect(r.reading.length).toBeLessThanOrEqual(520);
    expect(r.note).toMatch(/Do not name/);
    expect(r.card).toBeUndefined();
  });

  it("three-card spread draws three DIFFERENT ids and returns clipped love/career/finance readings", async () => {
    astroCall.mockResolvedValue(ok({ love: "L. " + "a".repeat(800), career: "C. " + "b".repeat(800), finance: "F. " + "c".repeat(800) }));
    const r: any = await tool("tarot", "draw_tarot").run(ctx, { question: "Show me everything", spread: "three" });
    const body = astroCall.mock.calls[0][2];
    expect(new Set([body.love, body.career, body.finance]).size).toBe(3);
    expect(r.spread).toBe("three");
    expect(r.readings.map((x: any) => x.area)).toEqual(["love", "career", "finance"]);
    for (const x of r.readings) expect(x.reading.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(r).length).toBeLessThan(2000);
    expect(cards[0].items.map((i: any) => i.label)).toEqual(["Love", "Career", "Finance"]);
  });

  it("needs no profile at all, and an API failure is reported softly", async () => {
    astroCall.mockResolvedValue(bad("Cannot read properties of undefined (reading 'love')"));
    expect(await tool("tarot", "draw_tarot").run(ctx, { question: "x", spread: "three" })).toMatchObject({ error: "astro_unavailable" });
    expect(getProfile).not.toHaveBeenCalled();
  });
});

describe("marriage", () => {
  const ASHT = {
    varna: { total_points: 1, received_points: 1 }, vashya: { total_points: 2, received_points: 1 }, tara: { total_points: 3, received_points: 3 },
    yoni: { total_points: 4, received_points: 4 }, maitri: { total_points: 5, received_points: 5 }, gan: { total_points: 6, received_points: 5 },
    bhakut: { total_points: 7, received_points: 0 }, nadi: { total_points: 8, received_points: 8 },
    total: { total_points: 36, received_points: 27, minimum_required: 18 },
    conclusion: { status: true, report: "The match has scored 27 points outs of 36 points. This is a reasonably good score." },
  };
  const DASHA = { total: { total_points: 36, received_points: 21, minimum_required: 18 } };
  const MANGLIK = {
    male: { is_present: false, manglik_status: "INEFFECTIVE", percentage_manglik_after_cancellation: 19.5, is_mars_manglik_cancelled: true, manglik_report: "Manglik Dosha is present, but it is very weak." },
    female: { is_present: true, manglik_status: "HIGHLY_EFFECTIVE", percentage_manglik_after_cancellation: 38.25, is_mars_manglik_cancelled: false, manglik_report: "Manglik Dosha is very strong." },
    conclusion: { match: false, report: "The boy is not Manglik. The girl is, however, Manglik." },
  };
  const REPORT = { ashtakoota: { status: true, received_points: 27 }, manglik: { status: false }, rajju_dosha: { status: false }, vedha_dosha: { status: false }, conclusion: { match_report: "Mangal Dosha exists; however you can go ahead." } };
  const answer = async (_e: unknown, path: string) =>
    path === "match_ashtakoot_points" ? ok(ASHT) : path === "match_dashakoot_points" ? ok(DASHA) : path === "match_manglik_report" ? ok(MANGLIK) : path === "match_making_report" ? ok(REPORT) : bad("unexpected " + path);
  const partnerArgs = { partner_name: "Priya", dob: "1993-02-03", tob: "14:15", place: "New Delhi" };

  beforeEach(() => {
    geoLookup.mockResolvedValue({ ok: true, data: [{ place_name: "New Delhi", lat: 28.61, lon: 77.21, timezone_id: "Asia/Kolkata", country_code: "IN" }] });
    tzoneFor.mockResolvedValue({ ok: true, data: 5.5 });
  });

  it("buildMatchBody puts the male on m_* and the female on f_*", () => {
    const me = { day: 15, month: 8, year: 1990, hour: 10, min: 30, lat: 19.07, lon: 72.88, tzone: 5.5 };
    const her = { day: 3, month: 2, year: 1993, hour: 14, min: 15, lat: 28.61, lon: 77.21, tzone: 5.5 };
    const asMale = buildMatchBody("male", me, her);
    expect(asMale).toMatchObject({ m_day: 15, m_lat: 19.07, f_day: 3, f_lon: 77.21, f_tzone: 5.5 });
    expect(Object.keys(asMale).sort()).toEqual(["f_day", "f_hour", "f_lat", "f_lon", "f_min", "f_month", "f_tzone", "f_year", "m_day", "m_hour", "m_lat", "m_lon", "m_min", "m_month", "m_tzone", "m_year"]);
    const asFemale = buildMatchBody("female", me, her);
    expect(asFemale).toMatchObject({ m_day: 3, f_day: 15, f_lat: 19.07 });
  });

  it("match_partner calls four endpoints with the verified m_/f_ body and summarises them", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockImplementation(answer);
    const r: any = await tool("marriage", "match_partner").run(ctx, partnerArgs);
    for (const p of ["match_ashtakoot_points", "match_dashakoot_points", "match_manglik_report", "match_making_report"]) {
      expect(calls(p)).toHaveLength(1);
      expect(calls(p)[0][2]).toMatchObject({ m_day: 15, m_month: 8, m_year: 1990, m_hour: 10, m_min: 30, f_day: 3, f_month: 2, f_year: 1993, f_hour: 14, f_min: 15, f_lat: 28.61 });
    }
    expect(geoLookup.mock.calls[0][1]).toBe("New Delhi");
    expect(tzoneFor.mock.calls[0][3]).toBe("03-02-1993");
    expect(r.partner).toBe("Priya");
    expect(r.approximate).toBe(false);
    expect(r.ashtakoot).toMatchObject({ score: "27 out of 36", minimum_needed: 18, enough: true, koots_with_zero: ["bhakut"] });
    expect(r.dashakoot).toEqual({ score: "21 out of 36", minimum_needed: 18, enough: true });
    expect(r.manglik.customer).toMatchObject({ manglik: false, strength: "INEFFECTIVE", cancelled: true });
    expect(r.manglik.partner).toMatchObject({ manglik: true, strength: "HIGHLY_EFFECTIVE" });
    expect(r.manglik.balanced).toBe(false);
    expect(r.other_doshas).toMatchObject({ rajju_dosha: false, vedha_dosha: false });
    expect(JSON.stringify(r).length).toBeLessThan(2500);
    expect(cards[0].items.map((i: any) => i.label)).toEqual(["Ashtakoot", "Dashakoot", "Manglik"]);
  });

  it("a female customer is the f_* side and her manglik is reported as the customer's", async () => {
    getProfile.mockResolvedValue(profile({ gender: "female" }));
    astroCall.mockImplementation(answer);
    const r: any = await tool("marriage", "match_partner").run(ctx, partnerArgs);
    expect(calls("match_ashtakoot_points")[0][2]).toMatchObject({ f_day: 15, m_day: 3 });
    expect(r.manglik.customer.manglik).toBe(true);
    expect(r.manglik.partner.manglik).toBe(false);
  });

  it("unknown partner birth time is approximate (12:00)", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockImplementation(answer);
    const r: any = await tool("marriage", "match_partner").run(ctx, { ...partnerArgs, tob: undefined, tob_unknown: true });
    expect(r.approximate).toBe(true);
    expect(calls("match_ashtakoot_points")[0][2]).toMatchObject({ f_hour: 12, f_min: 0 });
  });

  it("missing gender returns gender_unknown, unless partner_gender gives the other side", async () => {
    getProfile.mockResolvedValue(profile({ gender: null }));
    astroCall.mockImplementation(answer);
    expect(await tool("marriage", "match_partner").run(ctx, partnerArgs)).toMatchObject({ error: "gender_unknown" });
    expect(astroCall).not.toHaveBeenCalled();
    await tool("marriage", "match_partner").run(ctx, { ...partnerArgs, partner_gender: "female" });
    expect(calls("match_ashtakoot_points")[0][2]).toMatchObject({ m_day: 15, f_day: 3 });
  });

  it("input errors never reach the API", async () => {
    const run = (a: Record<string, unknown>) => tool("marriage", "match_partner").run(ctx, a);
    getProfile.mockResolvedValue(null);
    expect(await run(partnerArgs)).toMatchObject({ error: "no_birth_details" });
    getProfile.mockResolvedValue(profile());
    expect(await run({ ...partnerArgs, dob: "03/02/1993" })).toMatchObject({ error: "bad_partner_dob" });
    expect(await run({ ...partnerArgs, dob: "1993-02-31" })).toMatchObject({ error: "bad_partner_dob" });
    expect(await run({ ...partnerArgs, place: " " })).toMatchObject({ error: "no_partner_place" });
    geoLookup.mockResolvedValue({ ok: true, data: [] });
    expect(await run(partnerArgs)).toMatchObject({ error: "partner_place_not_found" });
    expect(astroCall).not.toHaveBeenCalled();
  });

  it("only ashtakoot is required: the other three failing still returns the score", async () => {
    getProfile.mockResolvedValue(profile());
    astroCall.mockImplementation(async (_e: unknown, path: string) => (path === "match_ashtakoot_points" ? ok(ASHT) : bad("x")));
    const r: any = await tool("marriage", "match_partner").run(ctx, partnerArgs);
    expect(r.ashtakoot.score).toBe("27 out of 36");
    expect(r.dashakoot).toBeUndefined();
    expect(r.manglik).toBeUndefined();
    astroCall.mockResolvedValue(bad("astro_not_configured"));
    expect(await tool("marriage", "match_partner").run(ctx, partnerArgs)).toMatchObject({ error: "astro_unavailable" });
  });

  it("summarisers are safe on empty input", () => {
    expect(summariseAshtakoot({}).score).toBeUndefined();
    expect(summariseManglikMatch({}, "male").customer.manglik).toBeUndefined();
  });
});
