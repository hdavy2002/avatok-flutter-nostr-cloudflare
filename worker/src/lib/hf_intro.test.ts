import { describe, it, expect } from "vitest";
import {
  normalizeIntroMime, validateIntro, parseGeminiIntro, mergeFlags, cleanFlags, introCaption, parseIntroCaption, parseStoredFlags,
  INTRO_MIN_BYTES, INTRO_MAX_BYTES, TRANSCRIPT_MAX_CHARS,
} from "./hf_intro";

describe("normalizeIntroMime", () => {
  it("maps accepted types to a mime + extension", () => {
    expect(normalizeIntroMime("audio/mp4")).toEqual({ mime: "audio/mp4", ext: "m4a" });
    expect(normalizeIntroMime("audio/x-m4a")).toEqual({ mime: "audio/mp4", ext: "m4a" });
    expect(normalizeIntroMime("audio/aac")).toEqual({ mime: "audio/aac", ext: "aac" });
    expect(normalizeIntroMime("audio/ogg")).toEqual({ mime: "audio/ogg", ext: "ogg" });
    expect(normalizeIntroMime("audio/mpeg")).toEqual({ mime: "audio/mpeg", ext: "mp3" });
    expect(normalizeIntroMime("audio/wav")).toEqual({ mime: "audio/wav", ext: "wav" });
    expect(normalizeIntroMime("audio/x-wav")).toEqual({ mime: "audio/wav", ext: "wav" });
  });
  it("accepts codecs params and any casing", () => {
    expect(normalizeIntroMime("audio/webm;codecs=opus")).toEqual({ mime: "audio/webm", ext: "webm" });
    expect(normalizeIntroMime(" Audio/WebM ; codecs=opus ")).toEqual({ mime: "audio/webm", ext: "webm" });
  });
  it("rejects everything else", () => {
    for (const t of ["video/webm", "application/json", "image/png", "", null, undefined, "audio/flac"]) expect(normalizeIntroMime(t as string)).toBeNull();
  });
});

describe("validateIntro", () => {
  const okBytes = 500_000;
  it("accepts 30..300 seconds and rounds", () => {
    expect(validateIntro(30, okBytes)).toEqual({ ok: true, seconds: 30 });
    expect(validateIntro("300", okBytes)).toEqual({ ok: true, seconds: 300 });
    expect(validateIntro("45.6", okBytes)).toEqual({ ok: true, seconds: 46 });
  });
  it("too short / too long -> 422 with the owner messages", () => {
    const s = validateIntro(29.4, okBytes);
    expect(s).toMatchObject({ ok: false, status: 422, error: "too_short", message: "Please record at least 30 seconds." });
    const l = validateIntro(301, okBytes);
    expect(l).toMatchObject({ ok: false, status: 422, error: "too_long", message: "Please keep it under 5 minutes." });
  });
  it("missing or junk duration -> 400", () => {
    for (const v of [null, undefined, "", "abc", NaN, -5, 0]) expect(validateIntro(v, okBytes)).toMatchObject({ ok: false, status: 400, error: "bad_duration" });
  });
  it("size limits", () => {
    expect(validateIntro(60, INTRO_MAX_BYTES + 1)).toMatchObject({ ok: false, status: 413, error: "too_large" });
    expect(validateIntro(60, INTRO_MAX_BYTES)).toMatchObject({ ok: true });
    expect(validateIntro(60, INTRO_MIN_BYTES)).toMatchObject({ ok: true });
    expect(validateIntro(60, INTRO_MIN_BYTES - 1)).toMatchObject({ ok: false, status: 422, error: "too_small" });
  });
});

describe("parseGeminiIntro", () => {
  it("parses clean JSON", () => {
    const r = parseGeminiIntro('{"transcript":"नमस्ते, मैं मीना हूँ","flags":[{"type":"phone","text":"98765"}]}');
    expect(r).toEqual({ transcript: "नमस्ते, मैं मीना हूँ", flags: [{ type: "phone", text: "98765" }] });
  });
  it("strips code fences and prose around the JSON", () => {
    expect(parseGeminiIntro('```json\n{"transcript":"hello","flags":[]}\n```')).toEqual({ transcript: "hello", flags: [] });
    expect(parseGeminiIntro('Here you go: {"transcript":"hi","flags":[]} thanks')).toEqual({ transcript: "hi", flags: [] });
  });
  it("tolerates a bare array, missing keys and a non-string transcript", () => {
    expect(parseGeminiIntro('[{"type":"email","text":"a at b"}]')).toEqual({ transcript: null, flags: [{ type: "email", text: "a at b" }] });
    expect(parseGeminiIntro('{"flags":[]}')).toEqual({ transcript: null, flags: [] });
    expect(parseGeminiIntro('{"transcript":123,"flags":"none"}')).toEqual({ transcript: null, flags: [] });
  });
  it("returns null for unusable output and caps the transcript", () => {
    for (const t of ["", "not json at all", "null", "42"]) expect(parseGeminiIntro(t)).toBeNull();
    const big = parseGeminiIntro(JSON.stringify({ transcript: "a".repeat(TRANSCRIPT_MAX_CHARS + 500), flags: [] }));
    expect(big?.transcript?.length).toBe(TRANSCRIPT_MAX_CHARS);
  });
});

describe("cleanFlags", () => {
  it("coerces unknown types, drops empties, accepts strings, caps text", () => {
    const f = cleanFlags([{ type: "PHONE", text: " 98 " }, { type: "weird", text: "x" }, { type: "upi", text: "" }, "call me", 7, null, { type: "abuse", text: "y".repeat(500) }]);
    expect(f.map((x) => x.type)).toEqual(["phone", "other_contact", "other_contact", "abuse"]);
    expect(f[0].text).toBe("98");
    expect(f[3].text.length).toBe(120);
  });
  it("non-array -> []", () => { expect(cleanFlags("x")).toEqual([]); expect(cleanFlags(undefined)).toEqual([]); });
});

describe("mergeFlags", () => {
  it("adds a generic other_contact when contactLeak fires and Gemini flagged nothing", () => {
    const m = mergeFlags([], "you can call me on 98765 43210 anytime");
    expect(m).toHaveLength(1);
    expect(m[0].type).toBe("other_contact");
    expect(m[0].text).not.toContain("98765");
  });
  it("does not duplicate when Gemini already flagged a contact item", () => {
    const g = [{ type: "phone" as const, text: "98765 43210" }];
    expect(mergeFlags(g, "call 98765 43210")).toEqual(g);
  });
  it("an abuse-only flag does not suppress the contact flag", () => {
    const m = mergeFlags([{ type: "abuse", text: "bad word" }], "find me on instagram");
    expect(m.map((f) => f.type)).toEqual(["abuse", "other_contact"]);
  });
  it("clean transcript adds nothing; null transcript is fine; duplicates collapse", () => {
    expect(mergeFlags([], "I love chai and old songs")).toEqual([]);
    expect(mergeFlags([], null)).toEqual([]);
    expect(mergeFlags([{ type: "social", text: "Insta" }, { type: "social", text: "insta" }], "x")).toHaveLength(1);
  });
});

describe("stored shapes", () => {
  it("caption round-trips", () => {
    expect(parseIntroCaption(introCaption(75, "audio/mp4"))).toEqual({ seconds: 75, mime: "audio/mp4" });
    expect(parseIntroCaption("garbage")).toEqual({ seconds: null, mime: null });
    expect(parseIntroCaption(null)).toEqual({ seconds: null, mime: null });
  });
  it("parseStoredFlags tolerates bad JSON", () => {
    expect(parseStoredFlags("{bad")).toEqual([]);
    expect(parseStoredFlags('[{"type":"upi","text":"a@b"}]')).toEqual([{ type: "upi", text: "a@b" }]);
  });
});
