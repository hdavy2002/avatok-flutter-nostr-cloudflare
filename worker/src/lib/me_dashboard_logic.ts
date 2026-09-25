// [DASH2-API 2026-09-25] Pure logic behind the customer dashboard (Dashboard 2).
// No I/O here, so every rule the spec (Specs/SPEC-2026-09-25-DASHBOARD-2.md) makes
// about state, refunds, VPAs and cursors is unit-tested in isolation.
import { scheduleState, eventWindow, type ScheduleState } from "./listing_schedule";

export const REFUND_WINDOW_MS = 24 * 60 * 60_000;
export const PAGE_SIZE = 20;
export const PHONE_SENDS_PER_WINDOW = 3;
export const PHONE_SEND_WINDOW_MS = 10 * 60_000;

export type EventState = "pending_payment" | "upcoming" | "live" | "ended";
export type PaymentStatus = "paid" | "pending" | "refund_requested" | "refunded";
export type RefundStatus = "requested" | "refunded" | "rejected";

type ListingRow = { kind?: unknown; status?: unknown; starts_at?: unknown; duration_min?: unknown; expires_at?: unknown };

/**
 * The customer-facing state of one booked event. lib/listing_schedule.ts stays the
 * authority on where the LISTING sits in time; this only folds its states into the
 * four the dashboard shows:
 *   - an unpaid booking is pending_payment whatever the clock says, until the show ends;
 *   - "starting" (start passed, provider not yet confirmed live) is still "upcoming":
 *     calling it live would tell the customer the pandit is on when he is not;
 *   - cancelled / completed / expired all read as "ended".
 */
export function eventState(listing: ListingRow, paid: boolean, now = Date.now()): { state: EventState; schedule: ScheduleState } {
  const schedule = scheduleState(listing, now);
  const over = schedule === "ended" || schedule === "cancelled" || schedule === "expired";
  if (!paid) return { state: over ? "ended" : "pending_payment", schedule };
  if (schedule === "live") {
    const win = eventWindow(listing);
    // A live projection long past its scheduled end is stuck; the show is over for the buyer.
    if (win && now >= win.end + 6 * 60 * 60_000) return { state: "ended", schedule };
    return { state: "live", schedule };
  }
  if (over || schedule === "unpublished") return { state: "ended", schedule };
  return { state: "upcoming", schedule };
}

export function isUpcomingScope(state: EventState): boolean {
  return state !== "ended";
}

/** Folds the base payment status with the latest refund row (if any). */
export function paymentStatus(base: "paid" | "pending" | "refunded", refund: RefundStatus | null): PaymentStatus {
  if (base === "refunded" || refund === "refunded") return "refunded";
  if (base === "pending") return "pending";
  if (refund === "requested") return "refund_requested";
  return "paid";
}

export type RefundEligibility = { ok: true } | { ok: false; error: string; message: string };

/**
 * A customer may REQUEST a refund only for a paid payment whose event starts at least
 * 24 hours from now, and only when no request is already open (or done).
 * Owner decision 2026-09-25; the refund itself is then made manually by an admin.
 */
export function refundEligibility(args: {
  status: PaymentStatus;
  eventStartsAt: number | null;
  now?: number;
}): RefundEligibility {
  const now = args.now ?? Date.now();
  if (args.status === "refund_requested") return { ok: false, error: "refund_already_requested", message: "A refund has already been requested for this payment." };
  if (args.status === "refunded") return { ok: false, error: "already_refunded", message: "This payment has already been refunded." };
  if (args.status !== "paid") return { ok: false, error: "not_paid", message: "Only a completed payment can be refunded." };
  if (args.eventStartsAt === null || !Number.isFinite(args.eventStartsAt)) {
    return { ok: false, error: "no_event_time", message: "This booking has no fixed start time, so it cannot be refunded online." };
  }
  if (args.eventStartsAt - now < REFUND_WINDOW_MS) {
    return { ok: false, error: "refund_window_closed", message: "Refunds can be requested only until 24 hours before the event starts." };
  }
  return { ok: true };
}

export const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
/** Validates and normalises (trim + lowercase) a UPI id. Null when invalid. */
export function normalizeVpa(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return VPA_RE.test(v) ? v.toLowerCase() : null;
}

/** Opaque keyset cursor over (sort_ts DESC, id DESC). */
export type Cursor = { t: number; id: string };
export function encodeCursor(c: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify([c.t, c.id]));
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw || raw.length > 400) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [t, id] = v;
    if (!Number.isSafeInteger(t) || typeof id !== "string" || !id || id.length > 200) return null;
    return { t, id };
  } catch { return null; }
}

/** "+919876543210" -> "+91 98•••••210". Anything else keeps only its last 3 digits. */
export function maskE164(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const m = /^\+91(\d{10})$/.exec(e164);
  if (m) return `+91 ${m[1].slice(0, 2)}•••••${m[1].slice(-3)}`;
  return e164.length > 4 ? `${e164.slice(0, 3)}•••••${e164.slice(-3)}` : "•••";
}

/** Rupees query param (spec: min/max are rupees) -> paise, or null when absent/invalid. */
export function rupeesParamToPaise(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Epoch-ms query param, or null. */
export function msParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (Number.isSafeInteger(n) && n > 0) return n;
  const d = Date.parse(raw);
  return Number.isFinite(d) ? d : null;
}

/** IST hour-of-day bucket for the catalog's `tod` filter. */
export type TimeOfDay = "morning" | "afternoon" | "evening";
export function istTimeOfDay(ms: number): TimeOfDay {
  const h = new Date(ms + 5.5 * 3_600_000).getUTCHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  return "evening";
}

/** Next receipt number for a year given the highest existing one ("SH-2026-000123"). */
export function nextReceiptNo(year: number, lastNo: string | null): string {
  const m = lastNo ? /^SH-(\d{4})-(\d{6,})$/.exec(lastNo) : null;
  const n = m && Number(m[1]) === year ? Number(m[2]) + 1 : 1;
  return `SH-${year}-${String(n).padStart(6, "0")}`;
}

/** Calendar year in IST. */
export function istYear(ms: number): number {
  return new Date(ms + 5.5 * 3_600_000).getUTCFullYear();
}

/** "Rs. 1,234.50" / "Rs. 1,234" — rupees with 2 decimals only when non-integer. */
export function formatRupeesAscii(paise: number): string {
  const whole = Math.trunc(paise / 100), frac = Math.abs(paise % 100);
  const grouped = whole.toLocaleString("en-IN");
  return `Rs. ${grouped}${frac ? "." + String(frac).padStart(2, "0") : ""}`;
}

/** "25 Sep 2026, 6:30 PM IST" */
export function formatIst(ms: number): string {
  const d = new Date(ms + 5.5 * 3_600_000);
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  let h = d.getUTCHours(); const ampm = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}, ${h}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ampm} IST`;
}

/** Keeps only characters Helvetica's WinAnsi encoding can draw (pdf-lib throws otherwise). */
export function winAnsiSafe(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/₹/g, "Rs.").replace(/•/g, "*")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "")
    .replace(/\s+/g, " ").trim();
}

type Invalid = { field: string; message: string };
const str = (v: unknown, max: number): string | null | undefined =>
  v === null ? null : typeof v === "string" ? (v.trim().slice(0, max) || null) : undefined;

/** Validates the editable profile fields. Pure; exported for tests. */
export function validateProfilePatch(b: Record<string, unknown>): { patch: Record<string, any> } | { invalid: Invalid } {
  const patch: Record<string, any> = {};
  if ("name" in b) {
    const v = str(b.name, 80);
    if (v === undefined || v === null) return { invalid: { field: "name", message: "Enter your name." } };
    patch.name = v;
  }
  for (const [k, max] of [["gotra", 60], ["language", 16]] as const) {
    if (k in b) { const v = str(b[k], max); if (v === undefined) return { invalid: { field: k, message: `Invalid ${k}.` } }; patch[k] = v; }
  }
  if ("family" in b) {
    if (!Array.isArray(b.family) || b.family.length > 20) return { invalid: { field: "family", message: "Family must be a list of up to 20 names." } };
    const fam: unknown[] = [];
    for (const m of b.family) {
      if (typeof m === "string" && m.trim()) fam.push(m.trim().slice(0, 80));
      else if (m && typeof m === "object" && typeof (m as any).name === "string" && (m as any).name.trim()) {
        const o: Record<string, string> = { name: (m as any).name.trim().slice(0, 80) };
        if (typeof (m as any).relation === "string" && (m as any).relation.trim()) o.relation = (m as any).relation.trim().slice(0, 40);
        fam.push(o);
      } else return { invalid: { field: "family", message: "Each family member needs a name." } };
    }
    patch.family = fam;
  }
  if ("notify" in b) {
    const n = b.notify;
    if (!n || typeof n !== "object" || Array.isArray(n)) return { invalid: { field: "notify", message: "Invalid notification settings." } };
    const out: Record<string, boolean> = {};
    for (const k of ["push", "email", "whatsapp"]) if (k in (n as any)) {
      if (typeof (n as any)[k] !== "boolean") return { invalid: { field: `notify.${k}`, message: "Must be on or off." } };
      out[k] = (n as any)[k];
    }
    patch.notify = out;
  }
  if ("address" in b) {
    if (b.address === null) patch.address = null;
    else if (!b.address || typeof b.address !== "object" || Array.isArray(b.address)) return { invalid: { field: "address", message: "Invalid address." } };
    else {
      const ad = b.address as Record<string, unknown>; const out: Record<string, string | null> = {};
      for (const [k, max] of [["name", 80], ["line1", 120], ["line2", 120], ["city", 60], ["state", 60], ["pin", 10], ["country", 60]] as const) {
        const v = ad[k] === undefined ? null : str(ad[k], max);
        if (v === undefined) return { invalid: { field: `address.${k}`, message: `Invalid ${k}.` } };
        out[k] = v;
      }
      if (out.pin && !/^[0-9A-Za-z -]{3,10}$/.test(out.pin)) return { invalid: { field: "address.pin", message: "Enter a valid PIN code." } };
      if ((out.country ?? "India").toLowerCase() === "india" && out.pin && !/^\d{6}$/.test(out.pin)) return { invalid: { field: "address.pin", message: "Enter a 6-digit PIN code." } };
      patch.address = out;
    }
  }
  return { patch };
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
/**
 * [DASH2-API] YouTube link -> 11-char video id, or null. Accepts watch?v=, youtu.be/<id>,
 * youtube.com/live|embed|shorts|v/<id> (www., m., music. and youtube-nocookie.com hosts)
 * and a bare id. Anything else (other hosts, playlists without v=, bad ids) is null.
 */
export function parseYoutubeVideoId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 500) return null;
  if (YT_ID.test(s)) return s;
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (host === "youtu.be") id = parts[0] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (["live", "embed", "shorts", "v"].includes(parts[0] ?? "")) id = parts[1] ?? null;
  }
  return id && YT_ID.test(id) ? id : null;
}
