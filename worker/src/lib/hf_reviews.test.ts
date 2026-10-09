import { describe, it, expect } from "vitest";
import {
  validateReviewInput, roundRating, buildAggregate, tokenExpired, reviewWindowOpen, isRegular, firstNameOf, canNotifyAgain,
  callDateIst, toMs, REVIEW_WINDOW_MS, NOTIFY_WINDOW_MS,
} from "./hf_reviews_pure";
import { TOPICS } from "./hf_options";

describe("aggregates", () => {
  it("rounds the average to one decimal, null when empty", () => {
    expect(roundRating(0, 0)).toBeNull();
    expect(roundRating(14, 3)).toBe(4.7);
    expect(roundRating(13, 3)).toBe(4.3);
    expect(roundRating(9, 2)).toBe(4.5);
    expect(roundRating(5, 1)).toBe(5);
  });
  it("builds breakdown, count, rating", () => {
    const a = buildAggregate({ c5: 3, c4: 1, c3: 0, c2: 0, c1: 1 }, 4, 1);
    expect(a.reviewCount).toBe(5);
    expect(a.rating).toBe(4.0);
    expect(a.ratingBreakdown).toEqual({ 5: 3, 4: 1, 3: 0, 2: 0, 1: 1 });
    expect(a.talkedTo).toBe(4);
    expect(a.regulars).toBe(1);
  });
  it("handles a host with no reviews", () => {
    const a = buildAggregate(undefined);
    expect(a.rating).toBeNull();
    expect(a.reviewCount).toBe(0);
    expect(a.ratingBreakdown).toEqual({ 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 });
  });
});

describe("review validation", () => {
  const topic = TOPICS[0].slug;
  it("accepts stars only, and stars + text + topic", () => {
    expect(validateReviewInput({ stars: 5 })).toEqual({ ok: true, stars: 5, text: "", topic: null });
    expect(validateReviewInput({ stars: 4, text: "  Lovely  chat, felt heard. ", topic })).toEqual({ ok: true, stars: 4, text: "Lovely chat, felt heard.", topic });
  });
  it("rejects bad stars", () => {
    for (const s of [0, 6, 2.5, "x", null, undefined]) {
      const r = validateReviewInput({ stars: s });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("bad_stars");
    }
  });
  it("enforces 500 chars", () => {
    expect(validateReviewInput({ stars: 5, text: "good chat ".repeat(50) }).ok).toBe(true);
    const r = validateReviewInput({ stars: 5, text: "word ".repeat(120) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("text_too_long");
  });
  it("blocks contact details with 422", () => {
    for (const t of ["call me on 98765 43210", "find me on WhatsApp", "mail a@b.com please", "see https://x.co"]) {
      const r = validateReviewInput({ stars: 5, text: t });
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.status).toBe(422); expect(r.error).toBe("contact_details"); }
    }
  });
  it("blocks very short junk", () => {
    for (const t of ["ok", "a", "aaaaaa", "......"]) {
      const r = validateReviewInput({ stars: 3, text: t });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("text_too_short");
    }
  });
  it("rejects unknown topics", () => {
    const r = validateReviewInput({ stars: 5, topic: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_topic");
  });
});

describe("tokens and windows", () => {
  const now = 1_800_000_000_000;
  it("token expiry", () => {
    expect(tokenExpired(now + 1, now)).toBe(false);
    expect(tokenExpired(now, now)).toBe(true);
    expect(tokenExpired(now - 1, now)).toBe(true);
  });
  it("7 day review window", () => {
    expect(reviewWindowOpen(now - REVIEW_WINDOW_MS + 1000, null, now)).toBe(true);
    expect(reviewWindowOpen(now - REVIEW_WINDOW_MS - 1000, null, now)).toBe(false);
    expect(reviewWindowOpen(null, now - 1000, now)).toBe(true);
    expect(reviewWindowOpen(null, null, now)).toBe(false);
  });
  it("normalises seconds to ms", () => {
    expect(toMs(1_800_000_000)).toBe(1_800_000_000_000);
    expect(toMs(now)).toBe(now);
  });
  it("IST call date", () => {
    expect(callDateIst(Date.UTC(2026, 9, 9, 20, 0))).toBe("2026-10-10"); // 01:30 IST next day
  });
});

describe("regulars and names", () => {
  it("regular at 3+ completed calls", () => {
    expect(isRegular(2)).toBe(false);
    expect(isRegular(3)).toBe(true);
    expect(isRegular(10)).toBe(true);
  });
  it("first name only, safe fallback", () => {
    expect(firstNameOf("Priya Sharma")).toBe("Priya");
    expect(firstNameOf("  ")).toBe("A caller");
    expect(firstNameOf(null)).toBe("A caller");
    expect(firstNameOf("9876543210 x")).toBe("A caller");
    expect(firstNameOf("राहुल कुमार")).toBe("राहुल");
  });
});

describe("notify dedupe window", () => {
  const now = 1_800_000_000_000;
  it("allows never-notified and >=24h", () => {
    expect(canNotifyAgain(null, now)).toBe(true);
    expect(canNotifyAgain(undefined, now)).toBe(true);
    expect(canNotifyAgain(now - NOTIFY_WINDOW_MS, now)).toBe(true);
  });
  it("blocks within 24h", () => {
    expect(canNotifyAgain(now - 1000, now)).toBe(false);
    expect(canNotifyAgain(now - NOTIFY_WINDOW_MS + 1, now)).toBe(false);
  });
});
