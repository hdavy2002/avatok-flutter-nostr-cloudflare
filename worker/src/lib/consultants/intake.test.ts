import { describe, it, expect } from "vitest";
import { validateIntake, validateQuestions, validDob } from "./intake";

const NOW = Date.parse("2026-10-02T00:00:00Z");
const birth = { name: " Asha  Rao ", gender: "female", dob: "1990-05-17", tob: "06:30", tob_unknown: false, place: "Dehradun", lat: 30.3, lon: 78, tzone: 5.5 };

describe("validDob", () => {
  it("accepts real past dates only", () => {
    expect(validDob("1990-05-17", NOW)).toBe(true);
    expect(validDob("1990-02-30", NOW)).toBe(false);
    expect(validDob("2030-01-01", NOW)).toBe(false);
    expect(validDob("1899-12-31", NOW)).toBe(false);
    expect(validDob("17-05-1990", NOW)).toBe(false);
    expect(validDob(19900517, NOW)).toBe(false);
  });
});

describe("validateIntake astrology", () => {
  it("accepts and sanitises", () => {
    const r = validateIntake("astrology", { kind: "astrology", birth, focus: ["career", "career", " love "], evil: "x" }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === "astrology") {
      expect(r.value.birth.name).toBe("Asha Rao");
      expect(r.value.focus).toEqual(["career", "love"]);
      expect("evil" in r.value).toBe(false);
    }
  });
  it("kind must match discipline", () => {
    const r = validateIntake("palmistry", { kind: "astrology", birth, focus: [] }, NOW);
    expect(r.ok).toBe(false);
  });
  it("tob required unless unknown", () => {
    const r = validateIntake("astrology", { kind: "astrology", birth: { ...birth, tob: null }, focus: [] }, NOW);
    expect(r).toMatchObject({ ok: false, field: "birth.tob" });
    const u = validateIntake("astrology", { kind: "astrology", birth: { ...birth, tob: null, tob_unknown: true }, focus: [] }, NOW);
    expect(u.ok).toBe(true);
  });
  it("rejects bad coordinates, gender, partner", () => {
    expect(validateIntake("astrology", { kind: "astrology", birth: { ...birth, lat: 200 }, focus: [] }, NOW).ok).toBe(false);
    expect(validateIntake("astrology", { kind: "astrology", birth: { ...birth, gender: "x" }, focus: [] }, NOW).ok).toBe(false);
    const p = validateIntake("astrology", { kind: "astrology", birth, focus: [], partner: { ...birth, dob: "nope" } }, NOW);
    expect(p).toMatchObject({ ok: false, field: "partner.dob" });
  });
  it("caps focus at 8", () => {
    const r = validateIntake("astrology", { kind: "astrology", birth, focus: Array.from({ length: 9 }, (_, i) => `f${i}`) }, NOW);
    expect(r.ok).toBe(false);
  });
});

describe("validateIntake numerology", () => {
  it("ok + mobile normalised", () => {
    const r = validateIntake("numerology", { kind: "numerology", birth_name: "Asha Rao", dob: "1990-05-17", mobile: "98765 43210", names_to_check: ["A B"] }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === "numerology") expect(r.value.mobile).toBe("9876543210");
  });
  it("rejects short name, bad mobile, too many names", () => {
    expect(validateIntake("numerology", { kind: "numerology", birth_name: "A", dob: "1990-05-17" }, NOW).ok).toBe(false);
    expect(validateIntake("numerology", { kind: "numerology", birth_name: "Asha", dob: "1990-05-17", mobile: "12" }, NOW).ok).toBe(false);
    expect(validateIntake("numerology", { kind: "numerology", birth_name: "Asha", dob: "1990-05-17", names_to_check: ["a", "b", "c", "d", "e", "f"] }, NOW).ok).toBe(false);
  });
});

describe("validateIntake palmistry / face", () => {
  it("palmistry", () => {
    expect(validateIntake("palmistry", { kind: "palmistry", dominant_hand: "left", age: 31, focus: ["career"] }, NOW).ok).toBe(true);
    expect(validateIntake("palmistry", { kind: "palmistry", dominant_hand: "both", focus: [] }, NOW).ok).toBe(false);
    expect(validateIntake("palmistry", { kind: "palmistry", dominant_hand: "left", age: 2, focus: [] }, NOW).ok).toBe(false);
  });
  it("face", () => {
    expect(validateIntake("face_reading", { kind: "face_reading", focus: [] }, NOW).ok).toBe(true);
    expect(validateIntake("face_reading", { kind: "face_reading", focus: [], dob: "2999-01-01" }, NOW).ok).toBe(false);
  });
});

describe("validateIntake tarot", () => {
  const ok = { kind: "tarot", name: "Asha", question: "Will I change jobs?", cards: { love: 1, career: 22, finance: 77 } };
  it("ok", () => { expect(validateIntake("tarot", ok, NOW).ok).toBe(true); });
  it("cards distinct, in range, integers", () => {
    expect(validateIntake("tarot", { ...ok, cards: { love: 1, career: 1, finance: 2 } }, NOW).ok).toBe(false);
    expect(validateIntake("tarot", { ...ok, cards: { love: 1, career: 2, finance: 78 } }, NOW).ok).toBe(false);
    expect(validateIntake("tarot", { ...ok, cards: { love: 1.5, career: 2, finance: 3 } }, NOW).ok).toBe(false);
  });
  it("yes/no card must be distinct", () => {
    expect(validateIntake("tarot", { ...ok, yes_no: { question: "Should I go?", card: 1 } }, NOW).ok).toBe(false);
    expect(validateIntake("tarot", { ...ok, yes_no: { question: "Should I go?", card: 5 } }, NOW).ok).toBe(true);
  });
  it("reversed flags are booleans", () => {
    expect(validateIntake("tarot", { ...ok, reversed: { love: "yes" } }, NOW).ok).toBe(false);
    expect(validateIntake("tarot", { ...ok, reversed: { love: true } }, NOW).ok).toBe(true);
  });
});

describe("validateIntake misc", () => {
  it("rejects non-objects / unknown discipline", () => {
    expect(validateIntake("tarot", null, NOW).ok).toBe(false);
    expect(validateIntake("tarot", [], NOW).ok).toBe(false);
    expect(validateIntake("nope" as never, { kind: "nope" }, NOW).ok).toBe(false);
  });
});

describe("validateQuestions", () => {
  it("trims, drops blanks, caps", () => {
    expect(validateQuestions([" a ", "", "b"])).toEqual({ ok: true, value: ["a", "b"] });
    expect(validateQuestions(undefined)).toEqual({ ok: true, value: [] });
    expect(validateQuestions(["x", "x", "x", "x", "x", "x"]).ok).toBe(false);
    expect(validateQuestions(["x".repeat(301)]).ok).toBe(false);
    expect(validateQuestions("hi").ok).toBe(false);
    expect(validateQuestions([5]).ok).toBe(false);
  });
});
