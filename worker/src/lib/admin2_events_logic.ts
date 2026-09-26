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
  locationMax: 60,
  seoTitleMax: 70,
  seoDescriptionMax: 170,
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

/**
 * [SAATHUM-EVENT-FIELDS-1] The intention pill on the Book now card ("GOOD LUCK", "WEALTH").
 * Keys mirror web/src/lib/ritualGuides.ts ritualCategories — keep the two in step.
 */
export const INTENTIONS: Record<string, string> = {
  education: "Education", luck: "Good luck", wealth: "Wealth", career: "Career", health: "Health",
  family: "Family", peace: "Peace", life: "Life events", festival: "Festivals",
};

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
  // [SAATHUM-EVENT-FIELDS-1 2026-09-26] What the Book now card shows that the form never asked.
  location?: string | null;
  /** attrs.* — written by this lane (see splitPatch / ATTR_KEYS). */
  intention?: string | null;
  prasad_courier?: boolean;
  guide_slug?: string | null;
  seo_title?: string | null;
  seo_description?: string | null;
  // [SAATHUM-CHADHAVA 2026-09-26] On the booking card + past-event video download.
  /** Replaces `replay`; on read, a row with no video_download yet falls back to attrs.replay. */
  video_download?: boolean;
  visibility?: "public" | "private" | null;
  /** ₹ shown on the booking card and charged at checkout when prasad_courier is on. */
  prasad_price_rupees?: number | null;
  /** [SAATHUM-BOOKED-BOOST 2026-09-26] Owner's ad number ADDED to the real bookings count on the public card/page. null = real count only. */
  booked_boost?: number | null;
  /** Pasted by the admin any time, including after the event ends. */
  video_download_url?: string | null;
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

  if (has(body, "location")) {
    const v = str(body.location).replace(/\s+/g, " ");
    if (v.length > LIMITS.locationMax) errors.push({ field: "location", message: `Keep the location under ${LIMITS.locationMax} characters.` });
    else patch.location = v || null;
  }
  if (has(body, "intention")) {
    const v = str(body.intention);
    if (v && !INTENTIONS[v]) errors.push({ field: "intention", message: "Pick an intention from the list." });
    else patch.intention = v || null;
  }
  for (const k of ["prasad_courier", "video_download"] as const) {
    if (has(body, k)) {
      if (typeof body[k] !== "boolean") errors.push({ field: k, message: "Choose yes or no." });
      else patch[k] = body[k] as boolean;
    }
  }
  // [SAATHUM-CHADHAVA 2026-09-26]
  if (has(body, "visibility")) {
    const v = str(body.visibility);
    if (v !== "public" && v !== "private") errors.push({ field: "visibility", message: "Choose Public or Private." });
    else patch.visibility = v;
  }
  if (has(body, "booked_boost")) {
    if (body.booked_boost === null || body.booked_boost === "" || body.booked_boost === 0) patch.booked_boost = null;
    else {
      const bb = Number(body.booked_boost);
      if (!Number.isInteger(bb) || bb < 0 || bb > 1_000_000) errors.push({ field: "booked_boost", message: "Extra booked count must be a whole number between 0 and 10,00,000." });
      else patch.booked_boost = bb;
    }
  }
  if (has(body, "prasad_price_rupees")) {
    if (body.prasad_price_rupees === null || body.prasad_price_rupees === "") patch.prasad_price_rupees = null;
    else {
      const pp = Number(body.prasad_price_rupees);
      if (!Number.isInteger(pp) || pp < 0 || pp > 5000) errors.push({ field: "prasad_price_rupees", message: "Prasad shipping price must be a whole number between ₹0 and ₹5,000." });
      else patch.prasad_price_rupees = pp;
    }
  }
  if (has(body, "video_download_url")) {
    if (body.video_download_url === null || body.video_download_url === "") patch.video_download_url = null;
    else if (!isHttpsUrl(body.video_download_url)) errors.push({ field: "video_download_url", message: "The video download link must be a valid https link." });
    else patch.video_download_url = String(body.video_download_url);
  }
  if (has(body, "guide_slug")) {
    const v = str(body.guide_slug);
    if (v && !/^[a-z0-9-]{2,80}$/.test(v)) errors.push({ field: "guide_slug", message: "That article link is not valid." });
    else patch.guide_slug = v || null;
  }
  if (has(body, "seo_title")) {
    const v = str(body.seo_title).replace(/\s+/g, " ");
    if (v.length > LIMITS.seoTitleMax) errors.push({ field: "seo_title", message: `Keep the Google title under ${LIMITS.seoTitleMax} characters.` });
    else patch.seo_title = v || null;
  }
  if (has(body, "seo_description")) {
    const v = str(body.seo_description).replace(/\s+/g, " ");
    if (v.length > LIMITS.seoDescriptionMax) errors.push({ field: "seo_description", message: `Keep the Google description under ${LIMITS.seoDescriptionMax} characters.` });
    else patch.seo_description = v || null;
  }

  if (has(body, "cover_url")) {
    if (body.cover_url === null || body.cover_url === "") patch.cover_url = null;
    else if (!isHttpsUrl(body.cover_url)) errors.push({ field: "cover_url", message: "The cover image must be an uploaded https image." });
    else patch.cover_url = String(body.cover_url);
  }

  return { patch, errors };
}

/** Fields adminEditListing (PUT /api/admin/listings/:id) owns. */
export const ADMIN_EDIT_KEYS = ["title", "blurb", "description", "category", "price", "starts_at", "duration_min", "capacity", "performed_by", "location"] as const;

/** attrs keys this lane owns. `null` removes the key. */
export const ATTR_KEYS = [
  "deity", "intention", "prasad_courier", "guide_slug",
  // [SAATHUM-CHADHAVA 2026-09-26]
  "video_download", "visibility", "prasad_price_rupees", "video_download_url",
  // [SAATHUM-BOOKED-BOOST 2026-09-26]
  "booked_boost",
] as const;
export type AttrPatch = Partial<Record<(typeof ATTR_KEYS)[number], string | boolean | number | null>>;
export type SeoPatch = { title?: string | null; description?: string | null };

/** Split a patch into the admin-edit fields and the media/attrs fields this lane writes itself. */
export function splitPatch(p: EventPatch): { edit: Record<string, unknown>; cover: string | null | undefined; attrs: AttrPatch; seo: SeoPatch | undefined } {
  const edit: Record<string, unknown> = {};
  for (const k of ADMIN_EDIT_KEYS) if (k in p) edit[k] = (p as Record<string, unknown>)[k];
  const attrs: AttrPatch = {};
  for (const k of ATTR_KEYS) if (k in p) attrs[k] = (p as Record<string, unknown>)[k] as string | boolean | null;
  let seo: SeoPatch | undefined;
  if ("seo_title" in p || "seo_description" in p) {
    seo = {};
    if ("seo_title" in p) seo.title = p.seo_title ?? null;
    if ("seo_description" in p) seo.description = p.seo_description ?? null;
  }
  return { edit, cover: p.cover_url, attrs, seo };
}

// ---------------------------------------------------------------------------
// [SAATHUM-EVENT-FIELDS-1 2026-09-26] Auto SEO (owner: "auto create SEO info when a
// listing is created"). Deterministic, from the listing's own fields — never invents
// a claim, a date or a price the row does not carry. Stored as attrs.seo:
//   { title, description, title_source, description_source: 'auto'|'admin', at }
// An admin-typed value is kept until the admin clears it; 'auto' parts are rewritten
// on every save so they always match the current title/price/place.
// ---------------------------------------------------------------------------

const BRAND = "Saa Thum";

function cut(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const c = t.slice(0, max - 1).replace(/[\s,;:.\-–—]+\S*$/, "");
  return (c || t.slice(0, max - 1)) + "…";
}

function firstSentence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t;
}

export function autoSeoTitle(row: { title?: unknown; location?: unknown }): string {
  const title = String(row.title ?? "").replace(/\s+/g, " ").trim() || "Live havan";
  const place = String(row.location ?? "").trim();
  const candidates = [
    `${title} Online${place ? ` from ${place}` : ""} – Book Live | ${BRAND}`,
    `${title} Online – Book Live | ${BRAND}`,
    `${title} Online | ${BRAND}`,
  ];
  return candidates.find((c) => c.length <= 60) ?? cut(`${title} | ${BRAND}`, 60);
}

export function autoSeoDescription(row: {
  title?: unknown; blurb?: unknown; description?: unknown; price?: unknown; location?: unknown; deity?: unknown;
}): string {
  const title = String(row.title ?? "").trim();
  const lead = String(row.blurb ?? "").trim() || firstSentence(String(row.description ?? ""));
  const place = String(row.location ?? "").trim();
  const price = Number(row.price);
  const tail = [
    `Join live${place ? ` from ${place}` : ""}, sankalp in your name`,
    Number.isInteger(price) && price > 0 ? `starting from ₹${price.toLocaleString("en-IN")}.` : "from anywhere.",
  ].join(", ");
  const base = lead || `${title} performed live by temple priests.`;
  const full = `${base.replace(/[.\s]+$/, "")}. ${tail}`;
  if (full.length <= 158) return full;
  // Keep the booking facts; trim the lead.
  const room = 158 - tail.length - 2;
  return room > 40 ? `${cut(base, room).replace(/[.…]+$/, "")}… ${tail}` : cut(full, 158);
}

export type StoredSeo = { title: string; description: string; title_source: "auto" | "admin"; description_source: "auto" | "admin"; at: number };

/** The next attrs.seo for a row, keeping admin-typed parts unless `patch` clears or replaces them. */
export function nextSeo(row: Record<string, unknown>, current: Partial<StoredSeo> | null | undefined, patch: SeoPatch | undefined, now = Date.now()): StoredSeo {
  const cur = current ?? {};
  let title: string; let ts: "auto" | "admin";
  if (patch && "title" in patch) { if (patch.title) { title = patch.title; ts = "admin"; } else { title = autoSeoTitle(row); ts = "auto"; } }
  else if (cur.title_source === "admin" && cur.title) { title = cur.title; ts = "admin"; }
  else { title = autoSeoTitle(row); ts = "auto"; }
  let description: string; let ds: "auto" | "admin";
  if (patch && "description" in patch) { if (patch.description) { description = patch.description; ds = "admin"; } else { description = autoSeoDescription(row); ds = "auto"; } }
  else if (cur.description_source === "admin" && cur.description) { description = cur.description; ds = "admin"; }
  else { description = autoSeoDescription(row); ds = "auto"; }
  return { title, description, title_source: ts, description_source: ds, at: now };
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
