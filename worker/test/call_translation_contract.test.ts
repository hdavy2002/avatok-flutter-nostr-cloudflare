import { describe, expect, it } from "vitest";
import { CALL_TRANSLATION_LANGS, CALL_TRANSLATION_MIN_START, CALL_TRANSLATION_RATE, CALL_TRANSLATION_MODEL, CALL_TRANSLATION_SOURCE_BRIDGE_ENABLED, mintFailureClass, stopEndReason } from "../src/routes/call_translation";

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

describe("[CALL-TRANSLATE-OBS-2] telemetry categories", () => {
  // These strings are what a dashboard breaks down on, so they are a contract.
  // The 2026-08-04 outage was a 400 (we sent a field name that only exists in
  // the SDK) — `bad_request` is the class that must have said "it's us".
  it("classifies the mint failure that actually happened as bad_request", () => {
    expect(mintFailureClass(400)).toBe("bad_request");
  });

  it("separates our fault, the account's fault and Google's fault", () => {
    expect(mintFailureClass(401)).toBe("auth");
    expect(mintFailureClass(403)).toBe("auth");
    expect(mintFailureClass(404)).toBe("not_found");
    expect(mintFailureClass(408)).toBe("timeout");
    expect(mintFailureClass(429)).toBe("quota");
    expect(mintFailureClass(500)).toBe("provider_error");
    expect(mintFailureClass(503)).toBe("provider_error");
    expect(mintFailureClass(504)).toBe("timeout");
    expect(mintFailureClass(418)).toBe("http_other");
  });

  it("maps stop reasons through a closed set, defaulting to user_stop", () => {
    expect(stopEndReason("dead_translation")).toBe("dead_translation");
    expect(stopEndReason("provider_failure")).toBe("provider_failure");
    expect(stopEndReason("call_ended")).toBe("call_ended");
    // Every build in the field today sends no reason at all.
    expect(stopEndReason(undefined)).toBe("user_stop");
    expect(stopEndReason("")).toBe("user_stop");
    // A client must never be able to inject a free string into the taxonomy.
    expect(stopEndReason("whatever the user typed")).toBe("user_stop");
    expect(stopEndReason({ nope: 1 })).toBe("user_stop");
  });
});
