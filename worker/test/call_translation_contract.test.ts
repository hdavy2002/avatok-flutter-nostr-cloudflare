import { describe, expect, it } from "vitest";
import { CALL_TRANSLATION_LANGS, CALL_TRANSLATION_MIN_START, CALL_TRANSLATION_RATE, CALL_TRANSLATION_MODEL, CALL_TRANSLATION_SOURCE_BRIDGE_ENABLED } from "../src/routes/call_translation";

describe("[CALL-TRANSLATE-1] contract", () => {
  it("uses the documented Gemini model and paid one-minute tariff", () => {
    expect(CALL_TRANSLATION_MODEL).toBe("gemini-3.5-live-translate-preview");
    expect(CALL_TRANSLATION_RATE).toBe(5);
    expect(CALL_TRANSLATION_MIN_START).toBe(5);
  });

  it("accepts the complete server-owned language set", () => {
    expect(CALL_TRANSLATION_LANGS.size).toBeGreaterThanOrEqual(70);
    expect(CALL_TRANSLATION_LANGS.has("en")).toBe(true);
    expect(CALL_TRANSLATION_LANGS.has("hi")).toBe(true);
    expect(CALL_TRANSLATION_LANGS.has("zh-Hant")).toBe(true);
  });

  it("allows the reviewed decoded-playback Android bridge", () => {
    expect(CALL_TRANSLATION_SOURCE_BRIDGE_ENABLED).toBe(true);
  });
});
