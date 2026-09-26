// [ADMIN2-EVENTS 2026-09-26] Pure rules for the Admin 2 Events screens.
// Contract: Specs/SPEC-2026-09-26-ADMIN-2.md ("Events"). No I/O here — the
// handlers in routes/admin2_events.ts do the D1 work and call these.
//
// Saa Thum is a direct service: the admin creates every puja/havan as a
// `live_event` listing. The five admin tabs are a VIEW over the listing status
// machine (lib/listing_transitions.ts) plus the clock (lib/listing_schedule.ts
// is the authority for "is this show over"); nothing here changes either.
import { endMsSql, eventWindow, scheduleState } from "./listing_schedule";
import { startsMsSql } from "./me_dashboard_data";
import { MIN_PRICE_TOKENS_PER_HOUR } from "./session_pricing";

export type EventTab = "upcoming" | "live" | "past" | "drafts" | "cancelled";
export const EVENT_TABS: readonly EventTab[] = ["upcoming", "live", "past", "drafts", "cancelled"];

/** Statuses that are "not public yet" — all of them sit in the Drafts tab. */
export const DRAFT_STATUSES = ["draft", "pending_review", "approved", "rejected"] as const;

export function parseTab(raw: string | null | undefined): EventTab {
  return (EVENT_TABS as readonly string[]).includes(String(raw)) ? (raw as EventTab) : "upcoming";
}

/**
 * Which admin tab a listing row belongs in. Uses scheduleState() so the admin and
 * the customer surfaces can never disagree about whether a show is over.
 */
export function tabOf(row: { kind?: unknown; status?: unknown; starts_at?: unknown; duration_min?: unknown }, now = Date.now()): EventTab {
  const status = String(row.status ?? "");
  if (status === "cancelled") return "cancelled";
  if ((DRAFT_STATUSES as readonly string[]).includes(status)) return "drafts";
  const state = scheduleState({ ...row, kind: row.kind ?? "live_event" }, now);
  if (state === "live" || state === "starting") return "live";
  if (state === "ended" || state === "expired") return "past";
  return "upcoming"; // upcoming, or a published row with no start time yet ("open")
}

/** SQL CASE giving the same answer as tabOf() for alias `a`; `nowRef` is a bind like `?1`. */
export function tabSql(a: string, nowRef: string): string {
  const s = startsMsSql(a);
  return `(CASE
    WHEN ${a}.status='cancelled' THEN 'cancelled'
    WHEN ${a}.status IN ('draft','pending_review','approved','rejected') THEN 'drafts'
    WHEN ${a}.status='live' THEN 'live'
    WHEN ${a}.status='completed' THEN 'past'
    WHEN ${a}.status='published' AND ${s} IS NOT NULL AND ${endMsSql(a)} <= ${nowRef} THEN 'past'
    WHEN ${a}.status='published' AND ${s} IS NOT NULL AND ${s} <= ${nowRef} THEN 'live'
    ELSE 'upcoming' END)`;
}

// ---------------------------------------------------------------------------
// Form input
// ---------------------------------------------------------------------------

export const LIMITS = {
  titleMin: 3, titleMax: 120,
  blurbMax: 120, // routes/listings.ts listingContentFieldsError
  descriptionMax: 6000,
  deityMax: 60,
  performedByMax: 80, // routes/listings.ts listingContentFieldsError
  durationMin: 5, durationMax: 480, // lib/listing_blockers.ts duration_required
  priceMax: 1_000_000,
  capacityMax: 100_000,
} as const;

/** The ₹ floor every live_event price must clear (lib/session_pricing.ts). */
export const MIN_PRICE_RUPEES = MIN_PRICE_TOKENS_PER_HOUR;

export const DEITY_SUGGESTIONS = [
  "Ganesha", "Shiva", "Vishnu", "Lakshmi", "Durga", "Hanuman", "Krishna", "Rama", "Saraswati",
  "Kali", "Navagraha", "Shani", "Surya", "Kuber", "Sai Baba", "Satyanarayan",
] as const;

const IST_OFFSET_MS = 330 * 60_000;

/**
 * "YYYY-MM-DD" + "HH:MM" read as Indian Standard Time -> epoch ms. Null when either
 * part is malformed or the date does not exist (2026-02-30).
 */
export function istToMs(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  if (h > 23 || mi > 59 || mo < 1 || mo > 12 || da < 1) return null;
  const utc = Date.UTC(y, mo - 1, da, h, mi);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== da) return null;
  return utc - IST_OFFSET_MS;
}

/** epoch ms -> { date:"YYYY-MM-DD", time:"HH:MM" } in IST. */
export function msToIst(ms: number): { date: string; time: string } {
  const iso = new Date(ms + IST_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** Plain https URL (the /upload/public result). */
export function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 500) return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}

export type EventFieldError = { field: string; message: string };

/**
 * The normalized, listing-column-shaped patch the handlers write.
 * `price` is rupees (listings.price is tokens and 1 token = ₹1).
 */
export type EventPatch = {
  title?: string;
  blurb?: string | null;
  description?: string | null;
  category?: string;
  deity?: string | null;
  starts_at?: number | null;
  duration_min?: number | null;
  price?: number;
  capacity?: number | null;
  cover_url?: string | null;
  performed_by?: string | null;
};

const has = (b: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();

/**
 * Validate the admin event form. `partial` (edit) only checks the keys that were
 * sent; create requires a title and category. Price and schedule rules mirror the
 * server's own (session_pricing floor, listing_blockers duration range) so the
 * admin hears the same sentence a creator would, before any write.
 */
export function normalizeEventInput(
  body: Record<string, unknown>,
  opts: { partial: boolean; now?: number },
): { patch: EventPatch; errors: EventFieldError[] } {
  const patch: EventPatch = {};
  const errors: EventFieldError[] = [];
  const now = opts.now ?? Date.now();
  const want = (k: string) => has(body, k) || !opts.partial;

  if (want("title")) {
    const t = str(body.title).replace(/\s+/g, " ");
    if (t.length < LIMITS.titleMin) errors.push({ field: "title", message: "Give the event a title (at least 3 characters)." });
    else if (t.length > LIMITS.titleMax) errors.push({ field: "title", message: `Keep the title under ${LIMITS.titleMax} characters.` });
    else patch.title = t;
  }
  if (want("category")) {
    const c = str(body.category);
    if (!/^[a-z0-9_]{2,40}$/.test(c)) errors.push({ field: "category", message: "Pick a category." });
    else patch.category = c;
  }
  if (has(body, "blurb")) {
    const v = str(body.blurb);
    if (v.length > LIMITS.blurbMax) errors.push({ field: "blurb", message: `Keep the short description under ${LIMITS.blurbMax} characters.` });
    else patch.blurb = v || null;
  }
  if (has(body, "description")) {
    const v = str(body.description);
    if (v.length > LIMITS.descriptionMax) errors.push({ field: "description", message: `Keep the description under ${LIMITS.descriptionMax} characters.` });
    else patch.description = v || null;
  }
  if (has(body, "deity")) {
    const v = str(body.deity).replace(/\s+/g, " ");
    if (v.length > LIMITS.deityMax) errors.push({ field: "deity", message: `Keep the deity under ${LIMITS.deityMax} characters.` });
    else patch.deity = v || null;
  }
  if (has(body, "performed_by")) {
    const v = str(body.performed_by);
    if (v.length > LIMITS.performedByMax) errors.push({ field: "performed_by", message: `Keep "performed by" under ${LIMITS.performedByMax} characters.` });
    else patch.performed_by = v || null;
  }

  // Start: either epoch ms, or IST date + time from the form.
  if (has(body, "start_date") || has(body, "start_time")) {
    const date = str(body.start_date), time = str(body.start_time);
    if (!date && !time) patch.starts_at = null;
    else {
      const ms = istToMs(date, time);
      if (ms === null) errors.push({ field: "starts_at", message: "Pick a valid date and start time (IST)." });
      else if (ms <= now) errors.push({ field: "starts_at", message: "The start time is in the past — pick a future date and time." });
      else patch.starts_at = ms;
    }
  } else if (has(body, "starts_at")) {
    if (body.starts_at === null || body.starts_at === "") patch.starts_at = null;
    else {
      const ms = Math.trunc(Number(body.starts_at));
      if (!Number.isFinite(ms) || ms <= 0) errors.push({ field: "starts_at", message: "Pick a valid date and start time (IST)." });
      else if (ms <= now) errors.push({ field: "starts_at", message: "The start time is in the past — pick a future date and time." });
      else patch.starts_at = ms;
    }
  }

  if (has(body, "duration_min")) {
    if (body.duration_min === null || body.duration_min === "") patch.duration_min = null;
    else {
      const d = Number(body.duration_min);
      if (!Number.isInteger(d) || d < LIMITS.durationMin || d > LIMITS.durationMax) {
        errors.push({ field: "duration_min", message: `Set how long the event runs, between ${LIMITS.durationMin} and ${LIMITS.durationMax} minutes.` });
      } else patch.duration_min = d;
    }
  }

  if (has(body, "price") || has(body, "price_rupees")) {
    const raw = has(body, "price_rupees") ? body.price_rupees : body.price;
    const p = Number(raw);
    if (!Number.isInteger(p)) errors.push({ field: "price", message: "Price must be a whole number of rupees." });
    else if (p < MIN_PRICE_RUPEES) errors.push({ field: "price", message: `Price must be at least ₹${MIN_PRICE_RUPEES}.` });
    else if (p > LIMITS.priceMax) errors.push({ field: "price", message: "That price is too high." });
    else patch.price = p;
  }

  if (has(body, "capacity")) {
    if (body.capacity === null || body.capacity === "" || body.capacity === 0) patch.capacity = null;
    else {
      const c = Number(body.capacity);
      if (!Number.isInteger(c) || c < 1 || c > LIMITS.capacityMax) errors.push({ field: "capacity", message: "Capacity must be a whole number of seats, or empty for unlimited." });
      else patch.capacity = c;
    }
  }

  if (has(body, "cover_url")) {
    if (body.cover_url === null || body.cover_url === "") patch.cover_url = null;
    else if (!isHttpsUrl(body.cover_url)) errors.push({ field: "cover_url", message: "The cover image must be an uploaded https image." });
    else patch.cover_url = String(body.cover_url);
  }

  return { patch, errors };
}

/** Fields adminEditListing (PUT /api/admin/listings/:id) owns. */
export const ADMIN_EDIT_KEYS = ["title", "blurb", "description", "category", "price", "starts_at", "duration_min", "capacity", "performed_by"] as const;

/** Split a patch into the admin-edit fields and the media/attrs fields this lane writes itself. */
export function splitPatch(p: EventPatch): { edit: Record<string, unknown>; cover: string | null | undefined; deity: string | null | undefined } {
  const edit: Record<string, unknown> = {};
  for (const k of ADMIN_EDIT_KEYS) if (k in p) edit[k] = (p as Record<string, unknown>)[k];
  return { edit, cover: p.cover_url, deity: p.deity };
}

// ---------------------------------------------------------------------------
// Cover media + poster
// ---------------------------------------------------------------------------

type Cover = { type?: string; url?: string; source?: string };

function parseArr(raw: unknown): Cover[] {
  if (Array.isArray(raw)) return raw as Cover[];
  if (typeof raw !== "string" || !raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * The next cover_media for an admin cover change. A new upload REPLACES the manual
 * photos (Saa Thum events carry one cover); the AI poster, if any, is kept so it
 * can be switched back to. Clearing the upload leaves only the AI poster.
 */
export function nextCoverMedia(current: unknown, coverUrl: string | null): Cover[] {
  const ai = parseArr(current).filter((c) => c && c.source === "ai_poster");
  if (!coverUrl) return ai;
  return [{ type: "image", url: coverUrl, source: "admin_upload" }, ...ai];
}

/** The admin-uploaded (non AI-poster) cover, if any. */
export function manualCoverUrl(current: unknown): string | null {
  const c = parseArr(current).find((x) => x && x.source !== "ai_poster" && typeof x.url === "string");
  return c?.url ?? null;
}

/** First image of any kind (what the public card shows). */
export function coverUrlOf(current: unknown): string | null {
  const c = parseArr(current).find((x) => x && typeof x.url === "string");
  return c?.url ?? null;
}

export type PosterPlan =
  | { kind: "ready" }
  /** The admin's own upload stands in for the poster: record it as approved. */
  | { kind: "use_cover"; url: string }
  /** A generated AI poster is waiting for the admin's OK. */
  | { kind: "approve_ai" }
  | { kind: "needs_image"; message: string };

/**
 * What publish must do about attrs.poster before publishListingAuthoritative(),
 * which refuses anything whose poster is not `approved`.
 */
export function posterPlan(attrs: Record<string, any>, coverMedia: unknown): PosterPlan {
  const poster = attrs?.poster ?? null;
  const manual = manualCoverUrl(coverMedia);
  if (poster?.status === "approved") {
    // An approved admin-cover poster must track the CURRENT upload.
    if (poster.provider === "admin_cover" && manual && poster.url !== manual) return { kind: "use_cover", url: manual };
    return { kind: "ready" };
  }
  if (manual) return { kind: "use_cover", url: manual };
  if (poster?.status === "draft") return { kind: "approve_ai" };
  if (poster?.status === "generating") return { kind: "needs_image", message: "The AI poster is still being made. Wait a moment, or upload a cover image." };
  return { kind: "needs_image", message: "Upload a cover image, or generate the AI poster and keep it." };
}

/** Is `ms` inside the event's scheduled window (for the list's LIVE badge)? */
export function isInWindow(row: { kind?: unknown; starts_at?: unknown; duration_min?: unknown }, now = Date.now()): boolean {
  const w = eventWindow({ ...row, kind: row.kind ?? "live_event" });
  return !!w && now >= w.start && now < w.end;
}

/** LIKE pattern with wildcards in the user's text escaped (use with ESCAPE '\\'). */
export function likeContains(q: string): string {
  return `%${q.trim().toLowerCase().slice(0, 80).replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
}
