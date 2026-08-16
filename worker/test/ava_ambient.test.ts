// [AVA-AMBIENT-1] Unit tests for the Ambient Ava PURE functions: eligibility
// prefilter, LLM decision parsing, and the KV rate-limiter arithmetic.
//
//   npx vitest run test/ava_ambient.test.ts
import { describe, it, expect } from "vitest";
import {
  isEligibleMessage, parseAmbientDecision,
  emptyRl, noteMessage, allowReact, allowComment, noteReact, noteComment,
  COMMENT_EVERY_N_MSGS, COMMENT_MIN_GAP_MS, REACT_WINDOW_MS,
  type AmbientRl,
} from "../src/lib/ava_ambient";

const T0 = 1_755_400_000_000;

// ─── eligibility ────────────────────────────────────────────────────────────

describe("isEligibleMessage", () => {
  const ok = (body: string) => isEligibleMessage({ kind: "text", body, senderUid: "u1" });

  it("accepts a plain human text message", () => {
    expect(ok("bhai that was hilarious 😂").ok).toBe(true);
  });

  it("skips Ava's own messages", () => {
    expect(isEligibleMessage({ kind: "text", body: "hi", senderUid: "ava" }))
      .toMatchObject({ ok: false, reason: "ava_self" });
  });

  it("skips non-text kinds (v1 is text only)", () => {
    expect(isEligibleMessage({ kind: "audio", body: "x", senderUid: "u1" }))
      .toMatchObject({ ok: false, reason: "non_text_kind" });
  });

  it("skips empty / null bodies", () => {
    expect(ok("").ok).toBe(false);
    expect(isEligibleMessage({ kind: "text", body: null, senderUid: "u1" }).ok).toBe(false);
  });

  it("skips control envelopes riding kind:'text' (media, del, poll, call, receipts)", () => {
    for (const t of ["media", "del", "gdel", "poll", "vote", "ava_status", "call"]) {
      expect(ok(JSON.stringify({ t, target: "x" })))
        .toMatchObject({ ok: false, reason: "control_envelope" });
    }
  });

  it("does NOT mistake human text that merely starts with a brace", () => {
    expect(ok("{honestly} that was great").ok).toBe(true);
  });

  it("skips @ava / #ava invocations, case-insensitive, at any position", () => {
    expect(ok("@ava what's the weather")).toMatchObject({ ok: false, reason: "ava_invoked" });
    expect(ok("hey @Ava help us settle this")).toMatchObject({ ok: false, reason: "ava_invoked" });
    expect(ok("#ava play a song")).toMatchObject({ ok: false, reason: "ava_invoked" });
  });

  it("does NOT skip emails or handles that merely contain 'ava'", () => {
    expect(ok("mail me at x@avatar.com").ok).toBe(true);
    expect(ok("lava vibes today").ok).toBe(true);
  });

  it("skips one-character trivia", () => {
    expect(ok("k")).toMatchObject({ ok: false, reason: "trivial" });
  });
});

// ─── decision parsing ───────────────────────────────────────────────────────

describe("parseAmbientDecision", () => {
  it("parses a valid react", () => {
    expect(parseAmbientDecision('{"action":"react","emoji":"🎉"}'))
      .toEqual({ action: "react", emoji: "🎉" });
  });

  it("parses a valid comment and trims it", () => {
    expect(parseAmbientDecision('{"action":"comment","text":"  So proud of you! 🎉  "}'))
      .toEqual({ action: "comment", text: "So proud of you! 🎉" });
  });

  it("survives prose/fence wrappers around the JSON", () => {
    const raw = "Sure! Here you go:\n```json\n{\"action\":\"react\",\"emoji\":\"❤️\"}\n```";
    expect(parseAmbientDecision(raw)).toEqual({ action: "react", emoji: "❤️" });
  });

  it("returns none for malformed output", () => {
    expect(parseAmbientDecision("")).toEqual({ action: "none" });
    expect(parseAmbientDecision("I think I'll react with a heart")).toEqual({ action: "none" });
    expect(parseAmbientDecision("{action: react}")).toEqual({ action: "none" });
    expect(parseAmbientDecision('{"action":"dance"}')).toEqual({ action: "none" });
  });

  it("rejects an ASCII-text 'emoji' (would render as a broken chip)", () => {
    expect(parseAmbientDecision('{"action":"react","emoji":"lol"}')).toEqual({ action: "none" });
    expect(parseAmbientDecision('{"action":"react","emoji":":)"}')).toEqual({ action: "none" });
    expect(parseAmbientDecision('{"action":"react","emoji":""}')).toEqual({ action: "none" });
  });

  it("rejects an empty comment; strips wrapping quotes; caps length", () => {
    expect(parseAmbientDecision('{"action":"comment","text":"   "}')).toEqual({ action: "none" });
    expect(parseAmbientDecision('{"action":"comment","text":"\\"nice one\\""}'))
      .toEqual({ action: "comment", text: "nice one" });
    const long = "a".repeat(500);
    const d = parseAmbientDecision(`{"action":"comment","text":"${long}"}`);
    expect(d.action).toBe("comment");
    expect((d as any).text.length).toBeLessThanOrEqual(240);
  });
});

// ─── rate limiter ───────────────────────────────────────────────────────────

describe("rate limiter", () => {
  function seen(n: number, from: AmbientRl, t = T0): AmbientRl {
    let rl = from;
    for (let i = 0; i < n; i++) rl = noteMessage(rl, t);
    return rl;
  }

  it("reactions: at most ~1 per 3 messages over the window", () => {
    let rl = emptyRl(T0);
    let reacts = 0;
    for (let i = 0; i < 30; i++) {
      rl = noteMessage(rl, T0 + i * 1000);
      if (allowReact(rl)) { rl = noteReact(rl); reacts++; }
    }
    expect(reacts).toBeGreaterThan(0);
    expect(reacts).toBeLessThanOrEqual(10); // 30 msgs / ratio 3
  });

  it("reaction window resets after REACT_WINDOW_MS of rolling", () => {
    let rl = emptyRl(T0);
    rl = seen(3, rl);
    rl = noteReact(rl);
    // Exhaust: 1 react per 3 msgs → a 4th react needs ≥10 msgs. Jump the window.
    const later = T0 + REACT_WINDOW_MS + 1;
    rl = noteMessage(rl, later);
    expect(rl.msgsInWin).toBe(1);
    expect(rl.reactsInWin).toBe(0);
    expect(allowReact(rl)).toBe(true);
  });

  it("comments: blocked until enough member messages have passed", () => {
    let rl = emptyRl(T0); // seeded halfway to the threshold
    expect(allowComment(rl, T0, 3)).toBe(false);
    rl = seen(COMMENT_EVERY_N_MSGS, rl);
    expect(allowComment(rl, T0, 3)).toBe(true);
  });

  it("comments: noteComment resets the message spacing", () => {
    let rl = seen(COMMENT_EVERY_N_MSGS, emptyRl(T0));
    rl = noteComment(rl, T0);
    expect(allowComment(rl, T0 + COMMENT_MIN_GAP_MS + 1, 3)).toBe(false); // 0 msgs since
    rl = seen(COMMENT_EVERY_N_MSGS, rl, T0 + COMMENT_MIN_GAP_MS + 2);
    expect(allowComment(rl, T0 + COMMENT_MIN_GAP_MS + 3, 3)).toBe(true);
  });

  it("comments: hourly cap holds, then rolls over after an hour", () => {
    let rl = emptyRl(T0);
    let t = T0;
    let posted = 0;
    // Try hard for an hour's worth of chatter: cap must hold at 3.
    for (let i = 0; i < 200; i++) {
      t += 15_000; // heavy chat, well inside one hour for the first chunk
      rl = noteMessage(rl, t);
      if (t - T0 < 3_600_000 && allowComment(rl, t, 3)) { rl = noteComment(rl, t); posted++; }
    }
    expect(posted).toBeLessThanOrEqual(3);
    // After the hour bucket rolls, commenting resumes.
    let t2 = T0 + 2 * 3_600_000;
    rl = seen(COMMENT_EVERY_N_MSGS, rl, t2);
    expect(rl.commentsInHour).toBe(0);
    expect(allowComment(rl, t2, 3)).toBe(true);
  });

  it("comments: minimum quiet gap between two comments", () => {
    let rl = seen(COMMENT_EVERY_N_MSGS, emptyRl(T0));
    expect(allowComment(rl, T0, 3)).toBe(true);
    rl = noteComment(rl, T0);
    rl = seen(COMMENT_EVERY_N_MSGS, rl, T0 + 60_000);
    expect(allowComment(rl, T0 + 60_000, 3)).toBe(false); // gap too small
    expect(allowComment(rl, T0 + COMMENT_MIN_GAP_MS + 1, 3)).toBe(true);
  });

  it("per-hour cap of 1 still allows the first comment", () => {
    const rl = seen(COMMENT_EVERY_N_MSGS, emptyRl(T0));
    expect(allowComment(rl, T0, 1)).toBe(true);
    expect(allowComment(noteComment(rl, T0), T0 + COMMENT_MIN_GAP_MS + 1, 1)).toBe(false);
  });
});
