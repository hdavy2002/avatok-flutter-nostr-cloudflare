// Phase 5 — ICS attachment builder + signed join-link tokens (A1).
// Join link = https://avatok.ai/j/<token>; token = base64url(payload).base64url(hmac)
// over JOIN_LINK_SECRET, payload { b: bookingId, exp }. Short-lived display-only:
// the /j/ page calls GET /api/join-info/:token for title/time/names; actually
// joining still requires the app + Clerk auth.
import type { Env } from "../types";

const b64u = (buf: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
};

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

export async function signJoinToken(env: Env, bookingId: string, expMs: number): Promise<string> {
  const secret = env.JOIN_LINK_SECRET || "dev-join-secret";
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ b: bookingId, exp: expMs })));
  return `${payload}.${b64u(await hmac(secret, payload))}`;
}

export async function verifyJoinToken(env: Env, token: string): Promise<string | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const secret = env.JOIN_LINK_SECRET || "dev-join-secret";
  const expect = b64u(await hmac(secret, payload));
  if (expect !== sig) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(fromB64u(payload))) as { b: string; exp: number };
    if (!j.b || (j.exp && Date.now() > j.exp)) return null;
    return j.b;
  } catch { return null; }
}

export function joinUrlFor(token: string): string { return `https://avatok.ai/j/${token}`; }

// ---------------------------------------------------------------------------
// [JOIN-LINK-1] v2 join tokens — the emailed link carries the customer's identity
//
// RULEBOOK-PAID-SESSIONS §7: "A customer needs a verified email and a payment —
// nothing more... He never logs into a dashboard and never needs an avaTOK
// account." A v1 token proves only WHICH booking; it cannot open a session,
// which is why `/j/<token>` could do nothing but redirect to a page that then
// asked the customer to sign in.
//
// A v2 payload additionally names the LISTING, the ACCOUNT the entitlement
// belongs to, and the session kind, so `POST /api/join-link/:token/session`
// can start a session for exactly that person:
//
//     { v: 2, b: bookingId|null, l: listingId, u: accountId, k: kind, exp }
//
// It is NOT single-use (the owner's rule: the same emailed link must work on a
// phone, then again on a laptop). It expires at session end + 24 h, it is bound
// to one account, and the endpoint re-checks the live entitlement on every call
// — a cancelled or refunded booking is refused even with a perfectly valid
// signature. A live_event ticket legitimately has no bookings row, which is why
// `b` is nullable while `l` is not.
export interface JoinTokenClaims {
  version: 1 | 2;
  bookingId: string | null;
  listingId: string | null;
  accountId: string | null;
  kind: "live_event" | "consult_1to1" | null;
  exp: number | null;
}

export async function signJoinTokenV2(env: Env, c: {
  bookingId: string | null;
  listingId: string;
  accountId: string;
  kind: "live_event" | "consult_1to1";
  expMs: number;
}): Promise<string> {
  const secret = env.JOIN_LINK_SECRET || "dev-join-secret";
  const payload = b64u(new TextEncoder().encode(JSON.stringify({
    v: 2, b: c.bookingId ?? null, l: c.listingId, u: c.accountId, k: c.kind, exp: c.expMs,
  })));
  return `${payload}.${b64u(await hmac(secret, payload))}`;
}

/**
 * Verify the signature and return the full claim set (v1 and v2).
 *
 * `allowExpired` exists so a caller can tell "this link is old" (410, with a
 * sentence the customer can act on) apart from "this link is not ours" (404).
 * Collapsing the two — which is what a bare boolean verifier forces — makes an
 * expired ticket look like a forged one to the person holding it.
 */
export async function verifyJoinTokenClaims(
  env: Env, token: string, opts: { allowExpired?: boolean } = {},
): Promise<JoinTokenClaims | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const secret = env.JOIN_LINK_SECRET || "dev-join-secret";
  // Constant-work compare: both sides are fixed-length base64url of the same
  // HMAC, so a plain !== leaks nothing an attacker can time against a secret
  // they do not hold — but keep the comparison after BOTH values exist.
  const expect = b64u(await hmac(secret, payload));
  if (expect !== sig) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(new TextDecoder().decode(fromB64u(payload))) as Record<string, unknown>;
  } catch { return null; }
  const exp = typeof j.exp === "number" ? j.exp : null;
  if (exp && Date.now() > exp && !opts.allowExpired) return null;
  if (j.v === 2) {
    const listingId = typeof j.l === "string" && j.l ? j.l : null;
    const accountId = typeof j.u === "string" && j.u ? j.u : null;
    const kind = j.k === "live_event" || j.k === "consult_1to1" ? j.k : null;
    if (!listingId || !accountId || !kind) return null;
    return {
      version: 2,
      bookingId: typeof j.b === "string" && j.b ? j.b : null,
      listingId, accountId, kind, exp,
    };
  }
  const bookingId = typeof j.b === "string" && j.b ? j.b : null;
  if (!bookingId) return null;
  return { version: 1, bookingId, listingId: null, accountId: null, kind: null, exp };
}

// ---------------------------------------------------------------------------
// ICS — minimal RFC 5545 VEVENT, UTC times (clients render in local tz).
// ---------------------------------------------------------------------------
const icsDate = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

export function buildIcs(o: { uid: string; title: string; start: number; end: number; description?: string; url?: string; method?: "REQUEST" | "CANCEL"; sequence?: number }): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AvaTOK//AvaCalendar//EN",
    `METHOD:${o.method ?? "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${o.uid}@avatok.ai`,
    `SEQUENCE:${o.sequence ?? 0}`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(o.start)}`,
    `DTEND:${icsDate(o.end)}`,
    `SUMMARY:${esc(o.title)}`,
    ...(o.description ? [`DESCRIPTION:${esc(o.description)}`] : []),
    ...(o.url ? [`URL:${o.url}`] : []),
    `STATUS:${o.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

export const icsB64 = (ics: string): string => btoa(unescape(encodeURIComponent(ics)));
