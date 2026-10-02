import { describe, it, expect } from "vitest";
import type { AstroResult } from "../../astrology";
import type { PrepDeps } from "./deps";
import { buildAstrologyCards, buildMatchBody, resolveBirth, APPROX_NOTE } from "./astrology";
import { buildNumerologyCards, luckyFromTable, ownNames } from "./numerology";
import { buildTarotCards, spreadOf } from "./tarot";
import { buildPalmCards, type PhotoRow } from "./palmistry";
import { buildFaceCards } from "./face";
import { classifyVisionId, extractVisionId, splitPalm, toBase64 } from "./vision";
import { normaliseCards, prepStatusOf, missing, ok } from "./shared";
import { ageFromDob, customerFromIntake, orderCards } from "./file_dto";
import { CARD_KEYS } from "../types";
import type { AstrologyIntake, BirthBlock, NumerologyIntake, TarotIntake, PalmistryIntake, FaceIntake } from "../types";

const good = (data: any): AstroResult<any> => ({ ok: true, data });
const bad = (error: string, status = 400): AstroResult<any> => ({ ok: false, error, status });

function deps(map: Record<string, AstroResult<any>>, calls: { path: string; body: any }[] = []): PrepDeps {
  return {
    call: async (path, body) => { calls.push({ path, body }); return map[path] ?? bad("http_404", 404); },
    geo: async (p) => (p === "Nowhere" ? null : { lat: 30.3, lon: 78 }),
    tzone: async () => 5.5,
  };
}

const birth = (o: Partial<BirthBlock> = {}): BirthBlock => ({ name: "Asha", gender: "female", dob: "1990-05-12", tob: "06:30", tob_unknown: false, place: "Dehradun", lat: null, lon: null, tzone: null, ...o });
const astroIntake = (o: Partial<AstrologyIntake> = {}): AstrologyIntake => ({ kind: "astrology", birth: birth(), focus: ["career"], ...o });

describe("shared", () => {
  it("normaliseCards yields exactly CARD_KEYS in order, filling gaps as missing and dropping strays", () => {
    const out = normaliseCards("tarot", [ok("yes_no", 1), ok("bogus", 2), ok("spread", 3)]);
    expect(out.map((c) => c.key)).toEqual(CARD_KEYS.tarot);
    expect(out.find((c) => c.key === "readings")?.status).toBe("missing");
  });
  it("prepStatusOf: ready / partial / failed", () => {
    expect(prepStatusOf([ok("a", 1), ok("b", 1)])).toBe("ready");
    expect(prepStatusOf([ok("a", 1), missing("b", "x")])).toBe("partial");
    expect(prepStatusOf([missing("a", "x"), missing("b", "x")])).toBe("failed");
  });
});

describe("resolveBirth", () => {
  it("uses the block's lat/lon/tzone and exact time", async () => {
    const r = await resolveBirth(birth({ lat: 28.6, lon: 77.2, tzone: 5.5 }), deps({}));
    expect(r.ok && r.birth).toEqual({ body: { day: 12, month: 5, year: 1990, hour: 6, min: 30, lat: 28.6, lon: 77.2, tzone: 5.5 }, approximate: false });
  });
  it("looks the place up and uses 12:00 when the time is unknown", async () => {
    const r = await resolveBirth(birth({ tob: null, tob_unknown: true }), deps({}));
    expect(r.ok && r.birth.approximate).toBe(true);
    expect(r.ok && [r.birth.body.hour, r.birth.body.min, r.birth.body.lat]).toEqual([12, 0, 30.3]);
  });
  it("fails on unknown place or bad dob", async () => {
    expect((await resolveBirth(birth({ place: "Nowhere" }), deps({}))).ok).toBe(false);
    expect((await resolveBirth(birth({ dob: "nope" }), deps({}))).ok).toBe(false);
  });
});

describe("buildMatchBody", () => {
  const a = { day: 1, month: 2, year: 1990, hour: 3, min: 4, lat: 5, lon: 6, tzone: 5.5 };
  const b = { ...a, day: 9 };
  it("male customer is the m_ side", () => {
    expect(buildMatchBody("male", a, b).m_day).toBe(1);
    expect(buildMatchBody("male", a, b).f_day).toBe(9);
    expect(buildMatchBody("female", a, b).m_day).toBe(9);
    expect(buildMatchBody("female", a, b).f_day).toBe(1);
  });
});

describe("buildAstrologyCards", () => {
  const map: Record<string, AstroResult<any>> = {
    birth_details: good({ sunrise: "6:19" }), astro_details: good({ sign: "Taurus" }),
    "horo_chart_image/D1": good({ svg: "<svg/>" }), "horo_chart_image/D9": bad("http_500", 500),
    planets: good([{ name: "Sun", sign: "Aries", house: 12 }]), current_vdasha: good({ major: { planet: "Jupiter" } }), major_vdasha: good([]),
    manglik: good({ is_present: false }), kalsarpa_details: bad("x"), sadhesati_current_status: good({}), pitra_dosha_report: good({}),
    basic_panchang: good({ tithi: "Panchami" }), puja_suggestion: good({}), basic_gem_suggestion: good({}), rudraksha_suggestion: good({}),
  };
  it("produces exactly the astrology keys; one failed chart is missing, partial doshas keep a note", async () => {
    const cards = normaliseCards("astrology", await buildAstrologyCards(astroIntake(), deps(map)));
    expect(cards.map((c) => c.key)).toEqual(CARD_KEYS.astrology);
    expect(cards.find((c) => c.key === "chart_d1")?.status).toBe("ok");
    expect(cards.find((c) => c.key === "chart_d9")?.status).toBe("missing");
    expect(cards.find((c) => c.key === "planets")?.api).toEqual([{ name: "Sun", sign: "Aries", house: 12 }]);
    const d = cards.find((c) => c.key === "doshas")!;
    expect(d.status).toBe("ok");
    expect(d.note).toContain("kalsarpa");
    expect(cards.find((c) => c.key === "match")?.status).toBe("ok"); // not applicable, no partner
    expect(cards.find((c) => c.key === "match")?.api).toBeNull();
  });
  it("unknown birth time: time-sensitive cards carry the approximate note, panchang does not", async () => {
    const cards = await buildAstrologyCards(astroIntake({ birth: birth({ tob: null, tob_unknown: true }) }), deps(map));
    expect(cards.find((c) => c.key === "planets")?.note).toContain(APPROX_NOTE);
    expect(cards.find((c) => c.key === "dasha")?.note).toContain(APPROX_NOTE);
    expect(cards.find((c) => c.key === "panchang")?.note).toBeUndefined();
  });
  it("partner given: match card calls the four match endpoints with a m_/f_ body", async () => {
    const calls: { path: string; body: any }[] = [];
    const m = { ...map, match_ashtakoot_points: good({ total: { received_points: 24 } }), match_dashakoot_points: good({}), match_manglik_report: good({}), match_making_report: good({}) };
    const cards = await buildAstrologyCards(astroIntake({ partner: birth({ name: "Ravi", gender: "male", place: "Delhi" }) }), deps(m, calls));
    const match = cards.find((c) => c.key === "match")!;
    expect(match.status).toBe("ok");
    expect((match.api as any).ashtakoot.total.received_points).toBe(24);
    const call = calls.find((c) => c.path === "match_ashtakoot_points")!;
    expect(call.body.f_day).toBe(12); // customer is female
    expect(call.body.m_lat).toBe(30.3);
  });
  it("unresolvable birth place makes every card missing with the reason", async () => {
    const cards = await buildAstrologyCards(astroIntake({ birth: birth({ place: "Nowhere" }) }), deps(map));
    expect(cards).toHaveLength(9);
    expect(cards.every((c) => c.status === "missing")).toBe(true);
  });
});

describe("buildNumerologyCards", () => {
  const intake: NumerologyIntake = { kind: "numerology", birth_name: "Davy Kumar", used_name: "Dave Kumar", dob: "1990-11-29", mobile: "+91 98765 43210", names_to_check: ["Davy Kumaar"] };
  const map: Record<string, AstroResult<any>> = {
    numero_table: good({ destiny_number: 5, radical_number: 2, name_number: 7, radical_ruler: "Moon", fav_color: "White", fav_day: "Monday", friendly_num: "1,2", fav_stone: "Pearl", fav_metal: "Silver", fav_god: "Shiva", fav_mantra: "Om", evil_num: "8" }),
    numero_report: good({ title: "Radical 2", description: "You are sensitive." }),
    "numero_prediction/daily": good({ prediction: "A calm day.", lucky_color: "Blue", lucky_number: "3", prediction_date: "02-10-2026" }),
  };
  it("builds all six cards with our own totals alongside the API", async () => {
    const cards = normaliseCards("numerology", await buildNumerologyCards(intake, deps(map)));
    expect(cards.map((c) => c.key)).toEqual(CARD_KEYS.numerology);
    expect(cards.every((c) => c.status === "ok")).toBe(true);
    const core = cards[0].api as any;
    expect(core.own.destiny.root).toBe(5);
    expect(core.mobile.root).toBe(9);
    expect(core.api.name_number).toBe(7);
    expect((cards.find((c) => c.key === "names")!.api as any).names).toHaveLength(3);
    expect((cards.find((c) => c.key === "lucky")!.api as any).colour).toBe("White");
  });
  it("API down: our own numbers still show, API cards are missing", async () => {
    const cards = await buildNumerologyCards(intake, deps({ numero_table: bad("astro_not_configured", 0), numero_report: bad("astro_not_configured", 0), "numero_prediction/daily": bad("astro_not_configured", 0) }));
    expect(cards.find((c) => c.key === "core_numbers")?.status).toBe("ok");
    expect(cards.find((c) => c.key === "lo_shu")?.status).toBe("ok");
    expect(cards.find((c) => c.key === "lucky")?.status).toBe("missing");
    expect(cards.find((c) => c.key === "report")?.status).toBe("missing");
  });
  it("helpers", () => {
    expect(luckyFromTable({ fav_color: " Red ", fav_day: "" })).toEqual({ colour: "Red" });
    expect(ownNames({ ...intake, used_name: "Davy Kumar" }).map((n) => n.label)).toEqual(["Birth name", "To check"]);
  });
});

describe("buildTarotCards", () => {
  const intake: TarotIntake = { kind: "tarot", name: "Meera", question: "Which way?", cards: { love: 1, career: 23, finance: 78 }, reversed: { career: true }, yes_no: { question: "Should I move?", card: 2 } };
  const map: Record<string, AstroResult<any>> = {
    tarot_predictions: good({ love: "L text", career: "C text", finance: "F text" }),
    yes_no_tarot: good({ name: "The Magician", value: "Yes", description: "Act." }),
  };
  it("names cards from our deck and keeps reversal", () => {
    const s = spreadOf(intake)!;
    expect(s.map((c) => c.name)).toEqual(["The Fool", "Ace of Wands", "King of Pentacles"]);
    expect(s[1].reversed).toBe(true);
    expect(s[1].meaning).toBe("A delayed start or lack of drive.");
    expect(spreadOf({ ...intake, cards: { love: 0, career: 1, finance: 2 } })).toBeNull();
  });
  it("builds spread, readings and yes_no", async () => {
    const cards = normaliseCards("tarot", await buildTarotCards(intake, deps(map)));
    expect(cards.map((c) => c.status)).toEqual(["ok", "ok", "ok"]);
    expect((cards[1].api as any).career).toBe("C text");
    expect((cards[2].api as any).answer).toBe("Yes");
  });
  it("no yes/no question is ok+null; API failure is missing", async () => {
    const cards = await buildTarotCards({ ...intake, yes_no: null }, deps({ tarot_predictions: bad("boom", 500) }));
    expect(cards.find((c) => c.key === "yes_no")).toMatchObject({ status: "ok", api: null });
    expect(cards.find((c) => c.key === "readings")?.status).toBe("missing");
    expect(cards.find((c) => c.key === "spread")?.status).toBe("ok");
  });
  it("yes/no id out of range is missing", async () => {
    const cards = await buildTarotCards({ ...intake, yes_no: { question: "q", card: 40 } }, deps(map));
    expect(cards.find((c) => c.key === "yes_no")?.status).toBe("missing");
  });
});

describe("vision", () => {
  it("extracts ids from likely shapes", () => {
    expect(extractVisionId({ palm_id: "abc" })).toBe("abc");
    expect(extractVisionId({ data: { id: 7 } })).toBe("7");
    expect(extractVisionId({})).toBeNull();
  });
  it("classifies: accepted / rejected / unchecked on outage", () => {
    expect(classifyVisionId(good({ face_id: "f1" }))).toEqual({ state: "accepted", id: "f1", reason: null });
    expect(classifyVisionId(bad("No palm detected in the image", 400)).state).toBe("rejected");
    expect(classifyVisionId(bad("astro_not_configured", 0)).state).toBe("unchecked");
    expect(classifyVisionId(bad("http_503", 503)).state).toBe("unchecked");
    expect(classifyVisionId(bad("denied", 403)).state).toBe("unchecked");
    expect(classifyVisionId(good({ weird: 1 })).state).toBe("unchecked");
  });
  it("base64 round-trips a large buffer", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    const back = Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0));
    expect(back.length).toBe(bytes.length);
    expect(back[99_999]).toBe(bytes[99_999]);
  });
  it("splitPalm sorts lines, mounts, hand type", () => {
    const s = splitPalm({ hand_type: "Fire", life_line: "long", heart_line: "deep", mount_of_venus: "full", summary: "x" });
    expect(s.type).toBe("Fire");
    expect(Object.keys(s.lines)).toEqual(["life_line", "heart_line"]);
    expect(Object.keys(s.parts)).toEqual(["mount_of_venus"]);
    expect(Object.keys(s.rest)).toEqual(["summary"]);
  });
});

describe("palm / face cards", () => {
  const palm: PalmistryIntake = { kind: "palmistry", dominant_hand: "right", focus: [] };
  const photos: PhotoRow[] = [{ kind: "palm_right", api_id: "p1", status: "accepted", reason: null }, { kind: "palm_left", api_id: null, status: "uploaded", reason: null }];
  it("palm: readings by id fill the cards", async () => {
    const calls: { path: string; body: any }[] = [];
    const cards = normaliseCards("palmistry", await buildPalmCards(palm, photos, deps({ "palmistry/get-palm-reading/p1": good({ hand_type: "Earth", life_line: "long", mount_of_moon: "high", note: "n" }) }, calls)));
    expect(cards.map((c) => c.key)).toEqual(CARD_KEYS.palmistry);
    expect(cards.every((c) => c.status === "ok")).toBe(true);
    expect((cards.find((c) => c.key === "lines")!.api as any).palm_right.life_line).toBe("long");
    expect(calls).toHaveLength(1);
  });
  it("palm: reading endpoint failing leaves photos ok and the rest missing", async () => {
    const cards = await buildPalmCards(palm, photos, deps({}));
    expect(cards.find((c) => c.key === "palm_photos")?.status).toBe("ok");
    expect(cards.filter((c) => c.status === "missing").map((c) => c.key)).toEqual(["hand_type", "lines", "mounts", "readings"]);
  });
  it("palm: only rejected photos -> everything missing", async () => {
    const cards = await buildPalmCards(palm, [{ kind: "palm_right", api_id: null, status: "rejected", reason: "blurry" }], deps({}));
    expect(cards).toHaveLength(5);
    expect(cards.every((c) => c.status === "missing")).toBe(true);
  });
  it("face: builds features + readings", async () => {
    const face: FaceIntake = { kind: "face_reading", focus: [] };
    const cards = normaliseCards("face_reading", await buildFaceCards(face, [{ kind: "face_front", api_id: "f1", status: "accepted", reason: null }],
      deps({ "face-reading/get-face-reading/f1": good({ face_shape: "Oval", eyes: "wide", summary: "calm" }) })));
    expect(cards.map((c) => c.key)).toEqual(CARD_KEYS.face_reading);
    expect(cards.every((c) => c.status === "ok")).toBe(true);
  });
});

describe("file dto", () => {
  const now = Date.UTC(2026, 9, 2);
  it("age from dob", () => {
    expect(ageFromDob("1990-10-03", now)).toBe(35);
    expect(ageFromDob("1990-10-02", now)).toBe(36);
    expect(ageFromDob("bad", now)).toBeNull();
    expect(ageFromDob(null, now)).toBeNull();
  });
  it("customer from intake", () => {
    expect(customerFromIntake(astroIntake({ current_city: "Pune" }), now)).toEqual({ name: "Asha", city: "Pune", age: 36 });
    expect(customerFromIntake({ kind: "palmistry", dominant_hand: "left", age: 41, focus: [] }, now).age).toBe(41);
  });
  it("orderCards returns exactly the keys, placeholders for absent rows, parsed JSON", () => {
    const out = orderCards("face_reading", [{ key: "readings", title: "Readings", api_json: '{"a":1}', override_json: '"edited"', edited_by: "u1", edited_at: 5, status: "ok", note: null }]);
    expect(out.map((c) => c.key)).toEqual(CARD_KEYS.face_reading);
    expect(out[2]).toMatchObject({ api: { a: 1 }, override: "edited", edited_by: "u1" });
    expect(out[0]).toMatchObject({ status: "missing", note: "Not prepared yet" });
  });
});
