// [HF-CALLS-1] Pure helpers for HF reviews + notify-me. No env / D1 / network here, so they unit-test cheaply.
import { contactLeak, TOPIC_SLUGS } from "./hf_options";

export const REVIEW_WINDOW_MS = 7 * 24 * 3600_000; // HF-REV: review within 7 days of the call
export const REVIEW_MAX_TEXT = 500;
export const REVIEW_MIN_TEXT = 3;
export const REGULAR_CALLS = 3; // "Regular" = caller has >= 3 completed calls with that host
export const NOTIFY_WINDOW_MS = 24 * 3600_000; // at most one notify-me WhatsApp per subscriber per 24 h

export type ReviewInput = { ok: true; stars: number; text: string; topic: string | null } | { ok: false; status: number; error: string; message: string };

/** Validates a review body (token and signed-in routes share it). */
export function validateReviewInput(body: unknown): ReviewInput {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const stars = Number(b.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { ok: false, status: 400, error: "bad_stars", message: "Choose 1 to 5 stars." };
  const raw = b.text == null ? "" : typeof b.text === "string" ? b.text : null;
  if (raw === null) return { ok: false, status: 400, error: "bad_text", message: "Review text must be text." };
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (text.length > REVIEW_MAX_TEXT) return { ok: false, status: 400, error: "text_too_long", message: `Keep it under ${REVIEW_MAX_TEXT} characters.` };
  if (text) {
    // Very short or keyboard-mash text is junk: <3 chars, or a single character repeated ("aaaaaa", "....").
    if ([...text].length < REVIEW_MIN_TEXT || new Set([...text.replace(/\s/g, "")]).size < 2) {
      return { ok: false, status: 422, error: "text_too_short", message: "Write a few words, or leave the text empty." };
    }
    if (contactLeak(text)) return { ok: false, status: 422, error: "contact_details", message: "Please remove phone numbers, links and handles from your review." };
  }
  let topic: string | null = null;
  if (b.topic != null && b.topic !== "") {
    if (typeof b.topic !== "string" || !TOPIC_SLUGS.has(b.topic)) return { ok: false, status: 400, error: "bad_topic", message: "Unknown topic." };
    topic = b.topic;
  }
  return { ok: true, stars, text, topic };
}

/** Timestamps may arrive in seconds from a different writer; normalise to ms. */
export function toMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

export const tokenExpired = (expiresAt: number, now: number): boolean => !(toMs(expiresAt) > now);
/** The signed-in review window: 7 days from the end of the call (falls back to its start). */
export const reviewWindowOpen = (endedAt: unknown, createdAt: unknown, now: number): boolean => {
  const t = toMs(endedAt) || toMs(createdAt);
  return t > 0 && now - t <= REVIEW_WINDOW_MS && now >= t - 60_000;
};
export const isRegular = (completedCalls: number): boolean => completedCalls >= REGULAR_CALLS;

/** Average of approved stars, one decimal, or null with no reviews. */
export function roundRating(sum: number, count: number): number | null {
  if (!(count > 0)) return null;
  return Math.round((sum / count) * 10) / 10;
}

export type Breakdown = { 5: number; 4: number; 3: number; 2: number; 1: number };
export type HostAggregate = { rating: number | null; reviewCount: number; ratingBreakdown: Breakdown; talkedTo: number; regulars: number };
export const EMPTY_AGG: HostAggregate = { rating: null, reviewCount: 0, ratingBreakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }, talkedTo: 0, regulars: 0 };

export type StarRow = { c1: number; c2: number; c3: number; c4: number; c5: number };
export function buildAggregate(stars: Partial<StarRow> | undefined, talkedTo = 0, regulars = 0): HostAggregate {
  const c = { 1: Number(stars?.c1) || 0, 2: Number(stars?.c2) || 0, 3: Number(stars?.c3) || 0, 4: Number(stars?.c4) || 0, 5: Number(stars?.c5) || 0 };
  const n = c[1] + c[2] + c[3] + c[4] + c[5];
  const sum = c[1] + 2 * c[2] + 3 * c[3] + 4 * c[4] + 5 * c[5];
  return { rating: roundRating(sum, n), reviewCount: n, ratingBreakdown: { 5: c[5], 4: c[4], 3: c[3], 2: c[2], 1: c[1] }, talkedTo: Math.max(0, talkedTo | 0), regulars: Math.max(0, regulars | 0) };
}

/** First name for public display: first word of the display name, letters only, capped; never contact-like. */
export function firstNameOf(displayName: unknown): string {
  const first = String(displayName ?? "").normalize("NFKC").trim().split(/\s+/)[0] ?? "";
  const clean = [...first].filter((ch) => /[\p{L}\p{M}'-]/u.test(ch)).join("").slice(0, 24);
  if ([...clean].length < 1 || contactLeak(clean)) return "A caller";
  return clean;
}

/** notify-me dedupe: a subscriber may be messaged again only 24 h after the last send. */
export const canNotifyAgain = (notifiedAt: number | null | undefined, now: number): boolean => notifiedAt == null || now - toMs(notifiedAt) >= NOTIFY_WINDOW_MS;

export function callDateIst(ms: number): string {
  return new Date(toMs(ms) + 5.5 * 3600_000).toISOString().slice(0, 10);
}
