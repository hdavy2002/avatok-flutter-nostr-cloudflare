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
