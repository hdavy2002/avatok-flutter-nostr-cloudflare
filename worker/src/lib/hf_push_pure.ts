// [HF-APP-4] Pure helpers for HF push notifications: token validation, deep-link path check, message copy.
// No imports from the runtime so it is unit-testable and safe to mirror on the web side.

export const HF_PUSH_KINDS = [
  "notify_me", "host_approved", "host_changes", "withdrawal_approved", "withdrawal_paid", "low_balance", "review_request", "presence_nudge", "booking_reminder",
  "booking_request", "booking_update", "booking_nudge", "open_window", // [HF-BOOK-APPROVE-BE]
] as const;
export type HfPushKind = (typeof HF_PUSH_KINDS)[number];

/** FCM registration tokens are ~150-170 chars of letters, digits, "-", "_" and ":". Be generous on length, strict on charset. */
const TOKEN_RE = /^[A-Za-z0-9_:.-]{40,4096}$/;
export function validPushToken(t: unknown): t is string {
  return typeof t === "string" && TOKEN_RE.test(t);
}

export function cleanShell(s: unknown): string {
  return typeof s === "string" || typeof s === "number" ? String(s).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 20) : "";
}

/** Same-site relative path only: starts with one "/", no scheme, no backslash, no control characters, no admin pages. */
export function safePushPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  if (p.length < 1 || p.length > 300) return null;
  if (p[0] !== "/" || p[1] === "/" || p[1] === "\\") return null;
  if (/[\\\u0000-\u001f\u007f]/.test(p)) return null;
  if (/^\/admin(\/|$|\?|#)/.test(p)) return null;
  return p;
}

export interface HfPushMessage { kind: HfPushKind; title: string; body: string; path: string }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Simple-English copy for each push. `brand` is BRAND.name; `name` is a host first name when relevant. */
export function hfPushCopy(kind: HfPushKind, brand: string, v: { name?: string; slug?: string; token?: string; rupees?: number; reason?: string } = {}): HfPushMessage {
  const name = (v.name || "").trim() || "Your host";
  switch (kind) {
    case "notify_me":
      return { kind, title: `${name} is online`, body: `You can call ${name} now on ${brand}.`, path: v.slug ? `/h/${v.slug}` : "/" };
    case "host_approved":
      return { kind, title: "Your profile is live", body: `People can now find you and call you on ${brand}.`, path: "/hosts/dashboard" };
    case "host_changes":
      return { kind, title: "Your profile needs a small change", body: "Open the app to see what to fix and send it again.", path: "/hosts/dashboard" };
    case "withdrawal_approved":
      return { kind, title: "Withdrawal approved", body: v.rupees ? `Your withdrawal of ₹${v.rupees} is approved. Payment is coming soon.` : "Your withdrawal is approved. Payment is coming soon.", path: "/hosts/dashboard" };
    case "withdrawal_paid":
      return { kind, title: "Withdrawal paid", body: v.rupees ? `₹${v.rupees} has been sent to your bank.` : "Your money has been sent to your bank.", path: "/hosts/dashboard" };
    case "low_balance":
      return { kind, title: "Your balance is low", body: "Add money to your wallet to keep talking without a break.", path: "/wallet" };
    case "review_request":
      return { kind, title: "How was your call?", body: `Tell us about your call with ${v.name?.trim() || "your host"}. It takes a few seconds.`, path: v.token ? `/review/${v.token}` : "/" };
    case "booking_reminder": // [HF-APPT-REMIND-1]
      return { kind, title: "Your call starts soon", body: `${name} — open the appointment a few minutes early.`, path: v.slug ? `/bookings/${v.slug}` : "/bookings" };
    // [HF-BOOK-APPROVE-PUSH] Paths are app locations (hf-flutter core/deep_links.dart maps them): /bookings/<id>, /inf/bookings, /inf/availability.
    // [HF-BOOK-APPROVE-BE] The booking-approval pushes carry their own title/body (built in lib/hf_booking_approval.ts); these are only the safe fallbacks.
    case "booking_request":
      return { kind, title: "New booking request", body: "Someone wants to book a call with you. Accept within 24 hours.", path: "/inf/bookings" };
    case "booking_update":
      return { kind, title: "Your booking was updated", body: "Open the app to see the latest.", path: "/bookings" };
    case "booking_nudge":
      return { kind, title: "A booking is waiting for you", body: "Accept or decline it before it is cancelled and refunded.", path: "/inf/bookings" };
    case "open_window":
      return { kind, title: "You're open for calls", body: "Expect calls. You're open for calls right now.", path: "/inf/availability" };
    case "presence_nudge": // [HF-PRESENCE-NUDGE-1]
      return { kind, title: "You're showing as offline", body: `Callers can't reach you on ${brand}. Open the app and turn the switch on.`, path: "/host" };
  }
}

/** Final shape handed to the queue. Returns null when anything is unsafe, so nothing half-valid is ever sent. */
export function buildHfPushJob(uid: string, m: { kind: string; title: string; body: string; path: string }): { kind: "hf_push"; to: string; hfKind: HfPushKind; title: string; body: string; path: string } | null {
  if (!uid || !(HF_PUSH_KINDS as readonly string[]).includes(m.kind)) return null;
  const path = safePushPath(m.path);
  if (!path) return null;
  const title = clip(String(m.title || "").trim(), 60);
  const body = clip(String(m.body || "").trim(), 160);
  if (!title || !body) return null;
  return { kind: "hf_push", to: uid, hfKind: m.kind as HfPushKind, title, body, path };
}
