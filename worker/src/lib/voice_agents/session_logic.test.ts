import { describe, expect, it } from "vitest";
import {
  CaptionTracker, buildTranscript, canUseVoice, capToolResult, liveCostUsd, meterCostPaise, parseDurationMs, parseTicket,
  parseUidList, parseUsage, emptyUsage, rememberLines, scrubSecrets, translateGemini,
} from "./session_logic";
import { dobToApiDate, normalizeTob, pickPlace } from "./memory_tools";

describe("ticket gate", () => {
  it("parses comma and space separated admin lists", () => {
    expect(parseUidList("u1, u2  u3,,")).toEqual(["u1", "u2", "u3"]);
    expect(parseUidList(undefined)).toEqual([]);
  });
  it("opens to everyone when enabled, only admins otherwise", () => {
    expect(canUseVoice(true, "u9", "")).toBe(true);
    expect(canUseVoice(false, "u9", "u1,u2")).toBe(false);
    expect(canUseVoice(false, "u2", "u1,u2")).toBe(true);
    expect(canUseVoice(true, "", "u1")).toBe(false);
  });
  it("rejects missing, garbled and stale tickets", () => {
    const now = 1_000_000;
    expect(parseTicket(null, now)).toBeNull();
    expect(parseTicket({ uid: "u", agent: "astrology" }, now)).toBeNull();
    expect(parseTicket({ uid: "u", agent: "astrology", ts: now - 200_000 }, now)).toBeNull();
    expect(parseTicket({ uid: "u", agent: "astrology", ts: now - 1000, email: "a@b.c" }, now)).toEqual({ uid: "u", agent: "astrology", email: "a@b.c", ts: now - 1000 });
  });
});

describe("translateGemini", () => {
  it("maps setup, audio, transcription, turn end", () => {
    expect(translateGemini({ setupComplete: {} })).toEqual([{ kind: "setup_complete" }]);
    const ev = translateGemini({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] },
        outputTranscription: { text: "Namaste" },
        inputTranscription: { text: "hello" },
        turnComplete: true,
      },
    });
    expect(ev.map((e) => e.kind)).toEqual(["input_text", "audio", "output_text", "turn_complete"]);
  });
  it("maps interruption, tool calls, cancellation, goAway and resumption", () => {
    expect(translateGemini({ serverContent: { interrupted: true } })).toEqual([{ kind: "interrupted" }]);
    expect(translateGemini({ toolCall: { functionCalls: [{ id: "c1", name: "remember", args: { fact: "x" } }, { nope: 1 }] } }))
      .toEqual([{ kind: "tool_calls", calls: [{ id: "c1", name: "remember", args: { fact: "x" } }] }]);
    expect(translateGemini({ toolCallCancellation: { ids: ["c1"] } })).toEqual([{ kind: "tool_cancel", ids: ["c1"] }]);
    expect(translateGemini({ goAway: { timeLeft: "12.5s" } })).toEqual([{ kind: "go_away", timeLeftMs: 12500 }]);
    expect(translateGemini({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } })).toEqual([{ kind: "resume_handle", handle: "h1" }]);
    expect(translateGemini({ sessionResumptionUpdate: { newHandle: "h1", resumable: false } })).toEqual([]);
  });
  it("ignores junk", () => {
    expect(translateGemini(null)).toEqual([]);
    expect(translateGemini("x")).toEqual([]);
    expect(translateGemini({})).toEqual([]);
    expect(parseDurationMs("abc")).toBeNull();
  });
});

describe("captions and transcript", () => {
  it("accumulates per turn and closes with final=true", () => {
    const c = new CaptionTracker();
    expect(c.addInput(" Hello")).toEqual([{ type: "caption", who: "user", text: "Hello", final: false }]);
    expect(c.addInput(" there")).toEqual([{ type: "caption", who: "user", text: "Hello there", final: false }]);
    // the agent starting to speak closes the customer's turn first
    expect(c.addOutput("Namaste")).toEqual([
      { type: "caption", who: "user", text: "Hello there", final: true },
      { type: "caption", who: "agent", text: "Namaste", final: false },
    ]);
    expect(c.addOutput(" ji")).toEqual([{ type: "caption", who: "agent", text: "Namaste ji", final: false }]);
    expect(c.closeAll()).toEqual([{ type: "caption", who: "agent", text: "Namaste ji", final: true }]);
    expect(c.closeAll()).toEqual([]);
    expect(buildTranscript(c.lines, "Meera")).toBe("Customer: Hello there\nMeera: Namaste ji");
  });
  it("an interruption closes only the agent turn", () => {
    const c = new CaptionTracker();
    c.addOutput("Long answer");
    c.addInput("wait");
    // addInput closed the agent turn already; a later interrupt has nothing to close
    expect(c.closeAgentTurn()).toEqual([]);
    expect(c.lines.map((l) => l.who)).toEqual(["agent"]);
  });
});

describe("usage and cost", () => {
  it("splits tokens by modality", () => {
    const u = parseUsage({
      promptTokensDetails: [{ modality: "AUDIO", tokenCount: 1000 }, { modality: "TEXT", tokenCount: 200 }],
      responseTokensDetails: [{ modality: "AUDIO", tokenCount: 2000 }],
    });
    expect(u).toEqual({ inAudio: 1000, inText: 200, outAudio: 2000, outText: 0, have: true });
    expect(liveCostUsd(u, 0, 0)).toBeCloseTo(0.003 + 0.00015 + 0.024, 6);
  });
  it("falls back to byte-based audio seconds when no usage reported", () => {
    // 60 s of mic (32000 B/s) and 60 s of agent audio (48000 B/s) = 1 min each way
    expect(liveCostUsd(emptyUsage(), 32000 * 60, 48000 * 60)).toBeCloseTo(0.005 + 0.018, 6);
  });
  it("meters nothing inside the free window, then pro rata", () => {
    expect(meterCostPaise(100, 180, 2000)).toBe(0);
    expect(meterCostPaise(240, 180, 2000)).toBe(2000);
    expect(meterCostPaise(210, 180, 2000)).toBe(1000);
    expect(meterCostPaise(300, 0, -5)).toBe(0);
  });
});

describe("small helpers", () => {
  it("shows at most 3 short remembered lines", () => {
    const long = "x".repeat(200);
    const r = rememberLines(["a  b", "", "c", "d", long]);
    expect(r).toEqual(["a b", "c", "d"]);
    expect(rememberLines([long])[0].length).toBe(80);
  });
  it("scrubs API keys out of error text", () => {
    expect(scrubSecrets("failed wss://x/ws?key=AIzaSyABCDEFGHIJKLMNOP&a=1")).not.toContain("AIza");
  });
  it("caps oversized tool results", () => {
    expect(capToolResult({ a: 1 })).toEqual({ a: 1 });
    const big = capToolResult({ t: "y".repeat(10_000) }) as { truncated: boolean; text: string };
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBe(6000);
  });
});

describe("birth-detail helpers", () => {
  it("normalizes times and dates", () => {
    expect(normalizeTob("6:5")).toBe("06:05");
    expect(normalizeTob("23:59")).toBe("23:59");
    expect(normalizeTob("24:00")).toBeNull();
    expect(normalizeTob("noon")).toBeNull();
    expect(dobToApiDate("1990-02-28")).toBe("28-02-1990");
  });
  it("picks one place or reports ambiguity", () => {
    const a = { place_name: "Aligarh, Uttar Pradesh", lat: 27.88, lon: 78.08, timezone_id: "Asia/Kolkata", country_code: "IN" };
    const dup = { ...a, place_name: "Aligarh" , lat: 27.9 };
    const far = { place_name: "Aligarh, Wyoming", lat: 41.1, lon: -104.8, timezone_id: "America/Denver", country_code: "US" };
    expect(pickPlace([a, dup], "")).toEqual({ place: a });
    const amb = pickPlace([a, far], "");
    expect("ambiguous" in amb && amb.ambiguous.length).toBe(2);
    expect(pickPlace([a, far], "wyoming")).toEqual({ place: far });
    expect(pickPlace([a, far], "IN")).toEqual({ place: a });
  });
});
