// [SAATHUM-CHECKOUT-API 2026-09-26] Pure rules for the Saa Thum checkout: quote
// math (incl. GST rounding), input validation (address/sankalp/UTR/pincode/qty
// bounds), and status mapping. NO I/O -- every dependency (listing snapshot,
// chadhava catalogue, config) is passed in. Kept pure so it is unit-testable
// without D1/env (see test/saathum_checkout.test.ts).

export type ChadhavaCatalogItem = {
  id: string;
  title: string;
  description: string | null;
  price_rupees: number;
  image_url: string | null;
};

export type QuoteLine = {
  kind: "ticket" | "chadhava" | "dakshina" | "prasad";
  id?: string;
  label: string;
  qty: number;
  unit_rupees: number;
  amount_rupees: number;
};

export type Quote = {
  lines: QuoteLine[];
  subtotal_rupees: number;
  gst_rate_pct: number;
  gst_rupees: number;
  total_rupees: number;
};

export type ListingSnapshot = {
  id: string;
  title: string;
  price_rupees: number;
  visibility: "public" | "private";
  prasad_available: boolean;
  prasad_price_rupees: number;
  starts_at: number | null;
  duration_min: number | null;
};

export type ChadhavaSelection = { id: string; qty: number };

export const MAX_CHADHAVA_QTY = 20;
export const MAX_DAKSHINA_RUPEES = 100_000;
export const DAKSHINA_PRESETS = [21, 51, 101, 251] as const;
export const PINCODE_RE = /^[1-9][0-9]{5}$/;
export const UTR_RE = /^\d{12}$/;
export const PHONE_RE = /^[6-9]\d{9}$/;

export type FieldError = { ok: false; error: string; message: string; field?: string };
export type Ok<T> = { ok: true; value: T };

/** Whole-rupee "round half up" GST, matching the spec's round(subtotal * rate /
 * 100) -- never bankers' rounding, never truncation. */
export function computeGstRupees(subtotalRupees: number, ratePct: number): number {
  if (!Number.isSafeInteger(subtotalRupees) || subtotalRupees < 0) return 0;
  if (!Number.isFinite(ratePct) || ratePct <= 0) return 0;
  return Math.round((subtotalRupees * ratePct) / 100);
}

export function normalizeUtr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return UTR_RE.test(v) ? v : null;
}

export function validPincode(value: unknown): value is string {
  return typeof value === "string" && PINCODE_RE.test(value.trim());
}

export type Address = {
  name: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
};

/** India-only address validation per spec. Every field is trimmed; empty after
 * trim fails. line2 is the only optional field. */
export function validateAddress(raw: unknown): Ok<Address> | FieldError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_address", message: "A shipping address is required.", field: "address" };
  }
  const a = raw as Record<string, unknown>;
  const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
  const name = str("name"), phone = str("phone"), line1 = str("line1"), line2 = str("line2");
  const city = str("city"), state = str("state"), pincode = str("pincode");
  if (!name || name.length > 120) return { ok: false, error: "invalid_name", message: "Enter the recipient's name.", field: "name" };
  if (!PHONE_RE.test(phone.replace(/^\+91/, ""))) {
    return { ok: false, error: "invalid_phone", message: "Enter a valid 10-digit Indian mobile number.", field: "phone" };
  }
  if (!line1 || line1.length > 200) return { ok: false, error: "invalid_line1", message: "Enter the address line.", field: "line1" };
  if (line2.length > 200) return { ok: false, error: "invalid_line2", message: "That address line is too long.", field: "line2" };
  if (!city || city.length > 80) return { ok: false, error: "invalid_city", message: "Enter the city.", field: "city" };
  if (!state || state.length > 80) return { ok: false, error: "invalid_state", message: "Enter the state.", field: "state" };
  if (!PINCODE_RE.test(pincode)) return { ok: false, error: "invalid_pincode", message: "Enter a valid 6-digit PIN code.", field: "pincode" };
  return {
    ok: true,
    value: { name, phone: phone.replace(/^\+91/, ""), line1, ...(line2 ? { line2 } : {}), city, state, pincode },
  };
}

export type Sankalp = { name: string; gotra?: string; family?: string[]; wish?: string };

export function validateSankalp(raw: unknown): Ok<Sankalp> | FieldError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_sankalp", message: "Sankalp name is required.", field: "sankalp" };
  }
  const s = raw as Record<string, unknown>;
  const name = typeof s.name === "string" ? s.name.trim() : "";
  if (!name || name.length > 120) return { ok: false, error: "invalid_sankalp_name", message: "Enter the name for the sankalp.", field: "name" };
  const gotra = typeof s.gotra === "string" ? s.gotra.trim().slice(0, 120) : undefined;
  const wish = typeof s.wish === "string" ? s.wish.trim().slice(0, 500) : undefined;
  let family: string[] | undefined;
  if (s.family !== undefined) {
    if (!Array.isArray(s.family) || s.family.length > 20 || !s.family.every((f) => typeof f === "string")) {
      return { ok: false, error: "invalid_family", message: "Family names must be a list of text.", field: "family" };
    }
    family = (s.family as string[]).map((f) => f.trim().slice(0, 120)).filter(Boolean);
  }
  return { ok: true, value: { name, ...(gotra ? { gotra } : {}), ...(family?.length ? { family } : {}), ...(wish ? { wish } : {}) } };
}

export type QuoteInput = {
  listing: ListingSnapshot;
  chadhavaCatalog: ChadhavaCatalogItem[];
  chadhava: ChadhavaSelection[];
  dakshinaRupees: number;
  prasad: boolean;
  gstEnabled: boolean;
  gstRatePct: number;
};

/** Server-authoritative quote. Never trusts a client-sent price -- every unit
 * price comes from `listing` / `chadhavaCatalog`, both loaded by the caller from
 * the DB. Throws-free: returns a FieldError for any out-of-bounds input so the
 * route can turn it into a 400 with a field name. */
export function computeQuote(input: QuoteInput): Ok<Quote> | FieldError {
  const { listing, chadhavaCatalog, dakshinaRupees: dakshina, prasad } = input;
  if (!Number.isSafeInteger(dakshina) || dakshina < 0 || dakshina > MAX_DAKSHINA_RUPEES) {
    return { ok: false, error: "invalid_dakshina", message: `Dakshina must be between 0 and ${MAX_DAKSHINA_RUPEES}.`, field: "dakshina_rupees" };
  }
  if (prasad && !listing.prasad_available) {
    return { ok: false, error: "prasad_unavailable", message: "This event does not offer prasad courier.", field: "prasad" };
  }
  const seen = new Set<string>();
  const lines: QuoteLine[] = [
    { kind: "ticket", label: listing.title, qty: 1, unit_rupees: listing.price_rupees, amount_rupees: listing.price_rupees },
  ];
  for (const sel of input.chadhava ?? []) {
    if (!sel || typeof sel.id !== "string" || seen.has(sel.id)) {
      return { ok: false, error: "invalid_chadhava", message: "Invalid chadhava selection.", field: "chadhava" };
    }
    if (!Number.isSafeInteger(sel.qty) || sel.qty < 0 || sel.qty > MAX_CHADHAVA_QTY) {
      return { ok: false, error: "invalid_chadhava_qty", message: `Quantity must be between 0 and ${MAX_CHADHAVA_QTY}.`, field: "chadhava" };
    }
    if (sel.qty === 0) continue;
    seen.add(sel.id);
    const item = chadhavaCatalog.find((c) => c.id === sel.id);
    if (!item) return { ok: false, error: "chadhava_not_found", message: "One of the offerings is no longer available.", field: "chadhava" };
    lines.push({ kind: "chadhava", id: item.id, label: item.title, qty: sel.qty, unit_rupees: item.price_rupees, amount_rupees: item.price_rupees * sel.qty });
  }
  if (dakshina > 0) lines.push({ kind: "dakshina", label: "Dakshina for the priest", qty: 1, unit_rupees: dakshina, amount_rupees: dakshina });
  if (prasad) lines.push({ kind: "prasad", label: "Prasad courier", qty: 1, unit_rupees: listing.prasad_price_rupees, amount_rupees: listing.prasad_price_rupees });

  const subtotal_rupees = lines.reduce((sum, l) => sum + l.amount_rupees, 0);
  const gst_rate_pct = input.gstEnabled ? input.gstRatePct : 0;
  const gst_rupees = computeGstRupees(subtotal_rupees, gst_rate_pct);
  const total_rupees = subtotal_rupees + gst_rupees;
  if (!Number.isSafeInteger(total_rupees) || total_rupees <= 0) {
    return { ok: false, error: "invalid_total", message: "This order total is invalid.", field: "total" };
  }
  return { ok: true, value: { lines, subtotal_rupees, gst_rate_pct, gst_rupees, total_rupees } };
}

/** True once the event's scheduled start has passed -- the point after which the
 * shipping address on a booking can no longer be edited (spec: "The address on a
 * booking can be changed any time before it starts"). */
export function addressLocked(startsAt: number | null, now = Date.now()): boolean {
  if (startsAt === null || !Number.isFinite(startsAt) || startsAt <= 0) return false;
  // Historical listings stored seconds; admin events store ms.
  const ms = startsAt < 100_000_000_000 ? startsAt * 1000 : startsAt;
  return now >= ms;
}

export type CheckoutRow = {
  status: "awaiting_payment" | "confirmed" | "review_pending" | "expired" | "cancelled";
  expires_at: number;
};

/** External status the HTTP contract exposes -- collapses the DB's `cancelled`
 * into `expired` (the contract's enum has no `cancelled`) and expires a stale
 * `awaiting_payment` row on read without needing a cron. */
export function externalStatus(row: CheckoutRow, now = Date.now()): "awaiting_payment" | "confirmed" | "review_pending" | "expired" {
  if (row.status === "confirmed" || row.status === "review_pending") return row.status;
  if (row.status === "cancelled") return "expired";
  if (row.status === "awaiting_payment" && row.expires_at <= now) return "expired";
  return "awaiting_payment";
}

/** How long a checkout's payment window stays open before it must be re-created. */
export const CHECKOUT_EXPIRY_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// [SAATHUM-CHECKOUT-API follow-up] "30 minutes before" reminder email.
// ---------------------------------------------------------------------------

/** listings.starts_at is stored as ms for admin-created events but some historical
 * rows (and the addressLocked callers above) treat anything under this threshold
 * as seconds. Shared here so the reminder window and addressLocked agree. */
export function normalizeStartsAtMs(startsAt: number | null | undefined): number | null {
  if (startsAt === null || startsAt === undefined || !Number.isFinite(startsAt) || startsAt <= 0) return null;
  return startsAt < 100_000_000_000 ? startsAt * 1000 : startsAt;
}

/** The reminder fires once, this far ahead of the event's scheduled start. */
export const REMINDER_LEAD_MS = 35 * 60_000;

export type ReminderCandidate = {
  status: "awaiting_payment" | "confirmed" | "review_pending" | "expired" | "cancelled";
  reminder_sent_at: number | null;
  starts_at: number | null;
};

/** True exactly when a confirmed, not-yet-reminded checkout's event starts within
 * the next REMINDER_LEAD_MS and has not started yet. Pure — the caller (a cron
 * sweep) loads status/reminder_sent_at/listings.starts_at and this decides;
 * claiming the row (UPDATE ... WHERE reminder_sent_at IS NULL) and sending the
 * email are the caller's job, not this function's. */
export function dueForReminder(row: ReminderCandidate, now = Date.now()): boolean {
  if (row.status !== "confirmed" || row.reminder_sent_at !== null) return false;
  const startsMs = normalizeStartsAtMs(row.starts_at);
  if (startsMs === null) return false;
  return startsMs > now && startsMs - now <= REMINDER_LEAD_MS;
}
